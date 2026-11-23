"use client";

import { cosignerEnforcerAddress, perTransferCapEnforcerAddress, x402VaultAbi } from "@cyphos-guard/sdk";
import { type GrantJSON, parsePolicy } from "@cyphos-guard/shared";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { useCallback, useEffect, useState } from "react";
import { type Address, encodeFunctionData, erc20Abi, formatEther, formatUnits, isAddressEqual } from "viem";
import { api } from "@/lib/api";
import { duration, USDC, when } from "@/lib/format";
import { environment, publicClient, sendOwnerCalls } from "@/lib/wallet";
import { Addr, Badge, Button, Details, ErrorText, TxHash } from "./ui";

/** Name of the caveat enforcer at `address`, read from the deployed environment (what the chain actually checks). */
function enforcerName(address: string): string {
  if (isAddressEqual(address as `0x${string}`, cosignerEnforcerAddress)) return "CosignerEnforcer (cyphos-guard)";
  if (isAddressEqual(address as `0x${string}`, perTransferCapEnforcerAddress))
    return "ERC20PerTransferCapEnforcer (cyphos-guard)";
  const hit = Object.entries(environment.caveatEnforcers).find(
    ([, a]) => a && isAddressEqual(a, address as `0x${string}`),
  );
  return hit ? hit[0] : address;
}

/** Grants made before the per-transfer cap existed don't carry it; say what THIS delegation enforces. */
const hasPerTransferCap = (d: { caveats: { enforcer: string }[] } | undefined) =>
  !!d?.caveats.some((c) => isAddressEqual(c.enforcer as `0x${string}`, perTransferCapEnforcerAddress));

const tokenLabel = (token: string) => (isAddressEqual(token as `0x${string}`, USDC) ? "USDC" : `token ${token}`);

/** Everything this agent may do, in plain language, plus the on-chain rules that enforce each permission. */
export function AgentDetails({
  grant,
  fork,
  account,
}: {
  grant: GrantJSON;
  fork: boolean;
  account: MetaMaskSmartAccount;
}) {
  const policy = parsePolicy(grant.policy);
  const [revokeTx, setRevokeTx] = useState<string | null>(null);
  useEffect(() => {
    if (grant.status !== "revoked") return;
    api
      .activity(1000)
      .then((items) => {
        const hit = items.find(
          (a) => a.kind === "grant_revoked" && (a.detail as { grantId?: string }).grantId === grant.id,
        );
        setRevokeTx(hit?.txHash ?? null);
      })
      .catch(() => {});
  }, [grant.id, grant.status]);

  return (
    <div className="mt-3 space-y-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <Details
        rows={[
          ["Agent", <Addr key="a" value={grant.agent} />],
          [
            "Status",
            grant.status === "active" ? (
              <Badge key="st" tone="green">
                active
              </Badge>
            ) : (
              <Badge key="st" tone="red">
                revoked
              </Badge>
            ),
          ],
          ["Granted", when(grant.createdAt)],
          ["Valid from", policy.validFrom ? when(policy.validFrom) : "immediately"],
          ["Expires", when(policy.expiresAt)],
          ...(grant.revokedAt ? ([["Revoked", when(grant.revokedAt)]] as [string, React.ReactNode][]) : []),
          ...(revokeTx
            ? ([["Revoke tx", <TxHash key="r" hash={revokeTx} fork={fork} />]] as [string, React.ReactNode][])
            : []),
          [
            "Grant id",
            <span key="g" className="font-mono text-xs">
              {grant.id}
            </span>,
          ],
        ]}
      />

      <div>
        <h4 className="mb-2 text-sm font-semibold">Permissions (what it may do on its own)</h4>
        <ol className="space-y-3">
          {policy.permissions.map((p, i) => {
            const delegation = grant.delegations[i];
            return (
              <li
                key={delegation?.salt ?? p.kind}
                className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
              >
                {p.kind === "nativeTransfer" && (
                  <Details
                    rows={[
                      ["Type", "Send ETH"],
                      [
                        "To",
                        <span key="t">
                          {p.recipients.map((r) => (
                            <div key={r}>
                              <Addr value={r} />
                            </div>
                          ))}
                        </span>,
                      ],
                      [
                        "Per period",
                        `${formatEther(p.perPeriod.amount)} ETH per ${duration(p.perPeriod.periodSeconds)}`,
                      ],
                      [
                        "Per payment",
                        p.perTx !== undefined ? `max ${formatEther(p.perTx)} ETH (on-chain)` : "no extra limit",
                      ],
                    ]}
                  />
                )}
                {p.kind === "erc20Transfer" && (
                  <Details
                    rows={[
                      ["Type", `Send ${tokenLabel(p.token)}`],
                      ["Token", <Addr key="tk" value={p.token} />],
                      [
                        "To",
                        <span key="t">
                          {p.recipients.map((r) => (
                            <div key={r}>
                              <Addr value={r} />
                            </div>
                          ))}
                        </span>,
                      ],
                      [
                        "Per period",
                        `${formatUnits(p.perPeriod.amount, 6)} ${tokenLabel(p.token)} per ${duration(p.perPeriod.periodSeconds)}`,
                      ],
                      [
                        "Per payment",
                        p.perTx !== undefined
                          ? `max ${formatUnits(p.perTx, 6)} ${tokenLabel(p.token)} (${hasPerTransferCap(delegation) ? "enforced on-chain" : policy.cosigner ? "binding via co-signer" : "checked by the SDK only; re-grant to enforce it on-chain"})`
                          : "no extra limit",
                      ],
                    ]}
                  />
                )}
                {p.kind === "contractCall" && (
                  <Details
                    rows={[
                      ["Type", "Call a contract"],
                      ["Contract", <Addr key="c" value={p.target} />],
                      [
                        "Functions",
                        <span key="f">
                          {p.functions.map((f) => (
                            <div key={f.signature} className="font-mono text-xs">
                              {f.signature}
                              {f.args.map((a) => ` · arg ${a.index} ${a.op} ${a.value}`).join("")}
                            </div>
                          ))}
                        </span>,
                      ],
                      [
                        "ETH with calls",
                        p.value
                          ? `${formatEther(p.value.perPeriod.amount)} ETH per ${duration(p.value.perPeriod.periodSeconds)}`
                          : "none",
                      ],
                    ]}
                  />
                )}
                {p.kind === "x402" && (
                  <Details
                    rows={[
                      ["Type", `Pay x402 APIs in ${tokenLabel(p.token)}`],
                      [
                        "Sellers",
                        <span key="s">
                          {p.sellers.map((r) => (
                            <div key={r}>
                              <Addr value={r} />
                            </div>
                          ))}
                        </span>,
                      ],
                      [
                        "Per period",
                        `${formatUnits(p.perPeriod.amount, 6)} ${tokenLabel(p.token)} per ${duration(p.perPeriod.periodSeconds)}`,
                      ],
                      [
                        "Per payment",
                        `max ${formatUnits(p.perTx, 6)} ${tokenLabel(p.token)} on its own${p.vault ? "; above: ask me" : hasPerTransferCap(delegation) ? " (enforced on-chain)" : " (binding via co-signer)"}`,
                      ],
                      ...(p.vault
                        ? ([
                            ["Vault", <Addr key="v" value={p.vault} />],
                            [
                              "How",
                              "Each payment moves exactly the price from your account into this agent's vault, then the agent signs the x402 payment. The vault contract only pays the sellers listed above, up to your hard maximum per payment, so even a stolen agent key can't pay anyone else.",
                            ],
                          ] as [string, React.ReactNode][])
                        : ([
                            [
                              "How",
                              "Legacy (no vault): each payment moves exactly the price to the agent's own address, then the agent signs the x402 payment. The seller check is done by the co-signer, not on-chain.",
                            ],
                          ] as [string, React.ReactNode][])),
                    ]}
                  />
                )}
                {p.kind === "x402" && p.vault && (
                  <VaultPanel vault={p.vault} token={p.token} account={account} fork={fork} />
                )}
                {delegation && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Enforced on-chain by: {delegation.caveats.map((c) => enforcerName(c.enforcer)).join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Above the limits</h4>
        <Details
          rows={[
            [
              "Ask me",
              policy.escalation.enabled
                ? `yes, requests stay open for ${duration(policy.escalation.approvalTtlSeconds)}`
                : "no, denied",
            ],
            [
              "Hard maximum",
              policy.escalation.hardMax.length
                ? `${policy.escalation.hardMax
                    .map((h) =>
                      h.token === "native"
                        ? `${formatEther(h.amount)} ETH`
                        : `${formatUnits(h.amount, 6)} ${tokenLabel(h.token)}`,
                    )
                    .join(" · ")} (above: denied, never asked)`
                : "none",
            ],
            [
              "Denylist",
              policy.forbidden.targets.length ? (
                <span key="d">
                  {policy.forbidden.targets.map((t) => (
                    <div key={t}>
                      <Addr value={t} />
                    </div>
                  ))}
                </span>
              ) : (
                "none"
              ),
            ],
            [
              "Co-signer",
              policy.cosigner ? (
                <Addr key="cs" value={policy.cosigner} />
              ) : (
                "none (off-chain rules checked by the SDK only)"
              ),
            ],
          ]}
        />
      </div>
    </div>
  );
}

/** Live balance of an agent's X402Vault and a passkey-signed withdrawal back to the owner's account. */
function VaultPanel({
  vault,
  token,
  account,
  fork,
}: {
  vault: Address;
  token: Address;
  account: MetaMaskSmartAccount;
  fork: boolean;
}) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const load = useCallback(
    () =>
      publicClient()
        .readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] })
        .then(setBalance)
        .catch(() => setBalance(null)),
    [token, vault],
  );
  useEffect(() => {
    load();
  }, [load]);
  const withdraw = async () => {
    if (!balance) return;
    setBusy(true);
    setError(null);
    try {
      const data = encodeFunctionData({
        abi: x402VaultAbi,
        functionName: "withdraw",
        args: [token, account.address, balance],
      });
      setTx(await sendOwnerCalls(account, fork, [{ to: vault, data }]));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
      <span>
        In the vault: {balance === null ? "…" : `${formatUnits(balance, 6)} ${tokenLabel(token)}`} (normally 0: it is
        topped up just before each payment)
      </span>
      {balance !== null && balance > 0n && (
        <Button variant="ghost" disabled={busy} onClick={withdraw}>
          {busy ? "Confirm with passkey…" : "Withdraw to my wallet"}
        </Button>
      )}
      {tx && <TxHash hash={tx} fork={fork} />}
      <ErrorText error={error} />
    </div>
  );
}
