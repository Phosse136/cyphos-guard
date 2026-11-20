/**
 * cyphos-guard Phase 1 PoC: scoped, revocable agent permissions on a MetaMask Hybrid smart account.
 *
 *   NETWORK=fork (default)  local anvil fork of Base Sepolia, spawned automatically, no faucet needed
 *   NETWORK=live            real Base Sepolia; the owner EOA needs ~0.003 test ETH
 *
 * The script is self-checking: if any step that must be rejected goes through, it exits non-zero.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  compilePolicy,
  deployAccount,
  encodeRedeem,
  executeAsOwner,
  revertReason,
  revokeCall,
} from "@cyphos-guard/sdk";
import { parsePolicy } from "@cyphos-guard/shared";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ensureKeys } from "./keys.ts";

// Widened to `Chain`: Base's OP-stack formatter types otherwise don't fit the kit's generic PublicClient.
const chain: Chain = baseSepolia;

const NETWORK = (process.env.NETWORK ?? "fork") as "fork" | "live";
if (NETWORK !== "fork" && NETWORK !== "live") throw new Error(`NETWORK must be fork or live, got ${NETWORK}`);
const LIVE_RPC = process.env.RPC_URL || "https://sepolia.base.org";
const FORK_RPC = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const RPC = NETWORK === "fork" ? FORK_RPC : LIVE_RPC;

const DAILY_LIMIT = parseEther("0.001");
const ACCOUNT_FUNDING = parseEther("0.002");
const AGENT_GAS_FUNDING = parseEther("0.0003");
const OWNER_MIN_BALANCE = parseEther("0.003");
const DAY = 86_400;

// ---------- output helpers ----------
const link = (hash: Hex) => (NETWORK === "live" ? `https://sepolia.basescan.org/tx/${hash}` : `${hash} (local fork)`);
const addrLink = (a: Address) => (NETWORK === "live" ? `https://sepolia.basescan.org/address/${a}` : a);
const step = (s: string) => console.log(`\n\x1b[1m▸ ${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✔\x1b[0m ${s}`);
const blocked = (s: string) => console.log(`  \x1b[33m✘\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);
const failures: string[] = [];

// ---------- fork management ----------
let anvil: ChildProcess | undefined;
async function rpcUp(url: string) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return ((await res.json()) as { result?: string }).result === toHex(baseSepolia.id);
  } catch {
    return false;
  }
}
async function startForkIfNeeded() {
  if (NETWORK !== "fork" || (await rpcUp(FORK_RPC))) return;
  const port = new URL(FORK_RPC).port || "8545";
  anvil = spawn("anvil", ["--fork-url", LIVE_RPC, "--port", port, "--silent"], { stdio: "ignore" });
  anvil.on("error", () => {
    console.error("Could not start anvil. Install Foundry (https://getfoundry.sh) or set NETWORK=live.");
    process.exit(1);
  });
  for (let i = 0; i < 60; i++) {
    if (await rpcUp(FORK_RPC)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("anvil fork did not come up");
}
process.on("exit", () => anvil?.kill());

// ---------- main ----------
async function main() {
  await startForkIfNeeded();
  const keys = ensureKeys();
  const owner = privateKeyToAccount(keys.owner);
  const agent = privateKeyToAccount(keys.agent);
  const shop = privateKeyToAddress(generatePrivateKey()); // the one allowed recipient
  const stranger = privateKeyToAddress(generatePrivateKey()); // not allowed

  const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC) });
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const agentWallet = createWalletClient({ account: agent, chain, transport: http(RPC) });
  const environment = getSmartAccountsEnvironment(baseSepolia.id);

  console.log(`cyphos-guard PoC on ${NETWORK === "fork" ? "a local fork of" : ""} Base Sepolia (${RPC})`);
  info(`owner EOA   ${owner.address}`);
  info(`agent EOA   ${agent.address}`);
  info(`shop        ${shop}  (allowed recipient)`);

  // 0. Fund the owner (fork) or check its balance (live).
  if (NETWORK === "fork") {
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [owner.address, toHex(parseEther("1"))] as never,
    });
  } else {
    const bal = await publicClient.getBalance({ address: owner.address });
    if (bal < OWNER_MIN_BALANCE) {
      console.log(
        `\nThe owner EOA needs ≥ ${formatEther(OWNER_MIN_BALANCE)} Base Sepolia ETH (has ${formatEther(bal)}).`,
      );
      console.log(`Send test ETH to ${owner.address} from a faucet, then re-run:`);
      console.log("  https://portal.cdp.coinbase.com/products/faucet · https://console.optimism.io/faucet");
      process.exit(2);
    }
  }

  // 1. Smart account. Owner = local test EOA for the PoC; Phase 2 adds the passkey signer
  //    (Hybrid supports EOA + WebAuthn signers; see ADR 0001 / docs/passkey-path.md).
  step("1. Create the owner's smart account (MetaMask Hybrid DeleGator)");
  const account = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: keccak256(toHex("cyphos-guard-poc-v1")),
    signer: { account: owner },
  });
  const deployHash = await deployAccount(account, ownerWallet, publicClient);
  ok(
    deployHash
      ? `deployed ${addrLink(account.address)}\n    tx ${link(deployHash)}`
      : `already deployed ${addrLink(account.address)}`,
  );

  const accBal = await publicClient.getBalance({ address: account.address });
  if (accBal < ACCOUNT_FUNDING) {
    const h = await ownerWallet.sendTransaction({ to: account.address, value: ACCOUNT_FUNDING - accBal });
    await publicClient.waitForTransactionReceipt({ hash: h });
    ok(`funded smart account to ${formatEther(ACCOUNT_FUNDING)} ETH  tx ${link(h)}`);
  }
  // The agent pays its own gas (that's why it can't drain the account through gas). ~8 txs × 400k gas.
  const gasPrice = await publicClient.getGasPrice();
  const agentNeeds =
    AGENT_GAS_FUNDING > 8n * 400_000n * gasPrice * 2n ? AGENT_GAS_FUNDING : 8n * 400_000n * gasPrice * 2n;
  const agentBal = await publicClient.getBalance({ address: agent.address });
  if (agentBal < agentNeeds / 2n) {
    if (NETWORK === "fork") {
      await publicClient.request({
        method: "anvil_setBalance" as never,
        params: [agent.address, toHex(agentNeeds)] as never,
      });
      ok(`gave the agent EOA ${formatEther(agentNeeds)} ETH for its own gas (fork)`);
    } else {
      const h = await ownerWallet.sendTransaction({ to: agent.address, value: agentNeeds - agentBal });
      await publicClient.waitForTransactionReceipt({ hash: h });
      ok(`gave the agent EOA ${formatEther(agentNeeds - agentBal)} ETH for its own gas  tx ${link(h)}`);
    }
  }

  // 2. Grant: policy (validated by the zod schema) → one delegation, signed by the owner.
  step("2. Grant the agent: max 0.001 ETH/day, only to `shop`, expires in 7 days");
  const now = Number((await publicClient.getBlock()).timestamp);
  const policy = parsePolicy({
    version: 1,
    chainId: baseSepolia.id,
    agent: agent.address,
    validFrom: now - 60,
    expiresAt: now + 7 * DAY,
    permissions: [
      { kind: "nativeTransfer", recipients: [shop], perPeriod: { amount: DAILY_LIMIT.toString(), periodSeconds: DAY } },
    ],
  });
  const [compiled] = compilePolicy({ policy, delegator: account.address, environment, now });
  if (!compiled) throw new Error("nothing compiled");
  const delegation = {
    ...compiled.delegation,
    signature: await account.signDelegation({ delegation: compiled.delegation }),
  };
  ok(`delegation signed off-chain by the owner (no tx, no gas). Caveats: ${delegation.caveats.length}`);
  for (const c of delegation.caveats) info(`- ${enforcerName(environment, c.enforcer)}`);

  // Agent helpers ------------------------------------------------------------
  const agentSend = async (label: string, to: Address, value: bigint, data: Hex = "0x") => {
    const callData = encodeRedeem(delegation, { to, value, data });
    const tx = { account: agent, to: environment.DelegationManager, data: callData } as const;
    try {
      await publicClient.call(tx);
    } catch (err) {
      return { label, ok: false as const, reason: revertReason(err), callData };
    }
    const hash = await agentWallet.sendTransaction({ to: tx.to, data: callData });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { label, ok: receipt.status === "success", hash, reason: "", callData };
  };
  /** Broadcast anyway with fixed gas so the rejection is visible on-chain (explorer shows a reverted tx). */
  const broadcastRejected = async (callData: Hex) => {
    const hash = await agentWallet.sendTransaction({
      to: environment.DelegationManager,
      data: callData,
      gas: 400_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  };
  const expectOk = async (label: string, to: Address, value: bigint) => {
    const r = await agentSend(label, to, value);
    if (r.ok && r.hash) ok(`${label}\n    tx ${link(r.hash)}`);
    else {
      failures.push(label);
      blocked(`UNEXPECTED REJECTION: ${label}: ${r.reason}`);
    }
  };
  const expectRejected = async (label: string, to: Address, value: bigint, data?: Hex) => {
    const r = await agentSend(label, to, value, data);
    if (r.ok) {
      failures.push(label);
      console.log(`  \x1b[31m!! SECURITY FAILURE: ${label} was NOT rejected  ${r.hash ? link(r.hash) : ""}\x1b[0m`);
      return;
    }
    const onchain = await broadcastRejected(r.callData);
    if (onchain.status !== "reverted") failures.push(`${label} (broadcast did not revert)`);
    blocked(`${label}\n    rejected on-chain: ${r.reason}\n    tx ${link(onchain.hash)} (status: ${onchain.status})`);
  };
  const shopBalance = async () => formatEther(await publicClient.getBalance({ address: shop }));

  // 3. Agent acts within / outside the rules.
  step("3. Agent acts on its own (plain EOA txs to the DelegationManager, no bundler)");
  await expectOk("send 0.0005 ETH to shop (within daily limit)", shop, parseEther("0.0005"));
  await expectRejected("send 0.0006 ETH to shop (would make 0.0011 today > 0.001)", shop, parseEther("0.0006"));
  await expectRejected("send 0.0001 ETH to a stranger (recipient not allowed)", stranger, parseEther("0.0001"));
  await expectRejected(
    "send 0.0001 ETH to shop with calldata (no smuggled calls)",
    shop,
    parseEther("0.0001"),
    "0xdeadbeef",
  );
  info(`shop balance: ${await shopBalance()} ETH`);

  if (NETWORK === "fork") {
    step("3b. (fork only) Fast-forward 1 day: the allowance resets");
    await publicClient.request({ method: "evm_increaseTime" as never, params: [DAY] as never });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });
    await expectOk("send 0.0006 ETH to shop on day 2", shop, parseEther("0.0006"));
    info(`shop balance: ${await shopBalance()} ETH`);
  }

  // 4. Revoke. Owner-only, on-chain, works without cyphos-guard.
  step("4. Owner revokes the grant (DelegationManager.disableDelegation via the smart account)");
  const revokeHash = await executeAsOwner(account, ownerWallet, publicClient, [revokeCall(environment, delegation)]);
  ok(`revoked  tx ${link(revokeHash)}`);
  await expectRejected("send 0.0001 ETH to shop after revocation", shop, parseEther("0.0001"));

  // Summary
  console.log(
    failures.length === 0
      ? "\n\x1b[32mAll checks passed:\x1b[0m routine action succeeded, over-limit / wrong-recipient / smuggled-call / revoked actions were rejected on-chain."
      : `\n\x1b[31m${failures.length} check(s) failed:\x1b[0m ${failures.join("; ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

function enforcerName(env: ReturnType<typeof getSmartAccountsEnvironment>, address: Address) {
  const hit = Object.entries(env.caveatEnforcers).find(([, a]) => String(a).toLowerCase() === address.toLowerCase());
  return hit ? `${hit[0]} (${address})` : address;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
