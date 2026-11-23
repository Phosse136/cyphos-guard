import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import { encodeFunctionData, erc20Abi, parseEther, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { openStore } from "../store.ts";
import { buildReport, isoWeek, ownerTxCategory } from "./datasets.ts";
import { toCsv, toTxt, toXlsx, writeReport } from "./export.ts";
import { colName, sheetNames } from "./xlsx.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const AG = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHOP = "0x5555555555555555555555555555555555555555";
const T0 = Date.UTC(2026, 10, 20, 10, 0, 0) / 1000; // Fri 2026-11-20 10:00 UTC
const usdc = (n: string) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, parseUnits(n, 6)] });

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "cg-report-")), "db.sqlite");
  openStore(path).close(); // creates the schema
  const db = new DatabaseSync(path);
  const owner = db.prepare(
    "INSERT INTO owners (credential_id, public_key, x, y, account_address, created_at) VALUES (?,?,?,?,?,?)",
  );
  owner.run("c1", "pk", "1", "2", A1, T0);
  owner.run("c2", "pk", "1", "2", A2, T0 + 86_400 * 2);
  owner.run("c3", "pk", "1", "2", null, T0 + 86_400 * 2); // registered, never created an account
  db.prepare(
    "INSERT INTO grants (id, account, agent, name, policy, delegations, status, created_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "g-1234567890",
    A1,
    AG,
    "Invoice bot",
    JSON.stringify({ permissions: [{ kind: "erc20Transfer" }, { kind: "nativeTransfer" }], cosigner: SHOP }),
    "[]",
    "active",
    T0 + 60,
    null,
  );
  const act = db.prepare(
    "INSERT INTO activity (account, agent, kind, detail, tx_hash, created_at) VALUES (?,?,?,?,?,?)",
  );
  const d = (o: object) => JSON.stringify(o);
  act.run(A1, AG, "grant_created", d({ grantId: "g-1234567890", name: "Invoice bot" }), null, T0 + 60);
  act.run(
    A1,
    AG,
    "routine_executed",
    d({ to: USDC, value: "0", data: usdc("1.2"), reason: "secret reason" }),
    "0xabc",
    T0 + 120,
  );
  act.run(
    A1,
    AG,
    "routine_executed",
    d({ to: SHOP, value: parseEther("0.0005").toString(), data: "0x" }),
    "0xabd",
    T0 + 180,
  );
  act.run(A1, AG, "request_created", d({ requestId: "r1" }), null, T0 + 240);
  act.run(A1, AG, "request_approved", d({ requestId: "r1" }), null, T0 + 840);
  act.run(A1, AG, "request_executed", d({ to: USDC, value: "0", data: usdc("4") }), "0xabe", T0 + 900);
  act.run(
    A1,
    AG,
    "request_denied",
    d({
      code: "forbidden",
      message: "denylisted",
      to: SHOP,
      value: "300000000000000",
      data: "0x",
      reason: "pay DataHarvest",
    }),
    null,
    T0 + 960,
  );
  act.run(
    A2,
    null,
    "owner_tx",
    d({ summary: ["created the account", "sent 0.0001 ETH → 0xeA59…21cF"] }),
    "0xabf",
    T0 + 86_400 * 3,
  );
  const req = db.prepare(
    "INSERT INTO requests (id, account, agent, target, value, data, reason, status, created_at, expires_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  req.run("r1-aaaaaaaa", A1, AG, USDC, "0", usdc("4"), "annual plan", "executed", T0 + 240, T0 + 1140, T0 + 840);
  req.run("r2-bbbbbbbb", A1, AG, USDC, "0", usdc("9"), "too big", "pending", T0 + 1000, T0 + 1900, null); // expired
  db.close();
  return new DatabaseSync(path, { readOnly: true });
}

const NOW = T0 + 86_400 * 4;
const table = (r: ReturnType<typeof buildReport>, name: string) => {
  const t = r.tables.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
};
const kpi = (r: ReturnType<typeof buildReport>, metric: string) =>
  table(r, "kpis").rows.find((x) => x.metric === metric)?.value;

describe("usage report", () => {
  it("computes KPIs, the activation funnel and approval stats", () => {
    const r = buildReport(fixture(), { now: NOW, salt: "s" });
    expect(kpi(r, "Registered owners")).toBe(3);
    expect(kpi(r, "Owners with a smart account")).toBe(2);
    expect(kpi(r, "Owners who granted an agent")).toBe(1);
    expect(kpi(r, "Payments")).toBe(3);
    expect(kpi(r, "USDC paid")).toBe(5.2);
    expect(kpi(r, "ETH paid")).toBe(0.0005);
    expect(kpi(r, "Approval requests")).toBe(2);
    expect(kpi(r, "  expired")).toBe(1); // pending past its expiry
    expect(kpi(r, "Approval rate")).toBe(0.5);
    expect(kpi(r, "Median minutes to decision")).toBe(10);
    expect(kpi(r, "Blocked attempts")).toBe(1);
  });

  it("daily table fills gaps and counts per day", () => {
    const daily = table(buildReport(fixture(), { now: NOW, salt: "s" }), "daily").rows;
    expect(daily.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(daily[0]).toMatchObject({
      new_owners: 1,
      payments: 3,
      within_limits: 2,
      after_approval: 1,
      blocked: 1,
      usdc_paid: 5.2,
    });
    expect(daily[1]).toMatchObject({ new_owners: 0, payments: 0, active_accounts: 0 });
    expect(daily[2]).toMatchObject({ new_owners: 2 });
    expect(daily[3]).toMatchObject({ own_transactions: 1, active_accounts: 1 });
  });

  it("pseudonymizes by default and leaves out free text and tx hashes", () => {
    const r = buildReport(fixture(), { now: NOW, salt: "s" });
    const all = JSON.stringify(r.tables);
    for (const secret of [A1, A2, AG, SHOP, "secret reason", "Invoice bot", "0xabc", "DataHarvest", "denylisted"]) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(table(r, "payments").rows[0]?.account).toMatch(/^acct_[0-9a-f]{10}$/);
    // stable with the same salt, different with another
    expect(buildReport(fixture(), { now: NOW, salt: "s" }).tables).toEqual(r.tables);
    expect(table(buildReport(fixture(), { now: NOW, salt: "t" }), "payments").rows[0]?.account).not.toBe(
      table(r, "payments").rows[0]?.account,
    );
  });

  it("x402: the vault top-up is not counted as a second payment", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cg-x402-")), "db.sqlite");
    openStore(path).close();
    const w = new DatabaseSync(path);
    const VAULT = "0x6666666666666666666666666666666666666666";
    const topUp = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [VAULT, parseUnits("3", 6)] });
    const pay = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, parseUnits("3", 6)] });
    const act = w.prepare(
      "INSERT INTO activity (account, agent, kind, detail, tx_hash, created_at) VALUES (?,?,?,?,?,?)",
    );
    act.run(A1, AG, "request_executed", JSON.stringify({ to: USDC, value: "0", data: topUp }), "0x1", T0);
    act.run(A1, AG, "x402_paid", JSON.stringify({ to: USDC, value: "0", data: pay, payer: VAULT }), "0x2", T0 + 5);
    w.close();
    const r = buildReport(new DatabaseSync(path, { readOnly: true }), { now: NOW, salt: "s" });
    expect(kpi(r, "Payments")).toBe(1);
    expect(kpi(r, "USDC paid")).toBe(3);
    expect(table(r, "daily").rows[0]).toMatchObject({ payments: 1, x402: 1, after_approval: 0 });
  });

  it("raw mode includes addresses, reasons and tx hashes", () => {
    const r = buildReport(fixture(), { now: NOW, raw: true });
    const p = table(r, "payments").rows[0];
    expect(p).toMatchObject({ account: A1, recipient: SHOP, reason: "secret reason", tx_hash: "0xabc" });
    expect(table(r, "agents").rows[0]).toMatchObject({ name: "Invoice bot", cosigner: "yes", payments: 3 });
  });

  it("filters events by period", () => {
    const r = buildReport(fixture(), { now: NOW, salt: "s", since: T0 + 86_400 });
    expect(kpi(r, "Payments")).toBe(0);
    expect(kpi(r, "New owners in period")).toBe(2);
    expect(kpi(r, "Owners' own passkey transactions")).toBe(1);
  });

  it("CSV: BOM, header, quoting and custom delimiter", () => {
    const t = table(buildReport(fixture(), { now: NOW, salt: "s" }), "kpis");
    const csv = toCsv(t, ";");
    expect(csv.startsWith("﻿Metric;Value;Note\r\n")).toBe(true);
    expect(csv).toContain("Approval rate;0.5;approved / requested");
    expect(toCsv(t)).toContain('"within limits + after approval + x402"'.replace(/"/g, "")); // no comma → unquoted
    expect(toCsv({ ...t, rows: [{ metric: 'a "b", c', value: 1, note: "" }] })).toContain('"a ""b"", c",1,');
  });

  it("TXT renders every table", () => {
    const txt = toTxt(buildReport(fixture(), { now: NOW, salt: "s" }));
    for (const title of [
      "Key figures",
      "Daily activity",
      "Owners",
      "Payments",
      "Approval requests",
      "Blocked attempts",
    ])
      expect(txt).toContain(title);
    expect(txt).toContain("Mode: pseudonymized (stable key)");
  });

  it("XLSX is a valid zip with one sheet per table, real numbers and dates", () => {
    const buf = toXlsx(buildReport(fixture(), { now: NOW, salt: "s" }));
    const files = unzip(buf);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]),
    );
    expect(files["xl/workbook.xml"]).toContain('name="Key figures"');
    // sheet order: About, Key figures, Daily, Owners, Agents, Payments, …
    const payments = files["xl/worksheets/sheet6.xml"];
    expect(payments).toMatch(/<c r="F2"><v>1\.2<\/v><\/c>/); // amount as a number
    expect(payments).toMatch(/<c r="A2" s="2"><v>[\d.]+<\/v><\/c>/); // time as an Excel date
    expect(files["xl/worksheets/sheet1.xml"]).not.toContain("autoFilter");
  });

  it("writes files with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-out-"));
    const files = writeReport(buildReport(fixture(), { now: NOW, salt: "s" }), dir, ["csv", "txt", "xlsx"]);
    expect(files.filter((f) => f.endsWith(".csv"))).toHaveLength(8);
    expect(files.some((f) => f.endsWith(".xlsx"))).toBe(true);
    expect(readFileSync(files[0] as string, "utf8").charCodeAt(0)).toBe(0xfeff);
  });

  it("helpers", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(sheetNames(["Owners' own transactions and more text", "a/b", "A/B"])).toEqual([
      "Owners' own transactions and mo",
      "a_b",
      "A_B_2",
    ]);
    expect(isoWeek(T0)).toBe("2026-W47");
    expect(ownerTxCategory("changed the recovery address → 0x1…")).toBe("recovery changed");
  });
});

/** Tiny ZIP reader for the test: local headers only (our writer never uses data descriptors). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString("utf8");
    const data = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    p += 30 + nlen + xlen + csize;
  }
  return out;
}
