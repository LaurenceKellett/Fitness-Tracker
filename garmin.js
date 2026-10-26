/* garmin.js — the owner's Garmin data, from Garmin's Personal API.
 *
 * Garmin's Personal API (October 2026) reads one person's own Garmin Connect data with
 * a key they make in Connect: GARMIN_API, a Worker secret. The key is swapped for a
 * bearer token (a JWT, good for 24 hours, no refresh token) and the token reads.
 * Paths and field names are from Garmin's own client (garmin-connect-personal-api-
 * python 1.0.0) and the typed models in gcpapi-sync, generated from Garmin's OpenAPI
 * document, and checked against the owner's live account (the Tools app's brief, 24
 * October 2026): the request limits and the defensive reading below come from that.
 * A key lasts 30 days to a year; when it expires the token swap is refused, what is
 * stored stays as it was, and the error is kept for the dashboard to show.
 *
 * TWO STORES
 *   garmin_v1       per calendar day ('YYYY-MM-DD', the day as Garmin files it: sleep
 *                   and HRV under the morning you woke up):
 *                     steps, stepGoal, rhr, stress, bbMax, bbMin
 *                     sleepSec, sleepScore, sleepQ (EXCELLENT/GOOD/FAIR/POOR), deepSec,
 *                     lightSec, remSec, awakeSec, sleepStart / sleepEnd (local wall time,
 *                     'YYYY-MM-DDTHH:MM'), sleepNeed (minutes), resp (breaths a minute
 *                     asleep)
 *                     needBase, needFb, needTrain, needHist, needHrv, needNap (what
 *                     Garmin's sleep need was built from: its baseline in minutes and
 *                     its own reason codes), bedRecStart / bedRecEnd (its recommended
 *                     bedtime, minutes after midnight)
 *                     stressRest, stressLow, stressMed, stressHigh (seconds at each),
 *                     bbCharged, bbDrained, imMod, imVig (intensity minutes)
 *                     hrv, hrvWeek, hrvLow, hrvHigh, hrvStatus
 *   garmin_acts_v1  per Garmin activity: its local and GMT start, type, duration,
 *                   distance, average HR, time in each HR zone (5) and power zone (7),
 *                   aerobic and anaerobic Training Effect and its label, Garmin's
 *                   training load, and the Body Battery it used; best average power
 *                   over PC_SECS (the power curve), normalised power, TSS, IF, and the
 *                   VO2 max, FTP and lactate threshold Garmin held after it; breathing
 *                   rate; for runs, cadence, stride, ground contact, vertical
 *                   oscillation and ratio, grade-adjusted speed and fastest splits.
 *                   From each activity's own record (one request each, so a budget a
 *                   run, back to DETAIL_FLOOR): what you said about it (RPE, feel),
 *                   how closely it followed a planned workout and that workout's name,
 *                   and recovery heart rate. `det` marks one that has been read.
 * Nothing finer than a day for health, and nothing of nutrition, weight or cycle
 * tracking.
 *
 * BACK TO 2013, A RUN AT A TIME. A free Worker may make 50 outbound requests a run. A
 * year of days costs 27 (summaries 1, sleep 12, HRV 14) and activities about one a
 * month, so each run first rereads the last few days, then spends what is left of its
 * budget walking backwards from where the last run stopped, until GARMIN_FLOOR. On the
 * three-hourly cron that is roughly two days for the daily history and one more for the
 * activities; GET /health?refresh=1 runs another pass at once.
 *
 * WHO SEES IT. This is health data, so it is never part of the public activity feed
 * (and so never reaches the CV). It is read only through GET /health, which needs
 * the admin key.
 */

export const GARMIN_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
export const GARMIN_KV = 'garmin_v1';
export const GARMIN_ACTS_KV = 'garmin_acts_v1';
export const GARMIN_FLOOR = '2013-01-01';
// The longest span each endpoint accepts in one request, as seen on the live API.
// HRV's limit is undocumented, so it is kept to 28 days to be safe.
const WINDOW = { summaries: 365, sleep: 31, hrv: 28 };
const YEAR_COST = 1 + Math.ceil(365 / WINDOW.sleep) + Math.ceil(365 / WINDOW.hrv);   // 27
const ACT_PAGE = 45;
// Requests one run may make, under the free plan's 50 with room for the token and retries.
export const GARMIN_BUDGET = 40;
// Sleep and HRV land the morning after, and watches sync late, so each refresh rereads
// a few days rather than one; anything older is settled.
export const GARMIN_RECENT_DAYS = 4;
const RECENT_ACT_DAYS = 7;
// Each activity's own record carries what the list does not: your RPE and feel, workout
// compliance, recovery heart rate. Garmin added the first two around 2021, so there is
// no point reading further back than that, a request at a time.
export const DETAIL_FLOOR = '2021-01-01';
// While the activity history is still arriving, details get only this much of a run.
const DETAIL_SHARE = 8;
// The durations Garmin keeps a best average power for, in seconds.
export const PC_SECS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18000];
const SPLITS = [1000, 1609, 5000, 10000, 21098, 42195];

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
const maxDay = (a, b) => (a > b ? a : b);

// Garmin sends a date as 'YYYY-MM-DD', as epoch milliseconds, or as
// { date, localDate }, and a date-time as an ISO string or epoch milliseconds whose
// "local" ones are wall-clock time shifted into UTC. These read every form.
export function dayOf(v) {
  if (v && typeof v === 'object') return dayOf(v.localDate || v.date);
  if (typeof v === 'number' && isFinite(v)) return isoDay(new Date(v));
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '';
}
export function wallOf(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(v).toISOString().slice(0, 16);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) ? v.slice(0, 10) + 'T' + v.slice(11, 16) : null;
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

const secs = (ms) => { const n = num(ms); return n == null ? null : Math.round(n / 1000); };
// Garmin's reason codes, kept as sent (they are short words like NO_CHANGE); a number is
// kept as a number.
const code = (v) => (typeof v === 'string' && v.trim() ? v.trim() : num(v));

export function fromSummaries(json) {
  const out = {};
  rows(json, 'data').forEach((r) => {
    const day = dayOf(r.calendarDate);
    if (!day) return;
    out[day] = {
      steps: num(r.movement?.steps?.value),
      stepGoal: num(r.movement?.steps?.goal),
      rhr: num(r.heartRate?.restingValue),
      stress: num(r.stress?.avgLevel),
      bbMax: num(r.bodyBattery?.maxValue),
      bbMin: num(r.bodyBattery?.minValue),
      bbCharged: num(r.bodyBattery?.chargedValue),
      bbDrained: num(r.bodyBattery?.drainedValue),
      stressRest: secs(r.stress?.restDurationInMillis),
      stressLow: secs(r.stress?.lowStressDurationInMillis),
      stressMed: secs(r.stress?.mediumStressDurationInMillis),
      stressHigh: secs(r.stress?.highStressDurationInMillis),
      imMod: num(r.intensityMinutes?.moderate),
      imVig: num(r.intensityMinutes?.vigorous),
    };
  });
  return out;
}

export function fromSleep(json) {
  const out = {};
  rows(json, 'data').forEach((r) => {
    // The record's own date: a sleep record also holds nextSleepNeed.calendarDate,
    // which is the next day.
    const day = dayOf(r.calendarDate);
    if (!day) return;
    const secs = num(r.sleepTimeSeconds);
    // A night with no sleep recorded comes back as a row of nulls or zeros; that is
    // no data, not a night of no sleep.
    if (!secs) return;
    // Sleep need is minutes in practice; a value too large to be minutes is seconds.
    const mins = (v) => { const n = num(v); return n != null && n > 2000 ? Math.round(n / 60) : n; };
    const need = mins(r.sleepNeed?.actual);
    const sn = r.sleepNeed || {};
    out[day] = {
      sleepSec: secs,
      sleepScore: num(r.sleepScores?.overall?.value),
      sleepQ: typeof r.sleepScores?.overall?.qualifierKey === 'string' ? r.sleepScores.overall.qualifierKey : null,
      deepSec: num(r.deepSleepSeconds),
      lightSec: num(r.lightSleepSeconds),
      remSec: num(r.remSleepSeconds),
      awakeSec: num(r.awakeSleepSeconds),
      sleepStart: wallOf(r.sleepStartTimestampLocal),
      sleepEnd: wallOf(r.sleepEndTimestampLocal),
      sleepNeed: need,
      resp: num(r.averageRespirationValue),
      needBase: mins(sn.baseline),
      needFb: code(sn.feedback),
      needTrain: code(sn.trainingFeedback),
      needHist: code(sn.sleepHistoryAdjustment),
      needHrv: code(sn.hrvAdjustment),
      needNap: code(sn.napAdjustment),
      bedRecStart: num(sn.recommendedBedtimeStartMins),
      bedRecEnd: num(sn.recommendedBedtimeEndMins),
    };
  });
  return out;
}

export function fromHrv(json) {
  const out = {};
  rows(json, 'hrvSummaries').forEach((r) => {
    const day = dayOf(r.calendarDate);
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

// One Garmin activity, kept to what the dashboard draws: the zones are seconds.
export function fromActivities(json) {
  const out = {};
  rows(json, 'activities').forEach((r) => {
    const id = r.activityId != null ? String(r.activityId) : '';
    const start = typeof r.startTimeLocal === 'number' ? new Date(r.startTimeLocal).toISOString().slice(0, 19)
      : (typeof r.startTimeLocal === 'string' ? r.startTimeLocal.replace(' ', 'T').slice(0, 19) : null);
    if (!id || !start) return;
    const zones = [1, 2, 3, 4, 5].map((i) => num(r['hrTimeInZone_' + i]));
    const pz = [1, 2, 3, 4, 5, 6, 7].map((i) => num(r['powerTimeInZone_' + i]));
    const gmt = typeof r.startTimeGMT === 'number' ? new Date(r.startTimeGMT).toISOString().slice(0, 19)
      : (typeof r.startTimeGMT === 'string' ? r.startTimeGMT.replace(' ', 'T').slice(0, 19) : null);
    out[id] = {
      start, gmt,
      type: r.activityType?.typeKey || null,
      dur: num(r.movingDuration) ?? num(r.duration),
      dist: num(r.distance),
      hr: num(r.averageHR),
      zones: zones.some((v) => v != null) ? zones.map((v) => v || 0) : null,
      power: pz.some((v) => v != null) ? pz.map((v) => v || 0) : null,
      aerobic: num(r.aerobicTrainingEffect),
      anaerobic: num(r.anaerobicTrainingEffect),
      label: typeof r.trainingEffectLabel === 'string' ? r.trainingEffectLabel : null,
      load: num(r.activityTrainingLoad),
      bb: num(r.differenceBodyBattery),
      ...perfOf(r),
      ...inputOf(r),
    };
  });
  return out;
}

const isRun = (type) => /run/i.test(type || '');
// Power, fitness markers, breathing and, for a run, its form: only what is present, so a
// ride on a watch with no power meter costs nothing in storage.
function perfOf(r) {
  const o = {};
  const put = (k, v) => { if (v != null) o[k] = v; };
  if (r.excludeFromPowerCurveReports !== true) {
    const pc = PC_SECS.map((s) => num(r['maxAvgPower_' + s]));
    if (pc.some((v) => v)) o.pc = pc.map((v) => v || null);
  }
  put('ap', num(r.avgPower));
  put('np', num(r.normPower));
  put('tss', num(r.trainingStressScore));
  put('if', num(r.intensityFactor));
  put('vo2', num(r.vO2MaxValue));
  put('ftp', num(r.maxFtp));
  put('lt', num(r.lactateThresholdBpm));
  put('resp', num(r.avgRespirationRate));
  if (isRun(r.activityType?.typeKey)) {
    const run = {};
    const rput = (k, v) => { if (v != null) run[k] = v; };
    // Garmin's own cadence field is steps a minute on both feet; the "double" one is a
    // fallback some watches fill instead.
    rput('cad', num(r.averageRunningCadenceInStepsPerMinute) ?? num(r.avgDoubleCadence));
    rput('stride', num(r.avgStrideLength));
    rput('gct', num(r.avgGroundContactTime));
    rput('gcb', num(r.avgGroundContactBalance));
    rput('vo', num(r.avgVerticalOscillation));
    rput('vr', num(r.avgVerticalRatio));
    rput('gap', num(r.avgGradeAdjustedSpeed));
    const sp = SPLITS.map((m) => num(r['fastestSplit_' + m]));
    if (sp.some((v) => v)) run.splits = sp.map((v) => v || null);
    if (Object.keys(run).length) o.run = run;
  }
  return o;
}

// What you told Garmin about an activity, and how it went against a planned workout.
// RPE is stored as 10 to 100 (10 times the 1 to 10 scale); feel as 0, 25, 50, 75 or 100
// (very weak to very strong). Read from the list when it carries them, and from the
// activity's own record otherwise.
export function inputOf(r) {
  const o = {};
  let rpe = num(r.directWorkoutRpe) ?? num(r.perceivedWorkoutEffort);
  if (rpe != null && rpe > 10) rpe = Math.round(rpe / 10);
  if (rpe) o.rpe = rpe;
  const feel = num(r.directWorkoutFeel);
  if (feel != null) o.feel = feel;
  const comp = num(r.directWorkoutComplianceScore);
  if (comp != null) o.comp = comp;
  const rec = num(r.recoveryHeartRate);
  if (rec) o.recHr = rec;
  return o;
}

// An activity's own record: { summaryDTO: {...} } (or the summary bare).
export function fromDetail(json) {
  const s = (json && (json.summaryDTO || json.summary)) || json || {};
  return inputOf(s);
}
// The planned workout an activity followed, if any: its name.
export function workoutName(json) {
  const list = Array.isArray(json) ? json : rows(json, 'workouts');
  const w = list.find((x) => x && typeof x.workoutName === 'string' && x.workoutName.trim());
  return w ? w.workoutName.trim() : null;
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

// An activity read again from the list keeps what only its own record held (RPE, feel,
// compliance, recovery HR, the `det` mark), so the last week's activities, reread every
// run, are not read in detail every run too.
export function mergeActs(base, got) {
  const out = { ...(base || {}) };
  Object.entries(got || {}).forEach(([id, rec]) => { out[id] = { ...(out[id] || {}), ...rec }; });
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

// auth: { token, renew(), used }. `used` counts requests against the run's budget; a
// token that lapses mid-run is replaced once.
async function garminGet(auth, path, params) {
  const url = GARMIN_BASE + path + (params ? '?' + new URLSearchParams(params).toString() : '');
  let renewed = false, waited = false;
  for (;;) {
    auth.used++;
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${auth.token}` } });
    // 204 and 404 are "nothing for those days", not a failure.
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 401 && !renewed) { renewed = true; auth.used++; auth.token = await auth.renew(); continue; }
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

async function newAuth(env) {
  return { token: await garminToken(env), renew: () => garminToken(env), used: 1 };
}

// Every day from `from` to `to`, inclusive, from the three endpoints that carry it.
export async function pullDays(auth, from, to) {
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

// One page of activities in [from, to]; `more` says whether a fuller page may follow.
async function pullActivityPage(auth, from, to, start) {
  const json = await garminGet(auth, '/activitylist-service/activities/search/activities',
    { start: String(start), limit: String(ACT_PAGE), startDate: from, endDate: to });
  const list = rows(json, 'activities');
  return { acts: fromActivities(list), more: list.length >= ACT_PAGE };
}

// The first day of iso's month.
const monthStart = (iso) => iso.slice(0, 8) + '01';

// ── The stored copies ────────────────────────────────────────────────────────
async function readJson(env, key) {
  if (!env.CACHE) return null;
  try { return JSON.parse((await env.CACHE.get(key)) || 'null'); } catch (e) { return null; }
}
export async function readGarmin(env) {
  const [days, acts] = await Promise.all([readJson(env, GARMIN_KV), readJson(env, GARMIN_ACTS_KV)]);
  return days || acts ? { ...(days || { days: {} }), acts: (acts && acts.acts) || {} } : null;
}

// One run: the last few days and the last week's activities, then as much of the
// history as the budget allows, newest first. Each store is written back only when
// it changed, so a quiet run costs no KV write.
export async function refreshGarmin(env, { today, budget = GARMIN_BUDGET } = {}) {
  if (!garminConfigured(env)) return { skipped: 'GARMIN_API is not set.' };
  const now = today || isoDay(new Date());
  const stored = (await readJson(env, GARMIN_KV)) || { days: {} };
  const storedActs = (await readJson(env, GARMIN_ACTS_KV)) || { acts: {} };
  const back = { ...(stored.backfill || {}) };
  let days = stored.days || {};
  let acts = storedActs.acts || {};
  const report = { recent: true, years: 0, actPages: 0 };
  try {
    const auth = await newAuth(env);
    days = mergeDays(days, await pullDays(auth, addDays(now, -(GARMIN_RECENT_DAYS - 1)), now));
    acts = mergeActs(acts, (await pullActivityPage(auth, addDays(now, -(RECENT_ACT_DAYS - 1)), now, 0)).acts);

    // What you said about the last week's activities: a few requests, every run, so a
    // ride's RPE shows the same day.
    const detailIds = (from, cap) => Object.entries(acts)
      .filter(([, a]) => !a.det && a.start && a.start.slice(0, 10) >= from)
      .sort((x, y) => (x[1].start < y[1].start ? 1 : -1))
      .slice(0, cap).map(([id]) => id);
    const readDetails = async (ids) => {
      for (const id of ids) {
        if (budget - auth.used < 2) break;
        const d = fromDetail(await garminGet(auth, `/activity-service/activity/${encodeURIComponent(id)}`));
        // A workout name only matters where there was a workout to comply with.
        if (d.comp != null && budget - auth.used >= 1) {
          const w = workoutName(await garminGet(auth, `/activity-service/activity/${encodeURIComponent(id)}/workouts`));
          if (w) d.workout = w;
        }
        acts = { ...acts, [id]: { ...acts[id], ...d, det: 1 } };
        report.details = (report.details || 0) + 1;
      }
    };
    await readDetails(detailIds(addDays(now, -(RECENT_ACT_DAYS - 1)), 6));

    // Daily history: a year at a time, back from the earliest day held.
    let dailyCursor = back.daily || addDays(now, -GARMIN_RECENT_DAYS);
    while (dailyCursor > GARMIN_FLOOR && budget - auth.used >= YEAR_COST) {
      const end = addDays(dailyCursor, -1);
      const start = maxDay(GARMIN_FLOOR, addDays(end, -364));
      days = mergeDays(days, await pullDays(auth, start, end));
      dailyCursor = start;
      report.years++;
    }
    back.daily = dailyCursor;

    // Activities: a month at a time, a page at a time, once the days are done (the
    // days are what most charts need first).
    if (dailyCursor <= GARMIN_FLOOR) {
      let actCursor = back.acts || addDays(now, -RECENT_ACT_DAYS);
      let page = back.actsPage || 0;
      // DETAIL_SHARE is held back for the detail backlog below.
      while (actCursor > GARMIN_FLOOR && budget - auth.used >= 1 + DETAIL_SHARE) {
        const end = addDays(actCursor, -1);
        const start = maxDay(GARMIN_FLOOR, monthStart(end));
        const { acts: got, more } = await pullActivityPage(auth, start, end, page * ACT_PAGE);
        acts = mergeActs(acts, got);
        report.actPages++;
        if (more) { page++; continue; }
        actCursor = start; page = 0;
      }
      back.acts = actCursor;
      back.actsPage = page;
    }
    // The detail backlog, newest first, back to DETAIL_FLOOR: a share of the run while
    // the activity history is still coming in, everything left once it is done.
    const historyDone = dailyCursor <= GARMIN_FLOOR && (back.acts || '9') <= GARMIN_FLOOR;
    await readDetails(detailIds(DETAIL_FLOOR, historyDone ? budget : DETAIL_SHARE));
  } catch (err) {
    // What is already held is still good; say what went wrong beside it.
    const msg = err.message;
    if (stored.error !== msg && env.CACHE) {
      await env.CACHE.put(GARMIN_KV, JSON.stringify({ ...stored, error: msg, errorAt: new Date().toISOString() }));
    }
    throw err;
  }
  const next = { days, backfill: back, updatedAt: new Date().toISOString(), error: null };
  const daysChanged = JSON.stringify(days) !== JSON.stringify(stored.days || {})
    || JSON.stringify(back) !== JSON.stringify(stored.backfill || {}) || !!stored.error;
  if (daysChanged && env.CACHE) await env.CACHE.put(GARMIN_KV, JSON.stringify(next));
  if (JSON.stringify(acts) !== JSON.stringify(storedActs.acts || {}) && env.CACHE) {
    await env.CACHE.put(GARMIN_ACTS_KV, JSON.stringify({ acts, updatedAt: next.updatedAt }));
  }
  return { ...report, days: Object.keys(days).length, acts: Object.keys(acts).length, backfill: back, complete: back.daily <= GARMIN_FLOOR && (back.acts || '9') <= GARMIN_FLOOR };
}
