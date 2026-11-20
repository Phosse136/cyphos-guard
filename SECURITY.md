# Security

phoswallet is **experimental and testnet-only**. Do not use it with real funds. It has not been audited (the
MetaMask Delegation Framework contracts it builds on have been; phoswallet adds no contracts of its own).

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting for this repository
("Security" tab → "Report a vulnerability"). Include steps to reproduce and what an attacker gains. We aim to
acknowledge within a few days.

## Threat model in one page

**What protects the owner's funds** (holds even if phoswallet's servers are down or compromised):

- **On-chain caveats** on every delegation: recipients/targets, function selectors, `eq` argument pins, per-period
  and per-tx caps, expiry, zero-value defaults. Enforced by the MetaMask Delegation Framework.
- **One-shot approvals** signed by the owner's passkey: exact call (`ExactExecution`), usable once
  (`LimitedCalls(1)`), short-lived (`Timestamp`). A leaked approval can't be replayed or widened.
- **Revocation** is an on-chain call from the owner's account (passkey via a bundler, or the recovery EOA). It
  doesn't need phoswallet.

**What a compromised policy service could do:** delay or withhold requests and approvals, refuse to escalate,
show stale activity. **It cannot** move funds, widen a grant, forge an approval (passkey signatures are verified
on-chain) or stop revocation.

**What a compromised agent could do:** spend up to its on-chain limits until revoked, and ignore off-chain rules
(ERC-20 per-payment caps, non-`eq` argument rules), because it holds its signed delegations and can redeem
them directly. Put anything security-critical into on-chain rules. A co-signer enforcer that makes off-chain rules
binding is on the [roadmap](README.md#roadmap).

**Known limitations**

- The approver app is served by whoever hosts it. A malicious frontend could display one call and ask the passkey
  to sign another. Self-host it; a pinned build or wallet-side decoding is planned.
- Passkeys are bound to the approver's domain (RP ID). Keep a recovery EOA on the account.
- On a live network the account pays its own userOp gas. An empty account can't revoke through the bundler; use
  the recovery EOA (it can always submit the revocation itself).
- The fork-only dev relay and funding endpoints are enabled only when the RPC is an actual anvil node.

Design records with more detail: [ADR 0001](docs/decisions/0001-account-stack.md) (stack and caveat semantics),
[ADR 0003](docs/decisions/0003-owner-actions-without-bundler.md) (owner actions) and
[ADR 0004](docs/decisions/0004-approval-flow.md) (approval flow and trust model).
