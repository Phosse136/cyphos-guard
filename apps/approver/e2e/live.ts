/**
 * LIVE Base Sepolia end-to-end through the real UI (Chromium + virtual WebAuthn authenticator):
 *   passkey → fund the shown account address → "Create account" (passkey-signed userOp via the public Pimlico
 *   bundler) → co-signed ETH grant → agent pays within limit → bigger payment needs approval → Approve with
 *   passkey → one-click Revoke (passkey-signed userOp via bundler) → agent is cut off.
 *
 * Spends ~0.0015 test ETH from POC_OWNER_PRIVATE_KEY (funds the new account) and gas from POC_AGENT_PRIVATE_KEY.
 * Requires `pnpm --filter @cyphos-guard/approver build` and the CosignerEnforcer deployed on Base Sepolia.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "@cyphos-guard/policy-service/app";
import { createChainAdapter } from "@cyphos-guard/policy-service/chain";
import { openStore } from "@cyphos-guard/policy-service/store";
import { ApprovalPending, createCyphosGuard, PolicyViolation } from "@cyphos-guard/sdk";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type PublicClient,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.RPC_URL || "https://sepolia.base.org";
const APP = "http://localhost:3000";
const SHOTS = process.env.E2E_SCREENSHOTS ?? resolve(import.meta.dirname, "screenshots");
const B = "https://sepolia.basescan.org";
mkdirSync(SHOTS, { recursive: true });
const ownerKey = process.env.POC_OWNER_PRIVATE_KEY as `0x${string}` | undefined;
const agentKey = process.env.POC_AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!ownerKey || !agentKey) throw new Error("POC_OWNER_PRIVATE_KEY / POC_AGENT_PRIVATE_KEY missing in .env");

const chain: Chain = baseSepolia;
const client: PublicClient = createPublicClient({ chain, transport: http(RPC) });
const funder = createWalletClient({ account: privateKeyToAccount(ownerKey), chain, transport: http(RPC) });
const agent = privateKeyToAccount(agentKey);
const shop = privateKeyToAddress(generatePrivateKey());
const evidence: { step: string; tx?: string }[] = [];
const failures: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✔" : "✘ FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures.push(label);
};

// ---- live policy service (co-signer enabled) + approver in live mode ----
const adapter = await createChainAdapter({ rpcUrl: RPC, network: "live" });
const deployed = await adapter.ensureEnforcers();
check("CosignerEnforcer deployed on Base Sepolia", deployed.cosigner);
check("ERC20PerTransferCapEnforcer deployed on Base Sepolia", deployed.perTransferCap);
const store = openStore(":memory:");
const service = serve({
  fetch: createApp({
    store,
    chain: adapter,
    config: {
      rpId: "localhost",
      rpName: "cyphos-guard",
      origins: [APP],
      sessionTtlSeconds: 3600,
      secureCookies: false,
      cosigner: privateKeyToAccount(generatePrivateKey()),
    },
  }).fetch,
  port: 8787,
  hostname: "127.0.0.1",
});
const next: ChildProcess = spawn("pnpm", ["exec", "next", "start", "--hostname", "localhost", "--port", "3000"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, NETWORK: "live", RPC_URL: RPC, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
});
const cleanup = () => {
  next.kill();
  service.close();
};
process.on("exit", cleanup);
for (
  let i = 0;
  i < 60 &&
  !(await fetch(APP).then(
    (r) => r.ok,
    () => false,
  ));
  i++
)
  await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
page.on("dialog", (d) => d.accept());
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const shot = (name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });

try {
  console.log("▸ passkey + fund the shown account address");
  await page.goto(APP);
  await page
    .getByText("local fork")
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  await page.getByRole("button", { name: "Create passkey" }).click();
  const addrEl = page.locator("p.font-mono").filter({ hasText: /^0x[0-9a-fA-F]{40}$/ });
  await addrEl.waitFor({ timeout: 30_000 });
  const account = (await addrEl.textContent())?.trim() as Address;
  check(
    "approver shows the counterfactual account address to fund (live)",
    /^0x[0-9a-fA-F]{40}$/.test(account),
    account,
  );
  check(
    "Create account is disabled until funded",
    await page.getByRole("button", { name: "2. Create account" }).isDisabled(),
  );
  await shot("live-1-fund-account");
  const fundTx = await funder.sendTransaction({ to: account, value: parseEther("0.0012") });
  await client.waitForTransactionReceipt({ hash: fundTx });
  evidence.push({ step: "fund account (0.0012 ETH)", tx: fundTx });

  console.log("▸ create account: passkey-signed userOp via the public bundler");
  const create = page.getByRole("button", { name: "2. Create account" });
  await create.waitFor();
  for (let i = 0; i < 20 && (await create.isDisabled()); i++) await page.waitForTimeout(1000);
  await create.click();
  await page.getByText("Pending approvals").waitFor({ timeout: 120_000 });
  check(
    "account deployed via bundler and linked (service verified the passkey on-chain)",
    !!(await client.getCode({ address: account })),
  );

  console.log("▸ co-signed grant: 0.0005 ETH/day to shop");
  await page.getByLabel("Agent address").fill(agent.address);
  await page.getByLabel("ETH recipient").fill(shop);
  await page.getByLabel("ETH per day").fill("0.0005");
  check("co-signer checkbox is on", await page.getByRole("checkbox").isChecked());
  await page.getByRole("button", { name: "Grant (sign with passkey)" }).click();
  await page.getByRole("button", { name: "Revoke" }).waitFor({ timeout: 30_000 });

  const pw = createCyphosGuard({ policyServiceUrl: "http://127.0.0.1:8787", publicClient: client, rpcUrl: RPC, agent });
  console.log("▸ routine: agent pays 0.0002 ETH (co-signed)");
  const routine = await pw.execute({ to: shop, value: parseEther("0.0002"), reason: "API usage" });
  check("routine co-signed payment executed live", routine.via === "grant", routine.txHash);
  evidence.push({ step: "agent pays 0.0002 ETH alone (co-signed)", tx: routine.txHash });

  console.log("▸ escalation: 0.0006 ETH (over the 0.0005/day cap) → approve with passkey");
  let requestId = "";
  try {
    await pw.execute({ to: shop, value: parseEther("0.0006"), reason: "Annual licence" });
  } catch (e) {
    if (e instanceof ApprovalPending) requestId = e.request.id;
  }
  check("over-limit payment became an approval request", requestId !== "");
  await page.getByText("Send 0.0006 ETH").waitFor({ timeout: 20_000 });
  await shot("live-2-pending-approval");
  await page.getByRole("button", { name: "Approve" }).click();
  const approved = await pw.waitForApproval(requestId, { pollMs: 1500, timeoutMs: 90_000 });
  check("approved payment executed live", approved.via === "approval", approved.txHash);
  evidence.push({ step: "owner approves 0.0006 ETH with passkey; agent pays", tx: approved.txHash });

  console.log("▸ one-click revoke: passkey-signed userOp via the bundler");
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByText("revoked", { exact: true }).waitFor({ timeout: 120_000 });
  const revoked = store.activity.list(account).find((a) => a.kind === "grant_revoked");
  check("grant revoked on-chain (service verified)", !!revoked?.txHash, revoked?.txHash ?? "");
  if (revoked?.txHash) evidence.push({ step: "owner revokes with passkey (userOp via bundler)", tx: revoked.txHash });
  let code = "";
  try {
    await pw.execute({ to: shop, value: parseEther("0.0001"), reason: "after revoke" });
  } catch (e) {
    if (e instanceof PolicyViolation) code = e.reason;
  }
  check("after revoke the agent is cut off", code === "no_grant");
  await page.waitForTimeout(5500);
  await shot("live-3-activity");

  const shopBal = await client.getBalance({ address: shop });
  check("shop received 0.0002 + 0.0006 ETH", shopBal === parseEther("0.0008"), `${formatEther(shopBal)} ETH`);
  console.log(`\n  account ${B}/address/${account}`);
  for (const e of evidence) console.log(`  ${e.step}: ${B}/tx/${e.tx}`);
  writeFileSync(resolve(SHOTS, "live-evidence.json"), JSON.stringify({ account, shop, evidence }, null, 2));
} catch (e) {
  await shot("live-failure").catch(() => {});
  failures.push(`exception: ${(e as Error).message.split("\n")[0]}`);
  console.error(e);
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} live check(s) FAILED` : "\nLive Base Sepolia UI e2e passed.");
cleanup();
process.exit(failures.length ? 1 : 0);
