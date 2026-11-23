/**
 * The canary end to end on a Base Sepolia fork: setup asks for funds, then deploys and signs everything; run is
 * green (with a real payment); a revoked grant makes it degraded (controls fail, nothing is "blocked" for the wrong
 * reason); the alert logic fires on changes only.
 */
import { deployPerTransferCapEnforcer, executeAsOwner, revokeCall } from "@cyphos-guard/sdk";
import { ensureFork, fundUsdc } from "@cyphos-guard/sdk/testing";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { createPublicClient, createWalletClient, http, type PublicClient, parseEther, toHex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CanaryReport,
  type CanaryState,
  CHAIN,
  canaryAccount,
  decideAlert,
  keysFrom,
  publicStatus,
  runCanary,
  setupCanary,
} from "./canary.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const keys = keysFrom(generatePrivateKey(), generatePrivateKey());
let client: PublicClient;
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let state: CanaryState;
const okFetch = (async () => new Response("<title>cyphos-guard</title>")) as unknown as typeof fetch;
const endpoints = { "https://site.test/": "cyphos-guard" };
const run = (s: CanaryState, pay = false) =>
  runCanary({
    client,
    rpcUrl: FORK,
    keys,
    state: s,
    endpoints,
    fetch: okFetch,
    pay,
    now: () => Math.floor(Date.now() / 1000),
  });

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  client = createPublicClient({ chain: CHAIN, transport: http(FORK) });
  // anvil's fork clock can lag; the block-age check compares with the wall clock.
  await client.request({
    method: "evm_setNextBlockTimestamp" as never,
    params: [toHex(Math.floor(Date.now() / 1000))] as never,
  });
  await client.request({ method: "evm_mine" as never, params: [] as never });
  const funder = keysFrom(generatePrivateKey(), generatePrivateKey()).owner;
  await client.request({
    method: "anvil_setBalance" as never,
    params: [funder.address, toHex(parseEther("1"))] as never,
  });
  await deployPerTransferCapEnforcer(
    createWalletClient({ account: funder, chain: CHAIN, transport: http(FORK) }),
    client,
  );
});

afterAll(() => anvil?.kill());

describe("canary (fork)", () => {
  it("setup without funds says what to send to the owner EOA, and changes nothing", async () => {
    const r = await setupCanary({ client, rpcUrl: FORK, keys, log: () => {} });
    expect("fund" in r && r.fund.address).toBe(keys.owner.address);
    expect(await (await canaryAccount(client, keys)).isDeployed()).toBe(false);
  });

  it("setup with funds deploys the account and the vault, funds them and signs a 90-day grant", async () => {
    await client.request({
      method: "anvil_setBalance" as never,
      params: [keys.owner.address, toHex(parseEther("0.01"))] as never,
    });
    await fundUsdc(client, keys.owner.address, 1_000_000n);
    const r = await setupCanary({ client, rpcUrl: FORK, keys, log: () => {} });
    if (!("state" in r)) throw new Error(`still asks for funds: ${JSON.stringify(r)}`);
    state = r.state;
    expect(await client.getCode({ address: state.vault })).toBeTruthy();
    expect(state.expiresAt - state.validFrom).toBeGreaterThan(89 * 86_400);
    // Idempotent: a second setup keeps the same grant (its period state lives under its hash).
    const again = await setupCanary({ client, rpcUrl: FORK, keys, previous: state, log: () => {} });
    expect("state" in again && again.state.delegations.erc20.salt).toBe(state.delegations.erc20.salt);
  });

  it("run is green: every attack blocked, controls ok, a real payment went through", async () => {
    // anvil's gas price is far above Base Sepolia's (~0.001 gwei), where the agent's 0.0002 ETH last for months.
    await client.request({
      method: "anvil_setBalance" as never,
      params: [keys.agent.address, toHex(parseEther("0.01"))] as never,
    });
    const report = await run(state, true);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.status).toBe("ok");
    expect(report.attacks.total).toBeGreaterThanOrEqual(25);
    expect(report.attacks.blocked).toBe(report.attacks.total);
    expect(report.txHash).toMatch(/^0x/);
    const pub = publicStatus(report, state);
    expect(JSON.stringify(pub)).not.toMatch(/KEY|private|0x[0-9a-f]{64}/i);
  });

  it("a revoked grant is reported as degraded (controls fail), not as a green 'all blocked'", async () => {
    const snap = (await client.request({ method: "evm_snapshot" as never, params: [] as never })) as string;
    const account = await canaryAccount(client, keys);
    const wallet = createWalletClient({ account: keys.owner, chain: CHAIN, transport: http(FORK) });
    await executeAsOwner(account, wallet, client, [
      revokeCall(getSmartAccountsEnvironment(CHAIN.id), state.delegations.erc20),
    ]);
    const report = await run(state);
    expect(report.status).toBe("degraded");
    expect(report.attacks.inconclusive).toBe(true);
    expect(report.checks.find((c) => c.name.includes("positive controls"))?.ok).toBe(false);
    await client.request({ method: "evm_revert" as never, params: [snap] as never });
  });

  it("a site that is down makes the run degraded", async () => {
    const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const report = await runCanary({ client, rpcUrl: FORK, keys, state, endpoints, fetch: down });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name.startsWith("GET"))?.detail).toBe("HTTP 502");
  });
});

describe("alerts", () => {
  const report = (status: CanaryReport["status"], at = 1_000_000): CanaryReport => ({
    at,
    status,
    checks:
      status === "ok"
        ? []
        : [{ name: "x", ok: false, detail: "down", level: status === "breach" ? "breach" : "error" }],
    attacks: { total: 25, blocked: status === "breach" ? 24 : 25, holes: [], wrongReason: [], inconclusive: false },
  });

  it("first run green: no message; green to green: no message", () => {
    expect(decideAlert(undefined, report("ok")).send).toBe(false);
    expect(decideAlert({ status: "ok", at: 1 }, report("ok")).send).toBe(false);
  });
  it("green to degraded: message; still degraded: a reminder only every 6 h", () => {
    expect(decideAlert({ status: "ok", at: 1 }, report("degraded")).send).toBe(true);
    const last = { status: "degraded" as const, at: 999_000, alertedAt: 999_000 };
    expect(decideAlert(last, report("degraded", 1_000_000)).send).toBe(false);
    expect(decideAlert(last, report("degraded", 999_000 + 6 * 3600)).send).toBe(true);
  });
  it("a breach always alerts, urgently; recovery says so", () => {
    const b = decideAlert({ status: "breach", at: 1, alertedAt: 999_999 }, report("breach"));
    expect(b).toMatchObject({ send: true, urgent: true });
    expect(decideAlert({ status: "degraded", at: 1 }, report("ok")).text).toMatch(/green again/);
  });
});
