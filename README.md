# Fitness Tracker

A personal fitness dashboard connected to Strava. Built on Cloudflare (Worker + Pages), with a single-file frontend and an AI-generated monthly summary powered by Workers AI.

---

## Architecture

```
Strava API
   │
   ▼
Cloudflare Worker  (activities-api.lk-ff7.workers.dev)
   OAuth · activity fetch · gear lookup · GPS privacy · KV cache · AI summary
   │
   ▼
Cloudflare Pages   (activities-5z4.pages.dev)
   index.html — all UI, charts, map, filtering
   │
   ▼
Browser
```

The Worker holds all secrets and does all the heavy work. The Pages frontend is a static file that calls one endpoint and renders everything client-side.

---

## Files

| File | Purpose |
|------|---------|
| `worker.js` | Cloudflare Worker — OAuth, Strava fetch, GPS privacy trimming, KV caching, AI summary |
| `index.html` | Full dashboard frontend — all CSS, HTML, and JS in one file |
| `wrangler.toml` | Wrangler config for the Worker |
| `.github/workflows/deploy-worker.yml` | Auto-deploys the Worker to Cloudflare on every push that touches `worker.js` or `wrangler.toml` |
| `activities.csv` | **Not committed** (in `.gitignore`) — personal Strava export, never goes to GitHub |

---

## Dashboard tabs

| Tab | What it shows |
|-----|---------------|
| Summary | Stats, year-over-year table, activity breakdown by type, recent activities, AI monthly summary, location pills |
| Map | Route heatmap — all GPS routes rendered as semi-transparent polylines on a dark basemap, coloured by sport type |
| Charts | Monthly distance, elevation, year-on-year bar chart, activity type doughnut |
| Heatmap | GitHub-style activity calendar |
| Records | Personal bests and highlights by sport type |
| Social | Kudos leaderboard |
| Gear | Bike and shoe mileage |
| Activity Log | Searchable, sortable full activity table |

---

## GPS privacy

Activities starting within **¼ mile of any configured home location** are handled server-side in the Worker:

- **Polylines** — the first and last GPS points within the exclusion radius are trimmed from the route before it reaches the browser. Routes appear to begin and end on a public road.
- **Start dots** — the start coordinate is snapped to the home zone centre at 3 decimal places (~100 m precision) rather than your exact door.
- The `near_home: true` flag is set on those activities so the frontend knows to exclude them from the location pills.

Home coordinates are stored as **Cloudflare Worker secrets** and never committed to GitHub.

---

## Cloudflare setup

### Worker secrets

Set these in the Cloudflare dashboard under **Workers & Pages → activities-api → Settings → Variables and Secrets** (use the Secret type):

| Secret name | Description |
|-------------|-------------|
| `STRAVA_CLIENT_ID` | Strava app client ID |
| `STRAVA_CLIENT_SECRET` | Strava app client secret |
| `STRAVA_REFRESH_TOKEN` | Obtained via the `/auth` → `/callback` OAuth flow (see below) |
| `HOME_LAT_1` | Latitude of home location 1 |
| `HOME_LNG_1` | Longitude of home location 1 |
| `HOME_LAT_2` | Latitude of home location 2 (optional) |
| `HOME_LNG_2` | Longitude of home location 2 (optional) |
| `HOME_LAT_3` … `HOME_LAT_5` | Additional home locations (optional) |
| `HOME_LNG_3` … `HOME_LNG_5` | Corresponding longitudes |

### Worker bindings

Also in Worker → Settings → Bindings:

| Binding | Type | Variable name |
|---------|------|---------------|
| KV namespace | KV | `CACHE` |
| Workers AI | AI | `AI` |

### KV namespace

The Worker caches all activity data under the key `activities_v2` with a 24-hour TTL. Force a fresh pull at any time with `?refresh=true`.

---

## Worker API routes

| Route | What it does |
|-------|-------------|
| `GET /activities` | Returns the cached activity envelope `{ data, aiSummary, updatedAt }` |
| `GET /activities?refresh=true` | Bypasses cache, re-fetches from Strava, regenerates AI summary |
| `GET /auth` | Redirects to Strava OAuth — run once to get a refresh token |
| `GET /callback` | Exchanges the OAuth code, shows the refresh token to copy |
| `GET /debug` | Raw Strava token diagnostic |

---

## Auto-deployment

### Frontend (index.html)

Cloudflare Pages watches the GitHub repo and deploys automatically on every push to `main`. No action needed.

### Worker (worker.js)

`.github/workflows/deploy-worker.yml` runs `wrangler deploy` automatically whenever `worker.js` or `wrangler.toml` changes on `main`.

**One-time setup:**

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → **Create Token**
2. Use the **Edit Cloudflare Workers** template → Create Token → copy the token
3. In GitHub: repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: paste the token

After that, every push that touches the Worker deploys automatically.

---

## One-time OAuth setup

Only needed once (or if your token is revoked):

1. Set `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` as Worker secrets.
2. In your Strava app settings, set **Authorization Callback Domain** to `activities-api.lk-ff7.workers.dev` (bare domain, no `https://`, no path).
3. Visit `https://activities-api.lk-ff7.workers.dev/auth` and authorise.
4. Copy the refresh token from the confirmation page.
5. Save it as the `STRAVA_REFRESH_TOKEN` secret.
6. Test: `https://activities-api.lk-ff7.workers.dev/activities` should return a JSON envelope with a `data` array.

---

## Location pills

The Summary tab shows a **Locations Found in Activities** section. This is generated dynamically:

- Activities flagged `near_home: true` are excluded (they're home, not interesting).
- Remaining activities with GPS coordinates are grouped by lat/lng rounded to 2 decimal places (~1 km grid).
- Each unique location group is reverse-geocoded via the [Nominatim](https://nominatim.openstreetmap.org/) API at zoom level 8 (county/region level).
- Results are cached in `localStorage` under the key `nominatim_v1` so geocoding only runs once per new location.
- Pills are sorted by activity count and labelled with the geocoded region name.

Geocoding runs in the browser with a 1.1-second delay between requests to respect Nominatim's rate limit.

---

## AI monthly summary

The Worker aggregates the last 30 days of activity data and sends it to `@cf/meta/llama-3.2-3b-instruct` via Workers AI. The model returns a short coaching summary displayed in the Summary tab. It is regenerated on every forced refresh and cached alongside activity data.

---

## Design

- **Font:** Plus Jakarta Sans (Google Fonts)
- **Icons:** Material Symbols Rounded (Google Fonts)
- **Map:** Leaflet 1.9.4 with CARTO Dark Matter tiles
- **Charts:** Chart.js 4.4.1
- **Accent colour:** `#ff385c`
- **Sport colours:** Ride `#1d4ed8` · Run `#ef4444` · Walk `#eab308` · Swim `#0ea5e9` · Virtual `#60a5fa`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Map shows nothing after sync | Worker may not have been deployed with the new code — check GitHub Actions ran successfully, then hit refresh in the app |
| Location pills show "Sync to load" | Data in KV cache pre-dates the `near_home` field — force a refresh with the ↻ button |
| OAuth redirect_uri error | Strava app Authorization Callback Domain must be exactly `activities-api.lk-ff7.workers.dev` (no `https://`, no `/callback`) |
| `/activities` returns empty array | Token refresh failing — visit `/debug` for raw Strava response |
| `X-Cache: MISS` every request | KV namespace not bound — check Worker → Settings → Bindings for a `CACHE` binding |
| GitHub Actions deploy fails | `CLOUDFLARE_API_TOKEN` secret missing or expired — regenerate and re-add in repo Settings → Secrets |
| AI summary stale | Force regeneration: `https://activities-api.lk-ff7.workers.dev/activities?refresh=true` |
