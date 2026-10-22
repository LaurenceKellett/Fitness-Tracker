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


// ---- The Zwift routes: anyone may read them, only an admin key may change them ------
// The list comes from a Notion database and is shown on a public dashboard as a plain
// read-only table. What is protected is changing it, and every answer says whether the
// caller was an admin so the dashboard offers editing to nobody else.
const ROUTES = JSON.stringify({ data: [{ id: 'r1', route: 'Secret Loop' }], updatedAt: '2026-01-01T00:00:00Z' });
const zenv = (extra = {}) => {
  const env = envOf({ ADMIN_KEY: 'phone:aaaa1111,laptop:bbbb2222', ...extra });
  env.CACHE.m.set('zwift_routes_v1', ROUTES);
  return env;
};

describe('the Zwift routes', () => {
  it('can be read by anyone, key or no key', async () => {
    stub();
    const res = await send(zenv(), 'GET', '/zwift-routes');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Secret Loop');
    expect(outbound).toEqual([]);
  });
  it('and say so: no key is not an admin', async () => {
    stub();
    expect((await send(zenv(), 'GET', '/zwift-routes')).headers.get('X-Key-Level')).toBe('none');
  });
  it('a wrong or revoked key still reads, as a nobody, rather than being refused', async () => {
    stub();
    const res = await send(zenv(), 'GET', '/zwift-routes', { key: 'dddd4444' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Key-Level')).toBe('none');
  });
  it('a good key reads as an admin', async () => {
    for (const key of ['aaaa1111', 'bbbb2222']) {
      stub();
      expect((await send(zenv(), 'GET', '/zwift-routes', { key })).headers.get('X-Key-Level'), key).toBe('admin');
    }
  });
  it('says which kind of caller it was on a fresh read from Notion as well as a cached one', async () => {
    stub();
    globalThis.fetch = vi.fn(async () => json({ results: [], has_more: false }));
    const env = zenv();
    env.CACHE.m.delete('zwift_routes_v1');
    const res = await send(env, 'GET', '/zwift-routes', { key: 'aaaa1111' });
    expect(res.headers.get('X-Key-Level')).toBe('admin');
  });
  it('changing one needs an admin key', async () => {
    stub();
    expect((await send(zenv(), 'PATCH', '/zwift-routes/abc', { body: { status: 'Complete' } })).status).toBe(401);
    expect((await send(zenv(), 'PATCH', '/zwift-routes/abc', { key: 'dddd4444', body: { status: 'Complete' } })).status).toBe(401);
    expect(outbound).toEqual([]);
    for (const key of ['aaaa1111', 'bbbb2222']) {
      expect([401, 403, 503], key).not.toContain((await send(zenv(), 'PATCH', '/zwift-routes/abc', { key, body: { status: 'Complete' } })).status);
    }
  });
  it('and so does refreshing the list from Notion', async () => {
    stub();
    expect((await send(zenv(), 'GET', '/zwift-routes?refresh=true')).status).toBe(401);
    expect(outbound).toEqual([]);
  });
  it('taking one device out of the list stops that device editing, and only that device', async () => {
    stub();
    const gone = zenv({ ADMIN_KEY: 'laptop:bbbb2222' });
    expect((await send(gone, 'GET', '/zwift-routes', { key: 'aaaa1111' })).headers.get('X-Key-Level')).toBe('none');
    expect((await send(gone, 'PATCH', '/zwift-routes/abc', { key: 'aaaa1111', body: {} })).status).toBe(401);
    expect((await send(gone, 'GET', '/zwift-routes', { key: 'bbbb2222' })).headers.get('X-Key-Level')).toBe('admin');
  });
  it('with no admin key configured at all, nobody can change anything (503), but anyone can still read', async () => {
    stub();
    const env = zenv({ ADMIN_KEY: undefined });
    expect((await send(env, 'PATCH', '/zwift-routes/abc', { key: 'anything', body: {} })).status).toBe(503);
    expect((await send(env, 'GET', '/zwift-routes')).status).toBe(200);
  });
  it('a bare key with no label works, and so does base64-looking padding in a labelled one', async () => {
    stub();
    expect((await send(zenv({ ADMIN_KEY: 'plainkey99' }), 'GET', '/zwift-routes', { key: 'plainkey99' })).headers.get('X-Key-Level')).toBe('admin');
    expect((await send(zenv({ ADMIN_KEY: 'me:abc=' }), 'GET', '/zwift-routes', { key: 'abc=' })).headers.get('X-Key-Level')).toBe('admin');
  });
  it('blank entries in the list are ignored, never matched by a blank key', async () => {
    stub();
    const env = zenv({ ADMIN_KEY: ' , ,phone:aaaa1111,' });
    expect((await send(env, 'GET', '/zwift-routes', { key: '' })).headers.get('X-Key-Level')).toBe('none');
    expect((await send(env, 'GET', '/zwift-routes', { key: 'aaaa1111' })).headers.get('X-Key-Level')).toBe('admin');
  });
  it('a list with nothing but blanks in it counts as not configured', async () => {
    stub();
    expect((await send(zenv({ ADMIN_KEY: 'phone:, ,' }), 'PATCH', '/zwift-routes/abc', { key: 'x', body: {} })).status).toBe(503);
  });
  it('a write is logged by the device that made it, never by its key', async () => {
    stub();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await send(zenv(), 'PUT', '/prefs', { key: 'bbbb2222', body: { prefs: {}, updatedAt: 1 } });
    const said = log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(said).toContain('laptop');
    expect(said).not.toContain('bbbb2222');
  });
  it('the dashboard may read which kind of caller it was, and no other site may read anything', async () => {
    const ok = await send(zenv(), 'GET', '/zwift-routes', { key: 'aaaa1111', origin: 'https://activities.laurencekellett.co.uk' });
    expect(ok.headers.get('Access-Control-Expose-Headers')).toContain('X-Key-Level');
    const no = await send(zenv(), 'GET', '/zwift-routes', { key: 'aaaa1111', origin: 'https://evil.example' });
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(no.headers.get('Access-Control-Expose-Headers')).toBeNull();
  });
});

// ---- One secret per device --------------------------------------------------------
// ADMIN_KEY_<LABEL> holds a single key. Deleting the secret revokes the device, with
// no list to retype.
describe('a secret of its own for each device', () => {
  const sep = (extra = {}) => {
    const env = envOf({ ADMIN_KEY: undefined, ...extra });
    env.CACHE.m.set('zwift_routes_v1', ROUTES);
    return env;
  };
  const level = async (env, key) => (await send(env, 'GET', '/zwift-routes', { key })).headers.get('X-Key-Level');
  it('each ADMIN_KEY_<name> is an admin key, and the name is its label', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = sep({ ADMIN_KEY_PHONE: 'aaaa1111', ADMIN_KEY_LAPTOP: 'bbbb2222' });
    for (const key of ['aaaa1111', 'bbbb2222']) {
      stub();
      const res = await send(env, 'PUT', '/prefs', { key, body: { prefs: {}, updatedAt: 1 } });
      expect([401, 403, 503]).not.toContain(res.status);
    }
    const said = log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(said).toContain('admin PHONE ');
    expect(said).toContain('admin LAPTOP ');
    expect(said).not.toContain('aaaa1111');
  });
  it('deleting one secret revokes that device and only that device', async () => {
    stub();
    const before = sep({ ADMIN_KEY_PHONE: 'aaaa1111', ADMIN_KEY_LAPTOP: 'bbbb2222' });
    expect(await level(before, 'aaaa1111')).toBe('admin');
    const after = sep({ ADMIN_KEY_LAPTOP: 'bbbb2222' });
    expect(await level(after, 'aaaa1111')).toBe('none');
    expect(await level(after, 'bbbb2222')).toBe('admin');
  });
  it('the list form and the separate form work together', async () => {
    stub();
    const env = sep({ ADMIN_KEY: 'old:dddd4444', ADMIN_KEY_PHONE: 'aaaa1111' });
    expect(await level(env, 'dddd4444')).toBe('admin');
    expect(await level(env, 'aaaa1111')).toBe('admin');
  });
  it('an empty one is not a key, and a bare prefix is not a name', async () => {
    stub();
    const env = sep({ ADMIN_KEY_PHONE: '   ', ADMIN_KEY_: 'eeee5555' });
    expect(await level(env, '')).toBe('none');
    expect(await level(env, 'eeee5555')).toBe('none');
    expect((await send(env, 'PATCH', '/zwift-routes/abc', { key: 'eeee5555', body: {} })).status).toBe(503);
  });
  it('only that exact prefix counts: a look-alike name opens nothing', async () => {
    stub();
    const env = sep({ MY_ADMIN_KEY_PHONE: 'ffff6666', ADMIN_KEYS: 'ffff6666', ADMIN_KEYPHONE: 'ffff6666', FIT_SECURITY_STRING_PHONE: 'ffff6666', VIEW_KEY_TABLET: 'ffff6666' });
    expect(await level(env, 'ffff6666')).toBe('none');
    expect((await send(env, 'PATCH', '/zwift-routes/abc', { key: 'ffff6666', body: {} })).status).toBe(503);
  });
  it('a non-text binding with a matching name is ignored rather than breaking the check', async () => {
    stub();
    const env = sep({ ADMIN_KEY_STORE: { get() {} }, ADMIN_KEY_PHONE: 'aaaa1111' });
    expect(await level(env, 'aaaa1111')).toBe('admin');
    const only = sep({ ADMIN_KEY_STORE: { get() {} } });
    expect((await send(only, 'PATCH', '/zwift-routes/abc', { key: '[object Object]', body: {} })).status).toBe(503);
  });
});


// ---- Is this key good? -----------------------------------------------------------
// Settings asks before it keeps a key, so a mistyped one is never stored and trusted.
describe('checking a key', () => {
  const who = (env, key, extra = {}) => send(env, 'GET', '/whoami', { key, ...extra });
  it('a good key is an admin, named by its device, and the key itself never comes back', async () => {
    const env = envOf({ ADMIN_KEY: undefined, ADMIN_KEY_PHONE: 'aaaa1111', ADMIN_KEY_LAPTOP: 'bbbb2222' });
    const res = await who(env, 'bbbb2222');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ level: 'admin', label: 'LAPTOP' });
    expect(text).not.toContain('bbbb2222');
    expect(text).not.toContain('aaaa1111');
  });
  it('no key, or a wrong one, is nobody and is told nothing else', async () => {
    const env = envOf({ ADMIN_KEY: undefined, ADMIN_KEY_PHONE: 'aaaa1111' });
    for (const key of [undefined, '', 'wrong', 'aaaa111', 'aaaa11112']) {
      const res = await who(env, key);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ level: 'none' });
    }
  });
  it('with no key configured at all, nobody is anybody', async () => {
    expect(await (await who(envOf({ ADMIN_KEY: undefined }), 'anything')).json()).toEqual({ level: 'none' });
  });
  it('a revoked key stops being good at the next ask', async () => {
    const before = envOf({ ADMIN_KEY: undefined, ADMIN_KEY_PHONE: 'aaaa1111', ADMIN_KEY_LAPTOP: 'bbbb2222' });
    const after = envOf({ ADMIN_KEY: undefined, ADMIN_KEY_LAPTOP: 'bbbb2222' });
    expect((await (await who(before, 'aaaa1111')).json()).level).toBe('admin');
    expect((await (await who(after, 'aaaa1111')).json()).level).toBe('none');
  });
  it('is not cached, and does no work and logs no write', async () => {
    stub();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await who(envOf(), KEY);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(outbound).toEqual([]);
    expect(log.mock.calls.length).toBe(0);
  });
  it('can be asked by the dashboard, and by no other site', async () => {
    const ok = await who(envOf(), KEY, { origin: 'https://activities.laurencekellett.co.uk' });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://activities.laurencekellett.co.uk');
    const no = await who(envOf(), KEY, { origin: 'https://evil.example' });
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('what a refused caller is told', () => {
  it('says what the key is for, in one voice on every route', async () => {
    for (const [method, path, body] of GATED) {
      stub();
      const res = await send(envOf(), method, path, { body });
      const j = await res.json();
      expect(j.message, method + ' ' + path).toMatch(/^Not allowed\./);
      for (const word of ['authorised admin key', 'make changes', 'refresh', 'rearrange', 'edit']) {
        expect(j.message, method + ' ' + path + ' ' + word).toContain(word);
      }
    }
  });
});
