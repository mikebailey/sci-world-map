#!/usr/bin/env bash
# Flip the sci-map runtime flag to disable the Mapbox basemap.
#
# When to run this: you got a Mapbox billing alert that you're at/over
# your monthly spend cap and you want the page to stop calling Mapbox
# for the rest of the month. Re-enable with bin/enable-basemap.sh on
# the 1st of next month (or whenever you raise the cap).
#
# Mechanism: writes feature-flags.json to your R2 bucket. The page
# reads this file on every load (~60s edge cache TTL) and decides
# whether to skip the basemap.
#
# Requires rclone with an [r2] remote configured for the sci-data
# bucket. See README.md → "Step 2b: Create an R2 API token for
# uploads".

set -euo pipefail

BUCKET="${SCI_R2_BUCKET:-sci-data}"
REMOTE="${SCI_R2_REMOTE:-r2}"
REASON="${1:-manual:billing_cap_hit}"

TMP="$(mktemp -t feature-flags.XXXXXX.json)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<EOF
{
  "disable_basemap": true,
  "reason": "$REASON",
  "state": "critical",
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

rclone copyto "$TMP" "$REMOTE:$BUCKET/feature-flags.json" \
  --s3-no-check-bucket \
  --header-upload "Content-Type: application/json" \
  --header-upload "Cache-Control: public, max-age=60"

echo "Flag set. The page will pick up the new state within ~60s."
echo "Inspect: rclone cat $REMOTE:$BUCKET/feature-flags.json --s3-no-check-bucket"
