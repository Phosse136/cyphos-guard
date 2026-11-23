/**
 * Red team, on a Base Sepolia fork with the DEPLOYED DelegationManager, real test USDC and a real X402Vault:
 * the attacker holds the agent's key and talks to the chain directly (no SDK checks, no policy service, no
 * co-signer). The read-only catalog (testing/attacks.ts, also run live by the canary) plus the attacks that need
 * state changes: expiry, revocation, an exhausted budget, replays, the vault's owner functions.
 *
 * Grant under attack: erc20Transfer ≤2 USDC per payment, ≤5 USDC/day, to SHOP only; x402 ≤1 USDC per payment,
 * ≤5 USDC/day, sellers = [SELLER] (via the vault).
 */

import { parsePolicy } from "@cyphos-guard/shared";
import {
  type Delegation,
  getSmartAccountsEnvironment,
  Implementation,
  type MetaMaskSmartAccount,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.ts";
import { encodeRedeem, revertReason, revokeCall } from "./delegations.ts";
import { deployAccount, executeAsOwner } from "./owner.ts";
import {
  type AttackTarget,
  BASE_SEPOLIA_WETH,
  buildAttacks,
  type ProbeResult,
  runAttackSuite,
  runProbe,
} from "./testing/attacks.ts";
import { ensureFork } from "./testing/fork.ts";
import { fundUsdc, USDC } from "./testing/usdc.ts";
import { deployPerTransferCapEnforcer } from "./transferCap.ts";
import { randomVaultSalt, vaultDeployment, x402VaultAbi } from "./vault.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());
const SHOP = privateKeyToAddress(generatePrivateKey());
const SELLER = privateKeyToAddress(generatePrivateKey());
const usdc = (n: string) => parseUnits(n, 6);

let client: PublicClient;
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let account: MetaMaskSmartAccount;
let target: AttackTarget;
let expiresAt: number;
const results: ProbeResult[] = [];

const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method: method as never, params: params as never }) as Promise<unknown>;
const snapshot = () => rpc("evm_snapshot") as Promise<Hex>;
const restore = (id: Hex) => rpc("evm_revert", [id]);
const ownerWallet = () => createWalletClient({ account: owner, chain, transport: http(FORK) });
const send = async (from: typeof agent, to: Address, data: Hex) => {
  const wallet = createWalletClient({ account: from, chain, transport: http(FORK) });
  try {
    const hash = await wallet.sendTransaction({ to, data, gas: 1_000_000n });
    const r = await client.waitForTransactionReceipt({ hash });
    return r.status === "success" ? "ok" : "reverted";
  } catch (e) {
    return revertReason(e);
  }
};
const simulate = async (from: Address, to: Address, data: Hex) => {
  try {
    await client.call({ account: from, to, data });
    return "ok";
  } catch (e) {
    return revertReason(e);
  }
};
const pay = (d: Delegation, to: Address, amount: bigint) =>
  encodeRedeem(d, {
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  });
const probe = (id: string) => {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`no probe ${id}`);
  return r;
};

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  client = createPublicClient({ chain, transport: http(FORK) });
  for (const a of [owner.address, agent.address, attacker.address]) {
    await rpc("anvil_setBalance", [a, toHex(parseEther("1"))]);
  }
  await deployPerTransferCapEnforcer(ownerWallet(), client);
  account = await toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { account: owner },
  });
  await deployAccount(account, ownerWallet(), client);
  await fundUsdc(client, account.address, usdc("100"));

  const vault = vaultDeployment({
    owner: account.address,
    agent: agent.address,
    token: USDC,
    maxPerPayment: usdc("1"),
    sellers: [SELLER],
    salt: randomVaultSalt(),
  });
  await executeAsOwner(account, ownerWallet(), client, [vault.call]);
  await fundUsdc(client, vault.address, usdc("10"));

  const t = Number((await client.getBlock()).timestamp);
  expiresAt = t + 86_400;
  const policy = parsePolicy({
    version: 1,
    chainId: 84532,
    agent: agent.address,
    validFrom: t - 60,
    expiresAt,
    permissions: [
      {
        kind: "erc20Transfer",
        token: USDC,
        recipients: [SHOP],
        perTx: usdc("2"),
        perPeriod: { amount: usdc("5"), periodSeconds: 86_400 },
      },
      {
        kind: "x402",
        token: USDC,
        sellers: [SELLER],
        vault: vault.address,
        perTx: usdc("1"),
        perPeriod: { amount: usdc("5"), periodSeconds: 86_400 },
      },
    ],
  });
  const signed = await Promise.all(
    compilePolicy({ policy, delegator: account.address, environment: env, now: t }).map(async (c) => ({
      ...c.delegation,
      signature: await account.signDelegation({ delegation: c.delegation }),
    })),
  );
  const [erc20, x402] = signed as [Delegation, Delegation];
  const [name, version] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "name" }),
    client.readContract({
      address: USDC,
      abi: parseAbi(["function version() view returns (string)"]),
      functionName: "version",
    }),
  ]);
  target = {
    environment: env,
    chainId: chain.id,
    account: account.address,
    agent,
    attacker: attacker.address,
    token: USDC,
    otherToken: BASE_SEPOLIA_WETH,
    erc20: { delegation: erc20, recipient: SHOP, perTx: usdc("2") },
    x402: { delegation: x402, vault: vault.address, seller: SELLER, perTx: usdc("1"), tokenName: name, version },
  };
  for (const p of await buildAttacks(target, t)) results.push(await runProbe(client, p));
});

afterAll(() => {
  if (process.env.ATTACK_REPORT)
    console.table(results.map((r) => ({ id: r.id, verdict: r.verdict, reason: r.reason })));
  anvil?.kill();
});

describe("red team: the agent's key is stolen (fork, no co-signer, no service)", () => {
  it("positive controls go through, so 'blocked' below means something", () => {
    const controls = results.filter((r) => r.expect === null);
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const c of controls) expect({ id: c.id, reason: c.reason }).toEqual({ id: c.id, reason: "" });
  });

  it("every attack in the catalog reverts, with the expected reason", () => {
    const attacks = results.filter((r) => r.expect !== null);
    expect(attacks.length).toBeGreaterThanOrEqual(25);
    const notBlocked = attacks
      .filter((r) => r.verdict !== "blocked")
      .map((r) => `${r.id}: ${r.ok ? "WENT THROUGH" : r.reason}`);
    expect(notBlocked).toEqual([]);
  });

  it.each([
    "A01-over-cap",
    "A02-other-recipient",
    "A03-approve",
    "A06-batch",
    "A12-strip-cap-caveat",
    "A15-redelegate-to-attacker",
    "X01-topup-to-agent",
    "X04-vault-pays-attacker",
    "X08-permit",
  ])("%s is blocked", (id) => {
    expect(probe(id).verdict).toBe("blocked");
  });

  it("S01 budget: 2 + 2 + 1 USDC fit the 5 USDC/day budget, the next unit does not", async () => {
    const s = await snapshot();
    const d = target.erc20.delegation;
    for (const amount of ["2", "2", "1"])
      expect(await send(agent, env.DelegationManager, pay(d, SHOP, usdc(amount)))).toBe("ok");
    expect(await simulate(agent.address, env.DelegationManager, pay(d, SHOP, 1n))).toMatch(
      /ERC20PeriodTransferEnforcer:transfer-amount-exceeded/,
    );
    await restore(s);
  });

  it("S02 expiry: one second after expiresAt nothing works", async () => {
    const s = await snapshot();
    await rpc("evm_setNextBlockTimestamp", [toHex(expiresAt + 1)]);
    await rpc("evm_mine");
    expect(await simulate(agent.address, env.DelegationManager, pay(target.erc20.delegation, SHOP, 1n))).toMatch(
      /TimestampEnforcer:expired-delegation/,
    );
    await restore(s);
  });

  it("S03 revoke: once the owner disables the delegation, the agent is locked out at once", async () => {
    const s = await snapshot();
    await executeAsOwner(account, ownerWallet(), client, [revokeCall(env, target.erc20.delegation)]);
    expect(await simulate(agent.address, env.DelegationManager, pay(target.erc20.delegation, SHOP, 1n))).toMatch(
      /CannotUseADisabledDelegation/,
    );
    await restore(s);
  });

  it("S04 replay: a vault payment that went through can't be submitted again", async () => {
    const s = await snapshot();
    const control = probe("control-x402-payment");
    expect(await send(attacker, control.to, control.data)).toBe("ok");
    expect(await simulate(attacker.address, control.to, control.data)).toMatch(
      /authorization is used|used or canceled/i,
    );
    await restore(s);
  });

  it("S05 the agent can't manage the vault: no setSeller, no withdraw", async () => {
    const vault = target.x402?.vault as Address;
    for (const data of [
      encodeFunctionData({ abi: x402VaultAbi, functionName: "setSeller", args: [attacker.address, true] }),
      encodeFunctionData({ abi: x402VaultAbi, functionName: "withdraw", args: [USDC, attacker.address, 1n] }),
    ]) {
      expect(await simulate(agent.address, vault, data)).toMatch(/NotOwner|0x30cd7471/); // NotOwner()
    }
  });

  it("S06 a seller the owner removes can't be paid any more, even with an authorization signed before", async () => {
    const s = await snapshot();
    const control = probe("control-x402-payment");
    const vault = target.x402?.vault as Address;
    await executeAsOwner(account, ownerWallet(), client, [
      { to: vault, data: encodeFunctionData({ abi: x402VaultAbi, functionName: "setSeller", args: [SELLER, false] }) },
    ]);
    expect(await simulate(attacker.address, control.to, control.data)).toMatch(/invalid signature/i);
    await restore(s);
  });

  it("S07 calling the period enforcer's hook directly doesn't touch the owner's budget", async () => {
    const s = await snapshot();
    const d = target.erc20.delegation;
    const period = d.caveats[0] as { enforcer: Address; terms: Hex };
    // The attacker "spends" in the enforcer's own namespace (msg.sender = attacker), hoping to reset or confuse it.
    const hookAbi = parseAbi([
      "function beforeHook(bytes terms, bytes args, bytes32 mode, bytes executionCallData, bytes32 delegationHash, address delegator, address redeemer)",
    ]);
    const exec = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, usdc("2")] });
    const executionCallData = `0x${USDC.slice(2)}${"0".repeat(64)}${exec.slice(2)}` as Hex;
    const hash = hashDelegation(d);
    const hook = encodeFunctionData({
      abi: hookAbi,
      functionName: "beforeHook",
      args: [period.terms, "0x", `0x${"0".repeat(64)}`, executionCallData, hash, account.address, agent.address],
    });
    expect(await send(attacker, period.enforcer, hook)).toBe("ok"); // allowed, but only in the attacker's namespace
    // The owner's budget through the DelegationManager is untouched: the full 5 USDC/day are still there (2+2+1).
    for (const amount of ["2", "2", "1"])
      expect(await send(agent, env.DelegationManager, pay(d, SHOP, usdc(amount)))).toBe("ok");
    expect(await simulate(agent.address, env.DelegationManager, pay(d, SHOP, 1n))).toMatch(/transfer-amount-exceeded/);
    await restore(s);
  });
});

describe("the red team is not vacuous", () => {
  it("it does report a hole for a weaker grant: no per-payment cap (like grants before 0.2.0)", async () => {
    const t = Number((await client.getBlock()).timestamp);
    const weak = parsePolicy({
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
          perPeriod: { amount: usdc("5"), periodSeconds: 86_400 },
        },
      ],
    });
    const [c] = compilePolicy({ policy: weak, delegator: account.address, environment: env, now: t });
    if (!c) throw new Error("nothing compiled");
    const delegation = { ...c.delegation, signature: await account.signDelegation({ delegation: c.delegation }) };
    const { x402: _, ...rest } = target;
    const { holes } = await runAttackSuite(client, { ...rest, erc20: { ...target.erc20, delegation } });
    expect(holes.map((h) => h.id)).toContain("A01-over-cap");
  });
});

describe("known limits (documented in docs/security/threat-model.md, asserted so they can't change silently)", () => {
  it("L01 period boundary: a full budget at the end of one day and another at the start of the next is allowed", async () => {
    const s = await snapshot();
    const d = target.erc20.delegation;
    const start = Number((await client.getBlock()).timestamp);
    // Jump to just before the period that started at validFrom ends.
    const startDate = start - 60;
    await rpc("evm_setNextBlockTimestamp", [toHex(startDate + 86_400 - 30)]);
    await rpc("evm_mine");
    for (const amount of ["2", "2", "1"])
      expect(await send(agent, env.DelegationManager, pay(d, SHOP, usdc(amount)))).toBe("ok");
    await rpc("evm_setNextBlockTimestamp", [toHex(startDate + 86_400 + 1)]);
    await rpc("evm_mine");
    for (const amount of ["2", "2", "1"])
      expect(await send(agent, env.DelegationManager, pay(d, SHOP, usdc(amount)))).toBe("ok");
    // 10 USDC in about a minute; the third period-budget is not reachable before the next day.
    expect(await simulate(agent.address, env.DelegationManager, pay(d, SHOP, 1n))).toMatch(/transfer-amount-exceeded/);
    await restore(s);
  });

  it("L02 the agent can keep paying the allowed recipient until the budget is used up (that's the grant)", async () => {
    expect(probe("control-cap").verdict).toBe("allowed");
  });
});
