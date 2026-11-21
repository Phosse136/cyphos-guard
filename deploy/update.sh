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
# Restart only the instances that are enabled (a retired instance stays down).
UNITS=""
for u in cyphos-guard-policy cyphos-guard-approver cyphos-guard-app-policy cyphos-guard-app-approver; do
  systemctl is-enabled --quiet "$u" 2>/dev/null && UNITS="$UNITS $u"
done
systemctl restart $UNITS
sleep 5
systemctl is-active $UNITS
systemctl is-enabled --quiet cyphos-guard-policy 2>/dev/null && curl -fsS http://127.0.0.1:8887/health && echo
systemctl is-enabled --quiet cyphos-guard-app-policy 2>/dev/null && curl -fsS http://127.0.0.1:8888/health && echo
true
