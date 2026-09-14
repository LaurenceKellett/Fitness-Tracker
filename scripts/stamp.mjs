// Rewrites index.html's calc.js tag with the current stamp. Run after editing calc.js;
// `npm test` fails while the stamp is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcStamp, STAMP_RE } from './calc-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = calcStamp(root);
const file = path.join(root, 'index.html');
const html = readFileSync(file, 'utf8');
if (!STAMP_RE.test(html)) {
  console.error('index.html has no stamped calc.js tag (<script src="calc.js?v=…"></script>)');
  process.exit(1);
}
const out = html.replace(STAMP_RE, `<script src="calc.js?v=${stamp}"></script>`);
if (out === html) {
  console.log(`index.html already asks for calc.js?v=${stamp}`);
} else {
  writeFileSync(file, out);
  console.log(`index.html now asks for calc.js?v=${stamp}`);
}
