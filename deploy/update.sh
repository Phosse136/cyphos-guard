#!/usr/bin/env bash
# Update the public instance in /opt/cyphos-guard to the latest commit of the working repo, rebuild, restart.
set -euo pipefail
# Source: the working repo to pull from (argument, or $CYPHOS_GUARD_SRC).
SRC=${1:-${CYPHOS_GUARD_SRC:?usage: update.sh <path-to-working-repo> (or set CYPHOS_GUARD_SRC)}}
cd /opt/cyphos-guard
git pull -q --ff-only "$SRC" main
# Offline first (reuses the local store); falls back to the registry for packages the cache lacks.
pnpm install --frozen-lockfile --offline >/dev/null 2>&1 || pnpm install --frozen-lockfile >/dev/null
set -a; . /etc/cyphos-guard/env; set +a
pnpm --filter @cyphos-guard/approver build >/dev/null
install -d -o cyphos -g cyphos apps/approver/.next/cache
UNITS="cyphos-guard-policy cyphos-guard-approver"
# Second instance (app.cyphosguard.com), if installed.
[ -f /etc/systemd/system/cyphos-guard-app-policy.service ] && UNITS="$UNITS cyphos-guard-app-policy cyphos-guard-app-approver"
systemctl restart $UNITS
sleep 5
systemctl is-active $UNITS
curl -fsS http://127.0.0.1:8887/health && echo
[ -f /etc/systemd/system/cyphos-guard-app-policy.service ] && curl -fsS http://127.0.0.1:8888/health && echo
