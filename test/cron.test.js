// The cron runs every three hours, and only three of those runs may pay for a
// whole-history pull. The rest must ask Strava for the last week and merge it
// in. Eight full pulls a day would spend Strava's daily allowance for no gain;
// eight week-only pulls would never backfill segment PBs or catch an edit to an
// old activity. Tested through the real scheduled() handler, against a stubbed
// Strava and a fake KV, by which Strava URLs it calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';

const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
  };
}
const stored = (id, date) => ({ id: String(id), date, name: 'A' + id, type: 'Run', hr: 150, max_hr: 175, mt: 1500 });
const seeded = () => {
  const env = JSON.stringify({
    data: [stored(1, iso(-40)), stored(2, iso(-2))],
    aiSummary: 'x', updatedAt: '2026-01-01T00:00:00Z',
    hrZones: { athleteMaxHr: 190, source: 'strava' }, gearMeta: {},
  });
  return fakeKV({ activities_v3: env, activities_last_good_v3: env });
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

let asked;
function stubStrava() {
  asked = [];
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/oauth/token')) return json({ access_token: 'tok', refresh_token: 'r' });
    if (u.includes('/athlete/activities')) return json([]);
    return json({}, 404);
  });
}
const env = () => ({ CACHE: seeded(), STRAVA_CLIENT_ID: 'id', STRAVA_CLIENT_SECRET: 's', STRAVA_REFRESH_TOKEN: 'r' });
async function runAt(hourUtc) {
  const t = new Date(); t.setUTCHours(hourUtc, 0, 0, 0);
  const pending = [];
  await worker.scheduled({ cron: '0 */3 * * *', scheduledTime: t.getTime() }, env(), { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}
// The full pull pages the history with no `after`; the week-only pull and the
// Notion sync both pass one, at different page sizes.
const fullPulls = () => asked.filter((u) => u.includes('/athlete/activities?per_page=200'));
const weekPulls = () => asked.filter((u) => u.includes('/athlete/activities?after=') && u.includes('per_page=200'));

afterEach(() => { vi.restoreAllMocks(); });

describe('the three-hourly cron', () => {
  it.each([0, 3, 6, 12, 18])('at %i:00 UTC merges the last week rather than pulling everything', async (h) => {
    stubStrava();
    await runAt(h);
    expect(weekPulls().length).toBeGreaterThan(0);
    expect(fullPulls()).toEqual([]);
  });

  it.each([9, 15, 21])('at %i:00 UTC pulls the whole history', async (h) => {
    stubStrava();
    await runAt(h);
    expect(fullPulls().length).toBeGreaterThan(0);
    expect(weekPulls()).toEqual([]);
  });

  it('falls back to a full pull when there is nothing cached to merge into', async () => {
    stubStrava();
    const t = new Date(); t.setUTCHours(12, 0, 0, 0);
    const pending = [];
    await worker.scheduled({ scheduledTime: t.getTime() },
      { CACHE: fakeKV(), STRAVA_CLIENT_ID: 'id', STRAVA_CLIENT_SECRET: 's', STRAVA_REFRESH_TOKEN: 'r' },
      { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    expect(fullPulls().length).toBeGreaterThan(0);
  });
});
