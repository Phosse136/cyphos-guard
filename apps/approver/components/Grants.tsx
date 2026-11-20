"use client";

import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import type { GrantJSON, PolicyInput } from "@phoswallet/shared";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, isAddress, parseEther, parseUnits } from "viem";
import { api } from "@/lib/api";
import { ago, eth, short } from "@/lib/format";
import { ownerClient, publicClient } from "@/lib/wallet";
import { Button, Card, ErrorText, Field, inputClass } from "./ui";

const DAY = 86_400;
/** Circle test USDC on Base Sepolia. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const EMPTY = {
  agent: "",
  ethRecipient: "",
  ethDaily: "0.001",
  usdcRecipient: "",
  usdcPerTx: "",
  usdcDaily: "",
  hardMaxEth: "0.01",
  hardMaxUsdc: "",
  days: "7",
  forbidden: "",
};
type Form = typeof EMPTY;

type PermissionJSON = { kind: string; token?: string; recipients?: string[]; perPeriod?: { amount: string } };

function describeGrant(policy: unknown): string {
  const p = policy as { permissions: PermissionJSON[] };
  return p.permissions
    .map((perm) => {
      const to = perm.recipients?.[0] ? ` → ${short(perm.recipients[0])}` : "";
      if (perm.kind === "nativeTransfer" && perm.perPeriod) return `${eth(perm.perPeriod.amount)}/day${to}`;
      if (perm.kind === "erc20Transfer" && perm.perPeriod) {
        const unit = perm.token?.toLowerCase() === USDC.toLowerCase() ? "USDC" : `token ${short(perm.token ?? "")}`;
        return `${formatUnits(BigInt(perm.perPeriod.amount), 6)} ${unit}/day${to}`;
      }
      return perm.kind;
    })
    .join(" · ");
}

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
  const [form, setForm] = useState<Form>(EMPTY);
  const [prefilled, setPrefilled] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value.trim() }));

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

  // Dev convenience for the demo: `?grant=<base64url JSON>` prefills the form. Local fork ONLY: on a real
  // network a crafted link could prefill an attacker's agent address. The owner still reviews and signs.
  useEffect(() => {
    if (!fork) return;
    const raw = new URLSearchParams(window.location.search).get("grant");
    if (!raw) return;
    try {
      const data = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<Form>;
      const clean = Object.fromEntries(
        Object.entries(data).filter(([k, v]) => k in EMPTY && typeof v === "string"),
      ) as Partial<Form>;
      setForm((f) => ({ ...f, ...clean }));
      setPrefilled(true);
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      setError("could not read the prefill link");
    }
  }, [fork]);

  const permissions = (): PolicyInput["permissions"] => {
    const out: PolicyInput["permissions"] = [];
    if (form.usdcRecipient) {
      out.push({
        kind: "erc20Transfer",
        token: USDC,
        recipients: [form.usdcRecipient],
        ...(form.usdcPerTx ? { perTx: parseUnits(form.usdcPerTx, 6).toString() } : {}),
        perPeriod: { amount: parseUnits(form.usdcDaily, 6).toString(), periodSeconds: DAY },
      });
    }
    if (form.ethRecipient) {
      out.push({
        kind: "nativeTransfer",
        recipients: [form.ethRecipient],
        perPeriod: { amount: parseEther(form.ethDaily).toString(), periodSeconds: DAY },
      });
    }
    return out;
  };

  const grant = async () => {
    setBusy("grant");
    setError(null);
    try {
      const now = Number((await publicClient().getBlock()).timestamp);
      const hardMax: NonNullable<PolicyInput["escalation"]>["hardMax"] = [];
      if (form.hardMaxEth) hardMax.push({ token: "native", amount: parseEther(form.hardMaxEth).toString() });
      if (form.hardMaxUsdc) hardMax.push({ token: USDC, amount: parseUnits(form.hardMaxUsdc, 6).toString() });
      const policyInput: PolicyInput = {
        version: 1,
        chainId: 84532, // Base Sepolia (the only chain the approver targets)
        agent: form.agent,
        validFrom: now - 60,
        expiresAt: now + Number(form.days) * DAY,
        permissions: permissions(),
        escalation: { enabled: true, approvalTtlSeconds: 900, hardMax },
        forbidden: { targets: form.forbidden.split(/[\s,]+/).filter(Boolean) },
      };
      // SDK: validates, compiles one delegation per permission, passkey-signs each, and revokes this
      // agent's existing grant on-chain first so caps never stack.
      await ownerClient(account, fork).grantAgent({ policy: policyInput });
      setForm(EMPTY);
      setPrefilled(false);
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
      await ownerClient(account, fork).revoke(g.id);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ethOk = !form.ethRecipient || (isAddress(form.ethRecipient) && Number(form.ethDaily) > 0);
  const usdcOk = !form.usdcRecipient || (isAddress(form.usdcRecipient) && Number(form.usdcDaily) > 0);
  const valid =
    isAddress(form.agent) && (form.ethRecipient || form.usdcRecipient) && ethOk && usdcOk && Number(form.days) > 0;

  return (
    <Card title="Agents">
      <ul className="mb-6 space-y-2">
        {grants.length === 0 && <li className="text-sm text-zinc-500">No agents yet.</li>}
        {grants.map((g) => {
          const p = g.policy as { expiresAt: number };
          return (
            <li
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="text-sm">
                <p className="font-mono">{short(g.agent)}</p>
                <p className="text-xs text-zinc-500">
                  {describeGrant(g.policy)} · granted {ago(g.createdAt)} ·{" "}
                  {g.status === "active" ? `expires ${new Date(p.expiresAt * 1000).toLocaleDateString()}` : "revoked"}
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
      {prefilled && (
        <p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Prefilled from a link (local fork only). Check every field before signing.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent address">
          <input className={inputClass} value={form.agent} onChange={set("agent")} placeholder="0x…" />
        </Field>
        <Field label="Valid for (days)" hint="Max 90">
          <input className={inputClass} value={form.days} onChange={set("days")} />
        </Field>

        <Field label="USDC recipient" hint="Optional: lets the agent pay this address in USDC">
          <input className={inputClass} value={form.usdcRecipient} onChange={set("usdcRecipient")} placeholder="0x…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="USDC per day" hint="On-chain">
            <input className={inputClass} value={form.usdcDaily} onChange={set("usdcDaily")} />
          </Field>
          <Field label="USDC per payment" hint="Above: ask me">
            <input className={inputClass} value={form.usdcPerTx} onChange={set("usdcPerTx")} />
          </Field>
        </div>

        <Field label="ETH recipient" hint="Optional: lets the agent pay this address in ETH">
          <input className={inputClass} value={form.ethRecipient} onChange={set("ethRecipient")} placeholder="0x…" />
        </Field>
        <Field label="ETH per day" hint="On-chain">
          <input className={inputClass} value={form.ethDaily} onChange={set("ethDaily")} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Ask me up to (ETH)" hint="Above: denied">
            <input className={inputClass} value={form.hardMaxEth} onChange={set("hardMaxEth")} />
          </Field>
          <Field label="Ask me up to (USDC)" hint="Above: denied">
            <input className={inputClass} value={form.hardMaxUsdc} onChange={set("hardMaxUsdc")} />
          </Field>
        </div>
        <Field label="Forbidden addresses" hint="Comma-separated; never paid, never asked">
          <input className={inputClass} value={form.forbidden} onChange={set("forbidden")} />
        </Field>
      </div>
      <Button className="mt-4" disabled={!valid || busy !== null} onClick={grant}>
        {busy === "grant" ? "Confirm with passkey…" : "Grant (sign with passkey)"}
      </Button>
      <ErrorText error={error} />
    </Card>
  );
}
