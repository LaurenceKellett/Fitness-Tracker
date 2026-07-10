// =============================================================================
// FITNESS TRACKER — CLOUDFLARE WORKER (WITH SMART LFETIME AI SUMMARY)
// =============================================================================
// Routes:
//   GET /auth        → redirects to Strava OAuth (run once to get refresh token)
//   GET /callback    → exchanges code, shows you your refresh token to copy
//   GET /activities  → returns data & AI summary in cached envelope
//   GET /activities?refresh=true → forces a fresh pull & completely regenerates AI
//   GET /zwift-routes → returns all Zwift routes from Notion in a cached envelope
//   GET /zwift-routes?refresh=true → forces a fresh pull from Notion
//   PATCH /zwift-routes/{pageId} → updates Status/Date completed/Time on one route
// =============================================================================

// ---- IMPORTANT: replace this with your actual Worker URL ------------------
const WORKER_URL = 'https://activities-api.lk-ff7.workers.dev/';
// ---------------------------------------------------------------------------

const CACHE_KEY  = 'activities_v2';
const CACHE_TTL  = 60 * 60 * 24; // 24 hours in seconds

const ZWIFT_DATA_SOURCE_ID = '13b81faa-c3d2-4f94-83ca-bc782626f1e3';
const ZWIFT_CACHE_KEY      = 'zwift_routes_v1';
const ZWIFT_CACHE_TTL      = 120; // 2 minutes — writes invalidate this immediately anyway

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    switch (url.pathname) {
      case '/auth':         return handleAuth(env);
      case '/callback':     return handleCallback(request, env);
      case '/activities':   return handleActivities(request, env);
      case '/debug':        return handleDebug(env);
      case '/zwift-routes': return handleZwiftRoutes(request, env);
      default:
        if (url.pathname.startsWith('/zwift-routes/') && request.method === 'PATCH') {
          const pageId = url.pathname.slice('/zwift-routes/'.length);
          return handleZwiftRouteUpdate(request, env, pageId);
        }
        return new Response('Not found', { status: 404 });
    }
  }
};

// =============================================================================
// AUTH — step 1 of one-time OAuth setup
// =============================================================================

function handleAuth(env) {
  const params = new URLSearchParams({
    client_id:       env.STRAVA_CLIENT_ID,
    redirect_uri:    `${WORKER_URL}/callback`,
    response_type:   'code',
    approval_prompt: 'force',
    scope:           'activity:read_all',
  });
  return Response.redirect(
    `https://www.strava.com/oauth/authorize?${params}`,
    302
  );
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
  <p>Copy the refresh token below, then go to your Worker in the Cloudflare dashboard
     → <strong>Settings → Variables and Secrets</strong> → add a secret called
     <code>STRAVA_REFRESH_TOKEN</code> and paste it in.</p>
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
  const forceRefresh = url.searchParams.get('refresh') === 'true';

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

  // Get a fresh access token using the stored refresh token
  const accessToken = await getAccessToken(env);

  // Fetch every page of activities from Strava
  const activities  = await fetchAllActivities(accessToken, env);
  
  // Calculate historical metrics & request high-context AI response
  let aiSummary = "No AI summary generated.";
  if (env.AI) {
    aiSummary = await generateAiSummary(activities, env);
  }

  // Combine raw list data alongside the AI response into the response envelope
  const envelope = JSON.stringify({ 
    data: activities, 
    aiSummary: aiSummary,
    updatedAt: new Date().toISOString() 
  });

  // Save to KV cache
  if (env.CACHE) {
    await env.CACHE.put(CACHE_KEY, envelope, { expirationTtl: CACHE_TTL });
  }

  return new Response(envelope, {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'X-Cache':       'MISS',
    },
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

async function handleDebug(env) {
  const out = {};

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  out.token_response = tokenData;

  if (!tokenData.access_token) {
    return new Response(JSON.stringify(out, null, 2), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const actRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=5&page=1',
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );
  out.activities_status = actRes.status;
  out.activities_response = await actRes.json();

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
      await env.CACHE.put(ZWIFT_CACHE_KEY, envelope, { expirationTtl: ZWIFT_CACHE_TTL });
    }

    return new Response(envelope, {
      headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (err) {
    return notionErrorResponse(err);
  }
}

async function handleZwiftRouteUpdate(request, env, pageId) {
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

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: true, code: 'validation', message: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { status, date_completed, time } = body;
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
    const page = await notionRequest(`/v1/pages/${pageId}`, env, {
      method: 'PATCH',
      body:   JSON.stringify({ properties }),
    });

    if (env.CACHE) {
      await env.CACHE.delete(ZWIFT_CACHE_KEY);
    }

    return new Response(JSON.stringify({ data: transformNotionRoute(page) }), {
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
// TOKEN REFRESH
// =============================================================================

async function getAccessToken(env) {
  const res  = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// =============================================================================
// PAGINATION
// =============================================================================

async function fetchAllActivities(accessToken, env) {
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

    if (batch.length < 200) break; 
    page++;
  }

  const gearIds = [...new Set(all.map(a => a._gear_id).filter(Boolean))];
  const gearMap  = {};
  await fetchGearNames(gearIds, accessToken, gearMap);

  for (const a of all) {
    a.gear    = a._gear_id ? (gearMap[a._gear_id] || null) : null;
    delete a._gear_id;
  }

  const hrZones = await fetchAthleteZones(accessToken);

  for (const a of all) {
    const zones = estimateZones(a.hr, a.max_hr, a.mt, hrZones);
    a.z1 = zones.z1;
    a.z2 = zones.z2;
    a.z3 = zones.z3;
    a.z4 = zones.z4;
    a.z5 = zones.z5;
  }

  return all.sort((a, b) => a.date.localeCompare(b.date));
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

async function fetchGearNames(gearIds, accessToken, gearMap) {
  for (let i = 0; i < gearIds.length; i += GEAR_BATCH_SIZE) {
    const batch = gearIds.slice(i, i + GEAR_BATCH_SIZE);
    await Promise.all(batch.map(id => fetchGearName(id, accessToken, gearMap)));
  }
}

async function fetchGearName(id, accessToken, gearMap) {
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
        console.error(`Gear lookup for ${id} rate-limited after ${attempt + 1} attempts, falling back to raw ID`);
        gearMap[id] = id;
        return;
      }

      if (!res.ok) {
        console.error(`Gear lookup for ${id} failed: ${res.status} ${await res.text()}`);
        gearMap[id] = id;
        return;
      }

      const data = await res.json();
      gearMap[id] = data.name || id;
      return;
    } catch (err) {
      console.error(`Gear lookup for ${id} threw: ${err.message}`);
      gearMap[id] = id;
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

function estimateZones(avgHr, maxHr, movingTime, zones) {
  const zero = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (!avgHr || movingTime === 0) return zero;

  const effectiveMax = maxHr > 0 ? maxHr : Math.round(avgHr / 0.80);

  const effectiveZones = (zones && zones.length >= 5) ? zones : [
    { min: 0,                               max: Math.round(effectiveMax * 0.60) },
    { min: Math.round(effectiveMax * 0.60), max: Math.round(effectiveMax * 0.70) },
    { min: Math.round(effectiveMax * 0.70), max: Math.round(effectiveMax * 0.80) },
    { min: Math.round(effectiveMax * 0.80), max: Math.round(effectiveMax * 0.90) },
    { min: Math.round(effectiveMax * 0.90), max: -1 },
  ];

  const std = Math.max((effectiveMax - avgHr) / 1.5, 3);

  const result = {};
  for (let i = 0; i < 5; i++) {
    const lo = effectiveZones[i].min;
    const hi = effectiveZones[i].max === -1 ? effectiveMax + 40 : effectiveZones[i].max;
    const proportion = Math.max(0, normalCDF(hi, avgHr, std) - normalCDF(lo, avgHr, std));
    result[`z${i + 1}`] = Math.round(proportion * movingTime);
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
  const isHome = !!(zones.length && rawLat && rawLng && nearHome(rawLat, rawLng, zones));
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
    type:       a.sport_type || a.type || 'Other',
    sport:      a.sport_type || a.type || 'Other',
    name:       a.name || '',
    dist_mi:    round(dist_mi, 2),
    dist_km:    round(dist_km, 2),
    elv:        round(elv_ft, 1),
    mt:         a.moving_time  || 0,
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
    pwr:     a.average_watts || null,
    max_pwr: a.max_watts     || null,
    dow:     DAYS[date.getDay()],
    temp:    null,
  };
}

function round(val, dp) {
  const m = Math.pow(10, dp);
  return Math.round(val * m) / m;
}

// =============================================================================
// HOME PRIVACY HELPERS
// Reads HOME_LAT_1/HOME_LNG_1 … HOME_LAT_5/HOME_LNG_5 from Cloudflare secrets.
// Activities starting within EXCLUSION_MILES of any zone have their start point
// snapped to the zone centre (3 dp ≈ 100 m). Any point of the route — start,
// end, or a mid-route pass-through — within that radius of any zone is
// dropped, splitting the route into separate segments where needed.
// =============================================================================

const EXCLUSION_MILES = 0.25;

function homeZones(env) {
  if (!env) return [];
  const zones = [];
  for (let i = 1; i <= 5; i++) {
    const lat = parseFloat(env[`HOME_LAT_${i}`]);
    const lng = parseFloat(env[`HOME_LNG_${i}`]);
    if (!isNaN(lat) && !isNaN(lng)) zones.push({ lat, lng });
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

function nearHome(lat, lng, zones) {
  return zones.some(z => geoDistMiles(lat, lng, z.lat, z.lng) < EXCLUSION_MILES);
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
function splitPolylineExcludingZones(str, zones) {
  if (!str || !zones.length) return [str];
  const pts = decodePolyline(str);
  const segments = [];
  let current = [];
  for (const [lat, lng] of pts) {
    if (nearHome(lat, lng, zones)) {
      if (current.length >= 2) segments.push(current);
      current = [];
    } else {
      current.push([lat, lng]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments.map(encodePolyline);
}
