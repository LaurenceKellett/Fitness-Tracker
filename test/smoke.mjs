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
  for (let i = 0; i < 420; i++) {
    const d = new Date(today.getTime() - i * 36e5 * 20);
    const iso = d.toISOString().slice(0, 10);
    const type = sports[i % sports.length];
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
          : (i > 300 && i % 7 === 0) ? `Evening ${type} w/ Nige`
          : `${type} session ${i}`,
      dist_mi: +(2 + (i % 40) * 0.9).toFixed(2),
      dist_km: +((2 + (i % 40) * 0.9) * 1.60934).toFixed(2),
      mt: 1800 + (i % 20) * 600,
      et: 1900 + (i % 20) * 600,
      elv: (i % 30) * 40,
      hr: 120 + (i % 40),
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
  }
  update() { window.__stubChartUpdates++; }
  destroy() { this._destroyed = true; }
  resize() {}
};
window.Chart.defaults = { color: '#000', borderColor: '#eee', font: { family: '' } };
window.Chart.register = function () {};
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
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
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
  // over whatever build this Playwright version would download.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );

  // One page per scenario, each with its own console-error collector.
  async function open({ apiStatus = 200, apiBody = ENVELOPE, offline = false, skipLibs = false,
                        serviceWorkers = 'block' } = {}) {
    // Service workers are blocked by default here. Once one is active it serves the
    // CDN requests itself, and a service worker's own fetches do not pass through
    // page.route() — so the library stubs below would be bypassed and the test
    // would be measuring the network, not this page. The worker gets its own
    // scenario at the end, where it is the subject rather than an interference.
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers });
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

    // Chart.js and Leaflet are served as stubs rather than fetched from their CDNs.
    // What is under test here is the dashboard's own lifecycle — that the libraries
    // are fetched on demand rather than up front, that a filter change updates the
    // existing charts instead of rebuilding them, that the map mounts when its tab
    // opens. None of that is a test of Chart.js or Leaflet, and pulling 350 KB over
    // the network would only make the suite slower and able to fail for reasons
    // that have nothing to do with this repo.
    if (!skipLibs) {
      await page.route(/chart\.umd\.min\.js/, (r) =>
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

    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.classList.contains('is-loading'), null, { timeout: 20000 });

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
