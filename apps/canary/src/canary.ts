/**
 * The canary: our own guarded agent on the live testnet, checked every hour.
 *
 * It owns a small Hybrid smart account (EOA owner, testnet keys on the server only) with a standing grant to its
 * own agent: ≤0.10 USDC per payment, ≤0.50 USDC/day, to one recipient (the account itself, so real test payments
 * cost only gas), plus an x402 vault. Each run:
 *   1. the public endpoints answer (site, app, policy service, stats are fresh),
 *   2. the chain and the bundler are reachable and current,
 *   3. our contracts are deployed at their CREATE2 addresses (code there = exactly our bytecode),
 *   4. the full red-team catalog runs against the live grant (eth_call only, free): every attack must revert and
 *      every positive control must succeed,
 *   5. optionally (--pay) the agent makes one real guarded payment.
 * A change of state (or a breach, always) is sent to the operator's Telegram/Discord/ntfy.
 */

import {
  compilePolicy,
  cosignerEnforcerAddress,
  deployAccount,
  encodeRedeem,
  executeAsOwner,
  perTransferCapEnforcerAddress,
  revertReason,
  vaultDeployment,
} from "@cyphos-guard/sdk";
import { type AttackTarget, BASE_SEPOLIA_WETH, runAttackSuite } from "@cyphos-guard/sdk/testing";
import { parsePolicy } from "@cyphos-guard/shared";
import {
  type Delegation,
  getSmartAccountsEnvironment,
  Implementation,
  type MetaMaskSmartAccount,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {
  type Address,
  type Chain,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  type Hex,
  http,
  keccak256,
  type LocalAccount,
  type PublicClient,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CHAIN: Chain = baseSepolia;

/** Small on purpose: the canary proves enforcement, it doesn't need money. */
export const LIMITS = {
  perTx: 100_000n, // 0.10 USDC
  perPeriod: 500_000n, // 0.50 USDC / day
  x402PerTx: 100_000n,
  vaultFloat: 100_000n, // the vault must hold one payment for the x402 positive control
  accountUsdc: 300_000n, // the account must hold the erc20 cap + one top-up
  accountEth: parseEther("0.0005"), // userOp prefunds for setup
  agentEth: parseEther("0.0002"), // gas for --pay
  /** Real --pay payment (to the account itself). */
  payAmount: 10_000n, // 0.01 USDC
  grantDays: 90, // the policy schema's maximum; `run` renews it when fewer than 30 days are left
} as const;

export type CanaryKeys = {
  owner: LocalAccount & { signTypedData: LocalAccount["signTypedData"] };
  agent: LocalAccount;
};

export type CanaryState = {
  version: 1;
  chainId: number;
  owner: Address;
  agent: Address;
  account: Address;
  vault: Address;
  /** Recipient of the erc20 grant = the account itself (real test payments go round in a circle). */
  recipient: Address;
  /** The vault's only seller (the owner EOA; never actually paid). */
  seller: Address;
  validFrom: number;
  expiresAt: number;
  delegations: { erc20: Delegation; x402: Delegation };
  last?: { status: Status; at: number; alertedAt?: number };
  /** Last real --pay payment (unix seconds). */
  lastPayAt?: number;
};

export type Status = "ok" | "degraded" | "breach";
export type Check = { name: string; ok: boolean; detail: string; level: "breach" | "error" | "warn" };
export type CanaryReport = {
  at: number;
  status: Status;
  checks: Check[];
  attacks: { total: number; blocked: number; holes: string[]; wrongReason: string[]; inconclusive: boolean };
  txHash?: Hex;
};

export function keysFrom(ownerKey: Hex, agentKey: Hex): CanaryKeys {
  return { owner: privateKeyToAccount(ownerKey), agent: privateKeyToAccount(agentKey) };
}

export const CANARY_SALT: Hex = keccak256(toHex("cyphos-guard:canary:v1"));
const VAULT_SALT: Hex = keccak256(toHex("cyphos-guard:canary:vault:v1"));

export function canaryAccount(client: PublicClient, keys: CanaryKeys): Promise<MetaMaskSmartAccount> {
  return toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [keys.owner.address, [], [], []],
    deploySalt: CANARY_SALT,
    signer: { account: keys.owner },
  });
}

const usdcBalance = (client: PublicClient, a: Address) =>
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

/**
 * Idempotent: deploys and funds what is missing, (re)signs the standing grant, returns the state to save.
 * Everything is paid from the OWNER EOA; if it lacks funds, returns what to send to it instead.
 */
export async function setupCanary({
  client,
  rpcUrl,
  keys,
  previous,
  log = console.log,
}: {
  client: PublicClient;
  rpcUrl: string;
  keys: CanaryKeys;
  previous?: CanaryState;
  log?: (m: string) => void;
}): Promise<{ state: CanaryState } | { fund: { address: Address; eth: string; usdc: string } }> {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN.id) throw new Error(`canary is testnet only (Base Sepolia, 84532); RPC is on ${chainId}`);
  const env = getSmartAccountsEnvironment(chainId);
  const wallet = createWalletClient({ account: keys.owner, chain: CHAIN, transport: http(rpcUrl) });
  const account = await canaryAccount(client, keys);
  const vault = vaultDeployment({
    owner: account.address,
    agent: keys.agent.address,
    token: USDC,
    maxPerPayment: LIMITS.x402PerTx,
    sellers: [keys.owner.address],
    salt: VAULT_SALT,
  });

  // What the owner EOA must still pay for (gas headroom included).
  const [accEth, accUsdc, vaultUsdc, agentEth, ownerEth, ownerUsdc, deployed, vaultCode] = await Promise.all([
    client.getBalance({ address: account.address }),
    usdcBalance(client, account.address),
    usdcBalance(client, vault.address),
    client.getBalance({ address: keys.agent.address }),
    client.getBalance({ address: keys.owner.address }),
    usdcBalance(client, keys.owner.address),
    account.isDeployed(),
    client.getCode({ address: vault.address }),
  ]);
  const needEth =
    (accEth < LIMITS.accountEth ? LIMITS.accountEth : 0n) +
    (agentEth < LIMITS.agentEth ? LIMITS.agentEth : 0n) +
    parseEther("0.0005"); // owner's own gas
  const needUsdc =
    (accUsdc < LIMITS.accountUsdc ? LIMITS.accountUsdc - accUsdc : 0n) +
    (vaultUsdc < LIMITS.vaultFloat ? LIMITS.vaultFloat - vaultUsdc : 0n);
  if (ownerEth < needEth || ownerUsdc < needUsdc) {
    return {
      fund: {
        address: keys.owner.address,
        eth: formatEther(needEth > ownerEth ? needEth - ownerEth : 0n),
        usdc: formatUnits(needUsdc > ownerUsdc ? needUsdc - ownerUsdc : 0n, 6),
      },
    };
  }

  const tx = async (label: string, p: Promise<Hex>) => {
    const hash = await p;
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
    log(`  ${label}: ${hash}`);
  };
  if (!deployed) {
    await deployAccount(account, wallet, client);
    log(`  account deployed: ${account.address}`);
  }
  if (accEth < LIMITS.accountEth)
    await tx("ETH → account", wallet.sendTransaction({ to: account.address, value: LIMITS.accountEth }));
  if (agentEth < LIMITS.agentEth)
    await tx("ETH → agent", wallet.sendTransaction({ to: keys.agent.address, value: LIMITS.agentEth }));
  if (accUsdc < LIMITS.accountUsdc) {
    const amount = LIMITS.accountUsdc - accUsdc;
    await tx(
      "USDC → account",
      wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [account.address, amount] }),
    );
  }
  if (!vaultCode) {
    await executeAsOwner(account, wallet, client, [vault.call]);
    log(`  vault deployed: ${vault.address}`);
  }
  if (vaultUsdc < LIMITS.vaultFloat) {
    const amount = LIMITS.vaultFloat - vaultUsdc;
    await tx(
      "USDC → vault",
      wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [vault.address, amount] }),
    );
  }

  // Keep the signed grant while it is valid for another 30 days: its period state lives under its hash.
  const now = Number((await client.getBlock()).timestamp);
  if (previous && previous.account === account.address && previous.expiresAt - now > 30 * 86_400) {
    return { state: { ...previous, vault: vault.address } };
  }
  const validFrom = now - 60;
  const expiresAt = validFrom + LIMITS.grantDays * 86_400;
  const policy = parsePolicy({
    version: 1,
    chainId,
    agent: keys.agent.address,
    validFrom,
    expiresAt,
    permissions: [
      {
        kind: "erc20Transfer",
        token: USDC,
        recipients: [account.address],
        perTx: LIMITS.perTx,
        perPeriod: { amount: LIMITS.perPeriod, periodSeconds: 86_400 },
      },
      {
        kind: "x402",
        token: USDC,
        sellers: [keys.owner.address],
        vault: vault.address,
        perTx: LIMITS.x402PerTx,
        perPeriod: { amount: LIMITS.perPeriod, periodSeconds: 86_400 },
      },
    ],
  });
  const compiled = compilePolicy({ policy, delegator: account.address, environment: env, now });
  const [erc20, x402] = await Promise.all(
    compiled.map(async (c) => ({
      ...c.delegation,
      signature: await account.signDelegation({ delegation: c.delegation }),
    })),
  );
  if (!erc20 || !x402) throw new Error("grant did not compile to two delegations");
  log(`  grant signed (valid ${LIMITS.grantDays} days)`);
  return {
    state: {
      version: 1,
      chainId,
      owner: keys.owner.address,
      agent: keys.agent.address,
      account: account.address,
      vault: vault.address,
      recipient: account.address,
      seller: keys.owner.address,
      validFrom,
      expiresAt,
      delegations: { erc20, x402 },
    },
  };
}

export type RunOptions = {
  client: PublicClient;
  rpcUrl: string;
  bundlerUrl?: string;
  keys: CanaryKeys;
  state: CanaryState;
  /** URL → what the body must contain (a string, or a check on the parsed JSON). */
  endpoints?: Record<string, string | ((json: unknown) => string | null)>;
  pay?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
};

const timed = async (name: string, level: Check["level"], f: () => Promise<string>): Promise<Check> => {
  try {
    return { name, level, ok: true, detail: await f() };
  } catch (e) {
    return { name, level, ok: false, detail: (e as Error).message.split("\n")[0] ?? String(e) };
  }
};

export async function runCanary(o: RunOptions): Promise<CanaryReport> {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const env = getSmartAccountsEnvironment(o.state.chainId);
  const checks: Check[] = [];

  for (const [url, want] of Object.entries(o.endpoints ?? {})) {
    checks.push(
      await timed(`GET ${url}`, "error", async () => {
        const res = await doFetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (typeof want === "string") {
          if (!body.includes(want)) throw new Error(`body lacks "${want}"`);
          return `HTTP ${res.status}`;
        }
        const problem = want(JSON.parse(body));
        if (problem) throw new Error(problem);
        return `HTTP ${res.status}`;
      }),
    );
  }

  checks.push(
    await timed("chain is Base Sepolia and current", "error", async () => {
      const [id, block] = await Promise.all([o.client.getChainId(), o.client.getBlock()]);
      if (id !== o.state.chainId) throw new Error(`chainId ${id}`);
      const age = now() - Number(block.timestamp);
      if (age > 300) throw new Error(`latest block is ${age}s old`);
      return `block ${block.number}, ${age}s old`;
    }),
  );
  if (o.bundlerUrl) {
    const bundlerUrl = o.bundlerUrl;
    checks.push(
      await timed("bundler answers (EntryPoint v0.7)", "error", async () => {
        const res = await doFetch(bundlerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] }),
          signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json()) as { result?: string[] };
        if (!json.result?.some((a) => a.toLowerCase() === entryPoint07Address.toLowerCase()))
          throw new Error(`unexpected answer: ${JSON.stringify(json).slice(0, 120)}`);
        return "ok";
      }),
    );
  }
  checks.push(
    await timed("contracts deployed (DelegationManager, our enforcers, the canary's vault)", "error", async () => {
      const at = {
        DelegationManager: env.DelegationManager,
        ERC20PerTransferCapEnforcer: perTransferCapEnforcerAddress,
        CosignerEnforcer: cosignerEnforcerAddress,
        X402Vault: o.state.vault,
      };
      const missing = [];
      for (const [name, address] of Object.entries(at)) {
        if (!(await o.client.getCode({ address }))) missing.push(name);
      }
      if (missing.length) throw new Error(`no code: ${missing.join(", ")}`);
      return "CREATE2 addresses have code";
    }),
  );
  checks.push(
    await timed("canary funds and grant validity", "warn", async () => {
      const [acc, vault, agentEth] = await Promise.all([
        usdcBalance(o.client, o.state.account),
        usdcBalance(o.client, o.state.vault),
        o.client.getBalance({ address: o.state.agent }),
      ]);
      const daysLeft = Math.floor((o.state.expiresAt - now()) / 86_400);
      const problems = [];
      if (acc < LIMITS.perTx + LIMITS.x402PerTx) problems.push(`account holds ${formatUnits(acc, 6)} USDC`);
      if (vault < LIMITS.vaultFloat) problems.push(`vault holds ${formatUnits(vault, 6)} USDC`);
      if (o.pay && agentEth < parseEther("0.00002")) problems.push(`agent has ${formatEther(agentEth)} ETH`);
      if (daysLeft < 7) problems.push(`grant expires in ${daysLeft} days (renewal failed?)`);
      if (problems.length) throw new Error(`${problems.join("; ")}: run "canary setup"`);
      return `grant valid ${daysLeft} more days`;
    }),
  );

  // The red team, live. A hole is a breach; a failed positive control makes the run inconclusive.
  const usdcMeta = await Promise.all([
    o.client.readContract({ address: USDC, abi: erc20Abi, functionName: "name" }),
    o.client.readContract({
      address: USDC,
      abi: parseAbi(["function version() view returns (string)"]),
      functionName: "version",
    }),
  ]).catch(() => ["USDC", "2"] as const);
  const target: AttackTarget = {
    environment: env,
    chainId: o.state.chainId,
    account: o.state.account,
    agent: o.keys.agent,
    attacker: "0x000000000000000000000000000000000000dEaD",
    token: USDC,
    otherToken: BASE_SEPOLIA_WETH,
    erc20: { delegation: o.state.delegations.erc20, recipient: o.state.recipient, perTx: LIMITS.perTx },
    x402: {
      delegation: o.state.delegations.x402,
      vault: o.state.vault,
      seller: o.state.seller,
      perTx: LIMITS.x402PerTx,
      tokenName: usdcMeta[0],
      version: usdcMeta[1],
    },
  };
  let attacks: CanaryReport["attacks"] = { total: 0, blocked: 0, holes: [], wrongReason: [], inconclusive: true };
  try {
    const suite = await runAttackSuite(o.client, target);
    const list = suite.results.filter((r) => r.expect !== null);
    attacks = {
      total: list.length,
      blocked: list.filter((r) => r.verdict === "blocked").length,
      holes: suite.holes.map((r) => r.id),
      wrongReason: suite.wrongReason.map((r) => `${r.id}: ${r.reason}`),
      inconclusive: suite.inconclusive,
    };
    const failedControls = suite.results.filter((r) => r.expect === null && !r.ok);
    checks.push({
      name: "red team: every attack reverts",
      level: "breach",
      ok: attacks.holes.length === 0,
      detail: attacks.holes.length
        ? `WENT THROUGH: ${attacks.holes.join(", ")}`
        : `${attacks.blocked}/${attacks.total} blocked`,
    });
    checks.push({
      name: "red team: positive controls succeed",
      level: "error",
      ok: failedControls.length === 0,
      detail: failedControls.length ? failedControls.map((r) => `${r.id}: ${r.reason}`).join("; ") : "all controls ok",
    });
    checks.push({
      name: "red team: attacks revert for the expected reason",
      level: "warn",
      ok: attacks.wrongReason.length === 0,
      detail: attacks.wrongReason.length ? attacks.wrongReason.join("; ") : "all as expected",
    });
  } catch (e) {
    checks.push({ name: "red team ran", level: "error", ok: false, detail: revertReason(e) });
  }

  let txHash: Hex | undefined;
  if (o.pay) {
    checks.push(
      await timed("real guarded payment (0.01 USDC, to the account itself)", "error", async () => {
        const wallet = createWalletClient({ account: o.keys.agent, chain: CHAIN, transport: http(o.rpcUrl) });
        txHash = await wallet.sendTransaction({
          to: env.DelegationManager,
          data: encodeRedeem(o.state.delegations.erc20, {
            to: USDC,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [o.state.recipient, LIMITS.payAmount],
            }),
          }),
        });
        const r = await o.client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
        if (r.status !== "success") throw new Error(`reverted: ${txHash}`);
        return txHash;
      }),
    );
  }

  const failed = checks.filter((c) => !c.ok);
  const status: Status = failed.some((c) => c.level === "breach")
    ? "breach"
    : failed.some((c) => c.level === "error")
      ? "degraded"
      : "ok";
  return { at: now(), status, checks, attacks, ...(txHash ? { txHash } : {}) };
}

/** When to tell the operator: on every change of status, a breach always, and a reminder every 6 h while not ok. */
export function decideAlert(
  last: CanaryState["last"],
  report: CanaryReport,
): { send: boolean; title: string; text: string; urgent: boolean } {
  const failed = report.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `• ${c.name}: ${c.detail}`).join("\n");
  const changed = last?.status !== report.status;
  const remind = report.status !== "ok" && (!last?.alertedAt || report.at - last.alertedAt >= 6 * 3600);
  if (report.status === "breach") {
    return {
      send: true,
      urgent: true,
      title: "Canary: ATTACK WENT THROUGH",
      text: `🚨 cyphos-guard canary: an attack on the live grant was NOT blocked.\n${lines}`,
    };
  }
  if (report.status === "degraded") {
    return {
      send: changed || remind,
      urgent: true,
      title: "Canary: degraded",
      text: `⚠️ cyphos-guard canary: something is down or failing.\n${lines}`,
    };
  }
  const warns = failed.length ? `\n(warnings: ${failed.map((c) => c.detail).join("; ")})` : "";
  return {
    send: changed && last !== undefined,
    urgent: false,
    title: "Canary: ok",
    text: `✅ cyphos-guard canary is green again: ${report.attacks.blocked}/${report.attacks.total} attacks blocked on the live grant.${warns}`,
  };
}

/** What the public stats page may show: counts and ids only. */
export function publicStatus(report: CanaryReport, state: CanaryState) {
  return {
    at: report.at,
    status: report.status,
    attacksBlocked: report.attacks.blocked,
    attacksTotal: report.attacks.total,
    controlsOk: !report.attacks.inconclusive,
    // The canary's own test account, so anyone can check the grant on a block explorer.
    account: state.account,
    checks: report.checks.map((c) => ({ name: c.name, ok: c.ok })),
  };
}
