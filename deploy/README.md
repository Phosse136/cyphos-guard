# Self-hosted public instance (testnet)

How https://app.cyphosguard.com runs (the setup supports a second instance too): one Linux machine behind a home router, Base Sepolia only.

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

Two instances share the build in `/opt/cyphos-guard` but have separate config, database, co-signer key and
ports: `cyphos-guard-*` (a second domain, 8887/3300, `/etc/cyphos-guard/env`) and `cyphos-guard-app-*`
(app.cyphosguard.com, 8888/3301, `/etc/cyphos-guard/app.env`). A passkey is bound to its domain, so each instance has
its own owner. `app.cyphosguard.com` is a CNAME to the DynDNS name.

Update: `sudo deploy/update.sh` (pulls the latest commit from the working repo, rebuilds, restarts).

Abuse protection: the policy service rate-limits per client IP (300/min), passkey sign-in (20/min per IP) and per
agent (120/min), caps request bodies at 256 KB and pending sign-ins at 10,000 (override the rates with
`RATE_LIMIT_PER_IP_PER_MIN`, `RATE_LIMIT_AUTH_PER_MIN`, `RATE_LIMIT_AGENT_PER_MIN`). The client IP comes from Caddy's
`X-Forwarded-For`, so keep the service bound to localhost. `/rpc` forwards only read-only methods (no
`eth_sendRawTransaction`), at most 600 calls/min per IP. Limits are in memory, per process.

## Notifications (Telegram, Discord, ntfy)

The policy service can message you when something happens: a new owner, an agent granted or revoked, **an approval
waiting** (with a link to the app), payments, blocked attempts, x402 API payments, plus an optional daily summary. Off
unless a channel is configured. Sends never block or break a request; at most 20 messages per minute (the rest are
summarized as "+N more").

Add to the instance's env file (`/etc/cyphos-guard/app.env`), then `systemctl restart cyphos-guard-app-policy`:

```sh
# Telegram: create a bot with @BotFather (/newbot) → token. Send your bot any message, then open
# https://api.telegram.org/bot<TOKEN>/getUpdates and copy "chat":{"id": …}.
TELEGRAM_BOT_TOKEN=123456:ABC…
TELEGRAM_CHAT_ID=123456789
# Discord: channel settings → Integrations → Webhooks → New webhook → copy URL.
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
# ntfy (free push app, https://ntfy.sh): pick a long, unguessable topic name, subscribe to it in the app.
NTFY_URL=https://ntfy.sh/cyphos-guard-<random>
# Optional: only these events (default: all), and a daily summary at this hour (server time).
NOTIFY_EVENTS=request_created,request_denied,routine_executed,x402_paid,owner_registered
NOTIFY_SUMMARY_HOUR=20
```

Messages contain the event, amounts and shortened addresses. Mention the channel in your privacy policy if other
people use your instance.

## Backups

`deploy/backup.sh` (daily via `cyphos-guard-backup.timer`, 03:30) writes consistent SQLite copies and the env files
(they hold the co-signer keys) to `/var/backups/cyphos-guard/<date>/`, root-only, 14 days kept. Install:
`cp deploy/cyphos-guard-backup.{service,timer} /etc/systemd/system/ && systemctl enable --now cyphos-guard-backup.timer`.
This is a local copy only: also copy the folder to another machine or storage.
