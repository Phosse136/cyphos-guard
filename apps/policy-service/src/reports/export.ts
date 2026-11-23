/** Writes a usage report as CSV (one file per table), plain-text and/or XLSX (one sheet per table). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Column, Report, Row, Table } from "./datasets.ts";
import { buildXlsx, type Cell } from "./xlsx.ts";

export type Format = "csv" | "txt" | "xlsx";

const iso = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19);

/** Cell value as text (CSV/TXT). Dates are UTC "YYYY-MM-DD HH:MM:SS"; decimals use a dot. */
function text(c: Column, v: Row[string] | undefined): string {
  if (v === null || v === undefined) return "";
  if (c.type === "date" && typeof v === "number") return iso(v);
  return String(v);
}

function cell(c: Column, v: Row[string] | undefined): Cell {
  if (v === null || v === undefined) return null;
  if (c.type === "date" && typeof v === "number") return new Date(v * 1000);
  if (c.type === "day" && typeof v === "string") return new Date(`${v}T00:00:00Z`);
  return v;
}

/** RFC 4180 CSV with a UTF-8 BOM (so Excel detects the encoding). */
export function toCsv(t: Table, delimiter = ","): string {
  const q = (s: string) => (/[",\n\r;\t]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [t.columns.map((c) => q(c.label)).join(delimiter)];
  for (const r of t.rows) lines.push(t.columns.map((c) => q(text(c, r[c.key]))).join(delimiter));
  return `﻿${lines.join("\r\n")}\r\n`;
}

function header(r: Report): string[] {
  const o = r.options;
  const d = (t?: number) => (t === undefined ? "–" : iso(t).slice(0, 10));
  return [
    `Generated (UTC): ${iso(r.generatedAt)}`,
    `Period: ${o.since || o.until ? `${d(o.since)} to ${d(o.until)} (exclusive)` : "all time"}`,
    o.raw
      ? "Mode: RAW (addresses, tx hashes and free text included; do not share)"
      : `Mode: pseudonymized${r.saltWasRandom ? " (random key: IDs are not comparable with other exports; set REPORT_SALT)" : " (stable key)"}`,
    "Network: Base Sepolia testnet. Amounts are test tokens.",
  ];
}

/** A readable plain-text report: header, then every table as aligned columns. */
export function toTxt(r: Report, maxRows = 200): string {
  const out = ["cyphos-guard usage report", "=".repeat(25), ...header(r), ""];
  for (const t of r.tables) {
    out.push(t.title, "-".repeat(t.title.length), t.description);
    if (t.rows.length === 0) {
      out.push("(no rows)", "");
      continue;
    }
    const shown = t.rows.slice(0, maxRows);
    const cells = shown.map((row) => t.columns.map((c) => text(c, row[c.key]).slice(0, 48)));
    const widths = t.columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => (row[i] ?? "").length)));
    const right = (c: Column) => c.type === "int" || c.type === "number";
    const fmt = (vals: string[]) =>
      vals
        .map((v, i) => {
          const col = t.columns[i] as Column;
          const w = widths[i] ?? 0;
          return right(col) ? v.padStart(w) : v.padEnd(w);
        })
        .join("  ")
        .trimEnd();
    out.push(fmt(t.columns.map((c) => c.label)), widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of cells) out.push(fmt(row));
    if (t.rows.length > maxRows) out.push(`… ${t.rows.length - maxRows} more rows (see CSV/XLSX)`);
    out.push("");
  }
  return out.join("\n");
}

export function toXlsx(r: Report): Buffer {
  const about = [
    ...header(r).map((l) => [l]),
    [""],
    ["Sheet", "Contents"],
    ...r.tables.map((t) => [t.title, t.description]),
  ];
  return buildXlsx([
    { name: "About", header: ["cyphos-guard usage report"], rows: about, widths: [32, 110], filter: false },
    ...r.tables.map((t) => ({
      name: t.title,
      header: t.columns.map((c) => c.label),
      rows: t.rows.map((row) => t.columns.map((c) => cell(c, row[c.key]))),
    })),
  ]);
}

/** Writes the chosen formats into `dir`; returns the written paths. */
export function writeReport(r: Report, dir: string, formats: Format[], delimiter = ","): string[] {
  mkdirSync(dir, { recursive: true });
  const stamp = iso(r.generatedAt).slice(0, 10);
  const written: string[] = [];
  const put = (name: string, data: string | Buffer) => {
    const p = join(dir, name);
    writeFileSync(p, data, { mode: 0o600 });
    written.push(p);
  };
  if (formats.includes("csv"))
    for (const t of r.tables) put(`cyphos-guard-${stamp}-${t.name}.csv`, toCsv(t, delimiter));
  if (formats.includes("txt")) put(`cyphos-guard-${stamp}-report.txt`, toTxt(r));
  if (formats.includes("xlsx")) put(`cyphos-guard-${stamp}-report.xlsx`, toXlsx(r));
  return written;
}
