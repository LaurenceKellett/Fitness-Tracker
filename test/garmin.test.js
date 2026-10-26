// Garmin's daily health numbers: read from the Personal API, kept per day in KV, and
// shown to nobody without the admin key. Tested against a stubbed Garmin whose answers
// are shaped as its OpenAPI document describes them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  windows, addDays, fromSummaries, fromSleep, fromHrv, fromActivities, mergeDays, refreshGarmin,
  dayOf, wallOf, GARMIN_KV, GARMIN_ACTS_KV, GARMIN_FLOOR, GARMIN_BUDGET,
  PC_SECS, inputOf, fromDetail, workoutName, mergeActs, DETAIL_FLOOR,
} from '../garmin.js';
import worker from '../worker.js';

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const puts = [];
  return {
    m, puts,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { puts.push(k); m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
  };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.restoreAllMocks());

const SUMMARY = (day, o = {}) => ({
  calendarDate: day,
  movement: { steps: { value: 9120, goal: 8000 } },
  heartRate: { restingValue: 47, minValue: 44, maxValue: 160 },
  stress: { avgLevel: 28 },
  bodyBattery: { maxValue: 88, minValue: 21 },
  ...o,
});
const SLEEP = (day, o = {}) => ({
  calendarDate: day, sleepTimeSeconds: 26100, sleepScores: { overall: { value: 82, qualifierKey: 'GOOD' } },
  deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 6300, awakeSleepSeconds: 900,
  sleepStartTimestampLocal: '2026-10-23T23:05:12.0', sleepEndTimestampLocal: '2026-10-24T06:40:00.0',
  sleepNeed: { actual: 480 }, averageRespirationValue: 14.2, nextSleepNeed: { calendarDate: '2026-10-25' }, ...o,
});
const ACT = (day, o = {}) => ({
  activityId: Number(day.replace(/-/g, '')), startTimeLocal: day + 'T07:30:00.0', startTimeGMT: day + 'T06:30:00.0',
  activityType: { typeKey: 'virtual_ride' }, duration: 3700, movingDuration: 3600, distance: 32000, averageHR: 142,
  hrTimeInZone_1: 300, hrTimeInZone_2: 1500, hrTimeInZone_3: 1200, hrTimeInZone_4: 500, hrTimeInZone_5: 100,
  powerTimeInZone_1: 200, powerTimeInZone_2: 1400, powerTimeInZone_3: 1300, powerTimeInZone_4: 500, powerTimeInZone_5: 150, powerTimeInZone_6: 40, powerTimeInZone_7: 10,
  aerobicTrainingEffect: 3.4, anaerobicTrainingEffect: 1.1, trainingEffectLabel: 'TEMPO', activityTrainingLoad: 112, differenceBodyBattery: -18, ...o,
});
const HRV = (day, o = {}) => ({ calendarDate: day, lastNightAvg: 58, weeklyAvg: 61, baseline: { balancedLow: 55, balancedUpper: 70 }, status: 'BALANCED', ...o });

describe('reading Garmin\'s answers', () => {
  it('takes steps, resting HR, stress and Body Battery from the daily summaries', () => {
    expect(fromSummaries({ data: [SUMMARY('2026-10-24')] })).toMatchObject({
      '2026-10-24': { steps: 9120, stepGoal: 8000, rhr: 47, stress: 28, bbMax: 88, bbMin: 21 },
    });
  });
  it('takes duration and score from sleep, and skips a night with nothing recorded', () => {
    expect(fromSleep([SLEEP('2026-10-24'), SLEEP('2026-10-23', { sleepTimeSeconds: 0, sleepScores: null })]))
      .toMatchObject({ '2026-10-24': { sleepSec: 26100, sleepScore: 82, sleepQ: 'GOOD', deepSec: 5400, lightSec: 14400, remSec: 6300,
        awakeSec: 900, sleepStart: '2026-10-23T23:05', sleepEnd: '2026-10-24T06:40', sleepNeed: 480, resp: 14.2 } });
    expect(Object.keys(fromSleep([SLEEP('2026-10-24'), SLEEP('2026-10-23', { sleepTimeSeconds: 0 })]))).toEqual(['2026-10-24']);
  });
  it('takes time at each stress level, Body Battery charged and drained, and intensity minutes', () => {
    const d = fromSummaries([SUMMARY('2026-10-24', {
      stress: { avgLevel: 28, restDurationInMillis: 30600000, lowStressDurationInMillis: 14400000, mediumStressDurationInMillis: 3600000, highStressDurationInMillis: 900000 },
      bodyBattery: { maxValue: 88, minValue: 21, chargedValue: 62, drainedValue: 70 },
      intensityMinutes: { goal: 150, moderate: 20, vigorous: '35' },
    })])['2026-10-24'];
    expect(d).toMatchObject({ stressRest: 30600, stressLow: 14400, stressMed: 3600, stressHigh: 900, bbCharged: 62, bbDrained: 70, imMod: 20, imVig: 35 });
  });
  it('takes what sleep need was built from, and the recommended bedtime', () => {
    const d = fromSleep([SLEEP('2026-10-24', { sleepNeed: { baseline: 470, actual: 500, feedback: 'INCREASED', trainingFeedback: 'HIGH_LOAD',
      sleepHistoryAdjustment: 'NO_CHANGE', hrvAdjustment: 'INCREASING', napAdjustment: 'NO_CHANGE', recommendedBedtimeStartMins: 1350, recommendedBedtimeEndMins: 1410 } })])['2026-10-24'];
    expect(d).toMatchObject({ sleepNeed: 500, needBase: 470, needFb: 'INCREASED', needTrain: 'HIGH_LOAD', needHist: 'NO_CHANGE', needHrv: 'INCREASING', bedRecStart: 1350, bedRecEnd: 1410 });
  });
  it('takes last night\'s HRV with its balanced range and status', () => {
    expect(fromHrv({ hrvSummaries: [HRV('2026-10-24'), HRV('2026-10-23', { lastNightAvg: null })] })).toEqual({
      '2026-10-24': { hrv: 58, hrvWeek: 61, hrvLow: 55, hrvHigh: 70, hrvStatus: 'BALANCED' },
    });
  });
  it('merges field by field, and a null never wipes a number', () => {
    const a = { '2026-10-24': { steps: 100, sleepScore: 70 } };
    expect(mergeDays(a, { '2026-10-24': { steps: 9000, sleepScore: null } }))
      .toEqual({ '2026-10-24': { steps: 9000, sleepScore: 70 } });
  });
  it('reads numbers sent as strings, and a wrapper under another name', () => {
    expect(fromSummaries({ data: [SUMMARY('2026-10-24', { heartRate: { restingValue: '47' } })] })['2026-10-24'].rhr).toBe(47);
    expect(fromHrv({ items: [HRV('2026-10-24')] })['2026-10-24'].hrv).toBe(58);
  });
  it('dates a sleep record by its own calendarDate, not the next night\'s need', () => {
    expect(Object.keys(fromSleep([SLEEP('2026-10-24', { nextSleepNeed: { calendarDate: '2026-10-25' } })]))).toEqual(['2026-10-24']);
  });
  it('reads an activity\'s measured zones, Training Effect and Body Battery cost', () => {
    const a = fromActivities([ACT('2026-10-24')])['20261024'];
    expect(a).toMatchObject({ start: '2026-10-24T07:30:00', gmt: '2026-10-24T06:30:00', type: 'virtual_ride', dur: 3600,
      zones: [300, 1500, 1200, 500, 100], aerobic: 3.4, anaerobic: 1.1, label: 'TEMPO', load: 112, bb: -18 });
    expect(a.power).toHaveLength(7);
    expect(fromActivities([ACT('2026-10-24', { hrTimeInZone_1: null, hrTimeInZone_2: null, hrTimeInZone_3: null, hrTimeInZone_4: null, hrTimeInZone_5: null })])['20261024'].zones).toBeNull();
  });
  it('reads the power curve, fitness markers and breathing, only where present', () => {
    const a = fromActivities([ACT('2026-10-24', { maxAvgPower_1: 820, maxAvgPower_5: 700, maxAvgPower_60: 410, maxAvgPower_300: 300, maxAvgPower_1200: 262,
      normPower: 251, avgPower: 230, trainingStressScore: 88.5, intensityFactor: 0.84, vO2MaxValue: 54, maxFtp: 285, lactateThresholdBpm: 166, avgRespirationRate: 31.2 })])['20261024'];
    expect(a.pc).toHaveLength(PC_SECS.length);
    expect(a.pc[PC_SECS.indexOf(1)]).toBe(820);
    expect(a.pc[PC_SECS.indexOf(1200)]).toBe(262);
    expect(a.pc[PC_SECS.indexOf(3600)]).toBeNull();
    expect(a).toMatchObject({ np: 251, ap: 230, tss: 88.5, if: 0.84, vo2: 54, ftp: 285, lt: 166, resp: 31.2 });
    const bare = fromActivities([ACT('2026-10-24')])['20261024'];
    expect(bare.pc).toBeUndefined();
    expect(bare.run).toBeUndefined();
    expect(fromActivities([ACT('2026-10-24', { maxAvgPower_60: 400, excludeFromPowerCurveReports: true })])['20261024'].pc).toBeUndefined();
  });
  it('reads a run\'s form and fastest splits, and nothing of the sort for a ride', () => {
    const r = fromActivities([ACT('2026-10-24', { activityType: { typeKey: 'trail_running' }, averageRunningCadenceInStepsPerMinute: 172, avgStrideLength: 112.4,
      avgGroundContactTime: 241, avgGroundContactBalance: 50.6, avgVerticalOscillation: 8.9, avgVerticalRatio: 7.8, avgGradeAdjustedSpeed: 3.2,
      fastestSplit_1000: 271, fastestSplit_5000: 1420 })])['20261024'];
    expect(r.run).toMatchObject({ cad: 172, stride: 112.4, gct: 241, gcb: 50.6, vo: 8.9, vr: 7.8, gap: 3.2 });
    expect(r.run.splits).toEqual([271, null, 1420, null, null, null]);
    expect(fromActivities([ACT('2026-10-24', { averageRunningCadenceInStepsPerMinute: 90 })])['20261024'].run).toBeUndefined();
  });
  it('reads your RPE, feel and workout compliance, and recovery heart rate', () => {
    expect(inputOf({ directWorkoutRpe: 70, directWorkoutFeel: 75, directWorkoutComplianceScore: 88, recoveryHeartRate: 34 }))
      .toEqual({ rpe: 7, feel: 75, comp: 88, recHr: 34 });
    expect(inputOf({ directWorkoutRpe: 6 })).toEqual({ rpe: 6 });                 // already on the 1 to 10 scale
    expect(inputOf({ perceivedWorkoutEffort: 40 })).toEqual({ rpe: 4 });
    expect(inputOf({ directWorkoutFeel: 0 })).toEqual({ feel: 0 });               // very weak is a feel, not a blank
    expect(inputOf({})).toEqual({});
    expect(fromDetail({ activityId: 1, summaryDTO: { directWorkoutRpe: 50, recoveryHeartRate: '28' } })).toEqual({ rpe: 5, recHr: 28 });
    expect(fromDetail(null)).toEqual({});
    expect(workoutName([{ workoutName: ' Threshold 3x10 ' }])).toBe('Threshold 3x10');
    expect(workoutName({ workouts: [] })).toBeNull();
  });
  it('rereading an activity from the list keeps what its own record added', () => {
    const m = mergeActs({ a: { start: 'x', hr: 140, rpe: 7, det: 1 } }, { a: { start: 'x', hr: 141 }, b: { start: 'y' } });
    expect(m).toEqual({ a: { start: 'x', hr: 141, rpe: 7, det: 1 }, b: { start: 'y' } });
  });
  it('reads dates and times in every form Garmin sends them', () => {
    expect(dayOf({ date: '2026-10-24', localDate: '2026-10-24' })).toBe('2026-10-24');
    expect(dayOf(Date.UTC(2026, 9, 24, 12))).toBe('2026-10-24');
    expect(wallOf(Date.UTC(2026, 9, 23, 23, 5))).toBe('2026-10-23T23:05');
    expect(wallOf('2026-10-23 23:05:12')).toBe('2026-10-23T23:05');
  });
  it('cuts a range into the windows each endpoint allows', () => {
    expect(windows('2026-01-01', '2026-02-10', 31)).toEqual([['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-10']]);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('refreshing from Garmin', () => {
  function garmin({ tokenStatus = 200 } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ u, method: init.method || 'GET', auth: init.headers && init.headers.Authorization });
      if (u.includes('/personal-api-key/token')) return tokenStatus === 200 ? new Response('eyJ.token.sig') : new Response('no', { status: tokenStatus });
      if (u.includes('/dailysummaries')) return json({ data: [SUMMARY('2026-10-24')] });
      if (u.includes('/dailySleepSummariesByDate')) return json([SLEEP('2026-10-24')]);
      if (u.includes('/hrv-service/hrv/daily/')) return json({ hrvSummaries: [HRV('2026-10-24')] });
      if (u.includes('/activities/search/activities')) return json([ACT(u.match(/startDate=([\d-]+)/)[1])]);
      return json({}, 404);
    });
    return calls;
  }
  const env = (kv = fakeKV()) => ({ GARMIN_API: ' gk-123 ', CACHE: kv });

  it('swaps the key for a token, then reads with the token', async () => {
    const calls = garmin();
    await refreshGarmin(env(), { today: '2026-10-24' });
    expect(calls[0]).toMatchObject({ method: 'POST', auth: 'ApiKey gk-123' });
    expect(calls.slice(1).every((c) => c.auth === 'Bearer eyJ.token.sig')).toBe(true);
  });

  it('reads the last few days and a year of history on the first run, inside the budget', async () => {
    const calls = garmin();
    const kv = fakeKV();
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    const reads = calls.filter((c) => c.method === 'GET');
    // The last four days (3 reads), last week's activities (1), then one year: summaries
    // a year a call, sleep 31 days, HRV 28 (its limit is undocumented).
    expect(reads.filter((c) => c.u.includes('dailysummaries'))).toHaveLength(2);
    expect(reads.filter((c) => c.u.includes('dailySleep'))).toHaveLength(13);
    expect(reads.filter((c) => c.u.includes('/hrv/daily/'))).toHaveLength(15);
    expect(calls.length).toBeLessThanOrEqual(GARMIN_BUDGET);   // under a free Worker's 50
    const stored = JSON.parse(kv.m.get(GARMIN_KV));
    expect(stored.days['2026-10-24']).toMatchObject({ steps: 9120, sleepScore: 82, hrv: 58, rhr: 47, deepSec: 5400, sleepStart: '2026-10-23T23:05', resp: 14.2 });
    expect(stored.backfill.daily).toBe('2025-10-20');
  });

  it('walks back to 2013 over successive runs, the days first and then the activities', async () => {
    const kv = fakeKV();
    let runs = 0, last;
    while (runs < 60) {
      const calls = garmin();
      last = await refreshGarmin(env(kv), { today: '2026-10-24' });
      runs++;
      expect(calls.length).toBeLessThanOrEqual(GARMIN_BUDGET);
      if (last.complete) break;
    }
    expect(last.complete).toBe(true);
    const stored = JSON.parse(kv.m.get(GARMIN_KV));
    expect(stored.backfill.daily).toBe(GARMIN_FLOOR);
    expect(stored.backfill.acts).toBe(GARMIN_FLOOR);
    // About fourteen runs for the days, then the months of activities.
    expect(runs).toBeLessThan(25);
    const acts = JSON.parse(kv.m.get(GARMIN_ACTS_KV)).acts;
    expect(Object.keys(acts).length).toBeGreaterThan(150);   // one a month back to 2013
  });

  it('once the history is in, rereads only the last few days, and writes nothing if nothing changed', async () => {
    const kv = fakeKV({ [GARMIN_KV]: JSON.stringify({ days: {}, backfill: { daily: GARMIN_FLOOR, acts: GARMIN_FLOOR, actsPage: 0 } }) });
    garmin();
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    const calls = garmin();
    const before = kv.puts.length;
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(4);
    expect(calls.find((c) => c.u.includes('dailysummaries')).u).toContain('startDate=2026-10-21');
    expect(kv.puts.length).toBe(before);
  });

  it('reads what you said about the last week\'s activities each run, and the backlog back to 2021', async () => {
    const kv = fakeKV({ [GARMIN_KV]: JSON.stringify({ days: {}, backfill: { daily: GARMIN_FLOOR, acts: GARMIN_FLOOR, actsPage: 0 } }),
      [GARMIN_ACTS_KV]: JSON.stringify({ acts: {
        old: { start: '2019-05-01T08:00:00' },
        mid: { start: '2024-03-01T08:00:00' },
        done: { start: '2025-01-01T08:00:00', det: 1, rpe: 3 },
      } }) });
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url); calls.push(u);
      if (u.includes('/personal-api-key/token')) return new Response('eyJ.token.sig');
      if (u.includes('/activities/search/activities')) return json([ACT('2026-10-24')]);
      if (u.endsWith('/activity-service/activity/20261024')) return json({ summaryDTO: { directWorkoutRpe: 80, directWorkoutFeel: 25, directWorkoutComplianceScore: 91, recoveryHeartRate: 31 } });
      if (u.endsWith('/activity-service/activity/20261024/workouts')) return json([{ workoutName: 'Sweet spot 2x20' }]);
      if (u.endsWith('/activity-service/activity/mid')) return json({ summaryDTO: { directWorkoutRpe: 40 } });
      return json({}, 404);
    });
    await refreshGarmin({ GARMIN_API: 'k', CACHE: kv }, { today: '2026-10-24' });
    const acts = JSON.parse(kv.m.get(GARMIN_ACTS_KV)).acts;
    expect(acts['20261024']).toMatchObject({ rpe: 8, feel: 25, comp: 91, recHr: 31, workout: 'Sweet spot 2x20', det: 1, hr: 142 });
    expect(acts.mid).toMatchObject({ rpe: 4, det: 1 });
    expect(acts.done).toMatchObject({ rpe: 3 });
    expect(calls.some((u) => u.endsWith('/activity/done'))).toBe(false);          // read once is enough
    expect(calls.some((u) => u.endsWith('/activity/old'))).toBe(false);           // before DETAIL_FLOOR
    expect(acts.old.det).toBeUndefined();
    expect(DETAIL_FLOOR).toBe('2021-01-01');
    // The next run rereads the week's list and keeps the detail it already has.
    calls.length = 0;
    await refreshGarmin({ GARMIN_API: 'k', CACHE: kv }, { today: '2026-10-24' });
    expect(calls.some((u) => u.includes('/activity-service/'))).toBe(false);
    expect(JSON.parse(kv.m.get(GARMIN_ACTS_KV)).acts['20261024']).toMatchObject({ rpe: 8, workout: 'Sweet spot 2x20' });
  });

  it('keeps the days it has and records the reason when the key has expired', async () => {
    garmin();
    const kv = fakeKV();
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    garmin({ tokenStatus: 401 });
    await expect(refreshGarmin(env(kv), { today: '2026-10-25' })).rejects.toThrow(/expired/);
    const stored = JSON.parse(kv.m.get(GARMIN_KV));
    expect(stored.days['2026-10-24'].hrv).toBe(58);
    expect(stored.error).toMatch(/expired/);
  });

  it('treats 204 and 404 as no data, and renews a lapsed token once on a 401', async () => {
    let tokens = 0, hrv401 = true;
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/personal-api-key/token')) { tokens++; return new Response('tok' + tokens); }
      if (u.includes('/dailysummaries')) return new Response(null, { status: 204 });
      if (u.includes('/dailySleepSummariesByDate')) return new Response('', { status: 404 });
      if (u.includes('/hrv-service/hrv/daily/')) {
        if (hrv401 && init.headers.Authorization === 'Bearer tok1') { hrv401 = false; return new Response('', { status: 401 }); }
        return json({ hrvSummaries: [HRV('2026-10-24')] });
      }
      if (u.includes('/activities/search/activities')) return new Response(null, { status: 204 });
      return json({}, 500);
    });
    const kv = fakeKV();
    await refreshGarmin({ GARMIN_API: 'gk', CACHE: kv }, { today: '2026-10-24', recentDays: 4 });
    expect(tokens).toBe(2);
    expect(JSON.parse(kv.m.get(GARMIN_KV)).days['2026-10-24'].hrv).toBe(58);
  });

  it('does nothing at all without the GARMIN_API secret', async () => {
    const calls = garmin();
    expect(await refreshGarmin({ CACHE: fakeKV() }, { today: '2026-10-24' })).toEqual({ skipped: 'GARMIN_API is not set.' });
    expect(calls).toEqual([]);
  });
});

describe('who sees it', () => {
  const KEY = 'correct-horse-battery-staple';
  const stored = JSON.stringify({ days: { '2026-10-24': { hrv: 58, sleepScore: 82 } }, updatedAt: '2026-10-24T08:00:00Z' });
  const env = () => ({ ADMIN_KEY: KEY, GARMIN_API: 'gk', CACHE: fakeKV({ [GARMIN_KV]: stored }) });
  const get = (e, path, key) => worker.fetch(new Request('https://api.example' + path, { headers: key ? { 'X-Admin-Key': key } : {} }), e);

  it('refuses /health without the admin key, and with a wrong one', async () => {
    globalThis.fetch = vi.fn();
    expect((await get(env(), '/health')).status).toBe(401);
    expect((await get(env(), '/health', 'nope')).status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('answers the admin key with the stored days, marked private and not to be cached', async () => {
    globalThis.fetch = vi.fn();
    const res = await get(env(), '/health', KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.json();
    expect(body.days['2026-10-24']).toEqual({ hrv: 58, sleepScore: 82 });
    // A plain read does not go to Garmin.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never puts health data in the public activity feed', async () => {
    const env2 = env();
    env2.CACHE.m.set('activities_v3', JSON.stringify({ data: [{ id: '1', date: '2026-10-24', type: 'Ride' }], updatedAt: '2026-10-24T00:00:00Z', hrZones: {}, gearMeta: {} }));
    globalThis.fetch = vi.fn(async () => json({}, 404));
    const text = await (await get(env2, '/activities')).text();
    expect(text).not.toMatch(/sleepScore|"hrv"|hrvStatus/);
  });
});
