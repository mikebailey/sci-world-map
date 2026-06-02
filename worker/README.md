# Mapbox quota monitor (Cloudflare Worker)

Out-of-band sidecar for `sci-map`. Runs every 6 hours, polls Mapbox's usage API, writes a feature-flag JSON to your R2 bucket, and emails you on state changes (warn at 80%, critical at 100%, restored when usage drops). The page reads the flag on load and proactively skips the basemap when needed — so the first user to hit the over-quota threshold doesn't see a broken canvas.

Layer #1 of the same plan (in-browser reactive fallback if Mapbox 401/403/429s mid-session) is in [`../js/main.js`](../js/main.js#L1) and stays useful even after this Worker is running, since Mapbox's usage API reports with a ~6-hour lag.

## What it does, in order

1. Cron tick (`0 */6 * * *`). Worker reads:
   - **Secret env vars**: `MAPBOX_SECRET_TOKEN`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `WORKER_MANUAL_TRIGGER_SECRET`.
   - **Plain env vars** (from `wrangler.toml`): `MAPBOX_USERNAME`, `MAPBOX_MONTHLY_MAP_LOAD_LIMIT`, `MAPBOX_MONTHLY_TILE_LIMIT`, `WARN_THRESHOLD`, `CRITICAL_THRESHOLD`, `PUBLIC_FLAG_URL`.
2. Calls `https://api.mapbox.com/usage/v2/{MAPBOX_USERNAME}` with the secret token. Sums map-load + vector-tile usage.
3. Compares against the configured monthly limits. Decides one of three states: `ok` / `warn` / `critical`.
4. Reads `feature-flags.json` from the R2 bucket (binding `SCI_BUCKET`).
5. Writes the new flag. Shape (this is what the page consumes):

   ```json
   {
     "disable_basemap": false,
     "reason": "auto:approaching_quota",
     "state": "warn",
     "metrics": {
       "map_loads": 42130,
       "map_load_limit": 50000,
       "map_load_fraction": 0.843,
       "tile_requests": 168240,
       "tile_request_limit": 200000,
       "tile_fraction": 0.841,
       "worst_fraction": 0.843
     },
     "updated_at": "2026-06-02T08:00:01.123Z"
   }
   ```

   `disable_basemap` is true only at `state: "critical"`.
6. If the state changed compared to the previous run, sends a transactional email via Resend. Quiet steady-state months don't generate alerts.

## One-time setup

### 1. Mapbox secret token

The usage endpoint requires a `sk....` token, not the public `pk....` one the page uses for tiles.

1. Go to [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/).
2. Click **Create a token**.
3. **Name:** `sci-map-quota-monitor`.
4. **Secret scopes:** check ONLY `usage:read`. Uncheck everything else.
5. **Public scopes:** check nothing.
6. **URL restrictions:** leave empty (this token is used server-side from the Worker, not from a browser).
7. Click **Create**. Mapbox will show the `sk....` value ONCE — copy it now. (If you lose it, you can issue a new token.)

### 2. Resend API key (for the alert emails)

[Resend](https://resend.com) is the path of least resistance — free tier covers 100 emails/day, no card needed.

1. Sign up at [resend.com](https://resend.com).
2. **Domains** → either:
   - Add and DNS-verify your own domain (e.g. `michaelbailey.org`) so emails go out as `alerts@michaelbailey.org`. The Resend dashboard shows the SPF/DKIM records to add at your DNS provider; on Cloudflare DNS, paste them in as TXT records.
   - Skip domain verification and use Resend's shared sandbox sender `onboarding@resend.dev` (works immediately; will land in spam more often).
3. **API Keys** → **Create API Key** → permission `Full access` (or just `Sending access`) → name it `sci-map-worker` → copy the `re_...` value.

### 3. Install Wrangler + log in

```bash
cd worker
npm install
npx wrangler login    # opens a browser, authorises against your Cloudflare account
```

### 4. Set Worker secrets

These never go in `wrangler.toml`. Use `wrangler secret put` for each:

```bash
cd worker
npx wrangler secret put MAPBOX_SECRET_TOKEN
# (paste the sk.... token at the prompt)

npx wrangler secret put RESEND_API_KEY
# (paste the re_... API key)

npx wrangler secret put EMAIL_FROM
# e.g. alerts@michaelbailey.org  OR  onboarding@resend.dev

npx wrangler secret put EMAIL_TO
# your inbox, e.g. mikethechampion@gmail.com

npx wrangler secret put WORKER_MANUAL_TRIGGER_SECRET
# Any opaque string. You'll pass this as ?token=... to manually run the Worker.
# Use: openssl rand -hex 24
```

### 5. Edit `wrangler.toml`

Open `worker/wrangler.toml` and check:
- `MAPBOX_USERNAME` — your Mapbox account username (the one in the URLs on `account.mapbox.com`).
- `MAPBOX_MONTHLY_MAP_LOAD_LIMIT`, `MAPBOX_MONTHLY_TILE_LIMIT` — set to your actual plan's monthly limits. Defaults match Mapbox's free tier (50k loads / 200k tiles).
- `PUBLIC_FLAG_URL` — your R2 public URL with `/feature-flags.json` appended. (Worker only uses this for the email body, so users can click through to see the current flag state.)

### 6. Deploy

```bash
cd worker
npx wrangler deploy
```

Wrangler prints a URL like `https://sci-map-quota-monitor.<your-account>.workers.dev`. Save it.

### 7. Smoke test

```bash
curl "https://sci-map-quota-monitor.<your-account>.workers.dev?token=$WORKER_MANUAL_TRIGGER_SECRET"
```

Should return JSON with current Mapbox numbers + the `flags` object that was just written to R2. Confirm `feature-flags.json` shows up in your R2 bucket. The first run will email an "ok → ok" state change since the previous state was nil; subsequent runs are quiet unless something changes.

If you hit:
- **`Mapbox usage API 401`** — `MAPBOX_SECRET_TOKEN` is wrong or the token is missing `usage:read` scope. Regenerate.
- **`Mapbox usage API 404`** — `MAPBOX_USERNAME` doesn't match your account. Check the URL `account.mapbox.com/access-tokens` to confirm.
- **`Resend send failed`** in the response body — `EMAIL_FROM` isn't a verified Resend sender, or `RESEND_API_KEY` is wrong.

## Tuning

- **Run every hour instead of every six**: change the cron in `wrangler.toml` to `"0 * * * *"`. Mapbox's reporting lag means you'll see no new data 5/6 of those hours, but the manual-trigger URL becomes redundant since the next cron is at most an hour away.
- **Adjust thresholds**: edit `WARN_THRESHOLD` / `CRITICAL_THRESHOLD` in `wrangler.toml` and re-deploy. Setting `CRITICAL_THRESHOLD = "0.95"` is a reasonable hedge against the reporting lag — disables the basemap a bit early but means you never actually go over budget.
- **Tighter cache on the flag file**: the Worker writes `feature-flags.json` with `cache-control: public, max-age=60`. If you want faster propagation after the Worker writes, drop it to `5` or `0`; the cost is more R2 read ops from the page's repeat visitors (still well under R2's 10M/mo free tier).

## When you actually exhaust quota

If `state` flips to `critical`, the email tells you and the page is already serving the no-basemap fallback. Options:

- **Wait it out**: next billing cycle starts on the 1st of the next calendar month UTC. Worker will set `state: "ok"` and write `disable_basemap: false` on its next run after usage drops.
- **Manually clear** (e.g. you upgraded to a paid plan and want the basemap back NOW): edit `feature-flags.json` directly in the R2 dashboard, set `disable_basemap: false`, save. The next page load gets the new value within ~60s (the `max-age` window).
- **Raise the limits** in `wrangler.toml`, redeploy. Worker stops thinking you're over quota; flag flips on next cron. (Make sure you actually have headroom on your Mapbox plan first — this Worker reflects reality, doesn't change it.)
