# /sci-map/ World regions ETL

One-shot data prep for the GADM2-level World regions tab. Output is hosted on
Cloudflare R2 and fetched per-click by the page; nothing built here is
committed back into the site.

## Inputs

- **SCI shards** — HDX dataset `social-connectedness-index`, resource `gadm2.zip`.
  HDX redirects to Google Drive: file id `1M3XTjZG_bgzGkEZ1tJgZ6qLcuPJU5Ck4`
  (4.98 GB zip → 12 country-sharded CSVs, ~44.7 GB raw, ~900M rows total).
  Download with `gdown 1M3XTjZG_bgzGkEZ1tJgZ6qLcuPJU5Ck4 -O gadm2.zip` then
  `unzip -d shards/`.
- **GADM 4.1 worldwide gpkg** — `https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip`
  (1.47 GB zip → 2.6 GB gpkg). Used to derive the polygon mesh.

## Outputs (on R2 in bucket `sci-data`)

- `gadm2_world_v5.geojson` — 47k admin-2 polygons, dissolved from GADM2/3/4/5
  features, simplified + topology-cleaned.
- `gadm2_v2/_meta.json` — bin thresholds for both methods (legend reads these).
- `gadm2_v2/<GID_2>.json.gz` × 37,160 — per-source payload of shape
  `{ ref, a: {FRIEND_GID: bin0..7}, b: {FRIEND_GID: bin0..7}, top: [...] }`.

## Boundary build (mapshaper)

```bash
# Stream-extract L2 from gpkg with per-feature simplify
ogr2ogr -f GeoJSON gadm_410_L2_simple.geojson gadm_410.gpkg \
  -sql "SELECT GID_2, NAME_2, GID_0, COUNTRY FROM ADM_ADM_2" \
  -simplify 0.01

# Dissolve duplicates that share a GID_2 + topology clean
NODE_OPTIONS="--max-old-space-size=6144" mapshaper gadm_410_L2_simple.geojson \
  -dissolve GID_2 copy-fields=NAME_2,GID_0,COUNTRY \
  -clean -snap \
  -simplify 8% keep-shapes \
  -clean gap-fill-area=20km2 \
  -o gadm2_world_v5.geojson format=geojson force precision=0.0001
```

## SCI ETL (etl_v3.py)

Run from `/tmp/sci-v3/` with `shards/` populated and `out_v2/_meta.json` present
(this directory's `_meta.json` is the canonical copy — drop it in `out_v2/`
before running):

```bash
pip3 install --user duckdb orjson
python3 -u etl_v3.py 2>&1 | tee etl_v3.log
```

Pipeline: DuckDB streams the CSVs → per-source 20th-pct ref → ORDER BY
user_region → Python streams batches → 6-worker multiprocess pool serializes
with orjson + writes one gzipped JSON per source. Wall clock ~20 min,
peak RAM ~6 GB, disk spill peaks ~35 GB.

Method A bin thresholds (Custom — currently the only one visible in the UI):
`[1, 5, 10, 25, 50, 100, 250]` × per-source ref.

Method B thresholds (hidden in the UI but shipped in every JSON):
`[1, 5, 12, 23, 47, 119, 528]` × per-source ref. These are exact quantiles
on a 2M-row sample of `ratio > 1`, so each of bins 1–7 holds roughly equal
mass globally.

## Upload to R2

```bash
# Per-source JSONs need BOTH headers; without Content-Encoding the browser
# can't decode the gzip bytes returned by R2.
rclone sync /tmp/sci-v3/out_v2/ r2:sci-data/gadm2_v2/ \
  --s3-no-check-bucket \
  --header-upload "Content-Type: application/json" \
  --header-upload "Content-Encoding: gzip" \
  --transfers 32 --checkers 32

# Boundary file (one-time):
rclone copyto /tmp/sci-v3/gadm2_world_v5.geojson \
  r2:sci-data/gadm2_world_v5.geojson \
  --s3-no-check-bucket \
  --header-upload "Content-Type: application/json"
```
