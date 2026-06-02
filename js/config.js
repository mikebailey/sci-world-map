// Adopter-editable configuration. Loaded by index.html *before* main.js,
// which reads window.SCI_CONFIG.
//
// If you're forking this project to host your own instance, edit the four
// values below and you're done — main.js doesn't need to be touched.
// See README.md → "Fork & deploy your own" for the full setup walkthrough.

window.SCI_CONFIG = {
  // PUBLIC Mapbox token. It's safe to commit because the token is restricted
  // to the URLs you put in the Mapbox dashboard allowlist (your deploy
  // origin, plus localhost for development). Scopes should be read-only:
  // styles:read, styles:tiles, fonts:read.
  MAPBOX_TOKEN: "pk.eyJ1IjoibWlrZXRoZWNoYW1waW9uIiwiYSI6ImNtcHJycGVwMzEyNGUyc29lbDg3MjRubGUifQ.W5gn-AZzwLAc0W3Mhftx9Q",

  // Cloudflare R2 bucket public dev URL (or a custom domain you've fronted
  // the bucket with). No trailing slash. Used for:
  //   - the GADM2 boundary file
  //   - the per-source SCI lookup JSONs (one per click on World regions)
  //   - the bin-threshold metadata
  R2_BASE: "https://pub-5433ddd592ff4ca4829ed8c8b77d58d6.r2.dev",

  // GADM2 boundary filename inside R2_BASE. Versioned so cache busting is a
  // one-character change. The "v5" file in the canonical deploy was built
  // with the mapshaper recipe in etl/README.md.
  R2_BOUNDARY_NAME: "gadm2_world_v5.geojson",

  // Path (with trailing slash) inside R2_BASE that holds per-source GADM2
  // SCI JSONs and the _meta.json threshold file. Each per-source file is
  // named "<GID_2>.json.gz" — e.g. "USA.45.27_1.json.gz" for Uintah, UT.
  R2_GADM2_PATH: "/gadm2_v2/",

  // If true, skip the Mapbox basemap entirely and render the choropleth on
  // a plain background. Useful as a manual kill-switch if the Mapbox bill
  // gets out of hand, or to preview what the auto-fallback looks like.
  // Even when false, main.js will switch to this mode automatically if it
  // detects a Mapbox 401/403/429 (auth or quota failure) at runtime.
  DISABLE_BASEMAP: false,
};
