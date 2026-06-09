# Claude context for sci-map

Standalone, embeddable build of the SCI viz. Extracted from
`mikebailey/mikebailey.github.io` on 2026-06-02 so other sites can fork
+ host their own under their own Mapbox/R2 quotas, and so collaborators
can work on the viz without needing Jekyll auth on the personal site.

**Now a downstream fork of the upstream Interactive Explorer**
(`social-connectedness-index/social-connectedness-index/web/src/explore/`,
deployed at [social-connectedness.org/explore](https://social-connectedness.org/explore)).
Re-integrated 2026-06-09 to track the collaborator's code. Future upstream
pulls should re-apply this fork's customizations (listed below) — they're
small and concentrated.

## What lives where

| Concern | Location |
|---------|----------|
| **Page code** | `index.html`, `css/style.css`, `js/main.js` — no build step, plain static. `js/main.js` carries a header comment listing every customization vs upstream. |
| **Adopter-configurable values** | `js/config.js`. Only file a fork should need to edit. Loaded by index.html **before** main.js. |
| **Bundled US-states data** | `data/geo/us_states.geojson` + `data/sci/us_states/<GID_1>.json` × 153 + `data/sci/us_states/sources.json`. Only level not fetched from the upstream collaborator deploy. |
| **US-states ETL** | `etl/build_us_states.py` — converts `data/us_states.csv` (long form: `user_country,friend_country,user_region,friend_region,scaled_sci`) into the upstream per-source JSON shape. Idempotent: if `data/us_states.geojson` (the GADM4.1 input) has already been consumed, the geojson step is skipped and only the SCI JSONs + `sources.json` regenerate. |
| **Countries + Regions (GADM best) data** | NOT in repo. Fetched live from `https://social-connectedness.org/data/...` (the collaborator's R-export pipeline). CORS open. |
| **Legacy GADM2 ETL** | `etl/etl_v3.py` (DuckDB + orjson + multiprocess), `etl/_meta.json`, `etl/README.md`. Produced the per-source pre-binned JSONs at `r2:sci-data/gadm2_v2/*` that this app used to read. **Obsolete since the 2026-06-09 integration** — Regions data now comes from social-connectedness.org instead. Kept around for reference / quick fallback, but not exercised. |
| **Cost-control kill switches** | `bin/disable-basemap.sh` / `bin/enable-basemap.sh`. Write `feature-flags.json` to R2 via rclone; index.html fetches the flag on each load and skips Mapbox when `disable_basemap: true`. Still active — Mapbox is the only remaining cost lever. |
| **Personal site mirror** | `mikebailey/mikebailey.github.io/sci-map/`. Sync from this repo via `mikebailey.github.io/sci-map/sync-from-canonical.sh`. |

## Customizations vs upstream Explorer

Track these when pulling new upstream changes — they're the diff between
canonical and `web/src/explore/`.

1. **Third level: US states (GADM1).** Bundled in `data/`. The upstream Explorer
   ships only Countries + Regions. See `LEVELS.level1` in `main.js` and
   `etl/build_us_states.py`.
2. **Globe / Flat projection toggle.** Upstream hardcodes globe. See
   `applyProjection()` + `FLAT_PROJECTION_BY_LEVEL` in `main.js` and
   `.projection-container` in `style.css`. Flat picks `naturalEarth` for the
   world layers and `albers` for US states.
3. **Top-10 visible inline by default, with a toggle button.** Upstream hides
   the list behind a modal popup. See `#top-connections-toggle` (the button) +
   the inline `#top-10-container` in `index.html`, and the toggle wiring at
   the bottom of `main.js`.
4. **GADM-level suffix on Regions hover + title.** `gadmLevelFromId()` in
   `main.js` parses the dot count in the GADM key (e.g. `DEU.1.10_1` → GADM2)
   and the regions level renders `(GADM<n>)` in the tooltip and panel title.
   `LEVELS.level2.showGadmLevel = true` gates this.
5. **R2 runtime feature-flag pre-fetch (cost-control layer #3).** Upstream
   only has layers #1 (config flag) and #2 (on-error fallback). See the inline
   `<script>` in `index.html` that fetches `feature-flags.json` from R2 before
   `main.js` loads.
6. **Sources file rename for US states** — `sources.json` instead of
   `_sources.json` (underscore-prefixed files are stripped by Jekyll's default
   exclude filter on the personal-site mirror). Upstream-fetched levels still
   use the upstream `_sources.json` name; only `LEVELS.level1.sourcesPath`
   overrides it.

## Important invariants — do NOT break

- **Mapbox token + R2 URLs live in `js/config.js` only.** `main.js` reads
  `window.SCI_CONFIG.*`. Don't hardcode either in `main.js` even
  "temporarily"; the personal-site mirror depends on the split.
- **`feature-flags.json` is read before `js/main.js` loads** (the inline
  `<script>` in `index.html` fetches it then injects the main script
  tag). If you move the flag fetch into main.js you reintroduce the race
  where the map is created with Mapbox style *before* the flag can disable
  it — defeating the whole point of cost-control layer #3.
- **There is no Mapbox usage API** despite what the earlier worker/
  attempt assumed. Don't try to re-build the auto-monitoring worker that
  was removed in commit `2d999ff`. Mapbox's only out-of-band signal is the
  automatic "free tier exceeded" email, which is the user's trigger to
  run `bin/disable-basemap.sh`.
- **GitHub secret-scanning push-protection blocks Mapbox `pk.` tokens**
  as a false positive. If a fresh token ever needs to be committed, GitHub
  will email a per-token "Allow secret" URL — pick "It's a false positive",
  not "used in tests".

## Cost-control layers (the three-tier kill-switch)

1. `SCI_CONFIG.DISABLE_BASEMAP = true` → manual config flag, requires
   redeploy. Used for testing the no-basemap look locally.
2. In-browser `error` event listener catches Mapbox 401/403/429 →
   sessionStorage flag + reload into empty style. Per-user, per-session.
   (Inherited from upstream Explorer.)
3. `r2:sci-data/feature-flags.json` → fetched by every page load before
   main.js. When `disable_basemap: true`, page uses empty style from
   start. Propagates to all users within ~60s. Written by `bin/*.sh`.
   (Fork-only.)

Any one of the three is enough to switch the page into no-basemap mode;
they OR together at the top of main.js.

## Personal site sync

The Jekyll-served copy at `michaelbailey.org/sci-map/` is a mirror, not
the source. To update it, run `sync-from-canonical.sh` from the
personal-website repo (it rsyncs from `../sci-map/` and re-stitches the
Jekyll frontmatter, back-link, and #site-back CSS). Treat the canonical
repo (this one) as the source of truth for everything except the
back-link and the Jekyll frontmatter.
