/**
 * Fork integration: ERC20PerTransferCapEnforcer through the DEPLOYED DelegationManager (Base Sepolia fork) with
 * real test USDC and NO co-signer. Grant: ≤2 USDC per payment, ≤5 USDC/day, to SHOP only. The agent holds the
 * signed delegation and redeems it directly, bypassing the SDK and the policy service.
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
import { type Execution, encodeRedeem, revertReason } from "./delegations.ts";
import { deployAccount } from "./owner.ts";
import { ensureFork } from "./testing/fork.ts";
import { fundUsdc, USDC } from "./testing/usdc.ts";
import { deployPerTransferCapEnforcer, perTransferCapEnforcerAddress } from "./transferCap.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);
const SHOP = privateKeyToAddress(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
let client: PublicClient;
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let delegation: Delegation;

const call = (functionName: "transfer" | "approve", amount: string): Execution => ({
  to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName, args: [SHOP, parseUnits(amount, 6)] }),
});
const simulate = async (execution: Execution) => {
  try {
    await client.call({ account: agent, to: env.DelegationManager, data: encodeRedeem(delegation, execution) });
    return "ok";
  } catch (e) {
    return revertReason(e);
  }
};
const send = async (execution: Execution) => {
  const wallet = createWalletClient({ account: agent, chain, transport: http(FORK) });
  const hash = await wallet.sendTransaction({ to: env.DelegationManager, data: encodeRedeem(delegation, execution) });
  return (await client.waitForTransactionReceipt({ hash })).status;
};
const shopBalance = () =>
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [SHOP] });

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  client = createPublicClient({ chain, transport: http(FORK) });
  for (const a of [owner.address, agent.address]) {
    await client.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("1"))] as never });
  }
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(FORK) });
  await deployPerTransferCapEnforcer(ownerWallet, client);
  const account = await toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { account: owner },
  });
  await deployAccount(account, ownerWallet, client);
  await fundUsdc(client, account.address, parseUnits("100", 6));
  const t = Number((await client.getBlock()).timestamp);
  const policy = parsePolicy({
    version: 1,
    chainId: 84532,
    agent: agent.address,
    validFrom: t - 60,
    expiresAt: t + 86_400,
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

describe("ERC20PerTransferCapEnforcer through the deployed DelegationManager (fork, no co-signer)", () => {
  it("is deployed at the predicted CREATE2 address and part of the compiled delegation", async () => {
    expect(await client.getCode({ address: perTransferCapEnforcerAddress })).toMatch(/^0x6080/);
    expect(delegation.caveats.some((c) => c.enforcer === perTransferCapEnforcerAddress)).toBe(true);
  });

  it("allows a payment of exactly the cap", async () => {
    expect(await send(call("transfer", "2"))).toBe("success");
    expect(await shopBalance()).toBe(parseUnits("2", 6));
  });

  it("rejects a payment one unit above the cap, although the daily budget has room", async () => {
    expect(await simulate(call("transfer", "2.000001"))).toMatch(/ERC20PerTransferCapEnforcer:amount-exceeded/);
  });

  it("rejects approve() (would let the shop pull more than the cap later)", async () => {
    expect(await simulate(call("approve", "1"))).not.toBe("ok");
  });

  it("the daily budget still applies on top: 2 + 2 ok, then 1.5 more is refused", async () => {
    expect(await send(call("transfer", "2"))).toBe("success");
    expect(await simulate(call("transfer", "1.5"))).toMatch(/ERC20PeriodTransferEnforcer/);
  });
});
