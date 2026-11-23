# Threat model

What cyphos-guard protects, from whom, which layer stops what, and what it deliberately does **not** protect
against. Testnet only, **not independently audited**. How each claim is checked:
[verification.md](verification.md).

## Assets

| Asset                                     | Where                                                  |
| ----------------------------------------- | ------------------------------------------------------ |
| Funds in the owner's smart account        | MetaMask Hybrid smart account (passkey + recovery EOA) |
| Funds in an agent's X402Vault             | one vault per agent and grant, topped up just in time  |
| The owner's authority (passkey)           | the owner's device (WebAuthn), never leaves it         |
| The agent's key                           | the agent's machine (EOA); assumed **stealable**       |
| The grant (signed delegations + policy)   | agent, policy service, chain                           |
| Approval decisions and activity (privacy) | policy service database                                |

## Trust boundaries

```
 owner device (passkey) ──signs──▶ delegations, approvals, revokes          TRUSTED for its own decisions
 agent process (agent key) ──redeems──▶ DelegationManager                   UNTRUSTED (may be injected/stolen)
 policy service ──refuses/escalates, optional co-signer──▶                  SEMI-TRUSTED: can block, can't widen
 chain: DelegationManager + caveat enforcers + X402Vault ──enforce──▶      TRUSTED (code at fixed addresses)
```

The design goal: **with only the agent's key, nothing beyond the signed grant can happen, and the grant is
enforced by the chain, not by our servers.**

## Attackers and what stops them

| Attacker                                     | Wants                                         | Stopped by                                                                                         | Checked by                                              |
| -------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Stolen agent key / prompt-injected agent** | pay itself, pay more, pay more often          | on-chain caveats: recipient pin, per-payment cap, period cap, expiry, single-call mode             | red team A01–A17, X01–X08, S01–S07 (fork + live canary) |
|                                              | approve/permit/transferFrom tricks            | selector + exact-length pins (period and cap enforcers), vault approves one digest only            | A03–A05, A10, X07, X08; Halmos                          |
|                                              | batch or try mode to hide a second call       | `onlySingleCallTypeMode`, `onlyDefaultExecutionMode`                                               | A06, A07; mutation test                                 |
|                                              | re-delegate to itself without caveats         | the root's caveats run for every redemption in the chain                                           | A15, A16                                                |
|                                              | edit caveats after signing                    | caveats are inside the owner's signature                                                           | A12, A13                                                |
|                                              | act on the account directly                   | the account only executes through the EntryPoint or the DelegationManager                          | A17                                                     |
|                                              | x402: pay an unlisted seller, over the cap    | X402Vault `isValidSignature`                                                                       | X04–X06; vault invariants; Halmos                       |
|                                              | x402: keep funds by topping up itself         | top-up recipient pinned to the vault                                                               | X01, X02                                                |
| **Leaked delegation (no key)**               | redeem it                                     | the DelegationManager checks `msg.sender == delegate`                                              | A14                                                     |
| **Malicious facilitator / seller (x402)**    | replay, change amount or recipient            | EIP-3009 nonces, the vault recomputes the digest; authorizations valid ≤10 min                     | S04; vault review                                       |
| **Compromised policy service**               | widen a grant, move funds                     | it holds no key that can move funds; grants are signed by the passkey; co-signer can only block    | ADR 0004, ADR 0005                                      |
|                                              | deny service (refuse approvals, go down)      | **not prevented**: the agent's within-limit payments and the owner's revoke don't need it          | canary (degraded alert)                                 |
| **Leaked co-signer key**                     | use it to pay                                 | a co-signature only adds a requirement; the remaining caveats still hold                           | CosignerEnforcer tests                                  |
| **Malicious approver host / build**          | show one thing, have the passkey sign another | the approver decodes what will be signed locally; **residual risk** until a pinned build (roadmap) | -                                                       |
| **Phished owner**                            | get a wide grant signed                       | grants are capped to 90 days, decoded and shown before signing; **residual risk**                  | -                                                       |
| **Anyone on-chain**                          | front-run vault/enforcer deployment           | CREATE2: an address can only ever hold exactly our bytecode                                        | canary contract check                                   |

## Known limits (accepted, documented, asserted by tests)

- **L01 period boundary.** Period caps run in fixed windows from the grant's start (`ERC20PeriodTransferEnforcer`).
  A full budget at the end of one window and another at the start of the next is allowed: up to **2× the period
  budget within minutes**, never more. Size the period budget with that in mind. (`attacks.fork.test.ts` L01)
- **L02 the grant itself.** Within its limits the agent can pay the allowed recipient until the budget is used up,
  also when the agent is compromised. That's what was granted; the limits are the protection.
- **L03 recovery wallet = full power.** The recovery EOA can withdraw everything or remove the passkey. That's its
  job; keep it offline. If it leaks, the account is lost.
- **L04 vault balance.** A compromised agent can spend whatever is in its vault (≤ the top-ups, which are capped by
  the period budget) to listed sellers. Sellers are chosen by the owner.
- **L05 off-chain rules.** Without the co-signer, rules the chain can't express (blocked addresses beyond the
  recipient pin, argument ranges) are checked by the SDK and the service only; a compromised agent skips them. With
  the co-signer they're binding. See `ENFORCEMENT` in `packages/shared/src/policy.ts`, which states per field where
  it is enforced.
- **L06 third-party code.** The MetaMask Delegation Framework v1.3.0 (audited by its authors) and USDC are trusted.
  A bug there is out of our scope, but the live canary would notice a behaviour change on the paths it tests.

## Out of scope

Mainnet use (testnet only until an independent audit), denial of service against the public instance, the
security of the user's device and passkey provider, and the third-party contracts above.
