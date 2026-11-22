# Passkey path (Phase 2)

The Phase 1 PoC uses a local EOA as the Hybrid account's owner, because a WebAuthn ceremony needs a browser.
Nothing else in the flow changes when a passkey is added. This is the plan, with the APIs it relies on.

## What's verified already

- `@metamask/smart-accounts-kit` 2.0.0 `HybridSignerConfig` accepts `{ webAuthnAccount: WebAuthnAccount, keyId: Hex }`
  (viem's `toWebAuthnAccount`). `HybridDeleGatorDeployParams` = `[owner, keyIds[], xValues[], yValues[]]`, so
  passkeys can be registered at deploy time next to the EOA owner.
- `HybridDeleGator` verifies P-256 via `P256SCLVerifierLib`: RIP-7212 precompile at `0x100`, SCL fallback.
- The precompile is live on Base Sepolia **and on an anvil fork of it**. Verified with a real P-256 signature
  (returns `1`).
- **Gas on other chains:** the precompile costs 3,450 gas per verification (RIP-7212). On a chain without it,
  `P256SCLVerifierLib` falls back to the Solidity SCL verifier, which works but costs a few hundred thousand gas
  per passkey signature check (every owner userOp, and every redemption of a passkey-signed delegation, since the
  DelegationManager re-verifies the delegator's signature each time). cyphos-guard only targets Base, where the
  precompile exists; check for it before deploying elsewhere.

## Plan

1. **Register** (approver app, browser): `navigator.credentials.create` via viem `createWebAuthnCredential`
   → public key (x, y) + credential id. RP ID = approver domain.
2. **Deploy** with `deployParams: [recoveryEoa, [keyId], [x], [y]]`. The EOA is the recovery owner held by the
   user, never by cyphos-guard. Alternatively add a passkey to an existing account via `HybridDeleGator.addKey`
   (an owner userOp, ADR 0003).
3. **Grant / approve**: build the delegation server-side (`compilePolicy`, or a one-shot approval delegation:
   `ExactExecution` + `LimitedCalls(1)` + short `Timestamp`), sign it in the browser with
   `account.signDelegation` using the WebAuthn signer. The agent redeems it as in the PoC. No bundler is needed
   for approvals.
4. **Revoke**: passkey-signed userOp `disableDelegation` via the bundler (`BUNDLER_URL`). The fallback is the EOA
   recovery key and self-submitted `handleOps` (ADR 0003).

## First spike in Phase 2 (biggest open risk, ADR 0001)

End-to-end `signDelegation` with a WebAuthn signer in a real browser, verified by `DelegationManager` through
`isValidSignature`. If that fails, the fallback is approval as a passkey-signed userOp that executes the call
directly.

## Notes

- Passkeys are bound to the RP ID. Losing the domain means losing the passkey, which is why the recovery EOA exists.
- Test passkeys in Chrome DevTools → WebAuthn virtual authenticator, so no real device is needed in CI.
