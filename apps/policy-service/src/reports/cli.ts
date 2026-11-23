/**
 * Usage report for the operator of a cyphos-guard instance. Reads the policy-service database READ-ONLY.
 *
 *   node src/reports/cli.ts --db /var/lib/cyphos-guard/app/policy-service.sqlite --out ./reports
 *     [--format all|csv|txt|xlsx[,…]] [--since 2026-11-01] [--until 2026-12-01]
 *     [--delimiter ";"] [--raw]
 *
 * Pseudonymized by default. Set REPORT_SALT (any long random string, kept secret) for IDs that stay the same
 * across exports; without it the IDs are random per run. --raw includes addresses, tx hashes and free text.
 */
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { buildReport } from "./datasets.ts";
import { type Format, writeReport } from "./export.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    out: { type: "string", default: "reports" },
    format: { type: "string", default: "all" },
    since: { type: "string" },
    until: { type: "string" },
    delimiter: { type: "string", default: "," },
    raw: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "usage: report --db <policy-service.sqlite> [--out dir] [--format all|csv|txt|xlsx] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--delimiter ;] [--raw]",
  );
  process.exit(0);
}

const dbPath = values.db ?? process.env.POLICY_DB_PATH;
if (!dbPath) {
  console.error("--db (or POLICY_DB_PATH) is required");
  process.exit(2);
}
const day = (s: string | undefined, flag: string) => {
  if (!s) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(t)) {
    console.error(`${flag} must be YYYY-MM-DD`);
    process.exit(2);
  }
  return t / 1000;
};
const all: Format[] = ["csv", "txt", "xlsx"];
const formats = values.format === "all" ? all : (values.format.split(",") as Format[]);
if (formats.some((f) => !all.includes(f))) {
  console.error("--format must be all, or a list of csv, txt, xlsx");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const report = buildReport(db, {
    since: day(values.since, "--since"),
    until: day(values.until, "--until"),
    raw: values.raw,
    salt: process.env.REPORT_SALT || undefined,
  });
  const files = writeReport(report, values.out, formats, values.delimiter);
  if (report.saltWasRandom && !values.raw)
    console.error("note: REPORT_SALT not set, so pseudonyms differ between exports");
  if (values.raw) console.error("warning: --raw report contains addresses and free text; don't share it");
  for (const f of files) console.log(f);
} finally {
  db.close();
}
