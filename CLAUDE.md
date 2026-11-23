# CLAUDE.md: cyphos-guard project rules

Guardrails + human approval for AI agents with crypto wallets. Stack decision: `docs/decisions/0001-account-stack.md`
(MetaMask Smart Accounts Kit / Delegation Framework, Hybrid DeleGator with passkeys). Policy schema:
`docs/decisions/0002-policy-schema.md`, `packages/shared/src/policy.ts`.

## Non-negotiable

- **Testnet only.** Base Sepolia (84532) default, Ethereum Sepolia (11155111) fallback. No mainnet chain ids, RPCs,
  or deployment addresses anywhere: config, code, tests, docs examples. The policy schema rejects mainnet ids. Keep it that way.
- **Non-custodial.** cyphos-guard services never hold an owner key and never gain authority to move funds. The off-chain
  policy service/co-signer may only _refuse or escalate_. It must never widen on-chain permissions. The owner must
  always be able to revoke (`DelegationManager.disableDelegation`) without cyphos-guard.
- **No secrets in git.** Secrets live in `.env` (git-ignored); document every variable in `.env.example`. Test keys are
  generated locally and are throwaway. Never ask the user for a real private key or seed phrase. The pre-commit
  hook (`scripts/check-secrets.sh`, enabled via `core.hooksPath=.githooks`) must stay on. Don't bypass it with `--no-verify`.
- **Don't reinvent wallets.** Use the Delegation Framework's audited enforcers. Write Solidity only when no enforcer
  exists (as with `CosignerEnforcer`, ADR 0005), with Foundry tests and an ADR.
- **Verify current APIs before coding against them.** Read the installed package's types/README/source
  (`node_modules/...`) or current docs. Do not rely on memory for crypto libraries.
- Keep it simple: no token, no DAO, no speculative abstractions.

## Security rules for policy → delegation compilation

- One permission = one delegation (targets × methods is a cross-product on-chain).
- Never emit a delegation without caveats. Every delegation gets `Timestamp`. Value-moving ones get a period cap.
- `NativeTokenPeriodTransfer` limits only value. Always pair it with target/calldata caveats.
- Approvals are one-shot delegations: `ExactExecution` + `LimitedCalls(1)` + short `Timestamp`.
- The approver builds what the passkey signs from the raw fields it displays, client-side. Never sign server-built data.
- Hybrid passkey `keyId` must be the same string at deploy and sign time (`passkeyKeyId()`).
- Dev-only endpoints (`/dev/relay`, `/dev/fund`) must stay gated on a real anvil node.
- Off-chain rules (ERC-20 per-tx, non-eq args) do NOT bind a compromised agent unless the policy has `cosigner` (ADR 0005).
- `packages/contracts`: Foundry on Delegation Framework v1.3.0 (submodule). After changing Solidity run `pnpm contracts:build`
  (regenerates `generated/`, changes the CREATE2 address) and `pnpm contracts:test`. Never deploy to mainnet.
- Writes must go through the same node as reads (SDK `writeTransport`). Never let a client fall back to a default RPC.
- One active grant per (account, agent): re-grant = revoke on-chain first.
- Demo agent: Claude API via the SDK tool runner (`claude-opus-5-5`, `fallbacks: "default"`). The scripted `--fake-model` is a test double; never present its output as Claude's.
- Activity is recorded from the chain (decoded redemption tx + delegator), never from agent claims.
- Next.js bakes `rewrites()` destinations into the build: never route network targets through rewrites. The approver
  proxies `/api` and `/rpc` with route handlers that read `lib/upstream.ts` at request time.
- MCP server (`packages/mcp`): stdout is the protocol channel, so log to stderr only. Tool results must never contain keys.
- Services bind to localhost. The approver proxies `/api` to the policy service.
- Flag anything that could put funds at risk, even on testnet.

## Working agreement

- Work in phases. Stop after each phase for review. Short plan before each phase.
- Small, focused commits. Never push unless asked.
- Non-obvious AA/crypto decisions get a short comment or an ADR in `docs/decisions/`.
- If a library doesn't behave as documented: show the evidence, propose an alternative, don't hack around it.

## Project status

Phases 0-5 done (see README). License Apache-2.0. CI: `.github/workflows/ci.yml` (checks job offline; fork job runs
fork/e2e/browser suites with the runner's Chrome via `CHROMIUM_PATH`). Public testnet instance: app.cyphosguard.com
(`deploy/`), landing page cyphosguard.com (`site/`, built with `scripts/build-site.sh`; `site/theme.js` is the light/dark
switch shared with the app, /recover and /stats), public anonymous stats at app.cyphosguard.com/stats (ADR 0007,
`apps/policy-service/src/reports/public.ts`). npm: contracts 0.2.0, shared 0.1.1, sdk 0.2.0, mcp 0.1.2, cli 0.1.0
(`docs/releasing.md`). Security checks: `docs/security/verification.md` (red-team catalog
`packages/sdk/src/testing/attacks.ts`, run on a fork in CI and hourly live by `apps/canary`; `pnpm contracts:verify` =
Slither + Halmos + mutation test, tools in a venv). A new attack idea goes into the catalog first. When shipping something user-visible, add a line to "What's new" in `site/index.html`.
The README/landing demo video and GIF come from `apps/approver/e2e/promo/promo-video.ts`.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm test` · `pnpm check-secrets`
- `pnpm poc` (Phase 1) · `pnpm dev` (fork + service + approver) · `pnpm e2e` · `pnpm e2e:browser` · `pnpm test:fork` · `pnpm demo:setup|demo:agent|demo:selftest [--fake-model]` · `pnpm e2e:demo` · `pnpm --filter @cyphos-guard/poc spike:passkey`
- Node ≥ 24 (Vitest 5 needs ≥ 22.12), pnpm 12, TypeScript 7, Biome 2, Vitest 5, zod 4, viem 2, Foundry 1.10 (anvil for local forks), gitleaks.
- Local fork: `anvil --fork-url https://sepolia.base.org` has the MetaMask v1.3.0 contracts and the RIP-7212 precompile (verified).

## Layout

`apps/approver` (Next.js), `apps/policy-service` (queue API), `apps/recovery` (static recovery page), `apps/canary` (live red team), `packages/shared`
(schema, types), `packages/sdk`, `packages/contracts` (Foundry: CosignerEnforcer, ERC20PerTransferCapEnforcer, X402Vault), `packages/mcp`,
`packages/cli`, `examples/poc`, `examples/demo-agent`, `examples/x402-seller`, `deploy/`, `site/`, `docs/decisions` (ADRs).
