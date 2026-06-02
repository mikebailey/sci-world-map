#!/usr/bin/env bash
# Flip the sci-map runtime flag back to ON, re-enabling the Mapbox
# basemap. Run this on the 1st of a new month after a quota-driven
# disable, or any time you've raised your Mapbox cap and want the
# basemap back.
#
# See bin/disable-basemap.sh for the mechanism.

set -euo pipefail

BUCKET="${SCI_R2_BUCKET:-sci-data}"
REMOTE="${SCI_R2_REMOTE:-r2}"

TMP="$(mktemp -t feature-flags.XXXXXX.json)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<EOF
{
  "disable_basemap": false,
  "reason": null,
  "state": "ok",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

rclone copyto "$TMP" "$REMOTE:$BUCKET/feature-flags.json" \
  --s3-no-check-bucket \
  --header-upload "Content-Type: application/json" \
  --header-upload "Cache-Control: public, max-age=60"

echo "Flag cleared. The page will resume serving the basemap within ~60s."
