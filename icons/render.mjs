// Renders the PNG app icons from the mark's geometry, so they cannot drift from the
// SVG. Run from the repo root after changing icons/icon.svg:
//   node icons/render.mjs
//
// The mark is "Signal": an ink tile and one square of accent. The PNGs are the ink
// version whatever the theme — a home-screen icon sits on wallpaper, not on the page.
// The maskable icon pulls the square in toward the centre so it survives a circular
// mask: the safe zone is a circle of 80% diameter, and the standard placement's outer
// corner sits outside it.
import { chromium } from 'playwright';

const html = (s, maskable) => {
  const k = s / 512;
  const sq = maskable ? { x: 256 * k, y: 256 * k, w: 102 * k } : { x: 287 * k, y: 287 * k, w: 143 * k };
  return `<!doctype html><html><body style="margin:0;background:#121214">` +
    `<div style="position:relative;width:${s}px;height:${s}px;background:#121214">` +
    `<div style="position:absolute;left:${sq.x}px;top:${sq.y}px;width:${sq.w}px;height:${sq.w}px;background:#ff385c"></div></div></body></html>`;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
for (const [file, s, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  await page.setContent(html(s, maskable));
  await page.screenshot({ path: 'icons/' + file, clip: { x: 0, y: 0, width: s, height: s } });
  console.log('wrote icons/' + file);
}
await browser.close();
