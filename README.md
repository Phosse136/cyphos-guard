# phoswallet

**Fireblocks-grade guardrails for AI agents, for indie devs and small teams. Open source, self-serve, cheap.**

> Status: Phase 1 (proof of concept). Testnet only (Base Sepolia). Not for real funds.

AI agents increasingly need to spend money on-chain: pay for APIs, swap, rebalance. Today you either hand the agent
a private key (full risk) or approve every transaction yourself (and the agent is pointless).

phoswallet gives an agent **scoped, revocable permissions** on your smart account, in three layers:

| Layer              | Example                                 | What happens                                                                                               |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Routine**        | Pay ≤ 1 USDC/day to the API provider    | The agent acts alone. Limits are enforced on-chain                                                         |
| **Big or unusual** | Pay 25 USDC, or a new recipient         | You get an approval request and approve with a **passkey** (Face ID, fingerprint, YubiKey). No seed phrase |
| **Forbidden**      | Anything touching a denylisted contract | Impossible for the agent. Never offered for approval                                                       |

## How it works

- Your account is a **MetaMask Hybrid smart account** (Delegation Framework, audited) owned by your passkey, with an
  EOA recovery key you keep.
- A grant is a set of **delegations** to the agent's key, each with on-chain caveats: per-tx and per-day limits,
  allowed recipients/contracts/functions, expiry.
- The agent redeems delegations with ordinary transactions. It needs no bundler and can't drain your account through gas.
- When the agent needs more, the SDK files an approval request. You approve with your passkey, which signs a
  **one-shot delegation** for exactly that call, valid for minutes.
- **Hybrid enforcement:** hard caps on-chain are the safety floor. The off-chain policy service can only _block or
  escalate_. It never holds keys and can never move funds. You can revoke on-chain without phoswallet.

Design records: [ADR 0001: account stack](docs/decisions/0001-account-stack.md) ·
[ADR 0002: policy schema](docs/decisions/0002-policy-schema.md)

## Run the PoC in 5 minutes

Requirements: Node ≥ 24, pnpm 12, [Foundry](https://getfoundry.sh) (for `anvil`).

```sh
pnpm install
pnpm poc            # local fork of Base Sepolia: no faucet, no API key
```

The script spawns an anvil fork of Base Sepolia (real MetaMask Delegation Framework contracts) and generates
throwaway keys into `.env`. Then it:

1. Deploys a Hybrid smart account for the owner and funds it.
2. Grants the agent **max 0.001 ETH per day, only to one address, for 7 days** (one signed delegation, no gas).
3. Agent: sends 0.0005 ✔ · sends 0.0006 more (over the daily cap) ✘ · pays a stranger ✘ · smuggles calldata ✘.
   Rejections are broadcast anyway, so you see reverted txs with the enforcer's reason.
4. Fast-forwards one day: the allowance resets and 0.0006 ✔ (fork only).
5. Owner revokes on-chain. The agent's next send ✘ `CannotUseADisabledDelegation()`.

It's self-checking: it exits non-zero if anything that must be rejected gets through.

**On real Base Sepolia** (explorer links): `NETWORK=live pnpm poc`. The first run prints the owner address. Send it
~0.003 test ETH from a faucet ([Coinbase](https://portal.cdp.coinbase.com/products/faucet),
[Superchain](https://console.optimism.io/faucet)) and run again.

How the pieces fit: [ADR 0003: owner actions without a bundler](docs/decisions/0003-owner-actions-without-bundler.md) ·
[passkey path (Phase 2)](docs/passkey-path.md)

## Repo layout

```
apps/approver         Next.js owner app: passkey approvals, activity, revoke
apps/policy-service   approval queue API (later: block-only co-signer)
packages/sdk          @phoswallet/sdk
packages/shared       policy schema (zod), shared types
packages/contracts    Foundry, only if we need a custom enforcer
examples/poc          Phase 1 testnet scripts
examples/demo-agent   Claude tool-calling demo agent
docs/decisions        ADRs
```

## Development

Requirements: Node ≥ 24 (see `.nvmrc`), pnpm 12, Foundry (from Phase 1, only if contracts are needed).

```sh
npm install -g pnpm@12.21.0   # Node ≥ 25 no longer bundles corepack
pnpm install        # also enables the pre-commit secret check
pnpm lint && pnpm typecheck && pnpm test
cp .env.example .env
```

## Security

Testnet only. Never put a key that has held real funds into `.env`. Commits are scanned for keys by
`scripts/check-secrets.sh` (and gitleaks, if installed).

## License

To be decided in Phase 5 (MIT or Apache-2.0).
