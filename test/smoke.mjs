/* Browser smoke test.
 *
 * calc.test.js covers the arithmetic; nothing there can tell you the page boots.
 * This does: it serves the repo over HTTP, stubs the Worker, drives a real
 * Chromium, and fails on any console error or unhandled rejection.
 *
 * Run with `npm run smoke`. Chromium comes from Playwright.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

// ── Fixture ───────────────────────────────────────────────────────────────────
// Enough shape to exercise every tab: several years, every sport group, a route,
// gear, a training partner, a race, and a near-home activity.
function fixture() {
  const out = [];
  const today = new Date();
  const sports = ['Ride', 'VirtualRide', 'Run', 'Walk', 'Swim', 'WeightTraining'];
  const thisYear = String(today.getFullYear());
  // Two full years of history, not one. A single year cannot exercise anything that
  // learns from a FINISHED year — the seasonal half of the projection mixer has
  // nothing to read and silently falls back to the recent trend.
  const N = 900;
  for (let i = 0; i < N; i++) {
    const d = new Date(today.getTime() - i * 36e5 * 20);
    const iso = d.toISOString().slice(0, 10);
    // Swimming stopped at the end of last year. It is the case the sport filter has
    // to handle: present across all time, absent from the year you are looking at.
    // Kayaking takes its place — the sport that used to be filed under Swim and put
    // paddled distances into the Records tab as swimming bests.
    let type = sports[i % sports.length];
    if (type === 'Swim' && iso.slice(0, 4) === thisYear) type = 'Kayaking';
    out.push({
      id: 1000 + i,
      date: iso,
      time: '07:30',
      type,
      sport: type,
      // Dave and Sarah appear throughout, so they read as current. Nige only ever
      // appears in the oldest third, which is what puts him in the dormant group —
      // without someone on each side of the line the grouping cannot be tested.
      name: i % 11 === 0 ? `Morning ${type} w/ Dave & Sarah`
          : (i > N * 0.7 && i % 7 === 0) ? `Evening ${type} w/ Nige`
          : `${type} session ${i}`,
      dist_mi: +(2 + (i % 40) * 0.9).toFixed(2),
      dist_km: +((2 + (i % 40) * 0.9) * 1.60934).toFixed(2),
      mt: 1800 + (i % 20) * 600,
      et: 1900 + (i % 20) * 600,
      elv: (i % 30) * 40,
      hr: 120 + (i % 40),
      // The Worker sends both of these on every activity; without them the charts
      // built on them would be tested only in their empty state.
      max_hr: 150 + (i % 30),
      kudos: i % 17,
      cad: 80 + (i % 15),
      cal: 400 + i,
      speed_mph: +(8 + (i % 12)).toFixed(1),
      speed_kph: +((8 + (i % 12)) * 1.60934).toFixed(1),
      gear: i % 2 ? 'Canyon Ultimate CF SL 8' : 'Nike Pegasus 40',
      wtype: i % 37 === 0 ? 1 : 0,
      commute: i % 13 === 0,
      has_map: i % 3 !== 0,
      near_home: i % 5 === 0,
      lat: 53.8362 + (i % 9) * 0.01,
      lng: -2.5964 + (i % 7) * 0.01,
      polylines: i % 3 !== 0 ? ['_p~iF~ps|U_ulLnnqC_mqNvxq`@'] : [],
      temp: 5 + (i % 20),
    });
  }
  return out;
}

const ENVELOPE = {
  data: fixture(),
  updatedAt: new Date().toISOString(),
  hrZones: { source: 'strava', zones: [110, 130, 150, 170] },
  gearMeta: { 'Nike Pegasus 40': { retired: false, type: 'shoe' } },
};

// ── Library stubs ─────────────────────────────────────────────────────────────
// Only the surface the dashboard actually touches. `update()` and `destroy()` are
// counted so the test can tell an in-place update from a rebuild.
const CHART_STUB = `
window.__stubChartUpdates = 0;
window.Chart = class {
  constructor(ctx, config) {
    this.canvas = ctx && ctx.canvas ? ctx.canvas : ctx;
    this.ctx = ctx;
    this.config = config || {};
    this.data = (config && config.data) || { labels: [], datasets: [] };
    this.options = (config && config.options) || {};
    this._destroyed = false;
    // Just enough tooltip to exercise the page's own open/close handling. The real
    // library opens on touchstart and again on the mousemove and click a browser
    // synthesises after a tap — which is the whole reason that handling is subtle —
    // and the point it lands on follows the x coordinate.
    this._active = [];
    const self = this;
    this.tooltip = {
      getActiveElements: () => self._active,
      setActiveElements: (a) => { self._active = a || []; },
      get opacity() { return self._active.length ? 1 : 0; },
    };
    const cv = this.canvas;
    if (cv && cv.addEventListener) {
      const openAt = (clientX) => {
        const r = cv.getBoundingClientRect();
        self._active = [{ index: Math.max(0, Math.round((clientX - r.left) / 10)), datasetIndex: 0 }];
      };
      cv.addEventListener('touchstart', (e) => {
        const t = e.touches && e.touches[0]; if (t) openAt(t.clientX);
      });
      cv.addEventListener('mousemove', (e) => openAt(e.clientX));
      cv.addEventListener('click', (e) => openAt(e.clientX));
      cv.addEventListener('mouseout', () => { self._active = []; });
      (window.Chart._reg || (window.Chart._reg = new Map())).set(cv, this);
    }
  }
  setActiveElements(a) { this._active = a || []; }
  update() { window.__stubChartUpdates++; }
  destroy() { this._destroyed = true; }
  resize() {}
};
window.Chart.defaults = { color: '#000', borderColor: '#eee', font: { family: '' } };
window.Chart.register = function () {};
window.Chart._reg = new Map();
window.Chart.getChart = (c) => window.Chart._reg.get(c) || null;
`;

const LEAFLET_STUB = `
(function () {
  function chainable(extra) {
    const o = Object.assign({
      addTo() { return o; }, remove() { return o; }, setOpacity() { return o; },
      on() { return o; }, setLatLngs() { return o; }, setStyle() { return o; },
      bringToFront() { return o; }, getBounds() { return { isValid: () => true }; },
    }, extra || {});
    return o;
  }
  const map = () => chainable({
    setView() { return map; }, flyTo() {}, flyToBounds() {}, fitBounds() {},
    invalidateSize() {}, removeLayer() {}, addLayer() {}, getZoom: () => 13,
    getCenter: () => ({ lat: 53.8, lng: -2.6 }), remove() {}, on() {}, off() {},
  });
  window.L = {
    map: () => map(),
    tileLayer: () => chainable(),
    polyline: () => chainable(),
    circleMarker: () => chainable(),
    marker: () => chainable(),
    canvas: () => ({}),
    latLngBounds: (pts) => ({ isValid: () => !!(pts && pts.length), pad: () => ({}) }),
    latLng: (a, b) => ({ lat: a, lng: b }),
    control: { layers: () => chainable() },
    DomUtil: { create: (t) => document.createElement(t) },
  };
})();
`;

// ── Static server ─────────────────────────────────────────────────────────────
/* The headers Cloudflare Pages will send, read from the file that configures it.
 *
 * Serving these locally is what makes the Content-Security-Policy testable at all. A
 * policy checked only by reading the file back proves the file parses; it does not
 * prove the page still works under it, and the failure mode of a too-strict policy is
 * a blocked script and a blank dashboard. Every scenario below already fails on an
 * unexpected console error, and a CSP violation logs exactly that — so with the real
 * headers on, the whole existing suite becomes the policy's test.
 *
 * Deliberately simple: this reads the one /* block, not Cloudflare's full matching
 * rules, because one block is what the file has.
 */
function pagesHeaders() {
  const src = path.join(ROOT, '_headers');
  if (!fs.existsSync(src)) return {};
  const out = {};
  let inGlobal = false;
  for (const raw of fs.readFileSync(src, 'utf8').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { inGlobal = line.trim() === '/*'; continue; }
    if (!inGlobal) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const DEPLOY_HEADERS = pagesHeaders();

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        ...DEPLOY_HEADERS,
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Harness ───────────────────────────────────────────────────────────────────
const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const TABS = ['summary', 'map', 'charts', 'heatmap', 'records', 'mex', 'social', 'gear', 'log', 'zwift'];

async function main() {
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  // Prefer a Chromium already on the machine (CI images and this sandbox ship one)
  // over whatever build this Playwright version would download. CHROMIUM_PATH wins;
  // failing that, look where PLAYWRIGHT_BROWSERS_PATH points, because Playwright's
  // own default resolves to a versioned headless-shell directory that an image
  // pinning a different build does not have — which is a launch failure, not a
  // fallback. Bare launch() only if neither is there.
  const browserDir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const preinstalled = [process.env.CHROMIUM_PATH, path.join(browserDir, 'chromium')]
    .find((p) => p && fs.existsSync(p));
  const browser = await chromium.launch(preinstalled ? { executablePath: preinstalled } : {});

  // One page per scenario, each with its own console-error collector.
  async function open({ apiStatus = 200, apiBody = ENVELOPE, offline = false, skipLibs = false,
                        serviceWorkers = 'block', viewport = { width: 1400, height: 900 },
                        hasTouch = false } = {}) {
    // Service workers are blocked by default here. Once one is active it serves the
    // CDN requests itself, and a service worker's own fetches do not pass through
    // page.route() — so the library stubs below would be bypassed and the test
    // would be measuring the network, not this page. The worker gets its own
    // scenario at the end, where it is the subject rather than an interference.
    const ctx = await browser.newContext({ viewport, serviceWorkers, hasTouch, isMobile: hasTouch });
    const page = await ctx.newPage();
    const errors = [];
    // Deliberately blocked third-party assets (fonts, tiles, geocoding) and missing
    // gear photos — which the page already handles with a fallback tile — are the
    // harness's noise, not the page's failures.
    const IGNORE = /net::ERR_FAILED|Failed to load resource|gear-images|favicon/;
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    // Tiles and fonts are third-party and not what this is testing.
    await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
    await page.route(/fonts\.g(oogleapis|static)\.com/, (r) => r.abort());
    await page.route(/nominatim\.openstreetmap\.org/, (r) => r.abort());

    // Chart.js and Leaflet are served as stubs rather than as their real selves.
    // They live in /vendor on this origin now rather than on a CDN, but what is under
    // test is unchanged: the dashboard's own lifecycle — that the libraries are
    // fetched on demand rather than up front, that a filter change updates the
    // existing charts instead of rebuilding them, that the map mounts when its tab
    // opens. None of that is a test of Chart.js or Leaflet.
    if (!skipLibs) {
      await page.route(/chart\.umd(\.min)?\.js/, (r) =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: CHART_STUB }));
      await page.route(/leaflet\.js(\?|$)/, (r) =>
        r.fulfill({ status: 200, contentType: 'text/javascript', body: LEAFLET_STUB }));
      await page.route(/leaflet\.css(\?|$)/, (r) =>
        r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    }

    await page.route('**/activities**', (r) => {
      if (offline) return r.abort('failed');
      return r.fulfill({ status: apiStatus, contentType: 'application/json', body: JSON.stringify(apiBody) });
    });
    await page.route('**/zwift-routes**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], updatedAt: new Date().toISOString() }) })
    );
    // The panel order syncs through the Worker. Left unstubbed this is a real
    // request to a real Worker from every test in the file: slow, and it would make
    // the suite's results depend on somebody's saved layout.
    await page.route('**/prefs**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: {}, updatedAt: 0 }) })
    );

    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }

  // ── 1. Happy path ───────────────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await open();
    await page.waitForFunction(() => !document.body.classList.contains('is-loading'), null, { timeout: 20000 });

    await check('boots and clears the loading skeleton', async () => {
      assert(!(await page.locator('body.is-loading').count()), 'skeleton still up');
    });

    await check('renders the hero figure from data, not a placeholder', async () => {
      const t = (await page.locator('#sumWeekHours').innerText()).trim();
      assert(t && t !== '—', `hero still reads "${t}"`);
    });

    await check('loads Chart.js on demand and draws the summary charts', async () => {
      assert(await page.evaluate(() => !!window.Chart), 'Chart.js never loaded');
      const drawn = await page.evaluate(() => Object.keys(typeof charts!=="undefined"?charts:{}).length);
      assert(drawn > 0, 'no chart instances registered');
    });

    await check('does not load Leaflet until the map is asked for', async () => {
      assert(!(await page.evaluate(() => !!window.L)), 'Leaflet loaded on the Summary tab');
    });

    await check('every tab renders without a console error', async () => {
      for (const tab of TABS) {
        errors.length = 0;
        await page.evaluate((t) => window.setTab(t), tab);
        await page.waitForTimeout(400);
        assert(errors.length === 0, `${tab}: ${errors[0]}`);
        const visible = await page.locator(`#tab-${tab}.active`).count();
        assert(visible === 1, `${tab}: panel did not become active`);
      }
    });

    await check('loads Leaflet once the Map tab is opened', async () => {
      await page.evaluate(() => window.setTab('map'));
      await page.waitForFunction(() => !!window.L, null, { timeout: 15000 });
      await page.waitForFunction(() => typeof _map!=="undefined"&&!!_map, null, { timeout: 15000 });
    });

    await check('switching units re-renders without tearing every chart down', async () => {
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(500);
      const before = await page.evaluate(() => typeof __chartStats!=="undefined"?{ ...__chartStats }:null);
      await page.evaluate(() => window.setUnit('km'));
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => typeof __chartStats!=="undefined"?{ ...__chartStats }:null);
      assert(before && after, 'chart stats not instrumented');
      assert(after.updated > before.updated, `no charts updated in place (updated ${before.updated} → ${after.updated})`);
      const created = after.created - before.created;
      assert(created === 0, `${created} charts were rebuilt from scratch on a unit toggle`);
    });

    await check('a sport with nothing in the period is not offered for it', async () => {
      const sportsOffered = () => page.evaluate(() =>
        [...document.querySelectorAll('#headerTypeFilters .type-btn')].map((b) => b.dataset.type));

      await page.evaluate(() => window.setYear('All'));
      await page.waitForTimeout(300);
      assert((await sportsOffered()).includes('Swim'), 'all time should still offer Swim');

      // The fixture's swimming all happened last year.
      await page.evaluate(() => window.setYear(String(new Date().getFullYear())));
      await page.waitForTimeout(300);
      const now = await sportsOffered();
      assert(!now.includes('Swim'), `this year still offers Swim: ${now}`);
      assert(now.includes('All') && now.includes('Ride') && now.includes('Run'),
        `the sports that did happen went missing too: ${now}`);

      await page.evaluate(() => window.setYear('All'));
      await page.waitForTimeout(300);
      assert((await sportsOffered()).includes('Swim'), 'Swim did not come back on all time');
    });

    await check('the selected sport stays put when its year runs out, marked empty', async () => {
      // Otherwise the control removes itself while active and the page is filtered to
      // nothing with no visible way back.
      await page.evaluate(() => window.setType('Swim'));
      await page.evaluate(() => window.setYear(String(new Date().getFullYear())));
      await page.waitForTimeout(400);
      const btn = await page.evaluate(() => {
        const b = document.querySelector('#headerTypeFilters .type-btn[data-type="Swim"]');
        return b && { empty: b.classList.contains('type-btn-empty'), active: b.classList.contains('active') };
      });
      assert(btn, 'the selected sport vanished from the row');
      assert(btn.active && btn.empty, `Swim button state: ${JSON.stringify(btn)}`);
      assert((await page.evaluate(() => activeType)) === 'Swim', 'the selection was changed behind my back');
      await page.evaluate(() => { window.setType('All'); window.setYear('All'); });
      await page.waitForTimeout(300);
    });

    await check('kayaking is not filed as a swim', async () => {
      // It happens in water; it is not swimming, and a paddled distance showing up as
      // a swimming best is what made this worth fixing.
      assert((await page.evaluate(() => typeGroup('Kayaking'))) === 'Other', 'Kayaking still groups as Swim');
      const counts = await page.evaluate(() => {
        const out = { Swim: 0, Other: 0 };
        for (const a of ALL_DATA) {
          if (a.type === 'Swim') out.Swim++;
          if (a.type === 'Kayaking') out.Other++;
        }
        return out;
      });
      assert(counts.Other > 0, 'the fixture has no kayaking to check');
      // Every activity the app calls a Swim is a Strava Swim.
      const misfiled = await page.evaluate(() =>
        ALL_DATA.filter((a) => typeGroup(a.type) === 'Swim' && a.type !== 'Swim').length);
      assert(misfiled === 0, `${misfiled} non-swims are grouped as swimming`);
    });

    await check('one broken chart does not take the rest of the tab with it', async () => {
      // The failure mode this guards: renderCharts used to be a straight run of
      // calls, so the first exception unwound the lot. Charts ABOVE the bad one kept
      // whatever they had drawn and looked current; everything below never updated.
      // A filter change then left half the tab describing the previous filter, with
      // nothing on screen admitting it.
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(500);
      const monoData = () => page.evaluate(() => {
        const c = window.Chart.getChart(document.getElementById('chartMono'));
        return c ? JSON.stringify(c.data.datasets[0].data.slice(0, 5)) : null;
      });

      // Break a chart EARLY in the sequence; chartMono renders after it.
      await page.evaluate(() => {
        window.__realMix = window.renderMixByYear;
        window.renderMixByYear = () => { throw new Error('synthetic failure'); };
      });
      const before = await monoData();
      let threw = null;
      try { await page.evaluate(() => window.setType('Ride')); }
      catch (e) { threw = e.message.split('\n')[0]; }
      await page.waitForTimeout(500);

      assert(!threw, `a filter change threw all the way out: ${threw}`);
      assert((await monoData()) !== before, 'a later chart never updated — the render still aborts');
      const note = await page.evaluate(() => {
        const cv = document.getElementById('chartMixYear');
        const n = cv && cv.parentElement.querySelector('.chart-empty');
        return n ? n.textContent : null;
      });
      assert(note && /could not be drawn/i.test(note),
        `the broken card shows "${note}" instead of saying it failed`);

      await page.evaluate(() => { window.renderMixByYear = window.__realMix; window.setType('All'); });
      await page.waitForTimeout(500);
    });

    await check('the five newest charts draw rather than sitting empty', async () => {
      // "Every tab renders without a console error" catches a throw. It does not
      // catch a chart that quietly decided it had no data and put a sentence in
      // place of itself, which is the way a new chart usually fails.
      const drawn = async (tab, canvas) => {
        await page.evaluate((t) => window.setTab(t), tab);
        await page.waitForTimeout(500);
        return page.evaluate((c) => {
          const cv = document.getElementById(c);
          if (!cv) return 'no canvas';
          if (cv.style.display === 'none') {
            const n = cv.parentElement.querySelector('.chart-empty');
            return 'empty: ' + (n ? n.textContent : '?');
          }
          const card = cv.closest('.chart-card');
          const chips = card.querySelector('.chart-chips');
          const verdict = card.querySelector('.chart-verdict');
          return {
            chips: chips ? chips.children.length : 0,
            verdict: verdict ? verdict.textContent.trim().length : 0,
          };
        }, canvas);
      };
      for (const [tab, canvas, name] of [
        ['charts', 'chartMixYear', 'how the mix has shifted'],
        ['charts', 'chartMaxHr', 'how hard you actually go'],
        ['charts', 'chartMono', 'training monotony'],
        ['social', 'chartKudos', 'what gets a reaction'],
      ]) {
        const r = await drawn(tab, canvas);
        assert(typeof r === 'object', `${name}: ${r}`);
        assert(r.chips > 0, `${name} drew no chips`);
        assert(r.verdict > 20, `${name} drew no verdict`);
      }

    });

    await check('the mix chart can be measured three ways and remembers which', async () => {
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(400);
      const read = () => page.evaluate(() => {
        const c = window.Chart.getChart(document.getElementById('chartMixYear'));
        return {
          active: [...document.querySelectorAll('#mixMeasureCtl .chart-ctl-btn')]
            .filter((b) => b.classList.contains('active')).map((b) => b.dataset.measure),
          sub: document.getElementById('mixYearSub').textContent,
          last: (c ? c.data.datasets : []).map((d) => d.label + ':' + d.data[d.data.length - 1]).join(' '),
        };
      });

      // Distance out of the box — the measure the rest of the dashboard leads with.
      const dist = await read();
      assert(dist.active.join() === 'dist', `active buttons: ${dist.active}`);
      assert(/distance/i.test(dist.sub), `sub reads "${dist.sub}"`);

      const seen = { dist: dist.last };
      for (const m of ['time', 'count']) {
        await page.evaluate((x) => window.setMixMeasure(x), m);
        await page.waitForTimeout(300);
        const r = await read();
        assert(r.active.join() === m, `${m}: active buttons are ${r.active}`);
        assert(r.sub !== dist.sub, `${m} did not change the subtitle`);
        seen[m] = r.last;
      }
      // The three must actually disagree, or the toggle is decoration: a walk is a
      // big share of sessions and a small share of distance, and that gap is the
      // reason the control exists.
      assert(new Set(Object.values(seen)).size === 3,
        `the measures produced identical shares: ${JSON.stringify(seen)}`);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.classList.contains('is-loading'), { timeout: 15000 });
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(500);
      assert((await read()).active.join() === 'count', 'the chosen measure did not survive a reload');
      await page.evaluate(() => window.setMixMeasure('dist'));
      await page.waitForTimeout(200);
    });

    await check('the year-end projection is dotted, and the mixer moves it', async () => {
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(500);
      const read = () => page.evaluate(() => {
        const c = window.Chart.getChart(document.getElementById('chartProject'));
        const ds = c && c.data ? c.data.datasets : [];
        const p = ds.find((d) => d.label === 'Projected');
        if (!p) return { found: false, labels: ds.map((d) => d.label) };
        const pts = p.data.filter((v) => v != null);
        return {
          found: true, n: pts.length, end: pts[pts.length - 1], start: pts[0],
          dotted: !!(p.borderDash && p.borderDash.length),
          says: document.getElementById('projMixSays').textContent,
        };
      });

      const mid = await read();
      assert(mid.found, `no projection dataset: ${JSON.stringify(mid.labels)}`);
      assert(mid.dotted, 'the projection is not dotted, so it reads as something that happened');
      assert(mid.n > 1, 'the projection has nothing to draw');
      assert(mid.end >= mid.start, 'a cumulative projection cannot go backwards');

      // The dial has to actually change the answer, and its two ends have to be
      // different methods rather than the same one relabelled.
      await page.evaluate(() => window.setProjMix(0));
      await page.waitForTimeout(300);
      const seasonal = await read();
      await page.evaluate(() => window.setProjMix(100));
      await page.waitForTimeout(300);
      const recent = await read();
      assert(seasonal.end !== recent.end,
        `both ends of the mixer project ${seasonal.end} — the dial is doing nothing`);
      assert(/usually|previous year/i.test(seasonal.says), `left end says "${seasonal.says}"`);
      assert(/last \d+ days/i.test(recent.says), `right end says "${recent.says}"`);

      // Every measure projects something, in its own unit.
      for (const m of ['time', 'count', 'elev', 'dist']) {
        await page.evaluate((x) => window.setProjMeasure(x), m);
        await page.waitForTimeout(300);
        const r = await read();
        assert(r.found && r.n > 1, `${m} drew no projection`);
      }
      const chip = await page.evaluate(() =>
        (document.querySelector('#projectChips .chart-chip') || {}).textContent || '');
      assert(/projected year end/i.test(chip), `first chip reads "${chip}"`);

      await page.evaluate(() => window.setProjMix(50));
      await page.waitForTimeout(200);
    });

    await check('rolling date scopes filter the data', async () => {
      const all = await page.evaluate(() => { window.setYear('All'); return window.getFiltered().length; });
      const d30 = await page.evaluate(() => { window.setYear('30d'); return window.getFiltered().length; });
      const d90 = await page.evaluate(() => { window.setYear('90d'); return window.getFiltered().length; });
      const m12 = await page.evaluate(() => { window.setYear('12m'); return window.getFiltered().length; });
      assert(d30 > 0, 'last 30 days is empty');
      assert(d30 < d90 && d90 < m12 && m12 <= all, `scopes do not nest: ${d30} / ${d90} / ${m12} / ${all}`);
      const label = await page.evaluate(() => { window.setYear('90d'); return document.getElementById('scopeChipText').textContent; });
      assert(/90 days/i.test(label), `scope chip reads "${label}"`);
      await page.evaluate(() => window.setYear('All'));
    });

    await check('a rolling scope survives a reload through the URL', async () => {
      await page.evaluate(() => window.setYear('90d'));
      await page.waitForTimeout(200);
      const url = page.url();
      assert(/year=90d/.test(url), `URL does not carry the scope: ${url}`);
      // Leave the scope where the rest of the suite expects it.
      await page.evaluate(() => window.setYear('All'));
      await page.waitForTimeout(300);
    });

    await check('tabs are exposed as a tablist with a selected tab', async () => {
      const info = await page.evaluate(() => {
        const strip = document.getElementById('tabRow');
        const btns = [...strip.querySelectorAll('.tab-btn')];
        return {
          role: strip.getAttribute('role'),
          btnRoles: btns.map((b) => b.getAttribute('role')),
          selected: btns.filter((b) => b.getAttribute('aria-selected') === 'true').length,
          tabbable: btns.filter((b) => b.getAttribute('tabindex') !== '-1').length,
          panels: [...document.querySelectorAll('.tab-content')].map((p) => p.getAttribute('role')),
          controls: btns.every((b) => !!b.getAttribute('aria-controls')),
        };
      });
      assert(info.role === 'tablist', `tab strip role is ${info.role}`);
      assert(info.btnRoles.every((r) => r === 'tab'), 'a tab button is missing role=tab');
      assert(info.selected === 1, `${info.selected} tabs marked selected`);
      assert(info.tabbable === 1, `${info.tabbable} tabs in the tab order; should be 1 (roving tabindex)`);
      assert(info.panels.every((r) => r === 'tabpanel'), 'a panel is missing role=tabpanel');
      assert(info.controls, 'a tab is missing aria-controls');
    });

    await check('arrow keys move between tabs', async () => {
      await page.evaluate(() => { window.setTab('summary'); document.querySelector('.tab-btn[aria-selected="true"]').focus(); });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      const tab = await page.evaluate(() => activeTab);
      assert(tab === 'map', `ArrowRight landed on ${tab}`);
      await page.keyboard.press('End');
      await page.waitForTimeout(300);
      assert((await page.evaluate(() => activeTab)) === 'zwift', 'End did not reach the last tab');
      await page.evaluate(() => window.setTab('summary'));
    });

    await check('a modal traps focus and gives it back on close', async () => {
      await page.evaluate(() => window.setTab('log'));
      await page.waitForTimeout(400);
      const opened = await page.evaluate(() => {
        // Scoped to the log table: the same class is on the Summary tab's recent
        // list, whose rows are in the DOM but hidden, and a hidden element cannot
        // take focus.
        const row = document.querySelector('#logBody .act-row-click');
        if (!row) return false;
        row.focus();
        if (document.activeElement !== row) return false;
        window.openActivityModal(row.dataset.act);
        return true;
      });
      assert(opened, 'could not focus a log row');
      await page.waitForTimeout(500);
      const inside = await page.evaluate(() => {
        const modal = document.querySelector('.gear-modal-backdrop.open, #actModalBackdrop.open');
        return !!(modal && modal.contains(document.activeElement));
      });
      assert(inside, 'focus did not move into the modal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const restored = await page.evaluate(() =>
        document.activeElement && document.activeElement.closest('#logBody .act-row-click') !== null);
      assert(restored, 'focus was not returned to the row that opened the modal');
    });

    await check('dormant training partners are grouped behind one toggle', async () => {
      // A narrow scope filters the dormant partners out of the data entirely, and
      // then there is nothing to group.
      await page.evaluate(() => { window.setYear('All'); window.setType('All'); window.setTab('social'); });
      await page.waitForTimeout(700);

      const before = await page.evaluate(() => {
        const d = document.querySelector('.soc-dormant');
        if (!d) return null;
        const rowsIn = d.querySelectorAll('.soc-row').length;
        const rowsOut = [...document.querySelectorAll('.soc-tbl > .soc-row')].length;
        return {
          open: d.open,
          rowsIn,
          rowsOut,
          countLabel: d.querySelector('.soc-dormant-n').textContent.trim(),
          sub: d.querySelector('.soc-dormant-sub').textContent.trim(),
          // A closed <details> genuinely hides its contents rather than merely
          // dimming them; measure that, not the attribute.
          visible: [...d.querySelectorAll('.soc-row')].filter((r) => r.offsetParent !== null).length,
        };
      });
      assert(before, 'no dormant group rendered');
      assert(before.rowsOut > 0, 'every partner ended up inside the toggle');
      assert(before.rowsIn > 0, 'the toggle holds no partners');
      assert(!before.open, 'the group starts expanded when there are current partners');
      assert(before.visible === 0, `${before.visible} dormant rows visible while collapsed`);
      assert(Number(before.countLabel) === before.rowsIn,
        `summary says ${before.countLabel} but holds ${before.rowsIn} rows`);
      assert(/occasional|lapsed/.test(before.sub), `summary subtitle reads "${before.sub}"`);

      // Only the dormant ones are hidden — the current partners stay on the page.
      const standings = await page.evaluate(() =>
        [...document.querySelectorAll('.soc-tbl > .soc-row .soc-warm')].map((e) => e.textContent.trim()));
      assert(standings.length && standings.every((t) => t === 'Regular'),
        `ungrouped rows show standings ${JSON.stringify(standings)}`);

      await page.click('.soc-dormant > summary');
      await page.waitForTimeout(350);
      const after = await page.evaluate(() => {
        const d = document.querySelector('.soc-dormant');
        return { open: d.open, visible: [...d.querySelectorAll('.soc-row')].filter((r) => r.offsetParent !== null).length };
      });
      assert(after.open && after.visible === before.rowsIn, 'opening the toggle did not reveal the rows');

      // A filter change re-renders the list; the group must not fold back up.
      await page.evaluate(() => window.setUnit('km'));
      await page.waitForTimeout(500);
      assert(await page.evaluate(() => document.querySelector('.soc-dormant').open),
        'the group closed itself on a re-render');
      await page.evaluate(() => window.setUnit('mi'));
      await page.waitForTimeout(400);

      await page.click('.soc-dormant > summary');
      await page.waitForTimeout(300);
      assert(!(await page.evaluate(() => document.querySelector('.soc-dormant').open)), 'the toggle does not close');
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(400);
    });

    await check('the distance-per-week hero sits under the hours one and adds up', async () => {
      await page.evaluate(() => { window.setYear('All'); window.setType('All'); window.setUnit('mi'); window.setTab('summary'); });
      await page.waitForTimeout(800);

      const r = await page.evaluate(() => {
        const heroes = [...document.querySelectorAll('.sum-hero')];
        const hours = document.getElementById('sumWeekHours');
        const dist = document.getElementById('sumWeekDist');
        if (!hours || !dist) return null;
        const keys = [...document.querySelectorAll('#sumDistSplit .split-key span')].map((e) => e.innerText);
        const widths = [...document.querySelectorAll('#sumDistSplit .split-bar span')]
          .map((e) => parseFloat(e.style.width));
        return {
          order: heroes.indexOf(hours.closest('.sum-hero')) < heroes.indexOf(dist.closest('.sum-hero')),
          hoursText: hours.innerText.replace(/\s+/g, ' '),
          distText: dist.innerText.replace(/\s+/g, ' '),
          unit: document.getElementById('sumWeekDistUnit').textContent,
          base: document.getElementById('sumDistBase').textContent,
          chips: [...document.querySelectorAll('#sumDistChips .chart-chip')].map((e) => e.innerText.replace(/\s+/g, ' ')),
          verdict: document.getElementById('sumDistVerdict').textContent,
          keys, widths,
          chart: !!(typeof charts !== 'undefined' && charts.sumdist),
        };
      });
      assert(r, 'the distance hero did not render');
      assert(r.order, 'the distance hero is not below the hours one');
      assert(/miles/.test(r.distText) && r.unit === 'miles', `figure reads "${r.distText}"`);
      assert(!/—/.test(r.distText), 'the figure is still a placeholder');
      // The base is the same slice of the preceding four weeks, not a whole-week
      // average — a part-week held against a whole one reads as a shortfall every
      // week of the year, which is noise dressed up as a warning.
      assert(/\bmi\b/.test(r.base) && /by this point in an average week|average week over the last four/.test(r.base),
        `base line reads "${r.base}"`);
      assert(r.chips.length === 4, `${r.chips.length} chips`);
      assert(r.verdict.length > 0, 'no verdict');
      assert(r.chart, 'no distance chart instance');

      // The split is the calendar week, by sport, as shares of one total. How many
      // sports that comes to depends on what day it is — a Monday can honestly be
      // one — so this checks the split against the week itself rather than against
      // a fixed count that would pass or fail by the day it was run.
      const week = await page.evaluate(() => {
        const today = _today(), start = weekStartISO(today);
        const by = {};
        ALL_DATA.filter((a) => a.date >= start && a.date <= today)
          .forEach((a) => { const g = typeGroup(a.type); by[g] = (by[g] || 0) + actDistIn(a); });
        return Object.entries(by).filter(([, d]) => d > 0)
          .sort((x, y) => y[1] - x[1]).map(([g]) => g);
      });
      assert(r.keys.length === week.length,
        `split shows ${r.keys.length} sports, the calendar week has ${week.length}`);
      week.forEach((g, i) => assert(new RegExp(g, 'i').test(r.keys[i]),
        `split key ${i} reads "${r.keys[i]}", expected ${g}`));
      if (week.length) {
        const sum = r.widths.reduce((a, b) => a + b, 0);
        assert(Math.abs(sum - 100) < 0.5, `split bar widths sum to ${sum.toFixed(2)}%, not 100`);
        // Sorted biggest first, so the bar reads left to right.
        for (let i = 1; i < r.widths.length; i++) {
          assert(r.widths[i] <= r.widths[i - 1] + 0.01, 'split is not sorted by size');
        }
      }
    });

    await check('"this week" is the calendar week, not the last seven days', async () => {
      await page.evaluate(() => { window.setYear('All'); window.setType('All'); window.setUnit('mi'); window.setTab('summary'); });
      await page.waitForTimeout(800);

      const r = await page.evaluate(() => {
        const today = _today();
        const start = weekStartISO(today);
        const sum = (from) => ALL_DATA
          .filter((a) => a.date >= from && a.date <= today)
          .reduce((s, a) => s + (a.mt || 0) / 3600, 0);
        const d = new Date(new Date(today + 'T12:00:00').getTime() - 6 * 86400000);
        const sevenAgo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return {
          start,
          weekday: new Date(start + 'T12:00:00').getDay(),
          shown: parseFloat(document.getElementById('sumWeekHours').innerText),
          week: sum(start),
          seven: sum(sevenAgo),
          label: (document.querySelector('[data-panel="sum-load"] .stat-label') || {}).textContent || '',
        };
      });

      assert(r.weekday === 1, `the week starts on weekday ${r.weekday}, not Monday`);
      assert(/This week/i.test(r.label), `the figure is labelled "${r.label}"`);
      // The figure has to be Monday-to-today. On a Monday with nothing logged that
      // means zero, however full the seven days behind it were.
      assert(Math.abs(r.shown - r.week) < 0.05,
        `hero reads ${r.shown}h, calendar week is ${r.week.toFixed(2)}h (last seven days: ${r.seven.toFixed(2)}h)`);
    });

    await check('the distance hero follows the unit toggle', async () => {
      const read = () => page.evaluate(() => ({
        unit: document.getElementById('sumWeekDistUnit').textContent,
        fig: parseFloat(document.getElementById('sumWeekDist').innerText),
        sub: document.getElementById('sumDistSub').textContent,
        key: (document.querySelector('#sumDistSplit .split-key span') || {}).innerText || '',
      }));
      await page.evaluate(() => window.setUnit('mi'));
      await page.waitForTimeout(600);
      const mi = await read();
      await page.evaluate(() => window.setUnit('km'));
      await page.waitForTimeout(600);
      const km = await read();

      assert(km.unit === 'km' && mi.unit === 'miles', `units are ${mi.unit}/${km.unit}`);
      assert(/Kilometres per week/.test(km.sub), `km subtitle reads "${km.sub}"`);
      assert(/Miles per week/.test(mi.sub), `mi subtitle reads "${mi.sub}"`);
      // Same week, bigger number in km — the conversion has to reach the figure,
      // the axis and the per-sport split alike.
      assert(km.fig > mi.fig * 1.5, `${mi.fig} mi became ${km.fig} km`);
      assert(/km/.test(km.key) && /mi/.test(mi.key), `split key reads "${km.key}" in km mode`);
      await page.evaluate(() => window.setUnit('mi'));
      await page.waitForTimeout(500);
    });

    await check('the gear photo runs to the top and both sides of its card', async () => {
      await page.evaluate(() => window.setTab('gear'));
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const card = document.querySelector('.gear-card');
        if (!card) return null;
        // Either a real photo or the fallback tile that replaces it on a 404 —
        // both occupy the same slot and both should bleed.
        const ph = card.querySelector('.gear-photo, .gear-icon-tile');
        if (!ph) return null;
        const c = card.getBoundingClientRect(), i = ph.getBoundingClientRect();
        const cs = getComputedStyle(card);
        const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth),
              br = parseFloat(cs.borderRightWidth);
        return {
          top: i.top - (c.top + bt),
          left: i.left - (c.left + bl),
          right: (c.right - br) - i.right,
          padded: parseFloat(cs.paddingLeft),
        };
      });
      assert(r, 'no gear card to measure');
      assert(r.padded > 0, 'the card has no padding, so this proves nothing');
      for (const side of ['top', 'left', 'right']) {
        assert(Math.abs(r[side]) < 1, `${side} gap is ${r[side].toFixed(1)}px, not flush`);
      }
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(300);
    });

    await check('every clickable row can be reached and opened from the keyboard', async () => {
      // Each of these is a div or a tr with a delegated click handler. A pointer
      // could open all four; a keyboard could open none of them.
      const cases = [
        { tab: 'log',    sel: '#logBody .act-row-click', opens: '#actModalBackdrop.open', close: 'Escape' },
        { tab: 'social', sel: '.soc-tbl > .soc-row',     opens: '#gearModalBackdrop.open, .soc-modal, #actModalBackdrop.open', close: 'Escape' },
        { tab: 'gear',   sel: '.gear-card',              opens: '#gearModalBackdrop.open', close: 'Escape' },
      ];
      for (const c of cases) {
        await page.evaluate((t) => window.setTab(t), c.tab);
        await page.waitForTimeout(600);
        const meta = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.focus();
          return {
            focused: document.activeElement === el,
            tabindex: el.getAttribute('tabindex'),
            role: el.getAttribute('role'),
            label: (el.getAttribute('aria-label') || '').trim(),
          };
        }, c.sel);
        assert(meta, `${c.tab}: nothing matched ${c.sel}`);
        assert(meta.tabindex === '0', `${c.tab}: tabindex is ${meta.tabindex}`);
        assert(meta.role === 'button', `${c.tab}: role is ${meta.role}`);
        assert(meta.label.length > 0, `${c.tab}: no aria-label, so a screen reader hears the whole row`);
        assert(meta.focused, `${c.tab}: the row would not take focus`);

        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        assert(await page.locator(c.opens).count(), `${c.tab}: Enter did not open anything`);
        await page.keyboard.press(c.close);
        await page.waitForTimeout(350);
      }

      // Location pills carry an inline onclick rather than going through
      // delegation, which is why the handler dispatches a click rather than
      // calling an opener.
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(500);
      const pill = await page.evaluate(() => {
        const el = document.querySelector('.loc-pill');
        return el ? { tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') } : null;
      });
      if (pill) {
        assert(pill.tabindex === '0' && pill.role === 'button',
          `location pill is tabindex=${pill.tabindex} role=${pill.role}`);
      }
    });

    await check('calendar days are reachable by keyboard without 1,800 tab stops', async () => {
      // They were divs with an onclick: a pointer could open any of ~1,800 day cells
      // and a keyboard could open none. The naive fix is worse than the bug — a tab
      // stop on every cell traps anyone tabbing through the page for the afternoon —
      // so this is the grid pattern: one stop per calendar, arrows move within it.
      await page.evaluate(() => window.setTab('heatmap'));
      await page.waitForTimeout(800);

      const stops = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('#tab-heatmap [data-day-tip]')]
          .filter((c) => c.offsetParent !== null);
        return { total: cells.length, tabbable: cells.filter((c) => c.tabIndex === 0).length };
      });
      assert(stops.total > 100, `only ${stops.total} day cells found — the calendar did not render`);
      assert(stops.tabbable > 0, 'no day cell is reachable by keyboard at all');
      assert(stops.tabbable < 10,
        `${stops.tabbable} of ${stops.total} cells are tab stops — that is the trap, not the fix`);

      // Arrow keys walk the grid and move the single tab stop with them.
      const first = await page.evaluate(() => {
        const c = [...document.querySelectorAll('#tab-heatmap [data-day-tip]')]
          .filter((x) => x.offsetParent !== null && x.tabIndex === 0)[0];
        c.focus();
        return c.dataset.dayTip;
      });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(120);
      const moved = await page.evaluate(() => document.activeElement.dataset.dayTip);
      assert(moved && moved !== first, `ArrowRight left focus on ${moved}`);
      // One stop PER GRID, not per tab: the Heatmap draws a desktop strip, a mobile
      // layout and a disclosure per prior year, and each should remember its own place.
      const perGrid = await page.evaluate(() => {
        const focused = document.activeElement.closest('[role="grid"]');
        const cells = [...focused.querySelectorAll('[data-day-tip]')].filter((c) => c.offsetParent !== null);
        return {
          stops: cells.filter((c) => c.tabIndex === 0).length,
          onFocused: document.activeElement.tabIndex,
        };
      });
      assert(perGrid.stops === 1, `the focused grid has ${perGrid.stops} tab stops, not one`);
      assert(perGrid.onFocused === 0, 'the tab stop did not rove with the focus');

      // A week is a row, so down is seven days.
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(120);
      const down = await page.evaluate(() => document.activeElement.dataset.dayTip);
      const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
      assert(days(moved, down) === 7, `ArrowDown moved ${days(moved, down)} days, not a week`);

      // Enter opens the day, the way a click does.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      assert(await page.evaluate(() => {
        const d = document.getElementById('heatmapDayDetail');
        return d && d.style.display !== 'none' && d.innerHTML.trim().length > 0;
      }), 'Enter on a focused day opened nothing');

      // And each cell says what it is, rather than being an unlabelled box.
      const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
      assert(label && /\d{4}|January|February|March|April|May|June|July|August|September|October|November|December/.test(label),
        `a day cell announces itself as "${label}"`);
    });

    await check('sport and standing colours follow the theme', async () => {
      const read = () => page.evaluate(() => ({
        ride: groupColor('Ride'),
        soft: groupSoft('Ride'),
        lapsed: palette().standing.Lapsed.join(','),
      }));
      await page.evaluate(() => window.applyTheme('light'));
      await page.waitForTimeout(300);
      const light = await read();
      await page.evaluate(() => window.applyTheme('dark'));
      await page.waitForTimeout(300);
      const dark = await read();

      for (const k of ['ride', 'soft', 'lapsed']) {
        assert(light[k] && dark[k], `${k} resolved to nothing`);
        assert(light[k] !== dark[k], `${k} is the same in both themes (${light[k]}) — still pinned to one palette`);
      }
      // The soft background is what a fallback gear tile and a standing chip are
      // painted with; in dark mode it must actually be dark.
      const lum = (c) => { const n = c.match(/\d+/g).map(Number); return (n[0] + n[1] + n[2]) / 3; };
      const darkSoft = await page.evaluate(() => {
        const d = document.createElement('div');
        d.style.background = groupSoft('Ride');
        document.body.appendChild(d);
        const c = getComputedStyle(d).backgroundColor;
        d.remove();
        return c;
      });
      assert(lum(darkSoft) < 90, `dark-mode soft background is ${darkSoft}, still a daylight colour`);
      await page.evaluate(() => window.applyTheme('system'));
      await page.waitForTimeout(300);
    });

    await check('a collapsed disclosure actually hides its content', async () => {
      // The prior-year heatmaps are the case that was broken: their content carries
      // an explicit display, which a closed <details> does not reliably suppress, so
      // collapsing a year left its heatmap on the page and the toggle did nothing.
      await page.evaluate(() => window.setTab('heatmap'));
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const d = document.querySelector('details.hm-prior');
        if (!d) return null;
        d.open = true;
        const openH = [...d.children].filter((c) => c.tagName !== 'SUMMARY')
          .reduce((s, c) => s + c.getBoundingClientRect().height, 0);
        d.open = false;
        const shutH = [...d.children].filter((c) => c.tagName !== 'SUMMARY')
          .reduce((s, c) => s + c.getBoundingClientRect().height, 0);
        d.open = true;
        return { openH, shutH };
      });
      assert(r, 'no prior-year disclosure to test');
      assert(r.openH > 0, 'the disclosure has no content when open');
      assert(r.shutH === 0, `closed disclosure still renders ${r.shutH}px of content`);
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(400);
    });

    await check('the page never scrolls sideways, and the header lines up with the cards', async () => {
      // A card on an inactive tab is display:none and measures 0 — take the one on
      // whichever panel is actually showing.
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(400);
      for (const [w, h] of [[390, 844], [768, 900], [1280, 900], [1440, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(350);
        const r = await page.evaluate(() => {
          const hi = document.querySelector('.header-inner');
          const card = document.querySelector('.tab-content.active .chart-card');
          return {
            over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            headerLeft: hi.getBoundingClientRect().left + parseFloat(getComputedStyle(hi).paddingLeft),
            cardLeft: card.getBoundingClientRect().left,
            gutter: card.getBoundingClientRect().left,
          };
        });
        // The tab strip scrolls on its own; the document must not.
        assert(r.over <= 0, `${w}px: document is ${r.over}px wider than the viewport`);
        assert(Math.abs(r.headerLeft - r.cardLeft) < 2,
          `${w}px: header starts at ${r.headerLeft} but cards at ${r.cardLeft}`);
        assert(r.gutter >= 12, `${w}px: only ${r.gutter}px of side gutter`);
      }
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(300);
    });

    await check('section explanations sit under the title, unboxed and light', async () => {
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const hdr = [...document.querySelectorAll('.section-header')]
          .find((h) => h.querySelector('.badge') && h.querySelector('.badge').textContent.trim());
        if (!hdr) return null;
        const h2 = hdr.querySelector('h2').getBoundingClientRect();
        const badge = hdr.querySelector('.badge');
        const b = badge.getBoundingClientRect();
        const cs = getComputedStyle(badge);
        return {
          below: b.top >= h2.bottom - 1,
          alignedLeft: Math.abs(b.left - h2.left) < 2,
          border: cs.borderTopWidth,
          bg: cs.backgroundColor,
          text: badge.textContent.trim(),
        };
      });
      assert(r, 'no section header with an explanation found');
      assert(r.below, 'the explanation is still beside the title, not under it');
      assert(r.alignedLeft, 'the explanation does not line up with the title');
      assert(r.border === '0px', `the explanation still has a ${r.border} border`);
      assert(/rgba\(0, 0, 0, 0\)|transparent/.test(r.bg), `the explanation still has a ${r.bg} box`);
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(300);
    });

    await check('the brand tile, scope chip and settings button are one height', async () => {
      for (const [w, h] of [[390, 844], [1280, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(350);
        const boxes = await page.evaluate(() =>
          ['.logo-icon', '.scope-chip', '.settings-btn']
            .map((sel) => {
              const e = document.querySelector(sel);
              if (!e || getComputedStyle(e).display === 'none') return null;
              const r = e.getBoundingClientRect();
              return { sel, h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
            })
            .filter(Boolean));
        assert(boxes.length >= 2, `${w}px: only ${boxes.length} header control visible`);
        const hs = [...new Set(boxes.map((b) => b.h))];
        assert(hs.length === 1, `${w}px: heights are ${JSON.stringify(boxes.map((b) => [b.sel, b.h]))}`);
        // Equal heights are not enough — they have to sit on the same line too.
        assert([...new Set(boxes.map((b) => b.top))].length === 1, `${w}px: tops differ`);
        assert([...new Set(boxes.map((b) => b.bottom))].length === 1, `${w}px: bottoms differ`);
        // The phone row must still clear the touch-target minimum the rest of the
        // phone styles enforce.
        if (w === 390) assert(hs[0] >= 40, `${w}px: controls are only ${hs[0]}px tall`);
      }
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(300);
    });

    await check('the header carries one control, not a row of them', async () => {
      const n = await page.evaluate(() =>
        document.querySelectorAll('.header-toolbar > *').length);
      assert(n === 1, `header toolbar holds ${n} controls`);
      assert(await page.locator('#settingsBtn').isVisible(), 'no settings button');
      assert(!(await page.locator('#settingsMenu.open').count()), 'menu starts open');
    });

    await check('the settings menu opens, closes and reports its state', async () => {
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open', { timeout: 3000 });
      assert((await page.getAttribute('#settingsBtn', 'aria-expanded')) === 'true', 'aria-expanded not set');
      assert(await page.locator('#settingsBackdrop.open').count(), 'no backdrop');
      // Anchored to the button rather than floating at the viewport edge.
      const { menu, btn } = await page.evaluate(() => ({
        menu: document.getElementById('settingsMenu').getBoundingClientRect().right,
        btn: document.getElementById('settingsBtn').getBoundingClientRect().right,
      }));
      assert(Math.abs(menu - btn) < 40, `menu right edge ${menu} vs button ${btn}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      assert(!(await page.locator('#settingsMenu.open').count()), 'Escape did not close it');
      assert((await page.getAttribute('#settingsBtn', 'aria-expanded')) === 'false', 'aria-expanded stuck');
    });

    await check('units and theme are both set from that one menu', async () => {
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');

      await page.click('#settingsUnits button[data-unit="km"]');
      await page.waitForTimeout(400);
      assert((await page.evaluate(() => unit)) === 'km', 'unit did not change');
      assert(await page.locator('#settingsUnits button[data-unit="km"].active').count(), 'km chip not marked active');

      await page.click('#settingsTheme button[data-theme-opt="dark"]');
      await page.waitForTimeout(400);
      assert((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'theme did not change');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      assert((r + g + b) / 3 < 60, `dark body background is ${bg}`);

      // All three states are offered, not hidden behind a cycling button.
      const opts = await page.evaluate(() =>
        [...document.querySelectorAll('#settingsTheme button')].map((b) => b.dataset.themeOpt));
      assert(opts.join(',') === 'system,light,dark', `theme options are ${opts}`);
      assert(
        (await page.locator('#settingsTheme button.active').count()) === 1,
        'more or less than one theme marked active'
      );

      await page.click('#settingsTheme button[data-theme-opt="system"]');
      await page.evaluate(() => window.setUnit('mi'));
      await page.click('#settingsBackdrop');
      await page.waitForTimeout(250);
      assert(!(await page.locator('#settingsMenu.open').count()), 'clicking the backdrop did not close it');
    });

    await check('refresh and the profile link live in the menu too', async () => {
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');
      assert(await page.locator('#settingsMenu #refreshBtn').count(), 'no refresh row');
      const note = await page.locator('#settingsUpdated').innerText();
      assert(note.trim().length, 'refresh row shows no last-updated time');
      const href = await page.getAttribute('#settingsMenu a[target="_blank"]', 'href');
      assert(/strava\.com/.test(href), `profile link is ${href}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    });

    await check('the menu becomes a bottom sheet on a phone', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');
      // The sheet slides up over 140ms; measuring mid-animation reads its
      // transform, not its resting position.
      await page.waitForTimeout(400);
      const box = await page.evaluate(() => {
        const r = document.getElementById('settingsMenu').getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight };
      });
      assert(box.left <= 1 && Math.abs(box.right - box.w) <= 1, `sheet is not full width: ${JSON.stringify(box)}`);
      assert(Math.abs(box.bottom - box.h) <= 1, 'sheet is not pinned to the bottom');
      assert(await page.locator('.settings-done').isVisible(), 'no Done button on the sheet');
      await page.click('.settings-done');
      await page.waitForTimeout(250);
      assert(!(await page.locator('#settingsMenu.open').count()), 'Done did not close the sheet');
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(200);
    });

    // ── Reordering the charts ───────────────────────────────────────────────
    const chartOrder = () => page.evaluate(() =>
      [...document.querySelectorAll('#tab-charts .chart-zone')].map((z) => ({
        zone: z.dataset.zone,
        cards: [...z.children].filter((c) => c.dataset.panel).map((c) => c.dataset.panel),
      })));
    const flatOrder = async () => (await chartOrder()).flatMap((z) => z.cards);
    // Rearranging acts on the tab you are looking at, so get there first.
    const enterReorder = async (tab = 'charts') => {
      await page.evaluate((t) => window.setTab(t), tab);
      await page.waitForTimeout(350);
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');
      await page.click('#reorderChartsBtn');
      await page.waitForSelector(`#tab-${tab}.reordering`, { timeout: 3000 });
      await page.waitForTimeout(250);
    };

    await check('the menu turns reordering on for the tab you are looking at', async () => {
      await enterReorder();
      assert((await page.evaluate(() => activeTab)) === 'charts', 'left the charts tab');
      assert(!(await page.locator('#settingsMenu.open').count()), 'the menu stayed open behind it');
      assert(await page.locator('#reorderBar').isVisible(), 'no reorder bar');
      // The point of the mode: every chart on one or two screens rather than five.
      const h = await page.evaluate(() =>
        document.querySelector('#tab-charts .chart-card[data-panel]').getBoundingClientRect().height);
      assert(h > 30 && h < 80, `a collapsed card is ${Math.round(h)}px tall`);
      assert((await page.evaluate(() => getComputedStyle(
        document.querySelector('#tab-charts .chart-card[data-panel] .chart-wrap')).display)) === 'none',
        'the canvas is still laid out');
    });

    await check('a chart can be walked down the list, across a section boundary', async () => {
      const before = await flatOrder();
      const last = (await chartOrder())[0].cards.slice(-1)[0];   // last card in Volume
      await page.evaluate((k) => document.querySelector(
        `#tab-charts .chart-card[data-panel="${k}"] .reorder-move[data-dir="1"]`).click(), last);
      const o = await chartOrder();
      assert(o.find((z) => z.cards.includes(last)).zone === 'intensity',
        `${last} did not cross into Intensity: ${JSON.stringify(o)}`);
      assert((await flatOrder()).length === before.length, 'a chart went missing');
      // The ends of the list say so rather than silently doing nothing.
      assert(await page.evaluate(() => document.querySelector(
        '#tab-charts .chart-card[data-panel] .reorder-move[data-dir="-1"]').disabled),
        'the first card offers to move earlier');
    });

    await check('dragging a chart with a pointer moves it to where it was dropped', async () => {
      const at = (k) => page.evaluate((kk) => {
        const r = document.querySelector(`#tab-charts .chart-card[data-panel="${kk}"]`).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.y };
      }, k);
      const first = (await flatOrder())[0];
      const moving = (await chartOrder())[0].cards.slice(-1)[0];
      const from = await at(moving), to = await at(first);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y - 20, { steps: 3 });   // past the drag threshold
      await page.mouse.move(to.x, to.top + 2, { steps: 20 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert((await flatOrder())[0] === moving,
        `dropped on the first slot but the list starts ${(await flatOrder()).slice(0, 3)}`);
    });

    await check('the order is saved, survives a reload, and Reset undoes it', async () => {
      const before = await chartOrder();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.classList.contains('is-loading'), { timeout: 15000 });
      assert(JSON.stringify(await chartOrder()) === JSON.stringify(before), 'the saved order did not come back');

      await enterReorder();
      await page.click('#reorderResetBtn');
      await page.waitForTimeout(150);
      const o = await flatOrder();
      assert(o[0] === 'load' && o[1] === 'cum', `Reset left the list as ${o.slice(0, 3)}`);
      assert(await page.evaluate(() => localStorage.getItem('fitness_chart_order_v1') === null),
        'Reset left a saved order behind');
      assert(await page.evaluate(() => document.getElementById('reorderResetBtn').disabled),
        'Reset is still offered with nothing to reset');
    });

    await check('arrow keys move a focused chart and the move is announced', async () => {
      const before = await flatOrder();
      await page.evaluate((k) => document.querySelector(
        `#tab-charts .chart-card[data-panel="${k}"]`).focus(), before[0]);
      await page.keyboard.press('ArrowDown');
      const after = await flatOrder();
      assert(after[1] === before[0], `${before.slice(0, 3)} -> ${after.slice(0, 3)}`);
      const said = await page.evaluate(() => document.getElementById('reorderLive').textContent);
      assert(/position \d+ of \d+/.test(said), `announcement was "${said}"`);
    });

    await check('a move is sent to the Worker, so every other device picks it up', async () => {
      // Still in reorder mode from the check above. The push runs a second behind
      // the last move, so the request is awaited rather than looked for.
      const before = await flatOrder();
      const put = page.waitForRequest((r) => r.method() === 'PUT' && /\/prefs\b/.test(r.url()), { timeout: 5000 });
      await page.evaluate((k) => document.querySelector(
        `#tab-charts .chart-card[data-panel="${k}"]`).focus(), before[0]);
      await page.keyboard.press('ArrowDown');
      const body = (await put).postDataJSON();
      assert(body && body.prefs && body.prefs.layout && typeof body.prefs.layout === 'object',
        `PUT body was ${JSON.stringify(body).slice(0, 120)}`);
      assert(Number(body.updatedAt) > 0,
        'the record carries no stamp, so the Worker could not tell which device is newer');
      assert(Object.values(body.prefs.layout).some((z) => Array.isArray(z) && z.includes(before[0])),
        'the chart that was just moved is not in the layout that went up');
    });

    await check('a chart the current filter hides can still be placed', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.evaluate(() => window.setType('Ride'));
      await page.waitForTimeout(300);
      assert((await page.evaluate(() =>
        getComputedStyle(document.getElementById('donutChartCard')).display)) === 'none',
        'Activity Mix is meant to be hidden for a single sport');
      await enterReorder();
      assert((await page.evaluate(() =>
        getComputedStyle(document.getElementById('donutChartCard')).display)) !== 'none',
        'a filtered-out chart is unreachable in reorder mode');
      await page.evaluate(() => window.setType('All'));
      await page.waitForTimeout(200);
    });

    await check('leaving the mode brings the charts back at full size', async () => {
      await page.click('.reorder-done');
      await page.waitForTimeout(400);
      assert(!(await page.locator('#tab-charts.reordering').count()), 'still in reorder mode');
      assert(await page.locator('#reorderBar').isHidden(), 'the bar is still on screen');
      const h = await page.evaluate(() =>
        document.querySelector('#tab-charts .chart-card[data-panel]').getBoundingClientRect().height);
      assert(h > 200, `a card came back only ${Math.round(h)}px tall`);
      // And it does not follow you onto another tab.
      await enterReorder();
      await page.click('#tabbtn-heatmap');
      await page.waitForTimeout(300);
      assert(await page.locator('#reorderBar').isHidden(), 'the bar survived a tab change');
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(300);
    });

    /* Done has to mean done. The grip, the panel label and the two arrow buttons are
     * injected into every panel on the way in, and leaving the mode used only to drop
     * the `reordering` class — which is what hides the panel's real contents, not what
     * shows the scaffolding. So the grips and arrows stayed on screen afterwards, and
     * piled up: rearrange one tab, then another, and the first tab's set was still
     * there underneath. Checked across every tab that can be rearranged, because the
     * tabs that re-render themselves on the way out were accidentally clearing their
     * own and hiding how general this was. */
    await check('pressing Done removes the grips and arrows, on every tab', async () => {
      const REORDERABLE = ['summary', 'charts', 'records', 'mex', 'social', 'gear'];
      for (const t of REORDERABLE) {
        await page.evaluate((x) => window.setTab(x), t);
        await page.waitForTimeout(350);
        // Bare identifiers on purpose: reorderOn is a top-level `let`, which makes a
        // lexical binding and not a property of window, so window.reorderOn is undefined.
        const on = await page.evaluate(() => { startReorder(); return reorderOn; });
        assert(on, `${t} would not enter reorder mode`);
        await page.waitForTimeout(350);
        // It is meant to be there while the mode is on — otherwise this proves nothing.
        const during = await page.evaluate(() => document.querySelectorAll('.reorder-grip').length);
        assert(during > 0, `${t} showed no grips while reordering`);

        await page.click('.reorder-done');
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => {
          const all = [...document.querySelectorAll('.reorder-grip,.reorder-name,.reorder-ctl')];
          const visible = all.filter((e) => e.getClientRects().length > 0);
          return {
            inDom: all.length,
            visible: visible.length,
            what: visible.slice(0, 2).map((e) => e.className),
            stillFocusable: document.querySelectorAll('[data-panel][aria-roledescription]').length,
          };
        });
        assert(after.visible === 0,
          `${t}: ${after.visible} grips/arrows still on screen after Done ${JSON.stringify(after.what)}`);
        assert(after.inDom === 0, `${t}: ${after.inDom} left in the DOM after Done`);
        assert(after.stillFocusable === 0,
          `${t}: ${after.stillFocusable} panels still announce themselves as reorderable`);
      }
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(300);
    });

    await check('and the mode still works on the way back in', async () => {
      // Removing the scaffolding must not stop it being rebuilt — the controls carry
      // their own click listeners, so they are rebuilt rather than re-shown.
      await enterReorder();
      const grips = await page.evaluate(() => document.querySelectorAll('#tab-charts .reorder-grip').length);
      assert(grips > 0, 'no grips came back on a second run through');
      const moved = await page.evaluate(() => {
        const first = document.querySelector('#tab-charts [data-panel]');
        const name = first.dataset.panel;
        first.querySelector('.reorder-ctl .reorder-move[data-dir="1"]').click();
        return { name, nowFirst: document.querySelector('#tab-charts [data-panel]').dataset.panel };
      });
      assert(moved.name !== moved.nowFirst, 'a rebuilt arrow button did nothing when pressed');
      await page.click('.reorder-done');
      await page.waitForTimeout(500);
    });

    await check('any tab with more than one panel can be rearranged, not just Charts', async () => {
      // The tab element itself can be the zone, so it has to be in the list too.
      const panelsOn = (tab) => page.evaluate((t) => {
        const el = document.getElementById('tab-' + t);
        const zones = [...el.querySelectorAll('[data-zone]')];
        if (el.dataset.zone) zones.unshift(el);
        return zones.flatMap((z) => [...z.children].filter((c) => c.dataset.panel).map((c) => c.dataset.panel));
      }, tab);

      for (const tab of ['summary', 'records', 'social', 'gear']) {
        const p = await panelsOn(tab);
        assert(p.length > 1, `${tab} exposes ${p.length} panel(s): ${p}`);
      }

      // Summary is the one with the most boxes, so it is the one worth driving.
      await enterReorder('summary');
      const before = await panelsOn('summary');
      await page.evaluate((k) => document.querySelector(
        `#tab-summary [data-panel="${k}"] .reorder-move[data-dir="1"]`).click(), before[0]);
      const after = await panelsOn('summary');
      assert(after[0] === before[1] && after[1] === before[0],
        `${before.slice(0, 3)} -> ${after.slice(0, 3)}`);
      assert(after.length === before.length, 'a panel went missing');

      // Saved per zone, so rearranging Summary must not disturb Charts.
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fitness_layout_v1') || '{}'));
      assert(Array.isArray(saved.summary), `no summary order saved: ${JSON.stringify(saved)}`);
      assert(saved.summary[0] === after[0], 'the saved summary order does not match the page');

      // And it survives a reload the same way the charts do.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.classList.contains('is-loading'), { timeout: 15000 });
      await page.evaluate(() => window.setTab('summary'));
      await page.waitForTimeout(300);
      assert((await panelsOn('summary')).join() === after.join(), 'the summary order did not come back');
    });

    await check('a tab that is one thing says so rather than doing nothing', async () => {
      // Heatmap is a single calendar; there is no arrangement of one box, and a
      // pressed button that silently does nothing is worse than a sentence.
      await page.evaluate(() => window.setTab('heatmap'));
      await page.waitForTimeout(300);
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');
      assert(await page.evaluate(() => document.getElementById('reorderChartsBtn').disabled),
        'the rearrange row is offered on a tab with nothing to rearrange');
      const note = await page.evaluate(() => document.getElementById('reorderBtnNote').textContent);
      assert(/nothing/i.test(note), `the row says "${note}"`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      assert(!(await page.locator('#tab-heatmap.reordering').count()), 'it entered reorder mode anyway');
    });

    await check('the rearrange row names the tab it would act on', async () => {
      await page.evaluate(() => window.setTab('records'));
      await page.waitForTimeout(300);
      await page.click('#settingsBtn');
      await page.waitForSelector('#settingsMenu.open');
      assert(!(await page.evaluate(() => document.getElementById('reorderChartsBtn').disabled)),
        'Records has panels but the row is disabled');
      const note = await page.evaluate(() => document.getElementById('reorderBtnNote').textContent);
      assert(/records/i.test(note), `the row says "${note}" rather than naming Records`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    });

    await check('reordering fits a phone without a sideways scroll', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await enterReorder();
      const r = await page.evaluate(() => {
        const de = document.documentElement;
        const bar = document.getElementById('reorderBar').getBoundingClientRect();
        return {
          over: de.scrollWidth - de.clientWidth,
          cols: getComputedStyle(document.querySelector('#tab-charts .chart-zone'))
            .gridTemplateColumns.split(' ').length,
          barBottom: bar.bottom, h: window.innerHeight,
        };
      });
      // One order, two layouts: the grid collapses to a column and the same list reads
      // top to bottom. An icon font that has not arrived must not widen a card either.
      assert(r.over <= 0, `the document is ${r.over}px wider than the phone`);
      assert(r.cols === 1, `the grid is still ${r.cols} columns`);
      assert(Math.abs(r.barBottom - r.h) < 2, 'the bar is not pinned to the bottom');
      await page.click('.reorder-done');
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(250);
    });

    await ctx.close();
  }

  // ── 2. The Worker answers 500 ───────────────────────────────────────────────
  {
    const { ctx, page } = await open({ apiStatus: 500, apiBody: { error: 'kv unavailable' } });
    await check('a 500 surfaces an error card instead of hanging on "Syncing…"', async () => {
      await page.waitForSelector('#appError.show', { timeout: 15000 });
      const msg = await page.locator('#appErrorMsg').innerText();
      assert(/500/.test(msg), `error text does not name the status: "${msg}"`);
      assert(!(await page.locator('body.is-loading').count()), 'skeleton left shimmering after a failure');
      assert(await page.locator('#appErrorRetry').isVisible(), 'no retry button');
    });
    await ctx.close();
  }

  // ── 3. A 200 with a malformed envelope ──────────────────────────────────────
  {
    const { ctx, page } = await open({ apiBody: { aiSummary: 'oops', updatedAt: 'now' } });
    await check('a 200 with no data array is reported, not thrown into the void', async () => {
      await page.waitForSelector('#appError.show', { timeout: 15000 });
      assert(!(await page.locator('body.is-loading').count()), 'skeleton left shimmering');
    });
    await ctx.close();
  }

  // ── 4. Network failure with nothing cached ──────────────────────────────────
  {
    const { ctx, page } = await open({ offline: true });
    await check('a dead network with no cache shows an error rather than a blank page', async () => {
      await page.waitForSelector('#appError.show', { timeout: 15000 });
      assert(!(await page.locator('body.is-loading').count()), 'skeleton left shimmering');
    });
    await ctx.close();
  }

  // ── 5. Network failure with a warm cache ────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
    await page.route(/fonts\.g(oogleapis|static)\.com/, (r) => r.abort());
    await page.route(/nominatim\.openstreetmap\.org/, (r) => r.abort());

    let fail = false;
    await page.route('**/activities**', (r) =>
      fail ? r.abort('failed')
           : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ENVELOPE) })
    );
    await page.route('**/zwift-routes**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );
    // This page loads the app too, and the app pulls its panel order at boot.
    await page.route('**/prefs**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: {}, updatedAt: 0 }) })
    );

    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.classList.contains('is-loading'), null, { timeout: 20000 });

    await check('every successful pull rewrites the on-device fallback', async () => {
      const cached = () => page.evaluate(() => {
        const raw = localStorage.getItem('fitness_dashboard_v1');
        if (!raw) return null;
        const p = JSON.parse(raw);
        return { n: p.data.length, updatedAt: p.updatedAt, partial: p.partial || null };
      });
      const first = await cached();
      assert(first, 'the first successful load cached nothing');
      assert(first.n === ENVELOPE.data.length, `cached ${first.n} of ${ENVELOPE.data.length} activities`);
      assert(!first.partial, `a history this size should fit whole, got "${first.partial}"`);

      // A later pull brings one more activity and a newer timestamp. The device copy
      // has to move with it — a fallback that is only ever written once is a fallback
      // that is out of date by definition.
      const later = {
        ...ENVELOPE,
        data: [...ENVELOPE.data, { ...ENVELOPE.data[0], id: 999999, name: 'Brand new ride' }],
        updatedAt: new Date(Date.now() + 60000).toISOString(),
      };
      await page.unroute('**/activities**');
      await page.route('**/activities**', (r) =>
        fail ? r.abort('failed')
             : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(later) }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.classList.contains('is-loading'), null, { timeout: 20000 });
      await page.waitForTimeout(400);

      const second = await cached();
      assert(second.n === later.data.length, `fallback still holds ${second.n}, not ${later.data.length}`);
      assert(second.updatedAt === later.updatedAt, 'the cached timestamp did not move with the data');

      // And the newer copy is what a dead network then falls back to.
      fail = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#appError.show.inline', { timeout: 15000 });
      const n = await page.evaluate(() => ALL_DATA.length);
      assert(n === later.data.length, `offline page fell back to ${n} activities, not ${later.data.length}`);
      fail = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.classList.contains('is-loading'), null, { timeout: 20000 });
    });

    await check('a failed refresh keeps the cached page and says so inline', async () => {
      fail = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#appError.show.inline', { timeout: 15000 });
      const hero = (await page.locator('#sumWeekHours').innerText()).trim();
      assert(hero && hero !== '—', 'cached data was not rendered');
      const lu = await page.locator('#lastUpdated').innerText();
      assert(/offline/i.test(lu), `last-updated does not mention offline: "${lu}"`);
    });
    await ctx.close();
  }

  // ── 5b. Closing a readout on a touchscreen ──────────────────────────────────
  // A touchscreen has no mouseout, so a tapped tooltip used to stay on top of the
  // plot for good. The subtlety is what a browser does AFTER a tap: it synthesises
  // mouseover, mousemove, mousedown, mouseup and click, and a chart library that
  // listens for mousemove and click will reopen a tooltip a few milliseconds after
  // it was closed. Stopping the click alone is not enough — this is the check that
  // says so.
  {
    const { ctx, page, errors } = await open({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const cdp = await ctx.newCDPSession(page);
    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(220);
    };

    await check('tapping a chart twice in the same place closes its readout', async () => {
      await page.evaluate(() => window.setTab('charts'));
      await page.waitForTimeout(600);
      const open_ = () => page.evaluate(() => {
        const c = window.Chart.getChart(document.getElementById('chartLoad'));
        return !!(c && c.tooltip.opacity > 0);
      });
      const at = async (frac) => {
        await page.evaluate(() => document.getElementById('chartLoad')
          .scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(200);
        return page.evaluate((f) => {
          const r = document.getElementById('chartLoad').getBoundingClientRect();
          return { x: r.x + r.width * f, y: r.y + r.height / 2 };
        }, frac);
      };

      assert(!(await open_()), 'a readout was open before anything was tapped');
      const a = await at(0.35);
      await tap(a.x, a.y);
      assert(await open_(), 'tapping the chart did not open a readout');
      await tap(a.x, a.y);
      assert(!(await open_()), 'tapping the same point again did not close it');
      await tap(a.x, a.y);
      assert(await open_(), 'a third tap did not open it again');

      // A different point moves the readout rather than closing it — "tap again to
      // dismiss" must not degrade into "one point per visit".
      const b = await at(0.75);
      await tap(b.x, b.y);
      assert(await open_(), 'tapping a different point closed the readout instead of moving it');
      await tap(b.x, b.y);
      assert(!(await open_()), 'the new point would not close on a repeat tap');

      // And a tap anywhere off the plot clears whatever is open.
      await tap(a.x, a.y);
      assert(await open_(), 'could not reopen for the tap-away case');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await tap(12, 300);
      assert(!(await open_()), 'tapping away from the chart left the readout on screen');
    });

    await check('tapping a calendar day twice closes its readout too', async () => {
      await page.evaluate(() => window.setTab('heatmap'));
      await page.waitForTimeout(700);
      const dash = () => page.evaluate(() => {
        const el = document.getElementById('dashTooltip');
        return { shown: el.style.display === 'block', date: el.dataset.date || null };
      });
      // Only days the readout will actually fill: it bails on a day with nothing in
      // the current scope, which would read as a broken toggle rather than an empty one.
      const days = await page.evaluate(() => {
        const cs = [...document.querySelectorAll('[data-day-tip]')].filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && window.getFiltered().some((a) => a.date === c.dataset.dayTip);
        });
        const pick = (c) => {
          const r = c.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, d: c.dataset.dayTip };
        };
        return cs.length > 60 ? [pick(cs[10]), pick(cs[60])] : null;
      });
      assert(days, 'no calendar days with activities to tap');
      const [d1, d2] = days;

      await tap(d1.x, d1.y);
      assert((await dash()).shown, 'tapping a day showed nothing');
      await tap(d1.x, d1.y);
      assert(!(await dash()).shown, 'tapping the same day again did not close it');
      await tap(d1.x, d1.y);
      // The emulated mouseenter does not fire again on a day the pointer never left,
      // so reopening has to come from the tap itself.
      assert((await dash()).shown, 'a third tap on the same day did not reopen it');
      await tap(d2.x, d2.y);
      const moved = await dash();
      assert(moved.shown && moved.date === d2.d, `tapping another day gave ${JSON.stringify(moved)}`);
      await tap(6, 320);
      assert(!(await dash()).shown, 'tapping off the calendar left the readout up');
    });

    await check('none of that logged an error', async () => {
      assert(errors.length === 0, errors.join(' | '));
    });
    await ctx.close();
  }

  // ── 6. Installability ───────────────────────────────────────────────────────
  {
    const { ctx, page } = await open({ skipLibs: true, serviceWorkers: 'allow' });
    await check('ships a valid manifest', async () => {
      const href = await page.evaluate(() => {
        const l = document.querySelector('link[rel="manifest"]');
        return l && l.href;
      });
      assert(href, 'no manifest link');
      const res = await page.request.get(href);
      assert(res.ok(), `manifest returned ${res.status()}`);
      const m = await res.json();
      assert(m.name && m.short_name, 'manifest has no name');
      assert(m.start_url, 'manifest has no start_url');
      assert(m.display === 'standalone', `manifest display is ${m.display}`);
      const sizes = (m.icons || []).map((i) => i.sizes);
      assert(sizes.includes('192x192') && sizes.includes('512x512'), `icons are ${JSON.stringify(sizes)}`);
      assert((m.icons || []).some((i) => i.purpose === 'maskable'), 'no maskable icon');
    });

    await check('registers a service worker that caches the app shell', async () => {
      const ready = await page.evaluate(() =>
        navigator.serviceWorker
          ? navigator.serviceWorker.ready.then(() => true).catch(() => false)
          : false
      );
      assert(ready, 'service worker never reached ready');
      // Give install() a moment to populate the caches it opened.
      await page.waitForTimeout(1500);
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const out = [];
        for (const n of names) {
          const keys = await (await caches.open(n)).keys();
          out.push(...keys.map((k) => new URL(k.url).pathname));
        }
        return out;
      });
      assert(cached.includes('/index.html'), `index.html not cached (have ${JSON.stringify(cached)})`);
      assert(cached.includes('/calc.js'), 'calc.js not cached');
      assert(cached.some((p) => p.startsWith('/icons/')), 'no icons cached');
    });

    await check('serves the shell from cache when the network dies', async () => {
      await ctx.setOffline(true);
      const res = await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      assert(res, 'no response at all while offline');
      const title = await page.title();
      assert(/Fitness/.test(title), `offline page title is "${title}"`);
      await ctx.setOffline(false);
    });

    await ctx.close();
  }

  /* ── 7. The policy, and the wiring it depends on ──────────────────────────────
   *
   * Every scenario above ran with the real _headers applied, so a policy that broke
   * the page would already have failed one of them. What none of them prove is that
   * the policy was ever sent — delete _headers and they all still pass. The first
   * check closes that.
   *
   * The rest are about the delegated actions the policy is built on. The markup names
   * a handler and its arguments in attributes now, and the shape of that wiring is not
   * something the language checks: a name can be misspelled, an arguments attribute can
   * hold text that is not JSON, and either way nothing happens until somebody clicks it
   * and gets nothing. All three had actually shipped — a handler naming a function that
   * was never written, and four buttons whose arguments were unparseable — so these
   * check the whole DOM rather than any one control.
   */
  {
    const { ctx, page } = await open();

    await check('the deployment sends a content security policy, with no inline script', async () => {
      const res = await page.request.get(base + '/index.html');
      const csp = res.headers()['content-security-policy'];
      assert(csp, 'no Content-Security-Policy header was sent at all');
      const script = (csp.match(/(?:^|;)\s*script-src\s+([^;]+)/) || [])[1] || '';
      assert(!/'unsafe-inline'/.test(script), `script-src allows inline: ${script}`);
      assert(!/'unsafe-eval'/.test(script), `script-src allows eval: ${script}`);
      assert(/'sha256-/.test(script), 'script-src names no hash for the theme stamp');
      for (const d of ['frame-ancestors', 'base-uri', 'object-src']) {
        assert(new RegExp(`${d}\\s+'none'`).test(csp), `${d} is not shut`);
      }
    });

    // Visit every tab so the markup each one builds is in the document to be checked.
    for (const t of ['summary', 'charts', 'heatmap', 'records', 'mex', 'social', 'gear', 'log']) {
      await page.evaluate((x) => setTab(x), t);
      await page.waitForTimeout(250);
    }

    const EVENTS = ['click', 'input', 'change', 'mouseenter', 'mouseleave', 'toggle', 'error'];
    const wiring = await page.evaluate((evs) => {
      const key = (p, e) => p + e[0].toUpperCase() + e.slice(1);
      const named = new Set(), badArgs = [], orphans = [];
      for (const ev of evs) {
        for (const el of document.querySelectorAll(`[data-on-${ev}]`)) named.add(el.dataset[key('on', ev)]);
        for (const el of document.querySelectorAll(`[data-args-${ev}]`)) {
          const raw = el.dataset[key('args', ev)];
          if (!el.dataset[key('on', ev)]) orphans.push(el.outerHTML.slice(0, 90));
          try {
            if (!Array.isArray(JSON.parse(raw))) badArgs.push(raw);
          } catch (e) { badArgs.push(raw); }
        }
      }
      return {
        count: named.size,
        missing: [...named].filter((n) => typeof ACTIONS[n] !== 'function'),
        badArgs, orphans,
      };
    }, EVENTS);

    await check('every action the markup names actually exists', async () => {
      assert(wiring.count > 20, `only ${wiring.count} actions found — did the sweep run?`);
      assert(wiring.missing.length === 0,
        `named but not registered: ${JSON.stringify(wiring.missing)}`);
    });

    await check('every action argument is parseable JSON, not a string that looks like it', async () => {
      assert(wiring.badArgs.length === 0, `unparseable: ${JSON.stringify(wiring.badArgs.slice(0, 4))}`);
      assert(wiring.orphans.length === 0, `arguments with no action: ${JSON.stringify(wiring.orphans.slice(0, 3))}`);
    });

    await check('a name that is not in the table does nothing, rather than something', async () => {
      const result = await page.evaluate(() => {
        const b = document.createElement('button');
        b.dataset.onClick = 'thisIsNotAnAction';
        document.body.appendChild(b);
        let threw = false;
        try { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
        catch (e) { threw = true; }
        b.remove();
        return { threw, stillThere: typeof window.thisIsNotAnAction };
      });
      assert(!result.threw, 'an unknown action threw instead of being ignored');
      assert(result.stillThere === 'undefined', 'the dispatcher resolved a name off window');
    });

    // A gear or activity name arrives from Strava and lands inside a single-quoted
    // attribute. The apostrophe in one used to end that attribute early.
    await check('a name with an apostrophe stays inside its attribute', async () => {
      const out = await page.evaluate(() => {
        const host = document.createElement('div');
        const name = "Dave's' onclick=alert(1) x='";
        host.innerHTML = `<button data-on-click="openGearFromActivity" ` +
          `data-args-click='${escapeAttr(JSON.stringify([name]))}'>x</button>`;
        const b = host.firstElementChild;
        // Parsed in here, but not allowed to throw in here: an escaping failure breaks
        // the JSON, and an exception inside evaluate reports as a harness error rather
        // than as this check failing for the reason it exists.
        let parsed = null, parseError = null;
        try { parsed = JSON.parse(b.dataset.argsClick || ''); }
        catch (e) { parseError = e.message; }
        return { attrs: b.getAttributeNames(), raw: b.dataset.argsClick, parsed, parseError, name };
      });
      assert(out.attrs.length === 2,
        `the attribute leaked and made ${out.attrs.length}: ${JSON.stringify(out.attrs)}`);
      assert(!out.parseError, `argument no longer parses (${out.parseError}) — raw was ${out.raw}`);
      assert(out.parsed[0] === out.name, `argument came back as ${JSON.stringify(out.parsed[0])}`);
    });

    /* Two handlers that the audit above cannot reach, because the markup carrying them
     * only exists after an interaction — and both were broken. The year calendar named
     * a function nobody had written, so every click on a day threw; and "This gear"
     * inside an activity modal read a lookup table that only the Gear tab filled in, so
     * it did nothing at all until you had visited that tab. */
    await check('a day on the year calendar opens, and closes on a second click', async () => {
      const year = await page.evaluate(() => [...new Set(ALL_DATA.map((a) => a.date.slice(0, 4)))].sort().pop());
      await page.evaluate((y) => { setTab('charts'); setYear(y); }, year);
      await page.waitForTimeout(900);
      const day = await page.evaluate(() => {
        const days = new Set(getFiltered().map((a) => a.date));
        const cell = [...document.querySelectorAll('.year-cal-cell[data-day-tip]')]
          .find((e) => days.has(e.dataset.dayTip));
        return cell ? cell.dataset.dayTip : null;
      });
      assert(day, 'the year calendar rendered no day with an activity on it');
      const state = () => page.evaluate(() => {
        const d = document.getElementById('yearCalDayDetail');
        return { shown: d.style.display === 'block', len: d.innerHTML.length };
      });
      const tap = () => page.evaluate((d) => document.querySelector(`.year-cal-cell[data-day-tip="${d}"]`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true })), day);
      await tap(); await page.waitForTimeout(250);
      const open = await state();
      assert(open.shown && open.len > 0, `clicking ${day} showed nothing`);
      await tap(); await page.waitForTimeout(250);
      assert(!(await state()).shown, 'a second click left the day detail up');
    });

    await check('"This gear" works without having visited the Gear tab first', async () => {
      // A fresh page on purpose: GEAR_DATA is empty until something fills it, and the
      // point of the check is that opening a gear modal is what fills it.
      const { ctx: c2, page: p2 } = await open();
      await p2.evaluate(() => setTab('log'));
      await p2.waitForTimeout(700);
      await p2.evaluate(() => {
        const row = document.querySelector('[data-act]');
        if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await p2.waitForTimeout(400);
      assert(await p2.evaluate(() => document.getElementById('actModalBackdrop').classList.contains('open')),
        'the activity row did not open its modal');
      const hasBtn = await p2.evaluate(() => {
        const b = document.querySelector('#actModal [data-on-click="openGearFromActivity"]');
        if (!b) return false;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      });
      assert(hasBtn, 'the activity modal offered no gear hand-off');
      await p2.waitForTimeout(400);
      assert(await p2.evaluate(() => document.getElementById('gearModalBackdrop').classList.contains('open')),
        'the gear modal never opened — GEAR_DATA was empty and nothing filled it');
      await c2.close();
    });

    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\nBrowser smoke test\n' + results.join('\n'));
  console.log(failed ? `\n${failed} check(s) failed\n` : `\nAll ${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
