/**
 * `pnpm poc:cosigner`: the co-signer scenario (ADR 0005) on live Base Sepolia (NETWORK=live) or a fork (default).
 *
 * The owner grants the agent 0.001 ETH/day to one shop, WITH a co-signer. Every redemption then needs a fresh
 * cosignature for that exact call. The co-signer key here signs exactly the typed data the policy service
 * signs (`cosignTypedData`). Rejections are broadcast as real transactions so they're visible on Basescan.
 *
 * Needs the deployed CosignerEnforcer (`pnpm contracts:deploy` on live; deployed automatically on a fork) and,
 * on live, ~0.002 test ETH on the PoC owner EOA.
 */

import {
  type Cosignature,
  compilePolicy,
  cosignerEnforcerAddress,
  cosignTypedData,
  deployAccount,
  deployCosignerEnforcer,
  type Execution,
  encodeRedeem,
  revertReason,
  withCosignature,
} from "@cyphos-guard/sdk";
import { ensureFork } from "@cyphos-guard/sdk/testing";
import { parsePolicy } from "@cyphos-guard/shared";
import type { Delegation } from "@metamask/smart-accounts-kit";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
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

const NETWORK = (process.env.NETWORK ?? "fork") as "fork" | "live";
const LIVE_RPC = process.env.RPC_URL || "https://sepolia.base.org";
const RPC = NETWORK === "fork" ? process.env.FORK_RPC_URL || "http://127.0.0.1:8545" : LIVE_RPC;
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);

const link = (kind: "tx" | "address", v: string) =>
  NETWORK === "live" ? `https://sepolia.basescan.org/${kind}/${v}` : `${v} (local fork)`;
const step = (s: string) => console.log(`\n\x1b[1m▸ ${s}\x1b[0m`);
const failures: string[] = [];

if (NETWORK === "fork") await ensureFork(RPC, LIVE_RPC);
const client: PublicClient = createPublicClient({ chain, transport: http(RPC) });
const keys = ensureKeys();
const owner = privateKeyToAccount(keys.owner);
const agent = privateKeyToAccount(keys.agent);
const cosigner = privateKeyToAccount(generatePrivateKey()); // stands in for the policy service's co-signer key
const shop = privateKeyToAddress(generatePrivateKey());
const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
const agentWallet = createWalletClient({ account: agent, chain, transport: http(RPC) });

console.log(`cyphos-guard co-signer scenario on ${NETWORK === "fork" ? "a local fork of " : ""}Base Sepolia (${RPC})`);
console.log(
  `    owner EOA  ${owner.address}\n    agent EOA  ${agent.address}\n    co-signer  ${cosigner.address}\n    shop       ${shop}`,
);

if (NETWORK === "fork") {
  await client.request({
    method: "anvil_setBalance" as never,
    params: [owner.address, toHex(parseEther("1"))] as never,
  });
} else {
  const bal = await client.getBalance({ address: owner.address });
  if (bal < parseEther("0.002")) {
    console.log(`\nThe owner EOA needs ≥ 0.002 test ETH (has ${formatEther(bal)}). Fund ${owner.address} and re-run.`);
    process.exit(2);
  }
}

step("1. CosignerEnforcer is deployed at its deterministic address");
if (NETWORK === "fork") await deployCosignerEnforcer(ownerWallet, client);
if (!(await client.getCode({ address: cosignerEnforcerAddress }))) {
  console.log(`  not deployed at ${cosignerEnforcerAddress}; run \`pnpm contracts:deploy\` first`);
  process.exit(2);
}
console.log(`  ✔ ${link("address", cosignerEnforcerAddress)}`);

step("2. Owner's smart account, funded; agent gas");
const account = await toMetaMaskSmartAccount({
  client,
  implementation: Implementation.Hybrid,
  deployParams: [owner.address, [], [], []],
  deploySalt: keccak256(toHex("cyphos-guard-cosigner-scenario-v1")),
  signer: { account: owner },
});
const deployed = await deployAccount(account, ownerWallet, client);
console.log(
  `  ✔ account ${link("address", account.address)}${deployed ? `\n    deploy tx ${link("tx", deployed)}` : " (already deployed)"}`,
);
const fund = async (to: `0x${string}`, target: bigint, label: string) => {
  const bal = await client.getBalance({ address: to });
  if (bal >= target / 2n) return;
  const hash = await ownerWallet.sendTransaction({ to, value: target - bal });
  await client.waitForTransactionReceipt({ hash });
  console.log(`  ✔ funded ${label} to ${formatEther(target)} ETH  ${link("tx", hash)}`);
};
await fund(account.address, parseEther("0.0012"), "smart account");
// The agent pays its own gas: ~8 txs × 400k gas. Anvil forks price gas far above real Base Sepolia.
if (NETWORK === "fork") {
  await client.request({
    method: "anvil_setBalance" as never,
    params: [agent.address, toHex(parseEther("1"))] as never,
  });
} else {
  const gasBudget = 8n * 400_000n * (await client.getGasPrice()) * 2n;
  await fund(
    agent.address,
    gasBudget > parseEther("0.0003") ? gasBudget : parseEther("0.0003"),
    "agent EOA (its own gas)",
  );
}

step("3. Grant: 0.001 ETH/day to shop, 1 day, WITH co-signer (signed off-chain, no gas)");
const now = Number((await client.getBlock()).timestamp);
const policy = parsePolicy({
  version: 1,
  chainId: 84532,
  agent: agent.address,
  validFrom: now - 60,
  expiresAt: now + 86_400,
  cosigner: cosigner.address,
  permissions: [
    {
      kind: "nativeTransfer",
      recipients: [shop],
      perPeriod: { amount: parseEther("0.001").toString(), periodSeconds: 86_400 },
    },
  ],
});
const [compiled] = compilePolicy({ policy, delegator: account.address, environment: env, now });
if (!compiled) throw new Error("nothing compiled");
const delegation: Delegation = {
  ...compiled.delegation,
  signature: await account.signDelegation({ delegation: compiled.delegation }),
};
console.log(`  ✔ ${delegation.caveats.length} caveats incl. CosignerEnforcer (co-signer ${cosigner.address})`);

// ---------- helpers ----------
const send = (value: string): Execution => ({ to: shop, value: parseEther(value) });
const cosign = async (execution: Execution, signer = cosigner, deadlineIn = 300): Promise<Cosignature> => {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const deadline = BigInt(Number((await client.getBlock()).timestamp) + deadlineIn);
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
const attempt = async (label: string, d: Delegation, execution: Execution, expect: "ok" | RegExp) => {
  const data = encodeRedeem(d, execution);
  let reason = "ok";
  try {
    await client.call({ account: agent, to: env.DelegationManager, data });
  } catch (e) {
    reason = revertReason(e);
  }
  // Broadcast either way (fixed gas for expected rejections) so the result is on-chain evidence.
  const hash: Hex = await agentWallet.sendTransaction({
    to: env.DelegationManager,
    data,
    ...(expect === "ok" ? {} : { gas: 400_000n }),
  });
  const status = (await client.waitForTransactionReceipt({ hash })).status;
  const pass = expect === "ok" ? status === "success" : status === "reverted" && expect.test(reason);
  if (!pass) failures.push(label);
  const mark =
    expect === "ok"
      ? pass
        ? "\x1b[32m✔\x1b[0m"
        : "\x1b[31m✘ FAIL\x1b[0m"
      : pass
        ? "\x1b[33m✘\x1b[0m"
        : "\x1b[31m!! FAIL\x1b[0m";
  console.log(
    `  ${mark} ${label}${expect === "ok" ? "" : `\n    rejected on-chain: ${reason}`}\n    tx ${link("tx", hash)} (status: ${status})`,
  );
  return hash;
};

step("4. Agent pays with a fresh cosignature for exactly that payment");
const pay1 = send("0.0002");
const cs1 = await cosign(pay1);
await attempt("send 0.0002 ETH to shop, co-signed", withCosignature(delegation, cs1), pay1, "ok");

step("5. Compromised agent tries to get around the co-signer");
await attempt(
  "same payment WITHOUT a cosignature (bypassing the service)",
  delegation,
  send("0.0002"),
  /missing-cosignature/,
);
await attempt(
  "cosignature forged with the agent's own key",
  withCosignature(delegation, await cosign(send("0.0002"), agent)),
  send("0.0002"),
  /invalid-cosignature/,
);
await attempt(
  "cosignature for 0.0002 used to send 0.0003",
  withCosignature(delegation, await cosign(send("0.0002"))),
  send("0.0003"),
  /invalid-cosignature/,
);
await attempt("replaying the cosignature from step 4", withCosignature(delegation, cs1), pay1, /already-used/);
await attempt(
  "expired cosignature",
  withCosignature(delegation, await cosign(send("0.0001"), cosigner, -1)),
  send("0.0001"),
  /expired/,
);

step("6. A valid cosignature doesn't lift the on-chain cap");
const big = send("0.0009"); // 0.0002 spent today; 0.0009 more would exceed 0.001/day
await attempt(
  "send 0.0009 ETH with a valid cosignature (over the daily cap)",
  withCosignature(delegation, await cosign(big)),
  big,
  /NativeTokenPeriodTransferEnforcer/,
);

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} check(s) failed:\x1b[0m ${failures.join("; ")}`
    : "\n\x1b[32mAll co-signer checks passed:\x1b[0m co-signed payment executed; missing, forged, mismatched, replayed and expired cosignatures were rejected on-chain; the cap still held.",
);
process.exit(failures.length ? 1 : 0);
