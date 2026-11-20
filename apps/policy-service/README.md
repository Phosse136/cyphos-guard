# policy-service

Approval queue, grant registry and activity log (Hono + `node:sqlite`). Holds no keys.
See [ADR 0004](../../docs/decisions/0004-approval-flow.md) for the API, the auth and the trust model.

- `pnpm dev`: watch mode (`NETWORK=fork` by default; dev relay only on a real anvil node)
- Config: `POLICY_SERVICE_PORT` (8787), `APPROVER_ORIGIN` (http://localhost:3000), `POLICY_DB_PATH`, `NETWORK`, `RPC_URL` / `FORK_RPC_URL`
