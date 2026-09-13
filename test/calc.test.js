import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import calc from '../calc.js';

const {
  fmtDist, distUnit, fmtElv, fmtElevUnit, fmtElevVal, fmtTime, fmtSpeed, fmtPace, fmtDate,
  fmtNum, fmtCal, fmtPRTime, fmtHours, chipNum, artFor, escapeAttr, escapeHtml, typeGroup,
  mapTypeGroup, typeMatches, isFootSport, isRace, dayOfYear, daysBetween, monthsBetween,
  monthLabel, haversineMi, decodePolylinePts, gearKey, gearSlug, socCanon, socInitials,
  extractPartners, formatUpdatedAt, recLongestStreak, recCurrentStreak, mexBuckets, mexOf,
  actDistIn, distIn, ROLLING_ORDER, todayISO, isYearScope, isRollingScope, periodStart,
  scopeIncludes, periodLabel, periodPhrase, isValidScope,
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

  it('groups kayaking with swimming, and sends the rest to Other', () => {
    expect(typeGroup('Kayaking')).toBe('Swim');
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
