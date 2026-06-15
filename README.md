# Fitness Tracker

A personal fitness dashboard that pulls activity data from Strava and displays it as an interactive web app — charts, heatmaps, zone breakdowns, PR timelines, and more.

---

## Architecture

The app is split across two Cloudflare services:

```
Strava API
   │
   ▼
Cloudflare Worker (activities-api)        ← API proxy + OAuth + KV cache
activities-api.lk-ff7.workers.dev
   │
   ▼
Cloudflare Pages (activities-5z4.pages.dev)   ← Static frontend
   │  index.html pulled from GitHub
   ▼
Your browser
```

**Why split?** Cloudflare Pages serves static assets but cannot hold secrets. The Worker holds the Strava credentials, calls the Strava API, and exposes a single `/activities` endpoint the frontend calls.

---

## Files

| File | What it is |
|---|---|
| `worker.js` | The Cloudflare Worker — Strava OAuth, activity fetching, KV caching |
| `index.html` | The full dashboard frontend — charts, filters, heatmaps, tabs |
| `activities.csv` | Strava bulk export (legacy seed data — the Worker now fetches live) |
| `design-dark.html` | Design explorations (not in production) |
| `design-glass.html` | Design explorations (not in production) |
| `design-minimal.html` | Design explorations (not in production) |

---

## How it works

### Worker routes

| Route | Purpose |
|---|---|
| `GET /auth` | Redirects to Strava OAuth — run once to get your refresh token |
| `GET /callback` | Exchanges the OAuth code and shows you the refresh token to save |
| `GET /activities` | Returns all activities as JSON (cached in Workers KV for 24 hours) |
| `GET /activities?refresh=true` | Bypasses the cache and fetches fresh from Strava |
| `GET /debug` | Raw Strava token + activity diagnostic — useful when troubleshooting |

### Caching

Activity data is stored in **Workers KV** under the key `activities_v2` with a 24-hour TTL. The response includes an `X-Cache: HIT` or `X-Cache: MISS` header so you can tell whether you got cached data. Force a refresh with `?refresh=true`.

### HR zone estimation

Strava's list API doesn't return per-second HR data, so zone splits are **estimated** using a normal distribution centred on `average_heartrate` with spread derived from `max_heartrate`. Boundaries come from your configured Strava athlete zones (falling back to standard % of max HR if not set). This is accurate for steady-state efforts; interval sessions will underestimate zone 5.

### Gear names

The Strava list API returns a `gear_id`, not the name. The Worker resolves each unique gear ID with one extra API call per item and stores the result on the activity object.

---

## Cloudflare setup

### Worker — `activities-api`

**URL:** `https://activities-api.lk-ff7.workers.dev`

**Required secrets** (Worker → Settings → Variables and Secrets):

| Name | Type | Value |
|---|---|---|
| `STRAVA_CLIENT_ID` | Secret | Your Strava app client ID |
| `STRAVA_CLIENT_SECRET` | Secret | Your Strava app client secret |
| `STRAVA_REFRESH_TOKEN` | Secret | Obtained via the `/auth` → `/callback` flow |

**KV namespace:** The Worker reads `env.CACHE` — bind a KV namespace named `CACHE` in the Worker → Settings → Bindings.

### Pages — `activities-5z4`

**URL:** `https://activities-5z4.pages.dev`

Connected to GitHub — `index.html` is deployed automatically on every push to `main`.

---

## One-time OAuth setup (getting your refresh token)

You only need to do this once (or if your token is revoked):

1. Make sure `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` are set as Worker secrets.
2. Make sure `WORKER_URL` at the top of `worker.js` is set to `https://activities-api.lk-ff7.workers.dev`.
3. Make sure the Strava app's **Authorization Callback Domain** is `activities-api.lk-ff7.workers.dev` (bare domain — no `https://`, no `/callback`).
4. Visit `https://activities-api.lk-ff7.workers.dev/auth` in your browser.
5. Authorise the app on Strava.
6. Copy the refresh token from the confirmation page.
7. Add it as a secret named `STRAVA_REFRESH_TOKEN` in the Worker settings.
8. Test: visit `/activities` — you should get a JSON envelope with a `data` array.

---

## Redeploying after changes

**Worker (`worker.js`):** commit to `main` and push — GitHub Actions deploys automatically (once wrangler.toml and GitHub secrets are wired up; see below).

**Frontend (`index.html`):** Cloudflare Pages watches the GitHub repo and redeploys on every push to `main`.

---

## GitHub Actions deployment (worker)

Add a `wrangler.toml` (see the other projects in this repo for the pattern) and set two GitHub repository secrets:

- `CF_API_TOKEN` — Cloudflare → My Profile → API Tokens → **Edit Cloudflare Workers** template
- `CF_ACCOUNT_ID` — visible in the right sidebar on any Workers & Pages page

Then every push to `main` deploys the Worker via `.github/workflows/deploy.yml`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Strava OAuth redirect_uri error | Check (1) `WORKER_URL` in `worker.js` matches `https://activities-api.lk-ff7.workers.dev` exactly, and (2) Strava app → Authorization Callback Domain is `activities-api.lk-ff7.workers.dev` (bare domain, no protocol, no path) |
| `/activities` returns an empty array | Token refresh may be failing — visit `/debug` for the raw Strava response |
| `X-Cache: MISS` every time | KV namespace not bound; check Worker → Settings → Bindings for a `CACHE` binding |
| After editing in the dashboard, changes not live | You must click **Deploy**, not just Save — they are different actions |
| Frontend can't reach the Worker | CORS headers are set to `*` in the Worker; if blocked, check the browser console for the exact error |
| HR zone splits look wrong | Expected for interval sessions — the estimation is less reliable when avg HR is much lower than peak HR. Steady efforts (long rides, tempo runs) are more accurate |
