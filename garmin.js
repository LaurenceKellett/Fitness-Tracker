/* garmin.js — the owner's daily health numbers from Garmin's Personal API.
 *
 * Garmin's Personal API (October 2026) reads one person's own Garmin Connect data with
 * a key they make in Connect: GARMIN_API, a Worker secret. The key is swapped for a
 * bearer token (a JWT, good for 24 hours, no refresh token) and the token reads.
 * Paths and field names are from Garmin's own client (garmin-connect-personal-api-
 * python 1.0.0) and the typed models in gcpapi-sync, generated from Garmin's OpenAPI
 * document, and checked against the owner's live account (the Tools app's brief, 24
 * October 2026): the request limits and the defensive reading below come from that. A key lasts 30 days to a year; when it expires the token swap is
 * refused, the stored days stay as they were, and the error is kept for the
 * dashboard to show.
 *
 * WHAT IS KEPT, per calendar day ('YYYY-MM-DD', the day as Garmin files it: sleep and
 * HRV under the morning you woke up):
 *   steps, rhr (resting heart rate), stress (average level), bbMax / bbMin (Body
 *   Battery), sleepSec, sleepScore, hrv (last night's average, ms), hrvWeek (7-day
 *   average), hrvLow / hrvHigh (the balanced range), hrvStatus (BALANCED, LOW,
 *   UNBALANCED, POOR).
 * Nothing finer than a day, and nothing of nutrition, weight or cycle tracking.
 *
 * WHO SEES IT. This is health data, so it is never part of the public activity feed
 * (and so never reaches the CV). It is read only through GET /health, which needs
 * the admin key.
 */

export const GARMIN_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
export const GARMIN_KV = 'garmin_v1';
// The longest span each endpoint accepts in one request, as seen on the live API.
// HRV's limit is undocumented, so it is kept to 28 days to be safe.
const WINDOW = { summaries: 365, sleep: 31, hrv: 28 };
export const GARMIN_BACKFILL_DAYS = 365;
// Sleep and HRV land the morning after, and watches sync late, so each refresh rereads
// a few days rather than one; anything older is settled.
export const GARMIN_RECENT_DAYS = 4;

export function garminConfigured(env) {
  return !!(env && typeof env.GARMIN_API === 'string' && env.GARMIN_API.trim());
}

// ── Dates ────────────────────────────────────────────────────────────────────
export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d + n)));
}
// Inclusive [from, to] cut into pieces no longer than max days.
export function windows(from, to, max) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, max)) {
    const e = addDays(s, max - 1);
    out.push([s, e < to ? e : to]);
  }
  return out;
}

// ── Reading the answers ──────────────────────────────────────────────────────
// Each endpoint wraps its rows differently (a bare list, { data: [...] },
// { hrvSummaries: [...] }); this takes whichever it was given.
function rows(json, key) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json[key])) return json[key];
  // A wrapper under some other name: take the first array it holds.
  const first = json && typeof json === 'object' && Object.values(json).find(Array.isArray);
  return first || [];
}
// The API is new: any figure may be missing, and numbers sometimes arrive as strings.
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
};

export function fromSummaries(json) {
  const out = {};
  rows(json, 'data').forEach((r) => {
    const day = String(r.calendarDate || '').slice(0, 10);
    if (!day) return;
    out[day] = {
      steps: num(r.movement?.steps?.value),
      rhr: num(r.heartRate?.restingValue),
      stress: num(r.stress?.avgLevel),
      bbMax: num(r.bodyBattery?.maxValue),
      bbMin: num(r.bodyBattery?.minValue),
    };
  });
  return out;
}

export function fromSleep(json) {
  const out = {};
  rows(json, 'data').forEach((r) => {
    const day = String(r.calendarDate || '').slice(0, 10);
    if (!day) return;
    const secs = num(r.sleepTimeSeconds);
    // A night with no sleep recorded comes back as a row of nulls or zeros; that is
    // no data, not a night of no sleep.
    if (!secs) return;
    out[day] = { sleepSec: secs, sleepScore: num(r.sleepScores?.overall?.value) };
  });
  return out;
}

export function fromHrv(json) {
  const out = {};
  rows(json, 'hrvSummaries').forEach((r) => {
    const day = String(r.calendarDate || '').slice(0, 10);
    if (!day || num(r.lastNightAvg) == null) return;
    out[day] = {
      hrv: num(r.lastNightAvg),
      hrvWeek: num(r.weeklyAvg),
      hrvLow: num(r.baseline?.balancedLow),
      hrvHigh: num(r.baseline?.balancedUpper),
      hrvStatus: typeof r.status === 'string' ? r.status : null,
    };
  });
  return out;
}

// Later pieces win field by field, and a null never overwrites a number: a day read
// before its sleep had synced keeps its steps when the sleep arrives, and the other
// way round.
export function mergeDays(base, ...parts) {
  const out = { ...(base || {}) };
  parts.forEach((part) => Object.entries(part || {}).forEach(([day, rec]) => {
    const cur = { ...(out[day] || {}) };
    Object.entries(rec).forEach(([k, v]) => { if (v != null) cur[k] = v; });
    out[day] = cur;
  }));
  return out;
}

// ── Talking to Garmin ────────────────────────────────────────────────────────
async function garminToken(env) {
  const res = await fetch(GARMIN_BASE + TOKEN_PATH, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: `ApiKey ${env.GARMIN_API.trim()}` },
  });
  if (!res.ok) {
    const e = new Error(res.status === 401 || res.status === 403
      ? 'Garmin refused the GARMIN_API key: it has probably expired. Make a new one in Garmin Connect and replace the secret.'
      : `Garmin token request failed (${res.status}).`);
    e.status = res.status;
    throw e;
  }
  const token = (await res.text()).trim();
  if (!token) throw new Error('Garmin returned an empty token.');
  return token;
}

// auth: { token, renew() }, so a token that has lapsed mid-run is replaced once.
async function garminGet(auth, path, params) {
  const url = GARMIN_BASE + path + (params ? '?' + new URLSearchParams(params).toString() : '');
  let renewed = false, waited = false;
  for (;;) {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${auth.token}` } });
    // 204 and 404 are "nothing for those days", not a failure.
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 401 && !renewed) { renewed = true; auth.token = await auth.renew(); continue; }
    // One retry on a rate limit, honouring a short Retry-After; a longer wait is the
    // next run's job.
    if (res.status === 429 && !waited) {
      waited = true;
      const wait = Math.min(parseFloat(res.headers.get('Retry-After') || '2') || 2, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Garmin GET ${path} answered ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

// Every day from `from` to `to`, inclusive, from the three endpoints that carry it.
export async function pullGarmin(env, from, to) {
  const auth = { token: await garminToken(env), renew: () => garminToken(env) };
  const parts = [];
  for (const [s, e] of windows(from, to, WINDOW.summaries)) {
    parts.push(fromSummaries(await garminGet(auth, '/usersummary-service/v2/dailysummaries', { startDate: s, endDate: e })));
  }
  for (const [s, e] of windows(from, to, WINDOW.sleep)) {
    parts.push(fromSleep(await garminGet(auth, '/sleep-service/sleep/dailySleepSummariesByDate', { startDate: s, endDate: e })));
  }
  for (const [s, e] of windows(from, to, WINDOW.hrv)) {
    parts.push(fromHrv(await garminGet(auth, `/hrv-service/hrv/daily/${s}/${e}`)));
  }
  return mergeDays({}, ...parts);
}

// ── The stored copy ──────────────────────────────────────────────────────────
// { days: { 'YYYY-MM-DD': {...} }, updatedAt, error }. A year of days is about 50 KB.
export async function readGarmin(env) {
  if (!env.CACHE) return null;
  try { return JSON.parse((await env.CACHE.get(GARMIN_KV)) || 'null'); } catch (e) { return null; }
}

// The first run reads a year; every later one rereads the last few days. Written
// back only when something changed, so a quiet day costs no KV write.
export async function refreshGarmin(env, { today, recentDays = GARMIN_RECENT_DAYS } = {}) {
  if (!garminConfigured(env)) return { skipped: 'GARMIN_API is not set.' };
  const now = today || isoDay(new Date());
  const stored = (await readGarmin(env)) || { days: {} };
  const empty = !Object.keys(stored.days || {}).length;
  const from = addDays(now, empty ? -(GARMIN_BACKFILL_DAYS - 1) : -(recentDays - 1));
  let next;
  try {
    const fresh = await pullGarmin(env, from, now);
    next = { days: mergeDays(stored.days, fresh), updatedAt: new Date().toISOString(), error: null };
  } catch (err) {
    // The days already held are still good; say what went wrong beside them.
    next = { ...stored, error: err.message, errorAt: new Date().toISOString() };
    if (stored.error === err.message) return { error: err.message, unchanged: true };
    if (env.CACHE) await env.CACHE.put(GARMIN_KV, JSON.stringify(next));
    throw err;
  }
  const changed = JSON.stringify(next.days) !== JSON.stringify(stored.days || {}) || stored.error;
  if (changed && env.CACHE) await env.CACHE.put(GARMIN_KV, JSON.stringify(next));
  return { from, to: now, days: Object.keys(next.days).length, changed: !!changed };
}
