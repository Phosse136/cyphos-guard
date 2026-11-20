# ADR 0003: Owner actions are self-submitted userOps (no bundler dependency)

- Status: Accepted (Phase 1)
- Date: 2026-11-20
- Code: `packages/sdk/src/owner.ts`

## Context

The Hybrid DeleGator only executes its own calls through the ERC-4337 EntryPoint (`execute` is
`onlyEntryPoint`, `disableDelegation` is `onlyEntryPointOrSelf`). Revoking a delegation therefore needs
a userOp. ADR 0001 assumed a hosted bundler (Pimlico) for these owner-side actions.

During Phase 1 we found that:

- A hosted bundler can't see a local anvil fork. We'd need two code paths, or a bundler running locally.
- "The owner can always revoke without cyphos-guard" shouldn't depend on any third-party service either.
- **AA21 didn't pay prefund**: on the first fork run, revocation failed because the smart account's
  balance was too low to prefund gas. An owner must be able to revoke even when the account is empty.

## Decision

- Owner actions are userOps signed by the account's owner signer and submitted **directly by the owner's
  EOA** via `EntryPoint.handleOps([op], beneficiary = owner)`. The EntryPoint is permissionless, so this is the
  same code path a bundler takes.
- Before submitting, the owner EOA tops up the account's **EntryPoint deposit** (`depositTo`) to the op's max
  gas cost if needed. The EntryPoint then takes no prefund from the account's ETH balance. Unused deposit stays
  withdrawable by the account.
- `handleOps` does not revert when the inner call fails, so we check `UserOperationEvent.success`.
- Account deployment is a plain tx from the owner EOA to the `SimpleFactory` (`getFactoryArgs()`).
- Gas limits are fixed and generous (deployed account, single signature check). No estimation round-trip.

A hosted bundler stays optional (`BUNDLER_URL`, public Pimlico endpoint verified working without a key). We'll
need it in Phase 2 if the owner signs with a **passkey only**. Then there's no owner EOA to pay for
`handleOps`, and a bundler (or a sponsor) submits the op.

## Consequences

- Phase 1 needs no API key and no bundler, on the fork or live.
- The owner EOA needs a little ETH for revoke gas. That's acceptable: it's the recovery key and is
  expected to be funded.
- Phase 2 (passkey owner): revocation via bundler (preferred) or via the EOA recovery key with this path
  as the fallback that always works.
