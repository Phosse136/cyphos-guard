# ADR 0005: Co-signer enforcer, making off-chain rules binding

- Status: Accepted
- Date: 2026-11-20
- Code: `packages/contracts/src/CosignerEnforcer.sol`, `packages/sdk/src/cosigner.ts`,
  `apps/policy-service/src/app.ts` (`/cosigner`, `/agent/cosign`)

## Problem

Some rules can't be expressed with the Delegation Framework's enforcers: ERC-20 per-payment caps, and argument
checks other than equality (`lt`, `lte`, `gt`, `gte`, `neq`). Until now the SDK checked them before redeeming
(ADR 0002). That stops a buggy agent, **but not a compromised one**: the agent holds its signed delegations and can
call `DelegationManager.redeemDelegations` directly, skipping the SDK.

## Decision

A custom caveat enforcer, **`CosignerEnforcer`**, that requires a fresh signature from a designated co-signer for every
redemption. The policy service holds the co-signer key and signs only when the off-chain rules pass. A policy opts
in with `cosigner: <address>`; the compiler then adds the caveat to every grant delegation.

- `terms` = the co-signer address (20 bytes). It's covered by the owner's delegation signature: the agent can't change
  who must co-sign.
- `args` = `abi.encode(salt, deadline, signature)`, supplied by the agent at redemption. In Delegation Framework v1.3.0
  a caveat's hash covers `(enforcer, terms)` but **not** `args` (`EncoderLib._getCaveatPacketHash`, verified in source).
  So the agent can attach a cosignature without the owner signing again.
- The cosignature is EIP-712 (domain: `cyphos-guard CosignerEnforcer` v1, chain id, enforcer address) over
  `Cosign(delegationManager, delegationHash, redeemer, executionHash, salt, deadline)`. It binds the exact call, the
  agent, the delegation, the DelegationManager and the chain.
- **Single use:** `usedCosignatures[msg.sender][digest]`, keyed by the calling DelegationManager like the framework's own
  stateful enforcers. A direct call to the hook can only consume entries in the caller's own namespace.
- **Short-lived:** the service issues 5-minute deadlines.
- **Single-call, default-execution mode only**, so the signed calldata is exactly what executes.
- Signature checks via OpenZeppelin 5.0.2 `ECDSA.tryRecover` (rejects malleable signatures).

## Why this doesn't break the non-custodial principle

The co-signer key is a new key held by the service, but it **can only block**. A cosignature adds a requirement and
grants nothing. Without the agent's key and the owner-signed delegation, with all its other caveats, it moves no
funds. The other caveats (period caps, recipients, expiry) still apply on-chain to every co-signed redemption. A fork
test checks that a valid cosignature can't exceed the period cap.

| If …                       | then …                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| the co-signer key leaks    | off-chain rules become bypassable again; on-chain caps still hold. Rotate by re-granting          |
| the policy service is down | the agent can't use co-signed grants (fail-closed). Owner approvals and revocation are unaffected |
| the agent is compromised   | it's held to the on-chain caps **and** the off-chain rules                                        |

## Deployment

The enforcer is deployed with the standard CREATE2 deployer (`0x4e59…956C`, present on Base Sepolia and its forks)
and a fixed salt. The address depends only on the bytecode: no owner, no upgrade, same address everywhere. The
bytecode is reproducible (`bytecode_hash = "none"`, `cbor_metadata = false`, solc 0.8.23 to match the framework).
CI rebuilds it and fails if `packages/contracts/generated/` differs from what the Solidity source compiles to.

- Fork: the policy service deploys it on start (dev relayer).
- Live: deploy once with `pnpm contracts:deploy` (anyone can; ~1 tx).

## Deployed

| Chain                | Address                                                                                                                         | Deploy tx                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Base Sepolia (84532) | [`0xDe95AB1D116AbF913584b6D3Bebf659D0CFfEA95`](https://sepolia.basescan.org/address/0xDe95AB1D116AbF913584b6D3Bebf659D0CFfEA95) | [2026-11-20](https://sepolia.basescan.org/tx/0x5ecd05ae046c75f422020e544aa8bbf9d9e8b154c55cd3c425bdcbdf1885c531) |

Checked after deployment: `COSIGN_TYPEHASH` and `eip712Domain()` match the source. The address is the CREATE2 address
of the committed bytecode, so the deployed initcode is exactly `packages/contracts/generated/`.

## Verified

- 14 Foundry unit tests incl. a 256-run fuzz test: valid, replay, fresh salt, wrong signer, different execution,
  redeemer, delegation, DelegationManager, wrong co-signer in terms, expiry, batch and try modes, bad terms,
  missing or garbage args.
- 8 fork tests through the **deployed** DelegationManager with real test USDC: predicted address, allowed with a fresh
  cosignature, rejected without one (`missing-cosignature`), forged by the agent, reused for a bigger amount, replayed,
  expired; period cap still enforced.
- Service tests: `/cosigner`, co-signs only in-policy calls (signature recovers to the co-signer), refuses off-chain
  violations, other agents' grants and revoked grants; grants naming a foreign co-signer or missing the caveat are rejected.
- E2E: a compromised agent that bypasses the SDK and redeems 3 USDC directly (per-payment limit 2) is rejected
  on-chain. The demo and both browser tests run with co-signed grants.

## Not done

- One co-signer per service; no key rotation helper (re-grant with the new address).
- The co-signer could also enforce smart rules (anomaly detection, rate limits). That's the hook for the roadmap's
  "smart rules".
