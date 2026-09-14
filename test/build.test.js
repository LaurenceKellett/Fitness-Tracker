import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcStamp, STAMP_RE } from '../scripts/calc-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One deploy served a new index.html against a cached older calc.js, and the page died
// on a function the old file did not have. The page now names the exact calc.js it was
// written against; this is what keeps the name honest. Edit calc.js, run
// `npm run stamp`, or this fails.
describe('index.html and calc.js ship as a pair', () => {
  it('asks for the calc.js it was written against', () => {
    const html = readFileSync(path.join(root, 'index.html'), 'utf8');
    const m = STAMP_RE.exec(html);
    expect(m, 'index.html has no stamped calc.js tag').not.toBeNull();
    expect(m[1], 'the stamp is stale — run `npm run stamp`').toBe(calcStamp(root));
  });
});
