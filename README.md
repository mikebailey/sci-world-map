# sci-map

Interactive web map of Facebook's **Social Connectedness Index (SCI)** — the relative likelihood that a Facebook user in one place has a friendship link to a user in another place. Click any country, EU region (NUTS2), US state, or worldwide admin-2 region; the map recolors to show how strongly that location connects to everywhere else.

**Canonical deploy:** [sci-map.michaelbailey.org](https://sci-map.michaelbailey.org) (also embedded at [michaelbailey.org/sci-map/](https://michaelbailey.org/sci-map/)).

**Data source:** [Humanitarian Data Exchange — Social Connectedness Index](https://data.humdata.org/dataset/social-connectedness-index) (Johnston, Kuchler, Kulkarni, Stroebel — 2026 vintage). The SCI was introduced by [Bailey, Cao, Kuchler, Stroebel, Wong (JEP 2018)](https://pages.stern.nyu.edu/~jstroebe/PDF/JKKS_SCI.pdf).

**Map design** adapted from [DeepMoiré](https://www.deepmoire.com/).

---

## Contents

1. [What the user sees](#what-the-user-sees)
2. [Architecture & data flow](#architecture--data-flow)
3. [Embed on your own site](#embed-on-your-own-site)
4. [Local development](#local-development)
5. [Fork & deploy your own instance](#fork--deploy-your-own-instance) — full setup walkthrough
6. [Rebuild the GADM2 dataset (ETL)](#rebuild-the-gadm2-dataset-etl)
7. [Costs & limits](#costs--limits)
8. [Contributing](#contributing)
9. [License](#license)

---

## What the user sees

Four tabs (top-left), one map (full viewport), one info panel (right):

| Tab | Geography | Source data | Where it lives |
|-----|-----------|-------------|----------------|
| Countries     | World, country-level                  | HDX `country.csv`         | Bundled in repo, ~565 KB CSV + 2.2 MB GeoJSON |
| EU regions    | Eurostat NUTS-2024 admin-2 (~300 polys) | HDX `nuts_2024.zip`       | Bundled, ~1.8 MB CSV + 240 KB GeoJSON |
| US states     | GADM 4.1 USA admin-1 (50 + DC + PR)   | HDX `gadm1.csv` (filtered) | Bundled, ~680 KB CSV + 270 KB GeoJSON |
| World regions | GADM 4.1 worldwide admin-2 (47k polys) | HDX `gadm2.zip` (12 shards, ~44.7 GB raw) | Cloudflare R2 — too big to ship in the repo |

Per click the page repaints the choropleth from a single source's row, surfaces a top-10 most-connected list, and renders a likelihood legend.

---

## Architecture & data flow

Static HTML/CSS/JS. No build step, no backend, no framework. Everything is browser-side.

```
                                   ┌─────────────────────────────┐
   User opens sci-map.example.org  │  index.html                 │
   ──────────────────────────────▶ │  loads css/style.css        │
                                   │        + mapbox-gl-js (CDN) │
                                   │        + js/config.js       │  ← edit me to fork
                                   │        + js/main.js         │
                                   └──────────────┬──────────────┘
                                                  │
                       ┌──────────────────────────┼──────────────────────────┐
                       ▼                          ▼                          ▼
                  Mapbox tiles            Bundled data/*.csv         Cloudflare R2
                  (basemap)               (levels 0-2, ~5 MB)        sci-data bucket:
                                                                     • gadm2_world_v5.geojson  (17 MB,
                                                                       loaded once when level3 active)
                                                                     • gadm2_v2/_meta.json     (legend
                                                                       thresholds, loaded once)
                                                                     • gadm2_v2/<GID_2>.json.gz
                                                                       (~190 KB, fetched per click
                                                                       on World regions)
```

### Why the World-regions data lives on R2 instead of in the repo

The full GADM2 SCI pairs table is ~900 million rows and ~40 GB raw. Even the bin-encoded per-source files together come to ~6.3 GB across 37,160 files — too big for GitHub Pages, and we want a CDN with free egress (R2's killer feature relative to S3) since each click is a fresh fetch.

### Per-source GADM2 payload shape

Each `gadm2_v2/<GID_2>.json.gz` decodes to:

```json
{
  "ref": 4359,
  "a":   { "FRIEND_GID_2": 0..7, ... },   // bin index under "Custom" thresholds
  "b":   { "FRIEND_GID_2": 0..7, ... },   // bin index under "Even" thresholds
  "top": [
    { "g": "USA.45.13_1", "s": 1040824, "a": 7, "b": 7 },
    ...
  ]
}
```

- `ref` — this source's 20th-percentile `scaled_sci`. Used as the "1×" reference for bin labels.
- `a` — bin assigned under fixed multipliers of `ref`: `[1, 5, 10, 25, 50, 100, 250]×`.
- `b` — bin assigned under global-quantile cuts on the `ratio > 1` distribution: `[1, 5, 12, 23, 47, 119, 528]×`. Currently shipped but the UI toggle is hidden — Method A is the visible default.
- `top` — top 20 friends ranked by RAW `scaled_sci`. The page renders the first 10; names + countries are joined client-side from the boundary GeoJSON via `GID_2`.

### Browser → R2 gotcha that will bite you

R2 serves objects exactly as uploaded. If you upload a gzipped file but only set `Content-Type: application/json`, the browser receives raw gzip bytes — `.json()` fails with `SyntaxError: Unexpected token`. The fix is to upload with **both** `Content-Type: application/json` **and** `Content-Encoding: gzip`. Then Cloudflare advertises gzip transfer encoding and every browser auto-decompresses transparently. The [ETL section](#rebuild-the-gadm2-dataset-etl) below uses these flags on every `rclone` invocation; if you skip them, the page will silently fail to repaint on World-region clicks.

---

## Embed on your own site

The cheapest way to ship this on a site you control is to point an iframe at the canonical deploy:

```html
<iframe
  src="https://sci-map.michaelbailey.org"
  style="border:0; width:100%; height:100vh;"
  loading="lazy"
  allowfullscreen
  title="Social Connectedness Index">
</iframe>
```

The iframe makes its own resource fetches as `sci-map.michaelbailey.org`, so the embedding host's domain doesn't need to be on either the Mapbox URL allowlist or the R2 CORS allowlist.

If you'd rather **copy the static files** into your own site instead of iframing, see [Fork & deploy your own instance](#fork--deploy-your-own-instance) — that is the same procedure, just minus the GitHub Pages part.

---

## Local development

You need [Mike's deployment's Mapbox token to be allowlisted for `http://localhost:4000`](#fork--deploy-your-own-instance) (it already is) and Python.

```bash
git clone https://github.com/mikebailey/sci-map.git
cd sci-map
python3 -m http.server 4000
# open http://localhost:4000
```

That's it. The page fetches Mapbox tiles + the canonical R2 bucket; no further setup needed for read-only local work.

If you change `js/config.js` to point at *your* R2 bucket, you also need that bucket to allowlist `http://localhost:4000` in its CORS rules (see [CORS](#step-2-configure-cors) below).

---

## Fork & deploy your own instance

This walkthrough assumes you want to host **your own copy** so its usage doesn't count against `michaelbailey.org`'s Mapbox bill or R2 quota. The walkthrough is written so that an LLM coding agent can follow each step verbatim without further prompts.

### Prerequisites

- A GitHub account with `gh` CLI authenticated (`gh auth status` returns OK).
- A Mapbox account (free tier; no credit card needed for the free 50k map loads/month).
- A Cloudflare account (free tier; no credit card needed unless you exceed R2's free 10 GB).
- `rclone` installed locally (`brew install rclone`, `apt install rclone`, or [rclone.org/install](https://rclone.org/install/)).
- `git` and a recent Python 3 (3.9+).

### Step 1: Get a Mapbox token

1. Go to [account.mapbox.com](https://account.mapbox.com/access-tokens/) and create an account if you don't have one.
2. Click **Create a token**.
3. **Name:** `sci-map-public` (anything — this name only appears in your dashboard).
4. **Public scopes:** check ONLY these three. Uncheck everything else.
   - `styles:read`
   - `styles:tiles`
   - `fonts:read`
5. **Secret scopes:** leave everything unchecked.
6. **URL restrictions:** add the URLs your deploy will be served from. Examples:
   - `http://localhost:4000` (for local dev)
   - `http://127.0.0.1:4000` (some browsers prefer this form)
   - `https://your-deploy-domain.example.com` (your canonical deploy)
   - Any other site that will embed this *as a script tag, not an iframe*. (Iframed deploys only need the iframe URL allowlisted, not the parent page's URL.)
7. Click **Create token**.
8. Copy the `pk....` string. Paste it into `js/config.js`:
   ```js
   MAPBOX_TOKEN: "pk.YOURTOKENHERE",
   ```

The token is committed to git and shipped to every visiting browser. That is OK because (a) the scopes are read-only and (b) the URL restrictions mean anyone who copies it can't use it from a domain you don't control.

### Step 2: Set up a Cloudflare R2 bucket

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com/). If you don't have an account, create one (no card needed).
2. In the left nav, click **R2**. If this is your first time, click **Enable R2** and follow the prompts (it'll ask for a payment method to verify your identity but won't charge anything under the 10 GB / 10M ops/month free tier).
3. Click **Create bucket**.
   - **Name:** `sci-data` (or anything; remember it).
   - **Location:** leave on Automatic.
4. Open the bucket → **Settings** tab.
5. Under **Public access**, click **Allow access** → confirm. This exposes the bucket at a URL like `https://pub-XXXXXXXXXXXX.r2.dev/`. Copy that URL.
6. Paste the URL into `js/config.js`:
   ```js
   R2_BASE: "https://pub-XXXXXXXXXXXX.r2.dev",
   ```

#### Step 2a: Configure CORS

R2's CORS allowlist gates browser fetches from JavaScript. Without CORS, the page can fetch the boundary file and meta but per-click region fetches will be blocked.

1. In the bucket Settings → **CORS Policy**, click **Add CORS policy**.
2. Paste this (edit the `AllowedOrigins` list to your own domains):

   ```json
   [
     {
       "AllowedOrigins": [
         "http://localhost:4000",
         "http://127.0.0.1:4000",
         "https://your-deploy-domain.example.com"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag", "Content-Length"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

3. Save.

#### Step 2b: Create an R2 API token for uploads

1. In the R2 dashboard → **Manage R2 API Tokens** (top right).
2. Click **Create Account API token** (NOT a User-level token — Account tokens are what work with `rclone`).
3. **Permissions:** Object Read & Write.
4. **Specify bucket:** select your bucket (e.g. `sci-data`) — single-bucket scoping is fine.
5. **TTL:** "Forever" is OK; pick a calendar date if you prefer to rotate.
6. Click **Create**.
7. The dashboard now shows: an **Access Key ID**, a **Secret Access Key**, and an **Endpoint** URL. Copy all three.
8. Configure `rclone`:

   ```bash
   mkdir -p ~/.config/rclone
   cat > ~/.config/rclone/rclone.conf <<EOF
   [r2]
   type = s3
   provider = Cloudflare
   access_key_id = <PASTE ACCESS KEY ID>
   secret_access_key = <PASTE SECRET ACCESS KEY>
   endpoint = <PASTE ENDPOINT URL>
   region = auto
   acl = private
   EOF
   ```

9. Sanity check:

   ```bash
   rclone ls r2:sci-data --s3-no-check-bucket
   # (empty bucket → no output; non-empty → list of objects. No error = good.)
   ```

   The `--s3-no-check-bucket` flag is **required** with Cloudflare's single-bucket-scoped tokens — without it, rclone tries to `ListBuckets` first, which the token isn't allowed to do, and the command fails 403.

### Step 3: Get the World-regions dataset onto your R2

You have two choices.

**Option A (easiest, no ETL): mirror Mike's canonical files.** Roughly 6.5 GB of one-time download + 6.5 GB of upload to your R2.

```bash
# These URLs are public, no auth needed.
PUB=https://pub-5433ddd592ff4ca4829ed8c8b77d58d6.r2.dev

# Boundary
curl -fLo gadm2_world_v5.geojson "$PUB/gadm2_world_v5.geojson"
rclone copyto gadm2_world_v5.geojson r2:sci-data/gadm2_world_v5.geojson \
  --s3-no-check-bucket --header-upload "Content-Type: application/json"

# Meta + 37,160 per-source SCI JSONs (you'll want to script this with rclone
# sync from a temporary mirror; see etl/README.md for the upload patterns)
```

This is fine if you trust the canonical version; it gives you an identical instance under your own quotas. The downside is no auditability — you have no idea how the bins were chosen without re-running the ETL.

**Option B (auditable): rebuild from scratch.** See [Rebuild the GADM2 dataset](#rebuild-the-gadm2-dataset-etl) below. ~1 hour wall clock on a recent laptop. End-to-end reproducible from HDX.

### Step 4: Test locally

```bash
python3 -m http.server 4000
# open http://localhost:4000 — the World regions tab should now hit YOUR R2
```

If the page loads but clicks on World regions silently do nothing, open DevTools → Network and look for failed R2 fetches. The most common causes:
- Per-source files served without `Content-Encoding: gzip` → `SyntaxError: Unexpected token`. Re-upload with both headers.
- CORS denied → your deploy origin isn't in the R2 bucket's CORS allowlist.
- 404 → file isn't actually there (or the path in `R2_GADM2_PATH` doesn't match where you uploaded).

### Step 5: Deploy

The page is a static site. Any static host works (GitHub Pages, Cloudflare Pages, Netlify, S3+CloudFront, ...).

**GitHub Pages with custom domain (the canonical setup):**

```bash
gh repo create your-org/sci-map --public --source=. --remote=origin --push
# Repo Settings → Pages → Source = "Deploy from a branch", Branch = main / root
# Custom domain: enter sci-map.yourdomain.com → "Save"
# Add a CNAME DNS record at your registrar:
#   sci-map.yourdomain.com → your-org.github.io
# Wait ~1 min for DNS + Pages to settle, then visit https://sci-map.yourdomain.com
```

The repo already includes a `.nojekyll` (so Pages doesn't try to Jekyll-process the JSON files) and a `CNAME` (which you'll edit to your domain). Don't forget to:

- Add your final `https://sci-map.yourdomain.com` to **both** the Mapbox URL allowlist and the R2 CORS allowlist before going live.

---

## Rebuild the GADM2 dataset (ETL)

End-to-end pipeline that takes you from HDX downloads to the 37,160 R2 objects that drive the World-regions tab. See [`etl/README.md`](etl/README.md) for the line-by-line script. Summary:

1. **Download the SCI shards.** HDX dataset `social-connectedness-index`, resource `gadm2.zip` → redirects to Google Drive file id `1M3XTjZG_bgzGkEZ1tJgZ6qLcuPJU5Ck4`. 4.98 GB zip → 12 country-sharded CSVs, ~44.7 GB raw.
   ```bash
   pip3 install --user gdown
   gdown 1M3XTjZG_bgzGkEZ1tJgZ6qLcuPJU5Ck4 -O gadm2.zip
   unzip gadm2.zip -d shards/ -x "__MACOSX/*"
   ```

2. **Download the GADM 4.1 worldwide GeoPackage** (for the boundary file).
   ```bash
   curl -fLo gadm_410-gpkg.zip https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip
   unzip gadm_410-gpkg.zip
   ```

3. **Build the boundary (`gadm2_world_v5.geojson`).** Streams L2 features via `ogr2ogr`, dissolves duplicates on `GID_2`, simplifies and topology-cleans with mapshaper. See `etl/README.md` for the exact incantation. Output: ~17 MB GeoJSON, 47,211 polygons.

4. **Run the SCI ETL.**
   ```bash
   pip3 install --user duckdb orjson
   # Drop the canonical bin thresholds in place so the script reuses them
   # (re-deriving Method B's global quantiles from a 2M-row sample is
   # deterministic but takes ~1 extra minute):
   mkdir -p out_v2
   cp etl/_meta.json out_v2/_meta.json
   python3 -u etl/etl_v3.py 2>&1 | tee etl.log
   ```
   ~20 min wall clock. Peak RAM ~6 GB. Disk spill peaks ~35 GB. Output: `out_v2/` with 37,160 gzipped per-source JSONs.

5. **Upload to R2.** **Both** headers are required:
   ```bash
   # Per-source JSONs + meta
   rclone sync out_v2/ r2:sci-data/gadm2_v2/ \
     --s3-no-check-bucket \
     --header-upload "Content-Type: application/json" \
     --header-upload "Content-Encoding: gzip" \
     --transfers 32 --checkers 32

   # Boundary file (no Content-Encoding because the .geojson is plain text)
   rclone copyto gadm2_world_v5.geojson r2:sci-data/gadm2_world_v5.geojson \
     --s3-no-check-bucket \
     --header-upload "Content-Type: application/json"
   ```

After this, the World regions tab on your deploy will paint from your own R2 bucket.

---

## Costs & limits

Both Mapbox and Cloudflare R2 charge per usage with generous free tiers. R2 is essentially free at any plausible scale because **R2 charges zero for egress** (S3's biggest pain point). Mapbox is the only material cost.

### Free tiers

| Resource              | Free per month | Above-tier price |
|-----------------------|---------------:|------------------|
| Mapbox map loads      | 50,000         | $5/k (next 50k), $4/k (next 100k), $3/k (next 800k), $2.50/k (1M–5M) |
| Mapbox vector tiles   | 200,000        | $0.25/k (next 1.8M), $0.20/k (next 2M), $0.15/k (4M+) |
| R2 storage            | 10 GB          | $0.015/GB/mo |
| R2 Class B (reads)    | 10M ops        | $0.36/M ops |
| R2 Class A (writes)   | 1M ops         | $4.50/M ops |
| R2 egress             | **unlimited**  | (no charge ever) |

### What one "user" costs you

Per-user-per-month assumptions used in the table below:
- 1 page-load → 1 Mapbox map load
- ~40 Mapbox vector-tile requests (modest pan/zoom on the light-v11 basemap)
- ~7 R2 GET requests (boundary + meta + ~5 region clicks)

| Users/mo | Mapbox cost | R2 cost | **Total/mo** |
|---------:|------------:|--------:|-------------:|
| 1,000    | $0          | $0      | **$0**       |
| 10,000   | $50         | $0      | **$50**      |
| 50,000   | ~$450       | $0      | **~$450**    |
| 100,000  | ~$1,100     | $0      | **~$1,100**  |
| 500,000  | ~$4,800     | $0      | **~$4,800**  |
| 1,000,000| ~$9,300     | $0      | **~$9,300**  |

Tile requests dominate the Mapbox bill — at 100k users/mo, ~77% of the Mapbox cost is tiles, not loads. The 40-tiles-per-user assumption is the squishiest number; lighter usage cuts it in half, heavier (lots of pan/zoom across continents) roughly doubles it.

### Set a budget alert

Mapbox lets you set a monthly billing threshold that emails you (and optionally throttles new tile requests). Do this in **Mapbox dashboard → Billing → Spend alerts**. A single viral post can push you past free tier overnight.

### Killing the basemap if billing becomes a problem

The escape hatch is to drop the Mapbox basemap and render just the boundary polygons on a plain background. Cosmetically worse but Mapbox cost goes to ~$0 at any scale (no tile requests = no tile bill; no map load = no map-load bill). Three independent triggers can flip the page into no-basemap mode:

1. **Manual config kill-switch.** Set `DISABLE_BASEMAP: true` in `js/config.js` and redeploy. Slow path (push + Pages build) but it's the most durable — useful for permanent toggles or for testing the fallback look locally.
2. **Reactive client fallback** (already wired). If a user's browser hits a Mapbox 401/403/429 mid-session, `main.js` flips the no-basemap session flag and reloads the tab into the fallback view. Covers individual users immediately, no infrastructure needed.
3. **Runtime feature flag on R2.** `index.html` fetches `<R2_BASE>/feature-flags.json` on every page load (before `main.js` runs). If that file says `disable_basemap: true`, the page initializes in no-basemap mode without ever asking Mapbox for tiles. Updates propagate to all users within ~60s (the R2 cache TTL).

The runtime flag is written by you, not by an automated poller. **Mapbox does not expose a usage API**, so there's no way to programmatically detect "we're at 80% of monthly quota" the way we'd hoped. Instead, the workflow is:

- **Set a Mapbox spend alert** in their dashboard → **Billing → Spend alerts** → choose a monthly $ threshold. Mapbox emails you when you cross it. This is the early-warning signal, ~24h before any user actually sees a 429.
- **When you get the alert**, run `bin/disable-basemap.sh` from this repo:

   ```bash
   bin/disable-basemap.sh
   ```

   That uploads a `feature-flags.json` to your R2 bucket with `disable_basemap: true`. Every page load from then on serves the no-basemap fallback. Optional argument is a reason string that gets stored in the flag for auditability: `bin/disable-basemap.sh "manual:spend_cap_hit_2026-06"`.

- **On the 1st of next month** (or whenever you've raised the cap), run `bin/enable-basemap.sh` to clear the flag.

Both scripts use `rclone` against your `[r2]` remote and overwrite the flag in place. R2's cache header is set to 60 s, so the change reaches users within a minute.

If for some reason `bin/` isn't handy, you can also edit `feature-flags.json` by hand in the Cloudflare R2 dashboard → bucket → click the file → **Edit metadata + content**. The page reads it identically.

---

## Contributing

Contributions welcome, especially:

- New region layers (e.g. UK NUTS3, Canadian census divisions, world admin-3).
- Performance improvements on the World-regions tab (currently the bin maps are dense — there's an obvious 50% size cut by packing both bins into a single byte).
- Better top-10 disambiguation (we already drop empty/`"?"` names and append country, but heuristics for very-common toponyms could be sharper).
- A "deep link" mechanism so a click can be captured in the URL and shared.

PRs should:
- Keep the page a single static HTML file with no build step. (Bundling is fine to *add* if it's a clear win, but the current zero-dependency setup is a feature.)
- Not bake the `MAPBOX_TOKEN` or `R2_BASE` into anything other than `js/config.js`.
- Update `etl/` and this README if you change the on-the-wire payload shape.

---

## License

MIT. See `LICENSE`.

The SCI data is published by Meta's Data for Good program on HDX under [Meta's Open Data Commons Attribution License](https://data.humdata.org/dataset/social-connectedness-index) — review their terms separately if you redistribute the underlying numbers.
