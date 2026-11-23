# Policy examples

All amounts are base units as decimal strings (wei for ETH, 6 decimals for USDC). Chain is Base Sepolia (84532).
Test USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## 1. "Pay my API provider, max 1 USDC a day"

```json
{
  "version": 1,
  "chainId": 84532,
  "agent": "0xAgent",
  "expiresAt": 1795604800,
  "permissions": [
    {
      "kind": "erc20Transfer",
      "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "recipients": ["0xApiProvider"],
      "perPeriod": { "amount": "1000000", "periodSeconds": 86400 }
    }
  ]
}
```

Anything above 1 USDC/day becomes an approval request. On-chain: `ERC20PeriodTransfer` + recipient pin + `Timestamp`.

## 2. "Small ETH tips, ask me above 0.01, never above 0.1"

```json
{
  "version": 1,
  "chainId": 84532,
  "agent": "0xAgent",
  "expiresAt": 1795604800,
  "permissions": [
    {
      "kind": "nativeTransfer",
      "recipients": ["0xCreatorA", "0xCreatorB"],
      "perTx": "2000000000000000",
      "perPeriod": { "amount": "10000000000000000", "periodSeconds": 86400 }
    }
  ],
  "escalation": {
    "enabled": true,
    "approvalTtlSeconds": 1800,
    "hardMax": [{ "token": "native", "amount": "100000000000000000" }]
  }
}
```

`perTx` (0.002 ETH) and the daily 0.01 ETH are on-chain. 0.01–0.1 ETH: you're asked. Above 0.1: denied.

## 3. "May approve the router to spend USDC, nothing else"

```json
{
  "version": 1,
  "chainId": 84532,
  "agent": "0xAgent",
  "expiresAt": 1795604800,
  "permissions": [
    {
      "kind": "contractCall",
      "target": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "functions": [
        {
          "signature": "approve(address,uint256)",
          "args": [{ "index": 0, "op": "eq", "value": "0xRouter" }, { "index": 1, "op": "lte", "value": "50000000" }]
        }
      ]
    }
  ]
}
```

Spender pin = on-chain (`AllowedCalldata`). The 50 USDC cap on the amount is an **off-chain** pre-check (`lte`):
On its own it binds a well-behaved agent only; add `"cosigner": "0x…"` (the policy service's co-signer) to make it binding on-chain
([ADR 0005](decisions/0005-cosigner-enforcer.md)).

## 4. Mixed + denylist, 30 days

```json
{
  "version": 1,
  "chainId": 84532,
  "agent": "0xAgent",
  "name": "ops-bot",
  "validFrom": 1795000000,
  "expiresAt": 1797592000,
  "permissions": [
    {
      "kind": "nativeTransfer",
      "recipients": ["0xGasTank"],
      "perPeriod": { "amount": "5000000000000000", "periodSeconds": 86400 }
    },
    {
      "kind": "erc20Transfer",
      "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "recipients": ["0xVendor"],
      "perTx": "2000000",
      "perPeriod": { "amount": "10000000", "periodSeconds": 604800 }
    }
  ],
  "forbidden": { "targets": ["0xKnownScam"] }
}
```

Weekly USDC budget of 10, at most 2 per payment (both on-chain; the per-payment cap since ADR 0006). Payments to `0xKnownScam` are never
executed and never shown to you for approval.

## Limits of v1 (by design, for on-chain soundness)

- `erc20Transfer`: exactly one recipient per permission. Several would need several delegations, each with its own cap.
- `contractCall`: `eq` argument pins need a single function per permission, and static types only.
- One active grant per agent. `grantAgent` replaces (and revokes on-chain) the previous one.
