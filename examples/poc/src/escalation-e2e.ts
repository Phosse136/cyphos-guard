/**
 * Phase 2 end-to-end on a local fork: passkey-only owner + policy service + agent.
 * Exercises all three layers and the approval flow through the real HTTP API, with the owner's
 * passkey simulated by a software authenticator (same bytes a real one produces).
 *
 *   routine  → agent pays within its daily cap on its own
 *   escalate → over the cap: request → owner approves with passkey → agent redeems once
 *   forbidden / over hard max → denied, never offered to the owner
 *   revoke   → passkey-signed userOp disables the grant on-chain → agent has nothing left
 */
import { serve } from "@hono/node-server";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { createApp } from "@phoswallet/policy-service/app";
import { createChainAdapter } from "@phoswallet/policy-service/chain";
import { openStore } from "@phoswallet/policy-service/store";
import { registrationResponse } from "@phoswallet/policy-service/testing";
import {
  buildApprovalDelegation,
  buildUserOp,
  compilePolicy,
  createAgentClient,
  revokeCall,
  userOpToJSON,
} from "@phoswallet/sdk";
import { createSoftPasskey, ensureFork } from "@phoswallet/sdk/testing";
import { type ApprovalRequestJSON, type GrantJSON, parsePolicy } from "@phoswallet/shared";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseEther,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const chain: Chain = baseSepolia;
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const ORIGIN = "http://localhost:3000";
await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");

// ---------- policy service (in-process, in-memory DB) ----------
const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
const app = createApp({
  store: openStore(":memory:"),
  chain: adapter,
  config: { rpId: "localhost", rpName: "phoswallet", origins: [ORIGIN], sessionTtlSeconds: 3600, secureCookies: false },
});
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));
const addr = server.address();
const SERVICE = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

// ---------- output / checks ----------
const failures: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  console.log(
    `  ${pass ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘ FAIL\x1b[0m"} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`,
  );
  if (!pass) failures.push(label);
};
const step = (s: string) => console.log(`\n\x1b[1m▸ ${s}\x1b[0m`);

// ---------- owner (browser stand-in): passkey + cookie session ----------
const passkey = createSoftPasskey({ rpId: "localhost", origin: ORIGIN });
let cookie = "";
const owner = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const res = await fetch(SERVICE + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0] ?? "";
  return { status: res.status, data: (await res.json()) as T };
};

const publicClient: PublicClient = createPublicClient({ chain, transport: http(FORK) });
const env = getSmartAccountsEnvironment(chain.id);
const SHOP = privateKeyToAddress(generatePrivateKey());
const MIXER = privateKeyToAddress(generatePrivateKey());

step("1. Owner registers a passkey with the policy service");
const regOpts = await owner<{ challengeId: string; options: { challenge: string } }>("POST", "/auth/register/options");
const reg = await owner<{ keyId: Hex; x: Hex; y: Hex }>("POST", "/auth/register/verify", {
  challengeId: regOpts.data.challengeId,
  response: registrationResponse(passkey, regOpts.data.options.challenge),
});
check("passkey registered, session started", reg.status === 200 && cookie.startsWith("phos_session="));

step("2. Deploy a passkey-only smart account (first userOp carries the factory call)");
const account = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Hybrid,
  // No EOA owner in this test: every owner action below must be signed by the passkey.
  // In the approver app the user can (and should) add a recovery EOA here.
  deployParams: [zeroAddress, [reg.data.keyId], [BigInt(reg.data.x)], [BigInt(reg.data.y)]],
  deploySalt: keccak256(toHex(passkey.credentialId)),
  signer: { webAuthnAccount: passkey.account, keyId: reg.data.keyId },
});
const passkeyUserOp = async (calls: { to: Address; data?: Hex; value?: bigint }[]) => {
  const op = await buildUserOp(account, publicClient, calls);
  op.signature = await account.signUserOperation({ ...op, chainId: chain.id });
  return owner<{ txHash?: Hex; error?: string }>("POST", "/dev/relay", { userOp: userOpToJSON(op) });
};
const deployed = await passkeyUserOp([{ to: account.address, value: 0n }]);
check(
  "account deployed via passkey-signed userOp",
  !!deployed.data.txHash && (await account.isDeployed()),
  deployed.data.error ?? account.address,
);
await owner("POST", "/dev/fund", { address: account.address });
const link = await owner("PUT", "/me/account", { accountAddress: account.address });
check("service verified the passkey is a signer on-chain and linked the account", link.status === 200);

step("3. Owner grants the agent 0.001 ETH/day to SHOP (hard max 0.01, MIXER forbidden)");
const agentKey = privateKeyToAccount(generatePrivateKey());
await publicClient.request({
  method: "anvil_setBalance" as never,
  params: [agentKey.address, toHex(parseEther("1"))] as never,
});
const now = Number((await publicClient.getBlock()).timestamp);
const policyInput = {
  version: 1,
  chainId: chain.id,
  agent: agentKey.address,
  name: "invoice-bot",
  validFrom: now - 60,
  expiresAt: now + 7 * 86_400,
  permissions: [
    {
      kind: "nativeTransfer",
      recipients: [SHOP],
      perPeriod: { amount: parseEther("0.001").toString(), periodSeconds: 86_400 },
    },
  ],
  escalation: {
    enabled: true,
    approvalTtlSeconds: 900,
    hardMax: [{ token: "native", amount: parseEther("0.01").toString() }],
  },
  forbidden: { targets: [MIXER] },
};
const compiled = compilePolicy({ policy: parsePolicy(policyInput), delegator: account.address, environment: env, now });
const signed = await Promise.all(
  compiled.map(async (c) => ({
    ...c.delegation,
    signature: await account.signDelegation({ delegation: c.delegation }),
  })),
);
const grant = await owner<GrantJSON>("POST", "/grants", { policy: policyInput, delegations: signed });
check("grant stored (delegation signed by the passkey, no gas)", grant.status === 201);

const agent = createAgentClient({
  agent: agentKey,
  account: account.address,
  policyServiceUrl: SERVICE,
  publicClient,
  walletClient: createWalletClient({ account: agentKey, chain, transport: http(FORK) }),
  environment: env,
});

step("4. Routine: agent pays 0.0005 ETH on its own");
const routine = await agent.execute({ to: SHOP, value: parseEther("0.0005"), reason: "API usage" });
check(
  "executed via grant without asking",
  routine.status === "executed",
  routine.status === "executed" ? routine.txHash : JSON.stringify(routine),
);

step("5. Escalation: agent needs 0.005 ETH (over the daily cap)");
const big = await agent.execute({ to: SHOP, value: parseEther("0.005"), reason: "annual licence, invoice #42" });
check(
  "approval request created instead of failing",
  big.status === "pending",
  big.status !== "executed" ? big.violations.join("; ") : "",
);
const pending = await owner<ApprovalRequestJSON[]>("GET", "/requests?status=pending");
const req = pending.data[0];
check("owner sees it in the pending queue", pending.data.length === 1 && req?.value === parseEther("0.005").toString());
if (!req) throw new Error("no pending request");

// Browser stand-in: build the one-shot approval from the raw request fields, sign with the passkey.
const unsigned = buildApprovalDelegation({
  environment: env,
  delegator: account.address,
  agent: req.agent,
  execution: { to: req.to, value: BigInt(req.value), data: req.data },
  expiresAt: req.expiresAt,
});
const approve = await owner<ApprovalRequestJSON & { error?: string }>("POST", `/requests/${req.id}/approve`, {
  delegation: { ...unsigned, signature: await account.signDelegation({ delegation: unsigned }) },
});
check("owner approved with passkey; service re-verified it on-chain", approve.status === 200, approve.data.error ?? "");

const decided = await agent.waitForApproval(req.id, { pollMs: 200 });
const redeemed = await agent.redeemApproval(decided);
check("agent redeemed the approval", "hash" in redeemed, "hash" in redeemed ? redeemed.hash : redeemed.reason);
const replay = await agent.redeemApproval({ ...decided, status: "approved" });
check("the same approval cannot be used twice", !("hash" in replay), "reason" in replay ? replay.reason : "");
const executed = await agent.getRequest(req.id);
check("request marked executed with tx hash", executed.status === "executed" && !!executed.txHash);

step("6. Forbidden & over hard max: denied, never shown to the owner");
const forbidden = await agent.execute({ to: MIXER, value: parseEther("0.0001"), reason: "trust me" });
check("payment to forbidden address denied", forbidden.status === "denied" && forbidden.code === "forbidden");
const huge = await agent.execute({ to: SHOP, value: parseEther("0.05"), reason: "big one" });
check("payment above hard max denied", huge.status === "denied" && huge.code === "over_hard_max");
const stillOne = await owner<ApprovalRequestJSON[]>("GET", "/requests?status=pending");
check("owner's pending queue is empty", stillOne.data.length === 0);

step("7. Owner rejects a request");
const another = await agent.execute({ to: SHOP, value: parseEther("0.002"), reason: "one more" });
if (another.status !== "pending") throw new Error("expected pending");
await owner("POST", `/requests/${another.request.id}/reject`);
const rejected = await agent.waitForApproval(another.request.id, { pollMs: 200 });
check("agent sees rejection", rejected.status === "rejected");

step("8. One-click revoke: passkey-signed userOp disables the grant on-chain");
const g = grant.data;
const revoke = await passkeyUserOp(g.delegations.map((d) => revokeCall(env, d as never)));
check("revocation userOp executed", !!revoke.data.txHash, revoke.data.error ?? revoke.data.txHash ?? "");
const marked = await owner<{ error?: string }>("POST", `/grants/${g.id}/revoked`, { txHash: revoke.data.txHash });
check("service confirmed on-chain that the delegation is disabled", marked.status === 200, marked.data.error ?? "");
const after = await agent.execute({ to: SHOP, value: parseEther("0.0001"), reason: "after revoke" });
check("agent can no longer act or escalate", after.status === "denied" && after.code === "no_grant");

step("Activity log (as the approver app shows it)");
const activity = await owner<{ kind: string; txHash: string | null }[]>("GET", "/activity");
for (const a of [...activity.data].reverse()) console.log(`    ${a.kind.padEnd(18)} ${a.txHash ?? ""}`);

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} check(s) failed\x1b[0m`
    : "\n\x1b[32mAll escalation checks passed.\x1b[0m",
);
server.close();
process.exit(failures.length ? 1 : 0);
