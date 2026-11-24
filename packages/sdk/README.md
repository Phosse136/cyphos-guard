# @cyphos-guard/sdk

Scoped, revocable spending permissions for AI agents on a MetaMask smart account, with passkey approval
above the limit. **Testnet only** (Base Sepolia, Sepolia).

- [Quickstart](#quickstart)
- [Agent API](#agent-api)
- [Owner API](#owner-api)
- [Errors](#errors)
- [Policies](#policies) (more in [docs/policy-examples.md](../../docs/policy-examples.md))
- [What is enforced where](#what-is-enforced-where)

## Quickstart

### Agent side

```ts
import { createCyphosGuard, ApprovalPending, PolicyViolation } from "@cyphos-guard/sdk";
import { privateKeyToAccount } from "viem/accounts";

const pw = createCyphosGuard({
  accountAddress: "0xOwnerSmartAccount…", // the account the agent spends from
  policyServiceUrl: "https://app.cyphosguard.com/api", // public testnet instance, or your own (local: http://127.0.0.1:8787)
  rpcUrl: "https://sepolia.base.org",
  agent: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`), // the agent's own key
});

try {
  const r = await pw.execute({ to: shop, value: parseEther("0.0005"), reason: "API usage for November" });
  console.log("paid", r.txHash, "via", r.via); // "grant": within limits, no human involved
} catch (e) {
  if (e instanceof ApprovalPending) {
    // Above the limit: the owner got a request in the approver app.
    const r = await pw.waitForApproval(e.request.id); // or come back later
    console.log("approved and paid", r.txHash);
  } else if (e instanceof PolicyViolation) {
    console.log("not allowed:", e.reason); // forbidden / over_hard_max / no_grant / escalation_disabled
  } else throw e;
}
```

The agent needs a little ETH in **its own** EOA for gas. It never pays gas from the owner's account, so it
can't drain it through gas.

### Owner side

Most owners use the approver app (`pnpm dev`). The same operations are available programmatically:

```ts
const owner = createCyphosGuard({
  accountAddress: account.address,
  policyServiceUrl: "/api",
  owner: {
    account,                     // toMetaMaskSmartAccount({ implementation: Hybrid, signer: { webAuthnAccount, keyId } })
    sendCalls: (calls) => …,     // submit a passkey-signed userOp (bundler on live, dev relay on a fork)
    // fetch: …                  // Node only: a fetch that carries the session cookie
  },
});

const grant = await owner.grantAgent({
  policy: {
    version: 1, chainId: 84532, agent: "0xAgent…", expiresAt: now + 7 * 86400,
    permissions: [{ kind: "nativeTransfer", recipients: [shop], perPeriod: { amount: "1000000000000000", periodSeconds: 86400 } }],
  },
});
const pending = await owner.getRequests("pending");
await owner.approve(pending[0]);   // passkey prompt; signs a one-shot permission for exactly that call
await owner.revoke(grant.id);      // passkey prompt; disables the delegations on-chain, empties the x402 vault
```

## Agent API

| Method                                                |                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute({ to, value?, data?, reason }, { wait? })`   | Try the agent's grants (off-chain pre-checks, then on-chain simulation, then tx). If none fits, ask the owner. Resolves `{ status: "executed", txHash, via: "grant" \| "approval" }`. Without `wait` it throws `ApprovalPending` once the owner has been asked. With `wait: true \| { timeoutMs, pollMs }` it blocks until decided. |
| `waitForApproval(requestId, { timeoutMs?, pollMs? })` | Poll until decided, then execute the approval. Throws `ApprovalRejected`, `ApprovalExpired`, or `ApprovalPending` on timeout.                                                                                                                                                                                                       |
| `getRequest(id)`                                      | Current state of an approval request.                                                                                                                                                                                                                                                                                               |
| `getGrants()`                                         | The agent's active grants for `accountAddress`.                                                                                                                                                                                                                                                                                     |
| `getActivity()`                                       | The agent's own activity.                                                                                                                                                                                                                                                                                                           |

## Owner API

| Method                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grantAgent({ policy, onProgress? })`                      | Validate, compile (one delegation per permission), sign each with the owner signer, then **one** owner transaction that deploys x402 vaults, **revokes the agent's existing grant** (so caps never stack) and moves any rest in the agent's earlier vaults back to the account (since 0.2.1), then register. Signing comes first, so a cancelled prompt changes nothing on-chain; a retry reuses a vault or revoke that already went through. `onProgress({ step, of, action, label })` for UI. The service enforces one active grant per agent. |
| `revoke(grantId)`                                          | One owner userOp that disables every delegation of the grant and, since 0.2.1, moves any rest in the grant's x402 vault back to the account (a vault can't be switched off; [#2](https://github.com/Phosse136/cyphos-guard/issues/2)), then records it (the service checks on-chain).                                                                                                                                                                                                                                                            |
| `getRequests(status?)` / `approve(request)` / `reject(id)` | `approve` takes the **request object you displayed** and signs a delegation built from those exact fields. The server re-verifies the match and simulates it.                                                                                                                                                                                                                                                                                                                                                                                    |
| `getGrants()` / `getActivity()`                            | Everything for the account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Errors

All extend `CyphosGuardError` (`.code`).

| Error                                        | When                                                                                   | Agent should                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `PolicyViolation` (`.reason`, `.violations`) | `forbidden`, `over_hard_max`, `no_grant`, `escalation_disabled`                        | Stop; tell the user. Don't retry.                         |
| `ApprovalPending` (`.request`)               | The owner has been asked                                                               | Continue other work; `waitForApproval(request.id)` later. |
| `ApprovalRejected`                           | The owner said no                                                                      | Stop.                                                     |
| `ApprovalExpired`                            | Nobody decided in time                                                                 | Ask again if still needed.                                |
| `ExecutionFailed` (`.reason`)                | Allowed or approved, but the tx reverted (e.g. balance)                                | Report.                                                   |
| `PolicyServiceError` (`.status`)             | Service down or erroring after retries (network/429/5xx retried with backoff; 4xx not) | Retry later.                                              |
| `MissingSigner`                              | Agent method without `agent`, owner method without `owner`                             | Fix configuration.                                        |

Options: `retry: { attempts = 3, baseDelayMs = 300 }`, `logger: { debug?, info?, warn? }` (silent by default),
`chain` (Base Sepolia default; mainnet throws), `publicClient` (reads **and** writes go through it).

## Policies

```ts
{
  version: 1,
  chainId: 84532,
  agent: "0xAgent…",
  validFrom?: number,              // unix seconds
  expiresAt: number,               // required, max 90 days after validFrom
  permissions: [
    { kind: "nativeTransfer", recipients: ["0x…"], perTx?: "…wei", perPeriod: { amount: "…wei", periodSeconds: 86400 } },
    { kind: "erc20Transfer", token: "0x…", recipients: ["0x…" /* exactly one */], perTx?: "…", perPeriod: { … } },
    { kind: "contractCall", target: "0x…", functions: [{ signature: "approve(address,uint256)", args: [{ index: 0, op: "eq", value: "0x…" }] }],
      value?: { perTx?: "…", perPeriod: { … } } },
  ],
  escalation?: { enabled: true, approvalTtlSeconds: 900, hardMax: [{ token: "native" | "0xToken", amount: "…" }] },
  cosigner?: "0x…",               // policy-service co-signer (GET /cosigner): makes off-chain rules binding
  forbidden?: { targets: ["0x…"] },
}
```

## What is enforced where

| Rule                                                                                                                   | Enforced by                                                                                            | Binds a compromised agent?                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recipients, targets, functions, `eq` args (static types), per-period caps, per-tx ETH caps, expiry, ETH value on calls | **on-chain caveat enforcers**                                                                          | **Yes**                                                                                                                                                                                                                   |
| ERC-20 per-tx caps (`erc20Transfer.perTx`, x402 top-ups), since 0.2.0                                                  | **on-chain** `ERC20PerTransferCapEnforcer` ([ADR 0006](../../docs/decisions/0006-per-transfer-cap.md)) | **Yes** (grants signed with 0.1.x don't have it: re-grant)                                                                                                                                                                |
| `neq/lt/lte/gt/gte` args                                                                                               | SDK pre-check (escalates instead of acting)                                                            | **No** by default (it can redeem directly). **Yes with `cosigner`**: the on-chain CosignerEnforcer needs a co-signature the service only gives within policy ([ADR 0005](../../docs/decisions/0005-cosigner-enforcer.md)) |
| forbidden targets, hard max, escalation                                                                                | policy service (refuses to create a request)                                                           | n/a (the agent can't reach anything outside its on-chain allowlist anyway)                                                                                                                                                |

Put anything security-critical into on-chain rules, or set `cosigner` on the policy to make the off-chain ones binding.
