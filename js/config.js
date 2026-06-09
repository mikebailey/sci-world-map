// Adopter-editable configuration. Loaded by index.html *before* main.js,
// which reads window.SCI_CONFIG.
//
// If you're forking this project to host your own instance, edit the values
// below and you're done — main.js doesn't need to be touched. See README.md
// → "Fork & deploy your own" for the full setup walkthrough.

window.SCI_CONFIG = {
  // PUBLIC Mapbox token. It's safe to commit because the token is restricted
  // to the URLs you put in the Mapbox dashboard allowlist (your deploy
  // origin, plus localhost for development). Scopes should be read-only:
  // styles:read, styles:tiles, fonts:read.
  MAPBOX_TOKEN: "pk.eyJ1IjoibWlrZXRoZWNoYW1waW9uIiwiYSI6ImNtcHJycGVwMzEyNGUyc29lbDg3MjRubGUifQ.W5gn-AZzwLAc0W3Mhftx9Q",

  // Base URL for the SCI data assets (no trailing slash). Default points at the
  // collaborator-hosted social-connectedness.org deploy, which serves
  // `geo/country.geojson`, `geo/gadm2/<CC>.geojson`, `sci/country/<id>.json`,
  // and the range-indexed `sci/gadm2/*`. CORS is open (`access-control-allow-
  // origin: *`), so the cross-origin fetch works from any deploy.
  //
  // The US-states level is the exception: its data is bundled in this repo
  // under ./data/ (see LEVELS.level1.dataBase in main.js), since the public
  // dataset doesn't ship US states as a separate level.
  DATA_BASE: "https://social-connectedness.org/data",

  // Cloudflare R2 bucket public URL (no trailing slash) — used ONLY for the
  // runtime cost-control kill switch (feature-flags.json). All SCI data is
  // served from DATA_BASE above.
  R2_BASE: "https://pub-5433ddd592ff4ca4829ed8c8b77d58d6.r2.dev",

  // If true, skip the Mapbox basemap entirely and render the choropleth on
  // a plain background. Manual kill-switch if the Mapbox bill gets out of
  // hand, or to preview the no-basemap look. Even when false, main.js will
  // switch to this mode automatically on a Mapbox 401/403/429 (auth or
  // quota failure), and also when the R2 feature flag is set.
  DISABLE_BASEMAP: false,
};
