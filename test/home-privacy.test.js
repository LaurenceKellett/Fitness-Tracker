// How much of a route is cut away near home.
//
// There are two radii and they are not the same thing. "snap" hides the
// published start point, which is one coarse coordinate and costs nothing
// to keep generous. "draw" decides how much of the line disappears, and it
// is the one you see: the gap at each end of every route on the day's
// picture.
//
// They used to be the same quarter mile, 402 m. That is invisible on a long
// run and ruinous on a dog walk: a short loop that never gets more than a
// few hundred metres from the door had every one of its points inside the
// zone, so the whole walk was dropped and the day drew no line at all.
//
// The helpers are not exported — worker.js is a Worker entry point, not a
// library — so they are lifted out by source. Taking the text means a
// rename or a deletion fails here loudly, rather than quietly testing a
// function that no longer exists.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'worker.js'), 'utf8');

const from = src.indexOf('const SNAP_MILES');
const end = src.indexOf('\n}', src.indexOf('function splitPolylineExcludingZones'));
if (from < 0 || end < 0) throw new Error('the home-privacy helpers were renamed or removed');
const block = src.slice(from, end + 2);

const P = new Function(block + `
  return { SNAP_MILES, DEFAULT_DRAW_M, METRES_PER_MILE, drawMiles, homeZones,
           geoDistMiles, nearHome, decodePolyline, encodePolyline,
           splitPolylineExcludingZones };`)();

const HOME = { lat: 53.0, lng: -2.0 };
const envWith = over => ({ HOME_LAT_1: String(HOME.lat), HOME_LNG_1: String(HOME.lng), ...over });

// A point n metres from home on a given bearing.
function at(metres, deg) {
  const r = deg * Math.PI / 180;
  return [
    HOME.lat + (metres * Math.cos(r)) / 111320,
    HOME.lng + (metres * Math.sin(r)) / (111320 * Math.cos(HOME.lat * Math.PI / 180)),
  ];
}
const line = pts => P.encodePolyline(pts);
const kept = (pts, zones) =>
  P.splitPolylineExcludingZones(line(pts), zones)
    .reduce((n, s) => n + P.decodePolyline(s).length, 0);

describe('the two radii', () => {
  it('cuts 200 m of route by default, not 402', () => {
    const z = P.homeZones(envWith())[0];
    expect(Math.round(z.draw * P.METRES_PER_MILE)).toBe(200);
  });

  it('still hides the published start point at a quarter mile', () => {
    const z = P.homeZones(envWith())[0];
    expect(z.snap).toBe(0.25);
  });

  it('a walk starting 300 m away is drawn from there but still reports home', () => {
    const zones = P.homeZones(envWith());
    const [lat, lng] = at(300, 0);
    // Outside the draw radius, so the line is kept...
    expect(P.nearHome(lat, lng, zones, 'draw')).toBe(false);
    // ...and inside the snap radius, so the start point is still masked.
    expect(P.nearHome(lat, lng, zones, 'snap')).toBe(true);
  });

  it('reads the radius from the project setting', () => {
    const z = P.homeZones(envWith({ HOME_EXCLUSION_M: '200' }))[0];
    expect(Math.round(z.draw * P.METRES_PER_MILE)).toBe(200);
  });

  // A typo that parsed as zero would put the line back on the doorstep; a
  // huge one would quietly delete every route. Both fall back instead.
  it.each([['0', 'zero'], ['', 'empty'], ['abc', 'not a number'], ['999999', 'absurdly large'], [undefined, 'unset']])
    ('ignores a radius of %s (%s) and uses the default', value => {
      const z = P.homeZones(envWith({ HOME_EXCLUSION_M: value }))[0];
      expect(Math.round(z.draw * P.METRES_PER_MILE)).toBe(200);
    });
});

describe('a short dog walk near the house', () => {
  // The case that prompted this: a loop that never gets more than ~350 m
  // from the door. Every point of it sat inside the old 402 m zone.
  const loop = Array.from({ length: 48 }, (_, i) => at(330, i * 7.5));

  it('used to vanish completely at the old quarter mile', () => {
    const old = P.homeZones(envWith()).map(z => ({ ...z, draw: 0.25 }));
    expect(kept(loop, old)).toBe(0);
  });

  it('now survives whole', () => {
    const zones = P.homeZones(envWith());
    expect(kept(loop, zones)).toBe(loop.length);
  });

  it('and is still one unbroken line, not a handful of stubs', () => {
    const zones = P.homeZones(envWith());
    expect(P.splitPolylineExcludingZones(line(loop), zones)).toHaveLength(1);
  });
});

describe('the house itself is never on the line', () => {
  // Out from the door, away, and back again.
  const outAndBack = [
    ...Array.from({ length: 30 }, (_, i) => at(i * 40, 20)),
    ...Array.from({ length: 30 }, (_, i) => at((29 - i) * 40, 50)),
  ];

  it('drops every point inside the radius, at either end', () => {
    const zones = P.homeZones(envWith());
    for (const seg of P.splitPolylineExcludingZones(line(outAndBack), zones)) {
      for (const [lat, lng] of P.decodePolyline(seg)) {
        const m = P.geoDistMiles(lat, lng, HOME.lat, HOME.lng) * P.METRES_PER_MILE;
        // A metre of slack for the polyline's own 1e5 rounding.
        expect(m).toBeGreaterThan(199);
      }
    }
  });

  it('keeps more of the walk than the old radius did', () => {
    const zones = P.homeZones(envWith());
    const old = zones.map(z => ({ ...z, draw: 0.25 }));
    expect(kept(outAndBack, zones)).toBeGreaterThan(kept(outAndBack, old));
  });

  // An out-and-back only comes near home at its two ends, so what is left
  // is one line. The middle of it joins the outward leg to the return,
  // which is right: the walk really was continuous out there.
  it('is one line, not two, when it only touches home at the ends', () => {
    const zones = P.homeZones(envWith());
    expect(P.splitPolylineExcludingZones(line(outAndBack), zones)).toHaveLength(1);
  });

  // A route that genuinely returns to the door in the middle and sets off
  // again must not be drawn as one line through the house.
  it('splits where a route passes the door mid-walk', () => {
    const zones = P.homeZones(envWith());
    const there = Array.from({ length: 20 }, (_, i) => at(i * 50, 20));
    const back = Array.from({ length: 20 }, (_, i) => at((19 - i) * 50, 40));
    const again = Array.from({ length: 20 }, (_, i) => at(i * 50, 200));
    const segs = P.splitPolylineExcludingZones(line([...there, ...back, ...again]), zones);
    expect(segs).toHaveLength(2);
  });
});

// The two radii are only worth having if each call site asks for the right
// one, and transformActivity is a hundred lines of Strava-shaped mapping
// that cannot be lifted out of worker.js the way the helpers above can. So
// these read the call sites from the source. Swapping either one is a
// silent change — the start point quietly stops being masked, or every
// route goes back to losing 402 m — and a mutation run proved nothing else
// here catches it.
describe('each call site asks for the radius it means', () => {
  it('masks the published start point with the snap radius', () => {
    expect(src).toMatch(/nearHome\(rawLat, rawLng, zones, "snap"\)/);
    expect(src).not.toMatch(/nearHome\(rawLat, rawLng, zones, "draw"\)/);
  });

  it('cuts the drawn route with the draw radius', () => {
    expect(src).toMatch(/nearHome\(lat, lng, zones, "draw"\)/);
    expect(src).not.toMatch(/nearHome\(lat, lng, zones, "snap"\)/);
  });

  it('has no call left that does not say which radius it wants', () => {
    // The declaration itself is not a call — everything else is.
    const calls = (src.match(/(?<!function )\bnearHome\([^)]*\)/g) || []);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toMatch(/, "(snap|draw)"\)$/);
  });
});

describe('with no home set', () => {
  it('there are no zones and nothing is cut', () => {
    expect(P.homeZones({})).toHaveLength(0);
    expect(P.homeZones(null)).toHaveLength(0);
  });
});
