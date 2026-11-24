"use client";

import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api, type Me } from "@/lib/api";
import { short } from "@/lib/short";

// The sections (and through them the smart-account kit, ~1 MB) load after the first paint, in parallel with
// the /me request, instead of blocking it.
const Onboarding = dynamic(() => import("@/components/Onboarding").then((m) => m.Onboarding));
const Wallet = dynamic(() => import("@/components/Wallet").then((m) => m.Wallet));
const Requests = dynamic(() => import("@/components/Requests").then((m) => m.Requests));
const Grants = dynamic(() => import("@/components/Grants").then((m) => m.Grants));
const Activity = dynamic(() => import("@/components/Activity").then((m) => m.Activity));
const History = dynamic(() => import("@/components/History").then((m) => m.History));

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [account, setAccount] = useState<MetaMaskSmartAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [m, wallet] = await Promise.all([api.me(), import("@/lib/wallet")]);
      setMe(m);
      const o = m.owner;
      setAccount(o?.accountAddress ? await wallet.linkedAccount({ ...o, accountAddress: o.accountAddress }) : null);
    } catch (e) {
      setError(`Policy service unreachable: ${(e as Error).message}`);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">cyphos-guard</h1>
          <p className="text-sm text-zinc-500">
            Guardrails for your AI agents · Base Sepolia{me?.fork ? " (local fork)" : ""} · testnet only
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {account && (
            <>
              <span className="font-mono text-zinc-500" title={account.address}>
                {short(account.address)}
              </span>
              <Button variant="ghost" onClick={() => api.logout().then(refresh)}>
                Sign out
              </Button>
            </>
          )}
          {/* Light/dark switch: handled by /theme.js (shared with cyphosguard.com); icon via CSS. */}
          <button
            type="button"
            className="theme-toggle"
            data-theme-toggle
            aria-label="Switch light/dark mode"
            title="Light/dark mode"
          />
        </div>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {me && !account && <Onboarding me={me} onChange={refresh} />}
      {me && account && (
        <>
          <Wallet account={account} fork={me.fork} refreshKey={refreshKey} />
          <Requests account={account} fork={me.fork} onDecided={() => setRefreshKey((k) => k + 1)} />
          <Grants
            account={account}
            fork={me.fork}
            refreshKey={refreshKey}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
          <Activity fork={me.fork} refreshKey={refreshKey} />
          <History fork={me.fork} refreshKey={refreshKey} />
        </>
      )}
    </main>
  );
}
