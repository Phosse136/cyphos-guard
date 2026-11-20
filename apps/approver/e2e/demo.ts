/**
 * Browser test of the INTERACTIVE demo exactly as a person runs it (fork):
 *   approver: create passkey + account → open the demo:setup prefill link → grant with passkey
 *   terminal: `demo:agent` (here with --fake-model: scripted Messages API, not Claude)
 *   approver: INV-1043 appears → click Approve (virtual WebAuthn authenticator)
 *   verify: vendor balances on-chain; transcript + screenshots saved for the docs / video.
 * Requires `pnpm --filter @cyphos-guard/approver build` first.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { prefillLink } from "@cyphos-guard/demo-agent/setup";
import { createApp } from "@cyphos-guard/policy-service/app";
import { createChainAdapter } from "@cyphos-guard/policy-service/chain";
import { openStore } from "@cyphos-guard/policy-service/store";
import { ensureFork } from "@cyphos-guard/sdk/testing";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import {
  type Address,
  type Chain,
  createPublicClient,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const chain: Chain = baseSepolia;
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
// Ports are configurable so the tests can run next to a developer's own `pnpm dev` (3000 / 8787 / 8545).
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3000);
const SERVICE_PORT = Number(process.env.E2E_SERVICE_PORT ?? 8787);
const SERVICE = `http://127.0.0.1:${SERVICE_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS ?? resolve(import.meta.dirname, "screenshots");
const root = resolve(import.meta.dirname, "../../..");
mkdirSync(SHOTS, { recursive: true });

const failures: string[] = [];
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✔" : "✘ FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures.push(label);
};

await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
await adapter.ensureCosignerEnforcer();
const service = serve({
  fetch: createApp({
    store: openStore(":memory:"),
    chain: adapter,
    config: {
      rpId: "localhost",
      rpName: "cyphos-guard",
      origins: [APP],
      sessionTtlSeconds: 3600,
      secureCookies: false,
      cosigner: privateKeyToAccount(generatePrivateKey()), // approver grants are co-signed by default
    },
  }).fetch,
  port: SERVICE_PORT,
  hostname: "127.0.0.1",
});
const next: ChildProcess = spawn(
  "pnpm",
  ["exec", "next", "start", "--hostname", "localhost", "--port", String(APP_PORT)],
  {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NETWORK: "fork",
      FORK_RPC_URL: FORK,
      POLICY_SERVICE_URL: SERVICE,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
  },
);
let agentProc: ChildProcess | undefined;
const cleanup = () => {
  agentProc?.kill();
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
// E2E_VIDEO_DIR=<dir>: record the browser for the README GIF (see scripts/make-demo-gif.sh). Adds short
// pauses at key moments so a viewer can follow; without it the test runs at full speed.
const VIDEO_DIR = process.env.E2E_VIDEO_DIR;
const context = await browser.newContext({
  viewport: { width: 1100, height: 1000 },
  ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1100, height: 1000 } } } : {}),
});
const page = await context.newPage();
const pause = (ms: number) => (VIDEO_DIR ? page.waitForTimeout(ms) : Promise.resolve());
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
const shot = async (name: string, hold = 1800) => {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
  await pause(hold);
};
const publicClient: PublicClient = createPublicClient({ chain, transport: http(FORK) });

try {
  console.log("▸ owner onboarding (approver)");
  await page.goto(APP);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Pending approvals").waitFor({ timeout: 60_000 });

  console.log("▸ demo:setup equivalent: agent key, gas, prefill link");
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [agent.address, toHex(parseEther("0.05"))] as never,
  });
  await page.goto(prefillLink(agent.address, APP));
  await page.getByText("Prefilled from a link").waitFor({ timeout: 15_000 });
  check(
    "prefill link filled the grant form (with a review warning)",
    (await page.getByLabel("Agent address").inputValue()) === agent.address,
  );
  await shot("demo-1-grant-prefilled");
  await page.getByRole("button", { name: "Grant (sign with passkey)" }).click();
  await page.getByRole("button", { name: "Revoke" }).waitFor({ timeout: 30_000 });
  check("grant signed with the passkey in the browser", true);

  console.log("▸ pnpm demo:agent --fake-model (separate process, like a second terminal)");
  let transcript = "";
  agentProc = spawn("node", ["examples/demo-agent/src/main.ts", "--fake-model"], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_AGENT_PRIVATE_KEY: agentKey,
      NETWORK: "fork",
      FORK_RPC_URL: FORK,
      POLICY_SERVICE_URL: SERVICE,
    },
  });
  agentProc.stdout?.on("data", (c: Buffer) => {
    transcript += c.toString();
  });
  agentProc.stderr?.on("data", (c: Buffer) => {
    transcript += c.toString();
  });
  const exited = new Promise<number | null>((r) => agentProc?.on("exit", r));

  await page.getByText("Pay 4 USDC").waitFor({ timeout: 60_000 });
  check("INV-1043 shows up as a pending approval, human-readable (Pay 4 USDC)", true);
  await shot("demo-2-pending-approval", 5000); // the key moment: hold it in the recording
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Nothing waiting").waitFor({ timeout: 30_000 });

  const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 90_000))]);
  check("agent process finished cleanly", code === 0, String(code));
  writeFileSync(resolve(SHOTS, "demo-transcript.txt"), stripVTControlCharacters(transcript));
  await page.getByText("Approved payment sent").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(5500); // let the activity list poll once more
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
  await shot("demo-3-activity", 5000);

  console.log("▸ full visibility: agent rights, event details, on-chain receipt, approval history");
  await page.getByRole("button", { name: "Details" }).first().click();
  await page.getByText("Permissions (what it may do on its own)").waitFor({ timeout: 10_000 });
  const rights = (await page.locator("main").textContent()) ?? "";
  check(
    "agent details show per-payment limit, denylist, co-signer and on-chain enforcers",
    /max 2 USDC \(binding via co-signer\)/.test(rights) &&
      /Denylist/.test(rights) &&
      /Enforced on-chain by: .*CosignerEnforcer/.test(rights),
  );
  await page
    .getByRole("button", { name: /Approved payment sent/ })
    .first()
    .click();
  await page.getByText("Agent's reason").first().waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Load on-chain details" }).first().click();
  await page.getByText("On-chain (read from the chain)").waitFor({ timeout: 15_000 });
  check("activity entry shows the reason, request status and the on-chain receipt", true);
  const history = page.getByRole("button", { name: /executed/ }).last();
  await history.scrollIntoViewIfNeeded();
  await history.click();
  // waitFor (not isVisible): the panel renders after the click, so an immediate visibility check races it.
  const historyShown = await page
    .getByText("Approval window until")
    .last()
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  check("approval history lists the executed request", historyShown);
  await page.screenshot({ path: resolve(SHOTS, "demo-4-details.png"), fullPage: true });

  console.log("▸ on-chain verification");
  const usdcOf = (a: Address) =>
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const { VENDORS } = await import("@cyphos-guard/demo-agent/scenario");
  check("Inference API got 1.20 + 4.00 USDC", (await usdcOf(VENDORS.inferenceApi)) === parseUnits("5.2", 6));
  check(
    "GPU market got 0.0005 ETH",
    (await publicClient.getBalance({ address: VENDORS.gpuMarket })) === parseEther("0.0005"),
  );
  check(
    "DataHarvest (forbidden) got nothing",
    (await publicClient.getBalance({ address: VENDORS.dataHarvest })) === 0n,
  );
  check("transcript shows the denial", /INV-1044 blocked by policy \(forbidden\)/.test(transcript));
} catch (e) {
  await shot("demo-failure").catch(() => {});
  failures.push(`exception: ${(e as Error).message.split("\n")[0]}`);
  console.error(e);
} finally {
  await context.close(); // flushes the video file
  if (VIDEO_DIR) console.log(`  video: ${await page.video()?.path()}`);
  await browser.close();
}

console.log(
  failures.length
    ? `\n${failures.length} demo check(s) FAILED`
    : `\nInteractive demo e2e passed. Screenshots + transcript: ${SHOTS}`,
);
cleanup();
process.exit(failures.length ? 1 : 0);
