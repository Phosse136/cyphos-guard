/**
 * EXPERIMENT: can the x402 payer be a contract (X402Vault, ERC-1271) so that the seller allowlist is enforced
 * ON-CHAIN? Real Base Sepolia USDC (FiatToken) on a fork, settled by the OFFICIAL x402 facilitator.
 * The vault approves only TransferWithAuthorization from itself to a listed seller, within its cap, signed by
 * the agent; the long signature carries the payment fields so the vault can recompute and check the digest.
 */
import { x402VaultAbi, x402VaultBytecode } from "@cyphos-guard/contracts/x402-vault";
import { decodeX402Header, encodeX402Header, type PaymentRequired, type PaymentRequirements } from "@cyphos-guard/sdk";
import { ensureFork, fundUsdc } from "@cyphos-guard/sdk/testing";
import { serve } from "@hono/node-server";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  http,
  type PublicClient,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSellerApp, localFacilitator, USDC } from "./seller.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const SELLER = privateKeyToAddress(generatePrivateKey());
const STRANGER = privateKeyToAddress(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const facilitatorKey = privateKeyToAccount(generatePrivateKey());
const closers: (() => void)[] = [];
let publicClient: PublicClient;
let vault: Address;
let listedShop: string;
let strangerShop: string;

const listen = async (fetch: (r: Request) => Response | Promise<Response>) => {
  const s = serve({ fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => s.once("listening", r));
  closers.push(() => s.close());
  const a = s.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
};
const usdcOf = (a: Address) =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

/** Pays `url` with the vault as the x402 payer: the agent signs, the signature carries the payment fields. */
async function payFromVault(url: string, signer = agent) {
  const first = await fetch(url);
  expect(first.status).toBe(402);
  const required = decodeX402Header<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED") ?? "");
  const req = required.accepts[0] as PaymentRequirements;
  const authorization = {
    from: vault,
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const agentSig = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
    },
  });
  const signature = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes" },
    ],
    [
      authorization.to,
      BigInt(authorization.value),
      0n,
      BigInt(authorization.validBefore),
      authorization.nonce,
      agentSig,
    ],
  );
  const res = await fetch(url, {
    headers: {
      "PAYMENT-SIGNATURE": encodeX402Header({
        x402Version: 2,
        resource: required.resource,
        accepted: req,
        payload: { authorization, signature },
      }),
    },
  });
  const settlement = res.headers.get("PAYMENT-RESPONSE");
  return {
    status: res.status,
    body: await res.text(),
    settlement: settlement ? decodeX402Header<{ success: boolean; errorReason?: string }>(settlement) : undefined,
  };
}

beforeAll(async () => {
  const anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  closers.push(() => anvil?.kill());
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  for (const a of [owner.address, facilitatorKey.address]) {
    await publicClient.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("1"))] as never });
  }
  const deployer = createWalletClient({ account: owner, chain, transport: http(FORK) });
  const hash = await deployer.deployContract({
    abi: x402VaultAbi,
    bytecode: x402VaultBytecode,
    args: [owner.address, agent.address, USDC, parseUnits("1", 6), [SELLER]],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  vault = receipt.contractAddress as Address;
  await fundUsdc(publicClient, vault, parseUnits("10", 6));

  const facilitator = localFacilitator(facilitatorKey, FORK);
  listedShop = await listen(
    (
      await createSellerApp({
        payTo: SELLER,
        facilitator,
        products: [
          { path: "/data", description: "data", amount: parseUnits("0.5", 6), body: { ok: true } },
          { path: "/big", description: "big", amount: parseUnits("3", 6), body: { ok: true } },
        ],
      })
    ).fetch,
  );
  strangerShop = await listen(
    (
      await createSellerApp({
        payTo: STRANGER,
        facilitator,
        products: [{ path: "/data", description: "data", amount: parseUnits("0.5", 6), body: { ok: true } }],
      })
    ).fetch,
  );
});

afterAll(() => {
  for (const close of closers.reverse()) close();
});

describe("EXPERIMENT: X402Vault as an on-chain-enforced x402 payer (official facilitator, real USDC, fork)", () => {
  it("the official facilitator verifies and settles a vault payment to a listed seller", async () => {
    const before = await usdcOf(SELLER);
    const r = await payFromVault(`${listedShop}/data`);
    expect(r.settlement?.errorReason).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.settlement?.success).toBe(true);
    expect((await usdcOf(SELLER)) - before).toBe(parseUnits("0.5", 6));
  });

  it("refuses a seller that is not on the vault's list, even with the agent's valid signature", async () => {
    const r = await payFromVault(`${strangerShop}/data`);
    expect(r.status).toBe(402);
    expect(await usdcOf(STRANGER)).toBe(0n);
  });

  it("refuses above the vault's per-payment cap", async () => {
    const before = await usdcOf(SELLER);
    const r = await payFromVault(`${listedShop}/big`);
    expect(r.status).toBe(402);
    expect(await usdcOf(SELLER)).toBe(before);
  });

  it("refuses a signature from anyone but the agent", async () => {
    const r = await payFromVault(`${listedShop}/data`, privateKeyToAccount(generatePrivateKey()));
    expect(r.status).toBe(402);
  });

  it("only the owner can withdraw", async () => {
    const wallet = createWalletClient({ account: owner, chain, transport: http(FORK) });
    const left = await usdcOf(vault);
    const hash = await wallet.writeContract({
      address: vault,
      abi: x402VaultAbi,
      functionName: "withdraw",
      args: [USDC, owner.address, left],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await usdcOf(vault)).toBe(0n);
    expect(await usdcOf(owner.address)).toBe(left);
  });
});
