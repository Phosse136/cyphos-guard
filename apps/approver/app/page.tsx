"use client";

import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { useCallback, useEffect, useState } from "react";
import { Activity } from "@/components/Activity";
import { Grants } from "@/components/Grants";
import { History } from "@/components/History";
import { Onboarding } from "@/components/Onboarding";
import { Requests } from "@/components/Requests";
import { Button } from "@/components/ui";
import { api, type Me } from "@/lib/api";
import { short } from "@/lib/format";
import { linkedAccount } from "@/lib/wallet";

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [account, setAccount] = useState<MetaMaskSmartAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      const o = m.owner;
      setAccount(o?.accountAddress ? await linkedAccount({ ...o, accountAddress: o.accountAddress }) : null);
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
        {account && (
          <div className="flex items-center gap-3 text-sm">
            <span className="font-mono text-zinc-500" title={account.address}>
              {short(account.address)}
            </span>
            <Button variant="ghost" onClick={() => api.logout().then(refresh)}>
              Sign out
            </Button>
          </div>
        )}
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {me && !account && <Onboarding me={me} onChange={refresh} />}
      {me && account && (
        <>
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
