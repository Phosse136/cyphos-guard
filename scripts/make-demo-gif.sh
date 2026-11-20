#!/usr/bin/env bash
# Records the interactive demo in Chromium (scripted model, virtual passkey) and turns it into
# docs/assets/demo.gif. Needs ffmpeg and a prior `pnpm --filter @cyphos-guard/approver build`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
E2E_VIDEO_DIR="$work" E2E_SCREENSHOTS="$root/docs/assets" pnpm --dir "$root" --filter @cyphos-guard/approver e2e:demo
video="$(ls "$work"/*.webm | head -1)"
# 2x speed, 8 fps, 760 px wide, palette-optimised GIF
ffmpeg -loglevel error -y -i "$video" -vf "setpts=0.5*PTS,fps=8,scale=760:-1:flags=lanczos,palettegen=stats_mode=diff" "$work/palette.png"
ffmpeg -loglevel error -y -i "$video" -i "$work/palette.png" \
  -lavfi "setpts=0.5*PTS,fps=8,scale=760:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" \
  "$root/docs/assets/demo.gif"
rm -f "$root/docs/assets/demo-failure.png" "$root/docs/assets/demo-transcript.txt" "$root/docs/assets/demo-1-grant-prefilled.png" # keep only what the README uses
ls -la "$root/docs/assets"
