# ADR 0007: Public usage statistics

Status: accepted (2026-11-23)

## Context

A public page with usage numbers helps (Show HN, funding applications, trust), and most activity is on-chain anyway.
But the policy service also holds data that never reaches the chain (blocked attempts, rejected or expired requests,
payment reasons, agent names, forbidden lists, sign-up times, grants not used yet), and it is what links scattered
addresses into "the users of this instance". Wallet addresses count as personal data under the GDPR when they can be
linked to a person (EDPB guidelines 02/2025 on blockchain), so publishing per-account data, even on-chain-derivable,
would be new processing. With very few users, even totals describe individuals.

## Decision

- Publish **totals only**: owners, activation funnel, active accounts (7/30 days), agents with an active grant,
  payments by kind, test USDC paid, approval rate and median time to decide, payments per ISO week.
- **Threshold k = 5**: each number needs at least 5 distinct accounts behind it (people counts: the count itself;
  activity metrics: the accounts that contributed), otherwise it is withheld and shown as "fewer than 5". A week with
  fewer than 5 active accounts shows no values.
- **Never published**: addresses, pseudonyms, free text, tx hashes, blocked attempts, forbidden lists, single
  decisions.
- Static output (`index.html` + `stats.json`) written hourly by a sandboxed oneshot unit without network access,
  served by Caddy from a separate directory. No new API, no JavaScript, nothing the web app has to trust.
- Detailed reports (CSV/TXT/XLSX, pseudonymized) stay with the operator.

## Consequences

- Early on the page shows "fewer than 5" almost everywhere. That is intended and said on the page.
- The privacy policy states that only aggregated, anonymous numbers are published.
- k = 5 is a common minimum; differencing attacks across hourly snapshots are possible in principle when a count
  crosses the threshold, which is acceptable for testnet usage totals. Revisit before mainnet.
