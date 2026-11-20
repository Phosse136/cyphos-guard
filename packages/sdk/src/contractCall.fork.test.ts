/**
 * Fork integration: contract-call permissions against a real contract (Base Sepolia test USDC).
 * The agent may only call approve(spender = ROUTER, amount): other spenders, other functions and
 * attached ETH must be rejected ON-CHAIN (not just by the SDK).
 */

import { parsePolicy } from "@cyphos-guard/shared";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.ts";
import { encodeRedeem, revertReason } from "./delegations.ts";
import { deployAccount } from "./owner.ts";
import { ensureFork } from "./testing/fork.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);
const ROUTER = privateKeyToAddress(generatePrivateKey());
const OTHER = privateKeyToAddress(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
let client: PublicClient;
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let delegation: Parameters<typeof encodeRedeem>[0];

const attempt = async (to: `0x${string}`, data: `0x${string}`, value = 0n) => {
  try {
    await client.call({
      account: agent,
      to: env.DelegationManager,
      data: encodeRedeem(delegation, { to, value, data }),
    });
    return "ok";
  } catch (e) {
    return revertReason(e);
  }
};
const approve = (spender: `0x${string}`, amount = 10n ** 6n) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  client = createPublicClient({ chain, transport: http(FORK) });
  for (const a of [owner.address, agent.address]) {
    await client.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("1"))] as never });
  }
  const account = await toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { account: owner },
  });
  await deployAccount(account, createWalletClient({ account: owner, chain, transport: http(FORK) }), client);
  const now = Number((await client.getBlock()).timestamp);
  const policy = parsePolicy({
    version: 1,
    chainId: 84532,
    agent: agent.address,
    validFrom: now - 60,
    expiresAt: now + 86_400,
    permissions: [
      {
        kind: "contractCall",
        target: USDC,
        functions: [{ signature: "approve(address,uint256)", args: [{ index: 0, op: "eq", value: ROUTER }] }],
      },
    ],
  });
  const [c] = compilePolicy({ policy, delegator: account.address, environment: env, now });
  if (!c) throw new Error("nothing compiled");
  delegation = { ...c.delegation, signature: await account.signDelegation({ delegation: c.delegation }) };
});

// vitest workers exit without firing process "exit" hooks, so stop the fork we started explicitly.
afterAll(() => {
  anvil?.kill();
});

describe("contractCall permission on a real contract (fork)", () => {
  it("allows the pinned call", async () => {
    expect(await attempt(USDC, approve(ROUTER))).toBe("ok");
  });
  it("rejects another spender on-chain", async () => {
    expect(await attempt(USDC, approve(OTHER))).toMatch(/AllowedCalldataEnforcer/);
  });
  it("rejects another function on-chain", async () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ROUTER, 1n] });
    expect(await attempt(USDC, transfer)).toMatch(/AllowedMethodsEnforcer/);
  });
  it("rejects another target and attached ETH on-chain", async () => {
    expect(await attempt(OTHER, approve(ROUTER))).toMatch(/AllowedTargetsEnforcer/);
    expect(await attempt(USDC, approve(ROUTER), 1n)).toMatch(/ValueLteEnforcer/);
  });
});
