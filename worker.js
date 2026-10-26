// =============================================================================
// FITNESS TRACKER — CLOUDFLARE WORKER (WITH SMART LFETIME AI SUMMARY)
// =============================================================================
// Routes:
//   GET /auth        → redirects to Strava OAuth (run once to get refresh token)
//   GET /callback    → exchanges code, shows you your refresh token to copy
//   GET /activities  → returns data & AI summary in cached envelope
//   GET /activities?refresh=true → forces a fresh pull & completely regenerates AI
//   GET /activities?refresh=recent[&days=7] → asks Strava only for the last few days
//                             and merges them into the cached history (see RECENT
//                             REFRESH). A few requests instead of a couple of dozen
//   GET /zwift-routes → returns all Zwift routes from Notion in a cached envelope
//   GET /zwift-routes?refresh=true → forces a fresh pull from Notion
//   PATCH /zwift-routes/{pageId} → updates Status/Planned Ride/Date completed/Time on one route,
//                             and moves its Google Calendar event to match (calendar.js)
//   GET /calendar-sync → reconciles planned rides with Google Calendar now (also runs
//                             every 15 minutes; see CAL_CRON)
//   GET /health → the owner's daily Garmin numbers (sleep, HRV, resting HR, steps…),
//                             admin key only; ?refresh=1 reads Garmin first (garmin.js,
//                             and GARMIN_CRON)
//   GET /sync-training-log → pulls recent Strava activities into the Notion
//                             Training Log database (also runs on a schedule —
//                             see the `crons` entry in wrangler.toml)
//
// The cron does two things: the Notion sync above, and a warm-up of the
// activities cache so the dashboard is current on arrival instead of paying a
// full Strava pull on the first visit after the 24h TTL lapses.
// =============================================================================

import { syncCalendar, syncCalendarRoute, calendarConfigured, calNotionDate, CAL_DEFAULT_TZ } from './calendar.js';
import { refreshGarmin, readGarmin, garminConfigured } from './garmin.js';
import { buildWeekly, weekFor, maybeSendWeekly, sendWeekly, weeklyStatus } from './weekly.js';
import { forgetEndpoints } from './jmap.js';

// ---- IMPORTANT: replace this with your actual Worker URL ------------------
const WORKER_URL = 'https://activities-api.lk-ff7.workers.dev/';
// ---------------------------------------------------------------------------

// Bumped from v2 when temp, np and pwr_real were added: entries cached under the
// old key have no such fields, and the charts reading them would show an empty
// state for up to a day rather than a rebuild.
const CACHE_KEY  = 'activities_v3';
const CACHE_TTL  = 60 * 60 * 24; // 24 hours in seconds

// The same envelope again, under a key with NO expiry. The serving cache above is
// meant to go stale — that is what makes a refresh happen — but it was also the
// only copy, so once it expired the last known good data was gone with it. If the
// token had died or Strava was down, /activities then had nothing to answer with
// and returned an error to a dashboard that was perfectly capable of showing
// yesterday's numbers.
//
// Every successful refresh writes both. This one is only ever read when a refresh
// fails, and it is never allowed to expire, so there is always something to serve.
// Two copies of the history is a few MB in a KV store with no size pressure —
// cheap next to the page having nothing to show.
const LAST_GOOD_KEY = 'activities_last_good_v3';

// Segment PBs (1k, 1 mile, 5k, 10k, half, marathon) are not on the bulk activity
// endpoint — they only come back from GET /activities/{id}, one request each. A
// full history is far too many requests to make in one go, so they are collected
// a slice at a time on the cron and kept forever in their own KV key. An entry of
// null means "asked, this activity has none", so it is never asked about again.
const BEST_EFFORTS_KEY   = 'best_efforts_v1';
const BEST_EFFORTS_BUDGET = 40;  // detail requests per cron run — 3 crons/day ≈ 120
const BEST_EFFORTS_BATCH  = 4;   // concurrent requests, matching the gear lookup's caution

// Strava's best-effort names, mapped to the fields the dashboard already has slots for.
const BEST_EFFORT_FIELDS = {
  '1k':             'pr_1km',
  '1 mile':         'pr_1mi',
  '5k':             'pr_5km',
  '10k':            'pr_10km',
  'half-marathon':  'pr_hm',
  'marathon':       'pr_mar',
};

const ZWIFT_DATA_SOURCE_ID = '13b81faa-c3d2-4f94-83ca-bc782626f1e3';
// The cron runs every three hours (wrangler.toml). These are the runs that do a
// full pull; the others merge the last week. See scheduled().
const FULL_PULL_HOURS_UTC = [9, 15, 21];
// The Google Calendar reconcile has a cron of its own, so a drag in the calendar
// reaches Notion within a quarter of an hour. It is the only thing that cron does.
const CAL_CRON = '*/15 * * * *';
// Garmin's daily health numbers, on a cron of their own: a first run reads a year in
// about 28 requests, which beside the Strava sync would crowd the per-run limit.
const GARMIN_CRON = '20 */3 * * *';

// Today on the owner's clock, which is how Garmin files its days.
function ownerToday(env) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: env.ZWIFT_TZ || CAL_DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const ZWIFT_CACHE_KEY      = 'zwift_routes_v1';
const ZWIFT_CACHE_TTL      = 600; // 10 minutes. Saves from the app clear it at once, and the
                                   // tab's Refresh skips it; each refill costs one of the
                                   // free plan's 1,000 KV writes a day.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// =============================================================================
// MAIN HANDLER
// =============================================================================

// =============================================================================
// WHO MAY DO WHAT
// =============================================================================
// The dashboard is public and so is its repository, so the Worker's address is
// known to anyone. Reading is open: the cached, home-trimmed activity feed, the
// Zwift routes as a read-only list, the dashboard's layout and the refresh progress.
// Everything that CHANGES something or SPENDS something needs an admin key, sent as an
// X-Admin-Key header: a refresh (GET /activities?refresh=…, /zwift-routes?refresh=true),
// the Notion and PB syncs, /debug, PATCH /zwift-routes/<id> and PUT /prefs.
//
// An answer to /zwift-routes says which kind of caller it was talking to
// (X-Key-Level: admin or none), so the dashboard shows editing controls only to a
// device whose key is good, and a revoked key falls back to the read-only list on its
// own rather than offering edits that would be refused.
//
// Keys are Worker secrets, one per device: ADMIN_KEY_PHONE, ADMIN_KEY_LAPTOP,
// ADMIN_KEY_TOOLS … Each holds one key and what follows the underscore is the
// device's label, so a lost phone is revoked by deleting one secret. (ADMIN_KEY on its
// own may hold several, comma-separated and labelled, `phone:3f9c…,laptop:b27a…`; a
// saved secret cannot be read back, so that form means retyping the others to remove
// one.) Keys are hex (`openssl rand -hex 24`): no commas or colons in them. With none
// configured the routes that need one answer 503 and stay shut: a missing secret must
// never mean "no lock". The dashboard keeps its key in the browser once opened with
// #admin=<key> on the end of its address (a fragment never reaches a server or a log).
const ADMIN_HEADER = 'X-Admin-Key';
const LEVEL_HEADER = 'X-Key-Level';
// What a refused caller is told, in words that say what the key is for.
const NOT_ALLOWED = 'Not allowed. You need an authorised admin key to make changes, refresh, rearrange or edit.';

// Compared by digest, so the time taken says nothing about how many leading
// characters were right.
async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// "phone:abc,laptop:def" or just "abc" -> [{ label, key }]
function parseKeys(raw) {
  return String(raw || '').split(',').map((part, i) => {
    const t = part.trim();
    if (!t) return null;
    const at = t.indexOf(':');
    const label = at > 0 ? t.slice(0, at).trim().slice(0, 24) : 'key' + (i + 1);
    const key = at > 0 ? t.slice(at + 1).trim() : t;
    return key ? { label, key } : null;
  }).filter(Boolean);
}

// Every admin key configured, from the list in ADMIN_KEY and from any secret named
// ADMIN_KEY_<LABEL> holding one key.
function adminKeys(env) {
  const out = parseKeys(env.ADMIN_KEY);
  for (const prop of Object.keys(env || {})) {
    if (!prop.startsWith('ADMIN_KEY_') || prop.length === 'ADMIN_KEY_'.length) continue;
    const v = typeof env[prop] === 'string' ? env[prop].trim() : '';
    if (v) out.push({ label: prop.slice('ADMIN_KEY_'.length).slice(0, 24), key: v });
  }
  return out;
}

// The label of the admin key this request carries, or null. Every configured key is
// compared, never stopping at the first, so the time does not say which one matched.
async function adminLabel(request, env) {
  const given = request.headers.get(ADMIN_HEADER) || '';
  if (!given) return null;
  let found = null;
  for (const k of adminKeys(env)) {
    if (await sameSecret(given, k.key) && !found) found = k.label;
  }
  return found;
}

const keyAnswer = (status, message) => new Response(JSON.stringify({ error: true, message }), {
  status, headers: { ...CORS, 'Content-Type': 'application/json' },
});

// null when the request may go ahead, otherwise the answer to send instead.
async function requireAdmin(request, env) {
  if (!adminKeys(env).length) return keyAnswer(503, 'No admin key is set on the Worker (ADMIN_KEY, or ADMIN_KEY_<name>), so this is switched off.');
  const label = await adminLabel(request, env);
  if (label) {
    // Which device did it, never the key itself.
    console.log('admin', label, request.method, new URL(request.url).pathname);
    return null;
  }
  return keyAnswer(401, NOT_ALLOWED);
}

// Browsers only: a page on another site cannot read these answers or send these
// writes. It is not what keeps a command-line caller out; the key does that.
const DEFAULT_ORIGINS = ['https://activities.laurencekellett.co.uk'];
function allowedOrigins(env) {
  const set = String((env && env.ALLOWED_ORIGINS) || '').split(',').map(x => x.trim()).filter(Boolean);
  return set.length ? set : DEFAULT_ORIGINS;
}
function withCors(response, request, env) {
  const out = new Response(response.body, response);
  const origin = request.headers.get('Origin');
  out.headers.delete('Access-Control-Allow-Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Content-Type, ' + ADMIN_HEADER);
    out.headers.set('Access-Control-Expose-Headers', LEVEL_HEADER);
    out.headers.append('Vary', 'Origin');
  }
  return out;
}

// What calendar.js needs from here to reach Notion, and to drop the routes cache
// when it has changed a plan, so the dashboard's next read sees it.
function calendarDeps(env) {
  return {
    notionRequest, fetchAllZwiftRoutes, transformNotionRoute,
    dataSourceId: ZWIFT_DATA_SOURCE_ID,
    onNotionChange: async () => {
      if (env.CACHE) await kvBestEffort(env.CACHE.delete(ZWIFT_CACHE_KEY), 'zwift cache delete');
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env);
    }
    return withCors(await route(request, env, ctx), request, env);
  },

  // Fires on the schedules configured in wrangler.toml's `[triggers] crons`.
  async scheduled(event, env, ctx) {
    if (event.cron === GARMIN_CRON) {
      ctx.waitUntil(refreshGarmin(env, { today: ownerToday(env) }).catch(err => {
        console.error('Scheduled Garmin refresh failed:', err.message);
      }));
      return;
    }
    if (event.cron === CAL_CRON) {
      ctx.waitUntil(syncCalendar(env, calendarDeps(env)).catch(err => {
        console.error('Scheduled calendar sync failed:', err.message);
      }));
      // The weekly email rides on this cron rather than one of its own: Cloudflare's
      // free plan allows five cron triggers across the whole account, and the Tasks
      // app has one of them. It decides for itself whether this firing is Tuesday
      // morning; every other firing returns at once.
      ctx.waitUntil(maybeSendWeekly(env, new Date(event.scheduledTime), () => weeklyData(env))
        .then(r => { if (r && !r.skipped) console.log('[weekly] ' + JSON.stringify(r)); })
        .catch(err => console.error('Weekly email failed:', err.message)));
      return;
    }
    ctx.waitUntil((async () => {
      // Sequential, not parallel. Both of these talk to Strava, and its rate
      // limit is per-15-minutes, so firing them together is the one reliable
      // way to trip it. Each is guarded so a failure in one still leaves the
      // other to run.
      try {
        await syncActivitiesToNotion(env);
      } catch (err) {
        console.error('Scheduled Notion sync failed:', err.message);
      }
      try {
        // Every three hours, but only three of those runs pay for the whole
        // history (pages of activities, gear lookups and a slice of segment PBs).
        // The rest ask Strava for the last week, usually one request, and merge
        // it in. That keeps the cache, and the CV that reads it, at most three
        // hours behind without spending Strava's daily allowance eight times over.
        const hour = new Date(event.scheduledTime).getUTCHours();
        const merged = FULL_PULL_HOURS_UTC.includes(hour) ? null : await pullRecentActivities(env, 7);
        if (!merged) {
          // backfillPrs: the cron is the only place that spends Strava requests on
          // segment PBs, a slice at a time, so it never delays a page load.
          await refreshActivitiesCache(env, { regenerateAi: false, backfillPrs: true, source: 'cron' });
        }
      } catch (err) {
        // The previous cache entry stays put, so a failed refresh serves stale
        // data rather than none.
        console.error('Scheduled activity refresh failed:', err.message);
      }
    })());
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const admin = () => requireAdmin(request, env);

  switch (url.pathname) {
    case '/auth':               return handleAuth(env);
    case '/callback':           return handleCallback(request, env);
    // A plain read is open; asking for a refresh is checked inside the handler.
    case '/activities':         return handleActivities(request, env);
    case '/debug':              return (await admin()) || handleDebug(env);
    case '/prefs':
      if (request.method === 'PUT') { const no = await admin(); if (no) return no; }
      return handlePrefs(request, env);
    case '/refresh-status':     return handleRefreshStatus(env);
    // Is this key good? The Settings pane asks before it keeps one. Open to ask, and it
    // only ever names the key that was just offered, never any other.
    case '/whoami': {
      const label = await adminLabel(request, env);
      return new Response(JSON.stringify(label ? { level: 'admin', label } : { level: 'none' }), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    // Anyone may read the list; a refresh, which re-reads Notion and spends a KV write,
    // needs an admin key. The answer says which kind of caller it was.
    case '/zwift-routes': {
      if (url.searchParams.get('refresh') === 'true') { const no = await admin(); if (no) return no; }
      const res = await handleZwiftRoutes(request, env);
      const out = new Response(res.body, res);
      out.headers.set(LEVEL_HEADER, (await adminLabel(request, env)) ? 'admin' : 'none');
      return out;
    }
    case '/sync-training-log':  return (await admin()) || handleSyncTrainingLog(env);
    case '/calendar-sync': {
      const no = await admin(); if (no) return no;
      try {
        const out = await syncCalendar(env, calendarDeps(env));
        return new Response(JSON.stringify(out, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: true, message: err.message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
    }
    case '/backfill-prs':       return (await admin()) || handleBackfillPrs(env);
    // Health data: never part of the public feed, and nothing at all without a key.
    case '/health': {
      const no = await admin(); if (no) return no;
      const headers = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' };
      if (!garminConfigured(env)) return new Response(JSON.stringify({ configured: false, days: {} }), { headers });
      let note = null;
      if (url.searchParams.get('refresh')) {
        try { await refreshGarmin(env, { today: ownerToday(env) }); } catch (err) { note = err.message; }
      }
      const stored = (await readGarmin(env)) || { days: {} };
      return new Response(JSON.stringify({ configured: true, ...stored, ...(note ? { error: note } : {}) }), { headers });
    }
    // The weekly email. Preview renders and sends nothing; send is a POST. All three need
    // the key: the email carries health data.
    case '/weekly/preview': {
      const no = await admin(); if (no) return no;
      const week = weekFor(url.searchParams.get('week'), env);
      const mail = buildWeekly(await weeklyData(env), week);
      const asText = url.searchParams.get('format') === 'text';
      return new Response(asText ? mail.text : mail.html, { headers: { ...CORS,
        'Content-Type': asText ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, private', 'X-Weekly-Subject': encodeURIComponent(mail.subject) } });
    }
    case '/weekly/status': {
      const no = await admin(); if (no) return no;
      return new Response(JSON.stringify(await weeklyStatus(env, new Date())), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
    }
    case '/weekly/send': {
      if (request.method !== 'POST') return new Response('POST only.', { status: 405, headers: CORS });
      const no = await admin(); if (no) return no;
      const headers = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' };
      try {
        if (url.searchParams.get('reset')) await forgetEndpoints(env);
        const week = weekFor(url.searchParams.get('week'), env);
        // Last week, the one the coming Tuesday covers, is marked as sent; any other is not.
        const r = await sendWeekly(env, week, await weeklyData(env), { mark: week.from === weekFor(null, env).from });
        return new Response(JSON.stringify({ sent: true, ...r }), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ sent: false, error: err.message }), { status: 502, headers });
      }
    }
    default:
      if (url.pathname.startsWith('/zwift-routes/') && request.method === 'PATCH') {
        const no = await admin();
        if (no) return no;
        const pageId = url.pathname.slice('/zwift-routes/'.length);
        return handleZwiftRouteUpdate(request, env, pageId, ctx);
      }
      return new Response('Not found', { status: 404 });
  }
}

// =============================================================================
// AUTH — step 1 of one-time OAuth setup
// =============================================================================

// The state ties a callback to the /auth visit that started it. Without it anyone
// could finish OAuth with THEIR Strava account and have this Worker store their
// token in place of yours. It travels in an HttpOnly cookie and in Strava's
// `state` parameter, and the two must match.
const OAUTH_STATE_COOKIE = 'strava_oauth_state';

function handleAuth(env) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    state,
    client_id:       env.STRAVA_CLIENT_ID,
    redirect_uri:    `${WORKER_URL}/callback`,
    response_type:   'code',
    approval_prompt: 'force',
    // profile:read_all is what /athlete/zones needs. Without it fetchAthleteZones
    // always returns null and the zone split falls back to percentages of a derived
    // max. Adding it here changes nothing for the token you already hold — it only
    // takes effect if you re-run /auth, which is optional.
    scope:           'activity:read_all,profile:read_all',
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://www.strava.com/oauth/authorize?${params}`,
      'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// =============================================================================
// CALLBACK — step 2 of one-time OAuth setup
// =============================================================================

async function handleCallback(request, env) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return new Response('Missing code parameter', { status: 400 });
  }
  const given = url.searchParams.get('state') || '';
  const expected = readCookie(request, OAUTH_STATE_COOKIE);
  if (!given || !expected || !(await sameSecret(given, expected))) {
    return new Response('This sign-in did not start here, so it was not used. Open /auth again.', { status: 400 });
  }

  const res  = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    }),
  });

  const data = await res.json();

  if (data.errors || !data.refresh_token) {
    return new Response(
      `Strava OAuth error: ${JSON.stringify(data)}`,
      { status: 400 }
    );
  }

  // Written here as well as shown, so re-running /auth actually recovers a
  // dead token: getAccessToken() reads KV first, and a value left there would
  // otherwise keep overriding whatever you paste into the secret.
  if (env.CACHE) await env.CACHE.put(STRAVA_REFRESH_KEY, data.refresh_token);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Connected!</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 40px; max-width: 640px; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  textarea { width: 100%; height: 72px; font-family: monospace; font-size: 12px;
             border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; margin-top: 8px; }
  .step { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px;
          padding: 18px 20px; margin-top: 20px; }
  h2 { color: #16a34a; }
</style>
</head>
<body>
  <h2>✅ Connected to Strava!</h2>
  <p>This token is already live — it has been written to the Worker's KV store,
     so the feed and the Training Log sync work from now on with nothing else to do.</p>
  <p>Optional, for a clean rebuild: copy it below and set it as the
     <code>STRAVA_REFRESH_TOKEN</code> secret under
     <strong>Settings → Variables and Secrets</strong>. That secret is only ever
     the seed for an empty KV store.</p>
  <textarea readonly onclick="this.select()">${data.refresh_token}</textarea>
  <div class="step">
    <strong>Once saved:</strong> visit <code>${WORKER_URL}/activities</code> to test the live feed.
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// =============================================================================
// ACTIVITIES — main endpoint, called by your frontend
// =============================================================================

async function handleActivities(request, env) {
  const url          = new URL(request.url);
  // `recent` is a refresh too: it has to skip the cache, or asking for it
  // would be answered by the very copy it was asked to update.
  const refreshParam = url.searchParams.get('refresh');
  // Any refresh spends Strava's rate limit, Workers AI and a KV write, so it is the
  // key holder's to ask for. A plain read stays open.
  if (refreshParam === 'true' || refreshParam === 'recent') {
    const no = await requireAdmin(request, env);
    if (no) return no;
  }
  const isAdmin = !!(await adminLabel(request, env));
  const recent       = refreshParam === 'recent' ? recentDaysFrom(url.searchParams.get('days')) : 0;
  const forceRefresh = refreshParam === 'true' || recent > 0;

  // Serve from KV cache if available and not forcing a refresh
  if (!forceRefresh && env.CACHE) {
    const cached = await env.CACHE.get(CACHE_KEY);
    if (cached) {
      return new Response(cached, {
        headers: {
          ...CORS,
          'Content-Type': 'application/json',
          'X-Cache':       'HIT',
        },
      });
    }
  }

  // An open read that finds the cache empty must not start a whole-history pull on
  // a stranger's say-so: the cron refills it, and the last good copy answers until
  // it has. Only when there is never has been one does it fall through to the pull.
  if (!forceRefresh && !isAdmin && env.CACHE) {
    const lastGood = await env.CACHE.get(LAST_GOOD_KEY);
    if (lastGood) {
      return new Response(lastGood, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'STALE', 'X-Refresh': 'none' },
      });
    }
  }

  let envelope, cacheState = 'MISS', how = 'full';
  try {
    // The week-only pull answers null when there is no history to merge it into,
    // and only then does this fall through to the full pull. Merging a week onto
    // nothing would write an envelope holding a week, over the top of everything.
    const merged = recent ? await pullRecentActivities(env, recent) : null;
    if (merged) { envelope = merged; how = 'recent'; }
    else        { envelope = await refreshActivitiesCache(env); }
  } catch (err) {
    // Strava is down, rate-limiting, or the token has died. Serving the last good
    // envelope is strictly better than an error: the dashboard can say how old the
    // numbers are, and it cannot say anything at all about a 500. Only if there has
    // never been a successful refresh does the failure reach the client.
    console.error('Activity refresh failed, falling back to last known good:', err.message);
    const lastGood = env.CACHE ? await env.CACHE.get(LAST_GOOD_KEY) : null;
    if (!lastGood) throw err;
    envelope = lastGood;
    cacheState = 'STALE';
  }

  return new Response(envelope, {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'X-Cache':       cacheState,
      // Which pull answered: 'recent' for the week-only merge, 'full' for a whole
      // history. A caller that asked for one and got the other can say so.
      'X-Refresh':     cacheState === 'STALE' ? 'none' : how,
    },
  });
}

// Pulls everything from Strava, writes the envelope to KV and returns it.
// Shared by the request path and the cron, so a visitor and a scheduled warm-up
// produce exactly the same cache entry.
//
// `regenerateAi` is false on the cron. The dashboard no longer renders the AI
// summary, so regenerating it three times a day would be paying Workers AI for
// output nobody reads — but a scheduled refresh should not be the thing that
// destroys the last good summary either, so it carries the existing one
// forward rather than writing the placeholder over it.
async function refreshActivitiesCache(env, opts = {}) {
  // Every pull narrates itself (see REFRESH PROGRESS below): what stage it is at is
  // written to KV as it goes, and the dashboard polls for it while it waits.
  const progress = await makeProgress(env, opts.source || 'request');
  try {
    const envelope = await pullActivities(env, opts, progress);
    await progress.done();
    return envelope;
  } catch (err) {
    await progress.failed(err);
    throw err;
  }
}

async function pullActivities(env, { regenerateAi = true, backfillPrs = false } = {}, progress) {
  await progress.stage('token');
  const accessToken = await getAccessToken(env);
  const activities  = await fetchAllActivities(accessToken, env, progress);

  // Segment PBs collected on previous runs are written on unconditionally — that
  // costs one KV read. Collecting NEW ones costs a Strava request per activity,
  // so only the cron does that; a user waiting on /activities never pays for it.
  if (backfillPrs) {
    await progress.stage('prs');
    try {
      const res = await backfillBestEfforts(env, accessToken, activities);
      console.log(`Best-effort backfill: checked ${res.checked}, found ${res.found}, ${res.remaining} runs still to do`);
    } catch (err) {
      console.error('Best-effort backfill failed:', err.message);
      applyBestEfforts(activities, await loadBestEfforts(env));
    }
  } else {
    applyBestEfforts(activities, await loadBestEfforts(env));
  }

  let aiSummary = 'No AI summary generated.';
  if (regenerateAi && env.AI) {
    await progress.stage('ai');
    aiSummary = await generateAiSummary(activities, env);
  } else if (env.CACHE) {
    try {
      const previous = await env.CACHE.get(CACHE_KEY);
      if (previous) aiSummary = JSON.parse(previous).aiSummary ?? aiSummary;
    } catch {
      // A corrupt or half-written cache entry is not worth failing a refresh for.
    }
  }

  const envelope = JSON.stringify({
    data: activities,
    aiSummary: aiSummary,
    updatedAt: new Date().toISOString(),
    // How the zone boundaries were arrived at, so the chart can say so rather than
    // asserting "your Strava zones" whether or not they loaded.
    hrZones: _hrZoneMeta,
    // Keyed by gear name, because that is what each activity carries.
    gearMeta: _gearMeta,
  });

  await progress.stage('save');
  if (env.CACHE) {
    // Both copies, every time, so the fallback is never older than the last
    // successful pull. The serving copy expires; the fallback never does.
    await Promise.all([
      kvBestEffort(env.CACHE.put(CACHE_KEY, envelope, { expirationTtl: CACHE_TTL }), 'activities cache put'),
      kvBestEffort(env.CACHE.put(LAST_GOOD_KEY, envelope), 'activities last-good put'),
    ]);
  }

  return envelope;
}

// =============================================================================
// RECENT REFRESH — the last few days from Strava, merged into what is cached
// =============================================================================
// A full pull pages the whole history, looks up gear, and takes up to a minute.
// For "I have just uploaded a run" that is a lot of work to learn about one
// activity, and a good way to meet Strava's rate limit. This asks for the last
// few days only — usually one request — and merges them in.
//
// It merges, it never replaces. The cached envelope is the whole history; the
// week is spliced into it. So with nothing cached it does nothing and says so
// (the caller then runs the full pull), because a week written over the top of
// the history would be the worst thing this worker could do.
//
// What it does NOT touch: the AI summary (carried forward, as the cron does),
// and the refresh-progress record, whose duration and total are how the
// dashboard estimates the NEXT full pull — a one-second pull of three
// activities written there would make that estimate nonsense.
const RECENT_DEFAULT_DAYS = 7;
const RECENT_MAX_DAYS     = 14;
const RECENT_MAX_PAGES    = 3;   // 600 activities in a fortnight is not a real day

// Clamped rather than trusted: a typo must not turn "the last week" into the
// whole history, and 0 or a negative number must not mean "nothing".
function recentDaysFrom(raw) {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 && n <= RECENT_MAX_DAYS ? n : RECENT_DEFAULT_DAYS;
}

// Two numbers. `fromDate` is the first LOCAL date that gets replaced; an
// activity's `date` is its local date, so the comparison is made in local dates
// with a day of margin either side. `afterEpoch` is what Strava is asked for,
// and Strava filters on the UTC start: a local date of fromDate can start as
// early as 14 hours before fromDate's midnight UTC (UTC+14 is as far ahead as a
// clock gets), so asking from there cannot miss one.
function recentWindow(nowMs, days) {
  const from = new Date(nowMs - days * 86400000);
  from.setUTCDate(from.getUTCDate() - 1);
  const fromDate = from.toISOString().slice(0, 10);
  const afterEpoch = Math.floor(Date.parse(fromDate + 'T00:00:00Z') / 1000) - 14 * 3600;
  return { fromDate, afterEpoch };
}

// Everything cached before the window stays exactly as it was. Everything inside
// it is dropped, then whatever Strava returned is put back — so an activity
// edited in Strava is replaced and one deleted there disappears. By id, so the
// few fetched from just before the window (the margin above) replace their
// cached copies instead of sitting beside them.
function mergeRecent(existing, fetched, fromDate) {
  const byId = new Map();
  for (const a of existing) if (a && a.date < fromDate) byId.set(String(a.id), a);
  for (const a of fetched) byId.set(String(a.id), a);
  return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function pullRecentActivities(env, days) {
  if (!env.CACHE) return null;
  // The fallback copy, not the serving one: the serving copy expires after a day
  // and the fallback never does, and both are written together.
  let prev = null;
  try {
    const raw = (await env.CACHE.get(LAST_GOOD_KEY)) || (await env.CACHE.get(CACHE_KEY));
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }
  if (!prev || !Array.isArray(prev.data) || prev.data.length === 0) return null;

  const accessToken = await getAccessToken(env);
  const { fromDate, afterEpoch } = recentWindow(Date.now(), days);
  const zones = homeZones(env);

  const fetched = [];
  for (let page = 1; page <= RECENT_MAX_PAGES; page++) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterEpoch}&per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const batch = await res.json();
    // An error is not "no more activities". The full pull treats a rate-limit
    // reply as the end of the list and carries on with what it has; here that
    // would report a successful fetch that found nothing, which is the one
    // answer this button must not give when Strava never answered.
    if (!res.ok || !Array.isArray(batch)) {
      throw new Error(`Strava answered ${res.status}${batch && batch.message ? ': ' + batch.message : ''}`);
    }
    for (const a of batch) fetched.push(transformActivity(a, zones));
    if (batch.length < 200) break;
  }

  // Gear for what came back, resolved the way the full pull does it. The
  // gear metadata for everything older is already in the cached envelope.
  const gearIds = [...new Set(fetched.map(a => a._gear_id).filter(Boolean))];
  const gearMap = {};
  const knownGear = await loadGearNames(env);
  await fetchGearNames(gearIds, accessToken, gearMap, knownGear);
  await saveGearNames(env, knownGear);
  _gearMeta = { ...(prev.gearMeta || {}) };
  for (const id of gearIds) {
    const rec = knownGear[id];
    if (rec && rec.name) {
      _gearMeta[rec.name] = {
        brand: rec.brand || null, model: rec.model || null, retired: !!rec.retired,
        kind: rec.kind || (id[0] === 'b' ? 'bike' : id[0] === 'g' ? 'shoe' : null),
      };
    }
  }
  for (const a of fetched) {
    a.gear = a._gear_id ? (gearMap[a._gear_id] || null) : null;
    delete a._gear_id;
  }

  const merged = mergeRecent(prev.data, fetched, fromDate);

  // Zones are worked out for the whole merged history, not just the new ones: the
  // athlete's max heart rate is derived from all of it, and one hard effort this
  // week can move every older activity's zones. Cheap — no request per activity.
  const hrZones = await fetchAthleteZones(accessToken);
  const athleteMaxHr = deriveAthleteMaxHr(merged);
  _hrZoneMeta = { athleteMaxHr, source: (hrZones && hrZones.length >= 5) ? 'strava' : 'derived' };
  for (const a of merged) {
    const z = estimateZones(a.hr, a.max_hr, a.mt, hrZones, athleteMaxHr);
    a.z1 = z.z1; a.z2 = z.z2; a.z3 = z.z3; a.z4 = z.z4; a.z5 = z.z5;
  }
  applyBestEfforts(merged, await loadBestEfforts(env));

  const envelope = JSON.stringify({
    data: merged,
    aiSummary: prev.aiSummary ?? 'No AI summary generated.',
    updatedAt: new Date().toISOString(),
    hrZones: _hrZoneMeta,
    gearMeta: _gearMeta,
  });
  await Promise.all([
    kvBestEffort(env.CACHE.put(CACHE_KEY, envelope, { expirationTtl: CACHE_TTL }), 'activities cache put'),
    kvBestEffort(env.CACHE.put(LAST_GOOD_KEY, envelope), 'activities last-good put'),
  ]);
  return envelope;
}

// =============================================================================
// REFRESH PROGRESS — what a pull from Strava is doing, for the dashboard to show
// =============================================================================
// A full pull is a couple of dozen requests to Strava and can take a minute. The
// dashboard used to show "Refreshing…" for the whole of it, which reads as hung. Now
// the refresh writes where it has got to under one small KV key as it works — the
// stage, the page it is on, how many activities so far, and how long the last pull
// took, which is the only honest basis for "about 40 seconds left" — and
// GET /refresh-status hands that back for the page to poll.
//
// KV allows one write a second to a key, so writes are throttled to one every 1.2 s
// except the last, and a write that fails is logged and ignored: the status is a
// courtesy, and the pull itself must never fail because of it.
const REFRESH_STATUS_KEY = 'refresh_status_v1';
const REFRESH_LAST_KEY   = 'refresh_last_v1';   // { durationMs, total, finishedAt } of the last success
const REFRESH_WRITE_GAP  = 1200;

async function makeProgress(env, source) {
  let last = null;
  if (env.CACHE) {
    try { last = JSON.parse((await env.CACHE.get(REFRESH_LAST_KEY)) || 'null'); } catch { last = null; }
  }
  const startedAt = Date.now();
  const rec = {
    state: 'running', source,
    startedAt: new Date(startedAt).toISOString(), updatedAt: null,
    stage: 'token', page: 0, fetched: 0,
    // Strava pages are 200 long; the last pull's total says how many to expect.
    expectedPages: last && last.total ? Math.ceil(last.total / 200) : null,
    expectedTotal: last ? last.total : null,
    lastDurationMs: last ? last.durationMs : null,
  };
  let lastWrite = 0;
  const write = async (force) => {
    if (!env.CACHE) return;
    const now = Date.now();
    if (!force && now - lastWrite < REFRESH_WRITE_GAP) return;
    lastWrite = now;
    rec.updatedAt = new Date(now).toISOString();
    try {
      await env.CACHE.put(REFRESH_STATUS_KEY, JSON.stringify(rec), { expirationTtl: 60 * 60 });
    } catch (err) {
      console.error('Refresh status write failed:', err.message);
    }
  };
  return {
    stage: (stage, extra) => { rec.stage = stage; Object.assign(rec, extra || {}); return write(false); },
    done: async () => {
      const durationMs = Date.now() - startedAt;
      Object.assign(rec, { state: 'done', stage: 'done', durationMs, total: rec.fetched });
      await write(true);
      if (env.CACHE) {
        try {
          await env.CACHE.put(REFRESH_LAST_KEY, JSON.stringify({ durationMs, total: rec.fetched, finishedAt: new Date().toISOString() }));
        } catch (err) {
          console.error('Refresh record write failed:', err.message);
        }
      }
    },
    failed: async (err) => {
      Object.assign(rec, { state: 'failed', error: String((err && err.message) || err) });
      await write(true);
    },
  };
}

async function handleRefreshStatus(env) {
  let body = '{"state":"idle"}';
  if (env.CACHE) {
    const raw = await env.CACHE.get(REFRESH_STATUS_KEY);
    if (raw) body = raw;
  }
  return new Response(body, {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// =============================================================================
// PRE-AGGREGATION AI SUMMARY GENERATOR
// =============================================================================

async function generateAiSummary(activities, env) {
  try {
    if (!activities || activities.length === 0) return "No data found.";

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recent = activities.filter(a => new Date(a.date) >= thirtyDaysAgo);

    // Calculate details for the prompt
    const totalDist = recent.reduce((sum, a) => sum + (a.dist_mi || 0), 0);
    const walkCount = recent.filter(a => a.type === 'Walk').length;
    const totalCount = recent.length;
    const walkPct = Math.round((walkCount / totalCount) * 100);

    const recentDataStr = recent.map(a => 
      `- ${a.date}: ${a.type} (${a.dist_mi} mi)`
    ).join('\n');

    const systemPrompt = `You are a realistic, data-driven fitness analyst. 
    Write a 5-6 sentence summary for Laurence, a hobbyist athlete. 
    CRITICAL RULES:
    1. Use "you" instead of "the athlete". 
    2. Be explicit: distinguish between activity 'count' (frequency) and 'distance' (miles). 
    3. Be factual, grounded, and supportive. No flowery language or hyperbole. 
    4. Do not use bolding or markdown.`;

    const userPrompt = `Data for the last 30 days:
    - Total Workouts: ${totalCount}
    - Total Distance: ${Math.round(totalDist)} miles
    - Walk frequency: ${walkCount} out of ${totalCount} workouts (${walkPct}% of workouts by count).

    Activity Log:
    ${recentDataStr}

    Task: Write a 5-6 sentence summary for Laurence. Describe the activity mix, highlighting that walking is the most frequent activity by count while acknowledging the distance covered.`;

    const aiResponse = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    return aiResponse.response;
  } catch (err) {
    return `Coach breakdown temporarily unavailable: ${err.message}`;
  }
}

// =============================================================================
// DEBUG ROUTE
// =============================================================================

// This route has no auth and CORS is open to *, so it must never echo Strava's
// raw token response: that carries the access token AND the refresh token, and
// the refresh token is indefinite read access to the account. It reports
// whether the refresh worked, not what it returned — and goes through
// getAccessToken() rather than re-implementing it, so there is one token path
// to keep right instead of two.
function redactTokens(text) {
  return String(text).replace(/\b[0-9a-f]{40}\b/gi, '<redacted>');
}

async function handleDebug(env) {
  const out = {};

  let accessToken;
  try {
    accessToken = await getAccessToken(env);
    out.token = 'ok';
  } catch (err) {
    out.token = 'failed';
    out.token_error = redactTokens(err.message);
    return new Response(JSON.stringify(out, null, 2), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const actRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=5&page=1',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  out.activities_status = actRes.status;
  // Strava's raw answer carries where each activity started and its full-precision
  // route: both are what the home privacy trimming exists to hide. A diagnostic only
  // needs to know the call worked.
  const raw = await actRes.json();
  out.activities_response = Array.isArray(raw)
    ? raw.map(a => ({ id: a.id, name: a.name, type: a.type, start_date: a.start_date, distance: a.distance }))
    : raw;

  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// =============================================================================
// ZWIFT ROUTES — NOTION INTEGRATION
// =============================================================================
// Notion is the single source of truth. The Worker proxies live reads/writes;
// there is no local database and no sync/reconciliation logic. Reads are
// cached briefly in KV to absorb repeated tab opens/rerenders; writes delete
// that cache key immediately so the next read is never stale.
// =============================================================================

const ZWIFT_STATUS_VALUES = ['Not started', 'Blocked', 'Planned', 'Complete'];

// =============================================================================
// PREFERENCES
// =============================================================================
/*
 * The dashboard's own settings — at present the panel order per zone, set by
 * "Rearrange this tab". The browser keeps its own copy in localStorage and that is
 * what actually draws the page; this one exists so an arrangement made on the
 * laptop is there on the phone.
 *
 * One record for one person, no merging. What is being synced is a single
 * ordering, and two devices disagreeing about it means the most recent arrangement
 * is the one that was meant — so the stamp decides, not arrival order.
 *
 * Reading it is open. Writing it needs the admin key (see WHO MAY DO WHAT): what
 * it holds is only the order somebody likes their charts in, but a write is a write,
 * the Worker's address is public, and an unauthenticated PUT is also a way to spend
 * the day's KV writes. Nothing belongs in here that would matter if it were read.
 *
 * No expirationTtl: a preference that quietly expired after a day would be worse
 * than not syncing at all.
 */
const PREFS_KEY = 'prefs_v1';
const PREFS_MAX = 64 * 1024;

async function handlePrefs(request, env) {
  const headers = { ...CORS, 'Content-Type': 'application/json' };

  if (!env.CACHE) {
    return new Response(JSON.stringify({ error: true, message: 'KV namespace not bound' }), {
      status: 500, headers,
    });
  }

  if (request.method === 'GET') {
    const raw = await env.CACHE.get(PREFS_KEY);
    // updatedAt 0 for "never set", so a browser that has an order of its own always
    // wins the first comparison and pushes it up.
    return new Response(raw || JSON.stringify({ prefs: {}, updatedAt: 0 }), { headers });
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: true, message: 'Body must be JSON' }), {
        status: 400, headers,
      });
    }

    const prefs = body && typeof body.prefs === 'object' && body.prefs !== null && !Array.isArray(body.prefs)
      ? body.prefs : null;
    if (!prefs) {
      return new Response(JSON.stringify({ error: true, message: 'Expected { prefs, updatedAt }' }), {
        status: 400, headers,
      });
    }

    const updatedAt = Number(body.updatedAt) || 0;

    // A device that has been asleep since Tuesday must not undo Wednesday's
    // arrangement just because it woke up and pushed second.
    const existing = await env.CACHE.get(PREFS_KEY);
    if (existing) {
      try {
        if ((Number(JSON.parse(existing).updatedAt) || 0) > updatedAt) {
          return new Response(existing, { headers: { ...headers, 'X-Prefs': 'stale' } });
        }
      } catch (err) {
        // An unparseable record is worse than no record: let this write replace it.
      }
    }

    const record = JSON.stringify({ prefs, updatedAt });
    if (record.length > PREFS_MAX) {
      return new Response(JSON.stringify({ error: true, message: 'Preferences too large' }), {
        status: 413, headers,
      });
    }

    await env.CACHE.put(PREFS_KEY, record);
    return new Response(record, { headers });
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}

// The cache is an optimisation, never the answer. On the free plan KV allows
// 1,000 writes a day; once they're spent every put() and delete() throws until the
// daily reset. A throw there used to turn a successful Notion read or write into an
// error, so the page fell back to a days-old copy while Notion was fine. Cache
// writes on a request path go through this: logged, then ignored.
async function kvBestEffort(op, label) {
  try {
    await op;
  } catch (err) {
    console.error(`KV ${label} failed (cache only, request continues):`, err.message);
  }
}

async function handleZwiftRoutes(request, env) {
  if (!env.NOTION_API_KEY) {
    return new Response(JSON.stringify({ error: true, message: 'NOTION_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const url          = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (!forceRefresh && env.CACHE) {
    const cached = await env.CACHE.get(ZWIFT_CACHE_KEY);
    if (cached) {
      return new Response(cached, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  try {
    const data     = await fetchAllZwiftRoutes(env);
    const envelope = JSON.stringify({ data, updatedAt: new Date().toISOString() });

    if (env.CACHE) {
      await kvBestEffort(env.CACHE.put(ZWIFT_CACHE_KEY, envelope, { expirationTtl: ZWIFT_CACHE_TTL }), 'zwift cache put');
    }

    return new Response(envelope, {
      headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (err) {
    return notionErrorResponse(err);
  }
}

async function handleZwiftRouteUpdate(request, env, pageId, ctx) {
  if (!env.NOTION_API_KEY) {
    return new Response(JSON.stringify({ error: true, message: 'NOTION_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  if (!pageId) {
    return new Response(JSON.stringify({ error: true, code: 'validation', message: 'Missing route id' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  // A Notion page id and nothing else. The id goes into a Notion URL, where
  // "../databases/<id>" would resolve to a different endpoint altogether.
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(pageId)) {
    return new Response(JSON.stringify({ error: true, code: 'validation', message: 'Not a route id' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: true, code: 'validation', message: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { status, date_completed, planned_ride, time } = body;
  const properties = {};

  if (status !== undefined) {
    if (!ZWIFT_STATUS_VALUES.includes(status)) {
      return new Response(JSON.stringify({ error: true, code: 'validation', message: `status must be one of ${ZWIFT_STATUS_VALUES.join(', ')}` }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    properties['Status'] = { status: { name: status } };
  }

  if (date_completed !== undefined) {
    if (date_completed !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date_completed)) {
      return new Response(JSON.stringify({ error: true, code: 'validation', message: 'date_completed must be YYYY-MM-DD or null' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    properties['Date completed'] = date_completed ? { date: { start: date_completed } } : { date: null };
  }

  if (planned_ride !== undefined) {
    // A day, or a day and a start time on the owner's clock ('2026-10-28T18:30'),
    // which Notion stores with the time zone so it reads back as the same hour.
    if (planned_ride !== null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(planned_ride)) {
      return new Response(JSON.stringify({ error: true, code: 'validation', message: 'planned_ride must be YYYY-MM-DD, YYYY-MM-DDTHH:MM or null' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    properties['Planned Ride'] = { date: calNotionDate(planned_ride, env.ZWIFT_TZ || CAL_DEFAULT_TZ) };
  }

  if (time !== undefined) {
    if (time !== null && !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
      return new Response(JSON.stringify({ error: true, code: 'validation', message: 'time must be HH:MM:SS or null' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    properties['Time'] = time ? { rich_text: [{ type: 'text', text: { content: time } }] } : { rich_text: [] };
  }

  if (Object.keys(properties).length === 0) {
    return new Response(JSON.stringify({ error: true, code: 'validation', message: 'No updatable fields provided' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    // The integration can also reach the Training Log and the diary, so a page id
    // is only written to once Notion confirms it is a row of Zwift Routes. Without
    // this, a key and a diary page's id would write to the diary and echo it back.
    // Anything else answers as a missing route, saying nothing about the page.
    const bare = (x) => String(x || '').replace(/-/g, '').toLowerCase();
    const target = await notionRequest(`/v1/pages/${pageId}`, env);
    if (bare(target.parent && target.parent.data_source_id) !== bare(ZWIFT_DATA_SOURCE_ID)) {
      return new Response(JSON.stringify({ error: true, code: 'notion_not_found', message: 'Route not found.' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const page = await notionRequest(`/v1/pages/${pageId}`, env, {
      method: 'PATCH',
      body:   JSON.stringify({ properties }),
    });

    if (env.CACHE) {
      await kvBestEffort(env.CACHE.delete(ZWIFT_CACHE_KEY), 'zwift cache delete');
    }

    const saved = transformNotionRoute(page);
    // The calendar follows after the answer has gone, so a slow Google never
    // slows a save; the 15-minute reconcile catches anything this misses.
    if (ctx && (planned_ride !== undefined || status !== undefined) && calendarConfigured(env)) {
      ctx.waitUntil(syncCalendarRoute(env, calendarDeps(env), saved).catch(err => {
        console.error('Calendar update after save failed:', err.message);
      }));
    }

    return new Response(JSON.stringify({ data: saved }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return notionErrorResponse(err);
  }
}

function notionErrorResponse(err) {
  const status  = err.status;
  let httpStatus = 502;
  let code       = 'network';
  let message    = 'Could not reach Notion.';

  if (status === 401) {
    httpStatus = 502; code = 'notion_auth';
    message = 'Notion credentials are invalid or expired — check the NOTION_API_KEY Worker secret.';
  } else if (status === 404) {
    httpStatus = 404; code = 'notion_not_found';
    message = 'Route not found, or the integration lost access to it — check the database is connected to the integration in Notion.';
  } else if (status === 400) {
    httpStatus = 400; code = 'notion_validation';
    message = err.message || 'Notion rejected the request.';
  } else if (status === 429) {
    httpStatus = 503; code = 'rate_limited';
    message = 'Notion is rate-limiting requests — try again in a moment.';
  }

  return new Response(JSON.stringify({ error: true, code, message }), {
    status: httpStatus,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function notionRequest(path, env, options = {}) {
  const res = await fetch(`https://api.notion.com${path}`, {
    ...options,
    headers: {
      'Authorization':  `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2025-09-03',
      'Content-Type':   'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '1');
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return notionRequest(path, env, options); // single retry
  }

  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || `Notion API error ${res.status}`);
    err.status = res.status;
    err.code   = json.code;
    throw err;
  }
  return json;
}

async function fetchAllZwiftRoutes(env) {
  const results = [];
  let   cursor  = undefined;

  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res  = await notionRequest(`/v1/data_sources/${ZWIFT_DATA_SOURCE_ID}/query`, env, {
      method: 'POST',
      body:   JSON.stringify(body),
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return results.map(transformNotionRoute);
}

function transformNotionRoute(page) {
  const p = page.properties;
  const timeStr = (p['Time']?.rich_text || []).map(t => t.plain_text).join('') || null;

  return {
    id:             page.id,
    route:          (p['Route']?.title || []).map(t => t.plain_text).join('') || '',
    maps:           (p['Map']?.multi_select || []).map(m => m.name),
    distance_mi:    p['Distance']?.number ?? null,
    elevation_ft:   p['Elevation']?.number ?? null,
    est_duration:   (p['Est. Duration']?.rich_text || []).map(t => t.plain_text).join('') || null,
    date_completed: p['Date completed']?.date?.start || null,
    time:           timeStr,
    time_sec:       parseTimeToSeconds(timeStr),
    status:         p['Status']?.status?.name || 'Not started',
    planned_ride:   p['Planned Ride']?.date?.start || null,
    link_zi:        p['Link (ZI)']?.url || null,
    link_strava:    p['Link (Strava)']?.url || null,
    link_zh:        p['Link (ZH)']?.url || null,
    in_route_list:  !!p['In route list?']?.checkbox,
    directions:     (p['Directions']?.rich_text || []).map(t => t.plain_text).join('') || null,
    last_edited:    page.last_edited_time || null,
  };
}

function parseTimeToSeconds(t) {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

// =============================================================================
// TRAINING LOG SYNC — REPLACES THE OLD ZAPIER STRAVA→NOTION AUTOMATION
// Zapier stopped firing, so this pulls the job in-house: on each run (manual
// hit or scheduled), it looks back a few days over Strava activities and
// creates a matching Training Log row for anything not already there.
// Matching/dedup is done against the "URL" property, which already holds the
// Strava activity link on every row Zapier ever created — no schema change
// needed. Note the plain name: Notion's MCP server displays this property as
// "userDefined:URL" because it namespaces any user property that collides
// with one of its own system columns, and a property called URL collides with
// the page's own url. That alias is an MCP display detail and means nothing to
// api.notion.com, which knows it only as "URL" — sending the prefixed form is
// an unknown-property validation error on both the filter and the create. Existing rows are left untouched (never patched),
// so a manual edit you make in Notion is never clobbered by a later re-run.
// The Diary relation is set from the activity's OWN local date, and re-checked
// on every pass — see repairDiaryLink for why that has to be a patch. Gear and
// Events still need real judgement, so they are left for you to link by hand.
// =============================================================================

const TRAINING_LOG_DATA_SOURCE_ID = '65bc3d80-a789-4c41-8107-3ba633df1672';
const TRAINING_LOG_LOOKBACK_DAYS  = 3; // safety margin for late GPS-watch syncs
const DIARY_DATA_SOURCE_ID        = '5276333e-fb61-47fd-8ab6-710d8bb8a656';

// The diary page for one day, looked up by its Date property. Cached per sync
// run rather than module-level: a Worker isolate outlives a request, and a day
// that had no diary page at 09:00 usually has one by 22:00 — a cache that
// survived between runs would keep insisting it doesn't exist.
async function findDiaryPageForDate(isoDate, env, cache) {
  if (cache.has(isoDate)) return cache.get(isoDate);
  const res = await notionRequest(`/v1/data_sources/${DIARY_DATA_SOURCE_ID}/query`, env, {
    method:  'POST',
    body:    JSON.stringify({ filter: { property: 'Date', date: { equals: isoDate } }, page_size: 1 }),
  });
  const id = (res.results && res.results[0] && res.results[0].id) || null;
  cache.set(isoDate, id);
  return id;
}

// Points an existing row's Diary relation at the day the activity actually
// happened, and returns whether it had to change anything.
//
// This is the one place the sync patches a row it did not just create, and it
// earns the exception. Two things conspire against setting Diary once at
// creation and leaving it: the diary page for a day usually does not exist yet
// when the activity syncs (you run at 07:00 and write the day up at 22:00), and
// a Notion automation on this database attaches TODAY'S diary page to every new
// row regardless of when the activity happened — so a backfilled row lands
// pointing at the wrong day and stays there. Re-checking each pass fixes both,
// and a row only gets written when its current link disagrees with its own
// date, so a correct link is never touched.
//
// A day with no diary page yet is left alone rather than cleared: the next run
// inside the lookback window will pick it up once the day is written.
async function repairDiaryLink(page, isoDate, env, cache) {
  if (!isoDate) return false;
  const want = await findDiaryPageForDate(isoDate, env, cache);
  if (!want) return false;
  const bare = id => String(id).replace(/-/g, '');
  const have = ((page.properties && page.properties.Diary && page.properties.Diary.relation) || []).map(r => bare(r.id));
  if (have.length === 1 && have[0] === bare(want)) return false;
  await notionRequest(`/v1/pages/${page.id}`, env, {
    method: 'PATCH',
    body:   JSON.stringify({ properties: { Diary: { relation: [{ id: want }] } } }),
  });
  return true;
}

async function handleSyncTrainingLog(env) {
  if (!env.NOTION_API_KEY) {
    return new Response(JSON.stringify({ error: true, message: 'NOTION_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const summary = await syncActivitiesToNotion(env);
    return new Response(JSON.stringify({ ...summary, syncedAt: new Date().toISOString() }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return notionErrorResponse(err);
  }
}

// Manual trigger for the segment-PB backfill, so a slice can be collected on demand
// rather than only on the cron. Refreshes the cache too, so the numbers it just
// collected are on screen straight away. Reports how many runs are still to do —
// call it again in fifteen minutes to take the next slice.
async function handleBackfillPrs(env) {
  try {
    const accessToken = await getAccessToken(env);
    const activities  = await fetchAllActivities(accessToken, env);
    const summary     = await backfillBestEfforts(env, accessToken, activities);

    if (env.CACHE) {
      let aiSummary = 'No AI summary generated.';
      try {
        const previous = await env.CACHE.get(CACHE_KEY);
        if (previous) aiSummary = JSON.parse(previous).aiSummary ?? aiSummary;
      } catch {
        // Keep the default rather than fail a successful backfill.
      }
      // The envelope has to carry `hrZones` the way the scheduled refresh does.
      // Writing it without meant a manual backfill republished the cache with the
      // zone chart's provenance stripped out, so the chart silently fell back to
      // claiming a derived max whether or not Strava's real zones had loaded.
      await env.CACHE.put(CACHE_KEY, JSON.stringify({
        data: activities,
        aiSummary,
        updatedAt: new Date().toISOString(),
        hrZones: _hrZoneMeta,
      }), { expirationTtl: CACHE_TTL });
    }

    return new Response(JSON.stringify({ ...summary, ranAt: new Date().toISOString() }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: true, message: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function syncActivitiesToNotion(env) {
  const accessToken = await getAccessToken(env);
  const afterEpoch   = Math.floor(Date.now() / 1000) - TRAINING_LOG_LOOKBACK_DAYS * 86400;
  const activities   = await fetchRecentStravaActivities(accessToken, afterEpoch);

  let created = 0, skipped = 0, relinked = 0, failed = 0;
  const errors = [];
  // Shared across the whole run so a day with several activities costs one
  // diary lookup, not one per activity. Worth caring about: a Worker has a
  // hard cap on subrequests per invocation.
  const diaryCache = new Map();

  for (const a of activities) {
    const stravaUrl = `https://www.strava.com/activities/${a.id}`;
    // Strava returns start_date_local with a Z suffix even though it is local
    // time, so the first ten characters are the day it happened where you were.
    const localDate = (a.start_date_local || '').slice(0, 10);
    try {
      const existing = await findTrainingLogPageByUrl(stravaUrl, env);
      if (existing) {
        if (await repairDiaryLink(existing, localDate, env, diaryCache)) relinked++;
        else skipped++;
        continue;
      }

      const props = buildTrainingLogProperties(a, stravaUrl);
      const diaryPageId = await findDiaryPageForDate(localDate, env, diaryCache);
      if (diaryPageId) props['Diary'] = { relation: [{ id: diaryPageId }] };

      await notionRequest('/v1/pages', env, {
        method: 'POST',
        body: JSON.stringify({
          parent:     { type: 'data_source_id', data_source_id: TRAINING_LOG_DATA_SOURCE_ID },
          properties: props,
        }),
      });
      created++;
    } catch (err) {
      failed++;
      errors.push({ id: a.id, name: a.name, message: err.message });
      console.error(`Training Log sync failed for activity ${a.id} (${a.name}): ${err.message}`);
    }
  }

  return { checked: activities.length, created, skipped, relinked, failed, errors };
}

async function fetchRecentStravaActivities(accessToken, afterEpoch) {
  const all  = [];
  let   page = 1;

  while (true) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return all;
}

async function findTrainingLogPageByUrl(stravaUrl, env) {
  const res = await notionRequest(`/v1/data_sources/${TRAINING_LOG_DATA_SOURCE_ID}/query`, env, {
    method: 'POST',
    body: JSON.stringify({
      filter:    { property: 'URL', url: { equals: stravaUrl } },
      page_size: 1,
    }),
  });
  return res.results && res.results.length > 0 ? res.results[0] : null;
}

// Ride cadence is reported in RPM; foot-sport cadence is per-leg strides/min,
// so it's doubled into SPM (total steps/min) alongside the raw per-leg value —
// matching how these two cadence fields were already being used in Notion.
const TRAINING_LOG_RIDE_TYPES = ['Ride', 'VirtualRide', 'EBikeRide', 'Handcycle'];
const TRAINING_LOG_FOOT_TYPES = ['Run', 'TrailRun', 'Walk', 'Hike'];

function paceSecondsToNotion(sec) {
  if (!sec || sec <= 0) return null;
  let m = Math.floor(sec / 60);
  let s = Math.round(sec % 60);
  if (s === 60) { m += 1; s = 0; }
  return m * 100 + s;
}

function buildTrainingLogProperties(a, stravaUrl) {
  const sportType  = a.sport_type || a.type || 'Workout';
  const distKm     = (a.distance || 0) / 1000;
  const distMi     = distKm * 0.621371;
  const elevM      = a.total_elevation_gain || 0;
  const elevFt     = elevM * 3.28084;
  const speedMs    = a.average_speed || 0;
  const speedKph   = speedMs * 3.6;
  const speedMph   = speedMs * 2.23694;
  const paceKmSec  = speedKph > 0 ? 3600 / speedKph : 0;
  const paceMiSec  = speedMph > 0 ? 3600 / speedMph : 0;
  const hasPartner = /\bw\/\s*(.+)/i.test(a.name || '');

  const props = {
    'Activity':        { title: [{ text: { content: a.name || 'Untitled activity' } }] },
    // start_date, not start_date_local. Strava returns start_date_local as
    // local time carrying a fake Z suffix ("2026-08-31T07:56:41Z" for an 07:56
    // BST run), so handing it to Notion stores it as 07:56 UTC and displays it
    // as 08:56 — an hour late for half the year. start_date is the honest UTC
    // instant, which is what every Zapier-era row holds and what makes Notion
    // render the right local time. The local date is still what decides the
    // diary day; that is read off start_date_local in the sync loop.
    'Start time':      { date: { start: a.start_date || a.start_date_local } },
    'Type':            { multi_select: [{ name: sportType }] },
    'Distance (mi)':   { number: round(distMi, 2) },
    'Distance (Km)':   { number: round(distKm, 2) },
    'Elevation (Ft)':  { number: round(elevFt, 1) },
    'Elevation (m)':   { number: round(elevM, 1) },
    'URL':             { url: stravaUrl },
    'w/':              { select: { name: hasPartner ? 'Joint Activity' : 'Solo Activity' } },
  };

  if (speedMph > 0) {
    props['Avg (MPH)'] = { number: round(speedMph, 2) };
    props['Avg (KPH)'] = { number: round(speedKph, 2) };
    props['Pace/m']    = { number: paceSecondsToNotion(paceMiSec) };
    props['Pace/k']    = { number: paceSecondsToNotion(paceKmSec) };
  }

  if (a.average_heartrate) props['HR (Avg)'] = { number: round(a.average_heartrate, 1) };
  if (a.max_heartrate)     props['HR (Max)'] = { number: a.max_heartrate };

  if (a.average_cadence) {
    if (TRAINING_LOG_RIDE_TYPES.includes(sportType)) {
      props['Cad'] = { number: round(a.average_cadence, 1) };
    } else if (TRAINING_LOG_FOOT_TYPES.includes(sportType)) {
      props['Cadence'] = { number: round(a.average_cadence, 1) };
      props['SPM']     = { number: round(a.average_cadence * 2, 1) };
    }
  }

  if (a.gear_id) props['Gear ID'] = { rich_text: [{ text: { content: a.gear_id } }] };

  // Best-effort guess — flag any Walk whose name mentions "dog". Not
  // authoritative; if it's wrong for a given entry just fix it in Notion.
  if (sportType === 'Walk' && /dog/i.test(a.name || '')) {
    props['Dog Walk'] = { select: { name: 'Dog Walk' } };
  }

  return props;
}

// =============================================================================
// TOKEN REFRESH
// =============================================================================

// Strava's refresh response may hand back a NEW refresh token, and the old one
// stops working when it does. A Worker secret is read-only at runtime, so the
// replacement would have nowhere to go and the next run would fail — which,
// on a cron nobody watches, is a silent death months from now. KV is the one
// place this Worker can write, so the live token lives there: the secret is
// only ever the seed for a cold start.
//
// Nothing deletes the stored value on failure. A transient Strava error would
// otherwise throw away a perfectly good token and fall back to a secret that
// is by definition older; re-running /auth is the recovery path instead, and
// the callback now writes to KV too so that actually fixes it.
const STRAVA_REFRESH_KEY = 'strava_refresh_token';

async function getAccessToken(env) {
  const stored  = env.CACHE ? await env.CACHE.get(STRAVA_REFRESH_KEY) : null;
  const current = stored || env.STRAVA_REFRESH_TOKEN;

  const res  = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: current,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  if (env.CACHE && data.refresh_token && data.refresh_token !== current) {
    await env.CACHE.put(STRAVA_REFRESH_KEY, data.refresh_token);
  }
  return data.access_token;
}

// =============================================================================
// PAGINATION
// =============================================================================

async function fetchAllActivities(accessToken, env, progress) {
  const all  = [];
  let   page = 1;
  const zones = homeZones(env);

  while (true) {
    const res   = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const batch = await res.json();

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const activity of batch) {
      all.push(transformActivity(activity, zones));
    }
    if (progress) await progress.stage('activities', { page, fetched: all.length });

    if (batch.length < 200) break; 
    page++;
  }

  if (progress) await progress.stage('gear', { page: 0 });
  const gearIds = [...new Set(all.map(a => a._gear_id).filter(Boolean))];
  const gearMap  = {};
  const knownGear = await loadGearNames(env);
  await fetchGearNames(gearIds, accessToken, gearMap, knownGear);
  await saveGearNames(env, knownGear);
  _gearMeta = {};
  for (const id of gearIds) {
    const rec = knownGear[id];
    if (rec && rec.name) {
      _gearMeta[rec.name] = {
        brand:   rec.brand   || null,
        model:   rec.model   || null,
        retired: !!rec.retired,
        // Derived here as well as read back, so gear resolved before the kind was
        // recorded still answers for it.
        kind:    rec.kind || (id[0] === 'b' ? 'bike' : id[0] === 'g' ? 'shoe' : null),
      };
    }
  }

  for (const a of all) {
    a.gear    = a._gear_id ? (gearMap[a._gear_id] || null) : null;
    delete a._gear_id;
  }

  if (progress) await progress.stage('zones');
  const hrZones = await fetchAthleteZones(accessToken);
  // Derived once from the whole history, not per activity — that was the bug.
  const athleteMaxHr = deriveAthleteMaxHr(all);
  // Recorded so the chart can state where its boundaries came from instead of
  // claiming "your Strava zones" whether or not they ever loaded.
  _hrZoneMeta = {
    athleteMaxHr,
    source: (hrZones && hrZones.length >= 5) ? 'strava' : 'derived',
  };
  console.log(`HR zones: athlete max ${athleteMaxHr ?? 'unknown'}, Strava zones ${hrZones ? 'loaded' : 'unavailable (needs profile:read_all)'}`);

  for (const a of all) {
    const zones = estimateZones(a.hr, a.max_hr, a.mt, hrZones, athleteMaxHr);
    a.z1 = zones.z1;
    a.z2 = zones.z2;
    a.z3 = zones.z3;
    a.z4 = zones.z4;
    a.z5 = zones.z5;
  }

  return all.sort((a, b) => a.date.localeCompare(b.date));
}

// =============================================================================
// BEST-EFFORT (SEGMENT PB) BACKFILL
// The Records tab has had six empty slots — 1k, 1 mile, 5k, 10k, half, marathon —
// since it was written, because transformActivity has nothing to fill them from:
// Strava's list endpoint omits best_efforts entirely. They arrive only on the
// detailed activity, one HTTP request per activity, and the API allows 100
// requests per 15 minutes and 1,000 a day.
//
// So this collects them gradually. Each cron run takes the newest runs that have
// not been asked about yet, up to BEST_EFFORTS_BUDGET of them, and records what
// came back. Runs with no best efforts (a treadmill session, a sub-1k jog) are
// stored as null so they are never asked about twice. A few hundred runs are
// covered within a week and the store is permanent from then on.
// =============================================================================

async function loadBestEfforts(env) {
  if (!env.CACHE) return {};
  try {
    const raw = await env.CACHE.get(BEST_EFFORTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    // A corrupt store costs a re-fetch, not a failed refresh.
    return {};
  }
}

async function saveBestEfforts(env, store) {
  if (!env.CACHE) return;
  // No expirationTtl: these never change once recorded, and re-deriving them
  // costs one Strava request per activity.
  await env.CACHE.put(BEST_EFFORTS_KEY, JSON.stringify(store));
}

// Write whatever has been collected onto the activity objects. Anything not yet
// asked about simply keeps its null, which the dashboard already renders as absent.
function applyBestEfforts(activities, store) {
  for (const a of activities) {
    const efforts = store[a.id];
    if (!efforts) continue;
    for (const field of Object.values(BEST_EFFORT_FIELDS)) {
      if (efforts[field] != null) a[field] = efforts[field];
    }
  }
}

// Only foot sports have best efforts. Asking about a ride wastes a request.
function hasBestEfforts(activity) {
  return ['Run', 'TrailRun', 'VirtualRun'].includes(activity.type);
}

async function backfillBestEfforts(env, accessToken, activities) {
  const store = await loadBestEfforts(env);

  // Newest first: a PB set last month matters more than filling in 2014.
  const pending = activities
    .filter(a => hasBestEfforts(a) && !(a.id in store))
    .sort((x, y) => y.date.localeCompare(x.date))
    .slice(0, BEST_EFFORTS_BUDGET);

  if (!pending.length) return { checked: 0, found: 0, remaining: 0 };

  let found = 0;
  for (let i = 0; i < pending.length; i += BEST_EFFORTS_BATCH) {
    const batch = pending.slice(i, i + BEST_EFFORTS_BATCH);
    const results = await Promise.all(
      batch.map(a => fetchBestEffortsFor(a.id, accessToken))
    );
    results.forEach((efforts, n) => {
      // undefined means the request failed — leave it out of the store entirely so
      // the next run retries it. null means asked and genuinely none.
      if (efforts === undefined) return;
      store[batch[n].id] = efforts;
      if (efforts) found++;
    });
  }

  await saveBestEfforts(env, store);
  applyBestEfforts(activities, store);

  const remaining = activities.filter(a => hasBestEfforts(a) && !(a.id in store)).length;
  return { checked: pending.length, found, remaining };
}

async function fetchBestEffortsFor(id, accessToken) {
  try {
    const res = await fetch(
      `https://www.strava.com/api/v3/activities/${id}?include_all_efforts=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.status === 429) {
      console.error(`Best efforts for ${id} rate-limited; will retry next run`);
      return undefined;
    }
    if (!res.ok) {
      // 404 means the activity is gone or private to this token. That will not
      // change on a retry, so record it as "none" rather than asking forever.
      if (res.status === 404) return null;
      console.error(`Best efforts for ${id} failed: ${res.status}`);
      return undefined;
    }
    const detail = await res.json();
    const efforts = Array.isArray(detail.best_efforts) ? detail.best_efforts : [];
    if (!efforts.length) return null;

    const out = {};
    for (const e of efforts) {
      const field = BEST_EFFORT_FIELDS[String(e.name || '').toLowerCase()];
      if (!field) continue;
      const t = e.elapsed_time || e.moving_time || 0;
      // Keep the fastest, in case Strava ever returns two efforts at one distance.
      if (t > 0 && (out[field] == null || t < out[field])) out[field] = t;
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    console.error(`Best efforts for ${id} threw: ${err.message}`);
    return undefined;
  }
}

// =============================================================================
// GEAR NAME LOOKUP
// Strava rate-limits short bursts fairly aggressively, and a full history
// re-sync can already burn through most of that quota on pagination alone.
// Fetching every distinct gear ID in one Promise.all burst risks 429s that
// were previously swallowed silently (falling back to the raw gear ID with
// no way to tell why). This fetches in small batches with a retry on 429
// and logs any failure that survives retries.
// =============================================================================

const GEAR_BATCH_SIZE   = 5;
const GEAR_MAX_RETRIES  = 3;
// Names are kept forever, not for a day. A bike's name does not change often
// enough to be worth re-asking Strava for on every sync, and re-asking was the
// whole problem: the map was rebuilt from {} each time, so one rate-limited
// lookup turned a perfectly well-known bike into "Unidentified gear" until the
// next successful full sync.
const GEAR_NAME_KEY = 'gear_names_v1';

async function loadGearNames(env) {
  try {
    const raw = await env.CACHE.get(GEAR_NAME_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(`Gear name cache unreadable, starting empty: ${err.message}`);
    return {};
  }
}

async function saveGearNames(env, known) {
  try {
    await env.CACHE.put(GEAR_NAME_KEY, JSON.stringify(known));
  } catch (err) {
    console.error(`Could not persist gear names: ${err.message}`);
  }
}

// `known` maps id -> {name} for gear we have resolved, or {gone:true} for gear
// Strava has deleted. Anything else is simply absent and worth asking about.
async function fetchGearNames(gearIds, accessToken, gearMap, known) {
  // A record already in KV used to be skipped forever, which meant retiring a pair
  // in Strava never reached the dashboard: the flag was whatever it had been the
  // first time that id was ever looked up. Retirement is effectively one-way, so a
  // record already flagged retired is settled and costs nothing to skip; everything
  // else is re-checked on every sync. That is one extra call per active item per
  // refresh, which against a few dozen items is nothing.
  const toFetch = gearIds.filter(id => !known[id] || !known[id].retired);
  for (let i = 0; i < toFetch.length; i += GEAR_BATCH_SIZE) {
    const batch = toFetch.slice(i, i + GEAR_BATCH_SIZE);
    await Promise.all(batch.map(id => fetchGearName(id, accessToken, gearMap, known)));
  }
  // Resolve every id against what we now know, falling back to the raw id only
  // when we have never once succeeded for it.
  for (const id of gearIds) {
    const rec = known[id];
    gearMap[id] = rec && rec.name ? rec.name : id;
  }
  const unresolved = gearIds.filter(id => !(known[id] && known[id].name));
  if (unresolved.length) {
    console.warn(`Gear still unresolved after this sync: ${unresolved.join(', ')}`);
  }
}

async function fetchGearName(id, accessToken, gearMap, known) {
  for (let attempt = 0; attempt <= GEAR_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://www.strava.com/api/v3/gear/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('Retry-After')) || 2 * (attempt + 1);
        if (attempt < GEAR_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        // Nothing is written to `known`: a rate limit says "ask me later", not
        // "this gear has no name". Writing here is what used to make the failure
        // permanent for the life of the cache.
        console.error(`Gear lookup for ${id} rate-limited after ${attempt + 1} attempts; will retry on the next sync`);
        return;
      }

      // 404 means the item has been deleted in Strava. It will never resolve, so
      // remember that and stop asking rather than spending a request a day on it.
      if (res.status === 404) {
        console.warn(`Gear ${id} no longer exists in Strava; recording it as deleted`);
        known[id] = { gone: true };
        return;
      }

      if (!res.ok) {
        console.error(`Gear lookup for ${id} failed: ${res.status} ${await res.text()}`);
        return;
      }

      const data = await res.json();
      // brand and model are on the same response the name comes from, and cost
      // nothing extra. A name is only recorded when Strava actually gave us one.
      if (data.name) {
        known[id] = {
          name: data.name,
          brand: data.brand_name || null,
          model: data.model_name || null,
          // Strava's id carries the kind: b1234567 is a bike, g1234567 a pair of
          // shoes. Nothing else on the response says so as plainly.
          kind: id[0] === 'b' ? 'bike' : id[0] === 'g' ? 'shoe' : null,
          retired: !!data.retired,
        };
      }
      return;
    } catch (err) {
      console.error(`Gear lookup for ${id} threw: ${err.message}`);
      return;
    }
  }
}

// =============================================================================
// HR ZONES ESTIMATION
// =============================================================================

async function fetchAthleteZones(accessToken) {
  try {
    const res  = await fetch('https://www.strava.com/api/v3/athlete/zones', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return data.heart_rate?.zones || null;
  } catch (_) {
    return null;
  }
}

function erf(x) {
  const t    = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const val  = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? val : -val;
}

function normalCDF(x, mean, std) {
  if (std <= 0) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

// Set by fetchAllActivities on each refresh and read straight afterwards by
// refreshActivitiesCache, which needs it for the envelope. Same request, no
// concurrency: a Worker isolate handles one refresh at a time.
let _hrZoneMeta = { athleteMaxHr: null, source: 'derived' };
// Gear brand, model and retired flag, keyed by the gear NAME the activities
// carry. The lookup that produces them is already made and already cached; this
// just stops the extra fields being thrown away at the door.
let _gearMeta = {};

// The athlete's maximum heart rate, derived from the history itself.
//
// This has to be derived because /athlete/zones needs the profile:read_all scope and
// this app only asks for activity:read_all — so fetchAthleteZones returns null and the
// real-zones branch below never fires. Re-authorising with the wider scope would give
// the true configured zones; until then the highest peak you have actually recorded is
// a better estimate of your ceiling than anything age-based.
//
// The 99th percentile rather than the outright maximum: across thousands of activities
// a handful of strap dropouts read 220+, and one bad contact should not set the scale
// for a decade of riding.
function deriveAthleteMaxHr(activities) {
  const peaks = activities
    .map(a => a.max_hr)
    .filter(v => typeof v === 'number' && v >= 120 && v <= 225)
    .sort((x, y) => x - y);
  if (peaks.length < 10) return null;
  return peaks[Math.floor(peaks.length * 0.99)] ?? peaks[peaks.length - 1];
}

// Split one activity's moving time across heart-rate zones.
//
// Two different numbers do two different jobs here, and the previous version conflated
// them: athleteMaxHr sets WHERE the zone boundaries sit, activityMaxHr sets HOW WIDE
// this particular activity's heart rate ranged. Passing the activity's own peak as the
// ceiling made every zone boundary a percentage of that day's high — so an average,
// which always sits close to its own day's peak, landed near the top of its own scale
// and a recovery spin scored 90% in zones 4 and 5.
function estimateZones(avgHr, activityMaxHr, movingTime, zones, athleteMaxHr) {
  const zero = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (!avgHr || movingTime === 0) return zero;

  // Last-resort ceiling if the history gave us nothing: assume a hard-ish average sits
  // around 80% of max. Only reached when there are fewer than ten HR activities.
  const ceiling = athleteMaxHr && athleteMaxHr > avgHr
    ? athleteMaxHr
    : Math.max(Math.round(avgHr / 0.80), avgHr + 15);

  const effectiveZones = (zones && zones.length >= 5) ? zones : [
    { min: 0,                          max: Math.round(ceiling * 0.60) },
    { min: Math.round(ceiling * 0.60), max: Math.round(ceiling * 0.70) },
    { min: Math.round(ceiling * 0.70), max: Math.round(ceiling * 0.80) },
    { min: Math.round(ceiling * 0.80), max: Math.round(ceiling * 0.90) },
    { min: Math.round(ceiling * 0.90), max: -1 },
  ];

  // Spread within this activity. The peak of a long-ish sample sits roughly 2.5
  // standard deviations above its mean, so (peak − average) / 2.5 estimates the
  // spread from the two numbers Strava actually gives us. A steady ride peaking 15
  // bpm over its average comes out tight; a session with real intervals peaking 60
  // over comes out wide. The old formula used (ceiling − average), which ran the
  // opposite way: the easier the ride, the wider it smeared the time.
  const span = (typeof activityMaxHr === 'number' && activityMaxHr > avgHr)
    ? activityMaxHr - avgHr
    : 12;
  const std = Math.min(Math.max(span / 2.5, 3), 30);

  const result = {};
  for (let i = 0; i < 5; i++) {
    const lo = effectiveZones[i].min;
    const hi = effectiveZones[i].max === -1 ? ceiling + 25 : effectiveZones[i].max;
    const proportion = Math.max(0, normalCDF(hi, avgHr, std) - normalCDF(lo, avgHr, std));
    result[`z${i + 1}`] = Math.round(proportion * movingTime);
  }

  // The curve's tails fall outside the zone range, so the five buckets come up a little
  // short of moving time. Scale them back up rather than quietly losing minutes.
  const total = result.z1 + result.z2 + result.z3 + result.z4 + result.z5;
  if (total > 0 && total < movingTime) {
    const k = movingTime / total;
    for (let i = 1; i <= 5; i++) result[`z${i}`] = Math.round(result[`z${i}`] * k);
  }

  return result;
}

// =============================================================================
// TRANSFORM API FORMAT
// =============================================================================

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function transformActivity(a, zones = []) {
  const date      = new Date(a.start_date_local);
  const dist_km   = (a.distance || 0) / 1000;
  const dist_mi   = dist_km * 0.621371;
  const elv_ft    = (a.total_elevation_gain || 0) * 3.28084;
  const speed_ms  = a.average_speed || 0;
  const speed_kph = speed_ms * 3.6;
  const speed_mph = speed_ms * 2.23694;
  const pace_km   = speed_kph > 0 ? 3600 / speed_kph : 0;
  const pace_mi   = speed_mph > 0 ? 3600 / speed_mph : 0;

  // Privacy: snap start point to nearest home zone centre (3dp ≈ 100m) if within exclusion radius
  const rawLat = a.start_latlng?.[0] ?? null;
  const rawLng = a.start_latlng?.[1] ?? null;
  const isHome = !!(zones.length && rawLat && rawLng && nearHome(rawLat, rawLng, zones, "snap"));
  let lat = rawLat, lng = rawLng;
  if (isHome) {
    const z = nearestZone(rawLat, rawLng, zones);
    lat = Math.round(z.lat * 1000) / 1000;
    lng = Math.round(z.lng * 1000) / 1000;
  }

  // Privacy: drop any part of the route (start, end, or mid-route pass-through)
  // that falls within a home exclusion zone
  const rawPolyline = a.map?.summary_polyline || null;
  const polylines = rawPolyline ? (zones.length ? splitPolylineExcludingZones(rawPolyline, zones) : [rawPolyline]) : [];

  return {
    id:         String(a.id),
    date:       a.start_date_local.slice(0, 10),
    // The local clock time, which used to be sliced off and thrown away with the
    // rest of the timestamp. "HH:MM", already in the athlete's own timezone.
    time:       a.start_date_local.slice(11, 16),
    type:       a.sport_type || a.type || 'Other',
    sport:      a.sport_type || a.type || 'Other',
    name:       a.name || '',
    dist_mi:    round(dist_mi, 2),
    dist_km:    round(dist_km, 2),
    elv:        round(elv_ft, 1),
    mt:         a.moving_time  || 0,
    // Elapsed minus moving is time spent stopped. Without it a four-hour ride with
    // ninety minutes of cafe reads exactly like a two-and-a-half-hour ride.
    et:         a.elapsed_time || 0,
    cad:        a.average_cadence || null,
    // Strava knows the real participant count; the Social tab was inferring company
    // by regex-matching "w/ Name" out of activity titles, so it only ever knew about
    // the ones you remembered to type.
    athletes:   a.athlete_count || 1,
    commute:    !!a.commute,
    // 1 = race for runs, 11 = race for rides. Lets a race be told from a hard Tuesday.
    wtype:      a.workout_type != null ? a.workout_type : null,
    hr:         a.average_heartrate || null,
    max_hr:     a.max_heartrate     || 0,
    cal:        a.calories || Math.round(a.kilojoules || 0),
    pace_mi:    Math.round(pace_mi),
    pace_km:    Math.round(pace_km),
    speed_mph:  round(speed_mph, 2),
    speed_kph:  round(speed_kph, 2),
    gear:       null,
    _gear_id:   a.gear_id || null,
    kudos:      a.kudos_count || 0,
    has_map:    polylines.length > 0,
    polylines,
    lat,
    lng,
    near_home:  isHome,
    score:      a.suffer_score || 0,
    z1: 0, z2: 0, z3: 0, z4: 0, z5: 0,
    pr_1km:  null,
    pr_5km:  null,
    pr_10km: null,
    pr_1mi:  null,
    pr_hm:   null,
    pr_mar:  null,
    // The highest and lowest point the activity reached, in feet to match elv.
    // Free on the summary object; this is a record rather than a trend, so the
    // Records page is where it surfaces.
    elev_hi: a.elev_high != null ? round(a.elev_high * 3.28084, 0) : null,
    elev_lo: a.elev_low  != null ? round(a.elev_low  * 3.28084, 0) : null,
    pwr:     a.average_watts || null,
    max_pwr: a.max_watts     || null,
    // Normalised power weights the surges, so it beats a flat average on anything
    // with hills or junctions in it. Strava gives it free on the summary object.
    np:      a.weighted_average_watts || null,
    // Whether those watts came off a power meter or were estimated from speed and
    // weight. An estimate is not wrong, but a power trend built on one is really a
    // speed trend, and the chart should be able to say so.
    pwr_real: a.device_watts === true,
    dow:     DAYS[date.getDay()],
    // 0 °C is a real temperature, so the usual `|| null` idiom would silently
    // discard every freezing ride. Only an absent reading becomes null.
    temp:    a.average_temp != null ? a.average_temp : null,
  };
}

function round(val, dp) {
  const m = Math.pow(10, dp);
  return Math.round(val * m) / m;
}

// =============================================================================
// HOME PRIVACY HELPERS
// Reads HOME_LAT_1/HOME_LNG_1 … HOME_LAT_5/HOME_LNG_5 from Cloudflare secrets.
//
// TWO radii, because they protect two different things and want different
// sizes:
//
//   snap — the published start point. An activity starting inside this is
//          reported from the zone centre, rounded to 3 dp (~100 m), instead
//          of from its real start. This is a single coarse coordinate, it
//          costs nothing to keep generous, so it stays at a quarter mile.
//
//   draw — how much of the ROUTE is cut away. Any point inside this, at the
//          start, at the end, or passing through mid-route, is dropped and
//          the route splits into separate segments. This is the one you see:
//          it is the gap at each end of every drawn line.
//
// They used to be the same quarter mile, which is 402 m off each end of a
// route. On a long run that is unnoticeable. On a sub-mile dog walk that
// starts and finishes at the door it removed most of the walk, and what was
// left drew as a stub or as nothing at all. HOME_EXCLUSION_M (metres) sets
// the draw radius; 100 m keeps the line off the door and little more.
// =============================================================================

const SNAP_MILES = 0.25;
const DEFAULT_DRAW_M = 100;
const METRES_PER_MILE = 1609.344;

// Clamped rather than trusted: this is read from a project variable, and a
// typo that parsed as 0 would put the line back on the doorstep, while a
// huge one would quietly delete every route. Anything unreadable falls back
// to the default.
function drawMiles(env) {
  const m = parseFloat((env && env.HOME_EXCLUSION_M) ?? "");
  const metres = Number.isFinite(m) && m >= 50 && m <= 5000 ? m : DEFAULT_DRAW_M;
  return metres / METRES_PER_MILE;
}

function homeZones(env) {
  if (!env) return [];
  const draw = drawMiles(env);
  const zones = [];
  for (let i = 1; i <= 5; i++) {
    const lat = parseFloat(env[`HOME_LAT_${i}`]);
    const lng = parseFloat(env[`HOME_LNG_${i}`]);
    if (!isNaN(lat) && !isNaN(lng)) zones.push({ lat, lng, snap: SNAP_MILES, draw });
  }
  return zones;
}

function geoDistMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// which is "snap" or "draw" — see the two radii above. Named rather than
// defaulted, so a new caller has to say which of the two it means instead
// of silently getting whichever one happened to be the default.
function nearHome(lat, lng, zones, which) {
  return zones.some(z => geoDistMiles(lat, lng, z.lat, z.lng) < z[which]);
}

function nearestZone(lat, lng, zones) {
  return zones.reduce((best, z) => {
    const d = geoDistMiles(lat, lng, z.lat, z.lng);
    return d < best.d ? { z, d } : best;
  }, { z: zones[0], d: Infinity }).z;
}

function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const pts = [];
  while (i < str.length) {
    let b, shift = 0, val = 0;
    do { b = str.charCodeAt(i++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (val & 1) ? ~(val >> 1) : (val >> 1);
    shift = val = 0;
    do { b = str.charCodeAt(i++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (val & 1) ? ~(val >> 1) : (val >> 1);
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

function encodePolyline(pts) {
  function enc(n) {
    let v = Math.round(n * 1e5);
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  }
  let pLat = 0, pLng = 0, s = '';
  for (const [lat, lng] of pts) {
    s += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return s;
}

// Drops every point that falls within a home exclusion zone — not just a
// contiguous run at the start/end — so a route that merely passes through
// (a commute, a through-road) never draws a line near home either. What's
// left is split into one or more disconnected segments.
//
// Uses the "draw" radius, not "snap": this is the one that decides how much
// of the line disappears, and a short walk from the door has very little to
// spare. A segment of fewer than two points is dropped, so the smaller this
// radius is, the fewer times a walk gets cut into pieces too short to keep.
function splitPolylineExcludingZones(str, zones) {
  if (!str || !zones.length) return [str];
  const pts = decodePolyline(str);
  const segments = [];
  let current = [];
  for (const [lat, lng] of pts) {
    if (nearHome(lat, lng, zones, "draw")) {
      if (current.length >= 2) segments.push(current);
      current = [];
    } else {
      current.push([lat, lng]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments.map(encodePolyline);
}

// ── The weekly email ─────────────────────────────────────────────────────────
// weekly.js decides when and builds it; this is what it reads: the stored activities,
// Garmin's days and activities, and the Zwift routes (from Notion, or the cached copy
// if Notion will not answer).
async function weeklyData(env) {
  let acts = [];
  try {
    const raw = (await env.CACHE.get(LAST_GOOD_KEY)) || (await env.CACHE.get(CACHE_KEY));
    acts = (JSON.parse(raw || '{}').data) || [];
  } catch (e) { acts = []; }
  const g = garminConfigured(env) ? ((await readGarmin(env)) || { days: {} }) : { days: {} };
  let routes = [];
  try { routes = await fetchAllZwiftRoutes(env); } catch (e) {
    try { routes = JSON.parse((await env.CACHE.get(ZWIFT_CACHE_KEY)) || '{}').data || []; } catch (e2) { routes = []; }
  }
  return { acts, days: g.days || {}, gacts: g.acts || {}, routes, garminError: g.error || null };
}
