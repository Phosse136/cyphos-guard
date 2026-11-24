# How cyphos-guard checks its own security

We have no independent audit yet (and won't go to mainnet without one). Until then, everything below runs in CI on every
push (the live canary on demand), so a claim on the website is either checked by a machine or marked as a
limit in the [threat model](threat-model.md). **None of this is a substitute for an audit.**

| Layer                     | What                                                                                                                                                                | Where / how to run                                                    | When            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| Unit tests (contracts)    | 38 Foundry tests incl. fuzzing, adversarial cases from the vault review                                                                                             | `pnpm contracts:test`                                                 | every push (CI) |
| Invariant tests           | X402Vault under random sequences of payments, forgeries, replays, owner actions                                                                                     | `packages/contracts/test/X402Vault.invariant.t.sol`                   | every push (CI) |
| Symbolic proofs (Halmos)  | for **all** inputs: the cap enforcer only passes a capped `transfer`; the vault only approves a capped payment to a listed seller; only the owner manages the vault | `pnpm --filter @cyphos-guard/contracts halmos`                        | every push (CI) |
| Static analysis (Slither) | 0 open findings; 4 informational ones annotated in the source with the reason                                                                                       | `pnpm --filter @cyphos-guard/contracts slither`                       | every push (CI) |
| Mutation test             | 26 planted bugs (one security check weakened or removed each): all must be caught                                                                                   | `pnpm --filter @cyphos-guard/contracts mutation`                      | every push (CI) |
| Red team (fork)           | 25 attacks with a stolen agent key, straight to the chain, plus 7 stateful ones                                                                                     | `packages/sdk/src/attacks.fork.test.ts` (`pnpm test:fork`)            | every push (CI) |
| Red team (live canary)    | the same 25 attacks against a live grant on Base Sepolia, plus site/service/chain health                                                                            | `apps/canary`, result on [/stats](https://app.cyphosguard.com/stats/) | on demand       |

`pnpm contracts:verify` runs Slither, Halmos and the mutation test (needs `pip install slither-analyzer==0.11.6
halmos==0.3.3`).

## The attack catalog

Source: [`packages/sdk/src/testing/attacks.ts`](../../packages/sdk/src/testing/attacks.ts). The attacker holds the
**agent's key** and bypasses the SDK, the policy service and the co-signer. Grant under attack: ERC-20 transfers
capped per payment and per day to one recipient; x402 through the agent's vault with one seller. Every attack must
revert **with the expected reason** (an attack that fails for an unrelated reason is reported, not counted as
blocked), and positive controls (a legitimate payment of exactly the cap) must go through, or the run is
inconclusive.

| ID  | Attack                                                            | Stopped by (revert reason)                             |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| A01 | pay one unit above the per-payment cap                            | `ERC20PerTransferCapEnforcer:amount-exceeded`          |
| A02 | pay the attacker instead of the allowed recipient                 | `AllowedCalldataEnforcer:invalid-calldata`             |
| A03 | `approve(attacker, max)`                                          | `ERC20PeriodTransferEnforcer:invalid-method`           |
| A04 | `increaseAllowance(attacker, max)`                                | `ERC20PeriodTransferEnforcer:invalid-method`           |
| A05 | `transferFrom(account, attacker, cap)`                            | `ERC20PeriodTransferEnforcer:invalid-execution-length` |
| A06 | batch mode: two cap-sized payments in one redemption              | `CaveatEnforcer:invalid-call-type`                     |
| A07 | try mode instead of default execution                             | `CaveatEnforcer:invalid-execution-type`                |
| A08 | move a different token (WETH) under the USDC grant                | `ERC20PeriodTransferEnforcer:invalid-contract`         |
| A09 | attach ETH to the token transfer                                  | `ValueLteEnforcer:value-too-high`                      |
| A10 | valid transfer with trailing bytes                                | `ERC20PeriodTransferEnforcer:invalid-execution-length` |
| A11 | recipient word with dirty high bits                               | `AllowedCalldataEnforcer:invalid-calldata`             |
| A12 | strip the per-payment cap caveat from the signed delegation       | `InvalidERC1271Signature()`                            |
| A13 | rewrite the cap in the caveat terms                               | `InvalidERC1271Signature()`                            |
| A14 | someone other than the agent redeems the delegation               | `InvalidDelegate()`                                    |
| A15 | agent re-delegates unrestricted to the attacker, who pays himself | `AllowedCalldataEnforcer:invalid-calldata`             |
| A16 | re-delegated chain pays above the cap                             | `ERC20PerTransferCapEnforcer:amount-exceeded`          |
| A17 | call the smart account's `execute()` with the agent key           | `NotEntryPoint()`                                      |
| X01 | x402 top-up to the agent's own address                            | `AllowedCalldataEnforcer:invalid-calldata`             |
| X02 | x402 top-up straight to the attacker                              | `AllowedCalldataEnforcer:invalid-calldata`             |
| X03 | x402 top-up above the cap                                         | `ERC20PerTransferCapEnforcer:amount-exceeded`          |
| X04 | agent signs a vault payment to the attacker                       | `FiatTokenV2: invalid signature` (vault says no)       |
| X05 | agent signs a vault payment above the cap                         | `FiatTokenV2: invalid signature`                       |
| X06 | another key signs a vault payment to the seller                   | `FiatTokenV2: invalid signature`                       |
| X07 | `receiveWithAuthorization` from the vault                         | `FiatTokenV2: invalid signature`                       |
| X08 | agent signs an EIP-2612 permit for the vault's USDC               | `EIP2612: invalid signature`                           |

Stateful attacks (fork only): **S01** budget exhausted, **S02** one second after expiry, **S03** after revoke,
**S04** replaying a vault payment, **S05** the agent calling the vault's owner functions, **S06** paying a seller the
owner removed with an authorization signed before, **S07** calling the period enforcer's hook directly to confuse
the owner's budget. Known limit **L01** (period boundary, up to 2× the period budget) is asserted so it can't change
unnoticed. The suite also proves it isn't vacuous: a grant without the per-payment cap is reported as a hole.

## Findings from this work (2026-11-23)

- Slither: 4 informational results (unchecked third return value of `tryRecover`, event after an owner-only external
  call, timestamp comparison for a minutes-long deadline). None exploitable; annotated in the source. Comments only:
  the bytecode and the CREATE2 addresses are unchanged.
- Halmos: one counterexample, in the proof, not the contract: the cap enforcer accepts mode words whose call type is
  single and exec type default but with other bytes set. The DeleGator only acts on those two bytes, so this is the
  same behaviour as the framework's own enforcers; the proof now states exactly that.
- Red team and invariants: no hole found. The recovery page's browser test had broken with the light/dark switch
  (test server only); fixed.
