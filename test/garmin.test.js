// Garmin's daily health numbers: read from the Personal API, kept per day in KV, and
// shown to nobody without the admin key. Tested against a stubbed Garmin whose answers
// are shaped as its OpenAPI document describes them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  windows, addDays, fromSummaries, fromSleep, fromHrv, mergeDays, refreshGarmin, GARMIN_KV,
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
const SLEEP = (day, o = {}) => ({ calendarDate: day, sleepTimeSeconds: 26100, sleepScores: { overall: { value: 82, qualifierKey: 'GOOD' } }, ...o });
const HRV = (day, o = {}) => ({ calendarDate: day, lastNightAvg: 58, weeklyAvg: 61, baseline: { balancedLow: 55, balancedUpper: 70 }, status: 'BALANCED', ...o });

describe('reading Garmin\'s answers', () => {
  it('takes steps, resting HR, stress and Body Battery from the daily summaries', () => {
    expect(fromSummaries({ data: [SUMMARY('2026-10-24')] })).toEqual({
      '2026-10-24': { steps: 9120, rhr: 47, stress: 28, bbMax: 88, bbMin: 21 },
    });
  });
  it('takes duration and score from sleep, and skips a night with nothing recorded', () => {
    expect(fromSleep([SLEEP('2026-10-24'), SLEEP('2026-10-23', { sleepTimeSeconds: 0, sleepScores: null })]))
      .toEqual({ '2026-10-24': { sleepSec: 26100, sleepScore: 82 } });
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

  it('reads a year on the first run, in windows that fit the request limit', async () => {
    const calls = garmin();
    const kv = fakeKV();
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    const reads = calls.filter((c) => c.method === 'GET');
    // Summaries take a year a call, sleep 31 days, HRV 28 (its limit is undocumented).
    expect(reads.filter((c) => c.u.includes('dailysummaries'))).toHaveLength(1);
    expect(reads.filter((c) => c.u.includes('dailySleep'))).toHaveLength(12);
    expect(reads.filter((c) => c.u.includes('/hrv/daily/'))).toHaveLength(14);
    expect(calls.length).toBeLessThan(50);   // a free Worker's subrequest limit
    const stored = JSON.parse(kv.m.get(GARMIN_KV));
    expect(stored.days['2026-10-24']).toMatchObject({ steps: 9120, sleepScore: 82, hrv: 58, rhr: 47 });
  });

  it('rereads only the last few days once it has a year, and writes nothing if nothing changed', async () => {
    garmin();
    const kv = fakeKV();
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    const calls = garmin();
    const before = kv.puts.length;
    await refreshGarmin(env(kv), { today: '2026-10-24' });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    expect(calls.find((c) => c.u.includes('dailysummaries')).u).toContain('startDate=2026-10-21');
    expect(kv.puts.length).toBe(before);
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
