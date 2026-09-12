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
| `worker.js` | Cloudflare Worker — OAuth, Strava fetch, GPS privacy trimming, KV caching, AI summary, Zwift Routes proxy, and the scheduled Strava → Notion Training Log sync |
| `index.html` | Full dashboard frontend — all CSS, HTML, and JS in one file |
| `wrangler.toml` | Wrangler config for the Worker |
| `.github/workflows/deploy-worker.yml` | Auto-deploys the Worker to Cloudflare on every push that touches `worker.js` or `wrangler.toml` |
| `activities.csv` | **Not committed** (in `.gitignore`) — personal Strava export, never goes to GitHub |

---

## Dashboard tabs

| Tab | What it shows |
|-----|---------------|
| Summary | Stats, year-over-year table, activity breakdown by type, recent activities, AI monthly summary, location pills |
| Map | Route heatmap — all GPS routes rendered as semi-transparent polylines on a dark basemap, coloured by sport type — plus **route replay** and **Ground covered** (see below) |
| Charts | Monthly distance, elevation, year-on-year bar chart, activity type doughnut, heart-rate zones, Relative Effort and time of day |
| Heatmap | GitHub-style activity calendar, with every prior year listed beneath |
| Records | Personal bests and highlights by sport type, including swims |
| Mex | Mex Score — the ladder of whole-unit distance buckets, the first gap, and which gaps are worth most (see below) |
| Social | Partner leaderboard plus real group sizes from Strava's participant count |
| Gear | Bike and shoe mileage, with a wear bar on running shoes |
| Activity Log | Searchable, sortable full activity table |
| Zwift Routes | Live two-way view of the "Zwift Routes" Notion database, grouped by map. Route catalog (name, map, distance, elevation, links) is read-only, managed in Notion; Status/Date completed/Time can be edited from the app and are written straight back to Notion |

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
| `NOTION_API_KEY` | Internal integration secret from a Notion integration (`notion.so/my-integrations`). Needs **Read**, **Update** *and* **Insert** content capabilities — Insert is what lets the Training Log sync create rows, and without it every sync fails with a permission error. Share it with **both** the "Zwift Routes" **and** the "Training Log" databases via each one's `•••` → Connections menu |

### Worker bindings

Also in Worker → Settings → Bindings:

| Binding | Type | Variable name |
|---------|------|---------------|
| KV namespace | KV | `CACHE` |
| Workers AI | AI | `AI` |

### KV namespace

The Worker caches all activity data under the key `activities_v2` with a 24-hour TTL. Force a fresh pull at any time with `?refresh=true`.

**The cron keeps it warm.** Each scheduled run refreshes that cache after the Notion
sync, so the dashboard is current when you open it rather than serving up-to-24-hour-old
data — and you never land on the slow first visit that pays a full Strava pull because the
TTL lapsed. Fires run at most 9 hours apart against a 24-hour TTL, so in normal operation
the entry never actually expires; the TTL is the safety net, not the refresh mechanism.

The scheduled refresh does **not** regenerate the AI summary. The dashboard no longer
renders it, so regenerating three times a day would be paying Workers AI for output nobody
reads; the existing summary is carried forward rather than overwritten with the
placeholder, so a `?refresh=true` from the ↻ button is still the thing that renews it.

Zwift route data is cached under `zwift_routes_v1` with a short 2-minute TTL (Notion is the source of truth, so this cache only absorbs repeated tab opens — it's deleted immediately on every successful edit).

---

## Worker API routes

| Route | What it does |
|-------|-------------|
| `GET /activities` | Returns the cached activity envelope `{ data, aiSummary, updatedAt }` |
| `GET /activities?refresh=true` | Bypasses cache, re-fetches from Strava, regenerates AI summary |
| `GET /auth` | Redirects to Strava OAuth — run once to get a refresh token |
| `GET /callback` | Exchanges the OAuth code, stores the refresh token in KV, and shows it for the secret |
| `GET /debug` | Strava connection diagnostic — reports whether the token refresh worked and returns five activities. Never echoes the token response itself: this route has no auth |
| `GET /sync-training-log` | Runs the Strava → Notion Training Log sync now, and returns `{ checked, created, skipped, relinked, failed, errors }`. Also runs automatically on the cron |
| `GET /backfill-prs` | Collects one slice (40) of segment PBs from Strava's best-efforts and refreshes the cache. Returns `{ checked, found, remaining }`. Also runs automatically on the cron — see **Segment PBs** below |
| `GET /zwift-routes` | Returns the cached Zwift routes envelope `{ data, updatedAt }`, proxied live from Notion |
| `GET /zwift-routes?refresh=true` | Bypasses cache, re-fetches all routes from Notion |
| `PATCH /zwift-routes/{pageId}` | Updates `status`/`date_completed`/`time` on one route, writes straight to Notion |

---

## Training Log sync

Strava activities are written into the **Training Log** Notion database three
times a day (`[triggers] crons` in `wrangler.toml`, plus `GET /sync-training-log`
to run it on demand). This replaced a Zapier automation that stopped firing.

The same cron then warms the activities cache (see **KV namespace** above). The two run
**in sequence, not in parallel** — both talk to Strava, whose rate limit is per-15-minutes,
so firing them together is the one reliable way to trip it. Each is wrapped separately, so
a failure in the sync still leaves the refresh to run, and vice versa.

Each run looks back three days — a generous margin so a late GPS-watch upload,
or a missed cron, is picked up on the next pass rather than lost. Rows are
matched on the **URL** property, which holds the Strava activity link on every
row Zapier ever created, so re-running is safe: anything already there is
skipped and **never patched**. Edits you make in Notion are never overwritten.

`Gear` and `Events` are relations that need real judgement, so the sync leaves
them empty for you to link by hand, exactly as before.

### The Diary relation

Each row's `Diary` relation is pointed at the diary page for the day the
activity actually happened, matched on the Diary database's `Date` property
against Strava's `start_date_local`. It is also **re-checked on every pass**,
and corrected if it disagrees — the one place the sync writes to a row it did
not just create.

That exception is load-bearing, for two reasons that both defeat setting it
once at creation:

- The diary page for a day usually doesn't exist yet when the activity syncs.
  You run at 07:00 and write the day up at 22:00, so a link set at creation
  would be empty far more often than not.
- A Notion automation on this database attaches **today's** diary page to every
  newly created row, whatever day the activity is from. A backfill run
  therefore lands three days of activities all pointing at today.

A row is only written when its current link disagrees with its own date, so a
link you set by hand is never touched, and a day with no diary page yet is left
alone rather than cleared — the next run inside the lookback window picks it up
once you've written the day. The run summary reports these as `relinked`.

### Two things that will silently stop it

- **Notion capabilities.** Creating a row needs the integration's **Insert
  content** capability, and the integration has to be shared with the Training
  Log database itself. Neither is implied by the Zwift Routes setup. Symptom: a
  sync where `created` is 0 and `failed` equals `checked`.
- **Property names are the plain ones.** Notion's MCP server displays the URL
  property as `userDefined:URL`, because it namespaces any user property whose
  name collides with one of its own system columns. That prefix is an MCP
  display detail; `api.notion.com` knows the property only as `URL`, and
  sending the prefixed form is an unknown-property validation error. If you
  ever regenerate this mapping from an MCP schema dump, strip the prefix.

### Start times

`Start time` is written from Strava's `start_date`, the true UTC instant — not
`start_date_local`. Strava returns `start_date_local` as local time carrying a
fake `Z` suffix (`2026-08-31T07:56:41Z` for an 07:56 BST run), so passing it
straight to Notion stores 07:56 UTC and renders **08:56** in a UK workspace: an
hour late for the whole of BST, and correct only in winter. Every Zapier-era row
holds true UTC, which is what makes Notion display the right local time.

The local date is still what decides which diary day a row belongs to, and that
is read off `start_date_local` in the sync loop — the one place the local field
is the right one.

### Activity fields

`transformActivity` in `worker.js` maps Strava's summary object to the compact
shape the dashboard caches. Six fields were being fetched and then dropped on
the floor; they are kept now:

| Field | Source | Used by |
|-------|--------|---------|
| `time` | `start_date_local.slice(11,16)` — local clock, "HH:MM" | Charts → When you train; the Log's date cell |
| `et` | `elapsed_time` | The Log's "+Nm stopped" line (`et − mt`) |
| `cad` | `average_cadence` | The Log's cadence line. Strava reports **one leg's** rpm for foot sports, so `cadenceLabel()` doubles it to spm for runs and walks |
| `athletes` | `athlete_count` | Social group-size cards and the solo/with-others chart |
| `commute` | `commute` | The Log's commute marker |
| `wtype` | `workout_type` — 1 = race (run), 11 = race (ride) | The Log's RACE marker |

These only appear on activities cached **after** the change. Anything relying on
them checks for the field's presence and says so on screen rather than reporting
a zero — `renderExtraCharts` shows "Start times arrive with the next Strava
refresh", `renderSocialStats` renders nothing rather than claiming everything
was solo. `wasSocial()` falls back to the old title regex for older entries.

### Segment PBs (best-efforts)

The Records tab has six distance PB slots — 1 km, 1 mile, 5 km, 10 km, half,
marathon — that sat empty since it was written, because Strava's **list**
endpoint omits `best_efforts` entirely. They come back only from
`GET /activities/{id}`, one request per activity, against a limit of 100
requests per 15 minutes and 1,000 a day.

So they are collected gradually:

- `best_efforts_v1` in KV maps activity id → `{pr_1km, pr_1mi, …}`, or `null`
  meaning *asked, this activity has none*. It has **no TTL** — re-deriving an
  entry costs a Strava request.
- Each cron run takes the `BEST_EFFORTS_BUDGET` (40) newest runs not yet in the
  store, four at a time. Three crons a day is ~120 requests — well inside the
  limit. A few hundred runs are covered within a week.
- Only `Run`, `TrailRun` and `VirtualRun` are asked about. A ride has no best
  efforts, so asking would waste a request.
- A 404 (deleted or no longer readable) is recorded as `null` so it is never
  asked about again. A 429 or a 5xx is **left out of the store entirely**, so
  the next run retries it.
- `applyBestEfforts` writes whatever has been collected onto every cache
  refresh, which costs one KV read. Only the cron spends Strava requests, so a
  page load never waits on this.

`GET /backfill-prs` runs a slice on demand and returns
`{checked, found, remaining}` — call it again in fifteen minutes for the next
slice. The Records tab says how many runs have been checked so far rather than
silently showing fewer cards than it has slots for.

### Sport types

The Training Log's `Type` property has eight options: Swim, Run, TrailRun,
Ride, VirtualRide, Walk, Workout, Rowing. Strava's `sport_type` vocabulary is
much larger, and Notion **creates** a select option for any name it doesn't
recognise rather than rejecting it — so a Hike or a WeightTraining session adds
a new option to the property and shows up in the Diary app with the generic
icon (it maps types by name). Nothing breaks; the list just grows. Fold new
sports onto an existing option in `buildTrainingLogProperties` if you'd rather
it didn't.

---

## Gear photos

Strava's API does not expose gear pictures, so `GEAR_IMAGES` in `index.html` maps each
item's Strava nickname to an image by hand. The provenance for those files is the
**Product photos** sheet in Drive, which lists each item beside the page its picture came
from.

Matching is **normalised** — lowercased with punctuation and spaces stripped — so
`Salomon S-LAB 2` and `Salomon S/Lab 2` resolve to the same entry and a rename in Strava
no longer silently drops the photo. It is not fuzzy, though: `Karrimor Skiddaw` and
`Karrimor Skiddaw Hiking Boots` are still different keys. The key must match the nickname
Strava actually returns.

Where one item is known by two names, add both keys pointing at the same file rather than
picking a winner — `Eddy Merckx` and `Merckx EMX-3` are one bike and share
`merckx-emx-3.jpg`.

An item with no entry, or whose picture fails to load, falls back to a tile carrying its
sport icon — derived from the activities logged against it, not from its name. The tile is
the same 110px block as a photo, so cards stay level either way.

### The three remote entries

`Rose`, `Barbour Wellies` and `Under Armour UA Thrill 3` currently **hotlink to
third-party CDNs** rather than sitting in `gear-images/`. That is a stopgap: those URLs
are someone else's bandwidth, they rotate without notice, and some hosts refuse requests
carrying a foreign `Referer`. The Under Armour one is a Google Images thumbnail-cache
address and is the least durable of the three.

To finish the job properly, download each into `gear-images/` and move its entry up into
the local block:

```sh
curl -L -o gear-images/rose.jpg \
  'https://www.cycleexchange.co.uk/cdn/shop/files/70959481-001.jpg?v=1733400261'
curl -L -o gear-images/barbour-wellies.jpg \
  'https://media.johnlewiscontent.com/i/JohnLewis/004999350alt1?fmt=auto'
curl -L -o gear-images/under-armour-ua-thrill-3.jpg \
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS5wY6VS80V-woI10KU9YfYvQYc9oN0iPfqP-tDacNOiQ&s'
```

Then check each file is actually an image (`file gear-images/*.jpg`) — a hotlink refusal
often arrives as an HTML error page with a `.jpg` name.

---

## Mex Score

A Mex is one activity at **every whole-unit distance in ascending order**. Your Mex is the
highest unbroken rung before the first gap: if you have something at 1, 2, 3 … 17 but
nothing between 18.0 and 18.9, your Mex is 17.

Three rules decide the number:

- **Rounded down, never to nearest.** A 14.7 mi run fills bucket 14, not 15.
- **One activity fills one bucket.** A second 12 mi ride adds nothing.
- **The low end governs everything.** A single missing bucket caps you however far you
  have ridden. This is the point of the challenge, and it is why the tab leads with the
  gap list rather than the number — the number alone is not something you can act on.

The **Fill these in order** panel is the useful part. Filling one gap raises your Mex to
*(the next gap above it) − 1*, so gaps are worth wildly different amounts: clearing 18
might be worth +7 while clearing 37 is worth +1. Each row assumes every gap above it is
already filled.

### Unit, filters and scope

Mex **follows the mi/km switch in the header**, so it is a different number in each — only
the km figure is comparable with other riders, and the tab says so. The year and sport
filters narrow it; all time, all sports is the headline figure.

**Mex by sport** uses strict groups — Virtual is kept out of Ride, unlike the header
filter, which folds them together. Expect low numbers there: a sport reads 0 until it has
an activity in every bucket from 1 up, and hardly anyone rides 1 mile.

Everything is computed in the browser from the existing `dist_mi` / `dist_km` fields. No
Worker change was needed. One caveat: `dist_km` is stored to two decimals, so an activity
of 6.996 km is saved as `7.00` and fills bucket 7 rather than 6 — roughly one activity in
a thousand, only ever at a boundary.

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
- **Corners:** square everywhere. `--radius` and `--radius-sm` are both `0`; nothing in the app rounds, including pills, dots and the favicon. Keep new work sharp.
- **Shadows:** `--shadow` is the standard card lift. `--shadow-callout` is heavier and reserved for call-out boxes — the AI summary and the sync warning — so they lift off the page without needing a colour fill.
- **Labels:** sentence case. No `text-transform: uppercase` and no letter-spacing on labels, per the house rule across the tools.
- **Card colour:** one rule — a 3px `border-top` in the relevant colour. Not a left border, not a `::before` bar. An uncoloured card uses `var(--border)` so it keeps the same height.
- **Motion:** four animations, and each one points at something. The Mex ladder builds left to right on arrival at the tab (not on a filter re-render — `mexAnimate` is set by `setTab` and cleared by `renderMex`, so a re-render reusing the same DOM doesn't replay it). The first-gap cell keeps a slow pulse because it is the one cell that is a to-do. Prior heatmap years fade up as you scroll to them, via an IntersectionObserver that unobserves each element once fired. Cards in the first grid of a tab come in as a short left-to-right run when you switch to it, capped at eight steps of 26ms — `staggerCards` runs *after* `renderAll`, because `renderAll` replaces the grid's `innerHTML`, and removes the class after 700ms so a filter change is instant. All four are switched off wholesale under `prefers-reduced-motion`, which also drops every transition to 0.01ms.

---

## The Map page

The map and its controls are **one object**: a single toolbar sharing the map's
border, then the map itself with its overlays.

It used to be three strips stacked above the map in three different treatments —
a bare legend-and-fade row, a row of eight jump pills, and a bordered, shadowed
replay bar. Measured in a browser, that was **116px of controls above the map**,
and 148px below about 1150px where the pills wrapped to a second row. It is 50px
now. But the height was the smaller half of the problem: nothing grouped by
function. Fade is a display control that sat with the legend, which is
information; navigation had its own strip; replay a third.

- **Go to** — Home keeps a button because it is the one you press. The other
  seven jump locations collapse into one select, which resets to its prompt after
  a jump so picking the same place twice still fires.
- **Replay** — picker and button together, the button beside the thing it acts on.
- **Fade** — the tile-opacity slider, now grouped as the display control it is.
- **Legend** — moved onto the map, bottom-left, where legends belong and where it
  costs no layout height. Being free of the layout, it also carries a count per
  sport.
- **Readout** — only while something is playing, bottom-right on the map. An empty
  status line under the toolbar was one more thing taking space and saying nothing.

On a phone it wraps to exactly **two** rows: Home, Elsewhere and Fade on the
first (Home drops to its icon, the slider to 64px), the replay picker and its
button on the second. Three rows would have been 155px — no better than the
strips it replaced.

### What the replay picker offers

Both notable and recent routes, in one list, Notable first. Every line is
computed from data already in the payload — nothing to configure, nothing extra
to fetch. It replaces the old rule, which was the 60 longest routes, so the
picker always opened on the same monster ride and there was no way to reach last
Tuesday.

| Category | From |
|----------|------|
| Race | `workout_type` 1 or 11, most recent first |
| Most new ground | the cell-counting walk `renderExplored` already does |
| Furthest out | great-circle distance from home, 25-mile floor |
| Biggest climb | `elv` |
| Longest | `dist_mi` |
| Fastest | `speed_mph`, 10-mile floor so it isn't a downhill sprint |

**Order is load-bearing.** The first category to claim a ride keeps it, and one
ride is often the winner of several — your biggest climb may also be the furthest
from home. Rarest fact first: a race is a thing that happened, "fastest" is a
superlative any ride can hold, so Fastest yields last rather than swallowing the
race. When a category's winner is already taken it falls to the **runner-up**
rather than the row silently disappearing, which is what an earlier version did.

"Most new ground" gets its ranking from `renderExplored` rather than repeating
the walk — `_exploreBestNew` holds the top five by proportion, and the picker is
rebuilt once that deferred pass finishes.

Routes split into segments by a privacy zone are excluded: the marker would jump
the gap. Fixed 9-second trace, not real time. Under `prefers-reduced-motion` the
whole route draws at once rather than not at all. `setTab` calls `stopReplay()`
when you leave the Map, so the `requestAnimationFrame` loop never runs behind a
tab you cannot see.

---

## Ground covered

On the Map tab, under the map itself. Every route point is dropped into a fixed
grid and the distinct cells counted. A cell is `CELL_DEG` = 0.003° of latitude —
about 330 m — coarse enough that the same road ridden twice is one cell, fine
enough that the next valley is a new one. Longitude is divided by
`cos(latitude)` so cells stay roughly square rather than stretching east-west.

Activities are walked in date order, so "new" always means new relative to
everything before it. Per-activity cell sets are memoised in a `WeakMap`, so a
filter change re-counts without re-decoding every polyline.

"Furthest from home" is a great-circle distance from `HOME_CENTER` (the
Longridge town centre constant, not an address) and skips `near_home`
activities, whose coordinates are deliberately snapped.

The area figure is cells × (0.003 × 69)² square miles. It measures ground
*touched*, not ground *seen* — a road through a cell claims the whole cell.

---

## Heart-rate zones

The zone chart on the Charts tab is **estimated, not measured**, and the
subtitle says so on screen — including which of the two sources below it used.
Strava's bulk activity endpoint returns one average heart rate per activity, not
the stream, so `estimateZones()` models the distribution as a normal curve around
that average and integrates it across the zone boundaries.

Two different numbers do two different jobs, and getting them the wrong way round
is what made the first version wrong:

| Number | Job |
|--------|-----|
| **Athlete max HR** | Sets *where the zone boundaries sit* — 60/70/80/90% of it |
| **That activity's peak HR** | Sets *how wide that activity's heart rate ranged* |

The original code passed each activity's own peak as the ceiling, so every
boundary became a percentage of that day's high. An average always sits close to
its own day's peak, so it landed near the top of its own private scale: a
recovery spin at 118 bpm scored **90% in zones 4 and 5**, and the all-time chart
read 31% Z5.

The spread was backwards too. `σ = (ceiling − average)/1.5` gave an *easy* ride a
*wider* spread than a hard one, smearing its time across every zone. It is now
`(activity peak − average) / 2.5` — the peak of a longish sample sits roughly 2.5
standard deviations above its mean, so the two numbers Strava gives us estimate
the spread directly. A steady ride peaking 15 bpm over its average comes out
tight; a session with real intervals peaking 60 over comes out wide.

**Where the ceiling comes from.** `/athlete/zones` needs the `profile:read_all`
scope. The app asked only for `activity:read_all`, so `fetchAthleteZones` always
returned null and the real-zones branch was dead code — which is why the bug went
unnoticed. `deriveAthleteMaxHr()` now takes the **99th percentile** of
`max_heartrate` across your whole history (not the outright maximum: across
thousands of activities a few strap dropouts read 220+, and one bad contact
shouldn't set the scale for a decade).

`profile:read_all` has been added to the OAuth scope, so re-running `GET /auth`
will pick up your real configured zones and the chart will say so. Until then it
says it is using a derived max and prints the figure. The envelope carries
`hrZones: {athleteMaxHr, source}` so the page can state its own provenance rather
than asserting "your Strava zones" either way.

The five buckets are rescaled to sum to moving time, since the curve's tails fall
outside the zone range.

---

## Activity detail modal

Clicking a Recent Activities row on the Summary, or any row in the Activity Log,
opens the activity. It reuses the gear modal's shell — same backdrop, head, stats
grid and section titles — so the two read as one idea rather than two designs.

The header is a **map of the route**, drawn with Leaflet from the stored polyline,
with a green start dot and a red finish dot so a loop can be told from a
point-to-point at a glance. Two cases fall back to the sport tile instead of an
empty grey box, and each says which it is:

- **Starts near home** — the route is deliberately trimmed (see GPS privacy), so
  there is nothing to draw. The modal also carries a "Starts near home · route
  trimmed" marker, rather than implying the activity had no GPS.
- **No GPS at all** — a turbo session, a pool swim, a treadmill run.

The map is **rebuilt on every open, not reused**: setting `innerHTML` destroys the
container it was mounted in, and Leaflet leaks listeners if the container vanishes
without `remove()` being called. `destroyActMap()` runs on open and on close, and
the map is created inside a `requestAnimationFrame` after the backdrop is shown so
Leaflet measures a laid-out container instead of coming up zero-sized.

Below it: every field the activity has, and only those it has — a row is omitted
rather than printed as an em dash. Stopped time appears only when it is at least a
minute; pace for foot sports, speed for everything else. Then the heart-rate zone
split as a single stacked bar in the same colours the Charts tab uses, carrying the
same "estimated, not measured" caveat; any segment bests recorded on that activity;
and three actions — Strava, jump to that item's gear, find it in the log.

One delegated click handler on `document` covers both surfaces and survives every
re-render. It returns early on `closest('a,button')`, so the Strava link and the
buttons inside a row keep their own behaviour instead of opening the modal.

---

## Figure chips and verdicts

The heart-rate zone card set a pattern worth reusing: tinted figure chips under
the plot, then one plain-English line saying what the shape *means*.
`chartSummary(id, chips, verdict)` renders both; `.chart-chips` and
`.chart-verdict` collapse when empty, so a filter that leaves a chart with
nothing to say leaves no gap.

Applied to Monthly Distance, Elevation, Activity Mix (chips only — the donut is
its own verdict), Relative Effort and When You Train. **Deliberately not** applied
to Calories or Year-over-Year: a chip reading "total calories" under a chart of
monthly calories is the axis restated, and the verdict would have to be invented.
A chart earns these only when there is something true and non-obvious to say.

Scope discipline matters here — the first version of the elevation chips divided
all-time climbing by 24-month distance and reported nearly double the real
ft-per-mile. Every figure in a chip is now summed over the same `monthKeys` the
chart itself draws, and the distance chip says "last 24 months" rather than
calling a two-year figure a total.

---

## Zwift routes ↔ virtual rides

Zwift writes the route name into the activity title, so `zwiftRiddenIndex()`
joins the Notion route catalogue to your VirtualRide activities on a normalised
name match (lowercase, non-alphanumerics collapsed, `includes`). Route names
shorter than six characters are skipped — "Hilly" would match half of Watopia.

Matched routes get a "Ridden N×" chip, and any route matched but not marked
Complete in Notion is listed in a callout above the groups. The join is
read-only: it never writes a status back.

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
| Zwift Routes tab shows "Could not load Zwift routes" | Check `NOTION_API_KEY` is set as a Worker secret, and that the Notion integration is connected to the "Zwift Routes" database (`•••` → Connections in Notion) — a valid key with no database access still 404s |
| Zwift route edit fails to save | Error message shows inline on the still-open edit row; check the Worker logs for the Notion error code (401 = bad/expired key, 404 = integration not connected, 429 = rate-limited, try again) |
