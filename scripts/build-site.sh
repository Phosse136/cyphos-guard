#!/usr/bin/env bash
# Assembles the static cyphosguard.com site (landing page + /recover/ recovery page) and zips it.
#   scripts/build-site.sh [out.zip]     (default: dist-site/cyphosguard-site.zip)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/dist-site/cyphosguard-site.zip}
stage=$root/dist-site/stage
rm -rf "$stage" && mkdir -p "$stage/recover" "$(dirname "$out")"
pnpm --filter @cyphos-guard/recovery build >/dev/null
cp "$root"/site/{index.html,favicon.svg,theme.js,impressum.html,datenschutz.html,.htaccess} "$stage/"
cp -r "$root"/site/media "$stage/media"
cp -r "$root"/apps/recovery/dist/. "$stage/recover/"
cp "$root"/apps/recovery/public-htaccess "$stage/recover/.htaccess"
rm -f "$out"
python3 -I - "$stage" "$out" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(stage):
        for f in sorted(files):
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, stage))
print(out)
for i in zipfile.ZipFile(out).infolist():
    print(f"{i.file_size:>8}  {i.filename}")
PY
