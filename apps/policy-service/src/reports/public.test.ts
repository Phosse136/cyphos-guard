import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { openStore } from "../store.ts";
import { buildReport } from "./datasets.ts";
import { buildPublicStats, renderStatsHtml } from "./public.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SHOP = "0x5555555555555555555555555555555555555555";
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0) / 1000; // Mon 2026-11-16 (ISO week 47)
const WEEK = 7 * 86_400;
const addr = (i: number) => `0x${i.toString(16).padStart(40, "a")}`;
const agentOf = (i: number) => `0x${i.toString(16).padStart(40, "b")}`;
const usdc = (n: string) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, parseUnits(n, 6)] });

/** `n` owners who each pay 1 USDC in week 47; owner 0 also pays in week 48 (alone). Plus a blocked attempt. */
function fixture(n: number) {
  const path = join(mkdtempSync(join(tmpdir(), "cg-public-")), "db.sqlite");
  openStore(path).close();
  const db = new DatabaseSync(path);
  const owner = db.prepare(
    "INSERT INTO owners (credential_id, public_key, x, y, account_address, created_at) VALUES (?,?,?,?,?,?)",
  );
  const grant = db.prepare(
    "INSERT INTO grants (id, account, agent, name, policy, delegations, status, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const act = db.prepare(
    "INSERT INTO activity (account, agent, kind, detail, tx_hash, created_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < n; i++) {
    owner.run(`c${i}`, "pk", "1", "2", addr(i), T0);
    grant.run(
      `g${i}`,
      addr(i),
      agentOf(i),
      "Secret bot name",
      JSON.stringify({ permissions: [] }),
      "[]",
      "active",
      T0,
      null,
    );
    act.run(addr(i), agentOf(i), "grant_created", JSON.stringify({ grantId: `g${i}` }), null, T0 + 60);
    act.run(
      addr(i),
      agentOf(i),
      "routine_executed",
      JSON.stringify({ to: USDC, value: "0", data: usdc("1"), reason: "secret reason" }),
      `0x${"c".repeat(64)}`,
      T0 + 120,
    );
  }
  act.run(
    addr(0),
    agentOf(0),
    "routine_executed",
    JSON.stringify({ to: USDC, value: "0", data: usdc("2"), reason: "x" }),
    null,
    T0 + WEEK,
  );
  act.run(addr(0), agentOf(0), "blocked", JSON.stringify({ code: "forbidden", to: SHOP }), null, T0 + 200);
  return db;
}
const stats = (n: number, threshold = 5) => {
  const db = fixture(n);
  return buildPublicStats(db, buildReport(db, { now: T0 + 2 * WEEK }), { threshold });
};

describe("public stats", () => {
  it("withholds everything while fewer than `threshold` accounts stand behind it", () => {
    const s = stats(3);
    expect(s.owners).toBeNull();
    expect(s.funnel).toEqual({ smartAccount: null, grantedAgent: null, madePayment: null });
    expect(s.payments.total).toBeNull();
    expect(s.usdcPaid).toBeNull();
    expect(s.agentsActive).toBeNull();
    expect(s.weekly.every((w) => w.payments === null && w.activeAccounts === null)).toBe(true);
  });

  it("shows totals once enough accounts contribute", () => {
    const s = stats(6);
    expect(s.owners).toBe(6);
    expect(s.funnel).toEqual({ smartAccount: 6, grantedAgent: 6, madePayment: 6 });
    expect(s.payments.total).toBe(7);
    expect(s.usdcPaid).toBe(8);
    expect(s.agentsActive).toBe(6);
  });

  it("withholds a week with fewer active accounts, even when the totals are public", () => {
    const s = stats(6);
    const [w47, w48] = s.weekly;
    expect(w47).toMatchObject({ week: "2026-W47", activeAccounts: 6, payments: 6, usdcPaid: 6 });
    expect(w48).toMatchObject({ week: "2026-W48", activeAccounts: null, payments: null, usdcPaid: null });
  });

  it("publishes no addresses, pseudonyms, free text, tx hashes or blocked attempts", () => {
    for (const n of [3, 6]) {
      const s = stats(n);
      const out = JSON.stringify(s) + renderStatsHtml(s);
      for (let i = 0; i < n; i++) {
        expect(out.toLowerCase()).not.toContain(addr(i).toLowerCase());
        expect(out.toLowerCase()).not.toContain(agentOf(i).toLowerCase());
      }
      expect(out).not.toMatch(/acct_|agent_|addr_|owner_/);
      expect(out).not.toContain("secret reason");
      expect(out).not.toContain("Secret bot name");
      expect(out).not.toContain("c".repeat(64));
      expect(JSON.stringify(s)).not.toMatch(/blocked|forbidden|rejected/i);
    }
  });

  it("refuses a raw report", () => {
    const db = fixture(6);
    expect(() => buildPublicStats(db, buildReport(db, { raw: true }))).toThrow(/pseudonymized/);
  });

  it("renders a static page without scripts, with the threshold explained", () => {
    const early = renderStatsHtml(stats(3));
    expect(early).not.toMatch(/<script/i);
    expect(early).toContain("Early days");
    expect(early).toContain("fewer than 5");
    const live = renderStatsHtml(stats(6));
    expect(live).not.toContain("Early days");
    expect(live).toContain("2026-W47: 6 payments");
  });
});
