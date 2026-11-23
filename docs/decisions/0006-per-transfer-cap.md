# ADR 0006: On-chain per-payment cap for ERC-20 grants

Status: accepted (2026-11-23)

## Context

`erc20Transfer.perTx` ("at most 2 USDC per payment") was only checked by the SDK, and binding on-chain only when the
owner turned on the co-signer (ADR 0005). A compromised agent without a co-signer could redeem its delegation directly
and pay up to the whole period budget in one transfer. The same held for routine x402 top-ups.

MetaMask Delegation Framework v1.3.0 has no stateless "ERC-20 amount ≤ X" enforcer: `ValueLteEnforcer` only caps ETH
value, `ERC20TransferAmountEnforcer` keeps a running total, `AllowedCalldataEnforcer` only matches exact bytes.
Suggested in review on r/ethdev.

## Decision

Add `ERC20PerTransferCapEnforcer` (packages/contracts). terms = `token (20 bytes) ‖ maxAmount (uint256)`. The hook
requires single-call, default-execution mode, target == token, value == 0, calldata exactly 68 bytes with the
`transfer(address,uint256)` selector, and amount ≤ maxAmount. No storage.

These pins repeat what `ERC20PeriodTransferEnforcer` already checks, on purpose: the cap stays sound if it's ever used
without the period enforcer (otherwise `approve`, a batch, or a different selector with the same shape would walk around
it).

The compiler adds it to every `erc20Transfer` with `perTx`, and to every `x402` permission (a top-up covers at most one
payment's shortfall, which is ≤ `perTx`). Larger payments still go through escalation: the owner's approval is a
separate one-shot delegation without this cap.

Deployed through the standard CREATE2 deployer like the CosignerEnforcer: same address on every chain, nobody owns it.

## Consequences

- Per-payment token limits are binding on-chain without the co-signer. The co-signer stays useful for the rules that
  remain off-chain (`forbidden.targets`, contract-call argument operators other than `eq`).
- Existing grants don't change (a signed delegation's caveats are fixed); the approver shows "re-grant to enforce it
  on-chain" for them.
- One more unaudited contract (~25 lines of logic). Covered by Foundry unit tests (incl. fuzz) and a fork test
  through the deployed DelegationManager.
