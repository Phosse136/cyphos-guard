/**
 * End-to-end on a local fork through the public SDK: a passkey-only owner and an agent, both using
 * createPhoswallet(), talking to the real policy service. Exercises all three layers, the typed errors,
 * ERC-20 (real Base Sepolia test USDC) and grant replacement.
 */
import { serve } from "@hono/node-server";
import { Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { createApp } from "@phoswallet/policy-service/app";
import { createChainAdapter } from "@phoswallet/policy-service/chain";
import { openStore } from "@phoswallet/policy-service/store";
import { registrationResponse } from "@phoswallet/policy-service/testing";
import {
  ApprovalPending,
  ApprovalRejected,
  buildUserOp,
  createPhoswallet,
  encodeRedeem,
  PolicyViolation,
  revertReason,
  userOpToJSON,
} from "@phoswallet/sdk";
import { createSoftPasskey, ensureFork, fundUsdc, USDC } from "@phoswallet/sdk/testing";
import type { PolicyInput } from "@phoswallet/shared";
import {
  type Address,
  type Chain,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseEther,
  parseUnits,
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
await adapter.ensureCosignerEnforcer(); // fork: deploys the CosignerEnforcer at its CREATE2 address
const cosigner = privateKeyToAccount(generatePrivateKey()); // the service's co-signer key (can only block)
const app = createApp({
  store: openStore(":memory:"),
  chain: adapter,
  config: {
    rpId: "localhost",
    rpName: "phoswallet",
    origins: [ORIGIN],
    sessionTtlSeconds: 3600,
    secureCookies: false,
    cosigner,
  },
});
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));
const addr = server.address();
const SERVICE = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

const failures: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  console.log(
    `  ${pass ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘ FAIL\x1b[0m"} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`,
  );
  if (!pass) failures.push(label);
};
const step = (s: string) => console.log(`\n\x1b[1m▸ ${s}\x1b[0m`);
async function expectError<E extends Error>(fn: () => Promise<unknown>, type: abstract new (...a: never[]) => E) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof type ? e : null;
  }
}

// ---------- owner session (stand-in for the approver app) ----------
const passkey = createSoftPasskey({ rpId: "localhost", origin: ORIGIN });
let cookie = "";
const ownerFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0] ?? "";
  return res;
};
const post = async <T>(path: string, body?: unknown) =>
  (await (
    await ownerFetch(SERVICE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  ).json()) as T;

const publicClient: PublicClient = createPublicClient({ chain, transport: http(FORK) });
const SHOP = privateKeyToAddress(generatePrivateKey());
const MIXER = privateKeyToAddress(generatePrivateKey());

step("1. Owner: passkey, passkey-only smart account, link");
const regOpts = await post<{ challengeId: string; options: { challenge: string } }>("/auth/register/options");
const reg = await post<{ keyId: Hex; x: Hex; y: Hex }>("/auth/register/verify", {
  challengeId: regOpts.challengeId,
  response: registrationResponse(passkey, regOpts.options.challenge),
});
const account = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Hybrid,
  deployParams: [zeroAddress, [reg.keyId], [BigInt(reg.x)], [BigInt(reg.y)]],
  deploySalt: keccak256(toHex(passkey.credentialId)),
  signer: { webAuthnAccount: passkey.account, keyId: reg.keyId },
});
const sendCalls = async (calls: { to: Address; data?: Hex; value?: bigint }[]) => {
  const op = await buildUserOp(account, publicClient, calls);
  op.signature = await account.signUserOperation({ ...op, chainId: chain.id });
  const r = await post<{ txHash?: Hex; error?: string }>("/dev/relay", { userOp: userOpToJSON(op) });
  if (!r.txHash) throw new Error(r.error);
  return r.txHash;
};
await sendCalls([{ to: account.address, value: 0n }]); // deploys
await post("/dev/fund", { address: account.address });
await fundUsdc(publicClient, account.address, parseUnits("100", 6));
const linked = await ownerFetch(`${SERVICE}/me/account`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accountAddress: account.address }),
});
check("passkey-only account deployed, funded (ETH + test USDC) and linked", linked.status === 200, account.address);

const owner = createPhoswallet({
  accountAddress: account.address,
  policyServiceUrl: SERVICE,
  publicClient,
  owner: { account, sendCalls, fetch: ownerFetch },
});

step("2. Owner grants: 0.001 ETH/day + 5 USDC/day (max 2 USDC per payment) to SHOP");
const agentKey = privateKeyToAccount(generatePrivateKey());
await publicClient.request({
  method: "anvil_setBalance" as never,
  params: [agentKey.address, toHex(parseEther("1"))] as never,
});
const now = Number((await publicClient.getBlock()).timestamp);
const policy = (dailyEth: string): PolicyInput => ({
  version: 1,
  chainId: 84532,
  agent: agentKey.address,
  validFrom: now - 60,
  expiresAt: now + 7 * 86_400,
  permissions: [
    { kind: "nativeTransfer", recipients: [SHOP], perPeriod: { amount: parseEther(dailyEth), periodSeconds: 86_400 } },
    {
      kind: "erc20Transfer",
      token: USDC,
      recipients: [SHOP],
      perTx: parseUnits("2", 6),
      perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
    },
  ],
  escalation: { enabled: true, approvalTtlSeconds: 900, hardMax: [{ token: "native", amount: parseEther("0.01") }] },
  forbidden: { targets: [MIXER] },
  cosigner: cosigner.address, // makes the 2 USDC per-payment limit binding on-chain
});
const grant = await owner.grantAgent({ policy: policy("0.001") });
check("grant registered (2 passkey-signed delegations, no gas)", grant.delegations.length === 2);

const agent = createPhoswallet({
  accountAddress: account.address,
  policyServiceUrl: SERVICE,
  publicClient,
  agent: agentKey,
});
const usdcTransfer = (amount: string) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, parseUnits(amount, 6)] });

step("3. Routine (agent alone)");
const r1 = await agent.execute({ to: SHOP, value: parseEther("0.0005"), reason: "API usage" });
check("0.0005 ETH paid within grant", r1.via === "grant", r1.txHash);
const r2 = await agent.execute({ to: USDC, data: usdcTransfer("1.5"), reason: "API usage" });
check("1.5 USDC paid within grant", r2.via === "grant", r2.txHash);

step("3b. Compromised agent bypasses the SDK: redeems 3 USDC directly (per-payment limit is 2)");
{
  // Without the co-signer this would pass on-chain (the per-payment cap is an off-chain rule). Now the
  // CosignerEnforcer requires a fresh cosignature the service won't give for 3 USDC.
  const usdcGrant = grant.delegations[1] as never;
  let reason = "";
  try {
    await publicClient.call({
      account: agentKey,
      to: owner.environment.DelegationManager,
      data: encodeRedeem(usdcGrant, { to: USDC, data: usdcTransfer("3") }),
    });
    reason = "succeeded";
  } catch (e) {
    reason = revertReason(e);
  }
  check("direct redemption without cosignature is rejected on-chain", reason !== "succeeded", reason);
}

step("4. Escalation → ApprovalPending → owner approves → waitForApproval executes");
const pending = await expectError(
  () => agent.execute({ to: SHOP, value: parseEther("0.005"), reason: "invoice #42" }),
  ApprovalPending,
);
check("over daily ETH cap → ApprovalPending", !!pending, pending?.violations.join("; "));
const usdcPending = await expectError(
  () => agent.execute({ to: USDC, data: usdcTransfer("3"), reason: "big invoice" }),
  ApprovalPending,
);
check("over per-tx USDC limit (off-chain rule) → ApprovalPending", !!usdcPending, usdcPending?.violations.join("; "));
if (!pending || !usdcPending) throw new Error("no pending requests");
const queue = await owner.getRequests("pending");
check("owner sees both requests", queue.length === 2);
for (const req of queue) await owner.approve(req);
const done = await agent.waitForApproval(pending.request.id, { pollMs: 200 });
check("approved ETH payment executed", done.via === "approval", done.txHash);
const doneUsdc = await agent.waitForApproval(usdcPending.request.id, { pollMs: 200 });
check("approved USDC payment executed", doneUsdc.via === "approval", doneUsdc.txHash);
const shopUsdc = await publicClient.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [SHOP],
});
check("shop received 4.5 USDC", shopUsdc === parseUnits("4.5", 6), shopUsdc.toString());

step("5. Rejection and denials (typed errors)");
const another = await expectError(
  () => agent.execute({ to: SHOP, value: parseEther("0.002"), reason: "one more" }),
  ApprovalPending,
);
if (!another) throw new Error("expected pending");
await owner.reject(another.request.id);
const rejected = await expectError(() => agent.waitForApproval(another.request.id, { pollMs: 200 }), ApprovalRejected);
check("owner rejection → ApprovalRejected", !!rejected);
const forbidden = await expectError(() => agent.execute({ to: MIXER, value: 1n, reason: "trust me" }), PolicyViolation);
check("forbidden address → PolicyViolation(forbidden)", forbidden?.reason === "forbidden");
const huge = await expectError(
  () => agent.execute({ to: SHOP, value: parseEther("0.05"), reason: "big" }),
  PolicyViolation,
);
check("above hard max → PolicyViolation(over_hard_max)", huge?.reason === "over_hard_max");

step("6. Re-grant replaces the old grant (revoked on-chain first, caps don't stack)");
const regrant = await owner.grantAgent({ policy: policy("0.002") });
const grants = await owner.getGrants();
check(
  "old grant revoked, new grant active",
  grants.find((g) => g.id === grant.id)?.status === "revoked" && regrant.status === "active",
);
let staleReason = "";
try {
  // Use the OLD delegation directly, bypassing the SDK: the chain itself must refuse it.
  const data = encodeRedeem(grant.delegations[0] as never, { to: SHOP, value: 1n });
  await publicClient.call({ account: agentKey, to: owner.environment.DelegationManager, data });
} catch (e) {
  staleReason = revertReason(e);
}
check(
  "old delegation is dead on-chain even when used directly",
  /CannotUseADisabledDelegation/.test(staleReason),
  staleReason,
);

step("7. Revoke");
await owner.revoke(regrant.id);
const after = await expectError(() => agent.execute({ to: SHOP, value: 1n, reason: "after revoke" }), PolicyViolation);
check("after revoke → PolicyViolation(no_grant)", after?.reason === "no_grant");

step("Agent's own activity");
for (const a of [...(await agent.getActivity())].reverse()) console.log(`    ${a.kind.padEnd(18)} ${a.txHash ?? ""}`);

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} check(s) failed\x1b[0m`
    : "\n\x1b[32mAll escalation checks passed.\x1b[0m",
);
server.close();
process.exit(failures.length ? 1 : 0);
