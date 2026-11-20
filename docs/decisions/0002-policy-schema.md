# ADR 0002: Policy schema v1 and enforcement mapping

- Status: Proposed
- Date: 2026-11-20
- Code: `packages/shared/src/policy.ts`

## Shape (plain language)

A **policy** is what an owner grants one **agent** on one testnet chain:

| Field                     | Meaning                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `agent`                   | The agent's EOA address: the only key that can redeem the grant                        |
| `chainId`                 | `84532` (Base Sepolia) or `11155111` (Sepolia). Mainnet ids are rejected by the schema |
| `validFrom` / `expiresAt` | Validity window in unix seconds. `expiresAt` is required; max 90 days                  |
| `permissions[]`           | What the agent may do on its own. Each entry becomes **one delegation**                |
| `escalation`              | What happens when the agent wants to go beyond `permissions`                           |
| `forbidden.targets`       | Addresses that are never used and never offered for approval                           |

Permission kinds (the brief's `allowedTargets`, `allowedFunctions` and `limits` live inside them):

- `nativeTransfer`: plain ETH sends to `recipients`, with `perTx` and **required** `perPeriod`.
- `erc20Transfer`: `token.transfer()` to `recipients`, with `perTx` (off-chain) and **required** `perPeriod`.
- `contractCall`: one `target`, a list of `functions` (signatures), optional `args` rules per function, and
  optional native `value` caps (default: no value allowed).

```jsonc
{
  "version": 1,
  "chainId": 84532,
  "agent": "0xAgent…",
  "validFrom": 1795000000,
  "expiresAt": 1795604800,
  "permissions": [
    {
      "kind": "nativeTransfer",
      "recipients": ["0xShop…"],
      "perPeriod": { "amount": "1000000000000000", "periodSeconds": 86400 }
    },
    {
      "kind": "erc20Transfer",
      "token": "0xUSDC…",
      "recipients": ["0xShop…"],
      "perTx": "500000",
      "perPeriod": { "amount": "1000000", "periodSeconds": 86400 }
    }
  ],
  "escalation": {
    "enabled": true,
    "approvalTtlSeconds": 900,
    "hardMax": [{ "token": "native", "amount": "50000000000000000" }]
  },
  "forbidden": { "targets": ["0xMixer…"] }
}
```

## Why a list of permissions, not one flat rule set

In the MetaMask Delegation Framework `AllowedTargets` and `AllowedMethods` are independent sets.
One delegation with targets `{A,B}` and methods `{f,g}` also allows `A.g`. Similarly,
`ERC20PeriodTransfer` restricts a delegation to `transfer()` on a single token. Making each permission
compile to its own delegation keeps "what the owner reads" equal to "what the chain enforces".

## Three layers

1. **Routine**: the action fits a permission → the agent redeems that delegation directly.
2. **Escalation**: the action doesn't fit, isn't forbidden and is under `hardMax` → an approval request
   goes to the queue. On approval, the owner's passkey signs a **one-shot delegation** (`ExactExecution` +
   `LimitedCalls(1)` + `Timestamp(now + approvalTtlSeconds)`). The agent redeems it.
3. **Forbidden**: the action touches `forbidden.targets` or exceeds `hardMax` → denied. On-chain, the agent can't
   reach anything outside its allowlists anyway. Off-chain, phoswallet refuses to create an approval request.

## Enforcement mapping

| Rule                                          | Where         | How                                                                                                                |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `agent`                                       | on-chain      | `delegation.delegate`                                                                                              |
| `validFrom`, `expiresAt`                      | on-chain      | `TimestampEnforcer`                                                                                                |
| `nativeTransfer.recipients`                   | on-chain      | `AllowedTargetsEnforcer` + `ExactCalldataEnforcer(0x)`                                                             |
| `nativeTransfer.perTx`                        | on-chain      | `ValueLteEnforcer`                                                                                                 |
| `nativeTransfer.perPeriod`                    | on-chain      | `NativeTokenPeriodTransferEnforcer`                                                                                |
| `erc20Transfer.token` + `perPeriod`           | on-chain      | `ERC20PeriodTransferEnforcer`                                                                                      |
| `erc20Transfer.recipients`                    | on-chain      | `AllowedCalldataEnforcer` at offset 4 (one recipient; several → `LogicalOrWrapperEnforcer` or one delegation each) |
| `erc20Transfer.perTx`                         | **off-chain** | SDK pre-check → escalation (no per-tx ERC-20 enforcer exists)                                                      |
| `contractCall.target`                         | on-chain      | `AllowedTargetsEnforcer`                                                                                           |
| `contractCall.functions`                      | on-chain      | `AllowedMethodsEnforcer`                                                                                           |
| `contractCall.args` with `eq` on static types | on-chain      | `AllowedCalldataEnforcer`                                                                                          |
| `contractCall.args` other operators           | **off-chain** | SDK pre-check now; co-signer enforcer later                                                                        |
| `contractCall.value`                          | on-chain      | `ValueLteEnforcer` + `NativeTokenPeriodTransferEnforcer`                                                           |
| `escalation.*`                                | **off-chain** | SDK + policy-service queue                                                                                         |
| `forbidden.targets`                           | **off-chain** | never escalated (the on-chain allowlist already excludes them)                                                     |

**Invariant:** off-chain checks only ever _narrow_ what the on-chain delegation allows. They can refuse or
escalate, never widen. If phoswallet's services are down or compromised, the worst case is the on-chain caps.

## Deliberately not in v1

Slippage, APY, protocol-risk, anomaly rules, multi-chain grants, per-recipient sub-limits, OR-combinations of arg rules.
