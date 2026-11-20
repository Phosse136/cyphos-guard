#!/usr/bin/env bash
# Update the public instance in /opt/cyphos-guard to the latest commit of the working repo, rebuild, restart.
set -euo pipefail
SRC=${1:-/home/PHILCLAUDE/cyphos-guard}
cd /opt/cyphos-guard
git pull -q --ff-only "$SRC" main
pnpm install --frozen-lockfile --offline >/dev/null
set -a; . /etc/cyphos-guard/env; set +a
pnpm --filter @cyphos-guard/approver build >/dev/null
install -d -o cyphos -g cyphos apps/approver/.next/cache
systemctl restart cyphos-guard-policy cyphos-guard-approver
sleep 5
systemctl is-active cyphos-guard-policy cyphos-guard-approver
curl -fsS http://127.0.0.1:8887/health && echo
