/* The policy in _headers, checked against the page it is supposed to describe.
 *
 * A CSP is the kind of thing that is correct on the day it is written and quietly wrong
 * six months later, because it lives in a file nobody opens and describes a page that
 * keeps changing. Two failures are worth catching automatically:
 *
 *   1. The inline script's hash drifting. Edit the theme stamp by one character and the
 *      browser refuses to run it — silently, with no console error the user would see,
 *      and the page loads in the wrong palette on every visit.
 *   2. 'unsafe-inline' reappearing in script-src. That is the whole policy switched off
 *      in one word, and it is exactly what someone adds under time pressure to make a
 *      new inline handler work.
 *
 * The browser-level check — that the page actually loads and runs under this policy —
 * is in test/smoke.mjs, which serves these headers for real.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineScripts, inlineScriptHashes } from './csp-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
const csp = (headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';

const directive = (name) => {
  const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`));
  return m ? m[1].trim().split(/\s+/) : null;
};

describe('the Content-Security-Policy in _headers', () => {
  it('is actually there', () => {
    expect(csp).not.toBe('');
  });

  it('allows the one inline script by its current hash', () => {
    const hashes = inlineScriptHashes();
    // If this fails after editing index.html's theme stamp, run:
    //   node test/csp-hash.mjs
    // and paste the value into _headers.
    expect(hashes).toHaveLength(1);
    expect(directive('script-src')).toContain(`'${hashes[0]}'`);
  });

  it('has no more inline scripts than it has hashes', () => {
    const hashed = (directive('script-src') || []).filter((s) => s.startsWith("'sha256-"));
    expect(inlineScripts()).toHaveLength(hashed.length);
  });

  it('never allows inline script wholesale, which would switch the policy off', () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
    // default-src is the fallback for anything not named, so it matters just as much.
    expect(directive('default-src')).not.toContain("'unsafe-inline'");
  });

  it('shuts the directives this app has no use for', () => {
    for (const d of ['frame-ancestors', 'base-uri', 'object-src', 'form-action']) {
      expect(directive(d)).toEqual(["'none'"]);
    }
  });

  it('permits every origin the page actually talks to', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
    const everywhere = [...directive('img-src'), ...directive('connect-src'),
      ...directive('font-src'), ...directive('style-src'), ...directive('script-src')];

    // Every external host in the source, minus the ones that are only ever a link the
    // user clicks — a navigation is not a fetch and no directive governs it.
    const NAVIGATION_ONLY = new Set(['www.strava.com', 'www.openstreetmap.org', 'www.w3.org']);
    const hosts = new Set();
    for (const src of [app, html, css]) {
      for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
    }
    // The map's tile URL is templated as {s}.tile.openstreetmap.org.
    if (/\{s\}\.tile\.openstreetmap\.org/.test(app)) hosts.add('a.tile.openstreetmap.org');

    for (const h of hosts) {
      if (NAVIGATION_ONLY.has(h)) continue;
      const allowed = everywhere.some((s) =>
        s === `https://${h}` ||
        (s.startsWith('https://*.') && h.endsWith(s.slice('https://*'.length))));
      expect(allowed, `${h} is fetched but no directive allows it`).toBe(true);
    }
  });
});
