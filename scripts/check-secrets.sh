#!/usr/bin/env bash
# Blocks commits that contain likely private keys, seed phrases or API keys.
# Usage: check-secrets.sh          -> scan staged content (pre-commit)
#        check-secrets.sh --all    -> scan all tracked files
# A line can be allowlisted with the marker "allow-secret" (use sparingly, e.g. a public tx hash in code).
# If gitleaks is installed it runs as well (defence in depth).
set -euo pipefail

PATTERNS=(
  '0x[0-9a-fA-F]{64}([^0-9a-fA-F]|$)'                                                       # raw 32-byte hex: private key (or hash)
  '(PRIVATE_KEY|MNEMONIC|SEED|API_KEY|SECRET)[A-Z_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_-]{16,}["'"'"']?[[:space:]]*$'
  'sk-ant-[A-Za-z0-9_-]{20,}'                                                                # Anthropic key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '["'"'"']([a-z]{3,8} ){11,23}[a-z]{3,8}["'"'"']'                                           # 12-24 word phrase in quotes
)
# Markdown may contain explorer tx hashes; lockfiles contain hashes.
SKIP_RE='(\.md$|\.(png|gif|jpe?g|webp|ico|pdf)$|pnpm-lock\.yaml$|^scripts/check-secrets\.sh$)' # images: gitleaks still scans them

if [[ "${1:-}" == "--all" ]]; then
  mapfile -t files < <(git ls-files)
  show() { cat -- "$1"; }
else
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
  show() { git show ":$1"; }
fi

found=0
for f in "${files[@]}"; do
  [[ -z "$f" || "$f" =~ $SKIP_RE ]] && continue
  [[ "$f" == ".env.example" ]] || [[ ! "$(basename "$f")" =~ ^\.env ]] || { echo "BLOCKED: $f (env files must not be committed)"; found=1; continue; }
  content="$(show "$f" 2>/dev/null)" || continue
  for p in "${PATTERNS[@]}"; do
    if hits=$(grep -nE -- "$p" <<<"$content" | grep -v 'allow-secret'); then
      echo "BLOCKED: possible secret in $f"; echo "$hits" | cut -c1-140 | sed 's/^/    /'; found=1
    fi
  done
done

if command -v gitleaks >/dev/null 2>&1; then
  if [[ "${1:-}" == "--all" ]]; then gitleaks git --no-banner --redact . || found=1
  else gitleaks git --staged --no-banner --redact . || found=1; fi
fi

if [[ $found -ne 0 ]]; then
  echo; echo "Commit blocked by scripts/check-secrets.sh. Remove the secret (use .env), or mark a false positive with 'allow-secret'."
  exit 1
fi
