"use client";

import { cosignerEnforcerAddress } from "@cyphos-guard/sdk";
import { type GrantJSON, parsePolicy } from "@cyphos-guard/shared";
import { useEffect, useState } from "react";
import { formatEther, formatUnits, isAddressEqual } from "viem";
import { api } from "@/lib/api";
import { duration, USDC, when } from "@/lib/format";
import { environment } from "@/lib/wallet";
import { Addr, Badge, Details, TxHash } from "./ui";

/** Name of the caveat enforcer at `address`, read from the deployed environment (what the chain actually checks). */
function enforcerName(address: string): string {
  if (isAddressEqual(address as `0x${string}`, cosignerEnforcerAddress)) return "CosignerEnforcer (cyphos-guard)";
  const hit = Object.entries(environment.caveatEnforcers).find(
    ([, a]) => a && isAddressEqual(a, address as `0x${string}`),
  );
  return hit ? hit[0] : address;
}

const tokenLabel = (token: string) => (isAddressEqual(token as `0x${string}`, USDC) ? "USDC" : `token ${token}`);

/** Everything this agent may do, in plain language, plus the on-chain rules that enforce each permission. */
export function AgentDetails({ grant, fork }: { grant: GrantJSON; fork: boolean }) {
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
                          ? `max ${formatUnits(p.perTx, 6)} ${tokenLabel(p.token)} (${policy.cosigner ? "binding via co-signer" : "checked by the SDK only"})`
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
