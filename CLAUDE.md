# CLAUDE.md: phoswallet project rules

Guardrails + human approval for AI agents with crypto wallets. Stack decision: `docs/decisions/0001-account-stack.md`
(MetaMask Smart Accounts Kit / Delegation Framework, Hybrid DeleGator with passkeys). Policy schema:
`docs/decisions/0002-policy-schema.md`, `packages/shared/src/policy.ts`.

## Non-negotiable

- **Testnet only.** Base Sepolia (84532) default, Ethereum Sepolia (11155111) fallback. No mainnet chain ids, RPCs,
  or deployment addresses anywhere: config, code, tests, docs examples. The policy schema rejects mainnet ids. Keep it that way.
- **Non-custodial.** phoswallet services never hold an owner key and never gain authority to move funds. The off-chain
  policy service/co-signer may only _refuse or escalate_. It must never widen on-chain permissions. The owner must
  always be able to revoke (`DelegationManager.disableDelegation`) without phoswallet.
- **No secrets in git.** Secrets live in `.env` (git-ignored); document every variable in `.env.example`. Test keys are
  generated locally and are throwaway. Never ask the user for a real private key or seed phrase. The pre-commit
  hook (`scripts/check-secrets.sh`, enabled via `core.hooksPath=.githooks`) must stay on. Don't bypass it with `--no-verify`.
- **Don't reinvent wallets.** Use the Delegation Framework's audited enforcers. Write Solidity only when no enforcer
  exists (e.g. a future `CosignerEnforcer`), with Foundry tests and an ADR.
- **Verify current APIs before coding against them.** Read the installed package's types/README/source
  (`node_modules/...`) or current docs. Do not rely on memory for crypto libraries.
- Keep it simple: no token, no DAO, no speculative abstractions.

## Security rules for policy → delegation compilation

- One permission = one delegation (targets × methods is a cross-product on-chain).
- Never emit a delegation without caveats. Every delegation gets `Timestamp`. Value-moving ones get a period cap.
- `NativeTokenPeriodTransfer` limits only value. Always pair it with target/calldata caveats.
- Approvals are one-shot delegations: `ExactExecution` + `LimitedCalls(1)` + short `Timestamp`.
- Flag anything that could put funds at risk, even on testnet.

## Working agreement

- Work in phases. Stop after each phase for review. Short plan before each phase.
- Small, focused commits. Never push unless asked.
- Non-obvious AA/crypto decisions get a short comment or an ADR in `docs/decisions/`.
- If a library doesn't behave as documented: show the evidence, propose an alternative, don't hack around it.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm test` · `pnpm check-secrets`
- Node ≥ 24 (Vitest 5 needs ≥ 22.12), pnpm 12, TypeScript 7, Biome 2, Vitest 5, zod 4, viem 2.

## Layout

`apps/approver` (Next.js), `apps/policy-service` (queue API), `packages/shared` (schema, types), `packages/sdk`,
`packages/contracts` (Foundry, only if needed), `examples/poc`, `examples/demo-agent`, `docs/decisions` (ADRs).
