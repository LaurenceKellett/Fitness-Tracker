import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import calc from '../calc.js';

const {
  fmtDist, distUnit, fmtElv, fmtElevUnit, fmtElevVal, fmtTime, fmtSpeed, fmtPace, fmtDate,
  fmtNum, fmtCal, fmtPRTime, fmtHours, chipNum, artFor, escapeAttr, escapeHtml, typeGroup,
  mapTypeGroup, typeMatches, isFootSport, isRace, dayOfYear, daysBetween, monthsBetween,
  monthLabel, haversineMi, decodePolylinePts, gearKey, gearSlug, socCanon, socInitials,
  extractPartners, formatUpdatedAt, recLongestStreak, recCurrentStreak, mexBuckets, mexOf,
  actDistIn, distIn, todayISO, isYearScope, isRollingScope, periodStart,
  scopeIncludes, periodLabel, periodPhrase, isValidScope, rollingWeekly, ratioBand,
  CHRONIC_DAYS, CHRONIC_WEIGHTS, weeklyLoadStats, MONOTONY_CAP,
  yearEndProjection, projectionWindow, daysInYear, PROJ_WINDOW_MIN, PROJ_WINDOW_MAX,
  setScope,
} = calc;

const miles = () => setScope({ unit: 'mi' });
const km = () => setScope({ unit: 'km' });

beforeEach(() => setScope({ unit: 'mi', activeYear: 'All', activeType: 'All' }));

// ── UNIT CONVERSION ───────────────────────────────────────────────────────────
// Every figure on the page runs through one of these, and the mi/km toggle means
// each has two answers. A silent conversion bug is the kind this app could carry
// for months without anyone noticing.

describe('fmtDist', () => {
  it('keeps one decimal below 100 and drops it at or above', () => {
    miles();
    expect(fmtDist(12.34)).toBe('12.3');
    expect(fmtDist(99.94)).toBe('99.9');
    expect(fmtDist(100.4)).toBe('100');
  });

  it('converts to km when the unit is km', () => {
    km();
    expect(fmtDist(10)).toBe('16.1');
    // 62.14 mi is 100.0 km, which crosses the drop-the-decimal threshold in km
    // but not in miles — the threshold is applied after conversion, not before.
    expect(fmtDist(62.14)).toBe('100');
  });

  it('groups thousands', () => {
    miles();
    expect(fmtDist(12345)).toBe('12,345');
  });

  it('renders a dash for null, but not for zero', () => {
    expect(fmtDist(null)).toBe('—');
    expect(fmtDist(undefined)).toBe('—');
    expect(fmtDist(0)).toBe('0');
  });
});

describe('elevation', () => {
  it('reports feet in miles mode and metres in km mode', () => {
    miles();
    expect(fmtElv(1000)).toBe('1,000ft');
    expect(fmtElevUnit()).toBe('ft');
    expect(fmtElevVal(1000)).toBe(1000);
    km();
    expect(fmtElv(1000)).toBe('305m');
    expect(fmtElevUnit()).toBe('m');
    expect(fmtElevVal(1000)).toBeCloseTo(304.8, 5);
  });

  it('keeps a real zero and rejects only absent values', () => {
    miles();
    expect(fmtElv(0)).toBe('0ft');
    expect(fmtElv(null)).toBe('—');
  });
});

describe('fmtSpeed', () => {
  it('labels the unit it converted to', () => {
    miles();
    expect(fmtSpeed(15)).toBe('15.0 mph');
    km();
    expect(fmtSpeed(15)).toBe('24.1 km/h');
  });

  it('treats zero and negative speed as absent', () => {
    expect(fmtSpeed(0)).toBe('—');
    expect(fmtSpeed(-3)).toBe('—');
  });
});

describe('fmtPace', () => {
  it('formats minutes per mile', () => {
    miles();
    expect(fmtPace(480)).toBe('8:00/mi');
    expect(fmtPace(485)).toBe('8:05/mi');
  });

  it('converts to minutes per km, which is a smaller number', () => {
    km();
    expect(fmtPace(480)).toBe('4:58/km');
  });

  it('rejects paces slower than an hour a mile as bad data', () => {
    expect(fmtPace(3601)).toBe('—');
    expect(fmtPace(0)).toBe('—');
  });
});

describe('actDistIn / distIn', () => {
  it('prefers a supplied km distance over converting the mile one', () => {
    km();
    // Strava's own km figure, not dist_mi * 1.60934 — they differ in the last decimal
    expect(actDistIn({ dist_mi: 10, dist_km: 16.09 })).toBe(16.09);
    expect(actDistIn({ dist_mi: 10 })).toBeCloseTo(16.0934, 4);
  });

  it('falls back to zero for an activity with no distance', () => {
    miles();
    expect(actDistIn({})).toBe(0);
    expect(distIn({})).toBe(0);
  });
});

// ── TIME FORMATTING ───────────────────────────────────────────────────────────

describe('fmtTime', () => {
  it('drops the hour component under an hour', () => {
    expect(fmtTime(1800)).toBe('30m');
  });

  it('zero-pads minutes once hours appear', () => {
    expect(fmtTime(3660)).toBe('1h 01m');
    expect(fmtTime(7200)).toBe('2h 00m');
  });

  it('groups thousands of hours', () => {
    expect(fmtTime(3600 * 1234)).toBe('1,234h 00m');
  });

  it('treats zero as absent', () => {
    expect(fmtTime(0)).toBe('—');
  });
});

describe('fmtPRTime', () => {
  it('uses h:mm:ss over an hour and m:ss under it', () => {
    expect(fmtPRTime(3725)).toBe('1:02:05');
    expect(fmtPRTime(125)).toBe('2:05');
  });
});

describe('fmtHours', () => {
  it('switches from minutes to hours at an hour', () => {
    expect(fmtHours(1800)).toBe('30m');
    expect(fmtHours(3600)).toBe('1.0h');
  });

  it('drops the decimal at ten hours, where it stops earning its width', () => {
    expect(fmtHours(3600 * 9.5)).toBe('9.5h');
    expect(fmtHours(3600 * 12.4)).toBe('12h');
  });
});

describe('formatUpdatedAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('steps through the units as the gap widens', () => {
    expect(formatUpdatedAt('2026-09-13T11:59:30Z')).toBe('Updated just now');
    expect(formatUpdatedAt('2026-09-13T11:30:00Z')).toBe('Updated 30m ago');
    expect(formatUpdatedAt('2026-09-13T06:00:00Z')).toBe('Updated 6h ago');
    expect(formatUpdatedAt('2026-09-10T12:00:00Z')).toBe('Updated 3d ago');
  });

  it('returns an empty string rather than "Invalid Date" when nothing is known', () => {
    expect(formatUpdatedAt(null)).toBe('');
    expect(formatUpdatedAt(undefined)).toBe('');
  });
});

// ── DATES ─────────────────────────────────────────────────────────────────────

describe('dayOfYear', () => {
  it('is 1-indexed from January 1st', () => {
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-12-31')).toBe(365);
  });

  it('accounts for the leap day', () => {
    expect(dayOfYear('2024-03-01')).toBe(61);
    expect(dayOfYear('2023-03-01')).toBe(60);
    expect(dayOfYear('2024-12-31')).toBe(366);
  });

  it('is computed in UTC, so a BST date does not slide by one', () => {
    // Local-time arithmetic here would make a summer date off-by-one in the UK,
    // which is exactly the bug the cumulative-distance chart would show.
    expect(dayOfYear('2026-07-01')).toBe(182);
  });
});

describe('daysBetween', () => {
  it('counts inclusively', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(1);
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(31);
  });

  it('spans a DST boundary without losing the hour', () => {
    // 2026-03-29 is the UK clock change; a naive local-time subtraction rounds wrong.
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(3);
  });
});

describe('monthsBetween', () => {
  it('is inclusive of both ends and rolls the year over', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('returns a single month when both ends match', () => {
    expect(monthsBetween('2026-05', '2026-05')).toEqual(['2026-05']);
  });

  it('returns nothing when the range runs backwards', () => {
    expect(monthsBetween('2026-05', '2026-01')).toEqual([]);
  });
});

describe('fmtDate / monthLabel', () => {
  it('renders ISO dates in UK order', () => {
    expect(fmtDate('2026-09-13')).toBe('13/09/2026');
    expect(fmtDate(null)).toBe('—');
  });

  it('abbreviates a month key', () => {
    expect(monthLabel('2026-01')).toBe('Jan 26');
  });
});

// ── SPORT CLASSIFICATION ──────────────────────────────────────────────────────

describe('typeGroup', () => {
  it('separates virtual rides from outdoor ones', () => {
    expect(typeGroup('VirtualRide')).toBe('Virtual');
    expect(typeGroup('Ride')).toBe('Ride');
  });

  it('folds the ride and run variants into their group', () => {
    expect(typeGroup('EBikeRide')).toBe('Ride');
    expect(typeGroup('Velomobile')).toBe('Ride');
    expect(typeGroup('TrailRun')).toBe('Run');
  });

  it('counts only actual swims as swimming', () => {
    // Strava has one Swim type; pool, indoor and open water all arrive as this.
    expect(typeGroup('Swim')).toBe('Swim');
  });

  it('keeps the boats out of swimming', () => {
    // These used to group as Swim because they happen in water, which put paddled
    // distances into the Records tab as swimming bests.
    for (const boat of ['Kayaking', 'Canoeing', 'Rowing', 'StandUpPaddling',
                        'Surfing', 'Kitesurf', 'Windsurf', 'Sail']) {
      expect(typeGroup(boat)).toBe('Other');
    }
  });

  it('sends everything unrecognised to Other', () => {
    expect(typeGroup('WeightTraining')).toBe('Other');
    expect(typeGroup(undefined)).toBe('Other');
  });
});

describe('mapTypeGroup', () => {
  it('puts virtual rides back with rides, because the map colours by route', () => {
    expect(mapTypeGroup('VirtualRide')).toBe('Ride');
    expect(mapTypeGroup('EBikeRide')).toBe('Other');
  });
});

describe('typeMatches', () => {
  it('passes everything when no sport is selected', () => {
    setScope({ activeType: 'All' });
    expect(typeMatches({ type: 'WeightTraining' })).toBe(true);
  });

  it('counts virtual rides as rides, so "Ride" is not silently missing Zwift', () => {
    setScope({ activeType: 'Ride' });
    expect(typeMatches({ type: 'Ride' })).toBe(true);
    expect(typeMatches({ type: 'VirtualRide' })).toBe(true);
    expect(typeMatches({ type: 'Run' })).toBe(false);
  });

  it('matches other sports on their own group only', () => {
    setScope({ activeType: 'Run' });
    expect(typeMatches({ type: 'TrailRun' })).toBe(true);
    expect(typeMatches({ type: 'Walk' })).toBe(false);
  });
});

describe('isFootSport / isRace', () => {
  it('treats running and walking as foot sports', () => {
    expect(isFootSport('Run')).toBe(true);
    expect(isFootSport('Walk')).toBe(true);
    expect(isFootSport('Ride')).toBe(false);
  });

  it('recognises both of Strava’s race workout types', () => {
    expect(isRace({ wtype: 1 })).toBe(true);
    expect(isRace({ wtype: 11 })).toBe(true);
    expect(isRace({ wtype: 0 })).toBe(false);
    expect(isRace({})).toBe(false);
  });
});

// ── ESCAPING ──────────────────────────────────────────────────────────────────
// Both of these guard innerHTML, so they are the difference between a Strava
// activity called <img onerror=…> being text and being markup.

describe('escapeAttr', () => {
  it('neutralises the quote that would end a double-quoted attribute', () => {
    expect(escapeAttr('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('escapes ampersands first, so an entity is not double-decoded', () => {
    expect(escapeAttr('Tom & "Jerry"')).toBe('Tom &amp; &quot;Jerry&quot;');
    expect(escapeAttr('&quot;')).toBe('&amp;quot;');
  });

  it('coerces non-strings rather than throwing', () => {
    expect(escapeAttr(42)).toBe('42');
    expect(escapeAttr(null)).toBe('null');
  });
});

describe('escapeHtml', () => {
  it('defuses a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('escapes both quote characters and the ampersand', () => {
    expect(escapeHtml(`'"&`)).toBe('&#39;&quot;&amp;');
  });
});

// ── DERIVATIONS ───────────────────────────────────────────────────────────────

describe('decodePolylinePts', () => {
  it('decodes Google’s reference polyline', () => {
    const pts = decodePolylinePts('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(38.5, 5);
    expect(pts[0][1]).toBeCloseTo(-120.2, 5);
    expect(pts[2][0]).toBeCloseTo(43.252, 5);
    expect(pts[2][1]).toBeCloseTo(-126.453, 5);
  });

  it('returns nothing for an empty string', () => {
    expect(decodePolylinePts('')).toEqual([]);
  });
});

describe('haversineMi', () => {
  it('measures a known distance', () => {
    // Longridge to Preston, as the crow flies
    expect(haversineMi([53.8362, -2.5964], [53.7632, -2.7031])).toBeCloseTo(6.66, 2);
    // London to Edinburgh, a long enough leg to catch a bad earth radius
    expect(haversineMi([51.5, -0.12], [55.95, -3.19])).toBeCloseTo(332.0, 1);
  });

  it('is zero for a point against itself', () => {
    expect(haversineMi([53.8362, -2.5964], [53.8362, -2.5964])).toBe(0);
  });

  it('is symmetric', () => {
    const a = [51.5, -0.12], b = [55.95, -3.19];
    expect(haversineMi(a, b)).toBeCloseTo(haversineMi(b, a), 9);
  });
});

describe('mexBuckets / mexOf', () => {
  const acts = (...miles) => miles.map((m) => ({ dist_mi: m, type: 'Run' }));

  it('buckets on the whole-mile floor', () => {
    miles();
    const b = mexBuckets(acts(1.9, 2.0, 2.7));
    expect([...b.keys()].sort()).toEqual([1, 2]);
    expect(b.get(2).counts.Run).toBe(2);
  });

  it('ignores anything under a mile, which cannot fill a bucket', () => {
    miles();
    expect(mexBuckets(acts(0.9)).size).toBe(0);
  });

  it('is the last unbroken rung of the ladder', () => {
    expect(mexOf(new Map([[1, 1], [2, 1], [3, 1], [5, 1]]))).toBe(3);
  });

  it('is zero when the first rung is missing, however much else is there', () => {
    expect(mexOf(new Map([[2, 1], [3, 1], [4, 1]]))).toBe(0);
    expect(mexOf(new Map())).toBe(0);
  });

  it('re-buckets in km, so the score is unit-dependent by design', () => {
    km();
    // 1.9 mi is 3.06 km, so it lands in bucket 3 rather than bucket 1
    expect([...mexBuckets(acts(1.9)).keys()]).toEqual([3]);
  });
});

describe('recLongestStreak', () => {
  it('finds the longest run of consecutive days', () => {
    const s = recLongestStreak(
      ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05'].map((date) => ({ date }))
    );
    expect(s.len).toBe(3);
    expect(s.from).toBe('2026-01-01');
    expect(s.to).toBe('2026-01-03');
  });

  it('counts a day once however many activities it holds', () => {
    const s = recLongestStreak([
      { date: '2026-01-01' }, { date: '2026-01-01' }, { date: '2026-01-02' },
    ]);
    expect(s.len).toBe(2);
  });

  it('is unbothered by input order', () => {
    const s = recLongestStreak(
      ['2026-01-03', '2026-01-01', '2026-01-02'].map((date) => ({ date }))
    );
    expect(s.len).toBe(3);
  });

  it('marks a streak ending today as current, and an old one as not', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T18:00:00Z'));
    expect(recLongestStreak([{ date: '2026-09-12' }, { date: '2026-09-13' }]).current).toBe(true);
    expect(recLongestStreak([{ date: '2026-01-01' }, { date: '2026-01-02' }]).current).toBe(false);
    vi.useRealTimers();
  });

  it('returns null with nothing to measure', () => {
    expect(recLongestStreak([])).toBeNull();
  });
});

describe('recCurrentStreak', () => {
  const run = (from, len) => {
    const out = [];
    const d = new Date(from + 'T00:00:00Z');
    for (let i = 0; i < len; i++) {
      out.push({ date: d.toISOString().slice(0, 10) });
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out;
  };

  it('counts back from today', () => {
    expect(recCurrentStreak(run('2026-09-13', 5), '2026-09-13')).toBe(5);
  });

  it('still counts when today has not been logged yet', () => {
    // The whole point: at 09:55 you have not necessarily trained yet, and that is
    // not a broken streak.
    expect(recCurrentStreak(run('2026-09-12', 5), '2026-09-13')).toBe(5);
  });

  it('stops at the first real gap', () => {
    const acts = [...run('2026-09-13', 3), { date: '2026-09-08' }];
    expect(recCurrentStreak(acts, '2026-09-13')).toBe(3);
  });

  it('is zero once two days have been missed', () => {
    expect(recCurrentStreak(run('2026-09-11', 10), '2026-09-13')).toBe(0);
  });

  // The regression this function exists for: the loop it replaced carried an
  // `if(k>400)break` ceiling, so a 2,365-day streak reported 401 while the
  // longest-streak figure next to it reported 2,365.
  it('does not cap a long streak at 401 days', () => {
    expect(recCurrentStreak(run('2026-09-12', 2365), '2026-09-13')).toBe(2365);
  });

  it('agrees with recLongestStreak when the longest streak is the current one', () => {
    const acts = run('2026-09-12', 500);
    const longest = recLongestStreak(acts);
    expect(recCurrentStreak(acts, '2026-09-13')).toBe(longest.len);
  });

  it('counts a day once however many activities it holds', () => {
    const acts = [...run('2026-09-13', 3), { date: '2026-09-13' }, { date: '2026-09-12' }];
    expect(recCurrentStreak(acts, '2026-09-13')).toBe(3);
  });

  it('is zero with nothing logged', () => {
    expect(recCurrentStreak([], '2026-09-13')).toBe(0);
  });
});

// ── ROLLING WEEKLY SERIES ─────────────────────────────────────────────────────
// Both hero charts on the Summary tab are this function with a different `pick`.
// It replaced an inline copy inside renderLoad, so these also pin the behaviour
// that chart had before the extraction.

describe('rollingWeekly', () => {
  const hours = (a) => (a.mt || 0) / 3600;
  const dist = (a) => a.dist_mi || 0;
  const day = (from, n) => {
    const d = new Date(from + 'T12:00:00');
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('totals the trailing seven days into the acute series', () => {
    const acts = [0, 1, 2].map((n) => ({ date: day('2026-09-13', n), mt: 3600 }));
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    expect(r.latest.acute).toBe(3);
  });

  it('puts the 28-day average on the same weekly scale as the 7-day total', () => {
    const acts = Array.from({ length: 28 }, (_, n) => ({ date: day('2026-09-13', n), mt: 3600 }));
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    expect(r.latest.acute).toBe(7);     // 7 days x 1h
    // An hour a day is 7h/week however the 28 days are weighted — the weighting
    // changes how bumps are spread, never the level of a steady input.
    expect(r.latest.chronic).toBe(7);
  });

  it('weights the 28 days heaviest in the middle and lightly at both ends', () => {
    expect(CHRONIC_WEIGHTS).toHaveLength(CHRONIC_DAYS);
    const mid = Math.floor(CHRONIC_DAYS / 2);
    expect(CHRONIC_WEIGHTS[mid]).toBeGreaterThan(CHRONIC_WEIGHTS[0] * 10);
    expect(CHRONIC_WEIGHTS[mid]).toBeGreaterThan(CHRONIC_WEIGHTS[CHRONIC_DAYS - 1] * 10);
    // Symmetric, which is what keeps the centre of mass at 13.5 days — the same
    // place a flat 28-day average sits. Front-loading the weights would smooth
    // nothing and make the line jumpier; back-loading would just add lag.
    for (let k = 0; k < CHRONIC_DAYS; k++) {
      expect(CHRONIC_WEIGHTS[k]).toBeCloseTo(CHRONIC_WEIGHTS[CHRONIC_DAYS - 1 - k], 10);
    }
    const total = CHRONIC_WEIGHTS.reduce((s, v) => s + v, 0);
    const com = CHRONIC_WEIGHTS.reduce((s, v, k) => s + v * k, 0) / total;
    expect(com).toBeCloseTo((CHRONIC_DAYS - 1) / 2, 6);
  });

  it('does not step the 28-day line up and down around one big day', () => {
    // The whole point. A flat 28-day average moves by value/4 the day a session
    // lands and by the same amount AGAIN 28 days later, when it drops out of the
    // window — a visible drop on a day with nothing logged, caused by the filter.
    const acts = [{ date: day('2026-09-13', 40), mt: 8 * 3600 }];
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });

    let worst = 0;
    for (let i = 1; i < r.chronic.length; i++) {
      worst = Math.max(worst, Math.abs(r.chronic[i] - r.chronic[i - 1]));
    }
    // A flat average would post two 2.00 h/wk steps for this single 8-hour day.
    expect(worst).toBeLessThan(0.6);

    // It still carries the full weight of that session through the window.
    expect(Math.max(...r.chronic)).toBeGreaterThan(3);
    // And every point is a real weighted average — never negative, never beyond
    // what the day itself was worth on a weekly scale.
    expect(Math.min(...r.chronic)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r.chronic)).toBeLessThanOrEqual(8 * 7);
  });

  it('is smoother than the flat average it replaced, on the same data', () => {
    // Four sessions a week, one of them long — the shape that made the old line
    // look almost as busy as the raw data.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const acts = [];
    for (let n = 0; n < 200; n++) {
      if (rnd() < 0.4) continue;
      // A spread of session lengths rather than two fixed ones: real weeks are
      // uneven, and it is the unevenness the old line was passing straight through.
      acts.push({ date: day('2026-09-13', n), mt: (rnd() < 0.15 ? 3 + rnd() * 2 : 0.5 + rnd() * 1.5) * 3600 });
    }
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    const series = r.chronic.slice(-200);

    // The same series under a flat 28-day average, for comparison.
    const byDay = {};
    acts.forEach((a) => { byDay[a.date] = (byDay[a.date] || 0) + a.mt / 3600; });
    const flat = r.labels.slice(-200).map((lab) => {
      const ms = new Date(lab + 'T12:00:00').getTime();
      let t = 0;
      for (let k = 0; k < 28; k++) {
        const d = new Date(ms - k * 86400000);
        t += byDay[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] || 0;
      }
      return t / 4;
    });

    const rough = (s) => s.slice(1).reduce((t, v, i) => t + Math.abs(v - s[i]), 0) / (s.length - 1);
    const turns = (s) => {
      let n = 0;
      for (let i = 2; i < s.length; i++) {
        const a = s[i - 1] - s[i - 2], b = s[i] - s[i - 1];
        if (Math.abs(a) > 1e-9 && Math.abs(b) > 1e-9 && Math.sign(a) !== Math.sign(b)) n++;
      }
      return n;
    };
    // Direction changes are the honest measure of "messy", and the steadier of the
    // two: across a range of seeds this lands between 0.12x and 0.39x of the flat
    // average, while the roughness ratio swings with how the random draw falls.
    // Both are 1.0 if the weighting is ever flattened back out, so this test bites.
    expect(turns(series)).toBeLessThan(turns(flat) * 0.5);
    expect(rough(series)).toBeLessThan(rough(flat) * 0.85);
    // Smoother, not lower: the two describe the same training at the same level.
    const mean = (s) => s.reduce((a, b) => a + b, 0) / s.length;
    expect(mean(series)).toBeCloseTo(mean(flat), 0);
  });

  it('drops activities older than the window out of the acute total', () => {
    const acts = [{ date: day('2026-09-13', 0), mt: 3600 }, { date: day('2026-09-13', 10), mt: 36000 }];
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    expect(r.latest.acute).toBe(1);
  });

  it('counts days from before the window towards the first plotted average', () => {
    // The first label is 364 days back; an activity the day before it must still
    // reach the 28-day average there, or the line ramps up from a false zero.
    const acts = [{ date: day('2026-09-13', 364), mt: 3600 }];
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    expect(r.chronic[0]).toBeGreaterThan(0);
  });

  it('returns whatever unit pick returns, so one function serves both charts', () => {
    const acts = [{ date: '2026-09-13', mt: 7200, dist_mi: 25 }];
    const opts = { today: '2026-09-13', scope: 'All' };
    expect(rollingWeekly(acts, hours, opts).latest.acute).toBe(2);
    expect(rollingWeekly(acts, dist, opts).latest.acute).toBe(25);
  });

  it('spans a year for all-time, a year plus a base for a calendar year', () => {
    const o = { today: '2026-09-13' };
    expect(rollingWeekly([], hours, { ...o, scope: 'All' }).span).toBe(365);
    expect(rollingWeekly([], hours, { ...o, scope: '2026' }).span).toBe(370);
  });

  it('gives a rolling scope its own length plus the 28-day base behind it', () => {
    const o = { today: '2026-09-13' };
    expect(rollingWeekly([], hours, { ...o, scope: '30d' }).span).toBe(58);
    expect(rollingWeekly([], hours, { ...o, scope: '90d' }).span).toBe(118);
  });

  it('ends a past year on its own last day, not on today', () => {
    const o = { today: '2026-09-13' };
    expect(rollingWeekly([], hours, { ...o, scope: '2024' }).end).toBe('2024-12-31');
    // The current year still ends today — 31 December has not happened yet.
    expect(rollingWeekly([], hours, { ...o, scope: '2026' }).end).toBe('2026-09-13');
    expect(rollingWeekly([], hours, { ...o, scope: 'All' }).end).toBe('2026-09-13');
  });

  it('reports whether anything falls inside the window at all', () => {
    const o = { today: '2026-09-13', scope: 'All' };
    expect(rollingWeekly([{ date: '2026-09-01', mt: 60 }], hours, o).hasData).toBe(true);
    expect(rollingWeekly([{ date: '2019-01-01', mt: 60 }], hours, o).hasData).toBe(false);
    expect(rollingWeekly([], hours, o).hasData).toBe(false);
  });

  it('reports the biggest week in the window', () => {
    const acts = [{ date: '2026-09-13', mt: 3600 }, { date: '2026-05-01', mt: 36000 }];
    const r = rollingWeekly(acts, hours, { today: '2026-09-13', scope: 'All' });
    expect(r.peak).toBe(10);
  });

  it('produces one label per day with no repeats or gaps across a clock change', () => {
    // 2026-03-29 is the UK spring change. Stepping in fixed 24h from midnight
    // would repeat or skip a date here; the noon anchor is what prevents it.
    const r = rollingWeekly([], hours, { today: '2026-04-05', scope: 'All' });
    expect(new Set(r.labels).size).toBe(r.labels.length);
    expect(r.labels.length).toBe(365);
    const i = r.labels.indexOf('2026-03-28');
    expect(r.labels[i + 1]).toBe('2026-03-29');
    expect(r.labels[i + 2]).toBe('2026-03-30');
  });

  it('survives an empty history without throwing', () => {
    const r = rollingWeekly([], hours, { today: '2026-09-13', scope: 'All' });
    expect(r.latest.acute).toBe(0);
    expect(r.peak).toBe(0);
  });
});

describe('ratioBand', () => {
  it('names each band of acute against chronic', () => {
    expect(ratioBand(1.8).word).toBe('stepping up hard');
    expect(ratioBand(1.4).word).toBe('building');
    expect(ratioBand(1.0).word).toBe('steady');
    expect(ratioBand(0.7).word).toBe('easing off');
    expect(ratioBand(0.4).word).toBe('backing off');
  });

  it('puts the boundaries where the thresholds say, not one side out', () => {
    expect(ratioBand(1.5).word).toBe('building');   // > 1.5, not >=
    expect(ratioBand(1.3).word).toBe('steady');
    expect(ratioBand(0.8).word).toBe('steady');
    expect(ratioBand(0.6).word).toBe('easing off');
  });

  it('carries a tone so both hero figures colour the same way', () => {
    expect(ratioBand(1.8).tone).toBe('danger');
    expect(ratioBand(1.0).tone).toBe('good');
    expect(ratioBand(0.5).tone).toBe('warn');
  });
});

// ── SCOPE PERIODS ─────────────────────────────────────────────────────────────

describe('rolling periods', () => {
  it('counts the window inclusively, ending today', () => {
    expect(periodStart('30d', '2026-09-13')).toBe('2026-08-15');
    expect(periodStart('90d', '2026-09-13')).toBe('2026-06-16');
    expect(periodStart('12m', '2026-09-13')).toBe('2025-09-14');
  });

  it('includes both ends of the window and nothing outside it', () => {
    expect(scopeIncludes('2026-09-13', '30d', '2026-09-13')).toBe(true);
    expect(scopeIncludes('2026-08-15', '30d', '2026-09-13')).toBe(true);
    expect(scopeIncludes('2026-08-14', '30d', '2026-09-13')).toBe(false);
  });

  it('excludes a future-dated activity from a rolling window', () => {
    expect(scopeIncludes('2026-09-14', '30d', '2026-09-13')).toBe(false);
  });

  it('nests, so a shorter window never holds more than a longer one', () => {
    const d = '2026-07-01';
    expect(scopeIncludes(d, '30d', '2026-09-13')).toBe(false);
    expect(scopeIncludes(d, '90d', '2026-09-13')).toBe(true);
    expect(scopeIncludes(d, '12m', '2026-09-13')).toBe(true);
  });

  it('keeps year and all-time scopes working exactly as before', () => {
    expect(scopeIncludes('2025-06-01', 'All', '2026-09-13')).toBe(true);
    expect(scopeIncludes('2025-06-01', '2025', '2026-09-13')).toBe(true);
    expect(scopeIncludes('2025-06-01', '2026', '2026-09-13')).toBe(false);
  });

  it('shows everything rather than nothing for a token it does not know', () => {
    // A stale URL must not render an empty dashboard with no explanation.
    expect(scopeIncludes('2020-01-01', 'nonsense', '2026-09-13')).toBe(true);
  });

  it('tells years and rolling windows apart', () => {
    expect(isYearScope('2026')).toBe(true);
    expect(isYearScope('30d')).toBe(false);
    expect(isYearScope('All')).toBe(false);
    expect(isRollingScope('30d')).toBe(true);
    expect(isRollingScope('2026')).toBe(false);
  });

  it('labels each scope for the chip and the scope line', () => {
    expect(periodLabel('All')).toBe('All time');
    expect(periodLabel('2026')).toBe('2026');
    expect(periodLabel('90d')).toBe('Last 90 days');
    expect(periodPhrase('2026')).toBe('in 2026');
    expect(periodPhrase('30d')).toBe('in the last 30 days');
  });

  it('accepts only scopes the UI can actually produce', () => {
    ['All', '2026', '30d', '90d', '12m'].forEach((v) => expect(isValidScope(v)).toBe(true));
    ['', 'yesterday', '20266', '7d', null].forEach((v) => expect(isValidScope(v)).toBe(false));
  });

  it('reads today in local time, not UTC', () => {
    // A UTC read would roll over at 1am BST and shift the window by a day.
    const t = todayISO();
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const local = new Date();
    expect(t).toBe(
      `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    );
  });
});

describe('extractPartners', () => {
  it('reads the names after a w/ marker', () => {
    expect(extractPartners('Morning ride w/ Dave')).toEqual(['Dave']);
  });

  it('splits on commas, ampersands and the word and', () => {
    expect(extractPartners('Ride w/ Dave, Sarah & Tom')).toEqual(['Dave', 'Sarah', 'Tom']);
    expect(extractPartners('Ride w/ Dave and Sarah')).toEqual(['Dave', 'Sarah']);
  });

  it('cuts a trailing note off the last name', () => {
    expect(extractPartners('Ride w/ Dave - hilly one')).toEqual(['Dave']);
  });

  it('returns nothing when there is no marker', () => {
    expect(extractPartners('Morning ride')).toEqual([]);
    expect(extractPartners('')).toEqual([]);
    expect(extractPartners(null)).toEqual([]);
  });

  it('drops single characters and runaway strings', () => {
    expect(extractPartners('Ride w/ D')).toEqual([]);
    expect(extractPartners('Ride w/ ' + 'x'.repeat(40))).toEqual([]);
  });
});

describe('socCanon / socInitials', () => {
  it('folds case, accents and punctuation so one person is one person', () => {
    expect(socCanon("Siobhán O'Brien")).toBe('siobhan obrien');
    expect(socCanon('Dave')).toBe(socCanon('  dave  '));
  });

  it('strips emoji out of a Strava display name', () => {
    expect(socCanon('Dave 🚴')).toBe('dave');
  });

  it('takes at most two initials', () => {
    expect(socInitials('Dave Smith')).toBe('DS');
    expect(socInitials('Dave Michael Smith')).toBe('DM');
    expect(socInitials('Dave')).toBe('D');
  });
});

describe('gearKey / gearSlug', () => {
  it('reduces a gear name to a comparable key', () => {
    expect(gearKey('Canyon Ultimate CF SL 8')).toBe('canyonultimatecfsl8');
    expect(gearKey('Canyon-Ultimate')).toBe(gearKey('Canyon Ultimate'));
  });

  it('makes a filename-safe slug without leading or trailing dashes', () => {
    expect(gearSlug('Canyon Ultimate CF SL 8')).toBe('canyon-ultimate-cf-sl-8');
    expect(gearSlug("Rapha's Shoes!")).toBe('raphas-shoes');
    expect(gearSlug('  spaced  out  ')).toBe('spaced-out');
  });
});

describe('small formatters', () => {
  it('groups and rounds numbers, with a dash for nothing', () => {
    expect(fmtNum(1234.6)).toBe('1,235');
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(null)).toBe('—');
    expect(fmtCal(2500)).toBe('2,500');
    expect(fmtCal(0)).toBe('—');
  });

  it('honours the requested decimal places', () => {
    expect(chipNum(1234.56, 1)).toBe('1,234.6');
    expect(chipNum(1234.56)).toBe('1,235');
  });

  // Its only caller passes a weekly-hours figure from toFixed(1), so the domain is
  // roughly 0.0–30.0. The trailing non-digit guard is what keeps "18.2" on "an"
  // while leaving "180" alone — irrelevant for hours-per-week, and the reason this
  // is not a general-purpose article picker.
  it('picks the article by how the number is said, not how it is spelled', () => {
    expect(artFor('8.0')).toBe('an');
    expect(artFor('11.5')).toBe('an');
    expect(artFor('18.2')).toBe('an');
    expect(artFor(8)).toBe('an');
    expect(artFor('1.0')).toBe('a');
    expect(artFor('12.0')).toBe('a');
    expect(artFor('9.5')).toBe('a');
    // Documented limit, not an endorsement: a number that merely starts 8/11/18
    // and carries on in digits falls through to "a".
    expect(artFor('80.0')).toBe('a');
  });

  it('reports the current distance unit', () => {
    miles();
    expect(distUnit()).toBe('mi');
    km();
    expect(distUnit()).toBe('km');
  });
});

// ── TRAINING MONOTONY ───────────────────────────────────────────────────────────
// The point of monotony is that it separates two weeks a total cannot: the same
// hours spread evenly and the same hours in two sessions. These tests are built
// around exactly that pair.

describe('weeklyLoadStats', () => {
  const hours = (a) => (a.mt || 0) / 3600;
  // 2026-09-14 is a Monday, so a week built from it lines up with the Monday-start
  // weeks the function uses and nothing straddles a boundary.
  const MON = '2026-09-14';
  const day = (n) => {
    const d = new Date(MON + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // A week of equal days, and a week of the same total in two sessions.
  const evenWeek = Array.from({ length: 7 }, (_, n) => ({ date: day(n), mt: 3600 }));
  const spikyWeek = [{ date: day(0), mt: 3.5 * 3600 }, { date: day(3), mt: 3.5 * 3600 }];
  const opts = { end: day(6) };

  it('scores a week of identical days at the cap, because its spread is zero', () => {
    const [w] = weeklyLoadStats(evenWeek, hours, opts);
    expect(w.total).toBe(7);
    expect(w.sd).toBe(0);
    expect(w.monotony).toBe(MONOTONY_CAP);
  });

  it('separates two weeks a total cannot tell apart', () => {
    const [even] = weeklyLoadStats(evenWeek, hours, opts);
    const [spiky] = weeklyLoadStats(spikyWeek, hours, opts);
    expect(even.total).toBe(spiky.total);          // identical volume
    expect(spiky.monotony).toBeLessThan(even.monotony);
    expect(spiky.strain).toBeLessThan(even.strain);
  });

  it('counts rest days as zeros, which is what creates the spread', () => {
    const [w] = weeklyLoadStats(spikyWeek, hours, opts);
    expect(w.days).toBe(2);
    expect(w.mean).toBeCloseTo(1, 6);             // 7 hours over SEVEN days, not two
    // [3.5,0,0,3.5,0,0,0] against a mean of 1: squared deviations are 2.5^2 twice
    // and 1^2 five times, so sd = sqrt(17.5/7) = sqrt(2.5).
    expect(w.sd).toBeCloseTo(Math.sqrt(2.5), 2);
    expect(w.monotony).toBeCloseTo(1 / Math.sqrt(2.5), 2);
  });

  it('reports strain as the week total times its monotony', () => {
    const [w] = weeklyLoadStats(spikyWeek, hours, opts);
    expect(w.strain).toBeCloseTo(w.total * w.monotony, 1);
  });

  it('skips a week with nothing in it rather than dividing by zero', () => {
    // Two weeks apart, so the week between them is empty.
    const acts = [{ date: day(0), mt: 3600 }, { date: day(14), mt: 3600 }];
    const out = weeklyLoadStats(acts, hours, { end: day(20) });
    expect(out).toHaveLength(2);
    expect(out.every((w) => w.total > 0)).toBe(true);
  });

  it('leaves out the week still in progress', () => {
    // Ending mid-week, the later days are zeros that have not happened yet — which
    // would otherwise score as the most varied week of the year.
    const acts = Array.from({ length: 10 }, (_, n) => ({ date: day(n), mt: 3600 }));
    const out = weeklyLoadStats(acts, hours, { end: day(9) });
    expect(out).toHaveLength(1);
    expect(out[0].week).toBe(day(0));
  });

  it('returns nothing at all for no activities', () => {
    expect(weeklyLoadStats([], hours, opts)).toEqual([]);
    expect(weeklyLoadStats(null, hours, opts)).toEqual([]);
  });
});

// ── YEAR-END PROJECTION ─────────────────────────────────────────────────────────
// The two methods fail in opposite directions, and the tests are built around
// making each one fail so the dial can be seen doing its job.

describe('yearEndProjection', () => {
  // A year of exactly 1 a day is the easiest thing to reason about: any honest
  // projection of it lands on the number of days in the year.
  const flat = (n, v = 1) => { const a = new Array(n + 1).fill(0); for (let d = 1; d <= n; d++) a[d] = v; return a; };
  // A seasonal year: all the work in the first half, nothing after day 180.
  const frontLoaded = (n) => { const a = new Array(n + 1).fill(0); for (let d = 1; d <= 180; d++) a[d] = 2; return a; };

  it('projects a perfectly steady year onto its own total', () => {
    const r = yearEndProjection({ 2026: flat(365), 2025: flat(365) }, '2026', 200, 0.5);
    expect(r.ytd).toBe(200);
    expect(r.projected).toBeCloseTo(365, 0);
    expect(r.seasonal).toBeCloseTo(365, 0);
    expect(r.recent).toBeCloseTo(365, 0);
  });

  it('lets the recent window see a stop that the seasonal shape cannot', () => {
    // Trained daily to day 170, then nothing for a month.
    const stopped = flat(365); for (let d = 171; d <= 200; d++) stopped[d] = 0;
    const daily = { 2026: stopped, 2025: flat(365) };
    const recentOnly = yearEndProjection(daily, '2026', 200, 1);
    const seasonalOnly = yearEndProjection(daily, '2026', 200, 0);
    // Nothing in the last 7 days, so the recent method adds nothing at all.
    expect(recentOnly.projected).toBeCloseTo(recentOnly.ytd, 0);
    // The seasonal method has no idea and scales the year up regardless.
    expect(seasonalOnly.projected).toBeGreaterThan(recentOnly.projected * 1.5);
  });

  it('lets the seasonal shape see a winter that the recent window cannot', () => {
    // Previous years stop dead at midsummer. Asked in June at full tilt, the recent
    // method promises a second half that has never once happened.
    const daily = { 2026: frontLoaded(365), 2025: frontLoaded(365), 2024: frontLoaded(366) };
    const atDay150 = yearEndProjection(daily, '2026', 150, 0);
    const recent = yearEndProjection(daily, '2026', 150, 1);
    expect(atDay150.projected).toBeCloseTo(360, 0);      // 180 days x 2, and no more
    expect(recent.projected).toBeGreaterThan(atDay150.projected);
  });

  it('slides monotonically between the two', () => {
    const stopped = flat(365); for (let d = 171; d <= 200; d++) stopped[d] = 0;
    const daily = { 2026: stopped, 2025: flat(365) };
    const at = (m) => yearEndProjection(daily, '2026', 200, m).projected;
    const steps = [0, 0.25, 0.5, 0.75, 1].map(at);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-6);
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 1]);
  });

  it('shortens the recent window as the dial moves right', () => {
    expect(projectionWindow(0)).toBe(PROJ_WINDOW_MAX);
    expect(projectionWindow(0.5)).toBe(PROJ_WINDOW_MAX);
    expect(projectionWindow(1)).toBe(PROJ_WINDOW_MIN);
    expect(projectionWindow(0.75)).toBeLessThan(PROJ_WINDOW_MAX);
    expect(projectionWindow(0.75)).toBeGreaterThan(PROJ_WINDOW_MIN);
  });

  it('ignores a part-year, which would otherwise halve every projection', () => {
    // The year you joined: nothing until September. Counting its shape would claim
    // day 200 is already most of a year.
    const joinedLate = new Array(366).fill(0);
    for (let d = 250; d <= 365; d++) joinedLate[d] = 1;
    const r = yearEndProjection({ 2026: flat(365), 2025: joinedLate }, '2026', 200, 0);
    expect(r.teachers).toBe(0);
    expect(r.seasonal).toBeNull();
  });

  it('falls back to the recent trend when no finished year can teach it', () => {
    const r = yearEndProjection({ 2026: flat(365) }, '2026', 200, 0);
    expect(r.seasonal).toBeNull();
    // The dial says "all seasonal" and there is no seasonal, so it must not quietly
    // serve the recent number under that label — the weight says which it used.
    expect(r.weight).toBe(1);
    expect(r.projected).toBeCloseTo(r.recent, 6);
  });

  it('draws a path that starts at today and ends on the projection', () => {
    const daily = { 2026: flat(365), 2025: flat(365) };
    const r = yearEndProjection(daily, '2026', 200, 0.5);
    expect(r.path[200]).toBeCloseTo(r.ytd, 1);
    expect(r.path[365]).toBeCloseTo(r.projected, 1);
    expect(r.path[100]).toBeNull();                      // nothing drawn over the past
    for (let d = 201; d <= 365; d++) expect(r.path[d]).toBeGreaterThanOrEqual(r.path[d - 1]);
  });

  it('bends the path the way the years usually bend', () => {
    // Previous years do nothing after midsummer, so a projection made in spring must
    // flatten out rather than run straight to 31 December.
    const daily = { 2026: frontLoaded(365), 2025: frontLoaded(365), 2024: frontLoaded(366) };
    const r = yearEndProjection(daily, '2026', 90, 0);
    const half = r.path[240], end = r.path[365];
    expect(half).toBeCloseTo(end, 0);                    // finished by midsummer
    const straight = r.ytd + (end - r.ytd) * (240 - 90) / (365 - 90);
    expect(half).toBeGreaterThan(straight);              // and got there sooner
  });

  it('knows which years have 366 days', () => {
    expect(daysInYear('2024')).toBe(366);
    expect(daysInYear('2026')).toBe(365);
    expect(daysInYear('2000')).toBe(366);
    expect(daysInYear('1900')).toBe(365);
  });
});
