# X402Vault security review (2026-11-21)

Internal review of [`X402Vault.sol`](../../packages/contracts/src/X402Vault.sol) and the code around it (SDK
deployment and signing, policy-service verification). **This is not an independent audit.** The vault runs on Base
Sepolia testnet only.

## What the vault must guarantee

The vault is the x402 payer for one agent. Its only job: approve (ERC-1271) a USDC `TransferWithAuthorization`
**from the vault** to a **listed seller**, for **0 < value ≤ cap**, **signed by the agent**. Everything else must be
refused. Only the owner (the user's smart account) manages sellers and withdraws.

## Threat model

| Attacker                             | Can                                                                 | Must not be able to                                                                              |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Stolen agent key                     | sign authorizations; trigger top-ups within the on-chain period cap | pay anyone but listed sellers; exceed the cap per payment; move funds otherwise                  |
| Malicious facilitator                | submit, delay or drop a signed authorization                        | change recipient or amount; replay                                                               |
| Malicious seller                     | set `maxTimeoutSeconds`, hold a signature, claim failure            | get paid twice for one request; get more than it asked                                           |
| Malicious/compromised approver build | name an arbitrary vault address in the policy the owner signs       | get the service to accept a vault that isn't the real contract with exactly the policy's sellers |
| Anyone on-chain                      | call `isValidSignature`, front-run deployment                       | get a "valid" answer for any other message; block a grant                                        |

## Contract checks (Foundry, `packages/contracts/test/X402Vault.t.sol`)

| Check                                                                                                                  | Result                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Listed seller within cap, agent-signed                                                                                 | approved                                                               |
| Unlisted seller, value 0, value > cap, wrong signer                                                                    | refused                                                                |
| Claimed fields don't match the hash (some other message)                                                               | refused                                                                |
| `ReceiveWithAuthorization`, `CancelAuthorization`, EIP-2612 `Permit` hashes (USDC verifies these through ERC-1271 too) | refused, both with a transfer-shaped and with a direct agent signature |
| Malleable (high-s) and 64-byte compact agent signatures                                                                | refused (OpenZeppelin 5 ECDSA)                                         |
| Malformed / short signatures                                                                                           | refused (or revert, which USDC's SignatureChecker treats as invalid)   |
| Fuzz (256 runs): random recipient/value/nonce/hash                                                                     | approved iff listed ∧ 0 < value ≤ cap ∧ exact digest ∧ agent           |
| Plain ETH sent to the vault                                                                                            | bounces (no receive/fallback)                                          |
| Only owner sets sellers / withdraws                                                                                    | yes                                                                    |

Also confirmed by reading the code paths: the digest uses `address(this)` as `from` and the token's live
`DOMAIN_SEPARATOR()` (chain-specific); replay is prevented by EIP-3009's per-authorizer nonces in USDC;
`isValidSignature` is `view` (no reentrancy surface); `withdraw` uses SafeERC20.

End-to-end on a Base Sepolia fork with real USDC and the official x402 facilitator
([vault.fork.test.ts](../../examples/x402-seller/src/vault.fork.test.ts)): listed seller settles; unlisted
seller, over-cap and foreign signatures are refused by the facilitator's on-chain verification.

## Static analysis

`slither` 0.11.6 over `packages/contracts/src` (2026-11-21, library code excluded): **0 high, 0 medium**. 18 low or
informational results, all triaged: `unused-return` on `ECDSA.tryRecover`'s third value (the error code and signer are
checked), `reentrancy-events` in the owner-only `withdraw` (event after the transfer; no state changes after the call),
`timestamp` on the co-signer's 5-minute deadline (intended), and naming-convention style notes. Re-run with
`slither packages/contracts --filter-paths "lib/|test/"`.

## Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                           | Status                                                                                                                                                                                                                                                                |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | The policy service checked what the vault _reports_ (owner, agent, token, cap, listed sellers) but couldn't prove it is the real X402Vault, nor that it lists **only** the policy's sellers (the seller mapping can't be enumerated). A doctored approver could have named a look-alike contract. | **Fixed:** the policy now carries the vault's CREATE2 salt; the service recomputes the address from the policy (code + owner, agent, token, cap, sellers). A vault with an extra seller, an arbitrary contract, or a missing salt is refused. Tests in `app.test.ts`. |
| 2   | Low      | Anyone could front-run the vault deployment with the same calldata; the owner's deploy call then reverted and the grant aborted (griefing).                                                                                                                                                       | **Fixed:** deployment is idempotent. A vault already at the CREATE2 address is by construction the exact one wanted, so the SDK skips or tolerates it.                                                                                                                |
| 3   | Low      | The signed authorization's validity came from the seller's `maxTimeoutSeconds`. A malicious seller could ask for days, hold the signature, report failure, and cash it later, after the agent had paid again. Applies to the legacy (no-vault) mode too.                                          | **Fixed:** validity is capped at 10 minutes (`MAX_AUTHORIZATION_SECONDS`), whatever the seller asks. Unit test in `x402.test.ts`.                                                                                                                                     |
| 4   | Info     | Without the co-signer, the routine per-payment limit (`perTx`) is not binding for a compromised agent; the binding limits are the vault cap (= the owner's "ask me up to" maximum) per payment and the on-chain period cap in total.                                                              | Documented. The approver enables the co-signer by default; keep it on for defense in depth.                                                                                                                                                                           |
| 5   | Info     | A stolen agent key **colluding with a listed seller** can pay that seller up to the period cap. Inherent: the agent is allowed to pay listed sellers.                                                                                                                                             | Documented. Keep seller lists short and period caps low; revoke on suspicion.                                                                                                                                                                                         |
| 6   | Info     | The agent can't cancel a signed authorization (`CancelAuthorization` is refused by design).                                                                                                                                                                                                       | Mitigated by the 10-minute validity cap (finding 3).                                                                                                                                                                                                                  |
| 7   | Info     | ETH forced into the vault (e.g. `selfdestruct`) can't be withdrawn; `withdraw` covers ERC-20 only.                                                                                                                                                                                                | Accepted: plain ETH transfers bounce; forced ETH is a self-inflicted edge case.                                                                                                                                                                                       |

## Not covered

An independent audit; formal verification; behavior with tokens other than Circle's FiatToken v2.2 (USDC); x402
schemes other than `exact` with EIP-3009. Vaults deployed before finding 1 was fixed have no salt in their policy;
the service still accepts their stored grants, but new grants require the salt.
