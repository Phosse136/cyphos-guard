# ADR 0001: Smart-account and permission stack for the MVP

- Status: Proposed
- Date: 2026-11-20

## Context

cyphos-guard needs a maintained smart-account stack that provides:

1. A passkey (WebAuthn P-256) owner.
2. Scoped, revocable permissions for an agent key, with on-chain hard caps: per-tx and **per-period**
   value limits, target/function/argument restrictions, and expiry.
3. Owner-side revocation that works without cyphos-guard.
4. Base Sepolia support.
5. A clean path to an off-chain co-signer that can **block but never move funds**.

All facts below were checked on 2026-11-20 against the official docs, the npm registry and, for the
recommended option, the contract source (`MetaMask/delegation-framework` @ `b4b8c41`, 2026-10-22).

## Options compared

|                                           | **(a) MetaMask Smart Accounts Kit**                                                                         | **(b) ZeroDev Kernel v3**                                                                               | **(c) Safe + Rhinestone Smart Sessions**                                                                        | **(d) permissionless.js + Pimlico**                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Package / version                         | `@metamask/smart-accounts-kit` 2.0.0 (Aug 2026), Delegation Framework v1.3.0                                | `@zerodev/sdk` 5.5.12, `@zerodev/permissions` 5.6.5 (Nov 2026)                                          | `@rhinestone/sdk` 3.4.1 (Nov 2026)                                                                              | `permissionless` 0.5.2 (Oct 2026)                                                               |
| What it is                                | Delegation framework (ERC-7710) + DeleGator smart accounts                                                  | Modular ERC-7579 account with a permissions plugin                                                      | ERC-7579 modules on Safe (Safe7579) or other accounts; SDK now centred on Rhinestone's orchestrator/intents     | ERC-4337 **client** library (accounts, bundler, paymaster). **No permission system of its own** |
| Passkey owner                             | Yes. `Implementation.Hybrid` = EOA owner + N passkeys (viem `WebAuthnAccount`)                              | Yes. `@zerodev/passkey-validator`. Needs a passkey server (ZeroDev's or self-hosted) for register/login | Embedded wallet (`@rhinestone/wallet`) via their hosted passkey service. Core-SDK WebAuthn owner not documented | Only via the chosen account (Kernel, Safe, …)                                                   |
| RIP-7212 precompile                       | Yes. `P256SCLVerifierLib` tries `0x100`, falls back to the SCL verifier (verified in source)                | Yes ("progressive" validator, Daimo/FCL fallback)                                                       | n/a / undocumented                                                                                              | n/a                                                                                             |
| Value limit per tx                        | `ValueLte`                                                                                                  | Call policy `valueLimit`                                                                                | `valueLimitPerUse`                                                                                              | n/a                                                                                             |
| **Value limit per period (e.g. per day)** | **Yes, built in**: `NativeTokenPeriodTransfer`, `ERC20PeriodTransfer`, `MultiTokenPeriod`                   | **No.** Gas policy = lifetime gas, rate limit = op count. Would need a custom policy contract           | **No.** Param `usageLimit` is a _lifetime_ cumulative cap                                                       | n/a                                                                                             |
| Allowed targets / functions               | `AllowedTargets`, `AllowedMethods`                                                                          | Call policy (target + ABI function)                                                                     | `definePermissions` (address + ABI functions)                                                                   | n/a                                                                                             |
| Argument rules                            | `AllowedCalldata` (byte-range **equality**), `ExactCalldata`, `ExactExecution`; `LogicalOrWrapper` for OR   | `ParamCondition` EQUAL / LT / GT / LTE / GTE / NOT_EQUAL                                                | equal / lt / gt / lte / gte / ne, `min/max`, `anyOf`                                                            | n/a                                                                                             |
| Expiry                                    | `Timestamp`                                                                                                 | Timestamp policy                                                                                        | `validAfter` / `validUntil`                                                                                     | n/a                                                                                             |
| Call count                                | `LimitedCalls`, `Id`, `Nonce`                                                                               | Rate-limit policy                                                                                       | `maxUses`                                                                                                       | n/a                                                                                             |
| Revocation                                | `DelegationManager.disableDelegation` (owner); bulk via `NonceEnforcer`                                     | Documented for v2 (`revokeSessionKey`). **v3 revocation not documented** in current permission docs     | `disableSession` / uninstall validator                                                                          | n/a                                                                                             |
| Agent submits via                         | **Plain EOA tx** to `DelegationManager.redeemDelegations` (no bundler, agent pays its own gas), or a userOp | userOp through a bundler                                                                                | userOp or Rhinestone orchestrator                                                                               | userOp                                                                                          |
| Gas-drain risk via agent                  | None on the EOA path: the agent pays gas from its own EOA                                                   | Real: docs warn to pin the paymaster, or the agent can overpay gas from the account                     | Similar to (b)                                                                                                  | —                                                                                               |
| EIP-7702                                  | Yes (`Stateless7702`, local accounts only, no passkeys)                                                     | Yes (Kernel 3.3)                                                                                        | Yes (delegation proofs)                                                                                         | Yes                                                                                             |
| Base Sepolia                              | Yes. Framework v1.3.0 is deployed on 84532 (checked in `@metamask/delegation-deployments` 2.1.0)            | Yes (84532)                                                                                             | Used in docs; catalogue not confirmed                                                                           | Yes (Pimlico)                                                                                   |
| Bundler / paymaster                       | Bundler only for owner-side userOps (deploy, revoke). Agent path needs none                                 | Bundler required for every agent action                                                                 | Rhinestone API key (apiKey/JWT) for the SDK's main path                                                         | Pimlico key                                                                                     |
| License                                   | MIT-0 OR Apache-2.0 (SDK); MIT / Apache-2.0 (contracts)                                                     | MIT                                                                                                     | SDK MIT; **Smart Sessions contracts AGPL-3.0, README: "beta… use at your own risk"**                            | MIT                                                                                             |
| Audits                                    | Cyfrin + ConsenSys Diligence (`audits/` in repo)                                                            | Kernel audited (not re-verified here)                                                                   | `audits/` dir present; beta label                                                                               | —                                                                                               |
| Activity                                  | Active (contracts commit Oct 2026, SDK Aug 2026)                                                            | Very active (publishes this week)                                                                       | Very active                                                                                                     | Active                                                                                          |

### Note on ERC-7715 (MetaMask "Advanced Permissions")

ERC-7715 (`wallet_requestExecutionPermissions`) requires the MetaMask extension (≥ 13.23). **We do not
use it.** We use the underlying delegation framework directly with our own Hybrid smart account, so
users need no MetaMask install. That is also our differentiation: MetaMask's flow is
"grant once in the extension". Ours adds live escalation with passkey approval.

## Decision

**Use (a): MetaMask Smart Accounts Kit + Delegation Framework, with a `Hybrid` DeleGator account
(passkey signers + an EOA recovery owner).** Pair it with viem's bundler client and a Pimlico bundler for owner-side
userOps only.

Reasons, in order of weight:

1. **Per-period on-chain caps exist out of the box.** "Max X per day" is the core guardrail, and only (a) enforces it
   without us writing and auditing custom Solidity.
2. **The agent never touches a bundler or paymaster.** It redeems a delegation with a normal tx from its own EOA.
   That removes the paymaster gas-drain class of attack, and the agent runtime needs only an RPC URL.
3. **The escalation flow fits the primitive.** An approval becomes a _one-shot delegation_: the owner's passkey signs
   a delegation to the agent with `ExactExecution` (exactly this call) + `LimitedCalls(1)` + `Timestamp` (short TTL).
   The agent redeems it. The approval path needs no bundler and the approval can't be replayed or widened.
4. **The co-signer has a clean hook.** Caveats carry redeemer-supplied `args`, which are passed to
   `beforeHook(_terms, _args, …)` (verified in `ICaveatEnforcer.sol`). A future `CosignerEnforcer` can require
   a policy-service signature over `(delegationHash, executionCalldata, nonce)` in `args`. Without that signature
   the redemption reverts, so the co-signer can block but holds no authority to move funds.
5. Audited, permissively licensed, and deployed on Base Sepolia.

### Why not the others

- **(b) ZeroDev**: strong passkey story and richer argument operators, but no per-period spend limit without a custom
  policy contract. Every agent action is a userOp, which brings bundler dependency and paymaster-drain hygiene.
  The v3 revocation API is undocumented in current docs. **The best fallback** if (a) fails a spike.
- **(c) Safe + Rhinestone**: AGPL-3.0 + "beta" on Smart Sessions, only lifetime cumulative limits, and the current
  SDK leans on Rhinestone's API key / orchestrator. That conflicts with "self-serve, cheap, no lock-in".
- **(d) permissionless.js**: a client library, not a permission layer. It doesn't answer the question on its own.
  We can still use it if we need Pimlico-specific helpers.

> **Update (Phase 1):** owner-side userOps are self-submitted via `EntryPoint.handleOps` from the owner EOA, so no
> bundler is needed for the PoC. See ADR 0003. A bundler becomes relevant again for passkey-only owner actions.

## Consequences and known limitations (security-relevant)

- **Targets × methods is a cross-product.** `AllowedTargets` and `AllowedMethods` are independent sets. Granting
  `{A, B}` × `{f, g}` also permits `A.g` and `B.f`. Our policy schema therefore models a grant as a **list of
  permissions, one delegation each**, rather than one wide delegation. See ADR 0002.
- **On-chain argument rules are equality only** (`AllowedCalldata`). Range and inequality checks on arguments are
  off-chain (SDK pre-check / future co-signer).
- **`ERC20PeriodTransfer` permits only `token.transfer(...)` on that one token** (enforcer checks
  `target == token` and the `transfer` selector). A permission is therefore either "pay token X" or "call contract
  Y". It can't be both.
- **`NativeTokenPeriodTransfer` checks only `value`.** It must always be paired with `AllowedTargets` +
  `ExactCalldata(0x)` (plain sends) or explicit call caveats. Otherwise the agent could attach value to arbitrary calls.
- **ERC-20 per-tx caps have no direct enforcer** (`ERC20TransferAmount` is a lifetime total). The on-chain floor is
  the period cap. The per-tx cap is an off-chain escalation threshold. _(Superseded 2026-11-23: our own stateless
  `ERC20PerTransferCapEnforcer` makes it on-chain, see [ADR 0006](0006-per-transfer-cap.md).)_
- **"Forbidden" means forbidden for the agent.** The owner is sovereign and can sign anything with their passkey.
  cyphos-guard won't route a forbidden action into an approval request, but it can't stop the owner. This is
  intended (non-custodial).
- **Passkeys are bound to an RP ID (domain).** Losing the approver domain makes the passkey unusable for signing
  through our app. Mitigation: Hybrid's EOA owner is the recovery key, held by the user and never by cyphos-guard.
- The delegator account must be **deployed** before redemption. The PoC deploys it explicitly.

## Open risks to retire with spikes

1. **Phase 1:** redeem from an EOA on Base Sepolia with `NativeTokenPeriodTransfer` + `AllowedTargets` +
   `ExactCalldata` + `Timestamp`; confirm the revert reasons surface cleanly in viem.
2. **Phase 2:** `signDelegation` with a **WebAuthn** signer on the Hybrid account, end to end in a browser (EIP-712
   over WebAuthn → `isValidSignature`). If it fails, fall back to a passkey-signed userOp via the bundler.
3. Gas cost of P-256 verification on Base Sepolia (expected cheap via RIP-7212; measure).

**Outcome (2026-11):** 1 passed on live Base Sepolia (README, "Verified on Base Sepolia"). 2 passed
(`examples/poc/src/spike-passkey.ts`, then live with a real phone); no fallback needed. 3: the RIP-7212 precompile is
live on Base Sepolia and used by `P256SCLVerifierLib`; the fallback cost on other chains is noted in
[passkey-path.md](../passkey-path.md).
