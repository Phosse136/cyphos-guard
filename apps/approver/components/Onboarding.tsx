"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { type Address, isAddress } from "viem";
import { api, type Me } from "@/lib/api";
import { newAccount, sendOwnerCalls } from "@/lib/wallet";
import { Button, Card, ErrorText, Field, inputClass } from "./ui";

export function Onboarding({ me, onChange }: { me: Me; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState("");
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!me.owner && me.registrationOpen) {
    return (
      <Card title="Set up your owner passkey">
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Your passkey (Face ID, fingerprint, security key) will own your smart account and approve big agent actions.
          No seed phrase. The first passkey registered here becomes the owner.
        </p>
        <Button
          disabled={busy}
          onClick={run(async () => {
            const { challengeId, options } = await api.registerOptions();
            await api.registerVerify(challengeId, await startRegistration({ optionsJSON: options }));
          })}
        >
          Create passkey
        </Button>
        <ErrorText error={error} />
      </Card>
    );
  }

  if (!me.owner) {
    return (
      <Card title="Sign in">
        <Button
          disabled={busy}
          onClick={run(async () => {
            const { challengeId, options } = await api.loginOptions();
            await api.loginVerify(challengeId, await startAuthentication({ optionsJSON: options }));
          })}
        >
          Sign in with passkey
        </Button>
        <ErrorText error={error} />
      </Card>
    );
  }

  const owner = me.owner;
  return (
    <Card title="Create your smart account">
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        A MetaMask Hybrid smart account on Base Sepolia, owned by your passkey. cyphos-guard never holds a key to it.
      </p>
      <Field
        label="Recovery address (recommended)"
        hint="An address you control (e.g. a hardware wallet). It can always revoke agents and recover the account if this site or passkey is lost. Leave empty for passkey-only."
      >
        <input
          className={inputClass}
          placeholder="0x…"
          value={recovery}
          onChange={(e) => setRecovery(e.target.value.trim())}
        />
      </Field>
      <div className="mt-4 flex gap-2">
        <Button
          disabled={busy || (recovery !== "" && !isAddress(recovery))}
          onClick={run(async () => {
            const account = await newAccount(owner, recovery ? (recovery as Address) : null);
            if (me.fork) await api.devFund(account.address);
            // First userOp deploys the account (factory call) and is signed by the passkey.
            await sendOwnerCalls(account, me.fork, [{ to: account.address, value: 0n }]);
            await api.linkAccount(account.address);
          })}
        >
          {busy ? "Waiting for passkey…" : "Create account"}
        </Button>
      </div>
      {!me.fork && (
        <p className="mt-3 text-xs text-zinc-500">
          On Base Sepolia the account pays its own gas: fund the counterfactual address with test ETH first.
        </p>
      )}
      <ErrorText error={error} />
    </Card>
  );
}
