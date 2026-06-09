// Interactive SCI map.
//
// A fork of the public Interactive Explorer
// (social-connectedness-index/social-connectedness-index — web/src/explore/explore.js)
// with three downstream customizations:
//
//   1. Adds a third level — US states (GADM1) — alongside Countries (level0)
//      and Regions / GADM best (level2). Data for US states is bundled in
//      this repo under data/ (see LEVELS.level1.dataBase). Data for the other
//      two levels comes from SCI_CONFIG.DATA_BASE (the collaborator deploy
//      at social-connectedness.org/data, CORS-open).
//   2. Restores a Globe / Flat projection switcher. Flat picks a per-level
//      projection (naturalEarth for the world layers, albers for US states).
//   3. Inverts the Top-10 list — visible inline in the right panel by default,
//      with a toggle button that hides/shows it (the upstream Explorer hides
//      it behind a modal).
//
// Plus: on the Regions level, the hover tooltip and panel title carry a small
// "(GADM<n>)" suffix derived from the feature id (count of dots before "_"
// in the GADM key), because the upstream "GADM best" layer mixes admin
// levels per country and surfacing the level matters for interpretation.

if (!window.SCI_CONFIG) {
  throw new Error("[SCI] window.SCI_CONFIG is missing — check that index.html loads config.js before main.js.");
}
mapboxgl.accessToken = window.SCI_CONFIG.MAPBOX_TOKEN;

const DATA_BASE = (window.SCI_CONFIG.DATA_BASE || "").replace(/\/$/, "");

// Default world view, US visible, nothing pre-highlighted.
const DEFAULT_CENTER = [-30, 28];
const DEFAULT_ZOOM = 1.6;

// Empty Mapbox style — no tiles, used when the basemap is disabled (manual
// config flag, runtime R2 feature flag, or automatic fallback after a Mapbox
// 401/403/429).
const EMPTY_STYLE = {
  version: 8,
  name: "no-basemap",
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ecef" } }],
};

// Three-tier kill switch (any one triggers no-basemap mode):
//   1. SCI_CONFIG.DISABLE_BASEMAP — manual config flag, requires redeploy.
//   2. SCI_RUNTIME_FLAGS.disable_basemap — fetched from R2 by index.html
//      *before* main.js loads; propagates to all users within ~60s.
//   3. sessionStorage flag set by the on-error fallback below — per user, per
//      session, after a Mapbox 401/403/429 hits during the page's lifetime.
const NO_BASEMAP_SESSION_KEY = "sciMapBasemapFailedThisSession";
const runtimeFlags = window.SCI_RUNTIME_FLAGS || {};
const forceNoBasemap =
  !!window.SCI_CONFIG.DISABLE_BASEMAP ||
  !!runtimeFlags.disable_basemap ||
  sessionStorage.getItem(NO_BASEMAP_SESSION_KEY) === "1";

const map = new mapboxgl.Map({
  attributionControl: false,
  container: "map",
  style: forceNoBasemap ? EMPTY_STYLE : "mapbox://styles/mapbox/light-v11",
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 8,
});

// Auto-fallback on Mapbox tile/style failures (401 bad token, 403 wrong
// origin, 429 quota). Mark the session and reload into no-basemap mode.
if (!forceNoBasemap) {
  map.on("error", function (e) {
    if (!e || !e.error) return;
    const err = e.error;
    const status = err.status || (err.message && (err.message.match(/HTTP (\d+)/) || [])[1]);
    if (status == 401 || status == 403 || status == 429) {
      console.warn("[SCI] Mapbox basemap failure (HTTP " + status + ") — falling back to no-basemap mode.", err);
      try { sessionStorage.setItem(NO_BASEMAP_SESSION_KEY, "1"); } catch (_) {}
      window.location.reload();
    }
  });
}

map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

let hoveredStateId = null;

const hoverPopup = new mapboxgl.Popup({
  closeButton: false,
  closeOnClick: false,
  className: "sci-tooltip",
  offset: 10,
  maxWidth: "240px",
});

// GADM admin level encoded in a feature id (dots before "_" in the GADM key).
// USA       -> 0    (country)
// JPN.10_1  -> 1    (prefecture)
// DEU.1.10_1 -> 2   (kreis)
// IND.1.1.1_1 -> 3  (subdistrict)
function gadmLevelFromId(id) {
  if (!id || typeof id !== "string") return null;
  const key = id.split("_")[0];
  if (!key) return null;
  return key.split(".").length - 1;
}

function fmtSciMultiplier(sci, refSci) {
  if (sci == null || isNaN(sci) || !refSci || refSci <= 0) return null;
  const m = sci / refSci;
  if (m < 1) return "<1x";
  if (m < 100) return Math.round(m) + "x";
  const f = m > 99999 ? 5000 : m > 9999 ? 500 : 50;
  return (Math.round(m / f) * f).toLocaleString() + "x";
}

function hoverTooltipHtml(feat, levelKey) {
  const cfg = LEVELS[levelKey];
  let name = feat.properties.name || feat.properties.id;
  if (cfg.appendCountry && feat.properties.country && name !== feat.properties.country) {
    name += ", " + feat.properties.country;
  }
  // GADM-best mixes admin levels per country; surface the level so users
  // can interpret what a "region" represents in each country.
  if (cfg.showGadmLevel) {
    const lvl = gadmLevelFromId(feat.properties.id);
    if (lvl != null) name += ' <span class="tt-gadm">(GADM' + lvl + ")</span>";
  }
  let html = '<div class="tt-name">' + name + "</div>";
  const sel = lastSelection;
  if (sel && sel.levelKey === levelKey && sel.refSci) {
    let line;
    if (feat.properties.id === sel.clickedId) line = "Selected region";
    else {
      const m = fmtSciMultiplier(feat.properties.sci, sel.refSci);
      line = m == null ? "No data" : m + " friendship likelihood";
    }
    html += '<div class="tt-sci">' + line + "</div>";
  }
  return html;
}

// Colours + bins (shared by all levels). Identical to the upstream Explorer.
const REFERENCE_QUANTILE = 0.25;
const BREAK_MULTIPLIERS = [1, 2, 5, 7, 10, 25, 50, 75, 100];
const RAMP_STOPS = [
  "#f7fcf0", "#e0f3db", "#ccebc5", "#a8ddb5", "#7bccc4",
  "#4eb3d3", "#2b8cbe", "#0868ac", "#084081",
];

function hexToRgb(h) {
  h = h.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  const c = (n) => Math.round(n).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
function rampColors(stops, n) {
  if (n <= 1) return [stops[0]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (stops.length - 1);
    const lo = Math.floor(t), hi = Math.min(lo + 1, stops.length - 1), f = t - lo;
    const a = hexToRgb(stops[lo]), b = hexToRgb(stops[hi]);
    out.push(rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f));
  }
  return out;
}

const BIN_COLORS = rampColors(RAMP_STOPS, BREAK_MULTIPLIERS.length + 1);

function fmtMult(m) { return (m >= 10 ? Math.round(m) : m) + "x"; }
const LEGEND_TICK_MULTS = [1, 5, 10, 50, 100];

const DEFAULT_FILL = "#e3e7ea";
const NO_DATA_FILL = "#cdd3d8";
const BORDER_COLOR = "#b9c2c9";

// Three levels: Countries (collaborator data), US states (bundled), Regions
// (collaborator GADM best). Each level can override DATA_BASE via `dataBase`.
const LEVELS = {
  level0: {
    sciType: "country",
    geo: "geo/country.geojson",
    sharded: false,
    ranged: false,
    appendCountry: false,
    unit: "country",
    title: "Top 10 Connected Countries",
    col: "Country",
    canFocus: false,
    showGadmLevel: false,
    view: { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM },
  },
  level1: {
    sciType: "us_states",
    // Bundled in this repo (the public dataset doesn't ship a US-states tab).
    dataBase: "./data",
    geo: "geo/us_states.geojson",
    // Override sources filename — Jekyll's default exclude pattern strips
    // any `_<name>` path, so the personal-site mirror 404s on _sources.json.
    // Collaborator-hosted levels still use the upstream `_sources.json`.
    sourcesPath: "sci/us_states/sources.json",
    sharded: false,
    ranged: false,
    appendCountry: false, // every region is a US state — country suffix is noise
    unit: "state",
    title: "Top 10 Connected US States",
    col: "US state",
    canFocus: false,
    showGadmLevel: false,
    view: { center: [-98, 39], zoom: 3.0 },
    // Default flat projection for US-only views is Albers USA conic. The
    // global FLAT_PROJECTION_BY_LEVEL table mirrors this.
  },
  level2: {
    sciType: "gadm2", // GADM-best data under the gadm2 id (upstream convention)
    sharded: true,
    ranged: true,
    appendCountry: true,
    unit: "region",
    title: "Top 10 Connected Regions",
    col: "Region",
    canFocus: true,
    showGadmLevel: true, // (GADM<n>) suffix in hover + title — see gadmLevelFromId
    view: { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM },
  },
};
const LEVEL_KEYS = ["level0", "level1", "level2"];

// Per-level flat projections. Globe mode forces the 3D globe regardless of
// zoom (overrides Mapbox's adaptive globe-below-zoom-5 default).
const FLAT_PROJECTION_BY_LEVEL = {
  level0: "naturalEarth",
  level1: "albers",     // purpose-built USA conic for the US-states view
  level2: "naturalEarth",
};
let projMode = "globe";

function applyProjection() {
  try {
    if (projMode === "globe") {
      map.setProjection("globe");
    } else {
      map.setProjection(FLAT_PROJECTION_BY_LEVEL[gSel] || "naturalEarth");
    }
  } catch (e) {
    console.warn("[SCI] setProjection failed:", e);
  }
}

let gSel = "level0";

// "Focus country" mode (Regions level only): restrict the choropleth + Top-10
// to regions within the selected source's own country, recoloured on the
// within-country distribution and zoomed to that country.
let focusCountry = false;
let lastSelection = null;

// Dynamic colour scale: when on, the reference is recomputed from the regions
// currently on screen (on moveend), so coloring adapts to the view.
let dynamicScale = false;

// Fetch helpers — honour per-level dataBase override.
function baseFor(cfg) { return (cfg && cfg.dataBase ? cfg.dataBase : DATA_BASE).replace(/\/$/, ""); }

async function getJSON(cfg, path) {
  const r = await fetch(baseFor(cfg) + "/" + path);
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + path);
  return r.json();
}

const sciCache = {};
let gadm2Index = null;

async function loadGadm2Index(cfg) {
  if (!gadm2Index) gadm2Index = await getJSON(cfg, "sci/gadm2/index.json");
  return gadm2Index;
}

async function getSciRanged(cfg, id) {
  const idx = await loadGadm2Index(cfg);
  const ent = idx.sources[id];
  if (!ent) return null;
  const [p, off, len] = ent;
  const url = baseFor(cfg) + "/sci/gadm2/" + idx.parts[p];
  const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
  if (!r.ok && r.status !== 206) return null;
  if (r.status === 206) return r.json();
  const whole = await r.arrayBuffer();
  const text = new TextDecoder().decode(whole.slice(off, off + len));
  return JSON.parse(text);
}

async function fetchSci(cfg, id) {
  const key = cfg.sciType + "/" + id;
  if (key in sciCache) return sciCache[key];
  let val = null;
  try {
    if (cfg.ranged) {
      val = await getSciRanged(cfg, id);
    } else {
      const r = await fetch(baseFor(cfg) + "/sci/" + cfg.sciType + "/" + id + ".json");
      val = r.ok ? await r.json() : null;
    }
  } catch (e) {
    console.warn("[SCI] SCI fetch failed for", key, e);
    val = null;
  }
  sciCache[key] = val;
  return val;
}

async function loadSources(cfg) {
  if (cfg.ranged) {
    const idx = await loadGadm2Index(cfg);
    return new Set(Object.keys(idx.sources));
  }
  const path = cfg.sourcesPath || ("sci/" + cfg.sciType + "/_sources.json");
  try {
    const arr = await getJSON(cfg, path);
    return new Set(arr);
  } catch (e) {
    console.warn("[SCI] sources file missing for", cfg.sciType, "(" + path + ") — treating all as clickable.");
    return null;
  }
}

async function loadGeometry(cfg) {
  if (!cfg.sharded) return getJSON(cfg, cfg.geo);
  const parts = await getJSON(cfg, "geo/gadm2/_parts.json");
  const shards = await Promise.all(
    parts.map((cc) =>
      getJSON(cfg, "geo/gadm2/" + cc + ".geojson").catch((e) => {
        console.warn("[SCI] gadm2 shard failed:", cc, e);
        return { features: [] };
      })
    )
  );
  const features = [];
  for (const s of shards) if (s && s.features) features.push(...s.features);
  return { type: "FeatureCollection", features };
}

const spinner = document.getElementById("loading-icon");
function showSpinner() { if (spinner) spinner.style.display = "block"; }
function hideSpinner() { if (spinner) spinner.style.display = "none"; }

function getPercentile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(percentile * sorted.length);
  return sorted[Math.min(index, sorted.length - 1)];
}

function featureCentroid(geom) {
  if (!geom) return null;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
  const scanCoords = function (c) {
    if (typeof c[0] === "number") {
      const x = c[0], y = c[1];
      if (isFinite(x) && isFinite(y)) {
        any = true;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    } else {
      for (let i = 0; i < c.length; i++) scanCoords(c[i]);
    }
  };
  const scanGeom = function (g) {
    if (!g) return;
    if (g.type === "GeometryCollection") {
      (g.geometries || []).forEach(scanGeom);
    } else if (g.coordinates) {
      scanCoords(g.coordinates);
    }
  };
  scanGeom(geom);
  return any ? [(minx + maxx) / 2, (miny + maxy) / 2] : null;
}

const unwrapLon = (x, ref) => {
  while (x - ref > 180) x -= 360;
  while (x - ref < -180) x += 360;
  return x;
};

// Bounding box of the contiguous landmass containing the clicked region — see
// upstream comment in explore.js for why this isn't a plain country bbox.
function focusBounds(features, country, anchorId) {
  const pts = [];
  let ai = -1;
  for (const f of features) {
    if (f.properties.country !== country) continue;
    const c = featureCentroid(f.geometry);
    if (!c) continue;
    if (f.properties.id === anchorId && ai < 0) ai = pts.length;
    pts.push(c);
  }
  if (!pts.length) return null;
  if (ai < 0) ai = 0;

  const ref = pts[ai][0];
  for (let i = 0; i < pts.length; i++) pts[i][0] = unwrapLon(pts[i][0], ref);
  const n = pts.length;

  let west, east, south, north;
  if (n === 1) {
    west = east = pts[0][0]; south = north = pts[0][1];
  } else {
    const inMST = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    best[0] = 0;
    const edges = [];
    for (let it = 0; it < n; it++) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < n; i++) if (!inMST[i] && best[i] < bd) { bd = best[i]; u = i; }
      if (u < 0) break;
      inMST[u] = 1;
      if (parent[u] >= 0) edges.push([u, parent[u], Math.sqrt(bd)]);
      for (let v = 0; v < n; v++) {
        if (inMST[v]) continue;
        const dx = pts[u][0] - pts[v][0], dy = pts[u][1] - pts[v][1];
        const dd = dx * dx + dy * dy;
        if (dd < best[v]) { best[v] = dd; parent[v] = u; }
      }
    }
    const lens = edges.map((e) => e[2]).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)] || 1;
    const T = Math.min(Math.max(2.5 * median, 8), 20);

    const adj = Array.from({ length: n }, () => []);
    for (const [u, v, w] of edges) if (w <= T) { adj[u].push(v); adj[v].push(u); }

    const vis = new Uint8Array(n);
    const stack = [ai];
    vis[ai] = 1;
    west = Infinity; east = -Infinity; south = Infinity; north = -Infinity;
    while (stack.length) {
      const i = stack.pop();
      const x = pts[i][0], y = pts[i][1];
      if (x < west) west = x; if (x > east) east = x;
      if (y < south) south = y; if (y > north) north = y;
      for (const j of adj[i]) if (!vis[j]) { vis[j] = 1; stack.push(j); }
    }
  }

  const padX = Math.max((east - west) * 0.12, 1.2);
  const padY = Math.max((north - south) * 0.12, 1.2);
  west -= padX; east += padX; south -= padY; north += padY;
  south = Math.max(south, -84); north = Math.min(north, 84);
  return [[west, south], [east, north]];
}

map.on("load", async function () {
  const setupDone = {};

  async function ensureLevel(levelKey) {
    if (setupDone[levelKey]) return;
    setupDone[levelKey] = true;
    const cfg = LEVELS[levelKey];

    showSpinner();
    let geojson, sources;
    try {
      [geojson, sources] = await Promise.all([loadGeometry(cfg), loadSources(cfg)]);
    } catch (e) {
      console.error("[SCI] failed to set up", levelKey, e);
      setupDone[levelKey] = false;
      hideSpinner();
      return;
    }

    geojson.features = geojson.features.map(function (d, i) {
      d.id = i + 1;
      const key = d.properties.id;
      d.properties.has_data = sources ? sources.has(key) : true;
      d.properties.sci = null;
      return d;
    });
    cfg.geojson = geojson;

    map.addSource(levelKey, { type: "geojson", data: geojson });

    const beforeId = map.getLayer("waterway-label") ? "waterway-label" : undefined;
    map.addLayer(
      {
        id: levelKey,
        type: "fill",
        source: levelKey,
        layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "has_data"], false], NO_DATA_FILL,
            DEFAULT_FILL,
          ],
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.92],
        },
      },
      beforeId
    );
    map.addLayer(
      {
        id: levelKey + "borders",
        type: "line",
        source: levelKey,
        layout: { visibility: "none", "line-join": "round" },
        paint: {
          "line-color": BORDER_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.15, 4, 0.4, 7, 0.85],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 4, 0.6],
        },
      },
      beforeId
    );

    wireLevelEvents(levelKey, cfg);
    hideSpinner();
  }

  function wireLevelEvents(levelKey, cfg) {
    map.on("click", levelKey, async function (e) {
      const feat = e.features[0];
      const clickedId = feat.properties.id;

      if (feat.properties.has_data === false) return;

      showSpinner();
      const sci = await fetchSci(cfg, clickedId);
      hideSpinner();
      if (!sci) return;

      lastSelection = {
        levelKey: levelKey,
        cfg: cfg,
        clickedId: clickedId,
        clickedName: feat.properties.name,
        clickedCountry: feat.properties.country,
        sci: sci,
      };
      renderSelection(focusCountry ? "country" : "none");
    });

    map.on("mousemove", levelKey, function (e) {
      if (e.features.length === 0) return;
      const hovered = e.features[0];
      const clickable = hovered.properties.has_data !== false;
      map.getCanvas().style.cursor = clickable ? "pointer" : "not-allowed";
      if (clickable) {
        if (hoveredStateId) map.setFeatureState({ source: levelKey, id: hoveredStateId }, { hover: false });
        hoveredStateId = hovered.id;
        map.setFeatureState({ source: levelKey, id: hoveredStateId }, { hover: true });
      } else if (hoveredStateId) {
        map.setFeatureState({ source: levelKey, id: hoveredStateId }, { hover: false });
        hoveredStateId = null;
      }
      hoverPopup.setLngLat(e.lngLat).setHTML(hoverTooltipHtml(hovered, levelKey)).addTo(map);
    });

    map.on("mouseleave", levelKey, function () {
      map.getCanvas().style.cursor = "";
      if (hoveredStateId) map.setFeatureState({ source: levelKey, id: hoveredStateId }, { hover: false });
      hoveredStateId = null;
      hoverPopup.remove();
    });
  }

  function renderSelection(zoom) {
    const sel = lastSelection;
    if (!sel) return;
    const { levelKey, cfg, clickedId, clickedName, clickedCountry, sci } = sel;
    const geojson = cfg.geojson;
    const focus = focusCountry && cfg.canFocus && !!clickedCountry;

    document.getElementById("console").style.display = "block";
    document.getElementById("legend").style.display = "block";
    // Title — append the GADM level for regions so users see what the
    // clicked unit actually is in that country.
    let titleText = clickedName || clickedId;
    if (cfg.showGadmLevel) {
      const lvl = gadmLevelFromId(clickedId);
      if (lvl != null) titleText += ' <span class="title-gadm">(GADM' + lvl + ")</span>";
    }
    document.getElementById("title").innerHTML = titleText;

    let clickedSci = null;
    const list = [];
    const seenIds = new Set();
    geojson.features.forEach(function (f) {
      const id = f.properties.id;
      const v = sci[id];
      f.properties.sci = v === undefined ? null : v;
      if (v === undefined) return;
      if (id === clickedId) clickedSci = v;
      if (focus && f.properties.country !== clickedCountry) return;
      if (seenIds.has(id)) return;
      seenIds.add(id);
      let label = f.properties.name || id;
      if (cfg.appendCountry && f.properties.country) label += ", " + f.properties.country;
      list.push({ admin: label, sci: v });
    });

    const sorted = list.sort((a, b) => b.sci - a.sci);

    const sciValues = sorted.map((c) => c.sci).filter((v) => v !== null && !isNaN(v) && v !== clickedSci);
    let refSci = getPercentile(sciValues, REFERENCE_QUANTILE);
    if (!refSci || refSci <= 0) {
      const pos = sciValues.filter((v) => v > 0);
      refSci = pos.length ? Math.min.apply(null, pos) : 1;
    }
    sel.globalRefSci = refSci;

    map.getSource(levelKey).setData(geojson);
    applyCurrentScale(levelKey);
    if (dynamicScale) map.once("idle", () => applyCurrentScale(levelKey));

    updateLegend();
    updateTop10Table(sorted, refSci, cfg);
    updateFocusButton();

    if (zoom === "country" && focus) {
      const b = focusBounds(geojson.features, clickedCountry, clickedId);
      if (b) {
        map.fitBounds(b, { padding: 50, duration: 1000, maxZoom: 6, linear: false });
      } else {
        console.warn("[SCI] focus zoom skipped: unreliable bounds for", clickedCountry);
      }
    } else if (zoom === "world") {
      const view = cfg.view;
      if (view) map.flyTo({ ...view, essential: true, duration: 1000 });
    }
  }

  function paintWithRef(levelKey, refSci) {
    const sel = lastSelection;
    if (!sel || sel.levelKey !== levelKey || !map.getLayer(levelKey)) return;
    const cfg = sel.cfg;
    const focus = focusCountry && cfg.canFocus && !!sel.clickedCountry;
    const thresholds = BREAK_MULTIPLIERS.map((m) => m * refSci);
    const step = ["step", ["coalesce", ["get", "sci"], 0], BIN_COLORS[0]];
    for (let i = 0; i < thresholds.length; i++) step.push(thresholds[i], BIN_COLORS[i + 1]);
    const fillColor = ["case", ["==", ["get", "has_data"], false], NO_DATA_FILL];
    if (focus) fillColor.push(["!=", ["get", "country"], sel.clickedCountry], DEFAULT_FILL);
    fillColor.push(["has", "sci"], step, DEFAULT_FILL);
    map.setPaintProperty(levelKey, "fill-color", fillColor);
    sel.refSci = refSci;
  }

  function levelPoints(cfg) {
    if (cfg._points) return cfg._points;
    const pts = [];
    const geo = cfg.geojson;
    if (geo) {
      for (const f of geo.features) {
        const c = featureCentroid(f.geometry);
        if (c) pts.push({ id: f.properties.id, country: f.properties.country, lng: c[0], lat: c[1] });
      }
    }
    cfg._points = pts;
    return pts;
  }

  function visibleRef(levelKey) {
    const sel = lastSelection;
    if (!sel || sel.levelKey !== levelKey || !sel.sci) return null;
    const bounds = map.getBounds();
    if (!bounds) return null;
    const cfg = sel.cfg;
    const focus = focusCountry && cfg.canFocus && !!sel.clickedCountry;
    const seen = new Set();
    const vals = [];
    for (const p of levelPoints(cfg)) {
      if (p.id === sel.clickedId || seen.has(p.id)) continue;
      if (focus && p.country !== sel.clickedCountry) continue;
      if (!bounds.contains([p.lng, p.lat])) continue;
      const v = sel.sci[p.id];
      if (v == null || isNaN(v) || v <= 0) continue;
      seen.add(p.id);
      vals.push(v);
    }
    if (!vals.length) return null;
    let r = getPercentile(vals, REFERENCE_QUANTILE);
    if (!r || r <= 0) r = Math.min.apply(null, vals);
    return r;
  }

  function applyCurrentScale(levelKey) {
    const sel = lastSelection;
    if (!sel || sel.levelKey !== levelKey) return;
    let ref = sel.globalRefSci;
    if (dynamicScale) { const v = visibleRef(levelKey); if (v) ref = v; }
    if (ref) paintWithRef(levelKey, ref);
  }

  map.on("moveend", function () {
    if (dynamicScale && lastSelection) applyCurrentScale(lastSelection.levelKey);
  });

  function updateLegend() {
    const legendScale = document.getElementById("legend-scale");
    const n = BIN_COLORS.length;
    const bar = BIN_COLORS
      .map(function (c) { return '<span class="legend-swatch" style="background-color:' + c + '"></span>'; })
      .join("");
    const labels = LEGEND_TICK_MULTS
      .map(function (m) {
        const i = BREAK_MULTIPLIERS.indexOf(m);
        if (i < 0) return "";
        const pos = (((i + 1) / n) * 100).toFixed(2);
        return '<span class="legend-tick" style="left:' + pos + '%">' + fmtMult(m) + "</span>";
      })
      .join("");
    legendScale.innerHTML =
      '<div class="legend-bar">' + bar + "</div>" +
      '<div class="legend-ticks">' + labels + "</div>";
  }

  function updateTop10Table(sorted, refSci, cfg) {
    document.getElementById("table-title").innerHTML = cfg.title;
    document.getElementById("tab-lab").innerHTML = cfg.col;
    const tableBody = document.querySelector("#top-10-table tbody");
    tableBody.innerHTML = "";

    function roundedMultiplier(sci) {
      if (!refSci || refSci === 0) return "-";
      const multiplier = sci / refSci;
      if (multiplier < 999) return "" + Math.round(multiplier / 5) * 5;
      let factor;
      if (multiplier > 99999) factor = 5000;
      else if (multiplier > 9999) factor = 500;
      else factor = 50;
      return (Math.round(multiplier / factor) * factor).toLocaleString();
    }

    sorted.slice(0, 10).forEach(function (item, index) {
      const row = document.createElement("tr");
      row.innerHTML =
        '<td><span class="rank-circle">' + (index + 1) + "</span></td>" +
        "<td>" + item.admin + "</td>" +
        "<td>" + roundedMultiplier(item.sci) + "x</td>";
      tableBody.appendChild(row);
    });
  }

  function updateFocusButton() {
    const row = document.getElementById("focus-country-row");
    const cb = document.getElementById("focus-country");
    if (!row || !cb) return;
    const canShow = lastSelection && lastSelection.cfg.canFocus && !!lastSelection.clickedCountry;
    row.style.display = canShow ? "flex" : "none";
    cb.checked = focusCountry;
  }

  async function setActiveLayer(activeId) {
    await ensureLevel(activeId);
    LEVEL_KEYS.forEach(function (id) {
      if (!map.getLayer(id)) return;
      const vis = id === activeId ? "visible" : "none";
      map.setLayoutProperty(id, "visibility", vis);
      if (map.getLayer(id + "borders")) map.setLayoutProperty(id + "borders", "visibility", vis);
    });
    if (map.getLayer(activeId)) {
      map.setPaintProperty(activeId, "fill-color", [
        "case",
        ["==", ["get", "has_data"], false], NO_DATA_FILL,
        DEFAULT_FILL,
      ]);
    }
  }

  // Projection — apply initial (globe), wire the switcher.
  applyProjection();

  // Initial level (countries).
  await ensureLevel("level0");
  setActiveLayer("level0");

  // Level switcher.
  document.querySelectorAll(".button-container button").forEach(function (button) {
    button.addEventListener("click", async function () {
      const consoleEl = document.getElementById("console");
      if (consoleEl) consoleEl.style.display = "none";
      const legendEl = document.getElementById("legend");
      if (legendEl) legendEl.style.display = "none";

      document.querySelectorAll(".button-container button").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      // Switching level clears any selection and exits focus mode.
      focusCountry = false;
      lastSelection = null;
      updateFocusButton();

      const previousLevel = gSel;
      gSel = this.id;
      await setActiveLayer(this.id);
      applyProjection(); // re-pick the flat projection per new level if in Flat mode

      // Stay where the user was looking, EXCEPT when entering or leaving the
      // US-states tab — that layer is geographically constrained, so we fly
      // to its default view on enter, and back to the world default on exit.
      const enteringUS = this.id === "level1" && previousLevel !== "level1";
      const leavingUS = previousLevel === "level1" && this.id !== "level1";
      if (enteringUS) {
        map.flyTo({ ...LEVELS.level1.view, essential: true, duration: 1200 });
      } else if (leavingUS) {
        map.flyTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, essential: true, duration: 1200 });
      }
    });
  });

  // Projection switcher.
  const projButtons = document.querySelectorAll(".projection-container button");
  projButtons.forEach((btn) => {
    btn.addEventListener("click", function () {
      projButtons.forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      projMode = this.id === "proj-globe" ? "globe" : "flat";
      applyProjection();
    });
  });

  // "Focus on this country" toggle.
  (function setupFocusButton() {
    const cb = document.getElementById("focus-country");
    if (!cb) return;
    cb.addEventListener("change", function () {
      if (!lastSelection) { cb.checked = false; return; }
      focusCountry = cb.checked;
      renderSelection(focusCountry ? "country" : "world");
    });
  })();

  // "Scale colors to the area in view" toggle.
  (function setupDynamicScale() {
    const cb = document.getElementById("dynamic-scale");
    if (!cb) return;
    cb.addEventListener("change", function () {
      dynamicScale = cb.checked;
      if (lastSelection) applyCurrentScale(lastSelection.levelKey);
    });
  })();

  // Results-panel close button (mainly mobile bottom-sheet UX).
  (function setupConsoleClose() {
    const btn = document.getElementById("console-close");
    if (!btn) return;
    btn.addEventListener("click", function () {
      const el = document.getElementById("console");
      if (el) el.style.display = "none";
    });
  })();

  // Top-10 toggle — INVERTED from upstream: the list is visible by default
  // and the button just hides/shows it inline, no modal.
  (function setupTopConnectionsToggle() {
    const btn = document.getElementById("top-connections-toggle");
    const container = document.getElementById("top-10-container");
    if (!btn || !container) return;
    function sync() {
      const visible = container.style.display !== "none";
      btn.textContent = visible ? "Hide top connections" : "Show top connections";
      btn.setAttribute("aria-expanded", visible ? "true" : "false");
    }
    sync();
    btn.addEventListener("click", function () {
      container.style.display = container.style.display === "none" ? "" : "none";
      sync();
    });
  })();

  // "About this map" expandable panel.
  (function setupExplanationToggle() {
    const btn = document.getElementById("data-explanation-btn");
    const panel = document.getElementById("data-explanation");
    if (!btn || !panel) return;
    const open = () => { panel.removeAttribute("hidden"); btn.setAttribute("aria-expanded", "true"); };
    const shut = () => { panel.setAttribute("hidden", ""); btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", () => (panel.hasAttribute("hidden") ? open() : shut()));
    const close = panel.querySelector(".close-btn");
    if (close) close.addEventListener("click", shut);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
  })();
});
