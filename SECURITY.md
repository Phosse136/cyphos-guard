# Security policy

cyphos-guard is a **testnet-only, unaudited** project. Please don't use it with real funds.

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub: _Security_ tab → **Report a vulnerability** (GitHub private
vulnerability reporting). Don't open a public issue for security problems.

Helpful to include: affected component (contracts, SDK, policy service, approver, recovery page, MCP server), steps to
reproduce, impact, and a suggested fix if you have one. You'll get an acknowledgement within a few days.

## Scope

- Smart contracts: `packages/contracts` (CosignerEnforcer, X402Vault)
- SDK and policy compiler: `packages/sdk`, `packages/shared`
- Policy service and approver app: `apps/policy-service`, `apps/approver`
- Recovery page: `apps/recovery`
- MCP server: `packages/mcp`

Out of scope: the third-party MetaMask Delegation Framework contracts (report to MetaMask), public testnet
infrastructure, and denial of service against the public demo instance.

## What we've already reviewed

See the [X402Vault security review](docs/security/x402-vault-review.md) and the hardening notes in
[deploy/README.md](deploy/README.md).
