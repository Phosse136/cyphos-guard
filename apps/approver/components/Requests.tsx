"use client";

import type { ApprovalRequestJSON } from "@cyphos-guard/shared";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ago, describe, short } from "@/lib/format";
import { ownerClient } from "@/lib/wallet";
import { Button, Card, ErrorText } from "./ui";

export function Requests({
  account,
  fork,
  onDecided,
}: {
  account: MetaMaskSmartAccount;
  fork: boolean;
  onDecided: () => void;
}) {
  const [pending, setPending] = useState<ApprovalRequestJSON[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(async () => {
    const list = await api.requests("pending").catch(() => null);
    if (!list) return;
    setPending(list);
    // In-app notification: title badge + optional browser notification for new requests.
    document.title = list.length ? `(${list.length}) cyphos-guard approver` : "cyphos-guard approver";
    for (const r of list) {
      // typeof guard: `Notification` doesn't exist at all in some browsers (e.g. iPhone Safari outside a home-screen
      // web app), where `Notification?.permission` would throw a ReferenceError.
      if (
        !seen.current.has(r.id) &&
        seen.current.size > 0 &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        new Notification("Agent needs approval", { body: describe(r).title });
      }
      seen.current.add(r.id);
    }
    if (seen.current.size === 0) seen.current.add("init");
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const decide = async (req: ApprovalRequestJSON, approve: boolean) => {
    setBusy(req.id);
    setError(null);
    try {
      if (approve) {
        // SDK builds the one-shot approval from the SAME request object shown above, and signs with the passkey.
        await ownerClient(account, fork).approve(req);
      } else {
        await api.reject(req.id);
      }
      await load();
      onDecided();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={`Pending approvals${pending.length ? ` (${pending.length})` : ""}`}
      action={
        typeof Notification !== "undefined" && Notification.permission === "default" ? (
          <Button variant="ghost" onClick={() => Notification.requestPermission()}>
            Enable notifications
          </Button>
        ) : null
      }
    >
      {pending.length === 0 && (
        <p className="text-sm text-zinc-500">Nothing waiting. Your agents are within their limits.</p>
      )}
      <ul className="space-y-3">
        {pending.map((r) => {
          const d = describe(r);
          return (
            <li
              key={r.id}
              className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{d.title}</p>
                  {d.lines.map((l) => (
                    <p key={l} className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {l}
                    </p>
                  ))}
                  <p className="mt-2 text-sm">
                    <span className="text-zinc-500">Agent {short(r.agent)} says: </span>
                    <span className="italic">“{r.reason}”</span>
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    requested {ago(r.createdAt)} · expires in{" "}
                    {Math.max(0, Math.round((r.expiresAt - Date.now() / 1000) / 60))} min
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button disabled={busy !== null} onClick={() => decide(r, true)}>
                    {busy === r.id ? "Confirm with passkey…" : "Approve"}
                  </Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => decide(r, false)}>
                    Reject
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorText error={error} />
    </Card>
  );
}
