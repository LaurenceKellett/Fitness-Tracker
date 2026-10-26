/* weekly.js — the Tuesday email: last week, Monday to Sunday.
 *
 * buildWeekly is pure, like the Tasks app's digest: given what is stored (the Strava
 * activities, the Garmin days and activities, the Zwift routes) and a week, it returns
 * { subject, html, text } with no network and no side effects. GET /weekly/preview
 * renders any week in a browser through the same function the Tuesday send uses, so
 * what is previewed is what arrives. The end of the file decides when it goes and sends
 * it (maybeSendWeekly, on the Worker's quarter-hour cron); the Worker hands it a loader
 * for the stored data.
 *
 * Sent on Tuesday rather than Monday so the weekend's rides, and the Sunday night's
 * sleep, have synced from the watch and Strava first.
 *
 * WHAT IT HOLDS, in order, each section only when there is something to put in it:
 *   the week in one line, its totals against the four weeks before and the same week
 *   last year, the load ratio; each day as a bar; every activity with what Garmin and
 *   you said about it (Training Effect, RPE, feel, workout compliance, Body Battery);
 *   heart-rate zones as measured; Training Effect labels; power bests; recovery
 *   (sleep each night against need, bedtime, HRV, resting HR, steps, stress, Body
 *   Battery, and the readiness verdict as of Sunday); running form and splits; Zwift
 *   routes done and planned; the year so far.
 *
 * Health data goes only to WEEKLY_TO (the owner's own address), from the owner's own
 * Fastmail. It is never in a URL or a log line.
 *
 * Styling follows the Japan planner's email (see Look, below). Charts are table cells
 * with heights and widths, which every mail client draws; the only images are the
 * section icons, and a blocked one leaves an empty tinted square.
 */
import calc from './calc.js';
import { sendMail } from './jmap.js';

const {
  fmtTime, typeGroup, garminMatch, teLabel, TE_ORDER, ratioBand, recoveryVerdict, restingHrTrend,
  hrvRecent, respTrend, powerCurve, PC_SECS, pcLabel, bestSplits, SPLIT_NAMES, feelWord, rpeWord,
  needReasons, nightMinutes, nightClock, clockToNight, garminIn, isGarminRun, fmtPRTime, setScope,
} = calc;

export const WEEKLY_HEADER = 'X-Fitness-Weekly';
export const WEEKLY_HEADER_VALUE = 'fitness-weekly-email';
export const WEEKLY_CODE = 'FT-WEEKLY';
export const DASHBOARD_URL = 'https://activities.laurencekellett.co.uk';

// ── Dates ────────────────────────────────────────────────────────────────────
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}
// The week before the one `today` is in.
export function lastWeek(today) {
  const from = addDays(mondayOf(today), -7);
  return { from, to: addDays(from, 6) };
}
const days7 = (from) => Array.from({ length: 7 }, (_, i) => addDays(from, i));
const dayName = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayMonth = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
function weekLabel(w) {
  const a = new Date(w.from + 'T12:00:00Z'), b = new Date(w.to + 'T12:00:00Z');
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return sameMonth ? `${a.getUTCDate()}–${dayMonth(w.to)}` : `${dayMonth(w.from)} – ${dayMonth(w.to)}`;
}

// ── Look ─────────────────────────────────────────────────────────────────────
// The Japan planner's email, carried over: a solid ink header block, then soft grey
// section cards with square-ish corners, each titled by a small label and icon over
// a hairline, holding white rows; links underlined in the accent. The dashboard and
// the planner share the accent (#ff385c) and the font (Plus Jakarta Sans), so this
// reads as the same family. A dark palette in THEME, as the planner has, is applied
// by clients that honour prefers-color-scheme; the chart colours hold on either.
const P = {
  ink: '#222222', body: '#222222', muted: '#6b6b6b', faint: '#8a8a8a',
  canvas: '#ffffff', card: '#f7f7f7', surface: '#ffffff', edge: '#e3e3e3', hair: '#ececec', track: '#e9e9e9',
  hero: '#222222', heroText: '#ffffff', heroMuted: '#cfcfd4', heroAccent: '#ffb3c1',
  accent: '#ff385c', accentSoft: '#ffeef1', accentText: '#d70466',
  good: '#1a7f43', warn: '#9a6410', bad: '#c92a2a',
};
const SPORT = { Ride: '#0a46b9', Virtual: '#9b6cf0', Run: '#d33a3c', Walk: '#0d9488', Swim: '#0891b2', Other: '#94a3b8' };
const ZONE = ['#94a3b8', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'];
const TE_COL = { RECOVERY: '#94a3b8', AEROBIC_BASE: '#38bdf8', TEMPO: '#22c55e', LACTATE_THRESHOLD: '#f59e0b', VO2MAX: '#f97316', ANAEROBIC_CAPACITY: '#ef4444', SPRINT: '#a855f7', NO_BENEFIT: '#cbd5e1' };
const FONT = `'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';
const f = (size, weight = 400, lh = 1.5) => `font-family:${FONT};font-size:${size}px;font-weight:${weight};line-height:${lh};`;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const R_CARD = 6, R_ROW = 4;
const THEME = `
  a.lk { color:${P.ink}; text-decoration:underline; text-decoration-color:${P.accent}; text-underline-offset:2px; }
  @media (prefers-color-scheme: dark) {
    body, .page { background:#18191c !important; }
    .card { background:#26272d !important; border-color:#45464e !important; }
    .sf   { background:#32333a !important; border-color:#4a4b53 !important; }
    .card, .sf, .tx { color:#f2f2f2 !important; }
    .mu   { color:#b4b4ba !important; }
    .ac   { color:#ff6b7a !important; }
    .gd   { color:#5fd48f !important; }
    .wn   { color:#e0a642 !important; }
    .hair { border-color:#45464e !important; }
    .hero { background:#2b2c33 !important; border-color:#45464e !important; }
    .trk  { background:#45464e !important; }
    .iw   { background:#3a2226 !important; }
    .btn  { background:#f2f2f2 !important; color:#111111 !important; }
    a.lk  { color:#f2f2f2 !important; }
    /* Text coloured inline in the sections, without a class of its own. */
    .card [style*="color:#222222"] { color:#f2f2f2 !important; }
    .card [style*="color:#6b6b6b"], .card [style*="color:#8a8a8a"] { color:#b4b4ba !important; }
    .card [style*="color:#1a7f43"] { color:#5fd48f !important; }
    .card [style*="color:#9a6410"] { color:#e0a642 !important; }
  }`;

// The dashboard's Material Symbols, as small images in the accent: several mail
// clients never load an icon font and would print the ligature word instead.
function icon(name, size = 16) {
  const url = `https://api.iconify.design/material-symbols/${name.replace(/_/g, '-')}-rounded.svg?color=%23ff385c&width=24&height=24`;
  return `<img src="${url}" width="${size}" height="${size}" alt="" style="display:inline-block;width:${size}px;height:${size}px;border:0;vertical-align:middle;">`;
}
function iconBox(name, box = 26, size = 16) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" class="iw" style="width:${box}px;height:${box}px;border-radius:${R_ROW}px;background:${P.accentSoft};"><tr>`
    + `<td align="center" valign="middle" style="width:${box}px;height:${box}px;line-height:0;">${icon(name, size)}</td></tr></table>`;
}
const SECTION_ICON = {
  Training: 'directions_bike', 'Day by day': 'calendar_month', 'Every activity': 'format_list_bulleted',
  'Heart-rate zones': 'favorite', 'What kind of training it was': 'bolt', Power: 'electric_bolt', Sleep: 'bedtime',
  Recovery: 'monitor_heart', Running: 'directions_run', 'Zwift routes': 'route',
};
// One card per section: its label and icon over a hairline, a line saying what it
// shows, then the content in a white row.
function card(title, sub, inner) {
  const ic = SECTION_ICON[title] || 'trending_up';
  return `<tr><td style="padding:0 0 12px 0;">
<div class="card tx" style="background:${P.card};color:${P.ink};border:1px solid ${P.edge};border-radius:${R_CARD}px;padding:14px 16px 14px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="hair" style="margin:0 0 10px 0;border-bottom:1px solid ${P.edge};"><tr>
<td style="width:26px;padding:0 9px 10px 0;vertical-align:middle;">${iconBox(ic)}</td>
<td class="ac" style="vertical-align:middle;padding:0 0 10px 0;${f(14, 700, 1.3)}color:${P.accentText};">${esc(title)}</td></tr></table>
${sub ? `<div class="mu" style="${f(12.5, 400, 1.45)}color:${P.muted};margin:0 0 10px 0;">${sub}</div>` : ''}
<div class="sf tx" style="background:${P.surface};color:${P.ink};border:1px solid ${P.edge};border-radius:${R_ROW}px;padding:14px 14px 12px 14px;">${inner}</div>
</div></td></tr>`;
}
// A row of big figures, each with a label and an optional line under it.
function figures(items) {
  const cells = items.filter(Boolean).map((x) => `<td valign="top" style="padding:0 16px 8px 0;">
<div class="${x.col ? '' : 'tx'}" style="${f(22, 800, 1.15)}color:${x.col || P.ink};white-space:nowrap;letter-spacing:-0.3px;">${x.n}</div>
<div class="mu" style="${f(12, 600, 1.35)}color:${P.muted};">${esc(x.label)}</div>
${x.sub ? `<div style="${f(11.5, 500, 1.35)}color:${x.subCol || P.faint};margin-top:2px;">${x.sub}</div>` : ''}</td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}
// Vertical bars, one a column, each a stack of { v, col } from the bottom up, with a
// figure above and a label below. `max` sets the scale; a column of nothing is a gap.
// Square-topped, like the dashboard's own bars.
function vbars(cols, { height = 96, max } = {}) {
  const top = max || Math.max(1e-9, ...cols.map((c) => c.stack.reduce((a, s) => a + (s.v || 0), 0)));
  const cells = cols.map((c) => {
    const segs = c.stack.filter((s) => s.v > 0).reverse()
      .map((s) => `<div style="height:${Math.max(2, Math.round((s.v / top) * height))}px;background:${s.col};font-size:0;line-height:0;">&nbsp;</div>`).join('');
    return `<td valign="bottom" align="center" style="padding:0 3px;">
<div class="tx" style="${f(11, 700, 1.2)}color:${P.ink};padding-bottom:3px;">${c.top || '&nbsp;'}</div>
<div style="width:100%;max-width:56px;margin:0 auto;">${segs || `<div class="trk" style="height:2px;background:${P.track};font-size:0;line-height:0;">&nbsp;</div>`}</div></td>`;
  }).join('');
  const labels = cols.map((c) => `<td align="center" class="hair mu" style="${f(11, 600, 1.3)}color:${P.muted};padding:6px 3px 0 3px;border-top:1px solid ${P.edge};">${c.label}</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;">
<tr style="height:${height + 18}px;">${cells}</tr><tr>${labels}</tr></table>`;
}
// One bar split into coloured parts by share, with a key under it.
function split(parts) {
  const total = parts.reduce((a, p) => a + (p.v || 0), 0);
  if (!total) return '';
  const shown = parts.filter((p) => p.v > 0);
  const cells = shown.map((p) => `<td style="width:${(p.v / total * 100).toFixed(2)}%;background:${p.col};height:14px;font-size:0;line-height:0;">&nbsp;</td>`).join('');
  const key = shown.map((p) => `<span style="white-space:nowrap;margin-right:12px;"><span style="display:inline-block;width:9px;height:9px;background:${p.col};"></span> ${esc(p.label)} <strong class="tx" style="color:${P.ink};">${Math.round(p.v / total * 100)}%</strong>${p.extra ? ` <span class="mu" style="color:${P.faint};">${p.extra}</span>` : ''}</span>`).join(' ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${cells}</tr></table>
<div class="tx" style="${f(12, 500, 1.9)}color:${P.body};margin-top:8px;">${key}</div>`;
}
function note(text) { return text ? `<div class="tx" style="${f(13, 400, 1.55)}color:${P.body};margin-top:12px;">${text}</div>` : ''; }
function table(head, rows) {
  const th = head.map((h) => `<td class="mu hair" style="${f(11, 700, 1.3)}color:${P.muted};padding:0 10px 6px 0;border-bottom:1px solid ${P.edge};">${h}</td>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td valign="top" class="tx hair" style="${f(13, i ? 400 : 600, 1.4)}color:${P.ink};padding:8px 10px 8px 0;border-bottom:1px solid ${P.hair};">${c}</td>`).join('')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${th}</tr>${tr}</table>`;
}
function delta(now, before, { unit = '', better = 'up', fmt = (v) => String(Math.round(v)) } = {}) {
  if (now == null || before == null || !before) return null;
  const pct = Math.round((now - before) / before * 100);
  if (Math.abs(pct) < 3) return { text: 'level with', col: P.faint };
  const good = better === 'up' ? pct > 0 : pct < 0;
  return { text: `${pct > 0 ? '+' : ''}${pct}%${unit} on`, col: better === 'none' ? P.muted : good ? P.good : P.warn };
}

// ── Formatting ───────────────────────────────────────────────────────────────
const mi = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('en-GB');
const hrs = (s) => fmtTime(Math.round(s));
const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const avg = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
const plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + 's'}`;

function totals(acts) {
  return { time: sum(acts, (a) => a.mt), dist: sum(acts, (a) => a.dist_mi), elv: sum(acts, (a) => a.elv), n: acts.length };
}

// ── The email ────────────────────────────────────────────────────────────────
/**
 * @param data { acts: Strava activities, days: Garmin days, gacts: Garmin activities,
 *               routes: Zwift routes, garminError }
 * @param week { from, to } Monday and Sunday
 * @param opts { today } the owner's today, for "this week's plan"
 */
export function buildWeekly(data, week, opts = {}) {
  setScope({ unit: 'mi', activeYear: 'All', activeType: 'All' });
  const acts = (data.acts || []).filter((a) => a && a.date);
  const days = data.days || {};
  const gacts = data.gacts || {};
  const inRange = (from, to) => acts.filter((a) => a.date >= from && a.date <= to);
  const wk = inRange(week.from, week.to).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const t = totals(wk);
  const before = [1, 2, 3, 4].map((i) => totals(inRange(addDays(week.from, -7 * i), addDays(week.to, -7 * i))));
  const base = { time: avg(before.map((b) => b.time)), dist: avg(before.map((b) => b.dist)), elv: avg(before.map((b) => b.elv)), n: avg(before.map((b) => b.n)) };
  const ly = totals(inRange(addDays(week.from, -364), addDays(week.to, -364)));
  const match = garminMatch(wk, gacts);
  const gWeek = garminIn(gacts, week.from, week.to);
  const sections = [];
  const text = [];

  // The week in one line, for the notification.
  const sports = {};
  wk.forEach((a) => { const g = typeGroup(a.type); sports[g] = (sports[g] || 0) + 1; });
  const sportLine = Object.entries(sports).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${n} ${g === 'Virtual' ? 'indoor ride' : g.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
  const ratio = base.time ? t.time / base.time : null;
  const band = ratio != null ? ratioBand(ratio) : null;
  const headline = t.n
    ? `${hrs(t.time)} over ${plural(t.n, 'activity', 'activities')} (${sportLine}), ${mi(t.dist)} mi${band ? ', ' + band.word : ''}.`
    : 'No activities last week.';
  text.push(headline);

  // ── Training: totals ──
  if (t.n || base.n) {
    const d = (k, o) => delta(t[k], base[k], o);
    const line = (dl) => (dl ? `<span style="color:${dl.col};">${dl.text} the 4-week average</span>` : '');
    const lyLine = ly.n ? `Same week last year: ${hrs(ly.time)}, ${mi(ly.dist)} mi, ${plural(ly.n, 'activity', 'activities')}.` : '';
    const bandCol = band ? (band.tone === 'good' ? P.good : band.tone === 'danger' ? P.bad : P.warn) : P.muted;
    sections.push(card('Training', `${esc(sportLine || 'Nothing logged')}`,
      figures([
        { n: hrs(t.time), label: 'moving', sub: line(d('time')) },
        { n: mi(t.dist) + ' mi', label: 'distance', sub: line(d('dist')) },
        { n: Math.round(t.elv).toLocaleString('en-GB') + ' ft', label: 'climbed', sub: line(d('elv')) },
        { n: String(t.n), label: t.n === 1 ? 'activity' : 'activities', sub: base.n ? `${Math.round(base.n * 10) / 10} a week before` : '' },
      ])
      + note((ratio != null ? `Training time was <strong style="color:${bandCol};">${band.word}</strong>: ${Math.round(ratio * 100)}% of the four weeks before. ` : '') + lyLine)));
    text.push(`Training: ${hrs(t.time)}, ${mi(t.dist)} mi, ${Math.round(t.elv).toLocaleString('en-GB')} ft, ${t.n} activities.` + (ratio != null ? ` ${Math.round(ratio * 100)}% of the 4-week average (${band.word}).` : ''));
  }

  // ── Each day ──
  if (t.n) {
    const cols = days7(week.from).map((day) => {
      const list = wk.filter((a) => a.date === day);
      const bySport = {};
      list.forEach((a) => { const g = typeGroup(a.type); bySport[g] = (bySport[g] || 0) + a.mt / 3600; });
      const tot = sum(list, (a) => a.mt);
      return { label: dayName(day), top: tot ? hrs(tot) : '', stack: Object.entries(bySport).map(([g, v]) => ({ v, col: SPORT[g] || SPORT.Other })) };
    });
    const key = Object.keys(sports).map((g) => `<span style="white-space:nowrap;margin-right:12px;"><span style="display:inline-block;width:9px;height:9px;background:${SPORT[g] || SPORT.Other};border-radius:2px;"></span> ${g === 'Virtual' ? 'Indoor ride' : g}</span>`).join(' ');
    sections.push(card('Day by day', 'Time moving each day, by sport', vbars(cols) + `<div style="${f(12, 400, 1.8)}color:${P.body};margin-top:8px;">${key}</div>`));
  }

  // ── Every activity ──
  if (wk.length) {
    const rows = wk.map((a) => {
      const g = match[String(a.id)];
      const sport = typeGroup(a.type);
      const bits = [];
      if (g && g.label) bits.push(`<span style="color:${TE_COL[g.label] || P.muted};font-weight:600;">${esc(teLabel(g.label))}</span>` + (g.aerobic != null ? ` ${g.aerobic.toFixed(1)}/${(g.anaerobic || 0).toFixed(1)}` : ''));
      if (g && g.rpe) bits.push(`RPE ${g.rpe} (${rpeWord(g.rpe)})`);
      if (g && g.feel != null) bits.push(`felt ${feelWord(g.feel).toLowerCase()}`);
      if (g && g.comp != null) bits.push(`${Math.round(g.comp)}% of ${g.workout ? esc(g.workout) : 'the workout'}`);
      if (g && g.bb != null && g.bb < 0) bits.push(`Body Battery −${-g.bb}`);
      if (g && g.np) bits.push(`NP ${Math.round(g.np)} W`);
      if (g && g.recHr) bits.push(`recovery HR ${g.recHr}`);
      return [
        `<span style="color:${SPORT[sport] || SPORT.Other};">●</span> ${esc(a.name || a.type)}<div style="${f(11, 400, 1.4)}color:${P.faint};">${dayName(a.date)} ${a.time || ''}</div>`,
        `<span style="white-space:nowrap;">${hrs(a.mt)}</span><div style="${f(11, 400, 1.4)}color:${P.faint};">${a.dist_mi ? mi(a.dist_mi) + ' mi' : ''}${a.hr ? ' · ' + Math.round(a.hr) + ' bpm' : ''}</div>`,
        bits.length ? `<span style="${f(12, 400, 1.5)}">${bits.join(' · ')}</span>` : `<span style="color:${P.faint};">${g ? '' : 'not on Garmin'}</span>`,
      ];
    });
    const said = wk.filter((a) => match[String(a.id)] && (match[String(a.id)].rpe || match[String(a.id)].feel != null)).length;
    sections.push(card('Every activity', 'With what Garmin measured and what you told it' + (said ? '' : ' (no RPE or feel logged this week)'),
      table(['Activity', 'Time', 'Garmin and you'], rows)));
    wk.forEach((a) => {
      const g = match[String(a.id)] || {};
      text.push(`- ${dayName(a.date)} ${a.name || a.type}: ${hrs(a.mt)}${a.dist_mi ? ', ' + mi(a.dist_mi) + ' mi' : ''}${g.label ? ', ' + teLabel(g.label) : ''}${g.rpe ? ', RPE ' + g.rpe : ''}${g.feel != null ? ', felt ' + feelWord(g.feel).toLowerCase() : ''}${g.comp != null ? ', ' + Math.round(g.comp) + '% of ' + (g.workout || 'the workout') : ''}`);
    });
  }

  // ── Heart-rate zones, measured ──
  const zoned = gWeek.filter((g) => Array.isArray(g.zones) && g.zones.some((v) => v > 0));
  if (zoned.length) {
    const z = [0, 1, 2, 3, 4].map((i) => sum(zoned, (g) => g.zones[i]));
    const all = z.reduce((a, c) => a + c, 0) || 1;
    const easy = Math.round((z[0] + z[1]) / all * 100), tempo = Math.round(z[2] / all * 100), hard = 100 - easy - tempo;
    const verdict = easy >= 75 ? 'Mostly easy, which is where most of the gains are made.'
      : tempo >= 30 ? 'A lot of this sits in the middle, tempo: the zone that tires you without the payoff of either end.'
        : hard >= 20 ? 'A hard week by heart rate. Make sure the next has more easy time in it.' : 'A reasonable spread.';
    sections.push(card('Heart-rate zones', `Measured by Garmin on ${plural(zoned.length, 'activity', 'activities')}, ${hrs(all)} in all`,
      split(z.map((v, i) => ({ v, col: ZONE[i], label: 'Z' + (i + 1), extra: hrs(v) })))
      + note(`${easy}% easy · ${tempo}% tempo · ${hard}% hard. ${verdict}`)));
    text.push(`Zones (measured): ${easy}% easy, ${tempo}% tempo, ${hard}% hard.`);
  }

  // ── Training Effect ──
  const labelled = gWeek.filter((g) => g.label && g.dur > 0);
  if (labelled.length) {
    const h = {};
    labelled.forEach((g) => { h[g.label] = (h[g.label] || 0) + g.dur; });
    const order = TE_ORDER.filter((k) => h[k]).concat(Object.keys(h).filter((k) => !TE_ORDER.includes(k)));
    const load = sum(gWeek, (g) => g.load);
    sections.push(card('What kind of training it was', "Garmin's Training Effect label, by time",
      split(order.map((k) => ({ v: h[k], col: TE_COL[k] || '#94a3b8', label: teLabel(k), extra: hrs(h[k]) })))
      + note(load ? `Garmin's training load for the week: <strong>${Math.round(load)}</strong>.` : '')));
  }

  // ── Power ──
  const wkCurve = powerCurve(gacts, week.from, week.to);
  if (wkCurve.some(Boolean)) {
    const allCurve = powerCurve(gacts, null, week.to);
    const prevCurve = powerCurve(gacts, addDays(week.from, -91), addDays(week.from, -1));
    const rows = [5, 60, 300, 1200, 3600].map((s) => {
      const i = PC_SECS.indexOf(s), w = wkCurve[i], a = allCurve[i], p = prevCurve[i];
      if (!w) return null;
      const best = a && w.w >= a.w;
      return [pcLabel(s), `<strong>${w.w} W</strong>${best ? ` <span style="color:${P.good};font-weight:600;">all-time best</span>` : ''}`,
        p ? `${p.w} W` : '—', a ? `${a.w} W` : '—'];
    }).filter(Boolean);
    const t20 = wkCurve[PC_SECS.indexOf(1200)];
    sections.push(card('Power', 'Best average power this week, against the 90 days before and your best ever',
      table(['Duration', 'This week', '90 days before', 'All time'], rows)
      + note(t20 ? `On a 20-minute best of ${t20.w} W, FTP is roughly ${Math.round(t20.w * 0.95)} W.` : '')));
  }

  // ── Recovery ──
  const wd = days7(week.from);
  const nights = wd.map((d) => ({ d, r: days[d] || {} }));
  const hasHealth = nights.some((n) => n.r.sleepSec || n.r.hrv != null || n.r.rhr != null || n.r.steps != null);
  if (hasHealth) {
    // Sleep each night, against need.
    const slept = nights.filter((n) => n.r.sleepSec);
    if (slept.length) {
      const cols = nights.map((n) => ({
        label: dayName(n.d), top: n.r.sleepScore != null ? String(n.r.sleepScore) : '',
        stack: n.r.sleepSec ? [{ v: n.r.sleepSec / 3600, col: n.r.sleepNeed && n.r.sleepSec / 60 < n.r.sleepNeed ? '#a5b4fc' : '#6366f1' }] : [],
      }));
      const need = slept.filter((n) => n.r.sleepNeed);
      const met = need.filter((n) => n.r.sleepSec / 60 >= n.r.sleepNeed).length;
      const why = needReasons(slept.map((n) => n.r));
      const beds = slept.map((n) => nightMinutes(n.r.sleepStart)).filter((v) => v != null);
      const wakes = slept.map((n) => nightMinutes(n.r.sleepEnd)).filter((v) => v != null);
      const rec = slept.filter((n) => n.r.bedRecStart != null);
      const recLine = rec.length ? ` Garmin suggested bed between ${nightClock(clockToNight(avg(rec.map((n) => n.r.bedRecStart))))} and ${nightClock(clockToNight(avg(rec.map((n) => n.r.bedRecEnd))))}.` : '';
      const deep = avg(slept.filter((n) => n.r.deepSec != null).map((n) => n.r.deepSec));
      const score = avg(slept.filter((n) => n.r.sleepScore != null).map((n) => n.r.sleepScore));
      sections.push(card('Sleep', 'Hours each night (the morning it ended), with the score above; pale where it fell short of what Garmin said you needed',
        vbars(cols, { max: Math.max(9, ...slept.map((n) => n.r.sleepSec / 3600)) })
        + figures([
          { n: hrs(avg(slept.map((n) => n.r.sleepSec))), label: 'a night' },
          score != null ? { n: String(Math.round(score)), label: 'average score' } : null,
          need.length ? { n: `${met} of ${need.length}`, label: 'nights you met your need' } : null,
          deep != null ? { n: hrs(deep), label: 'deep a night' } : null,
        ].map((x) => x && { ...x }))
        + note((need.length ? `Garmin wanted ${hrs(avg(need.map((n) => n.r.sleepNeed * 60)))} a night on average` + (why.factors.length ? `, raised for ${why.factors.map((x) => x.label).join(' and ')}` : '') + '. ' : '')
          + (beds.length ? `Asleep around ${nightClock(avg(beds))}, up around ${nightClock(avg(wakes))}.` : '') + recLine)));
      text.push(`Sleep: ${hrs(avg(slept.map((n) => n.r.sleepSec)))} a night` + (score != null ? `, score ${Math.round(score)}` : '') + (need.length ? `, met your need ${met} of ${need.length} nights` : '') + '.');
    }
    // HRV, resting HR, steps, stress, Body Battery.
    const hrvN = nights.filter((n) => n.r.hrv != null);
    const rhrs = nights.map((n) => n.r.rhr).filter((v) => v > 0);
    const rhrBefore = [];
    for (let i = 1; i <= 28; i++) { const r = days[addDays(week.from, -i)]; if (r && r.rhr > 0) rhrBefore.push(r.rhr); }
    const steps = nights.filter((n) => n.r.steps != null);
    const stepGoal = avg(steps.filter((n) => n.r.stepGoal).map((n) => n.r.stepGoal));
    const atGoal = steps.filter((n) => n.r.stepGoal && n.r.steps >= n.r.stepGoal).length;
    const charged = nights.map((n) => n.r.bbCharged).filter((v) => v != null);
    const bbMax = nights.map((n) => n.r.bbMax).filter((v) => v != null);
    const rhrNow = avg(rhrs), rhrThen = avg(rhrBefore);
    const rhrD = rhrNow != null && rhrThen != null ? Math.round((rhrNow - rhrThen) * 10) / 10 : null;
    const items = [
      hrvN.length ? { n: Math.round(avg(hrvN.map((n) => n.r.hrv))) + ' ms', label: 'HRV a night', sub: `${hrvN.filter((n) => n.r.hrvStatus === 'BALANCED').length} of ${hrvN.length} balanced`, subCol: hrvN.every((n) => n.r.hrvStatus === 'BALANCED') ? P.good : P.warn } : null,
      rhrs.length ? { n: Math.round(rhrNow) + ' bpm', label: 'resting HR', sub: rhrD != null ? (Math.abs(rhrD) < 1 ? 'level with the 4 weeks before' : `${rhrD > 0 ? '+' : ''}${rhrD} on the 4 weeks before`) : '', subCol: rhrD != null && rhrD >= 3 ? P.warn : P.faint } : null,
      steps.length ? { n: Math.round(avg(steps.map((n) => n.r.steps))).toLocaleString('en-GB'), label: 'steps a day', sub: stepGoal ? `${atGoal} of ${steps.length} days at goal` : '' } : null,
      charged.length ? { n: '+' + Math.round(avg(charged)), label: 'Body Battery charged a day', sub: bbMax.length ? `peak ${Math.round(avg(bbMax))} on average` : '' } : null,
    ];
    // HRV each night as a strip against its range.
    const hrvStrip = hrvN.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;margin-top:10px;"><tr>${nights.map((n) => {
      const r = n.r, ok = r.hrvStatus === 'BALANCED';
      return `<td align="center" style="padding:0 3px;"><div style="background:${r.hrv == null ? P.track : ok ? '#dcfce7' : '#fde68a'};border-radius:${R_ROW}px;padding:6px 0;${f(13, 650, 1.2)}color:${r.hrv == null ? P.faint : ok ? P.good : P.warn};">${r.hrv != null ? r.hrv : '–'}</div><div style="${f(11, 500, 1.3)}color:${P.muted};padding-top:4px;">${dayName(n.d)}</div></td>`;
    }).join('')}</tr></table>` : '';
    // Stress, as shares of the measured week.
    const st = ['stressRest', 'stressLow', 'stressMed', 'stressHigh'].map((k) => sum(nights, (n) => n.r[k]));
    const stressBar = st.some((v) => v > 0) ? `<div style="${f(13, 600, 1.4)}color:${P.ink};margin:16px 0 8px 0;">Stress</div>` + split([
      { v: st[0], col: '#38bdf8', label: 'Rest' }, { v: st[1], col: '#fcd34d', label: 'Low' },
      { v: st[2], col: '#f59e0b', label: 'Medium' }, { v: st[3], col: '#ea580c', label: 'High' }]) : '';
    const verdict = recoveryVerdict(restingHrTrend(days, week.to), hrvRecent(days, week.to), respTrend(days, week.to));
    sections.push(card('Recovery', 'HRV each night (green when Garmin called it balanced), and the week around it',
      figures(items) + hrvStrip + stressBar + note(verdict ? `As of Sunday: ${verdict}` : '')));
    if (hrvN.length) text.push(`HRV ${Math.round(avg(hrvN.map((n) => n.r.hrv)))} ms a night; resting HR ${rhrs.length ? Math.round(rhrNow) : '–'} bpm.`);
    if (verdict) text.push(verdict);
  } else if (data.garminError) {
    sections.push(card('Recovery', '', note(`Nothing from Garmin for this week. ${esc(data.garminError)}`)));
  }

  // ── Running ──
  const runs = gWeek.filter((g) => isGarminRun(g) && g.run);
  if (runs.length) {
    const r = (k) => avg(runs.map((g) => g.run[k]).filter((v) => v != null));
    const cad = r('cad'), stride = r('stride'), gct = r('gct'), vr = r('vr');
    const wkSplits = bestSplits(gacts, week.from, week.to), allSplits = bestSplits(gacts, null, week.to);
    const rows = SPLIT_NAMES.map((name, i) => (wkSplits[i] ? [name, `<strong>${fmtPRTime(wkSplits[i].sec)}</strong>` + (allSplits[i] && wkSplits[i].sec <= allSplits[i].sec ? ` <span style="color:${P.good};font-weight:600;">all-time best</span>` : ''), allSplits[i] ? fmtPRTime(allSplits[i].sec) : '—'] : null)).filter(Boolean);
    sections.push(card('Running', `Form from ${plural(runs.length, 'run')}, from the watch's running dynamics`,
      figures([
        cad != null ? { n: Math.round(cad) + ' spm', label: 'cadence' } : null,
        stride != null ? { n: (stride / 100).toFixed(2) + ' m', label: 'stride' } : null,
        gct != null ? { n: Math.round(gct) + ' ms', label: 'ground contact' } : null,
        vr != null ? { n: vr.toFixed(1) + '%', label: 'vertical ratio' } : null,
      ]) + (rows.length ? `<div style="margin-top:8px;">${table(['Fastest split', 'This week', 'All time'], rows)}</div>` : '')));
  }

  // ── Zwift ──
  const routes = data.routes || [];
  if (routes.length) {
    const done = routes.filter((r) => r.date_completed && r.date_completed.slice(0, 10) >= week.from && r.date_completed.slice(0, 10) <= week.to);
    const thisFrom = addDays(week.to, 1), thisTo = addDays(week.to, 7);
    const planned = routes.filter((r) => r.planned_ride && r.status !== 'Complete' && r.planned_ride.slice(0, 10) >= thisFrom && r.planned_ride.slice(0, 10) <= thisTo)
      .sort((a, b) => a.planned_ride.localeCompare(b.planned_ride));
    const overdue = routes.filter((r) => r.planned_ride && r.status !== 'Complete' && r.planned_ride.slice(0, 10) < thisFrom).length;
    const complete = routes.filter((r) => r.status === 'Complete').length;
    if (done.length || planned.length || overdue) {
      const list = (rs, when) => rs.map((r) => `<div style="${f(13, 400, 1.6)}color:${P.body};">${esc(r.route)}<span style="color:${P.faint};"> · ${when(r)}</span></div>`).join('');
      sections.push(card('Zwift routes', `${complete} of ${routes.length} done in all`,
        (done.length ? `<div style="${f(13, 600, 1.4)}color:${P.ink};margin-bottom:4px;">Done last week</div>` + list(done, (r) => (r.distance_mi ? mi(r.distance_mi) + ' mi' : '') + (r.time ? ' in ' + esc(r.time) : '')) : '')
        + (planned.length ? `<div style="${f(13, 600, 1.4)}color:${P.ink};margin:${done.length ? 12 : 0}px 0 4px 0;">Planned this week</div>` + list(planned, (r) => dayName(r.planned_ride.slice(0, 10)) + (r.est_duration ? ' · about ' + esc(r.est_duration) : '')) : '')
        + (overdue ? note(`<span style="color:${P.bad};">${plural(overdue, 'planned route')} still to ride from before this week.</span>`) : '')));
      if (done.length) text.push(`Zwift: ${done.length} route${done.length === 1 ? '' : 's'} done.`);
    }
  }

  // ── The year so far ──
  const y = week.to.slice(0, 4), ytd = totals(inRange(y + '-01-01', week.to));
  const lyTo = String(+y - 1) + week.to.slice(4), lytd = totals(inRange(String(+y - 1) + '-01-01', lyTo));
  if (ytd.n) {
    const dd = delta(ytd.dist, lytd.dist);
    sections.push(card(`${y} so far`, `To ${dayMonth(week.to)}`,
      figures([
        { n: mi(ytd.dist) + ' mi', label: 'distance', sub: dd && lytd.n ? `<span style="color:${dd.col};">${dd.text} this point last year (${mi(lytd.dist)} mi)</span>` : '' },
        { n: hrs(ytd.time), label: 'moving' },
        { n: Math.round(ytd.elv).toLocaleString('en-GB') + ' ft', label: 'climbed' },
        { n: ytd.n.toLocaleString('en-GB'), label: 'activities' },
      ])));
  }

  const subject = `Your week, ${weekLabel(week)}: ` + (t.n ? `${hrs(t.time)}, ${mi(t.dist)} mi` : 'a rest week');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>
<link href="${FONT_URL}" rel="stylesheet">
<style>:root { color-scheme: light dark; supported-color-schemes: light dark; } @import url('${FONT_URL}');${THEME}</style></head>
<body style="margin:0;padding:0;background:${P.canvas};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" style="background:${P.canvas};"><tr><td align="center" style="padding:12px 10px 28px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td style="padding:2px 0 12px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="hero" style="background:${P.hero};border:1px solid ${P.hero};border-radius:${R_CARD}px;"><tr>
<td style="width:44px;vertical-align:middle;padding:18px 0 18px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:44px;height:44px;border-radius:${R_ROW}px;background:#ffffff;"><tr>
<td align="center" valign="middle" style="width:44px;height:44px;line-height:0;"><div style="display:inline-block;width:18px;height:18px;background:${P.accent};font-size:0;line-height:0;">&nbsp;</div></td></tr></table></td>
<td style="vertical-align:middle;padding:18px 16px 18px 14px;">
<div style="${f(12, 700, 1.4)}color:${P.heroAccent};">Your week · ${esc(weekLabel(week))}</div>
<div style="${f(20, 800, 1.25)}color:${P.heroText};letter-spacing:-0.3px;margin-top:2px;">${esc(headline)}</div>
</td></tr></table></td></tr>
${sections.join('\n')}
<tr><td align="center" style="padding:10px 2px 0 2px;">
<a class="btn" href="${DASHBOARD_URL}" style="display:inline-block;background:${P.ink};color:#ffffff;${f(13, 700, 1.2)}text-decoration:none;padding:12px 20px;border-radius:${R_CARD}px;">Open the dashboard</a>
<div class="mu" style="${f(12, 400, 1.6)}color:${P.muted};margin-top:14px;">
Every chart behind this is on <a class="lk" href="${DASHBOARD_URL}" style="color:${P.muted};text-decoration:underline;text-decoration-color:${P.accent};">the dashboard</a>.<br>
Training from Strava; recovery, zones, Training Effect, power and what you logged from Garmin.<br>
Sent every Tuesday for the Monday to Sunday before · fitness weekly email ${WEEKLY_CODE}
</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text: `${subject}\n\n${text.join('\n')}\n\n${DASHBOARD_URL}\n\nFitness weekly email ${WEEKLY_CODE}\n` };
}

// ── When it goes ─────────────────────────────────────────────────────────────
// Every Tuesday from 07:00 on the owner's clock, for the Monday to Sunday before.
// WEEKLY_FROM and WEEKLY_TO are vars in wrangler.toml; FASTMAIL_TOKEN is a secret, the
// same kind of token the Tasks app sends with.
export const WEEKLY_KV = 'weekly_email_v1';
const WEEKLY_HOUR = 7;
// A send is tried at most this many times a week. The mark is written before each try,
// so a send that went out but whose mark failed to save can repeat at most this often,
// never every quarter hour all day.
const WEEKLY_TRIES = 3;
const DEFAULT_TZ = 'Europe/London';

function ownerClock(env, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: env.ZWIFT_TZ || DEFAULT_TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: Number(p.hour) };
}
// ?week= takes any day in the week wanted; without it, last week.
export function weekFor(param, env, at = new Date()) {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const from = mondayOf(param);
    return { from, to: addDays(from, 6) };
  }
  return lastWeek(ownerClock(env, at).day);
}
function weeklyTo(env) {
  return String(env.WEEKLY_TO || '').split(',').map((x) => x.trim()).filter(Boolean).map((email) => ({ email }));
}

export async function sendWeekly(env, week, data, { mark = false } = {}) {
  const mail = buildWeekly(data, week);
  const id = await sendMail(env, { to: weeklyTo(env), subject: mail.subject, html: mail.html, text: mail.text, headers: { [WEEKLY_HEADER]: WEEKLY_HEADER_VALUE } });
  // A send by hand of the week Tuesday would send counts as Tuesday's, so a Monday
  // "Send it now" is not followed by the same email the next morning.
  if (mark && env.CACHE) await env.CACHE.put(WEEKLY_KV, JSON.stringify({ week: week.from, tries: 1, sentAt: new Date().toISOString(), subject: mail.subject, byHand: true }));
  return { week: week.from, subject: mail.subject, id };
}

export async function weeklyStatus(env, at) {
  const clock = ownerClock(env, at);
  let mark = null;
  try { mark = JSON.parse((await env.CACHE.get(WEEKLY_KV)) || 'null'); } catch (e) { mark = null; }
  return {
    ownerDay: clock.day, weekday: clock.weekday, hour: clock.hour,
    sendsOn: 'Tuesday from ' + String(WEEKLY_HOUR).padStart(2, '0') + ':00',
    nextWeek: lastWeek(clock.day), to: weeklyTo(env).map((x) => x.email), from: env.WEEKLY_FROM || null,
    tokenSet: !!env.FASTMAIL_TOKEN, last: mark,
  };
}

// `load` reads the stored data, and is only called when there is something to send.
export async function maybeSendWeekly(env, at, load) {
  if (!env.FASTMAIL_TOKEN || !env.CACHE) return { skipped: 'no token' };
  const clock = ownerClock(env, at);
  if (clock.weekday !== 'Tue' || clock.hour < WEEKLY_HOUR) return { skipped: 'not Tuesday morning' };
  const week = lastWeek(clock.day);
  let mark = null;
  try { mark = JSON.parse((await env.CACHE.get(WEEKLY_KV)) || 'null'); } catch (e) { mark = null; }
  if (mark && mark.week === week.from && (mark.sentAt || (mark.tries || 0) >= WEEKLY_TRIES)) return { skipped: 'done this week' };
  const tries = mark && mark.week === week.from ? (mark.tries || 0) + 1 : 1;
  await env.CACHE.put(WEEKLY_KV, JSON.stringify({ week: week.from, tries, triedAt: at.toISOString() }));
  try {
    const r = await sendWeekly(env, week, await load());
    await env.CACHE.put(WEEKLY_KV, JSON.stringify({ week: week.from, tries, sentAt: new Date().toISOString(), subject: r.subject }));
    return { sent: true, ...r };
  } catch (err) {
    await env.CACHE.put(WEEKLY_KV, JSON.stringify({ week: week.from, tries, triedAt: at.toISOString(), error: err.message }));
    throw err;
  }
}
