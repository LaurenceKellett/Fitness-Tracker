// =============================================================================
// FITNESS TRACKER — CLOUDFLARE WORKER (WITH SMART LFETIME AI SUMMARY)
// =============================================================================
// Routes:
//   GET /auth        → redirects to Strava OAuth (run once to get refresh token)
//   GET /callback    → exchanges code, shows you your refresh token to copy
//   GET /activities  → returns data & AI summary in cached envelope
//   GET /activities?refresh=true → forces a fresh pull & completely regenerates AI
// =============================================================================

// ---- IMPORTANT: replace this with your actual Worker URL ------------------
const WORKER_URL = 'https://activities-api.lk-ff7.workers.dev/';
// ---------------------------------------------------------------------------

const CACHE_KEY  = 'activities_v2'; 
const CACHE_TTL  = 60 * 60 * 24; // 24 hours in seconds

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
      case '/auth':       return handleAuth(env);
      case '/callback':   return handleCallback(request, env);
      case '/activities': return handleActivities(request, env);
      case '/debug':      return handleDebug(env);
      default:            return new Response('Not found', { status: 404 });
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
  const activities  = await fetchAllActivities(accessToken);
  
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
    if (!activities || activities.length === 0) {
      return "No training data found to summarize.";
    }

    // 1. Crunch metrics across your ENTIRE history in pure JS (Zero Token Cost)
    let totalMiles = 0;
    let totalElevation = 0;
    let totalWorkouts = activities.length;
    let highestHeartRate = 0;
    let sportCounts = {};

    for (const act of activities) {
      totalMiles += (act.dist_mi || 0);
      totalElevation += (act.elv || 0);
      if (act.hr > highestHeartRate) highestHeartRate = act.hr;
      
      const type = act.type || 'Other';
      sportCounts[type] = (sportCounts[type] || 0) + 1;
    }

    let favoriteSport = "None";
    let favoriteSportCount = 0;
    for (const [sport, count] of Object.entries(sportCounts)) {
      if (count > favoriteSportCount) {
        favoriteSport = sport;
        favoriteSportCount = count;
      }
    }

    // 2. Isolate the 5 most recent activities from the end of the sorted array
    const recent = activities.slice(-5).reverse();
    const recentDataStr = recent.map(a => 
      `- ${a.date}: ${a.type} - "${a.name}" (${a.dist_mi} mi, ${Math.round(a.mt / 60)} mins, Avg HR: ${a.hr || 'N/A'})`
    ).join('\n');

    // 3. Assemble prompt providing full macro history + micro context
    const systemPrompt = `You are a concise, supportive personal fitness coach. Analyze the athlete's lifetime fitness totals alongside their most recent workouts. Provide a punchy, highly encouraging 3-sentence summary of their fitness progress, highlighting their career milestones and their current momentum. Do not use any markdown bolding symbols like '**'. Provide plain, natural text.`;
    
    const userPrompt = `Here is my overall historical career summary crunched from my full tracking history:
- Total Career Workouts: ${totalWorkouts}
- Total Career Distance: ${Math.round(totalMiles)} miles
- Total Career Elevation Gain: ${Math.round(totalElevation)} feet
- Primary Sport: ${favoriteSport} (${favoriteSportCount} sessions)
- Highest Recorded Avg Heart Rate: ${highestHeartRate || 'N/A'} bpm

Here are my 5 most recent workouts for immediate context:
${recentDataStr}

Coach Summary:`;

    // Perform edge inference
    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    return aiResponse.response || "Inference completed without returning text.";
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

async function fetchAllActivities(accessToken) {
  const all  = [];
  let   page = 1;

  while (true) {
    const res   = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const batch = await res.json();

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const activity of batch) {
      all.push(transformActivity(activity));
    }

    if (batch.length < 200) break; 
    page++;
  }

  const gearIds = [...new Set(all.map(a => a._gear_id).filter(Boolean))];
  const gearMap  = {};
  await Promise.all(gearIds.map(async id => {
    try {
      const res  = await fetch(`https://www.strava.com/api/v3/gear/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      gearMap[id] = data.name || id;
    } catch (_) {
      gearMap[id] = id;
    }
  }));

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

function transformActivity(a) {
  const date      = new Date(a.start_date_local);
  const dist_km   = (a.distance || 0) / 1000;
  const dist_mi   = dist_km * 0.621371;
  const elv_ft    = (a.total_elevation_gain || 0) * 3.28084; 
  const speed_ms  = a.average_speed || 0;
  const speed_kph = speed_ms * 3.6;
  const speed_mph = speed_ms * 2.23694;
  const pace_km   = speed_kph > 0 ? 3600 / speed_kph : 0;
  const pace_mi   = speed_mph > 0 ? 3600 / speed_mph : 0;

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
    has_map:    !!(a.map && a.map.summary_polyline),
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
