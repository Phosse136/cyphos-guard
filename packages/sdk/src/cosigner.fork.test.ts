/**
 * Fork integration: CosignerEnforcer through the DEPLOYED DelegationManager (Base Sepolia fork) with real
 * test USDC. Grant: ≤5 USDC/day to SHOP with a co-signer. The agent holds the signed delegation, so without the
 * enforcer it could redeem anything within the on-chain caps; with it, every redemption needs a fresh
 * cosignature for that exact call.
 */

import { parsePolicy } from "@cyphos-guard/shared";
import {
  type Delegation,
  getSmartAccountsEnvironment,
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.ts";
import {
  type Cosignature,
  cosignerEnforcerAddress,
  cosignTypedData,
  delegationCosigner,
  deployCosignerEnforcer,
  withCosignature,
} from "./cosigner.ts";
import { type Execution, encodeRedeem, revertReason } from "./delegations.ts";
import { deployAccount } from "./owner.ts";
import { ensureFork } from "./testing/fork.ts";
import { fundUsdc, USDC } from "./testing/usdc.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);
const SHOP = privateKeyToAddress(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const cosigner = privateKeyToAccount(generatePrivateKey());
let client: PublicClient;
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let delegation: Delegation;

const usdc = (amount: string): Execution => ({
  to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, parseUnits(amount, 6)] }),
});
const now = async () => Number((await client.getBlock()).timestamp);
const cosign = async (execution: Execution, signer = cosigner, deadlineIn = 300): Promise<Cosignature> => {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const deadline = BigInt((await now()) + deadlineIn);
  const signature = await signer.signTypedData(
    cosignTypedData({
      chainId: chain.id,
      delegationManager: env.DelegationManager,
      delegation,
      redeemer: agent.address,
      execution,
      salt,
      deadline,
    }),
  );
  return { salt, deadline: deadline.toString(), signature };
};
/** Simulate the agent's redemption; "ok" or the revert reason. */
const simulate = async (d: Delegation, execution: Execution) => {
  try {
    await client.call({ account: agent, to: env.DelegationManager, data: encodeRedeem(d, execution) });
    return "ok";
  } catch (e) {
    return revertReason(e);
  }
};
const send = async (d: Delegation, execution: Execution) => {
  const wallet = createWalletClient({ account: agent, chain, transport: http(FORK) });
  const hash = await wallet.sendTransaction({ to: env.DelegationManager, data: encodeRedeem(d, execution) });
  return (await client.waitForTransactionReceipt({ hash })).status;
};

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  client = createPublicClient({ chain, transport: http(FORK) });
  for (const a of [owner.address, agent.address]) {
    await client.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("1"))] as never });
  }
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(FORK) });
  await deployCosignerEnforcer(ownerWallet, client);
  const account = await toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { account: owner },
  });
  await deployAccount(account, ownerWallet, client);
  await fundUsdc(client, account.address, parseUnits("100", 6));
  const t = await now();
  const policy = parsePolicy({
    version: 1,
    chainId: 84532,
    agent: agent.address,
    validFrom: t - 60,
    expiresAt: t + 86_400,
    cosigner: cosigner.address,
    permissions: [
      {
        kind: "erc20Transfer",
        token: USDC,
        recipients: [SHOP],
        perTx: parseUnits("2", 6),
        perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
      },
    ],
  });
  const [c] = compilePolicy({ policy, delegator: account.address, environment: env, now: t });
  if (!c) throw new Error("nothing compiled");
  delegation = { ...c.delegation, signature: await account.signDelegation({ delegation: c.delegation }) };
});

afterAll(() => {
  anvil?.kill();
});

describe("CosignerEnforcer through the deployed DelegationManager (fork)", () => {
  it("is deployed at the predicted CREATE2 address and required by the compiled delegation", async () => {
    expect(await client.getCode({ address: cosignerEnforcerAddress })).toMatch(/^0x6080/);
    expect(delegationCosigner(delegation)?.toLowerCase()).toBe(cosigner.address.toLowerCase());
  });

  it("allows the call with a fresh cosignature for exactly that call", async () => {
    const exec = usdc("1.5");
    const d = withCosignature(delegation, await cosign(exec));
    expect(await simulate(d, exec)).toBe("ok");
    expect(await send(d, exec)).toBe("success");
    const bal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [SHOP] });
    expect(bal).toBe(parseUnits("1.5", 6));
  });

  it("rejects the same call without a cosignature (agent bypassing the service)", async () => {
    expect(await simulate(delegation, usdc("1.5"))).toMatch(/missing-cosignature/);
  });

  it("rejects a cosignature forged with the agent's own key", async () => {
    const exec = usdc("1.5");
    expect(await simulate(withCosignature(delegation, await cosign(exec, agent)), exec)).toMatch(/invalid-cosignature/);
  });

  it("rejects a cosignature for 1.5 USDC used to send 3 USDC (above the off-chain per-payment limit)", async () => {
    const cs = await cosign(usdc("1.5"));
    expect(await simulate(withCosignature(delegation, cs), usdc("3"))).toMatch(/invalid-cosignature/);
  });

  it("rejects replaying a used cosignature", async () => {
    const exec = usdc("0.5");
    const d = withCosignature(delegation, await cosign(exec));
    expect(await send(d, exec)).toBe("success");
    expect(await simulate(d, exec)).toMatch(/already-used/);
  });

  it("rejects an expired cosignature", async () => {
    const exec = usdc("0.5");
    expect(await simulate(withCosignature(delegation, await cosign(exec, cosigner, -1)), exec)).toMatch(/expired/);
  });

  it("still enforces the other on-chain caveats (period cap) even with a valid cosignature", async () => {
    const exec = usdc("4"); // 1.5 + 0.5 already spent today; 4 more would exceed 5/day
    expect(await simulate(withCosignature(delegation, await cosign(exec)), exec)).toMatch(
      /ERC20PeriodTransferEnforcer/,
    );
  });
});
