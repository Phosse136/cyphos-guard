"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { type Address, formatEther, isAddress, parseEther } from "viem";
import { api, type Me } from "@/lib/api";
import { newAccount, publicClient, sendOwnerCalls } from "@/lib/wallet";
import { Button, Card, ErrorText, Field, inputClass } from "./ui";

export function Onboarding({ me, onChange }: { me: Me; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState("");
  const [setupCode, setSetupCode] = useState("");
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
        {me.setupCodeRequired && (
          <Field
            label="Setup code"
            hint="Printed in the server log / set as OWNER_SETUP_CODE by whoever runs this server."
          >
            <input
              className={inputClass}
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <Button
          disabled={busy || (me.setupCodeRequired && !setupCode.trim())}
          onClick={run(async () => {
            const { challengeId, options } = await api.registerOptions(setupCode || undefined);
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
    <CreateAccount
      me={me}
      owner={owner}
      busy={busy}
      error={error}
      recovery={recovery}
      setRecovery={setRecovery}
      onCreate={run}
    />
  );
}

/** On live Base Sepolia the account pays for its own deployment, so it must hold test ETH first. */
const MIN_DEPLOY_BALANCE = parseEther("0.0003");

function CreateAccount({
  me,
  owner,
  busy,
  error,
  recovery,
  setRecovery,
  onCreate,
}: {
  me: Me;
  owner: NonNullable<Me["owner"]>;
  busy: boolean;
  error: string | null;
  recovery: string;
  setRecovery: (v: string) => void;
  onCreate: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  const recoveryOk = recovery === "" || isAddress(recovery);
  const [address, setAddress] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  // The counterfactual address depends on the passkey AND the recovery address: recompute when it changes.
  useEffect(() => {
    if (!recoveryOk) return setAddress(null);
    let stale = false;
    newAccount(owner, recovery ? (recovery as Address) : null).then((a) => {
      if (!stale) setAddress(a.address);
    });
    return () => {
      stale = true;
    };
  }, [owner, recovery, recoveryOk]);

  // Live only: poll the balance so the owner sees when their faucet / wallet transfer has arrived.
  useEffect(() => {
    if (me.fork || !address) return;
    let stop = false;
    const tick = async () => {
      const b = await publicClient()
        .getBalance({ address })
        .catch(() => null);
      if (!stop) setBalance(b);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [address, me.fork]);

  const funded = me.fork || (balance !== null && balance >= MIN_DEPLOY_BALANCE);
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
      {!me.fork && address && (
        <div className="mt-4 rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
          <p className="font-medium">1. Fund your account address with test ETH</p>
          <p className="mt-1 break-all font-mono text-xs">{address}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Balance: {balance === null ? "…" : `${formatEther(balance)} ETH`} · needs at least{" "}
            {formatEther(MIN_DEPLOY_BALANCE)} ETH to pay for its own deployment. Send from your wallet or a Base Sepolia
            faucet; this updates automatically. Changing the recovery address changes this address.
          </p>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button
          disabled={busy || !recoveryOk || !funded}
          onClick={onCreate(async () => {
            const account = await newAccount(owner, recovery ? (recovery as Address) : null);
            if (me.fork) await api.devFund(account.address);
            // First userOp deploys the account (factory call) and is signed by the passkey.
            const txHash = await sendOwnerCalls(account, me.fork, [{ to: account.address, value: 0n }], {
              report: false, // reported below: the service only accepts it once the account is linked
            });
            await api.linkAccount(account.address);
            api.reportOwnerTx(txHash).catch(() => {});
          })}
        >
          {busy ? "Waiting for passkey…" : me.fork ? "Create account" : "2. Create account"}
        </Button>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}
