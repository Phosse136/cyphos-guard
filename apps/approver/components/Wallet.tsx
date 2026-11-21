"use client";

import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { useCallback, useEffect, useState } from "react";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  isAddress,
  parseAbi,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";
import { USDC } from "@/lib/format";
import { publicClient, sendOwnerCalls } from "@/lib/wallet";
import { Button, Card, CopyButton, Details, ErrorText, Field, inputClass } from "./ui";

/** The owner's smart account: address, balances, recovery address, and sending funds back out (passkey-signed). */
export function Wallet({
  account,
  fork,
  refreshKey,
}: {
  account: MetaMaskSmartAccount;
  fork: boolean;
  refreshKey: number;
}) {
  const [eth, setEth] = useState<bigint | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [recovery, setRecovery] = useState<Address | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ to: "", token: "USDC", amount: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const address = account.address;

  const load = useCallback(async () => {
    const c = publicClient();
    const [e, u] = await Promise.all([
      c.getBalance({ address }),
      c.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => 0n),
    ]);
    setEth(e);
    setUsdc(u);
  }, [address]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate reload trigger
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  useEffect(() => {
    publicClient()
      .readContract({ address, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" })
      .then((o) => {
        const r = o === zeroAddress ? null : o;
        setRecovery(r);
        if (r) setForm((f) => (f.to ? f : { ...f, to: r }));
      })
      .catch(() => setRecovery(null));
  }, [address]);

  const send = async () => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const to = form.to as Address;
      const call =
        form.token === "ETH"
          ? { to, value: parseEther(form.amount) }
          : {
              to: USDC as Address,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [to, parseUnits(form.amount, 6)],
              }),
            };
      setSent(await sendOwnerCalls(account, fork, [call]));
      setForm((f) => ({ ...f, amount: "" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const amountOk = Number(form.amount) > 0;
  const max = form.token === "ETH" ? eth : usdc;
  const tooMuch =
    max !== null && amountOk && (form.token === "ETH" ? parseEther(form.amount) : parseUnits(form.amount, 6)) > max;

  return (
    <Card
      title="Your wallet"
      action={
        <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Send funds out"}
        </Button>
      }
    >
      <p className="break-all font-mono text-sm">
        {address}
        <CopyButton value={address} />
        {!fork && (
          <a
            className="ml-2 text-xs text-blue-600 hover:underline"
            href={`https://sepolia.basescan.org/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Basescan ↗
          </a>
        )}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Smart account on Base Sepolia, owned by your passkey. Send test ETH / USDC here to fund your agents. No seed
        phrase: it isn't importable into MetaMask; your recovery address is the backup.
      </p>
      <div className="mt-3">
        <Details
          rows={[
            ["ETH", eth === null ? "…" : `${formatEther(eth)} ETH`],
            ["USDC", usdc === null ? "…" : `${formatUnits(usdc, 6)} USDC`],
            ["Recovery address", recovery ?? "none (passkey only)"],
          ]}
        />
      </div>

      {open && (
        <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Field label="Send to" hint={recovery ? "Prefilled with your recovery address" : undefined}>
            <input
              className={inputClass}
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value.trim() })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Token">
              <select
                className={inputClass}
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              >
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
              </select>
            </Field>
            <Field label="Amount" hint={tooMuch ? "More than the balance" : undefined}>
              <input
                className={inputClass}
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value.trim() })}
              />
            </Field>
          </div>
          <Button disabled={busy || !isAddress(form.to) || !amountOk || tooMuch} onClick={send}>
            {busy ? "Confirm with passkey…" : "Send (sign with passkey)"}
          </Button>
          {sent && (
            <p className="text-xs text-green-700">
              Sent.{" "}
              {!fork && (
                <a
                  className="underline"
                  href={`https://sepolia.basescan.org/tx/${sent}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Basescan
                </a>
              )}
            </p>
          )}
          <ErrorText error={error} />
        </div>
      )}
    </Card>
  );
}
