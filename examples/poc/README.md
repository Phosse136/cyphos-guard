# poc

Phase 1 proof of concept. Run from the repo root: `pnpm poc` (fork) or `NETWORK=live pnpm poc`.
See the root README, section "Run the PoC in 5 minutes".

- `src/keys.ts`: generates throwaway owner/agent keys into `.env` (never printed)
- `src/poc.ts`: the end-to-end, self-checking flow
