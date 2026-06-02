# Claude context for sci-map

Standalone, embeddable build of the SCI viz. Extracted from
`mikebailey/mikebailey.github.io` on 2026-06-02 so other sites can fork
+ host their own under their own Mapbox/R2 quotas, and so collaborators
can work on the viz without needing Jekyll auth on the personal site.

## What lives where

| Concern | Location |
|---------|----------|
| **Page code** | `index.html`, `css/style.css`, `js/main.js`, `js/csv2geojson.js` — no build step, plain static. |
| **Adopter-configurable values** | `js/config.js`. Only file a fork should need to edit. Loaded by index.html **before** main.js. |
| **Bundled CSV + GeoJSON for levels 0–2** | `data/`. ~5 MB total. Countries, EU NUTS2, US states. |
| **R2-hosted GADM2 SCI data (level 3)** | NOT in the repo. Lives at `https://pub-5433ddd592ff4ca4829ed8c8b77d58d6.r2.dev/gadm2_v2/<GID_2>.json.gz` × 37k + `gadm2_world_v5.geojson` (the boundary). Bucket `sci-data` on Mike's Cloudflare. |
| **ETL that produced the R2 data** | `etl/etl_v3.py` (DuckDB + orjson + multiprocess), `etl/_meta.json` (bin thresholds), `etl/README.md` (line-by-line walkthrough). |
| **Cost-control kill switches** | `bin/disable-basemap.sh` / `bin/enable-basemap.sh`. Write `feature-flags.json` to R2 via rclone; index.html fetches the flag on each load and skips Mapbox when `disable_basemap: true`. |
| **Personal site mirror** | `mikebailey/mikebailey.github.io/sci-map/`. Sync from this repo via `mikebailey.github.io/sci-map/sync-from-canonical.sh`. |

## Important invariants — do NOT break

- **Mapbox token + R2 URLs live in `js/config.js` only.** `main.js` reads
  `window.SCI_CONFIG.*`. Don't hardcode either in `main.js` even
  "temporarily"; the personal-site mirror depends on the split.
- **Per-source R2 JSONs must be uploaded with both `Content-Type:
  application/json` AND `Content-Encoding: gzip`.** Without the second
  header, R2 serves raw gzip bytes and `await resp.json()` chokes on the
  magic bytes (`SyntaxError: Unexpected token`). Affects every script
  under `bin/` and `etl/` that uploads to R2.
- **`feature-flags.json` is read before `js/main.js` loads** (the inline
  `<script>` in `index.html` fetches it then injects the main script
  tag). If you move the flag fetch into main.js you reintroduce the race
  where the map is created with Mapbox style *before* the flag can disable
  it — defeating the whole point of layer #3.
- **There is no Mapbox usage API** despite what the earlier worker/
  attempt assumed. Don't try to re-build the auto-monitoring worker that
  was removed in commit 2d999ff. Mapbox's only out-of-band signal is the
  automatic "free tier exceeded" email, which is the user's trigger to
  run `bin/disable-basemap.sh`.

## Cost-control layers (the three-tier kill-switch)

1. `SCI_CONFIG.DISABLE_BASEMAP = true` → manual config flag, requires
   redeploy. Used for testing the no-basemap look locally.
2. In-browser `error` event listener catches Mapbox 401/403/429 →
   sessionStorage flag + reload into empty style. Per-user, per-session.
3. `r2:sci-data/feature-flags.json` → fetched by every page load before
   main.js. When `disable_basemap: true`, page uses empty style from
   start. Propagates to all users within ~60s. Written by `bin/*.sh`.

Any one of the three is enough to switch the page into no-basemap mode;
they OR together at the top of main.js.

## ETL recap

Run from `/tmp/sci-v3/` after dropping `etl/_meta.json` into
`out_v2/_meta.json`. ~20 min wall clock, peak RAM ~6 GB, disk spill
~35 GB. Produces 37,160 gzipped per-source JSONs of shape
`{ref, a, b, top}` where `a`/`b` are bin maps under two threshold sets
(only `a` is currently used by the UI; `b` is shipped for a hidden
"Even bins" toggle). `top` is precomputed top-20 friends by raw SCI so
the UI doesn't have to sort 37k entries client-side.

Upload to R2 with **both** `Content-Type: application/json` and
`Content-Encoding: gzip` rclone header flags. See `etl/README.md`.

## Personal site sync

The Jekyll-served copy at `michaelbailey.org/sci-map/` is a mirror, not
the source. To update it, run `sync-from-canonical.sh` from the
personal-website repo (it rsyncs from `../sci-map/` and re-stitches the
Jekyll frontmatter, back-link, and #site-back CSS). Treat the canonical
repo (this one) as the source of truth for everything except the
back-link and the Jekyll frontmatter.
