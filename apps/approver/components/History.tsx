"use client";

import type { ApprovalRequestJSON } from "@cyphos-guard/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { describe, short, when } from "@/lib/format";
import { Addr, Badge, Card, Details, TxHash } from "./ui";

const TONE: Record<ApprovalRequestJSON["status"], "green" | "amber" | "red" | "zinc"> = {
  executed: "green",
  approved: "amber",
  pending: "amber",
  rejected: "red",
  expired: "zinc",
};

/** Every approval request the agents ever made, with its outcome. */
export function History({ fork, refreshKey }: { fork: boolean; refreshKey: number }) {
  const [requests, setRequests] = useState<ApprovalRequestJSON[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate reload trigger
  useEffect(() => {
    const load = () =>
      api
        .requests(undefined, 1000)
        .then(setRequests)
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [refreshKey]);

  return (
    <Card title={`Approval history (${requests.length})`}>
      {requests.length === 0 && <p className="text-sm text-zinc-500">No approval requests yet.</p>}
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {requests.map((r) => {
          const d = describe(r);
          const isOpen = open === r.id;
          return (
            <li key={r.id} className="py-2">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                onClick={() => setOpen(isOpen ? null : r.id)}
                aria-expanded={isOpen}
              >
                <span>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge> <span className="font-medium">{d.title}</span>
                  <span className="text-zinc-500"> · “{r.reason}”</span>
                  <span className="font-mono text-xs text-zinc-400"> · agent {short(r.agent)}</span>
                </span>
                <span className="text-xs text-zinc-500">
                  {when(r.createdAt)} <span className="ml-1 text-zinc-400">{isOpen ? "▴" : "▾"}</span>
                </span>
              </button>
              {isOpen && (
                <div className="mt-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                  <Details
                    rows={[
                      [
                        "Request",
                        <span key="id" className="font-mono text-xs">
                          {r.id}
                        </span>,
                      ],
                      [
                        "Status",
                        <Badge key="s" tone={TONE[r.status]}>
                          {r.status}
                        </Badge>,
                      ],
                      ["What", d.title],
                      ...d.lines.map((l): [string, React.ReactNode] => {
                        const space = l.indexOf(" ");
                        const addr = l.match(/0x[0-9a-fA-F]{40}$/)?.[0];
                        return [l.slice(0, space), addr ? <Addr key={l} value={addr} /> : l.slice(space + 1)];
                      }),
                      ["Agent", <Addr key="a" value={r.agent} />],
                      [
                        "Agent's reason",
                        <span key="re" className="italic">
                          “{r.reason}”
                        </span>,
                      ],
                      ["Requested", when(r.createdAt)],
                      ["Approval window until", when(r.expiresAt)],
                      ["Decided", r.decidedAt ? when(r.decidedAt) : "not yet"],
                      [
                        "Approval",
                        r.delegation
                          ? "one-shot permission signed with your passkey (this exact call, once, until the window ends)"
                          : "none",
                      ],
                      ["Transaction", r.txHash ? <TxHash key="tx" hash={r.txHash} fork={fork} /> : "none"],
                    ]}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
