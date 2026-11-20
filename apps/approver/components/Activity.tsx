"use client";

import type { ActivityJSON, ApprovalRequestJSON } from "@cyphos-guard/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, type Hex } from "viem";
import { api } from "@/lib/api";
import { ago, describe, short, when } from "@/lib/format";
import { publicClient } from "@/lib/wallet";
import { Addr, Badge, Button, Card, Details, TxHash } from "./ui";

const LABEL: Record<ActivityJSON["kind"], string> = {
  grant_created: "Agent granted",
  grant_revoked: "Agent revoked",
  routine_executed: "Paid within limits",
  request_created: "Asked for approval",
  request_approved: "You approved",
  request_rejected: "You rejected",
  request_executed: "Approved payment sent",
  request_denied: "Blocked by policy",
};

const GROUPS = {
  all: "All events",
  payments: "Payments",
  approvals: "Approvals",
  blocked: "Blocked",
  grants: "Grants",
} as const;
type Group = keyof typeof GROUPS;
const inGroup = (kind: ActivityJSON["kind"], g: Group) =>
  g === "all" ||
  (g === "payments" && (kind === "routine_executed" || kind === "request_executed")) ||
  (g === "approvals" && kind.startsWith("request_") && kind !== "request_denied") ||
  (g === "blocked" && kind === "request_denied") ||
  (g === "grants" && kind.startsWith("grant_"));

const PAGE = 100;
type Detail = {
  value?: string;
  to?: `0x${string}`;
  data?: Hex;
  code?: string;
  message?: string;
  reason?: string;
  requestId?: string;
  grantId?: string;
};

export function Activity({ fork, refreshKey }: { fork: boolean; refreshKey: number }) {
  const [items, setItems] = useState<ActivityJSON[]>([]);
  const [older, setOlder] = useState<ActivityJSON[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [requests, setRequests] = useState<Map<string, ApprovalRequestJSON>>(new Map());
  const [agent, setAgent] = useState("all");
  const [group, setGroup] = useState<Group>("all");
  const [open, setOpen] = useState<number | null>(null);

  // Newest page, refreshed every 5 s (and on refreshKey); older pages are kept once loaded.
  const load = useCallback(async () => {
    const [latest, reqs] = await Promise.all([api.activity(PAGE), api.requests(undefined, 1000)]);
    setItems(latest);
    setRequests(new Map(reqs.map((r) => [r.id, r])));
    setHasMore((h) => h || latest.length === PAGE);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate reload trigger
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const all = useMemo(() => {
    const seen = new Set(items.map((a) => a.id));
    return [...items, ...older.filter((a) => !seen.has(a.id))];
  }, [items, older]);
  const loadOlder = async () => {
    const last = all.at(-1);
    if (!last) return;
    const page = await api.activity(PAGE, last.id);
    setOlder((o) => [...o, ...page]);
    setHasMore(page.length === PAGE);
  };

  const agents = [...new Set(all.map((a) => a.agent).filter(Boolean))] as string[];
  const shown = all.filter((a) => (agent === "all" || a.agent === agent) && inGroup(a.kind, group));
  const select = "rounded-lg border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";

  return (
    <Card
      title={`Activity (${all.length}${hasMore ? "+" : ""})`}
      action={
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Filter by agent"
            className={select}
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {short(a)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by type"
            className={select}
            value={group}
            onChange={(e) => setGroup(e.target.value as Group)}
          >
            {Object.entries(GROUPS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {shown.length === 0 && <p className="text-sm text-zinc-500">No activity yet.</p>}
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {shown.map((a) => {
          const d = a.detail as Detail;
          const desc =
            d.to && d.value !== undefined ? describe({ to: d.to, value: d.value, data: d.data ?? "0x" }) : null;
          const recipient = desc?.lines.find((l) => l.startsWith("to "))?.slice(3) ?? d.to;
          const isOpen = open === a.id;
          return (
            <li key={a.id} className="py-2">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                onClick={() => setOpen(isOpen ? null : a.id)}
                aria-expanded={isOpen}
              >
                <span>
                  <span className={a.kind === "request_denied" ? "font-medium text-red-600" : "font-medium"}>
                    {LABEL[a.kind]}
                  </span>
                  {desc && <span className="text-zinc-500"> · {desc.title.replace(/^(Send|Pay) /, "")}</span>}
                  {recipient && <span className="font-mono text-xs text-zinc-500"> → {short(recipient)}</span>}
                  {d.code && <span className="text-xs text-zinc-500"> ({d.code})</span>}
                  {a.agent && <span className="font-mono text-xs text-zinc-400"> · agent {short(a.agent)}</span>}
                </span>
                <span className="text-xs text-zinc-500">
                  {a.txHash && <span className="mr-2 font-mono">{short(a.txHash)}</span>}
                  <span title={when(a.createdAt)}>{ago(a.createdAt)}</span>
                  <span className="ml-2 text-zinc-400">{isOpen ? "▴" : "▾"}</span>
                </span>
              </button>
              {isOpen && (
                <EventDetails
                  a={a}
                  d={d}
                  desc={desc}
                  request={d.requestId ? requests.get(d.requestId) : undefined}
                  fork={fork}
                />
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <Button variant="ghost" className="mt-3" onClick={loadOlder}>
          Show older activity
        </Button>
      )}
    </Card>
  );
}

function EventDetails({
  a,
  d,
  desc,
  request,
  fork,
}: {
  a: ActivityJSON;
  d: Detail;
  desc: { title: string; lines: string[] } | null;
  request?: ApprovalRequestJSON;
  fork: boolean;
}) {
  const reason = request?.reason ?? d.reason;
  const rows: [string, React.ReactNode][] = [
    ["Event", `${LABEL[a.kind]} (${a.kind})`],
    ["Time", when(a.createdAt)],
  ];
  if (a.agent) rows.push(["Agent", <Addr key="ag" value={a.agent} />]);
  if (desc) {
    rows.push(["What", desc.title]);
    for (const line of desc.lines) {
      const space = line.indexOf(" ");
      const label = line.slice(0, space);
      const value = line.slice(space + 1);
      const addr = value.match(/0x[0-9a-fA-F]{40}$/)?.[0];
      rows.push([
        label,
        addr ? (
          <span key={line}>
            {value.slice(0, value.length - addr.length)}
            <Addr value={addr} />
          </span>
        ) : (
          value
        ),
      ]);
    }
  }
  if (reason)
    rows.push([
      "Agent's reason",
      <span key="r" className="italic">
        “{reason}”
      </span>,
    ]);
  if (d.code) rows.push(["Blocked because", `${d.code}${d.message ? `: ${d.message}` : ""}`]);
  if (request) {
    const tone =
      request.status === "executed"
        ? "green"
        : request.status === "pending" || request.status === "approved"
          ? "amber"
          : "red";
    rows.push([
      "Request",
      <span key="rq" className="font-mono text-xs">
        {request.id}
      </span>,
    ]);
    rows.push([
      "Request status",
      <Badge key="rs" tone={tone}>
        {request.status}
      </Badge>,
    ]);
    rows.push(["Requested", when(request.createdAt)]);
    rows.push(["Approval window until", when(request.expiresAt)]);
    if (request.decidedAt) rows.push(["Decided", when(request.decidedAt)]);
  }
  if (d.grantId)
    rows.push([
      "Grant id",
      <span key="gi" className="font-mono text-xs">
        {d.grantId}
      </span>,
    ]);
  if (a.txHash) rows.push(["Transaction", <TxHash key="tx" hash={a.txHash} fork={fork} />]);

  return (
    <div className="mt-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
      <Details rows={rows} />
      {a.txHash && <OnChain hash={a.txHash as Hex} />}
    </div>
  );
}

/** Loads the receipt from the chain itself (not from the policy service). */
function OnChain({ hash }: { hash: Hex }) {
  const [info, setInfo] = useState<[string, React.ReactNode][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadIt = async () => {
    try {
      const r = await publicClient().getTransactionReceipt({ hash });
      setInfo([
        [
          "Status",
          r.status === "success" ? (
            <Badge key="s" tone="green">
              success
            </Badge>
          ) : (
            <Badge key="s" tone="red">
              reverted
            </Badge>
          ),
        ],
        ["Block", r.blockNumber.toString()],
        ["From", <Addr key="f" value={r.from} />],
        ["To", r.to ? <Addr key="t" value={r.to} /> : "contract creation"],
        ["Gas used", r.gasUsed.toString()],
        ["Fee", `${formatEther(r.gasUsed * r.effectiveGasPrice)} ETH`],
      ]);
    } catch (e) {
      setError((e as Error).message.split("\n")[0] ?? "could not load");
    }
  };
  return (
    <div className="mt-3">
      {!info && (
        <Button variant="ghost" onClick={loadIt}>
          Load on-chain details
        </Button>
      )}
      {info && (
        <div className="border-t border-zinc-200 pt-2 dark:border-zinc-700">
          <p className="mb-1 text-xs font-medium text-zinc-500">On-chain (read from the chain)</p>
          <Details rows={info} />
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
