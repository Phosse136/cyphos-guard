/**
 * Browser end-to-end test of the approver app (real Chromium + Chrome's virtual WebAuthn authenticator).
 * Retires ADR 0001 risk #2 in a real browser: passkey registration, passkey-signed account deployment,
 * grant, approval and revocation, all through the UI, with a scripted agent on the other side.
 *
 * Starts: anvil fork (if needed), policy-service (in-process, in-memory DB), `next start`.
 * Requires a prior `pnpm --filter @phoswallet/approver build`. Screenshots go to E2E_SCREENSHOTS (or ./e2e/screenshots).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "@phoswallet/policy-service/app";
import { createChainAdapter } from "@phoswallet/policy-service/chain";
import { openStore } from "@phoswallet/policy-service/store";
import { ApprovalPending, createPhoswallet, PolicyViolation } from "@phoswallet/sdk";
import { ensureFork } from "@phoswallet/sdk/testing";
import { chromium } from "playwright-core";
import { type Address, type Chain, createPublicClient, http, type PublicClient, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const chain: Chain = baseSepolia;
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const APP = "http://localhost:3000";
const SHOTS = process.env.E2E_SCREENSHOTS ?? resolve(import.meta.dirname, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const failures: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✔" : "✘ FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures.push(label);
};

await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");

// policy service on the port the Next rewrites point to
const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
await adapter.ensureCosignerEnforcer();
const service = serve({
  fetch: createApp({
    store: openStore(":memory:"),
    chain: adapter,
    config: {
      rpId: "localhost",
      rpName: "phoswallet",
      origins: [APP],
      sessionTtlSeconds: 3600,
      secureCookies: false,
      cosigner: privateKeyToAccount(generatePrivateKey()), // approver grants are co-signed by default
    },
  }).fetch,
  port: 8787,
  hostname: "127.0.0.1",
});

const next: ChildProcess = spawn("pnpm", ["exec", "next", "start", "--hostname", "localhost", "--port", "3000"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, NETWORK: "fork", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
});
const cleanup = () => {
  next.kill();
  service.close();
};
process.on("exit", cleanup);
for (let i = 0; i < 60; i++) {
  if (
    await fetch(APP).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
page.on("dialog", (d) => d.accept()); // the revoke confirmation
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
  console.log("▸ onboarding");
  await page.goto(APP);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Pending approvals").waitFor({ timeout: 60_000 });
  check("passkey registered and smart account deployed from the browser", true);
  const accountAddress = (await page.locator("header span[title]").getAttribute("title")) as Address;

  console.log("▸ grant");
  const agentKey = privateKeyToAccount(generatePrivateKey());
  const shop = privateKeyToAddress(generatePrivateKey());
  const publicClient: PublicClient = createPublicClient({ chain, transport: http(FORK) });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [agentKey.address, toHex(parseEther("1"))] as never,
  });
  await page.getByLabel("Agent address").fill(agentKey.address);
  await page.getByLabel("ETH recipient").fill(shop);
  await page.getByRole("button", { name: "Grant (sign with passkey)" }).click();
  await page.getByRole("button", { name: "Revoke" }).waitFor({ timeout: 30_000 });
  check("agent granted with a passkey-signed delegation", true);

  const agent = createPhoswallet({
    accountAddress,
    policyServiceUrl: "http://127.0.0.1:8787",
    publicClient,
    agent: agentKey,
  });

  console.log("▸ routine + escalation");
  const routine = await agent.execute({ to: shop, value: parseEther("0.0005"), reason: "API usage" });
  check("routine payment executed by the agent alone", routine.via === "grant");
  let requestId = "";
  try {
    await agent.execute({ to: shop, value: parseEther("0.005"), reason: "Annual licence, invoice #42" });
  } catch (e) {
    if (e instanceof ApprovalPending) requestId = e.request.id;
  }
  check("over-limit payment became an approval request (ApprovalPending)", requestId !== "");
  await page.getByText("Send 0.005 ETH").waitFor({ timeout: 15_000 });
  await shot("1-pending-approval");
  check("request shown human-readably in the approver", true);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Nothing waiting").waitFor({ timeout: 30_000 });
  const executed = await agent.waitForApproval(requestId, { pollMs: 300, timeoutMs: 30_000 });
  check("browser passkey approval executed on-chain by the agent", executed.via === "approval", executed.txHash);
  await page.getByText("Approved payment sent").waitFor({ timeout: 15_000 });
  await shot("2-activity-after-approval");

  console.log("▸ revoke");
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByText("revoked", { exact: true }).waitFor({ timeout: 30_000 });
  await shot("3-revoked");
  let code = "";
  try {
    await agent.execute({ to: shop, value: parseEther("0.0001"), reason: "after revoke" });
  } catch (e) {
    if (e instanceof PolicyViolation) code = e.reason;
  }
  check("after one-click revoke the agent can't act or escalate", code === "no_grant");
} catch (e) {
  await shot("failure").catch(() => {});
  failures.push(`exception: ${(e as Error).message.split("\n")[0]}`);
  console.error(e);
} finally {
  await browser.close();
}

console.log(
  failures.length ? `\n${failures.length} browser check(s) FAILED` : `\nBrowser e2e passed. Screenshots: ${SHOTS}`,
);
cleanup();
process.exit(failures.length ? 1 : 0);
