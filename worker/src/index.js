// Cloudflare Worker — Mapbox quota monitor + R2 feature-flag writer.
//
// Runs on a cron trigger every 6 hours (Mapbox usage reporting lags by
// ~6h so polling more often is wasted requests). Logic:
//
//   1. Pull the current month's map-load + tile-request usage from
//      https://api.mapbox.com/usage/v2/{username}.
//   2. Compute usage / monthly limit for each.
//   3. Decide a new feature-flag state:
//        - >= 100% of map loads OR tile requests  → disable_basemap = true
//          (auto kill-switch — the page falls back to plain-background mode)
//        - >= 80%                                  → disable_basemap = false,
//          but flag the situation as "warn" so we email once
//        - otherwise                               → disable_basemap = false,
//          clear any prior alert state
//   4. Write the new flags to r2:sci-data/feature-flags.json (overwriting
//      the previous file). The page fetches this file on each load.
//   5. If the alert state CHANGED since the last run, send an email via
//      Resend (warn / critical / restored).
//
// The Worker is also reachable via plain HTTP fetch — hitting its URL
// runs the same check immediately and returns JSON, useful for manual
// "what does it look like right now?" checks. Protect the URL by setting
// the WORKER_MANUAL_TRIGGER_SECRET env var; requests must pass it as a
// `?token=...` query parameter.

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
  async fetch(request, env, ctx) {
    if (env.WORKER_MANUAL_TRIGGER_SECRET) {
      const url = new URL(request.url);
      if (url.searchParams.get("token") !== env.WORKER_MANUAL_TRIGGER_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
    }
    const result = await runCheck(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

async function runCheck(env) {
  const username = required(env, "MAPBOX_USERNAME");
  const secretToken = required(env, "MAPBOX_SECRET_TOKEN");
  const mapLoadLimit = parseInt(env.MAPBOX_MONTHLY_MAP_LOAD_LIMIT || "50000", 10);
  const tileLimit    = parseInt(env.MAPBOX_MONTHLY_TILE_LIMIT     || "200000", 10);
  const warnThreshold     = parseFloat(env.WARN_THRESHOLD     || "0.8");
  const criticalThreshold = parseFloat(env.CRITICAL_THRESHOLD || "1.0");

  const usage = await fetchMapboxUsage(username, secretToken);

  // The Mapbox usage API returns a list of services; we only care about
  // web map loads ("MAP_LOAD_WEB") and vector-tile API requests
  // ("VECTOR_TILES_API"). Names are stable across Mapbox's pricing
  // revisions but if Mapbox ever renames them this Worker will silently
  // report zero — the README points at the schema.
  const mapLoads     = sumService(usage, ["MAP_LOAD_WEB", "MAU"]);
  const tileRequests = sumService(usage, ["VECTOR_TILES_API"]);

  const mapLoadFraction = mapLoads     / mapLoadLimit;
  const tileFraction    = tileRequests / tileLimit;
  const worstFraction   = Math.max(mapLoadFraction, tileFraction);

  let newState;
  if (worstFraction >= criticalThreshold) {
    newState = "critical";
  } else if (worstFraction >= warnThreshold) {
    newState = "warn";
  } else {
    newState = "ok";
  }

  const newFlags = {
    disable_basemap: newState === "critical",
    reason: {
      critical: "auto:quota_exceeded",
      warn:     "auto:approaching_quota",
      ok:       null,
    }[newState],
    state: newState,
    metrics: {
      map_loads:           mapLoads,
      map_load_limit:      mapLoadLimit,
      map_load_fraction:   mapLoadFraction,
      tile_requests:       tileRequests,
      tile_request_limit:  tileLimit,
      tile_fraction:       tileFraction,
      worst_fraction:      worstFraction,
    },
    updated_at: new Date().toISOString(),
  };

  // Compare to previous run to see if we need to alert.
  let prevFlags = null;
  try {
    const obj = await env.SCI_BUCKET.get("feature-flags.json");
    if (obj) prevFlags = await obj.json();
  } catch (_) { /* first run; no prior flags */ }
  const prevState = (prevFlags && prevFlags.state) || "ok";

  // Persist flags. cacheControl is short so the page picks up state changes
  // within ~60s of the worker writing them. R2 still benefits from CDN edge
  // caching for the within-TTL window.
  await env.SCI_BUCKET.put("feature-flags.json", JSON.stringify(newFlags), {
    httpMetadata: {
      contentType:  "application/json",
      cacheControl: "public, max-age=60",
    },
  });

  // Send email only on state transitions, so a quiet month doesn't generate
  // four "all good" emails per day.
  let alertSent = null;
  if (prevState !== newState) {
    alertSent = await sendStateChangeEmail(env, prevState, newState, newFlags);
  }

  return {
    prev_state: prevState,
    new_state:  newState,
    flags:      newFlags,
    alert_sent: alertSent,
  };
}

async function fetchMapboxUsage(username, secretToken) {
  // Mapbox usage/v2 endpoint, current monthly period. The `sk....` token
  // must have the `usage:read` scope.
  const url = `https://api.mapbox.com/usage/v2/${encodeURIComponent(username)}?access_token=${encodeURIComponent(secretToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Mapbox usage API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return await resp.json();
}

function sumService(usageJson, serviceNames) {
  // The Mapbox usage payload shape has shifted a few times. Try the
  // current shape (services array with `name` + `usage`), then fall back
  // to legacy shapes. Worst case we return 0 and the cron still writes
  // a flag — the Worker just won't see truth until the schema is fixed.
  const services = usageJson.services || usageJson.usage || [];
  if (Array.isArray(services)) {
    let total = 0;
    for (const s of services) {
      if (s && serviceNames.includes(s.name || s.service)) {
        total += Number(s.usage || s.count || s.total || 0);
      }
    }
    return total;
  }
  if (typeof services === "object") {
    let total = 0;
    for (const k of serviceNames) {
      const v = services[k];
      if (v && typeof v === "object") total += Number(v.usage || v.count || 0);
    }
    return total;
  }
  return 0;
}

async function sendStateChangeEmail(env, prevState, newState, flags) {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) {
    console.log(`would email: ${prevState} → ${newState}; RESEND_API_KEY/EMAIL_TO/EMAIL_FROM not all set`);
    return "skipped:not_configured";
  }

  const lines = [];
  const pct = (f) => (f * 100).toFixed(1) + "%";
  const m = flags.metrics;

  let subject;
  if (newState === "critical") {
    subject = "[sci-map] Mapbox quota EXCEEDED — basemap auto-disabled";
    lines.push("Mapbox monthly limit reached. The sci-map page is now serving the no-basemap fallback (plain background + boundary polygons only). No tile or map-load requests will hit Mapbox until the next billing cycle OR until you manually clear the flag in R2.");
  } else if (newState === "warn") {
    subject = "[sci-map] Mapbox usage past 80% of monthly limit";
    lines.push("You're approaching the Mapbox monthly limit. Basemap is still active; the page will auto-disable it at 100%.");
  } else if (newState === "ok" && prevState !== "ok") {
    subject = "[sci-map] Mapbox usage back in safe range — basemap re-enabled";
    lines.push("Usage has dropped back below 80% (probably a new billing cycle). The basemap is active again.");
  } else {
    subject = `[sci-map] State change: ${prevState} → ${newState}`;
    lines.push("Worker state transitioned.");
  }
  lines.push("");
  lines.push(`Map loads:     ${m.map_loads.toLocaleString()} / ${m.map_load_limit.toLocaleString()} (${pct(m.map_load_fraction)})`);
  lines.push(`Tile requests: ${m.tile_requests.toLocaleString()} / ${m.tile_request_limit.toLocaleString()} (${pct(m.tile_fraction)})`);
  lines.push("");
  lines.push(`Previous state: ${prevState}`);
  lines.push(`New state:      ${newState}`);
  lines.push(`Updated at:     ${flags.updated_at}`);
  lines.push("");
  lines.push("Flag URL (open to confirm state):");
  lines.push(`  ${env.PUBLIC_FLAG_URL || "[set PUBLIC_FLAG_URL env var]"}`);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to:   env.EMAIL_TO,
      subject,
      text: lines.join("\n"),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error("Resend send failed:", resp.status, body.slice(0, 400));
    return `failed:${resp.status}`;
  }
  return "sent";
}

function required(env, key) {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var ${key} (set with: wrangler secret put ${key})`);
  return v;
}
