# Contributing to cyphos-guard

Thanks for helping. cyphos-guard moves (test) money on behalf of AI agents, so the bar is "boring and verifiable".

## Ground rules

- **Testnet only.** Base Sepolia (84532) and Sepolia (11155111). No mainnet chain ids, RPCs or addresses anywhere:
  code, tests, docs examples. The policy schema rejects mainnet ids; keep it that way.
- **Non-custodial.** cyphos-guard services never hold a key that can move funds, and off-chain checks may only
  refuse or escalate, never widen what the on-chain delegation allows.
- **No secrets in git.** `.env` is ignored; every variable goes in `.env.example`. The pre-commit hook
  (`scripts/check-secrets.sh` + gitleaks) must stay on. Don't use `--no-verify`.
- **Don't reinvent wallets.** Use the MetaMask Delegation Framework's audited enforcers. New Solidity needs an
  ADR and Foundry tests.
- **Verify APIs, don't recall them.** Crypto libraries move fast. Read the installed package's types/source or the
  current docs before coding against them.

The full list of project rules lives in [CLAUDE.md](CLAUDE.md) (it doubles as the brief for AI coding assistants).

## Setup

Node ≥ 24 (`.nvmrc` pins 26), pnpm 12, [Foundry](https://getfoundry.sh) for anvil, Chromium or Chrome for the browser tests.

```sh
pnpm install          # also enables the pre-commit secret check
pnpm dev              # local fork + policy service + approver on http://localhost:3000
```

## Checks (CI runs all of them)

| Command                                                     | What                                            | Needs          |
| ----------------------------------------------------------- | ----------------------------------------------- | -------------- |
| `pnpm lint` · `pnpm typecheck` · `pnpm test`                | Biome, tsc, Vitest unit tests                   | nothing        |
| `pnpm contracts:test`                                       | Foundry tests                                   | Foundry        |
| `pnpm test:fork`                                            | SDK integration tests on a Base Sepolia fork    | anvil, network |
| `pnpm poc` · `pnpm e2e` · `pnpm demo:selftest --fake-model` | end-to-end flows on a fork                      | anvil, network |
| `pnpm e2e:browser` · `pnpm e2e:demo`                        | the approver in Chromium with a virtual passkey | + Chromium     |

Fork tests start anvil themselves if nothing listens on `127.0.0.1:8545`.

## Pull requests

- Small, focused commits; describe _why_. Security-relevant changes say what an attacker could and couldn't do before and after.
- New behavior comes with a test. Anything that touches what gets signed or enforced on-chain gets a fork test
  that shows the chain rejecting the bad case, not just the SDK.
- Non-obvious account-abstraction or delegation decisions get a short comment or an ADR in `docs/decisions/`.
- If a library doesn't behave as documented, show the evidence and propose an alternative instead of hacking around it.

## Where things are

`packages/shared` (policy schema, API types) · `packages/sdk` (compiler, `createCyphosGuard`, typed errors) ·
`packages/contracts` (Foundry: CosignerEnforcer, ERC20PerTransferCapEnforcer, X402Vault) · `packages/mcp` (MCP server) · `packages/cli` (agent keys) ·
`apps/policy-service` (Hono + SQLite) · `apps/approver` (Next.js) · `apps/recovery` (static recovery page) ·
`examples/poc`, `examples/demo-agent`, `examples/x402-seller` · `deploy/` (public instance) · `site/` (landing page) ·
`docs/decisions` (ADRs).

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
