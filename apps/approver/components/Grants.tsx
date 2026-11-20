"use client";

import type { Delegation, MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { compilePolicy, revokeCall } from "@phoswallet/sdk";
import { type GrantJSON, parsePolicy } from "@phoswallet/shared";
import { useCallback, useEffect, useState } from "react";
import { isAddress, parseEther } from "viem";
import { api } from "@/lib/api";
import { ago, eth, short } from "@/lib/format";
import { chain, environment, publicClient, sendOwnerCalls, signDelegation } from "@/lib/wallet";
import { Button, Card, ErrorText, Field, inputClass } from "./ui";

const DAY = 86_400;

export function Grants({
  account,
  fork,
  refreshKey,
  onChanged,
}: {
  account: MetaMaskSmartAccount;
  fork: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [grants, setGrants] = useState<GrantJSON[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    agent: "",
    recipient: "",
    daily: "0.001",
    hardMax: "0.01",
    days: "7",
    forbidden: "",
  });

  const load = useCallback(
    () =>
      api
        .grants()
        .then(setGrants)
        .catch(() => {}),
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate reload trigger
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const grant = async () => {
    setBusy("grant");
    setError(null);
    try {
      const now = Number((await publicClient().getBlock()).timestamp);
      const policyInput = {
        version: 1,
        chainId: chain.id,
        agent: form.agent,
        validFrom: now - 60,
        expiresAt: now + Number(form.days) * DAY,
        permissions: [
          {
            kind: "nativeTransfer",
            recipients: [form.recipient],
            perPeriod: { amount: parseEther(form.daily).toString(), periodSeconds: DAY },
          },
        ],
        escalation: {
          enabled: true,
          approvalTtlSeconds: 900,
          hardMax: form.hardMax ? [{ token: "native", amount: parseEther(form.hardMax).toString() }] : [],
        },
        forbidden: { targets: form.forbidden.split(/[\s,]+/).filter(Boolean) },
      };
      const policy = parsePolicy(policyInput); // same validation as the server
      const compiled = compilePolicy({ policy, delegator: account.address, environment, now });
      const signed = [];
      for (const c of compiled) signed.push(await signDelegation(account, c.delegation)); // one passkey prompt each
      await api.createGrant(policyInput, signed);
      setForm((f) => ({ ...f, agent: "", recipient: "", forbidden: "" }));
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (g: GrantJSON) => {
    if (!confirm(`Revoke all permissions of agent ${g.agent}? This is enforced on-chain immediately.`)) return;
    setBusy(g.id);
    setError(null);
    try {
      const tx = await sendOwnerCalls(
        account,
        fork,
        g.delegations.map((d) => revokeCall(environment, d as Delegation)),
      );
      await api.markRevoked(g.id, tx);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const valid = isAddress(form.agent) && isAddress(form.recipient) && Number(form.daily) > 0 && Number(form.days) > 0;

  return (
    <Card title="Agents">
      <ul className="mb-6 space-y-2">
        {grants.length === 0 && <li className="text-sm text-zinc-500">No agents yet.</li>}
        {grants.map((g) => {
          const p = g.policy as { permissions: { perPeriod: { amount: string } }[]; expiresAt: number };
          return (
            <li
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="text-sm">
                <p className="font-mono">{short(g.agent)}</p>
                <p className="text-xs text-zinc-500">
                  {p.permissions[0] ? `${eth(p.permissions[0].perPeriod.amount)}/day` : ""} · granted {ago(g.createdAt)}{" "}
                  · {g.status === "active" ? `expires ${new Date(p.expiresAt * 1000).toLocaleDateString()}` : "revoked"}
                </p>
              </div>
              {g.status === "active" ? (
                <Button variant="danger" disabled={busy !== null} onClick={() => revoke(g)}>
                  {busy === g.id ? "Confirm with passkey…" : "Revoke"}
                </Button>
              ) : (
                <span className="text-xs font-medium text-zinc-500">revoked</span>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className="mb-3 text-sm font-semibold">Grant a new agent</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent address">
          <input
            className={inputClass}
            value={form.agent}
            onChange={(e) => setForm({ ...form, agent: e.target.value.trim() })}
            placeholder="0x…"
          />
        </Field>
        <Field label="Allowed recipient">
          <input
            className={inputClass}
            value={form.recipient}
            onChange={(e) => setForm({ ...form, recipient: e.target.value.trim() })}
            placeholder="0x…"
          />
        </Field>
        <Field label="Daily limit (ETH)" hint="Enforced on-chain">
          <input
            className={inputClass}
            value={form.daily}
            onChange={(e) => setForm({ ...form, daily: e.target.value })}
          />
        </Field>
        <Field label="Ask me up to (ETH)" hint="Above this: denied, never asked">
          <input
            className={inputClass}
            value={form.hardMax}
            onChange={(e) => setForm({ ...form, hardMax: e.target.value })}
          />
        </Field>
        <Field label="Valid for (days)" hint="Max 90">
          <input
            className={inputClass}
            value={form.days}
            onChange={(e) => setForm({ ...form, days: e.target.value })}
          />
        </Field>
        <Field label="Forbidden addresses" hint="Comma-separated; never paid, never asked">
          <input
            className={inputClass}
            value={form.forbidden}
            onChange={(e) => setForm({ ...form, forbidden: e.target.value })}
          />
        </Field>
      </div>
      <Button className="mt-4" disabled={!valid || busy !== null} onClick={grant}>
        {busy === "grant" ? "Confirm with passkey…" : "Grant (sign with passkey)"}
      </Button>
      <ErrorText error={error} />
    </Card>
  );
}
