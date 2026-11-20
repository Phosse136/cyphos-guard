"use client";

import type { ActivityJSON } from "@phoswallet/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ago, eth, explorer, short } from "@/lib/format";
import { Card } from "./ui";

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

export function Activity({ fork, refreshKey }: { fork: boolean; refreshKey: number }) {
  const [items, setItems] = useState<ActivityJSON[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate reload trigger
  useEffect(() => {
    const load = () =>
      api
        .activity()
        .then(setItems)
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [refreshKey]);

  return (
    <Card title="Activity">
      {items.length === 0 && <p className="text-sm text-zinc-500">No activity yet.</p>}
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {items.map((a) => {
          const d = a.detail as { value?: string; to?: string; code?: string };
          const link = a.txHash ? explorer(fork, a.txHash) : null;
          return (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className={a.kind === "request_denied" ? "font-medium text-red-600" : "font-medium"}>
                  {LABEL[a.kind]}
                </span>
                {d.value && <span className="text-zinc-500"> · {eth(d.value)}</span>}
                {d.to && <span className="font-mono text-xs text-zinc-500"> → {short(d.to)}</span>}
                {d.code && <span className="text-xs text-zinc-500"> ({d.code})</span>}
                {a.agent && <span className="font-mono text-xs text-zinc-400"> · agent {short(a.agent)}</span>}
              </span>
              <span className="text-xs text-zinc-500">
                {a.txHash &&
                  (link ? (
                    <a className="mr-2 underline" href={link} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  ) : (
                    <span className="mr-2 font-mono">{short(a.txHash)}</span>
                  ))}
                {ago(a.createdAt)}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
