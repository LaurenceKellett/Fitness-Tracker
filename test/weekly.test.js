// The Tuesday email: what it says (buildWeekly, pure) and when it goes (maybeSendWeekly,
// on the quarter-hour cron), sent through a stubbed Fastmail.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWeekly, lastWeek, mondayOf, WEEKLY_HEADER } from '../weekly.js';
import { maybeSendWeekly } from '../weekly.js';
import worker from '../worker.js';

afterEach(() => vi.restoreAllMocks());
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const WEEK = { from: '2026-10-19', to: '2026-10-25' };
const ride = (date, o = {}) => ({ id: date.replace(/-/g, ''), date, time: '07:30', name: 'Morning ride', type: 'VirtualRide', mt: 3600, dist_mi: 20, elv: 600, hr: 140, ...o });
const DATA = {
  acts: [
    ride('2026-10-19'), ride('2026-10-21', { type: 'Ride', name: 'Lanes', mt: 7200, dist_mi: 38 }), ride('2026-10-25', { type: 'Run', name: 'Parkrun', mt: 1500, dist_mi: 3.1, time: '09:00' }),
    ride('2026-10-12'), ride('2026-10-05'), ride('2025-10-21', { mt: 5400, dist_mi: 30 }), ride('2026-03-01', { dist_mi: 25 }),
  ],
  days: Object.fromEntries(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map((d, i) => [d, {
    sleepSec: 25000 + i * 600, sleepScore: 70 + i, sleepNeed: 460, needBase: 450, needTrain: 'HIGH', sleepStart: '2026-10-18T23:00', sleepEnd: d + 'T06:45',
    bedRecStart: 1350, bedRecEnd: 1410, hrv: 55 + i, hrvStatus: i === 3 ? 'UNBALANCED' : 'BALANCED', rhr: 47, steps: 9000 + i * 500, stepGoal: 8000,
    stressRest: 30000, stressLow: 15000, stressMed: 4000, stressHigh: 1000, bbCharged: 60, bbMax: 80,
  }])),
  gacts: {
    g1: { start: '2026-10-19T07:31:00', type: 'virtual_ride', dur: 3600, zones: [600, 1800, 900, 250, 50], label: 'TEMPO', aerobic: 3.2, anaerobic: 0.8, bb: -22,
      rpe: 6, feel: 75, comp: 92, workout: 'Sweet spot 2x20', np: 240, pc: [900, 850, 760, 640, 520, 470, 380, 330, 300, 270, 262, 250, 230, null, null], load: 110 },
    g2: { start: '2026-10-21T07:30:00', type: 'road_biking', dur: 7200, zones: [1200, 4000, 1500, 400, 100], label: 'AEROBIC_BASE', aerobic: 3.0, bb: -30, load: 140 },
    g3: { start: '2026-10-25T09:00:00', type: 'running', dur: 1500, label: 'LACTATE_THRESHOLD', run: { cad: 172, stride: 112, gct: 238, vr: 7.6, splits: [255, 420, 1310, null, null, null] } },
  },
  routes: [
    { route: 'Tempus Fugit', status: 'Complete', date_completed: '2026-10-21', distance_mi: 10.8, time: '28:41' },
    { route: 'Road to Sky', status: 'Not started', planned_ride: '2026-10-29', est_duration: '1h 05m' },
    { route: 'Mountain 8', status: 'Not started', planned_ride: '2026-10-10' },
  ],
};

describe('which week', () => {
  it('is the Monday to Sunday before the one today is in', () => {
    expect(lastWeek('2026-10-27')).toEqual(WEEK);   // a Tuesday
    expect(lastWeek('2026-10-26')).toEqual(WEEK);   // a Monday
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
  });
});

describe('what it says', () => {
  const mail = buildWeekly(DATA, WEEK);
  it('leads with the week in its subject and first line', () => {
    expect(mail.subject).toBe('Your week, 19–25 October: 3h 25m, 61.1 mi');
    expect(mail.text).toMatch(/^Your week, 19–25 October/);
  });
  it('holds every section there is data for', () => {
    for (const s of ['Training', 'Day by day', 'Every activity', 'Heart-rate zones', 'What kind of training it was', 'Power', 'Sleep', 'Recovery', 'Running', 'Zwift routes', '2026 so far']) {
      expect(mail.html).toContain(`>${s}</div>`);
    }
  });
  it('carries what you told Garmin, matched to the Strava activity', () => {
    expect(mail.html).toContain('RPE 6 (moderate)');
    expect(mail.html).toContain('felt strong');
    expect(mail.html).toContain('92% of Sweet spot 2x20');
    expect(mail.text).toContain('Morning ride: 1h 00m, 20 mi, Tempo, RPE 6, felt strong, 92% of Sweet spot 2x20');
  });
  it('compares with the weeks before, last year, and plans ahead', () => {
    expect(mail.html).toContain('Same week last year: 1h 30m, 30 mi, 1 activity.');
    expect(mail.html).toContain('Road to Sky');
    expect(mail.html).toContain('1 planned route still to ride');
    expect(mail.html).toContain('Tempus Fugit');
  });
  it('never prints a broken figure, and never shouts', () => {
    expect(mail.html).not.toMatch(/undefined|NaN|null|\[object/);
    expect(mail.text).not.toMatch(/undefined|NaN|\[object/);
    expect(mail.html).not.toMatch(/text-transform/i);
    expect(mail.html).toContain('color-scheme:light');
  });
  it('says so plainly for an empty week', () => {
    const empty = buildWeekly({ acts: [], days: {}, gacts: {}, routes: [] }, WEEK);
    expect(empty.subject).toBe('Your week, 19–25 October: a rest week');
    expect(empty.html).not.toMatch(/undefined|NaN/);
  });
});

describe('when it goes', () => {
  // Tuesday 27 October 2026, 07:00 in London is 07:00 UTC (GMT from the 25th).
  const TUE_0700 = new Date('2026-10-27T07:00:00Z');
  function fastmail() {
    const sent = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://api.fastmail.com/jmap/session') return json({ apiUrl: 'https://api.fastmail.com/jmap/api/', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' } });
      if (u === 'https://api.fastmail.com/jmap/api/') {
        const body = JSON.parse(init.body);
        const calls = body.methodCalls;
        if (calls[0][0] === 'Identity/get') return json({ methodResponses: [['Identity/get', { list: [{ id: 'id1', email: 'hello@laurencekellett.co.uk', name: 'L' }] }, 'i'], ['Mailbox/query', { ids: ['drafts'] }, 'd'], ['Mailbox/query', { ids: ['sent'] }, 's']] });
        sent.push(calls[0][1].create.draft);
        return json({ methodResponses: [['Email/set', { created: { draft: { id: 'e1' } } }, 'e'], ['EmailSubmission/set', { created: { send: { id: 'sub1' } } }, 's']] });
      }
      return json({}, 404);   // Notion: the routes fall back to the cache
    });
    return sent;
  }
  const load = async () => DATA;
  const env = (kv = fakeKV({ activities_last_good_v3: JSON.stringify({ data: DATA.acts }) })) =>
    ({ FASTMAIL_TOKEN: 'fm', WEEKLY_FROM: 'hello@laurencekellett.co.uk', WEEKLY_TO: 'hello@laurencekellett.co.uk', ZWIFT_TZ: 'Europe/London', CACHE: kv });

  it('sends once on Tuesday morning, for last week, marked for filtering', async () => {
    const sent = fastmail();
    const e = env();
    expect(await maybeSendWeekly(e, new Date('2026-10-27T06:45:00Z'), load)).toEqual({ skipped: 'not Tuesday morning' });
    expect(await maybeSendWeekly(e, new Date('2026-10-26T09:00:00Z'), load)).toEqual({ skipped: 'not Tuesday morning' });
    const r = await maybeSendWeekly(e, TUE_0700, load);
    expect(r).toMatchObject({ sent: true, week: '2026-10-19' });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Your week, 19–25 October/);
    expect(sent[0]['header:' + WEEKLY_HEADER + ':asText']).toBe('fitness-weekly-email');
    expect(await maybeSendWeekly(e, new Date('2026-10-27T07:15:00Z'), load)).toEqual({ skipped: 'done this week' });
    expect(sent).toHaveLength(1);
  });
  it('tries at most three times in a week when Fastmail fails', async () => {
    globalThis.fetch = vi.fn(async () => json({}, 500));
    const e = env();
    for (let i = 0; i < 3; i++) await expect(maybeSendWeekly(e, TUE_0700, load)).rejects.toThrow();
    expect(await maybeSendWeekly(e, TUE_0700, load)).toEqual({ skipped: 'done this week' });
    expect(JSON.parse(e.CACHE.m.get('weekly_email_v1'))).toMatchObject({ tries: 3, error: expect.any(String) });
  });
  it('does nothing without the Fastmail token', async () => {
    globalThis.fetch = vi.fn();
    expect(await maybeSendWeekly({ ...env(), FASTMAIL_TOKEN: '' }, TUE_0700, load)).toEqual({ skipped: 'no token' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('who can see it', () => {
  const KEY = 'correct-horse-battery-staple';
  const env = () => ({ ADMIN_KEY: KEY, CACHE: fakeKV({ activities_last_good_v3: JSON.stringify({ data: DATA.acts }) }) });
  const call = (path, key, method = 'GET') => worker.fetch(new Request('https://api.example' + path, { method, headers: key ? { 'X-Admin-Key': key } : {} }), env());
  it('refuses the preview, the status and a send without the admin key', async () => {
    globalThis.fetch = vi.fn(async () => json({}, 404));
    expect((await call('/weekly/preview')).status).toBe(401);
    expect((await call('/weekly/status', 'wrong')).status).toBe(401);
    expect((await call('/weekly/send', null, 'POST')).status).toBe(401);
    expect((await call('/weekly/send', KEY, 'GET')).status).toBe(405);
  });
  it('previews any week with the key, private and uncached, sending nothing', async () => {
    globalThis.fetch = vi.fn(async () => json({}, 404));
    const res = await call('/weekly/preview?week=2026-10-21', KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await res.text()).toContain('19–25 October');
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('fastmail'))).toBe(false);
  });
});
