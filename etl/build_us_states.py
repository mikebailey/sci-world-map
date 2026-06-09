#!/usr/bin/env python3
"""Convert the US-states SCI CSV + GADM1 geojson into the public Explorer's
data shape, so US states can be added as a third level alongside the
collaborator-hosted Countries and Regions (GADM best) data.

Inputs (committed):
  data/us_states.csv           (user_country, friend_country, user_region, friend_region, scaled_sci)
  data/us_states.geojson       (GADM 4.1 USA L1, properties {GID_1, NAME_1, HASC_1}).
                               Idempotent: if this file is missing AND
                               data/geo/us_states.geojson already exists in the
                               public schema (its first feature has {id, country,
                               name}), the geojson rewrite step is skipped and
                               only the SCI JSONs + sources.json are regenerated.

Outputs (committed; matches https://social-connectedness.org/data layout,
EXCEPT the sources file is named `sources.json` not `_sources.json` — the
underscore-prefixed name conflicts with Jekyll's default exclude filter on
the personal-site mirror, and this file is bundled in our repo so we can
pick a friendlier name; main.js looks for it via LEVELS.level1.sourcesPath):
  data/geo/us_states.geojson           properties rewritten to {id, country, name}
  data/sci/us_states/sources.json      ["USA.1_1", ...]
  data/sci/us_states/<GID_1>.json      {friend_region: raw_scaled_sci, ...}

Run from the repo root: python3 etl/build_us_states.py
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CSV_IN = REPO / "data" / "us_states.csv"
GEO_IN = REPO / "data" / "us_states.geojson"
GEO_OUT = REPO / "data" / "geo" / "us_states.geojson"
SCI_OUT = REPO / "data" / "sci" / "us_states"


def rewrite_geo() -> int:
    with GEO_IN.open() as f:
        fc = json.load(f)
    for feat in fc["features"]:
        p = feat["properties"]
        gid = p.get("GID_1")
        name = p.get("NAME_1")
        feat["properties"] = {"id": gid, "country": "US", "name": name}
    GEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    with GEO_OUT.open("w") as f:
        json.dump(fc, f, separators=(",", ":"))
    return len(fc["features"])


def build_sci() -> tuple[int, int]:
    by_source: dict[str, dict[str, int | float]] = defaultdict(dict)
    with CSV_IN.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            src = row["user_region"]
            dst = row["friend_region"]
            raw = row["scaled_sci"]
            try:
                v = int(raw)
            except ValueError:
                v = float(raw)
            by_source[src][dst] = v

    SCI_OUT.mkdir(parents=True, exist_ok=True)
    for src, friends in by_source.items():
        with (SCI_OUT / f"{src}.json").open("w") as f:
            json.dump(friends, f, separators=(",", ":"))

    sources = sorted(by_source.keys())
    with (SCI_OUT / "sources.json").open("w") as f:
        json.dump(sources, f, separators=(",", ":"))
    return len(sources), sum(len(v) for v in by_source.values())


def main() -> None:
    if not CSV_IN.exists():
        print(f"missing input: {CSV_IN}", file=sys.stderr)
        sys.exit(1)

    if GEO_IN.exists():
        n_geo = rewrite_geo()
        print(f"geo:    {n_geo} features  -> {GEO_OUT.relative_to(REPO)}")
    elif GEO_OUT.exists():
        # Already-rewritten geojson present (typical re-run case); leave it.
        with GEO_OUT.open() as f:
            head = json.load(f)
        n_geo = len(head["features"])
        print(f"geo:    {n_geo} features already in public schema  (skipped rewrite)")
    else:
        print(f"missing input: {GEO_IN}  (and no prior output at {GEO_OUT})", file=sys.stderr)
        sys.exit(1)

    n_src, n_edges = build_sci()
    print(f"sci:    {n_src} sources, {n_edges} edges  -> {SCI_OUT.relative_to(REPO)}/")


if __name__ == "__main__":
    main()
