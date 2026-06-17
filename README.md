# 💪 Fitness Tracker with AI Coach

A high-performance, serverless fitness dashboard that pulls activity data from Strava and utilizes Cloudflare Workers AI to provide automated, intelligent, and context-aware coaching insights.

---

## 🏗️ Technical Architecture

The app is split across three Cloudflare services:

```
Strava API
   │
   ▼
Cloudflare Worker (activities-api)        ← API proxy + OAuth + AI Inference + KV cache
activities-api.lk-ff7.workers.dev
   │
   ▼
Cloudflare Pages (activities-5z4.pages.dev)   ← Static frontend
   │  index.html (dynamic AI text injection)
   ▼
Your browser
```

**Why split?** Cloudflare Pages serves static assets but cannot hold secrets. The Worker holds the Strava credentials, calls the Strava API, runs AI inference on edge, and exposes a single `/activities` endpoint the frontend calls with enriched data.

---

## 🤖 New Feature: Edge AI Coaching

We have added a server-side AI aggregation layer. Instead of just returning raw activity lists, the Worker now performs pre-inference math to analyze your lifetime performance metrics and injects them into a large language model.

### How it works

**Pre-Aggregation (The "Crunch"):** The worker iterates through your entire cached Strava history (thousands of activities) in pure JavaScript to calculate career totals, primary sports, and maximum heart rate metrics. This happens in milliseconds with zero token cost.

**Prompt Engineering:** These aggregated metrics are packaged into a high-context prompt alongside your 5 most recent activities.

**Edge Inference:** The worker calls `@cf/meta/llama-3.2-3b-instruct` to generate a personalized 3-sentence summary of your fitness momentum.

**Frontend Injection:** The frontend receives a JSON "envelope" containing both the raw data and the generated `aiSummary` string, which is dynamically injected into the `ai-box` UI element.

### Worker Code Snippet

The core logic resides in the `generateAiSummary` function added to `worker.js`:

```javascript
async function generateAiSummary(activities, env) {
  // 1. Aggregates historical metrics (Total miles, favorite sports, etc.)
  // ... (JS aggregation logic) ...
  // 2. Formats recent activities for context
  // 3. Runs edge inference
  const aiResponse = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });
  return aiResponse.response;
}
```

### Prompt Template

**System Prompt:**

> You are a realistic, data-driven fitness analyst. Your goal is to provide a grounded, punchy, and strictly factual 3-sentence summary of a hobbyist athlete's performance. CRITICAL RULES: 1. Avoid all flowery, grandiose, or superlative language (e.g., no 'cementing your legacy' or 'one of the most accomplished'). 2. Be precise with data: NEVER assume an activity type. If the data says 55,000 miles, but only 3,000 are walking, do not claim the miles were 'walked'. 3. Maintain a supportive but neutral, 'just the facts' tone. 4. Do not use bolding or markdown symbols.

**User Prompt:**

> Overall Career Stats:
> - Total Workouts: ${totalWorkouts}
> - Total Distance: ${Math.round(totalMiles)} miles
> - Primary Sport: ${favoriteSport}
> - Sport Breakdown: ${JSON.stringify(sportCounts)}
> 
> Recent Activities (5 most recent):
> ${recentDataStr}
> 
> Task: Write a 3-sentence summary. If the total distance is high, acknowledge the consistency over time without assuming specific activity types for the whole distance. If the recent data shows cycling, focus on that.

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
| `GET /activities` | Returns all activities as JSON with `aiSummary` (cached in Workers KV for 24 hours) |
| `GET /activities?refresh=true` | Bypasses the cache, fetches fresh from Strava, and regenerates AI summary |
| `GET /debug` | Raw Strava token + activity diagnostic — useful when troubleshooting |

### Caching

Activity data is stored in **Workers KV** under the key `activities_v2` with a 24-hour TTL. The response includes an `X-Cache: HIT` or `X-Cache: MISS` header so you can tell whether you got cached data. Force a refresh with `?refresh=true`.

### HR zone estimation

Strava's list API doesn't return per-second HR data, so zone splits are **estimated** using a normal distribution centred on `average_heartrate` with spread derived from `max_heartrate`. Boundaries come from your configured Strava athlete zones (falling back to standard % of max HR if not set). This is accurate for steady-state efforts; interval sessions will underestimate zone 5.

### Gear names

The Strava list API returns a `gear_id`, not the name. The Worker resolves each unique gear ID with one extra API call per item and stores the result on the activity object.

---

## ⚙️ Cloudflare Setup

### Worker — `activities-api`

**URL:** `https://activities-api.lk-ff7.workers.dev`

**Required secrets** (Worker → Settings → Variables and Secrets):

| Name | Type | Value |
|---|---|---|
| `STRAVA_CLIENT_ID` | Secret | Your Strava app client ID |
| `STRAVA_CLIENT_SECRET` | Secret | Your Strava app client secret |
| `STRAVA_REFRESH_TOKEN` | Secret | Obtained via the `/auth` → `/callback` flow |

**KV namespace:** The Worker reads `env.CACHE` — bind a KV namespace named `CACHE` in the Worker → Settings → Bindings.

**AI Binding:** In addition to the above, your worker now requires the AI binding to be enabled:
- Type: **AI**
- Variable Name: **AI**

**wrangler.toml:** Ensure your `wrangler.toml` includes the AI service binding:

```toml
[ai]
binding = "AI"
```

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
| "Coach breakdown unavailable: 5028" | The model name has changed. Ensure you are using `@cf/meta/llama-3.2-3b-instruct` in `worker.js` |
| AI Summary is stale | Trigger a fresh calculation by visiting `https://activities-api.lk-ff7.workers.dev/activities?refresh=true` |
| "Summary payload empty" in UI | Verify your frontend JS is accessing `envelope.aiSummary` and not just the raw data array |
| AI binding not found | Check Worker → Settings → Bindings for an **AI** binding, and ensure `wrangler.toml` includes `[ai]` section |
