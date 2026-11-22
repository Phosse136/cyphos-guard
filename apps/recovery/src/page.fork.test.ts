/**
 * The BUILT recovery page in a real browser, on a Base Sepolia fork, clicked through like a person would.
 * The wallet (window.ethereum) is a stand-in for MetaMask, backed by the recovery key.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import { createSoftPasskey, ensureFork } from "@cyphos-guard/sdk/testing";
import { chromium } from "playwright-core";
import { type Address, type Chain, createPublicClient, erc20Abi, http, type PublicClient, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverableSmartAccount, testWallet } from "./fork-fixture.ts";
import { USDC } from "./recovery.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const dist = resolve(import.meta.dirname, "../dist");
const SHOTS = process.env.E2E_SCREENSHOTS;
const recoveryKey = generatePrivateKey();
const recovery = privateKeyToAccount(recoveryKey);
let publicClient: PublicClient;
let account: Address;
let server: Server;
let url: string;
let kill: (() => void) | undefined;

beforeAll(async () => {
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: resolve(import.meta.dirname, ".."), stdio: "ignore" });
  const anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  kill = () => anvil?.kill();
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  account = (await recoverableSmartAccount(publicClient, FORK, recovery.address, createSoftPasskey())).address;
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
  server = createServer((req, res) => {
    const path = join(
      dist,
      (req.url ?? "/").split("?")[0] === "/" ? "index.html" : ((req.url ?? "").split("?")[0] ?? ""),
    );
    try {
      res
        .writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" })
        .end(readFileSync(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(() => {
  server?.close();
  kill?.();
});

describe("recovery page in the browser (fork)", () => {
  it("connect → check → emergency stop → withdraw everything to the recovery address", async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
      // The page's CSP (no network, own script only) must not break anything.
      const cspViolations: string[] = [];
      page.on("console", (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
      });
      const wallet = testWallet(recoveryKey, FORK);
      await page.exposeFunction("__wallet", (method: string, params: unknown[]) =>
        wallet.request({ method, params } as never),
      );
      await page.addInitScript(() => {
        const w = window as unknown as { __wallet: (m: string, p: unknown) => Promise<unknown>; ethereum: unknown };
        w.ethereum = {
          request: ({ method, params }: { method: string; params?: unknown[] }) => w.__wallet(method, params ?? []),
          on: () => {},
          removeListener: () => {},
        };
      });
      await page.goto(`${url}/?account=${account}`);
      await page.getByRole("button", { name: "Connect wallet" }).click();
      await page.getByText(`Connected: ${recovery.address}`).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Check account" }).click();
      await page.getByText("Your wallet is this account's recovery address").waitFor({ timeout: 15_000 });
      expect(await page.getByText("14.8 USDC").isVisible()).toBe(true);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/recovery-1-ready.png`, fullPage: true });
      const dialogs: string[] = [];
      page.once("dialog", (d) => {
        dialogs.push(d.message());
        void d.accept();
      });
      await page.getByRole("button", { name: "Stop all agents" }).click();
      await page.getByText("Done. The passkey was removed").waitFor({ timeout: 30_000 });
      await page.getByText("none (agents stopped)").waitFor({ timeout: 15_000 });
      expect(dialogs[0]).toContain("Stop all agents?");
      expect(await page.getByRole("button", { name: "Stop all agents" }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Withdraw everything to my recovery address" }).click();
      await page.getByText("Done. Everything was sent to your recovery address.").waitFor({ timeout: 30_000 });
      await page.getByText("The account is empty.").waitFor({ timeout: 15_000 });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/recovery-2-done.png`, fullPage: true });
      expect(cspViolations).toEqual([]);
    } finally {
      await browser.close();
    }
    const usdc = (a: Address) =>
      publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
    expect(await usdc(account)).toBe(0n);
    expect(await publicClient.getBalance({ address: account })).toBe(0n);
    expect(await usdc(recovery.address)).toBe(parseUnits("14.8", 6));
  });
});
