/**
 * Public usage statistics: aggregated, anonymous numbers for a public page (stats.json + a static stats.html).
 *
 * Privacy rules (k-anonymity style, see docs/decisions/0007-public-stats.md):
 * - Only totals. No per-account rows, no addresses or pseudonyms, no free text, no tx hashes.
 * - Every number needs at least `threshold` distinct accounts behind it, otherwise it is withheld (null).
 *   Counts of people below the threshold show as "fewer than N"; activity metrics are withheld entirely.
 * - Weekly series: a week with fewer than `threshold` active accounts shows no values at all.
 * - Never published, whatever the counts: blocked attempts, rejected requests one by one, forbidden lists.
 */
import type { DatabaseSync } from "node:sqlite";
import { isoWeek, type Report, type Row } from "./datasets.ts";

export const DEFAULT_THRESHOLD = 5;

/** A number, or null when fewer than `threshold` accounts stand behind it. */
export type Stat = number | null;

export type PublicStats = {
  generatedAt: number;
  network: "Base Sepolia testnet";
  threshold: number;
  owners: Stat;
  funnel: { smartAccount: Stat; grantedAgent: Stat; madePayment: Stat };
  activeAccounts: { last7Days: Stat; last30Days: Stat };
  agentsActive: Stat;
  payments: { total: Stat; withinLimits: Stat; afterApproval: Stat; x402: Stat };
  usdcPaid: Stat;
  approvals: { requested: Stat; approvalRate: Stat; medianMinutesToDecision: Stat };
  weekly: { week: string; activeAccounts: Stat; payments: Stat; usdcPaid: Stat }[];
};

const table = (r: Report, name: string): Row[] => r.tables.find((t) => t.name === name)?.rows ?? [];
const distinct = (rows: Row[], key = "account") =>
  new Set(rows.map((x) => x[key]).filter((v) => v !== null && v !== undefined)).size;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * `report` must be a pseudonymized, all-time report (buildReport without raw/since/until); `db` is read for
 * weekly active accounts only.
 */
export function buildPublicStats(
  db: DatabaseSync,
  report: Report,
  { threshold = DEFAULT_THRESHOLD, now = report.generatedAt }: { threshold?: number; now?: number } = {},
): PublicStats {
  if (report.options.raw) throw new Error("public stats must be built from a pseudonymized report");
  const k = threshold;
  /** A count of people: withheld below k. */
  const people = (n: number): Stat => (n >= k ? n : null);
  /** A value about activity: withheld unless at least k accounts contributed. */
  const about = (contributors: number, v: number | null): Stat => (contributors >= k ? v : null);

  const owners = table(report, "owners");
  const agents = table(report, "agents");
  const payments = table(report, "payments");
  const approvals = table(report, "approvals");
  const usdc = (rows: Row[]) =>
    round(
      rows.filter((p) => p.token === "USDC").reduce((s, p) => s + Number(p.amount ?? 0), 0),
      2,
    );
  const ofType = (t: string) => payments.filter((p) => p.type === t);
  const payers = distinct(payments);

  const decided = approvals.filter((a) => typeof a.minutes_to_decision === "number");
  const approved = approvals.filter((a) => a.status === "approved" || a.status === "executed").length;
  const requesters = distinct(approvals);

  const activity = db.prepare("SELECT account, created_at FROM activity").all() as {
    account: string;
    created_at: number;
  }[];
  const activeSince = (t: number) =>
    new Set(activity.filter((a) => a.created_at >= t).map((a) => a.account.toLowerCase())).size;

  const weeks = new Map<string, { accounts: Set<string>; payments: Row[] }>();
  const week = (w: string) => {
    let e = weeks.get(w);
    if (!e) {
      e = { accounts: new Set(), payments: [] };
      weeks.set(w, e);
    }
    return e;
  };
  for (const a of activity) week(isoWeek(a.created_at)).accounts.add(a.account.toLowerCase());
  for (const p of payments) if (typeof p.time === "number") week(isoWeek(p.time)).payments.push(p);
  const weekly = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, e]) => {
      const ok = e.accounts.size >= k;
      return {
        week: w,
        activeAccounts: ok ? e.accounts.size : null,
        payments: ok ? e.payments.length : null,
        usdcPaid: ok ? usdc(e.payments) : null,
      };
    });

  return {
    generatedAt: now,
    network: "Base Sepolia testnet",
    threshold: k,
    owners: people(owners.length),
    funnel: {
      smartAccount: people(owners.filter((o) => o.has_account === "yes").length),
      grantedAgent: people(owners.filter((o) => Number(o.agents_granted) > 0).length),
      madePayment: people(owners.filter((o) => Number(o.payments) > 0).length),
    },
    activeAccounts: {
      last7Days: people(activeSince(now - 7 * 86_400)),
      last30Days: people(activeSince(now - 30 * 86_400)),
    },
    agentsActive: about(
      distinct(agents.filter((a) => a.status === "active")),
      agents.filter((a) => a.status === "active").length,
    ),
    payments: {
      total: about(payers, payments.length),
      withinLimits: about(payers, ofType("within limits").length),
      afterApproval: about(payers, ofType("after approval").length),
      x402: about(payers, ofType("x402 API").length),
    },
    usdcPaid: about(payers, usdc(payments)),
    approvals: {
      requested: about(requesters, approvals.length),
      approvalRate: about(requesters, approvals.length ? round(approved / approvals.length, 2) : null),
      medianMinutesToDecision: about(
        distinct(decided),
        (() => {
          const m = median(decided.map((a) => a.minutes_to_decision as number));
          return m === null ? null : round(m, 1);
        })(),
      ),
    },
    weekly,
  };
}

// ---------------------------------------------------------------- static page (no JavaScript)

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CONTRACTS = [
  ["ERC20PerTransferCapEnforcer", "0x4D5a6De281dfDC3d276A787a1fD517DBCe04936b", "per-payment cap"],
  ["CosignerEnforcer", "0x0a2f40e9789235B6ce2a23668FD3F90cef5eefbf", "optional co-signer"],
] as const;

export function renderStatsHtml(s: PublicStats): string {
  const k = s.threshold;
  const fmt = (v: Stat, digits = 0) =>
    v === null
      ? `<span class="held" title="withheld: fewer than ${k} accounts">fewer than ${k}</span>`
      : esc(v.toLocaleString("en-US", { maximumFractionDigits: digits }));
  const pct = (v: Stat) => (v === null ? fmt(null) : `${Math.round(v * 100)}%`);
  const tile = (label: string, value: string, note = "") =>
    `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
  const updated = new Date(s.generatedAt * 1000).toISOString().replace("T", " ").slice(0, 16);
  const early = s.owners === null;

  const funnel = [
    ["Registered", s.owners],
    ["Smart account created", s.funnel.smartAccount],
    ["Granted an agent", s.funnel.grantedAgent],
    ["Agent made a payment", s.funnel.madePayment],
  ] as const;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<script src="theme.js"></script>
<meta name="robots" content="index">
<title>cyphos-guard usage</title>
<meta name="description" content="Live, anonymous usage statistics of the public cyphos-guard instance on Base Sepolia testnet.">
<style>
  :root { color-scheme: light; --bg:#fbfbfd; --card:#fff; --text:#14161c; --muted:#5b6170; --line:#e3e5ec; --brand:#4f46e5; --bar:#4f46e5; --grid:#e3e5ec; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --bg:#0b0d12; --card:#151923; --text:#eceef4; --muted:#a0a6b6; --line:#252a36; --brand:#818cf8; --bar:#6d72f0; --grid:#252a36; } }
  :root[data-theme="dark"] { color-scheme: dark; --bg:#0b0d12; --card:#151923; --text:#eceef4; --muted:#a0a6b6; --line:#252a36; --brand:#818cf8; --bar:#6d72f0; --grid:#252a36; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); line-height:1.55; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  a { color:var(--brand); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 1.8rem; margin: 0 0 4px; } h2 { font-size: 1.15rem; margin: 36px 0 12px; }
  .sub { color: var(--muted); margin: 0; }
  .banner { margin-top: 20px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .label { color: var(--muted); font-size: .85rem; } .value { font-size: 1.7rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .note { color: var(--muted); font-size: .8rem; }
  .held { font-size: 1rem; font-weight: 500; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); } th { color: var(--muted); font-weight: 500; font-size: .85rem; }
  td.num { text-align: right; } tr:last-child td { border-bottom: 0; }
  .chart { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; overflow-x: auto; }
  .chart svg { display: block; width: 100%; height: auto; min-width: 560px; }
  .chart text { fill: var(--muted); font-size: 11px; }
  .chart .bar { fill: var(--bar); } .chart .bar:hover { opacity: .8; } .chart .gridline { stroke: var(--grid); stroke-width: 1; }
  .chart .held-week { fill: none; stroke: var(--grid); stroke-dasharray: 3 3; }
  ul { padding-left: 20px; } li { margin: 4px 0; } code { font-size: .85em; word-break: break-all; }
  footer { color: var(--muted); font-size: .85rem; margin-top: 40px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .theme-toggle { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--text); cursor: pointer; font-size: 17px; line-height: 1; }
  .theme-toggle::before { content: "\\263E"; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .theme-toggle::before { content: "\\2600"; } }
  :root[data-theme="dark"] .theme-toggle::before { content: "\\2600"; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><p class="sub"><a href="https://cyphosguard.com">cyphos-guard</a></p><button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch light/dark mode" title="Light/dark mode"></button></div>
  <h1>Usage of the public instance</h1>
  <p class="sub">app.cyphosguard.com on ${esc(s.network)} · updated hourly · last update ${esc(updated)} UTC</p>
  ${
    early
      ? `<div class="banner"><strong>Early days.</strong> Fewer than ${k} people use the public instance so far. To protect them, numbers appear here once at least ${k} accounts stand behind each one. <a href="https://app.cyphosguard.com">Try it</a> (testnet, free).</div>`
      : ""
  }

  <h2>Key figures</h2>
  <div class="tiles">
    ${tile("Registered owners", fmt(s.owners))}
    ${tile("Active accounts, 7 days", fmt(s.activeAccounts.last7Days))}
    ${tile("Agents with an active grant", fmt(s.agentsActive))}
    ${tile("Agent payments", fmt(s.payments.total), "within limits, after approval, x402")}
    ${tile("Test USDC paid by agents", fmt(s.usdcPaid, 2))}
    ${tile("Approval requests approved", pct(s.approvals.approvalRate), s.approvals.medianMinutesToDecision === null ? "" : `median ${s.approvals.medianMinutesToDecision} min to decide`)}
  </div>

  <h2>From sign-up to first agent payment</h2>
  <table>
    <thead><tr><th>Step</th><th class="num" style="text-align:right">Owners</th></tr></thead>
    <tbody>${funnel.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="num">${fmt(v)}</td></tr>`).join("")}</tbody>
  </table>

  <h2>Agent payments per week</h2>
  ${weeklyChart(s)}

  <h2>Payments by kind</h2>
  <table>
    <thead><tr><th>Kind</th><th class="num" style="text-align:right">Payments</th></tr></thead>
    <tbody>
      <tr><td>Within the owner's limits (no approval needed)</td><td class="num">${fmt(s.payments.withinLimits)}</td></tr>
      <tr><td>After the owner's passkey approval</td><td class="num">${fmt(s.payments.afterApproval)}</td></tr>
      <tr><td>Paid HTTP APIs (x402)</td><td class="num">${fmt(s.payments.x402)}</td></tr>
    </tbody>
  </table>

  <h2>Check it on-chain</h2>
  <p>Every agent payment runs through public contracts. Anyone can see their transactions on Basescan:</p>
  <ul>${CONTRACTS.map(([n, a, w]) => `<li>${esc(n)} (${esc(w)}): <a href="https://sepolia.basescan.org/address/${a}"><code>${a}</code></a></li>`).join("")}
    <li>MetaMask DelegationManager (Delegation Framework v1.3.0), which redeems every agent payment</li>
  </ul>

  <h2>How these numbers are made</h2>
  <ul>
    <li>Only totals. No accounts, addresses, names, payment reasons or transaction hashes are published.</li>
    <li>Each number needs at least ${k} different accounts behind it, otherwise it shows as "fewer than ${k}". Weeks with fewer than ${k} active accounts show no values.</li>
    <li>Blocked payment attempts and individual approval decisions are never published.</li>
    <li>Testnet only: amounts are free test tokens, not real money.</li>
    <li>Raw data: <a href="stats.json">stats.json</a> (same numbers). Source code: <a href="https://github.com/Phosse136/cyphos-guard/blob/main/apps/policy-service/src/reports/public.ts">public.ts</a>.</li>
  </ul>

  <footer><a href="https://cyphosguard.com">cyphosguard.com</a> · <a href="https://cyphosguard.com/impressum.html">Impressum</a> · <a href="https://cyphosguard.com/datenschutz.html">Datenschutz</a> · <a href="https://github.com/Phosse136/cyphos-guard">GitHub</a></footer>
</div>
</body>
</html>
`;
}

/** Single-series bar chart as inline SVG; native <title> tooltips on each bar (no JavaScript). */
function weeklyChart(s: PublicStats): string {
  const weeks = s.weekly.slice(-26);
  if (weeks.length === 0) return `<p class="sub">No activity yet.</p>`;
  if (weeks.every((w) => w.payments === null)) {
    return `<p class="banner">Every week so far had fewer than ${s.threshold} active accounts, so no weekly numbers are shown yet.</p>`;
  }
  const W = 720;
  const H = 220;
  const pad = { l: 36, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...weeks.map((w) => w.payments ?? 0));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / weeks.length;
  const bw = Math.max(4, Math.min(28, slot - 4));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const grid: string[] = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(
      `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    );
  }
  const labelEvery = Math.ceil(weeks.length / 8);
  const bars = weeks.map((w, i) => {
    const x = pad.l + i * slot + (slot - bw) / 2;
    const label =
      i % labelEvery === 0
        ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(w.week.slice(5))}</text>`
        : "";
    if (w.payments === null) {
      return `<g><title>${esc(w.week)}: withheld (fewer than ${s.threshold} active accounts)</title><rect class="held-week" x="${x}" y="${pad.t}" width="${bw}" height="${ih}" rx="4"/></g>${label}`;
    }
    const h = Math.max(w.payments > 0 ? 2 : 0, pad.t + ih - y(w.payments));
    // Rounded top, square base: a path keeps the data end rounded and the baseline flat.
    const r = Math.min(4, bw / 2, h);
    const x2 = x + bw;
    const yb = pad.t + ih;
    const yt = yb - h;
    const d =
      h > 0 ? `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x2 - r}Q${x2},${yt} ${x2},${yt + r}V${yb}Z` : "";
    return `<g><title>${esc(w.week)}: ${w.payments} payments, ${w.usdcPaid ?? 0} test USDC, ${w.activeAccounts} active accounts</title>${d ? `<path class="bar" d="${d}"/>` : ""}<rect x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent"/></g>${label}`;
  });
  const rows = weeks
    .map(
      (w) =>
        `<tr><td>${esc(w.week)}</td><td class="num">${w.payments ?? "–"}</td><td class="num">${w.usdcPaid ?? "–"}</td><td class="num">${w.activeAccounts ?? `fewer than ${s.threshold}`}</td></tr>`,
    )
    .join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Agent payments per ISO week">${grid.join("")}${bars.join("")}</svg></div>
  <details style="margin-top:8px"><summary>Show as table</summary>
  <table style="margin-top:8px"><thead><tr><th>Week</th><th class="num" style="text-align:right">Payments</th><th class="num" style="text-align:right">Test USDC</th><th class="num" style="text-align:right">Active accounts</th></tr></thead><tbody>${rows}</tbody></table>
  </details>
  <p class="sub" style="font-size:.85rem">Dashed outline: week withheld (fewer than ${s.threshold} active accounts).</p>`;
}

function niceStep(max: number): number {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return Math.max(1, m * mag);
  return Math.max(1, 10 * mag);
}
