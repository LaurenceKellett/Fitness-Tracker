// The last week from Strava, merged into what is cached.
//
// "Force fetch" used to be a full pull: every page of the whole history, a
// gear lookup per active item, up to a minute, and a good way to meet
// Strava's rate limit — to learn about one run. This asks for the last few
// days and splices them in.
//
// The reason this is tested through the real handler and not by lifting
// helpers out of the source: the one thing that must never happen is the
// cached history being replaced by a week of it, and that is a property of
// the whole path — what is read from KV, what is asked of Strava, what is
// written back — not of any one function in it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async k => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async k => { m.delete(k); },
    _m: m,
  };
}

// What Strava hands back, in the shape transformActivity reads.
function raw(id, date, over = {}) {
  return {
    id, name: 'Activity ' + id, sport_type: 'Run', type: 'Run',
    start_date_local: date + 'T07:30:00Z', distance: 5000, moving_time: 1500, elapsed_time: 1600,
    total_elevation_gain: 40, average_speed: 3.3, average_heartrate: 150, max_heartrate: 175,
    start_latlng: [], map: { summary_polyline: '' }, gear_id: null, ...over,
  };
}
// What the cache holds: the same, already transformed.
const stored = (id, date, over = {}) => ({ id: String(id), date, name: 'Activity ' + id, type: 'Run', hr: 150, max_hr: 175, mt: 1500, ...over });

const history = () => [
  ...Array.from({ length: 300 }, (_, i) => stored(1000 + i, iso(-400 - i))),   // old
  stored(5001, iso(-20)), stored(5002, iso(-9)),                                // before the window
  stored(6001, iso(-5), { name: 'Stale name' }), stored(6002, iso(-2)),         // inside it
].sort((a, b) => a.date.localeCompare(b.date));

let asked;        // every URL the worker called
let strava;       // what Strava will answer; set per test
function install(handler) {
  asked = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    asked.push(u);
    return handler(u, init);
  });
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function stravaOk(activities, { gear = {} } = {}) {
  return (u) => {
    if (u.includes('/oauth/token')) return json({ access_token: 'tok', refresh_token: 'refresh' });
    if (u.includes('/athlete/zones')) return json({ heart_rate: { zones: [{ min: 0, max: 120 }, { min: 120, max: 140 }, { min: 140, max: 160 }, { min: 160, max: 180 }, { min: 180, max: -1 }] } });
    if (u.includes('/gear/')) { const id = u.split('/gear/')[1]; return gear[id] ? json(gear[id]) : json({ message: 'Not Found' }, 404); }
    if (u.includes('/athlete/activities')) {
      const page = +(new URL(u).searchParams.get('page') || 1);
      return json(activities.slice((page - 1) * 200, page * 200));
    }
    return json({}, 404);
  };
}

// A refresh is the key holder's to ask for (see requireAdmin in worker.js).
const call = (env, qs) => worker.fetch(new Request('https://api.example/activities' + qs, { headers: { 'X-Admin-Key': 'k' } }), env);
const envOf = (kv, extra = {}) => ({ CACHE: kv, STRAVA_CLIENT_ID: 'id', STRAVA_CLIENT_SECRET: 'secret', STRAVA_REFRESH_TOKEN: 'r', ADMIN_KEY: 'k', ...extra });
const seeded = (hist = history()) => {
  const env = JSON.stringify({ data: hist, aiSummary: 'KEEP THIS SUMMARY', updatedAt: '2026-01-01T00:00:00Z', hrZones: { athleteMaxHr: 190, source: 'strava' }, gearMeta: { 'Old Shoes': { brand: 'B', model: 'M', retired: false, kind: 'shoe' } } });
  return fakeKV({ activities_v3: env, activities_last_good_v3: env });
};
const activitiesCalls = () => asked.filter(u => u.includes('/athlete/activities'));

describe('asking for the last week', () => {
  it('asks Strava for a few days, in a request, not the whole history', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const res = await call(envOf(kv), '?refresh=recent');
    expect(res.status).toBe(200);
    const reqs = activitiesCalls();
    expect(reqs).toHaveLength(1);
    const q = new URL(reqs[0]).searchParams;
    expect(q.get('after')).toBeTruthy();
    expect(q.get('page')).toBe('1');
  });

  it('starts the window about a week back, with a day of margin and a clock-zone allowance', async () => {
    const kv = seeded();
    install(stravaOk([]));
    await call(envOf(kv), '?refresh=recent&days=7');
    const after = +new URL(activitiesCalls()[0]).searchParams.get('after');
    const daysBack = (Date.now() / 1000 - after) / 86400;
    // 7 days, a margin day, the time since that day's midnight (0 to 1 day)
    // and 14 hours of zone: between 8.6 and 9.6. Generous on purpose — it is
    // still one request — but not a fortnight.
    expect(daysBack).toBeGreaterThan(8.5);
    expect(daysBack).toBeLessThan(9.7);
  });

  it('is a handful of requests, not a couple of dozen', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    await call(envOf(kv), '?refresh=recent');
    expect(asked.length).toBeLessThanOrEqual(5);   // token, activities, zones, maybe gear
  });
});

describe('it merges, and never replaces', () => {
  it('keeps every activity older than the window exactly as it was', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    const ids = new Set(j.data.map(a => a.id));
    for (const a of history().filter(a => a.date < iso(-9))) expect(ids.has(a.id), a.id).toBe(true);
    expect(j.data.length).toBeGreaterThan(300);
  });

  it('adds what is new', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1), { name: 'Brand new' })]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.data.find(a => a.id === '7001')?.name).toBe('Brand new');
  });

  it('replaces an activity edited in Strava, rather than keeping both', async () => {
    const kv = seeded();
    install(stravaOk([raw(6001, iso(-5), { name: 'Renamed in Strava' }), raw(6002, iso(-2))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    const same = j.data.filter(a => a.id === '6001');
    expect(same).toHaveLength(1);
    expect(same[0].name).toBe('Renamed in Strava');
  });

  it('drops an activity deleted in Strava from inside the window', async () => {
    const kv = seeded();
    install(stravaOk([raw(6002, iso(-2))]));   // 6001 is gone
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.data.some(a => a.id === '6001')).toBe(false);
    expect(j.data.some(a => a.id === '6002')).toBe(true);
  });

  it('does not duplicate one that slipped in through the margin', async () => {
    // Fetched from just before the window by the clock-zone allowance, and
    // already cached: it must replace its cached copy, not sit beside it.
    const kv = seeded();
    install(stravaOk([raw(5002, iso(-9), { name: 'Updated at the edge' })]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.data.filter(a => a.id === '5002')).toHaveLength(1);
  });

  it('keeps the history in date order', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1)), raw(7002, iso(-3))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    const dates = j.data.map(a => a.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('carries the AI summary forward instead of regenerating it', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.aiSummary).toBe('KEEP THIS SUMMARY');
  });

  it('keeps the gear metadata for everything older', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.gearMeta['Old Shoes']).toBeTruthy();
  });

  it('writes both copies, so the fallback is never older than the serving one', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    await call(envOf(kv), '?refresh=recent');
    const a = JSON.parse(kv._m.get('activities_v3')), b = JSON.parse(kv._m.get('activities_last_good_v3'));
    expect(a.data.some(x => x.id === '7001')).toBe(true);
    expect(b.data.some(x => x.id === '7001')).toBe(true);
  });

  it('resolves gear for the new activity', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1), { gear_id: 'g999' })], { gear: { g999: { name: 'New Shoes', brand_name: 'Brand', model_name: 'Model', retired: false } } }));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.data.find(a => a.id === '7001').gear).toBe('New Shoes');
    expect(j.gearMeta['New Shoes']).toBeTruthy();
  });
});

describe('where the window starts', () => {
  // The window is cut in LOCAL dates with a day of margin, because an
  // activity's date is its local date and the cut is made from a UTC clock.
  // Pinned from both sides: too tight and an activity from the margin day is
  // never refreshed; too loose and the history older than that is rewritten.
  it('refreshes the margin day: one there that Strava no longer returns is dropped', async () => {
    const kv = seeded([...history(), stored(6500, iso(-8))]);
    install(stravaOk([raw(6002, iso(-2))]));
    const j = await (await call(envOf(kv), '?refresh=recent&days=7')).json();
    expect(j.data.some(a => a.id === '6500')).toBe(false);
  });

  it('and leaves the day before that alone, even though Strava did not return it', async () => {
    const kv = seeded([...history(), stored(6501, iso(-9))]);
    install(stravaOk([raw(6002, iso(-2))]));
    const j = await (await call(envOf(kv), '?refresh=recent&days=7')).json();
    expect(j.data.some(a => a.id === '6501')).toBe(true);
  });

  it('asks Strava from before the margin day starts, to cover a clock far ahead of UTC', async () => {
    const kv = seeded();
    install(stravaOk([]));
    await call(envOf(kv), '?refresh=recent&days=7');
    const after = +new URL(activitiesCalls()[0]).searchParams.get('after');
    const marginMidnight = Date.parse(iso(-8) + 'T00:00:00Z') / 1000;
    // UTC+14 is as far ahead as a clock gets: a local date of iso(-8) can
    // begin 14h before that midnight UTC.
    expect(after).toBeLessThanOrEqual(marginMidnight - 13 * 3600);
  });

  it('reports that it was the week-only pull', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const res = await call(envOf(kv), '?refresh=recent');
    expect(res.headers.get('X-Cache')).toBe('MISS');
    expect(res.headers.get('X-Refresh')).toBe('recent');
  });
});

describe('what it recomputes', () => {
  // The athlete's max heart rate is the 99th percentile of every activity's
  // peak, so it is a property of the WHOLE history. Six hard efforts this
  // week lift it to 200 — which can only happen if it is derived from the
  // merged history: the old activities alone say 175, and this week alone
  // has too few peaks to derive anything at all.
  it('derives the max heart rate from the whole merged history', async () => {
    const kv = seeded();
    install(stravaOk(Array.from({ length: 6 }, (_, i) => raw(7001 + i, iso(-1), { max_heartrate: 200 }))));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    expect(j.hrZones.athleteMaxHr).toBe(200);
  });

  it('and works out zones for the older activities too, not just the new ones', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const j = await (await call(envOf(kv), '?refresh=recent')).json();
    const old = j.data.find(a => a.id === '1000');
    // The seeded history has no zones at all; they exist because they were recomputed.
    expect(['z1', 'z2', 'z3', 'z4', 'z5'].every(k => typeof old[k] === 'number')).toBe(true);
  });
});

describe('when the serving copy has expired', () => {
  it('still merges, from the fallback copy that never expires', async () => {
    const full = seeded();
    const kv = fakeKV({ activities_last_good_v3: full._m.get('activities_last_good_v3') });   // no serving copy
    install(stravaOk([raw(7001, iso(-1))]));
    const res = await call(envOf(kv), '?refresh=recent');
    expect(res.headers.get('X-Refresh')).toBe('recent');
    const j = await res.json();
    expect(j.data.length).toBeGreaterThan(300);
  });
});

describe('with nothing cached to merge into', () => {
  it('runs the full pull instead — a week must never be written over the history', async () => {
    const kv = fakeKV();   // empty
    install(stravaOk([raw(7001, iso(-1)), raw(7002, iso(-30))]));
    const res = await call(envOf(kv), '?refresh=recent');
    expect(res.headers.get('X-Refresh')).toBe('full');
    // A full pull asks without `after`.
    expect(activitiesCalls().every(u => !new URL(u).searchParams.has('after'))).toBe(true);
  });

  it('and treats an empty or unreadable cache the same way', async () => {
    for (const bad of ['{not json', JSON.stringify({ data: [] }), JSON.stringify({ nope: 1 })]) {
      const kv = fakeKV({ activities_last_good_v3: bad, activities_v3: bad });
      install(stravaOk([raw(7001, iso(-1))]));
      const res = await call(envOf(kv), '?refresh=recent');
      expect(res.headers.get('X-Refresh'), bad).toBe('full');
    }
  });
});

describe('when Strava does not answer', () => {
  it('a rate limit is an error, not "nothing new"', async () => {
    const kv = seeded();
    install((u) => u.includes('/athlete/activities') ? json({ message: 'Rate Limit Exceeded' }, 429) : stravaOk([])(u));
    const res = await call(envOf(kv), '?refresh=recent');
    // Falls back to the last good copy and says so — never a success that found nothing.
    expect(res.headers.get('X-Cache')).toBe('STALE');
    expect(res.headers.get('X-Refresh')).toBe('none');
  });

  it('and the cached history is untouched afterwards', async () => {
    const kv = seeded();
    const before = kv._m.get('activities_last_good_v3');
    install((u) => u.includes('/athlete/activities') ? json({ message: 'Rate Limit Exceeded' }, 429) : stravaOk([])(u));
    await call(envOf(kv), '?refresh=recent');
    expect(kv._m.get('activities_last_good_v3')).toBe(before);
  });

  it('a token that cannot be refreshed is the same', async () => {
    const kv = seeded();
    install((u) => u.includes('/oauth/token') ? json({ message: 'Bad Request' }, 400) : stravaOk([])(u));
    const res = await call(envOf(kv), '?refresh=recent');
    expect(res.headers.get('X-Cache')).toBe('STALE');
  });
});

describe('the window is bounded', () => {
  it.each([[undefined, 7], ['7', 7], ['3', 3], ['14', 14], ['15', 7], ['0', 7], ['-3', 7], ['abc', 7], ['999999', 7]])
    ('days=%s asks for about %s days', async (param, days) => {
      const kv = seeded();
      install(stravaOk([]));
      await call(envOf(kv), '?refresh=recent' + (param === undefined ? '' : '&days=' + param));
      const after = +new URL(activitiesCalls()[0]).searchParams.get('after');
      const extra = (Date.now() / 1000 - after) / 86400 - days;
      // The margin day, the hours since its midnight and the zone allowance
      // add between 1.5 and 2.6 days to whatever was asked for. Wide enough to
      // hold for any time of day, narrow enough that 3, 7 and 14 stay apart —
      // and that an unclamped 999999 is nowhere near.
      expect(extra).toBeGreaterThan(1.5);
      expect(extra).toBeLessThan(2.7);
    });

  it('never pages past three requests however many come back', async () => {
    const kv = seeded();
    const many = Array.from({ length: 700 }, (_, i) => raw(9000 + i, iso(-1)));
    install(stravaOk(many));
    await call(envOf(kv), '?refresh=recent');
    expect(activitiesCalls().length).toBeLessThanOrEqual(3);
  });
});

describe('what it leaves alone', () => {
  it('does not write the refresh-duration record the dashboard estimates the next full pull from', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    await call(envOf(kv), '?refresh=recent');
    expect(kv._m.has('refresh_last_v1')).toBe(false);
    expect(kv._m.has('refresh_status_v1')).toBe(false);
  });

  it('refresh=true is still the full pull it always was', async () => {
    const kv = seeded();
    install(stravaOk([raw(7001, iso(-1))]));
    const res = await call(envOf(kv), '?refresh=true');
    expect(res.headers.get('X-Refresh')).toBe('full');
    expect(activitiesCalls().every(u => !new URL(u).searchParams.has('after'))).toBe(true);
  });

  it('a plain request is still answered from the cache without calling Strava', async () => {
    const kv = seeded();
    install(stravaOk([]));
    const res = await call(envOf(kv), '');
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(asked).toHaveLength(0);
  });
});
