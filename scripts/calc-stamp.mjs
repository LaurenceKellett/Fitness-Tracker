// The stamp index.html carries on its calc.js request: the first eight hex digits of a
// SHA-1 of the file, line endings normalised so a CRLF checkout on Windows and the LF
// copy Pages serves agree on it. Shared by `npm run stamp` and the test that checks it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function calcStamp(root) {
  const src = readFileSync(path.join(root, 'calc.js'), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha1').update(src).digest('hex').slice(0, 8);
}

export const STAMP_RE = /<script src="calc\.js\?v=([0-9a-f]{8})"><\/script>/;
