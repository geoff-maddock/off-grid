#!/usr/bin/env bash
#
# Deploy the Off Grid static frontend (only) into a target directory — e.g. the
# `/audio` path of a separately-hosted static site.
#
# It copies just the files a browser needs (player page, web component, admin)
# and never the backend/tooling (worker/, scripts/, migrations/, data/, docs/).
#
# Usage:
#   scripts/deploy-static.sh /path/to/your-site/html/audio
#
# Then commit & push your site repo to publish.

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?Usage: deploy-static.sh <target-dir>}"

mkdir -p "$DEST/admin"

# Player page + web component
cp "$SRC/index.html"       "$DEST/index.html"
cp "$SRC/audio-player.js"  "$DEST/audio-player.js"

# Admin SPA
cp "$SRC/admin/index.html" "$SRC/admin/admin.js" "$SRC/admin/admin.css" "$SRC/admin/peaks.js" "$DEST/admin/"

# Host-specific config (your manifest URL). Gitignored in this repo; copied only
# if present. It is safe to keep in your *own* site repo — the manifest URL is
# public by nature (the player page fetches it client-side).
if [ -f "$SRC/config.local.js" ]; then
  cp "$SRC/config.local.js" "$DEST/config.local.js"
  echo "  + config.local.js"
else
  echo "  ! no config.local.js — create one in $DEST (set window.OFFGRID_MANIFEST_URL)"
fi

echo "Deployed Off Grid static frontend to: $DEST"
echo "  index.html, audio-player.js, admin/{index.html,admin.js,admin.css,peaks.js}"
echo "Next: commit & push your site repo to publish."
