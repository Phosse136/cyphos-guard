# Self-hosted public instance (testnet)

How https://guard.cyphos.de runs: one Linux machine behind a home router, Base Sepolia only.

- Router forwards **only port 443** to the machine; DNS for the subdomain is kept current by the router's DynDNS.
- **Caddy** terminates HTTPS (Let's Encrypt via TLS-ALPN-01, so port 80 need not be reachable) and proxies to
  the approver on `127.0.0.1:3300`. The approver proxies `/api` to the policy service on `127.0.0.1:8887`.
- Both run as the unprivileged `cyphos` user under systemd with a read-only filesystem except their data dirs.
- Config lives in `/etc/cyphos-guard/env` (mode 640, root:cyphos), see `env.example`. It holds the co-signer key
  (can only _block_ agent redemptions, never move funds) and `OWNER_SETUP_CODE`.
- **Owner setup code:** on a public address the first visitor could otherwise register as owner. With
  `OWNER_SETUP_CODE` set, registration requires it; after the owner exists, registration is closed for good.

Install: clone to `/opt/cyphos-guard`, `pnpm install`, build the approver with the env loaded, copy the two
`.service` files to `/etc/systemd/system/` and `Caddyfile` to `/etc/caddy/`, then
`systemctl enable --now cyphos-guard-policy cyphos-guard-approver caddy`.

Update: `sudo deploy/update.sh` (pulls the latest commit from the working repo, rebuilds, restarts).

Known limits (fine for a testnet demo, fix before anything more): no rate limiting on the policy service, and
`/rpc` forwards any JSON-RPC call to the public Base Sepolia RPC.
