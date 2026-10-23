// The Google Calendar sync decides, for every route still to ride, whether the
// calendar or Notion is right, and does the one thing that makes them agree. A wrong
// decision either drops a plan or keeps moving an event back under the owner's
// finger, so the deciding is tested on its own, then once end to end through the
// worker against a stubbed Google and Notion.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calWall, calKey, calDurationMin, calEventBody, calNotionDate, calPlan, CAL_ROUTE, CAL_TAG,
} from '../calendar.js';
import worker from '../worker.js';

const TZ = 'Europe/London';
const route = (o = {}) => ({
  id: 'r1', route: 'Mech Isle Mayhem', maps: ['Makuri Island'], distance_mi: 11.4, elevation_ft: 381,
  est_duration: null, status: 'Planned', planned_ride: '2026-10-28T18:30', last_edited: '2026-10-23T10:00:00.000Z', ...o,
});
const event = (o = {}) => ({
  id: 'e1', status: 'confirmed', summary: '🚴 Mech Isle Mayhem', updated: '2026-10-23T10:00:30.000Z',
  start: { dateTime: '2026-10-28T18:30:00Z', timeZone: TZ },
  extendedProperties: { private: { [CAL_TAG]: '1', [CAL_ROUTE]: 'r1' } }, ...o,
});

describe('calWall', () => {
  it('reads a bare day, a local time, and a UTC instant as the London clock', () => {
    expect(calWall('2026-10-28', TZ)).toEqual({ date: '2026-10-28', time: null });
    expect(calWall('2026-10-28T18:30', TZ)).toEqual({ date: '2026-10-28', time: '18:30' });
    // British Summer Time: 17:05 UTC is 18:05 on the wall.
    expect(calWall('2026-07-01T17:05:00.000+00:00', TZ)).toEqual({ date: '2026-07-01', time: '18:05' });
    // Winter: UTC and London agree.
    expect(calWall('2026-01-31T17:05:00.000Z', TZ)).toEqual({ date: '2026-01-31', time: '17:05' });
  });
  it('keys a plan for comparing either side', () => {
    expect(calKey('2026-10-28T18:30:00.000+00:00', TZ)).toBe('2026-10-28T18:30');
    expect(calKey(null, TZ)).toBe('');
  });
});

describe('calDurationMin', () => {
  it('adds a fifth to the estimate, at least ten minutes, rounded up to five', () => {
    expect(calDurationMin(route({ est_duration: '02:17' }))).toBe(165);   // 137 + 27.4 -> 165
    expect(calDurationMin(route({ est_duration: '00:20' }))).toBe(30);    // 20 + 10 -> 30
  });
  it('falls back to the fit, then to an hour', () => {
    expect(calDurationMin(route(), { a: 180, b: 0 })).toBe(45);           // 11.4 mi at 20 mph = 34.2 min
    expect(calDurationMin(route(), null)).toBe(60);
  });
});

describe('calEventBody', () => {
  it('is private, tagged with its route, and named with a bike', () => {
    const b = calEventBody(route({ est_duration: '00:30' }), { tz: TZ });
    expect(b.summary).toBe('🚴 Mech Isle Mayhem');
    expect(b.visibility).toBe('private');
    expect(b.extendedProperties.private).toEqual({ [CAL_TAG]: '1', [CAL_ROUTE]: 'r1' });
    expect(b.start).toEqual({ dateTime: '2026-10-28T18:30:00', timeZone: TZ });
    expect(b.end).toEqual({ dateTime: '2026-10-28T19:10:00', timeZone: TZ });   // 30 + 10
  });
  it('is an all-day event for a plan with no time', () => {
    const b = calEventBody(route({ planned_ride: '2026-10-31' }), { tz: TZ });
    expect(b.start).toEqual({ date: '2026-10-31' });
    expect(b.end).toEqual({ date: '2026-11-01' });
  });
});

describe('calNotionDate', () => {
  it('stores a time with its zone, a day as a day, and nothing as nothing', () => {
    expect(calNotionDate('2026-10-28T18:30', TZ)).toEqual({ start: '2026-10-28T18:30:00', time_zone: TZ });
    expect(calNotionDate('2026-10-28', TZ)).toEqual({ start: '2026-10-28' });
    expect(calNotionDate(null, TZ)).toBeNull();
  });
});

describe('calPlan', () => {
  const ops = (a) => a.map((x) => x.op + (x.key !== undefined ? ':' + x.key : ''));

  it('creates an event for a plan that has none', () => {
    expect(ops(calPlan([route()], [], TZ))).toEqual(['create']);
  });
  it('does nothing when the two agree', () => {
    expect(calPlan([route()], [event()], TZ)).toEqual([]);
  });
  it('moves the plan when the event was dragged after the page was edited', () => {
    const dragged = event({ start: { dateTime: '2026-10-30T08:00:00Z' }, updated: '2026-10-23T11:00:00.000Z' });
    expect(ops(calPlan([route()], [dragged], TZ))).toEqual(['notion:2026-10-30T08:00']);
  });
  it('moves the event when the page was edited after it', () => {
    const old = event({ start: { dateTime: '2026-10-30T08:00:00Z' }, updated: '2026-10-22T09:00:00.000Z' });
    expect(ops(calPlan([route()], [old], TZ))).toEqual(['update']);
  });
  it('treats an event changed within Notion\'s rounding minute as older', () => {
    const near = event({ start: { dateTime: '2026-10-30T08:00:00Z' }, updated: '2026-10-23T10:00:50.000Z' });
    expect(ops(calPlan([route()], [near], TZ))).toEqual(['update']);
  });
  it('reads an all-day event moved to another day', () => {
    const allDay = event({ start: { date: '2026-11-02' }, updated: '2026-10-23T12:00:00.000Z' });
    expect(ops(calPlan([route()], [allDay], TZ))).toEqual(['notion:2026-11-02']);
  });
  it('deletes the event when the plan was cleared in the app', () => {
    const r = route({ planned_ride: null, last_edited: '2026-10-23T12:00:00.000Z' });
    expect(ops(calPlan([r], [event()], TZ))).toEqual(['delete']);
  });
  it('clears the plan when the event was deleted after the last edit, and recreates it otherwise', () => {
    const gone = event({ status: 'cancelled', updated: '2026-10-23T11:00:00.000Z' });
    expect(ops(calPlan([route()], [gone], TZ))).toEqual(['notion:']);
    const goneBefore = event({ status: 'cancelled', updated: '2026-10-22T11:00:00.000Z' });
    expect(ops(calPlan([route()], [goneBefore], TZ))).toEqual(['create']);
  });
  it('leaves a completed route and its event alone', () => {
    const dragged = event({ start: { dateTime: '2026-10-30T08:00:00Z' }, updated: '2026-10-24T11:00:00.000Z' });
    expect(calPlan([route({ status: 'Complete' })], [dragged], TZ)).toEqual([]);
  });
  it('removes a duplicate event and renames one whose route was renamed', () => {
    const dup = event({ id: 'e2', updated: '2026-10-23T09:00:00.000Z' });
    expect(ops(calPlan([route()], [event(), dup], TZ))).toEqual(['delete']);
    expect(ops(calPlan([route({ route: 'Mech Isle Mayhem Reverse' })], [event()], TZ))).toEqual(['update']);
  });
});

// ── End to end, through the worker ───────────────────────────────────────────
describe('the 15-minute cron', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const page = (o = {}) => ({
    id: 'r1', last_edited_time: '2026-10-23T10:00:00.000Z',
    properties: {
      Route: { title: [{ plain_text: 'Mech Isle Mayhem' }] },
      Map: { multi_select: [{ name: 'Makuri Island' }] },
      Distance: { number: 11.4 }, Elevation: { number: 381 },
      'Est. Duration': { rich_text: [{ plain_text: '00:30' }] },
      Status: { status: { name: o.status || 'Planned' } },
      'Planned Ride': { date: o.planned === null ? null : { start: o.planned || '2026-10-28T18:30:00.000+00:00' } },
      'Date completed': { date: null }, Time: { rich_text: [] },
    },
  });

  function stub({ events = [], pages = [page()] } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url), method = opts.method || 'GET';
      calls.push({ u, method, body: opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : String(opts.body)) : null });
      const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'g' });
      if (u.includes('/calendar/v3/') && method === 'GET') return json({ items: events });
      if (u.includes('/calendar/v3/')) return json({ id: 'new' });
      if (u.includes('/data_sources/') && u.endsWith('/query')) return json({ results: pages, has_more: false });
      if (u.includes('/v1/pages/')) return json(page());
      return json({}, 404);
    });
    return calls;
  }
  const env = () => ({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', NOTION_API_KEY: 'n' });
  const run = async (e) => {
    const pending = [];
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, e, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  };

  it('creates the missing event, private and tagged, and touches nothing of Strava', async () => {
    const calls = stub();
    await run(env());
    const made = calls.find((c) => c.u.includes('/calendar/v3/') && c.method === 'POST');
    expect(made.body.summary).toBe('🚴 Mech Isle Mayhem');
    expect(made.body.visibility).toBe('private');
    expect(made.body.start).toEqual({ dateTime: '2026-10-28T18:30:00', timeZone: TZ });
    expect(calls.some((c) => c.u.includes('strava.com'))).toBe(false);
    // Only routes still to ride are read.
    const q = calls.find((c) => c.u.endsWith('/query'));
    expect(q.body.filter).toEqual({ property: 'Status', status: { does_not_equal: 'Complete' } });
  });

  it('writes a dragged event back to Notion with its time zone', async () => {
    const calls = stub({ events: [event({ start: { dateTime: '2026-10-30T08:00:00Z' }, updated: '2026-10-23T11:00:00.000Z' })] });
    await run(env());
    const w = calls.find((c) => c.u.includes('/v1/pages/r1') && c.method === 'PATCH');
    expect(w.body.properties['Planned Ride']).toEqual({ date: { start: '2026-10-30T08:00:00', time_zone: TZ } });
  });

  it('does nothing at all until Google is set up', async () => {
    const calls = stub();
    await run({ NOTION_API_KEY: 'n' });
    expect(calls).toEqual([]);
  });
});
