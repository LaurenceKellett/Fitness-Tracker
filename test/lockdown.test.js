// Who may do what. The Worker's repository is public, so its address is known to
// anyone, and for a long time every route answered anyone. This holds the line the
// other way round: anything that writes, spends Strava's rate limit or shows raw
// Strava data refuses a caller without the admin key, and does so BEFORE it does
// any of that work, which is checked by counting what the Worker fetched.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';

function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
  };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const ENVELOPE = JSON.stringify({ data: [{ id: '1', date: '2026-01-01', name: 'A', type: 'Run' }], aiSummary: 'x', updatedAt: '2026-01-01T00:00:00Z', hrZones: {}, gearMeta: {} });

let outbound;
function stub() {
  outbound = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    outbound.push((init && init.method || 'GET') + ' ' + u);
    if (u.includes('/oauth/token')) return json({ access_token: 'tok', refresh_token: 'new-refresh' });
    if (u.includes('/athlete/activities')) return json([{ id: 9, name: 'Morning run', type: 'Run', start_date: '2026-01-02', start_date_local: '2026-01-02T08:00:00Z', distance: 5000,
      start_latlng: [53.8362, -2.5964], end_latlng: [53.8362, -2.5964], map: { summary_polyline: 'abcdef' } }]);
    return json({}, 404);
  });
}
afterEach(() => vi.restoreAllMocks());

const KEY = 'correct-horse-battery-staple';
const envOf = (extra = {}) => ({
  CACHE: fakeKV({ activities_v3: ENVELOPE, activities_last_good_v3: ENVELOPE }),
  STRAVA_CLIENT_ID: 'id', STRAVA_CLIENT_SECRET: 'secret', STRAVA_REFRESH_TOKEN: 'r', NOTION_API_KEY: 'n', ADMIN_KEY: KEY, ...extra,
});
const send = (env, method, path, { key, origin, body, cookie } = {}) => {
  const headers = {};
  if (key !== undefined) headers['X-Admin-Key'] = key;
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request('https://api.example' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
};

const GATED = [
  ['GET', '/debug'],
  ['GET', '/sync-training-log'],
  ['GET', '/backfill-prs'],
  ['GET', '/activities?refresh=true'],
  ['GET', '/activities?refresh=recent&days=7'],
  ['GET', '/zwift-routes?refresh=true'],
  ['PATCH', '/zwift-routes/abc123', { status: 'Complete' }],
  ['PUT', '/prefs', { prefs: { layout: {} }, updatedAt: 5 }],
];

describe('routes that need the admin key', () => {
  for (const [method, path, body] of GATED) {
    it(`${method} ${path} refuses a caller with no key, and does no work`, async () => {
      stub();
      const env = envOf();
      const before = JSON.stringify([...env.CACHE.m]);
      const res = await send(env, method, path, { body });
      expect(res.status).toBe(401);
      expect(outbound).toEqual([]);
      expect(JSON.stringify([...env.CACHE.m])).toBe(before);
    });
    it(`${method} ${path} refuses the wrong key`, async () => {
      stub();
      const res = await send(envOf(), method, path, { key: KEY + 'x', body });
      expect(res.status).toBe(401);
      expect(outbound).toEqual([]);
    });
    it(`${method} ${path} is switched off, not open, when no key is configured`, async () => {
      stub();
      const res = await send(envOf({ ADMIN_KEY: undefined }), method, path, { key: 'anything', body });
      expect(res.status).toBe(503);
      expect(outbound).toEqual([]);
    });
    it(`${method} ${path} gets past the lock with the right key`, async () => {
      stub();
      const res = await send(envOf(), method, path, { key: KEY, body });
      expect([401, 503]).not.toContain(res.status);
    });
  }
  it('a key that merely shares the start of its digest is still the wrong key', async () => {
    // The check compares digests, so a comparison that stopped early would let a
    // key through whose hash begins the same way. Find one that does (two bytes' worth).
    const enc = new TextEncoder();
    const head = async (t) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t))).slice(0, 2).join(',');
    const target = await head(KEY);
    let twin = null;
    for (let i = 0; i < 400000 && !twin; i++) if ((await head('guess' + i)) === target) twin = 'guess' + i;
    expect(twin).not.toBeNull();
    stub();
    const res = await send(envOf(), 'GET', '/sync-training-log', { key: twin });
    expect(res.status).toBe(401);
  });
  it('an empty key is not the same as no lock', async () => {
    stub();
    const res = await send(envOf({ ADMIN_KEY: '' }), 'GET', '/sync-training-log', { key: '' });
    expect(res.status).toBe(503);
  });
});

describe('what stays open', () => {
  it('a plain read of the activities', async () => {
    stub();
    const res = await send(envOf(), 'GET', '/activities');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(outbound).toEqual([]);
  });
  it('reading the dashboard preferences, and the refresh progress', async () => {
    stub();
    expect((await send(envOf(), 'GET', '/prefs')).status).toBe(200);
    expect((await send(envOf(), 'GET', '/refresh-status')).status).toBe(200);
  });
  it('an unknown path is still a 404', async () => {
    expect((await send(envOf(), 'GET', '/nope')).status).toBe(404);
  });
});

describe('an open read that finds the cache empty', () => {
  it('serves the last good copy instead of starting a pull for a stranger', async () => {
    stub();
    const env = envOf();
    env.CACHE.m.delete('activities_v3');
    const res = await send(env, 'GET', '/activities');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('STALE');
    expect(outbound).toEqual([]);
  });
  it('the key holder still gets the pull', async () => {
    stub();
    const env = envOf();
    env.CACHE.m.delete('activities_v3');
    await send(env, 'GET', '/activities', { key: KEY });
    expect(outbound.some(u => u.includes('/athlete/activities'))).toBe(true);
  });
  it('and a Worker that has never had a good copy still builds its first one', async () => {
    stub();
    const env = envOf({ CACHE: fakeKV() });
    await send(env, 'GET', '/activities');
    expect(outbound.some(u => u.includes('/athlete/activities'))).toBe(true);
  });
});

describe('the diagnostic', () => {
  it('shows that Strava answered and not where the activities started', async () => {
    stub();
    const res = await send(envOf(), 'GET', '/debug', { key: KEY });
    const text = await res.text();
    expect(text).toContain('Morning run');
    expect(text).not.toContain('start_latlng');
    expect(text).not.toContain('end_latlng');
    expect(text).not.toContain('summary_polyline');
    expect(text).not.toContain('53.8362');
    expect(text).not.toContain('abcdef');
  });
});

describe('signing in to Strava', () => {
  it('/auth sends a state, and the same one in a cookie', async () => {
    const res = await send(envOf(), 'GET', '/auth');
    const to = new URL(res.headers.get('Location'));
    const state = to.searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('strava_oauth_state=' + state);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
  });
  it('/callback with no state is not used, and stores nothing', async () => {
    stub();
    const env = envOf();
    const res = await send(env, 'GET', '/callback?code=abc');
    expect(res.status).toBe(400);
    expect(outbound).toEqual([]);
    expect(env.CACHE.m.has('strava_refresh_token')).toBe(false);
  });
  it('/callback whose state is not the cookie is not used', async () => {
    stub();
    const env = envOf();
    const res = await send(env, 'GET', '/callback?code=abc&state=attacker', { cookie: 'strava_oauth_state=mine' });
    expect(res.status).toBe(400);
    expect(outbound).toEqual([]);
  });
  it('/callback with a state but no cookie is not used (the browser never started it)', async () => {
    stub();
    const res = await send(envOf(), 'GET', '/callback?code=abc&state=attacker');
    expect(res.status).toBe(400);
    expect(outbound).toEqual([]);
  });
  it('/callback that matches the cookie goes through and keeps the token', async () => {
    stub();
    const env = envOf();
    const res = await send(env, 'GET', '/callback?code=abc&state=s1', { cookie: 'other=1; strava_oauth_state=s1' });
    expect(res.status).toBe(200);
    expect(outbound.some(u => u.includes('/oauth/token'))).toBe(true);
    expect([...env.CACHE.m.values()]).toContain('new-refresh');
  });
});

describe('which web pages may talk to it', () => {
  it('the dashboard may, and is named rather than allowed with a star', async () => {
    const res = await send(envOf(), 'GET', '/activities', { origin: 'https://activities.laurencekellett.co.uk' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://activities.laurencekellett.co.uk');
  });
  it('another site may not read it', async () => {
    const res = await send(envOf(), 'GET', '/activities', { origin: 'https://evil.example' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('and nothing answers with a star', async () => {
    for (const [method, path, body] of [['GET', '/activities'], ['GET', '/debug'], ['GET', '/prefs'], ...GATED]) {
      stub();
      const res = await send(envOf(), method, path, { origin: 'https://evil.example', body });
      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });
  it('the preflight for a write says the admin header is allowed, to the dashboard only', async () => {
    const ok = await send(envOf(), 'OPTIONS', '/prefs', { origin: 'https://activities.laurencekellett.co.uk' });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('X-Admin-Key');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    const no = await send(envOf(), 'OPTIONS', '/prefs', { origin: 'https://evil.example' });
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('another address can be allowed from the environment', async () => {
    const env = envOf({ ALLOWED_ORIGINS: 'https://one.example, https://two.example' });
    expect((await send(env, 'GET', '/activities', { origin: 'https://two.example' })).headers.get('Access-Control-Allow-Origin')).toBe('https://two.example');
    expect((await send(env, 'GET', '/activities', { origin: 'https://activities.laurencekellett.co.uk' })).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
