/**
 * Usage analytics for the operator of a cyphos-guard instance, computed read-only from the policy-service SQLite
 * database. Every table is a plain list of rows, so the same data exports to CSV, TXT and XLSX.
 *
 * Privacy: by default every address is replaced by a keyed pseudonym (HMAC-SHA256 with a salt), and free text
 * that may contain personal data (agent reasons, grant names, error messages, tx hashes, which link back to
 * addresses on-chain) is left out. `raw: true` includes it, for the operator's own debugging only.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decodeErc20Transfer } from "@cyphos-guard/shared";
import { formatEther, formatUnits, type Hex, isAddressEqual } from "viem";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DAY = 86_400;

export type ColType = "string" | "int" | "number" | "date" | "day";
export type Column = { key: string; label: string; type: ColType; note?: string };
export type Row = Record<string, string | number | null>;
export type Table = { name: string; title: string; description: string; columns: Column[]; rows: Row[] };

export type ReportOptions = {
  /** Unix seconds; events before are ignored (owners registered before still appear in the owner table). */
  since?: number;
  /** Unix seconds, exclusive. */
  until?: number;
  /** Include addresses, tx hashes and free text. Off by default. */
  raw?: boolean;
  /** Pseudonym key: the same salt gives the same IDs across exports. Random if omitted. */
  salt?: string;
  /** "Now" for expiry of pending requests and for the report header (tests). */
  now?: number;
};

export type Report = { generatedAt: number; options: ReportOptions; saltWasRandom: boolean; tables: Table[] };

type ActivityRow = {
  id: number;
  account: string;
  agent: string | null;
  kind: string;
  detail: string;
  tx_hash: string | null;
  created_at: number;
};
type OwnerRow = { id: number; account_address: string | null; created_at: number };
type GrantRow = {
  id: string;
  account: string;
  agent: string;
  name: string | null;
  policy: string;
  status: string;
  created_at: number;
  revoked_at: number | null;
};
type RequestRow = {
  id: string;
  account: string;
  agent: string;
  target: string;
  value: string;
  data: string;
  reason: string;
  status: string;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
};

const PAYMENT_KINDS: Record<string, string> = {
  routine_executed: "within limits",
  request_executed: "after approval",
  x402_paid: "x402 API",
};

/** What a call moved: token, amount (decimal string) and recipient. */
export function decodeAmount(to: string, value: string, data: string) {
  const t = data && data !== "0x" ? decodeErc20Transfer(data as Hex) : null;
  if (t) {
    const usdc = isAddressEqual(to as Hex, USDC);
    return {
      token: usdc ? "USDC" : "ERC-20",
      amount: usdc ? Number(formatUnits(t.amount, 6)) : Number(t.amount),
      recipient: t.recipient as string,
    };
  }
  const v = BigInt(value || "0");
  return {
    token: data && data !== "0x" ? (v > 0n ? "ETH+call" : "call") : "ETH",
    amount: Number(formatEther(v)),
    recipient: to,
  };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const round = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Category of an owner's own passkey transaction, from the service's summary line. */
export function ownerTxCategory(summary: string): string {
  if (summary.startsWith("created the account")) return "account created";
  if (summary.startsWith("changed the recovery")) return "recovery changed";
  if (summary.startsWith("deployed an x402 vault")) return "vault deployed";
  if (summary.startsWith("withdrew") && summary.includes("vault")) return "vault withdrawal";
  if (summary.startsWith("withdrew the EntryPoint")) return "gas deposit withdrawn";
  if (summary.startsWith("sent")) return "sent out";
  if (summary.startsWith("revoked")) return "revoked";
  return "other call";
}

export function buildReport(db: DatabaseSync, options: ReportOptions = {}): Report {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const saltWasRandom = !options.salt;
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const raw = !!options.raw;
  const pseudo = (prefix: string, v: string | null | undefined) => {
    if (!v) return null;
    if (raw) return v;
    return `${prefix}_${createHmac("sha256", salt).update(v.toLowerCase()).digest("hex").slice(0, 10)}`;
  };
  const acct = (v: string | null | undefined) => pseudo("acct", v);
  const agentId = (v: string | null | undefined) => pseudo("agent", v);
  const addr = (v: string | null | undefined) => pseudo("addr", v);
  const since = options.since ?? 0;
  const until = options.until ?? Number.MAX_SAFE_INTEGER;
  const inRange = (t: number) => t >= since && t < until;

  const allActivity = db.prepare("SELECT * FROM activity ORDER BY created_at, id").all() as ActivityRow[];
  const activity = allActivity.filter((a) => inRange(a.created_at));
  const owners = db
    .prepare("SELECT id, account_address, created_at FROM owners ORDER BY created_at")
    .all() as OwnerRow[];
  const grants = db.prepare("SELECT * FROM grants ORDER BY created_at").all() as GrantRow[];
  const requests = (db.prepare("SELECT * FROM requests ORDER BY created_at").all() as RequestRow[]).filter((r) =>
    inRange(r.created_at),
  );
  const detail = (a: ActivityRow) => {
    try {
      return JSON.parse(a.detail) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const effStatus = (r: RequestRow) => (r.status === "pending" && r.expires_at < now ? "expired" : r.status);

  // ---------- payments ----------
  // An x402 payment shows up twice: first the account tops up the payer (the agent's vault, or in legacy mode the
  // agent's own address) via a routine or approved redemption, then the payer pays the seller (x402_paid). The
  // top-up is an internal transfer, so it isn't counted as a payment; the x402_paid row is.
  const payers = new Set<string>();
  for (const a of allActivity) {
    if (a.kind !== "x402_paid") continue;
    const payer = detail(a).payer;
    if (typeof payer === "string") payers.add(`${a.account.toLowerCase()}:${payer.toLowerCase()}`);
  }
  const isTopUp = (account: string, recipient: string) =>
    payers.has(`${account.toLowerCase()}:${recipient.toLowerCase()}`);
  const payments: Row[] = [];
  for (const a of activity) {
    const type = PAYMENT_KINDS[a.kind];
    if (!type) continue;
    const d = detail(a);
    const m = decodeAmount(String(d.to ?? ""), String(d.value ?? "0"), String(d.data ?? "0x"));
    if (a.kind !== "x402_paid" && isTopUp(a.account, m.recipient)) continue;
    payments.push({
      time: a.created_at,
      account: acct(a.account),
      agent: agentId(a.agent),
      type,
      token: m.token,
      amount: m.amount,
      recipient: addr(m.recipient),
      ...(raw ? { tx_hash: a.tx_hash, reason: typeof d.reason === "string" ? d.reason : null } : {}),
    });
  }

  // ---------- blocked ----------
  const blocked: Row[] = activity
    .filter((a) => a.kind === "request_denied")
    .map((a) => {
      const d = detail(a);
      const m = decodeAmount(String(d.to ?? ""), String(d.value ?? "0"), String(d.data ?? "0x"));
      return {
        time: a.created_at,
        account: acct(a.account),
        agent: agentId(a.agent),
        code: typeof d.code === "string" ? d.code : null,
        token: m.token,
        amount: m.amount,
        recipient: addr(m.recipient),
        ...(raw ? { message: (d.message as string) ?? null, reason: (d.reason as string) ?? null } : {}),
      };
    });

  // ---------- approvals ----------
  const approvals: Row[] = requests.map((r) => {
    const m = decodeAmount(r.target, r.value, r.data);
    const status = effStatus(r);
    return {
      request: r.id.slice(0, 8),
      account: acct(r.account),
      agent: agentId(r.agent),
      created: r.created_at,
      status,
      decided: r.decided_at,
      minutes_to_decision: r.decided_at ? round((r.decided_at - r.created_at) / 60) : null,
      token: m.token,
      amount: m.amount,
      recipient: addr(m.recipient),
      ...(raw ? { reason: r.reason } : {}),
    };
  });

  // ---------- owner transactions ----------
  const ownerTx: Row[] = [];
  for (const a of activity.filter((x) => x.kind === "owner_tx")) {
    const d = detail(a);
    const lines = Array.isArray(d.summary) ? (d.summary as string[]) : [];
    for (const line of lines.length ? lines : ["other call"]) {
      ownerTx.push({
        time: a.created_at,
        account: acct(a.account),
        action: ownerTxCategory(line),
        ...(raw ? { summary: line, tx_hash: a.tx_hash } : {}),
      });
    }
  }

  // ---------- agents (grants) ----------
  const grantAgents: Row[] = grants.map((g) => {
    let kinds = "";
    let cosigner = "no";
    try {
      const p = JSON.parse(g.policy) as { permissions?: { kind: string }[]; cosigner?: string };
      kinds = [...new Set((p.permissions ?? []).map((x) => x.kind))].join(", ");
      cosigner = p.cosigner ? "yes" : "no";
    } catch {
      // keep defaults
    }
    const mine = payments.filter(
      (p) =>
        p.account === acct(g.account) &&
        p.agent === agentId(g.agent) &&
        (p.time as number) >= g.created_at &&
        (!g.revoked_at || (p.time as number) <= g.revoked_at),
    );
    const sum = (token: string) =>
      round(
        mine.filter((p) => p.token === token).reduce((s, p) => s + (p.amount as number), 0),
        6,
      );
    return {
      grant: g.id.slice(0, 8),
      account: acct(g.account),
      agent: agentId(g.agent),
      status: g.status,
      created: g.created_at,
      revoked: g.revoked_at,
      days_active: round(((g.revoked_at ?? now) - g.created_at) / DAY, 1),
      permissions: kinds,
      cosigner,
      payments: mine.length,
      usdc_paid: sum("USDC"),
      eth_paid: sum("ETH"),
      ...(raw ? { name: g.name } : {}),
    };
  });

  // ---------- owners (one row per registered owner: cohort-ready) ----------
  const byAccount = new Map<string, ActivityRow[]>();
  for (const a of activity) {
    const k = a.account.toLowerCase();
    byAccount.set(k, [...(byAccount.get(k) ?? []), a]);
  }
  const ownerRows: Row[] = owners.map((o) => {
    const acts = o.account_address ? (byAccount.get(o.account_address.toLowerCase()) ?? []) : [];
    const days = new Set(acts.map((a) => dayOf(a.created_at)));
    const count = (k: string | string[]) => acts.filter((a) => (Array.isArray(k) ? k : [k]).includes(a.kind)).length;
    return {
      owner: pseudo("owner", `owner:${o.id}`),
      registered: o.created_at,
      cohort_week: isoWeek(o.created_at),
      has_account: o.account_address ? "yes" : "no",
      account: acct(o.account_address),
      first_activity: acts[0]?.created_at ?? null,
      last_activity: acts.at(-1)?.created_at ?? null,
      active_days: days.size,
      agents_granted: count("grant_created"),
      payments: o.account_address ? payments.filter((p) => p.account === acct(o.account_address)).length : 0,
      approvals_requested: count("request_created"),
      blocked: count("request_denied"),
      own_transactions: count("owner_tx"),
    };
  });

  // ---------- daily ----------
  const days = new Map<string, Row>();
  const day = (t: number) => {
    const k = dayOf(t);
    let r = days.get(k);
    if (!r) {
      r = {
        date: k,
        new_owners: 0,
        active_accounts: 0,
        agents_granted: 0,
        agents_revoked: 0,
        payments: 0,
        within_limits: 0,
        after_approval: 0,
        x402: 0,
        approvals_requested: 0,
        approved: 0,
        rejected: 0,
        blocked: 0,
        own_transactions: 0,
        usdc_paid: 0,
        eth_paid: 0,
      };
      days.set(k, r);
    }
    return r;
  };
  const inc = (r: Row, k: string, by = 1) => {
    r[k] = ((r[k] as number) ?? 0) + by;
  };
  for (const o of owners) if (inRange(o.created_at)) inc(day(o.created_at), "new_owners");
  const activeSets = new Map<string, Set<string>>();
  for (const a of activity) {
    const r = day(a.created_at);
    const k = r.date as string;
    activeSets.set(k, (activeSets.get(k) ?? new Set()).add(a.account.toLowerCase()));
    const map: Record<string, string> = {
      grant_created: "agents_granted",
      grant_revoked: "agents_revoked",
      routine_executed: "within_limits",
      request_executed: "after_approval",
      x402_paid: "x402",
      request_created: "approvals_requested",
      request_approved: "approved",
      request_rejected: "rejected",
      request_denied: "blocked",
      owner_tx: "own_transactions",
    };
    const col = map[a.kind];
    if (col && !PAYMENT_KINDS[a.kind]) inc(r, col);
  }
  const typeCol: Record<string, string> = {
    "within limits": "within_limits",
    "after approval": "after_approval",
    "x402 API": "x402",
  };
  for (const p of payments) {
    const r = day(p.time as number);
    inc(r, "payments");
    inc(r, typeCol[p.type as string] as string);
    if (p.token === "USDC") inc(r, "usdc_paid", p.amount as number);
    if (p.token === "ETH") inc(r, "eth_paid", p.amount as number);
  }
  for (const [k, set] of activeSets) {
    const r = days.get(k);
    if (r) r.active_accounts = set.size;
  }
  const daily = fillDays(
    [...days.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    day,
  );
  for (const r of daily) {
    r.usdc_paid = round(r.usdc_paid as number, 6);
    r.eth_paid = round(r.eth_paid as number, 8);
  }

  // ---------- KPIs ----------
  const decided = approvals.filter((r) => r.minutes_to_decision !== null);
  const approvedN = approvals.filter((r) => r.status === "approved" || r.status === "executed").length;
  const rejectedN = approvals.filter((r) => r.status === "rejected").length;
  const expiredN = approvals.filter((r) => r.status === "expired").length;
  const activeAccounts = (from: number) =>
    new Set(activity.filter((a) => a.created_at >= from).map((a) => a.account.toLowerCase())).size;
  const totalPaid = (token: string) =>
    round(
      payments.filter((p) => p.token === token).reduce((s, p) => s + (p.amount as number), 0),
      6,
    );
  const kpi = (metric: string, value: number | string | null, note = ""): Row => ({ metric, value, note });
  const kpis: Row[] = [
    kpi("Registered owners", owners.length, "all time"),
    kpi("New owners in period", owners.filter((o) => inRange(o.created_at)).length),
    kpi("Owners with a smart account", owners.filter((o) => o.account_address).length, "all time; activation step 1"),
    kpi(
      "Owners who granted an agent",
      ownerRows.filter((o) => (o.agents_granted as number) > 0).length,
      "in period; activation step 2",
    ),
    kpi(
      "Owners with a payment",
      ownerRows.filter((o) => (o.payments as number) > 0).length,
      "in period; activation step 3",
    ),
    kpi("Active accounts, last 1 day", activeAccounts(now - DAY), "any activity"),
    kpi("Active accounts, last 7 days", activeAccounts(now - 7 * DAY)),
    kpi("Active accounts, last 30 days", activeAccounts(now - 30 * DAY)),
    kpi("Agents granted (active now)", grants.filter((g) => g.status === "active").length, "all time"),
    kpi("Agents revoked", grants.filter((g) => g.status === "revoked").length, "all time"),
    kpi("Payments", payments.length, "within limits + after approval + x402 (vault top-ups not counted twice)"),
    kpi("  within limits", payments.filter((p) => p.type === "within limits").length),
    kpi("  after approval", payments.filter((p) => p.type === "after approval").length),
    kpi("  x402 API", payments.filter((p) => p.type === "x402 API").length),
    kpi("USDC paid", totalPaid("USDC"), "testnet"),
    kpi("ETH paid", totalPaid("ETH"), "testnet"),
    kpi("Approval requests", approvals.length),
    kpi("  approved (incl. executed)", approvedN),
    kpi("  rejected", rejectedN),
    kpi("  expired", expiredN),
    kpi("Approval rate", approvals.length ? round(approvedN / approvals.length, 3) : null, "approved / requested"),
    kpi(
      "Median minutes to decision",
      round(median(decided.map((r) => r.minutes_to_decision as number))),
      "approved or rejected requests",
    ),
    kpi("Blocked attempts", blocked.length, "forbidden, over hard max, escalation disabled"),
    kpi("Owners' own passkey transactions", activity.filter((a) => a.kind === "owner_tx").length),
  ];

  const dt = (key: string, label: string): Column => ({ key, label, type: "date" });
  const s = (key: string, label: string): Column => ({ key, label, type: "string" });
  const n = (key: string, label: string): Column => ({ key, label, type: "number" });
  const i = (key: string, label: string): Column => ({ key, label, type: "int" });
  const rawCols = (cols: Column[]) => (raw ? cols : []);

  const tables: Table[] = [
    {
      name: "kpis",
      title: "Key figures",
      description: "Headline numbers for the period, including the activation funnel (account → agent → payment).",
      columns: [s("metric", "Metric"), { key: "value", label: "Value", type: "number" }, s("note", "Note")],
      rows: kpis,
    },
    {
      name: "daily",
      title: "Daily activity",
      description: "One row per UTC day (gaps filled with zeros): sign-ups, active accounts and every event type.",
      columns: [
        { key: "date", label: "Date (UTC)", type: "day" },
        i("new_owners", "New owners"),
        i("active_accounts", "Active accounts"),
        i("agents_granted", "Agents granted"),
        i("agents_revoked", "Agents revoked"),
        i("payments", "Payments"),
        i("within_limits", "Within limits"),
        i("after_approval", "After approval"),
        i("x402", "x402 payments"),
        i("approvals_requested", "Approvals requested"),
        i("approved", "Approved"),
        i("rejected", "Rejected"),
        i("blocked", "Blocked"),
        i("own_transactions", "Own passkey txs"),
        n("usdc_paid", "USDC paid"),
        n("eth_paid", "ETH paid"),
      ],
      rows: daily,
    },
    {
      name: "owners",
      title: "Owners",
      description:
        "One row per registered owner, pseudonymized; cohort week and activity counts for retention analysis.",
      columns: [
        s("owner", "Owner"),
        dt("registered", "Registered (UTC)"),
        s("cohort_week", "Cohort week"),
        s("has_account", "Has account"),
        s("account", "Account"),
        dt("first_activity", "First activity"),
        dt("last_activity", "Last activity"),
        i("active_days", "Active days"),
        i("agents_granted", "Agents granted"),
        i("payments", "Payments"),
        i("approvals_requested", "Approvals requested"),
        i("blocked", "Blocked"),
        i("own_transactions", "Own passkey txs"),
      ],
      rows: ownerRows,
    },
    {
      name: "agents",
      title: "Agents (grants)",
      description: "One row per agent permission: lifetime, permission types, co-signer, payments and volume.",
      columns: [
        s("grant", "Grant"),
        s("account", "Account"),
        s("agent", "Agent"),
        s("status", "Status"),
        dt("created", "Created (UTC)"),
        dt("revoked", "Revoked (UTC)"),
        n("days_active", "Days active"),
        s("permissions", "Permission types"),
        s("cosigner", "Co-signer"),
        i("payments", "Payments"),
        n("usdc_paid", "USDC paid"),
        n("eth_paid", "ETH paid"),
        ...rawCols([s("name", "Name")]),
      ],
      rows: grantAgents,
    },
    {
      name: "payments",
      title: "Payments",
      description: "Every payment an agent made: within limits, after the owner's approval, or to an x402 API.",
      columns: [
        dt("time", "Time (UTC)"),
        s("account", "Account"),
        s("agent", "Agent"),
        s("type", "Type"),
        s("token", "Token"),
        n("amount", "Amount"),
        s("recipient", "Recipient"),
        ...rawCols([s("tx_hash", "Tx hash"), s("reason", "Agent's reason")]),
      ],
      rows: payments,
    },
    {
      name: "approvals",
      title: "Approval requests",
      description: "Every escalation: status (pending, approved, executed, rejected, expired) and time to decision.",
      columns: [
        s("request", "Request"),
        s("account", "Account"),
        s("agent", "Agent"),
        dt("created", "Created (UTC)"),
        s("status", "Status"),
        dt("decided", "Decided (UTC)"),
        n("minutes_to_decision", "Minutes to decision"),
        s("token", "Token"),
        n("amount", "Amount"),
        s("recipient", "Recipient"),
        ...rawCols([s("reason", "Agent's reason")]),
      ],
      rows: approvals,
    },
    {
      name: "blocked",
      title: "Blocked attempts",
      description: "Payments the service refused outright (never offered for approval), with the refusal code.",
      columns: [
        dt("time", "Time (UTC)"),
        s("account", "Account"),
        s("agent", "Agent"),
        s("code", "Code"),
        s("token", "Token"),
        n("amount", "Amount"),
        s("recipient", "Recipient"),
        ...rawCols([s("message", "Message"), s("reason", "Agent's reason")]),
      ],
      rows: blocked,
    },
    {
      name: "owner_tx",
      title: "Owners' own transactions",
      description: "What owners did with their passkey: account creation, sending out, recovery changes, vaults.",
      columns: [
        dt("time", "Time (UTC)"),
        s("account", "Account"),
        s("action", "Action"),
        ...rawCols([s("summary", "Summary"), s("tx_hash", "Tx hash")]),
      ],
      rows: ownerTx,
    },
  ];
  return { generatedAt: now, options: { ...options, salt: undefined }, saltWasRandom, tables };
}

/** ISO week label, e.g. 2026-W47. */
export function isoWeek(t: number): string {
  const d = new Date(t * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function fillDays(rows: Row[], make: (t: number) => Row): Row[] {
  if (rows.length < 2) return rows;
  const first = Date.parse(`${rows[0]?.date}T00:00:00Z`) / 1000;
  const last = Date.parse(`${rows.at(-1)?.date}T00:00:00Z`) / 1000;
  const out: Row[] = [];
  for (let t = first; t <= last; t += DAY) out.push(make(t));
  return out;
}
