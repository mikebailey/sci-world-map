// All user-configurable values live in js/config.js (loaded by index.html
// before this file). Adopters editing a fork should only need to touch
// config.js — see README.md "Fork & deploy your own".
if (!window.SCI_CONFIG) {
  throw new Error("[SCI] window.SCI_CONFIG is missing — check that index.html loads js/config.js *before* js/main.js.");
}
mapboxgl.accessToken = window.SCI_CONFIG.MAPBOX_TOKEN;

// Default world view, US visible, nothing pre-highlighted.
const DEFAULT_CENTER = [-30, 28];
const DEFAULT_ZOOM = 1.6;

// Empty Mapbox style — no tiles, no labels, no basemap. Used when the
// basemap is disabled (manually via config or automatically after a Mapbox
// 401/403/429). The choropleth polygons still render on top; the page
// looks like a flat-colour world map with the SCI fills drawn on it.
const EMPTY_STYLE = {
  version: 8,
  name: "no-basemap",
  sources: {},
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e8ecef" } },
  ],
};

// Decide whether to skip the basemap. Three independent sources, any of
// which is enough to flip the switch:
//   1. SCI_CONFIG.DISABLE_BASEMAP — manual kill-switch in the deployed
//      config.js. Hardcoded; flipping it requires a redeploy.
//   2. SCI_RUNTIME_FLAGS.disable_basemap — runtime flag fetched from
//      r2:sci-data/feature-flags.json before this file loaded. Written
//      by the worker/ cron when Mapbox usage crosses the critical
//      threshold. The page picks up changes on the next load (no redeploy).
//   3. NO_BASEMAP_SESSION_KEY in sessionStorage — set by the error handler
//      below after this same tab hit a Mapbox 401/403/429. Stops the page
//      from re-pinging a known-failing endpoint on every reload within
//      the tab's lifetime.
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

// Auto-fallback. Mapbox surfaces tile/style HTTP failures as `error` events
// on the map. 401 = bad/invalid token, 403 = URL-restricted token used on
// the wrong origin, 429 = monthly quota exhausted. In any of those cases
// the basemap will be unusable for the rest of the calendar month (token
// problems) or until billing rolls over (quota), so we mark the session
// and reload into no-basemap mode. The reload is the cheapest way to
// teardown Mapbox's broken tile layers; rebuilding the level0-3 sources
// would require duplicating setActiveLayer's reset logic.
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

var nav = new mapboxgl.NavigationControl();
map.addControl(nav, "top-right");

// Mapbox-required attribution only (compact); SCI + DeepMoiré attribution
// lives in the #credits panel.
map.addControl(new mapboxgl.AttributionControl({ compact: true }));
var hoveredStateId = null;

var popup = new mapboxgl.Popup({
  className: "popup",
  closeButton: false,
  closeOnClick: true,
  anchor: "bottom",
  offset: [0, 0],
});

async function loadTSV(url) {
  const response = await fetch(url);
  const text = await response.text();
  const rows = text.split("\n").map((row) => row.trim()); // Trim each row to remove trailing spaces

  // Extract headers and trim them
  const headers = rows
    .shift()
    .split("\t") // Change delimiter to TAB
    .map((h) => h.trim());

  return rows.map((row) => {
    const values = row.split("\t").map((v) => v.trim()); // Split by TAB and trim
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] || null; // Ensure no undefined values
      return acc;
    }, {});
  });
}

async function loadCSV(url) {
  const response = await fetch(url);
  const text = await response.text();
  const rows = text.split("\n").map((row) => row.trim()); // Trim each row to remove trailing spaces

  // Extract headers and trim them
  const headers = rows
    .shift()
    .split(",")
    .map((h) => h.trim());

  return rows.map((row) => {
    const values = row.split(",").map((v) => v.trim()); // Trim each value
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index]; // Store with cleaned headers
      return acc;
    }, {});
  });
}

// Function to load the GeoJSON file
async function loadGeoJSON(url) {
  const response = await fetch(url);
  return await response.json();
}
// Level 0 — countries worldwide (~565 KB CSV, 2.2 MB boundaries).
const geojsonUrl0 = "data/WORLDCOUNTRIES.geojson";
const csvUrl0     = "data/country.csv";

// Level 1 — Europe NUTS2 (~1.6 MB simplified boundaries, ~1.8 MB CSV; 2026 HDX, NUTS 2024 codes).
const geojsonUrl1 = "data/nuts2_2024.geojson";
const csvUrl1     = "data/nuts2_2024.csv";

// Level 2 — US states (~270 KB simplified GADM USA L1 boundaries, ~680 KB CSV; user_region keyed USA.X_1).
const geojsonUrl2 = "data/us_states.geojson";
const csvUrl2     = "data/us_states.csv";

// Level 3 — World GADM2 (47k polygons + per-source pre-binned lookups on R2).
// SCI is NOT loaded upfront like levels 0-2 (the full pairs table is >40 GB);
// instead each click fetches one ~190 KB gzipped JSON from R2.
const R2_BASE      = window.SCI_CONFIG.R2_BASE.replace(/\/$/, "");
const R2_GADM2     = window.SCI_CONFIG.R2_GADM2_PATH.replace(/\/?$/, "/");
const geojsonUrl3  = R2_BASE + "/" + window.SCI_CONFIG.R2_BOUNDARY_NAME;
const sciUrl3Base  = R2_BASE + R2_GADM2;            // <GID_2>.json.gz appended at click time
const sciUrl3Meta  = R2_BASE + R2_GADM2 + "_meta.json";

function getColor(value) {
  if (!value) return "#cccccc"; // Default gray if no data
  return `rgba(0, 128, 255, ${Math.min(value / 100, 1)})`; // Adjust opacity based on scaled_sci
}

const colorSequence = [
  "#F7FCFD", // <1x (Country 20th Percentile)
  "#E0F3DB", // 1x - 2x
  "#CCEBC5", // 2x - 3x
  "#A8DDB5", // 3x - 5x
  "#7BCCC4", // 5x - 10x
  "#43A2CA", // 10x - 25x
  "#0868AC", // 25x - 100x
  "#084081", // >= 100x
  "rgba(0, 0, 0, 0)", // No data transparent (kept for compatibility with the legend "NA" row)
];

// Default fill for an in-sample feature before any click highlights it.
// Distinct from the out-of-sample grey, which signals "this region exists in
// the boundary file but has no SCI data, so it cannot be clicked".
const DEFAULT_FILL = "#F7F7F7";
const NO_DATA_FILL = "#dedede";

map.on("load", async function () {
  function colorAllLevelA(layerName, geojson, csvData, labelGeo, nameGeo, topLeveled, userCol, frCol) {
    // Build a {user -> {friend -> scaled_sci}} lookup from the CSV. The
    // user/friend column names are passed in so the same function works for
    // the country layer (user_country / friend_country) and, in v2, for
    // region layers (user_region / friend_region).

    const csvDataMap = {};

    csvData.forEach((row) => {
      const userLoc = row[userCol] ? row[userCol].trim() : null;
      const frLoc = row[frCol] ? row[frCol].trim() : null;
      const scaledSci = row.scaled_sci ? parseFloat(row.scaled_sci.replace(/\r/g, "").trim()) : null;

      if (userLoc && frLoc) {
        // Ensure both keys exist
        if (!csvDataMap[userLoc]) {
          csvDataMap[userLoc] = {};
        }
        csvDataMap[userLoc][frLoc] = isNaN(scaledSci) ? null : scaledSci; // Avoid NaN issues
      }
    });

    if (layerName === "level0") {
      document.getElementById("loading-icon").style.display = "none";
    }

    // Tag each feature with has_data so:
    //   (a) the paint expression can render out-of-sample features in a
    //       distinct "not clickable" light grey rather than NaN-out the map,
    //   (b) the click handler can ignore clicks on out-of-sample regions
    //       (a click with no row in csvDataMap used to break the choropleth
    //       paint expression and turn the whole map white).
    geojson.features = geojson.features.map(function (d, index) {
      d.id = index + 1;
      const key = d.properties[labelGeo];
      d.properties.has_data = !!(key && csvDataMap[key]);
      return d;
    });

    // Add source to the map
    map.addSource(layerName, {
      type: "geojson",
      data: geojson,
    });

    // Add the fill layer
    map.addLayer(
      {
        id: layerName,
        type: "fill",
        source: layerName,
        layout: {
          visibility: "none",
        },
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "has_data"], false],
            NO_DATA_FILL,         // out-of-sample (e.g. Liechtenstein on NUTS map)
            DEFAULT_FILL,         // in-sample, not yet highlighted by a click
          ],
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.8, 0.9],
        },
      },
      map.getLayer("waterway-label") ? "waterway-label" : undefined
    );

    map.addLayer(
      {
        id: layerName + "borders",
        type: "line",
        source: layerName,
        //minzoom: 5,
        // maxzoom: 12,
        layout: {
          visibility: "none",
          "line-join": "round",
          // "line-cap": "round",
        },
        paint: {
          "line-color": "#CCCCCC",
          "line-width": 0.3,
          "line-opacity": 1,
        },
      },
      map.getLayer("waterway-label") ? "waterway-label" : undefined
    );

    if (layerName === "level0") {
      map.setLayoutProperty(layerName, "visibility", "visible");
      map.setLayoutProperty(layerName + "borders", "visibility", "visible");
    }

    map.on("click", layerName, function (e) {
      var clickedISO = e.features[0].properties[labelGeo];

      // Out-of-sample click — no SCI row to anchor the choropleth on.
      // Doing nothing here keeps the previous highlight on the map; without
      // this guard the percentile math produced NaN thresholds and the whole
      // map went white (the bug surfaced on UK NUTS clicks, since UK isn't
      // in NUTS-2024 / not in the SCI 2026 release).
      if (!csvDataMap[clickedISO]) {
        return;
      }

      document.getElementById("console").style.display = "block";
      document.getElementById("legend").style.display = "block";

      var clickedAdmin = e.features[0].properties[nameGeo];

      document.getElementById("title").innerText = clickedAdmin; // Update the country name

      // Reset all .sci properties before updating
      geojson.features.forEach((feature) => {
        feature.properties.sci = null;
      });

      let clickedSci = null;
      let countryList = [];

      // If clicked country has data, update geojson properties
      if (csvDataMap[clickedISO]) {
        geojson.features.forEach((feature) => {
          let iso = feature.properties[labelGeo];
          let adminName = feature.properties[nameGeo]; // Get country name
          if (csvDataMap[clickedISO][iso] !== undefined) {
            let sciValue = csvDataMap[clickedISO][iso];
            feature.properties.sci = sciValue;
            countryList.push({ admin: adminName, sci: sciValue });
          } else {
          }
          if (iso === clickedISO) {
            clickedSci = csvDataMap[clickedISO][iso];
          }
        });
      }
      console.log(geojson.features);

      // Sort countries by SCI in descending order
      let sortedCountries = countryList.sort((a, b) => b.sci - a.sci);

      // Get SCI values excluding the clicked country's own value for min/max calculation
      let sciValues = sortedCountries.map((c) => c.sci).filter((v) => v !== null && !isNaN(v) && v !== clickedSci);

      // Compute the 5th and 95th percentiles
      let minSci = getPercentile(sciValues, 0.05); // 5th percentile
      let maxSci = getPercentile(sciValues, 0.9); // 95th percentile

      // Handle edge cases where percentiles return undefined
      if (minSci === null || maxSci === null || minSci === maxSci) {
        minSci = Math.min(...sciValues);
        maxSci = Math.max(...sciValues);
      }

      // Compute the 20th percentile as the reference value
      let refSci = getPercentile(sciValues, 0.2); // 20th percentile

      // Define SCI threshold values based on ranges
      let thresholds = [
        refSci, // 1x (Reference value)
        2 * refSci, // 2x
        3 * refSci, // 3x
        5 * refSci, // 5x
        10 * refSci, // 10x
        25 * refSci, // 25x
        100 * refSci, // 100x
      ];

      // Handle cases where refSci is too low or undefined
      if (refSci === null || refSci === 0 || maxSci === null || minSci === maxSci) {
        refSci = Math.min(...sciValues);
        thresholds = [refSci, 2 * refSci, 3 * refSci, 5 * refSci, 10 * refSci, 25 * refSci, 100 * refSci, 500 * refSci];
      }

      console.log(`Reference SCI (20th percentile): ${refSci}`);
      console.log(`Thresholds: ${thresholds.map((x) => x.toLocaleString())}`);

      // Update the GeoJSON source
      map.getSource(layerName).setData(geojson);

      // Apply the new range-based colouring. Out-of-sample features are
      // checked first so they always stay light grey, regardless of click
      // state.
      map.setPaintProperty(layerName, "fill-color", [
        "case",
        ["==", ["get", "has_data"], false],
        NO_DATA_FILL,
        ["has", "sci"],
        [
          "step",
          ["coalesce", ["get", "sci"], 0],
          colorSequence[0],
          0.1,
          colorSequence[0],
          thresholds[0],
          colorSequence[1],
          thresholds[1],
          colorSequence[2],
          thresholds[2],
          colorSequence[3],
          thresholds[3],
          colorSequence[4],
          thresholds[4],
          colorSequence[5],
          thresholds[5],
          colorSequence[6],
          thresholds[6],
          colorSequence[7],
        ],
        DEFAULT_FILL,
      ]);

      // Update the legend dynamically
      updateLegend();

      // Update the top 10 table
      if (thresholds && thresholds.length >= 7) {
        //updateTop10Table(sortedCountries, thresholds);
        updateTop10Table(sortedCountries, refSci, topLeveled);
      } else {
        console.error("Error: Thresholds array is undefined or too short", thresholds);
      }
    });

    map.on("mousemove", layerName, function (e) {
      if (e.features.length === 0) return;
      const hovered = e.features[0];
      const clickable = hovered.properties.has_data !== false;
      map.getCanvas().style.cursor = clickable ? "pointer" : "not-allowed";

      // Only apply the hover-highlight feature state to clickable features.
      if (clickable) {
        if (hoveredStateId) {
          map.setFeatureState({ source: layerName, id: hoveredStateId }, { hover: false });
        }
        hoveredStateId = hovered.id;
        map.setFeatureState({ source: layerName, id: hoveredStateId }, { hover: true });
      } else if (hoveredStateId) {
        map.setFeatureState({ source: layerName, id: hoveredStateId }, { hover: false });
        hoveredStateId = null;
      }
    });

    map.on("mouseleave", layerName, function () {
      map.getCanvas().style.cursor = "";

      if (hoveredStateId) {
        map.setFeatureState({ source: layerName, id: hoveredStateId }, { hover: false });
      }
      hoveredStateId = null;
      popup.remove();
    });

    // (Removed: UAE auto-highlight, fly-to, and 60s inactivity reset. The
    // map now opens to a neutral world view and waits for the user to click
    // a country. The click handler above does all of the highlight work.)
  }

  // Level 0 — countries (visible by default; click handler wires up).
  const geojson0 = await loadGeoJSON(geojsonUrl0);
  const csvData0 = await loadCSV(csvUrl0);
  colorAllLevelA("level0", geojson0, csvData0, "ISO_A2", "ADMIN", 100, "user_country", "friend_country");

  // Level 1 — Europe NUTS2.
  const geojson1 = await loadGeoJSON(geojsonUrl1);
  const csvData1 = await loadCSV(csvUrl1);
  colorAllLevelA("level1", geojson1, csvData1, "NUTS_ID", "NUTS_NAME", 100, "user_region", "friend_region");

  // Level 2 — US states (GADM USA L1, codes USA.N_1).
  const geojson2 = await loadGeoJSON(geojsonUrl2);
  const csvData2 = await loadCSV(csvUrl2);
  colorAllLevelA("level2", geojson2, csvData2, "GID_1", "NAME_1", 100, "user_region", "friend_region");

  // -------------------------------------------------------------------------
  // Level 3 — World GADM2 (47k polygons; per-source SCI lookups on Cloudflare R2)
  // -------------------------------------------------------------------------
  // The full SCI pairs table at GADM2 is too big to ship inline (>40 GB raw,
  // ~900M rows). The ETL pre-bins each (source, friend) pair under two
  // threshold sets and writes one gzipped JSON per source region of shape:
  //   { ref, a: {FRIEND_GID: bin0..7}, b: {FRIEND_GID: bin0..7},
  //     top: [{g, s, a, b}, ...] }   — top sorted by raw scaled_sci DESC.
  // The bin-method toggle below switches the choropleth between `a` (user
  // ratios) and `b` (global quantiles). Out-of-sample regions (file 404s)
  // just do nothing — same UX as the early-return guard on levels 0-2.
  let level3Boundary = null;
  // _meta.json carries the bin thresholds for both methods; fetched once at
  // setup time so the legend can render with real numbers ("1x - 5x" for A,
  // "1x - 5x", "5x - 12x", ... for B's quantile cuts).
  let level3Meta = null;
  // Last-fetched payload, retained so the binning-method toggle can re-paint
  // without refetching the JSON.
  let level3LastPayload = null;
  let level3LastName = null;
  let level3LastGid = null;
  // Binning method choice; persists across sessions.
  let level3BinMethod = localStorage.getItem("sciBinMethod") === "b" ? "b" : "a";

  async function setupLevel3() {
    console.log("[SCI level3] setup start");
    try {
      // Boundary + meta in parallel — meta is tiny so it lands first.
      const [boundary, metaResp] = await Promise.all([
        loadGeoJSON(geojsonUrl3),
        fetch(sciUrl3Meta),
      ]);
      try { level3Meta = await metaResp.json(); }
      catch (e) { console.warn("[SCI level3] meta.json parse failed:", e); }
      level3Boundary = boundary;
      console.log("[SCI level3] boundary loaded:", level3Boundary.features.length, "features");
      level3Boundary.features = level3Boundary.features.map(function (d, i) {
        d.id = i + 1;
        // has_data is *unknown* until click; treat all as clickable. The
        // click handler returns early on 404 and the fill stays default.
        d.properties.has_data = true;
        d.properties.sci_bin = -1;
        return d;
      });

      map.addSource("level3", { type: "geojson", data: level3Boundary });
      console.log("[SCI level3] source added");
      // Use whichever before-layer the existing levels used; fall back to
      // appending at the top if the style doesn't have it (some Mapbox
      // styles drop "waterway-label" — silently failing addLayer in that
      // case would leave the level invisible).
      const beforeId = map.getLayer("waterway-label") ? "waterway-label" : undefined;
      map.addLayer({
        id: "level3",
        type: "fill",
        source: "level3",
        layout: { visibility: "none" },
        paint: {
          // Slight blue tint so the world-region mesh is visibly distinct
          // from the near-white Mapbox light-v11 basemap even before the
          // user clicks any region.
          "fill-color": "#e7eef5",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.7, 0.85],
        },
      }, beforeId);
      map.addLayer({
        id: "level3borders",
        type: "line",
        source: "level3",
        layout: { visibility: "none", "line-join": "round" },
        paint: { "line-color": "#9aa6b3", "line-width": 0.35, "line-opacity": 0.8 },
      }, beforeId);
      console.log("[SCI level3] layers added; getLayer level3 =", !!map.getLayer("level3"));

      map.on("click", "level3", async function (e) {
        const f = e.features[0];
        const gid = f.properties.GID_2;
        const name = f.properties.NAME_2;

        let payload;
        try {
          const resp = await fetch(sciUrl3Base + gid + ".json.gz");
          if (!resp.ok) {
            console.log("[SCI level3] no data for", gid, "(HTTP " + resp.status + ")");
            return;
          }
          // R2 auto-transcodes gzipped objects when Content-Type is
          // application/json; the .json.gz extension is just a storage hint.
          payload = await resp.json();
        } catch (err) {
          console.warn("[SCI level3] fetch failed for", gid, err);
          return;
        }

        level3LastPayload = payload;
        level3LastName = name;
        level3LastGid = gid;
        applyLevel3();
      });

      // Apply the currently-selected binning method to the cached payload.
      // Called from the click handler and from the bin-method toggle so the
      // user can flip Method A/B without re-downloading the per-source JSON.
      function applyLevel3() {
        if (!level3LastPayload) return;
        const p = level3LastPayload;
        const bins = level3BinMethod === "b" ? p.b : p.a;

        // Stamp each feature with the chosen method's bin (or -1 = out of
        // this source's lookup).
        level3Boundary.features.forEach(function (feat) {
          const g = feat.properties.GID_2;
          feat.properties.sci_bin = (bins && bins.hasOwnProperty(g)) ? bins[g] : -1;
        });
        map.getSource("level3").setData(level3Boundary);

        map.setPaintProperty("level3", "fill-color", [
          "case",
          ["<", ["get", "sci_bin"], 0], NO_DATA_FILL,
          [
            "step", ["get", "sci_bin"],
            colorSequence[0],
            1, colorSequence[1],
            2, colorSequence[2],
            3, colorSequence[3],
            4, colorSequence[4],
            5, colorSequence[5],
            6, colorSequence[6],
            7, colorSequence[7],
          ],
        ]);

        document.getElementById("console").style.display = "block";
        document.getElementById("legend").style.display = "block";
        document.getElementById("title").innerText = level3LastName || "";

        // Top-10 from the precomputed `top` array (already ranked by raw
        // scaled_sci by the ETL). Look up NAME_2/COUNTRY from boundary geo
        // by GID_2; drop entries without a real name. The chosen method
        // decides which bin label each entry's SCI value gets.
        const top10 = [];
        if (Array.isArray(p.top)) {
          for (const t of p.top) {
            const feat = level3Boundary.features.find(function (ff) { return ff.properties.GID_2 === t.g; });
            if (!feat) continue;
            const props = feat.properties;
            const nm = (props.NAME_2 || "").trim();
            if (!nm || nm === "?") continue;
            const label = props.COUNTRY ? nm + ", " + props.COUNTRY : nm;
            const bin = level3BinMethod === "b" ? t.b : t.a;
            top10.push({ admin: label, sci: bin });
            if (top10.length >= 10) break;
          }
        }

        updateLegendForLevel3();
        updateTop10ForLevel3(top10);
      }
      // Make available to the toggle handler defined further down.
      window.__applyLevel3 = applyLevel3;

      map.on("mousemove", "level3", function (e) {
        if (e.features.length === 0) return;
        map.getCanvas().style.cursor = "pointer";
        if (hoveredStateId) {
          map.setFeatureState({ source: "level3", id: hoveredStateId }, { hover: false });
        }
        hoveredStateId = e.features[0].id;
        map.setFeatureState({ source: "level3", id: hoveredStateId }, { hover: true });
      });
      map.on("mouseleave", "level3", function () {
        map.getCanvas().style.cursor = "";
        if (hoveredStateId) {
          map.setFeatureState({ source: "level3", id: hoveredStateId }, { hover: false });
          hoveredStateId = null;
        }
      });
    } catch (err) {
      console.error("[SCI level3] setup failed:", err);
    }
  }
  await setupLevel3();

  // Level3 legend labels are derived from _meta.json thresholds at runtime
  // because the chosen method (A = user-suggested ratios, B = global quantile
  // cuts) changes the numbers. Method A: [1, 5, 10, 25, 50, 100, 250]. Method
  // B example: [1, 5, 12, 23, 47, 119, 528] (from the ETL's quantile pass).
  function level3BinLabels() {
    const thresholds = (level3Meta && (level3BinMethod === "b" ? level3Meta.thresholds_b : level3Meta.thresholds_a)) || [];
    if (thresholds.length !== 7) {
      // Defensive fallback if meta hasn't loaded — show the Method A defaults.
      return ["< 1x", "1x - 5x", "5x - 10x", "10x - 25x", "25x - 50x", "50x - 100x", "100x - 250x", "> 250x"];
    }
    const fmt = function (n) {
      if (n >= 100) return Math.round(n) + "x";
      if (n >= 10)  return Math.round(n) + "x";
      return (Math.round(n * 10) / 10) + "x";
    };
    const labels = ["< " + fmt(thresholds[0])];
    for (let i = 0; i < thresholds.length - 1; i++) {
      labels.push(fmt(thresholds[i]) + " - " + fmt(thresholds[i + 1]));
    }
    labels.push("> " + fmt(thresholds[thresholds.length - 1]));
    return labels;
  }
  function updateLegendForLevel3() {
    const legendScale = document.getElementById("legend-scale");
    legendScale.innerHTML = "";
    const labels = level3BinLabels();
    for (let i = 0; i < 8; i++) {
      const item = document.createElement("div");
      item.className = "legend-item";
      item.innerHTML = '<span class="legend-color" style="background-color: ' + colorSequence[i] + ';"></span> ' + labels[i];
      legendScale.appendChild(item);
    }
  }
  function updateTop10ForLevel3(items) {
    const meta = LAYER_META.level3;
    document.getElementById("table-title").innerHTML = meta.title;
    document.getElementById("tab-lab").innerHTML = meta.col;
    const tableBody = document.querySelector("#top-10-table tbody");
    tableBody.innerHTML = "";
    const labels = level3BinLabels();
    items.forEach(function (item, idx) {
      const row = tableBody.insertRow();
      const c1 = row.insertCell(); c1.innerHTML = '<span class="rank-circle">' + (idx + 1) + "</span>";
      const c2 = row.insertCell(); c2.textContent = item.admin;
      const c3 = row.insertCell(); c3.textContent = labels[item.sci] || "";
    });
  }

  // ----- Bin-method toggle (Custom / Even), level3 only -----
  // Two pill buttons that switch between Method A (user-suggested ratio
  // thresholds) and Method B (global quantile cuts on >1× ratios). Choice
  // persists in localStorage; re-applies to whatever payload is currently
  // cached without re-fetching.
  (function setupBinMethodToggle() {
    const buttons = document.querySelectorAll("#bin-method-container button");
    if (!buttons.length) return;
    buttons.forEach(function (b) {
      b.classList.toggle("active", b.id === ("bin-" + level3BinMethod));
    });
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        if (this.classList.contains("active")) return;
        buttons.forEach(function (x) { x.classList.remove("active"); });
        this.classList.add("active");
        level3BinMethod = this.id === "bin-b" ? "b" : "a";
        localStorage.setItem("sciBinMethod", level3BinMethod);
        if (typeof window.__applyLevel3 === "function") window.__applyLevel3();
        else updateLegendForLevel3();
      });
    });
  })();

  // Show only the active layer; reset its fills (clears any choropleth from
  // the previous layer). Skips layers that haven't been added yet so this is
  // safe to call before all loaders finish.
  function setActiveLayer(activeId) {
    ["level0", "level1", "level2", "level3"].forEach((id) => {
      if (!map.getLayer(id)) return;
      const vis = id === activeId ? "visible" : "none";
      map.setLayoutProperty(id, "visibility", vis);
      if (map.getLayer(id + "borders")) {
        map.setLayoutProperty(id + "borders", "visibility", vis);
      }
    });
    // Bin-method toggle is hidden in the shipped UI — Method A (Custom bins)
    // is the default and only visible option. The Method B code path stays
    // wired up so we can re-enable the toggle later by setting display:flex
    // here for activeId === "level3".
    if (map.getLayer(activeId)) {
      if (activeId === "level3") {
        // World regions has its own distinct default styling (tinted fill
        // + darker borders) so the polygon mesh is visible against the
        // light Mapbox basemap even before a click.
        map.setPaintProperty("level3", "fill-color", "#e7eef5");
        if (map.getLayer("level3borders")) {
          map.setPaintProperty("level3borders", "line-color", "#9aa6b3");
        }
      } else {
        // Reset to the has_data-aware default fill so out-of-sample
        // regions stay grey across level switches.
        map.setPaintProperty(activeId, "fill-color", [
          "case",
          ["==", ["get", "has_data"], false],
          NO_DATA_FILL,
          DEFAULT_FILL,
        ]);
        if (map.getLayer(activeId + "borders")) {
          map.setPaintProperty(activeId + "borders", "line-color", "#CCCCCC");
        }
      }
    }
  }

  // Default camera for each level (used when the user switches layers).
  const LEVEL_VIEWS = {
    level0: { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM },
    level1: { center: [12, 52], zoom: 3.3 },   // Europe
    level2: { center: [-98, 39], zoom: 3.4 },  // continental US
    level3: { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }, // world (GADM2)
  };

  // Per-level wording for the subtitle + top-10 table header.
  const LAYER_META = {
    level0: { unit: "country", title: "Top 10 Connected Countries", col: "Country" },
    level1: { unit: "region",  title: "Top 10 Connected Regions",   col: "Region"  },
    level2: { unit: "state",   title: "Top 10 Connected States",    col: "State"   },
    level3: { unit: "region",  title: "Top 10 Connected Regions",   col: "Region"  },
  };

  function setLayerSubtitle(id) {
    const meta = LAYER_META[id] || LAYER_META.level0;
    const sub = document.getElementById("soc-sub");
    if (sub) sub.textContent = "Click any " + meta.unit;
  }
  setLayerSubtitle(gSel); // initial — matches default-active "Countries" button

  // ----- Projection toggle (Globe / Flat) -----
  // Flat mode picks the most flattering projection per active layer:
  //   - level0 (Countries):    naturalEarth — Robinson-like compromise.
  //   - level1 (EU regions):   mercator     — straightforward, good at this zoom.
  //   - level2 (US states):    albers       — purpose-built USA conic.
  //   - level3 (World regions): naturalEarth — Robinson-like compromise.
  // Globe mode forces the 3D globe regardless of zoom (overrides Mapbox's
  // adaptive globe-below-zoom-5 default).
  const FLAT_PROJECTION_BY_LEVEL = {
    level0: "naturalEarth",
    level1: "mercator",
    level2: "albers",
    level3: "naturalEarth",
  };
  let projMode = "globe";

  function applyProjection() {
    try {
      if (projMode === "globe") {
        map.setProjection("globe");
      } else {
        map.setProjection(FLAT_PROJECTION_BY_LEVEL[gSel] || "mercator");
      }
    } catch (e) {
      console.warn("[SCI] setProjection failed:", e);
    }
  }
  applyProjection(); // explicit initial state

  const projButtons = document.querySelectorAll(".projection-container button");
  projButtons.forEach((btn) => {
    btn.addEventListener("click", function () {
      projButtons.forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      projMode = this.id === "proj-globe" ? "globe" : "flat";
      applyProjection();
    });
  });

  const buttons = document.querySelectorAll(".button-container button");
  buttons.forEach((button) => {
    button.addEventListener("click", function () {
      // Diagnostic — surfaces in DevTools console if a button does nothing.
      console.log("[SCI] level switch ->", this.id, {
        l0: !!map.getLayer("level0"),
        l1: !!map.getLayer("level1"),
        l2: !!map.getLayer("level2"),
      });

      const consoleEl = document.getElementById("console");
      if (consoleEl) consoleEl.style.display = "none";
      const legendEl = document.getElementById("legend");
      if (legendEl) legendEl.style.display = "none";

      buttons.forEach((btn) => btn.classList.remove("active"));
      this.classList.add("active");

      gSel = this.id;
      setActiveLayer(this.id);
      setLayerSubtitle(this.id);
      applyProjection(); // re-pick flat per level if we're in Flat mode

      const view = LEVEL_VIEWS[this.id];
      if (view) {
        map.flyTo({ ...view, essential: true, duration: 1200 });
      }
    });
  });

  // "About this map" expandable panel.
  (function setupExplanationToggle() {
    const btn = document.getElementById("data-explanation-btn");
    const panel = document.getElementById("data-explanation");
    if (!btn || !panel) return;
    const open = () => { panel.removeAttribute("hidden"); btn.setAttribute("aria-expanded", "true"); };
    const shut = () => { panel.setAttribute("hidden", ""); btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", () => panel.hasAttribute("hidden") ? open() : shut());
    const close = panel.querySelector(".close-btn");
    if (close) close.addEventListener("click", shut);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
  })();

  ////////////////////////////////////////functions

  function updateLegend() {
    const legendScale = document.getElementById("legend-scale");
    legendScale.innerHTML = ""; // Clear previous legend

    // Define the fixed **range-based** labels
    const labels = [
      "< 1x", // Less than 1x (20th percentile)
      "1x - 2x", // 1x - 2x
      "2x - 3x", // 2x - 3x
      "3x - 5x", // 3x - 5x
      "5x - 10x", // 5x - 10x
      "10x - 25x", // 10x - 25x
      "25x - 100x", // 25x - 100x
      "> 100x", // Greater than 100x
      "NA", // No data
    ];

    // Define the corresponding color scale
    const colorScale = [
      { color: colorSequence[0], label: labels[0] }, // <1x
      { color: colorSequence[1], label: labels[1] }, // 1x - 2x
      { color: colorSequence[2], label: labels[2] }, // 2x - 3x
      { color: colorSequence[3], label: labels[3] }, // 3x - 5x
      { color: colorSequence[4], label: labels[4] }, // 5x - 10x
      { color: colorSequence[5], label: labels[5] }, // 10x - 25x
      { color: colorSequence[6], label: labels[6] }, // 25x - 100x
      { color: colorSequence[7], label: labels[7] }, // >100x
      { color: colorSequence[8], label: labels[8] }, // na
    ];

    // Populate the legend dynamically
    colorScale.forEach((item) => {
      const div = document.createElement("div");
      div.className = "legend-item";
      div.innerHTML = `<span class="legend-color" style="background-color: ${item.color};"></span> ${item.label}`;
      legendScale.appendChild(div);
    });
  }

  var gSel = "level0";

  function updateTop10Table(sortedCountries, refSci, top) {
    const meta = LAYER_META[gSel] || LAYER_META.level0;
    document.getElementById("table-title").innerHTML = meta.title;
    document.getElementById("tab-lab").innerHTML = meta.col;

    const tableBody = document.querySelector("#top-10-table tbody");
    tableBody.innerHTML = ""; // Clear previous rows

    // Function to calculate and round multiplier dynamically
    function getRoundedMultiplier(sci) {
      if (!refSci || refSci === 0) return "-"; // Prevent division by zero
      let multiplier = sci / refSci; // Compute multiplier

      // Apply different rounding rules based on the computed multiplier
      let roundingFactor;
      if (multiplier < 999) {
        return `${Math.round(multiplier / 5) * 5}`; // Round to nearest 5x
      } else if (multiplier > 99999) {
        roundingFactor = 5000;
      } else if (multiplier > 9999) {
        roundingFactor = 500;
      } else {
        roundingFactor = 50;
      }

      // Round to the nearest factor
      let roundedMultiplier = Math.round(multiplier / roundingFactor) * roundingFactor;

      return `${roundedMultiplier.toLocaleString()}`; // Format number with commas
    }

    sortedCountries.slice(0, 10).forEach((item, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
            <td><span class="rank-circle">${index + 1}</span></td> <!-- Add ranking circle -->
            <td>${item.admin}</td>
            <td>${getRoundedMultiplier(item.sci) + "x"}</td> <!-- Show formatted multiplier -->
        `;
      tableBody.appendChild(row);
    });
  }

  // Function to calculate percentile from an array of numbers
  function getPercentile(values, percentile) {
    if (values.length === 0) return null;
    let sorted = [...values].sort((a, b) => a - b);
    let index = Math.floor(percentile * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)]; // Ensure within bounds
  }
});
