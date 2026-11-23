/**
 * Writes the PUBLIC, anonymous usage statistics (stats.json + index.html) for app.cyphosguard.com/stats.
 * Reads the policy-service database READ-ONLY. Run hourly by deploy/cyphos-guard-stats.timer.
 *
 *   node src/reports/stats-cli.ts --db /var/lib/cyphos-guard/app/policy-service.sqlite --out /var/lib/cyphos-guard-public/stats
 *     [--threshold 5]
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { buildReport } from "./datasets.ts";
import { buildPublicStats, DEFAULT_THRESHOLD, renderStatsHtml } from "./public.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    out: { type: "string" },
    threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
  },
});
const dbPath = values.db ?? process.env.POLICY_DB_PATH;
if (!dbPath || !values.out) {
  console.error("usage: stats --db <policy-service.sqlite> --out <dir> [--threshold 5]");
  process.exit(2);
}
const threshold = Number(values.threshold);
if (!Number.isInteger(threshold) || threshold < 2) {
  console.error("--threshold must be an integer >= 2");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // Pseudonyms are only used for counting distinct accounts and never leave this process.
  const stats = buildPublicStats(db, buildReport(db), { threshold });
  mkdirSync(values.out, { recursive: true, mode: 0o755 });
  // Atomic replace, so the web server never serves a half-written file.
  const put = (name: string, data: string) => {
    const tmp = join(values.out as string, `.${name}.tmp`);
    writeFileSync(tmp, data, { mode: 0o644 });
    renameSync(tmp, join(values.out as string, name));
  };
  put("stats.json", `${JSON.stringify(stats, null, 2)}\n`);
  put("index.html", renderStatsHtml(stats));
  console.log(`wrote ${values.out}/stats.json and index.html (threshold ${threshold})`);
} finally {
  db.close();
}
