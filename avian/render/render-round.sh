#!/usr/bin/env bash
# Renders the round, transparent bird collage that the phone widget and watch
# tile show: the kiosk page in shape=round / bg=none mode, screenshotted by
# headless Chromium. Run every 15 minutes by birdnet-render.timer.
#
#   render-round.sh [OUT_PNG] [EXTRA_QUERY]
#
# Writes to a temp file and renames it into place, so Caddy never serves a
# half-written PNG; on any failure the previous render stays.
set -euo pipefail

OUT="${1:-$HOME/BirdSongs/Extracted/tile/birds-round.png}"
EXTRA="${2:-}"
# A hung Chromium must not wedge the oneshot unit: the timer only re-fires once
# the last run has finished.
RENDER_TIMEOUT="${RENDER_TIMEOUT:-60}"
URL="http://localhost/?kiosk=1&shape=round&bg=none&theme=dark&hours=12${EXTRA:+&$EXTRA}"

mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp "$(dirname "$OUT")/.render.XXXXXX.png")"
trap 'rm -f "$tmp"' EXIT

start=$(date +%s)
# The background colour must be hex RGBA: Chromium rejects a bare 0. The page
# lays out at 800 CSS px but is captured at 2x (1600 px), so a full-width phone
# widget stays sharp; the phone downscales its copy for the watch.
timeout "$RENDER_TIMEOUT" chromium-headless-shell --screenshot="$tmp" --window-size=800,800 \
  --force-device-scale-factor=2 \
  --default-background-color=00000000 --hide-scrollbars --virtual-time-budget=8000 \
  "$URL" >/dev/null 2>&1

# A PNG signature, or keep the old render.
[ "$(head -c 8 "$tmp" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] \
  || { echo "render failed: not a PNG" >&2; exit 1; }

chmod 644 "$tmp"   # mktemp makes it 0600; Caddy runs as its own user
mv -f "$tmp" "$OUT"
echo "rendered $OUT in $(( $(date +%s) - start ))s ($(stat -c %s "$OUT") bytes)"
