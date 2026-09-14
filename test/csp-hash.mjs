/* The one script that has to stay inline, and its hash.
 *
 * index.html carries exactly one inline <script>: the four lines that stamp the saved
 * theme onto <html> before any stylesheet resolves. It cannot move into app.js —
 * anything deferred by even a tick paints the wrong palette first, which is the flash
 * the theme toggle exists to avoid. So the policy allows it by hash rather than by
 * 'unsafe-inline', which would allow every other inline script along with it.
 *
 * A hash is exact: change one character of that script and the browser refuses to run
 * it, silently, and the page loads in the wrong theme. test/csp.test.js recomputes it
 * from index.html and compares against _headers, so the drift is a failing test rather
 * than a bug someone notices months later in the dark.
 *
 * Exported as a module so the test, the smoke server and anything else share one
 * implementation of "what exactly is hashed" — the bytes between the tags, verbatim,
 * which is what the CSP spec hashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only scripts with no src attribute. A <script src="..."> has no body to hash.
const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScripts(html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) {
  return [...html.matchAll(INLINE)].map((m) => m[1]);
}

export function sha256(body) {
  return 'sha256-' + crypto.createHash('sha256').update(body, 'utf8').digest('base64');
}

export function inlineScriptHashes(html) {
  return inlineScripts(html).map(sha256);
}

// Run directly to print what belongs in _headers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hashes = inlineScriptHashes();
  console.log(`${hashes.length} inline script(s) in index.html`);
  hashes.forEach((h) => console.log(`  '${h}'`));
}
