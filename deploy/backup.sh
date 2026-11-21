#!/usr/bin/env bash
# Daily local backup of the cyphos-guard instances: consistent SQLite copies (VACUUM INTO, safe while running)
# and the env files (co-signer keys!). Root-only, keeps 14 days. This protects against mistakes and corruption,
# NOT against losing the disk: copy /var/backups/cyphos-guard somewhere else too.
set -euo pipefail
dest=/var/backups/cyphos-guard/$(date +%Y-%m-%d_%H%M)
umask 077
mkdir -p "$dest"
for db in /var/lib/cyphos-guard/policy-service.sqlite /var/lib/cyphos-guard/app/policy-service.sqlite; do
  [ -f "$db" ] || continue
  name=$(echo "$db" | sed 's#/var/lib/cyphos-guard/##; s#/#-#g')
  /usr/local/bin/node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec(`VACUUM INTO ${JSON.stringify(process.argv[2]).replace(/"/g, "\x27")}`);
    db.close();' "$db" "$dest/$name"
done
cp -p /etc/cyphos-guard/*env* "$dest/" 2>/dev/null || true
chmod -R go-rwx /var/backups/cyphos-guard
find /var/backups/cyphos-guard -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "backup: $dest ($(du -sh "$dest" | cut -f1))"
