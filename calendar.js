/* calendar.js — planned Zwift rides, kept in step with Google Calendar.
 *
 * Each route that is not yet Complete and has a Planned Ride in Notion has one event
 * in the owner's main calendar: "🚴 <route>", private, as long as the route's
 * estimate plus a margin. Moving the event moves the plan, and moving the plan (in
 * the dashboard or in Notion) moves the event. A Complete route is left alone, its
 * event included: it stays where it was ridden.
 *
 * WHICH EVENT IS WHOSE. Every event this writes carries two private extended
 * properties, zwiftSync=1 and zwiftRouteId=<Notion page id>. Nothing else is stored:
 * no table of event ids to lose or drift, and the main calendar's other events are
 * never read for anything but that tag.
 *
 * WHO WINS. When the two sides disagree, the one changed last does. Notion keeps
 * last_edited_time to the minute, so Google wins only when its event changed more
 * than a minute after the page did; anything closer is treated as Notion's edit,
 * which is what an edit from the dashboard always is.
 *
 * A deleted event clears the plan (the route stays Planned, with no day), unless the
 * page was edited again after the deletion, in which case the event comes back.
 *
 * Imported by worker.js. Pure helpers are exported for the tests; syncCalendar and
 * syncCalendarRoute do the talking.
 */
import calc from './calc.js';

const { zwiftFit, zwiftPredictSec } = calc;

export const CAL_TAG = 'zwiftSync';
export const CAL_ROUTE = 'zwiftRouteId';
export const CAL_DEFAULT_TZ = 'Europe/London';
export const CAL_DEFAULT_APP = 'https://activities.laurencekellett.co.uk';
// Notion's last_edited_time is rounded to the minute.
const NOTION_SLACK_MS = 60 * 1000;
const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// ── Wall time ────────────────────────────────────────────────────────────────
// A planned ride as the clock on the wall reads it in the owner's time zone:
// { date: 'YYYY-MM-DD', time: 'HH:MM' | null }. Notion and Google hand back the
// same moment in different shapes (a bare day, a local time, a UTC instant with an
// offset); this is the one form they are compared in.
export function calWall(v, tz = CAL_DEFAULT_TZ) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v, time: null };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return null;
  if (!m[4]) return { date: m[1], time: `${m[2]}:${m[3]}` };
  const d = new Date(v);
  if (isNaN(d)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', or '' for no plan.
export function calKey(v, tz) {
  const w = calWall(v, tz);
  return w ? w.date + (w.time ? 'T' + w.time : '') : '';
}

function eventKey(ev, tz) {
  if (!ev || !ev.start) return '';
  return ev.start.date ? ev.start.date : calKey(ev.start.dateTime, tz);
}

// ── How long the event is ────────────────────────────────────────────────────
// The route's estimate, plus a fifth of it and never less than ten minutes, rounded
// up to five. The estimate is Notion's Est. Duration where there is one ("02:17" is
// two hours seventeen), otherwise the dashboard's own fit from completed routes,
// otherwise an hour.
export function calEstimateSec(route, fit) {
  const t = String(route.est_duration || '').trim();
  let m;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) return +m[1] * 3600 + +m[2] * 60;
  if ((m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(t))) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  const p = zwiftPredictSec(fit, route.distance_mi, route.elevation_ft);
  return p && p > 0 ? p : null;
}

export function calDurationMin(route, fit) {
  const est = calEstimateSec(route, fit);
  if (!est) return 60;
  const mins = est / 60;
  return Math.ceil((mins + Math.max(10, mins * 0.2)) / 5) * 5;
}

function addMinutes(date, time, mins) {
  // Wall-clock arithmetic: Google reads the result in the event's own time zone.
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) + mins * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// ── The event ────────────────────────────────────────────────────────────────
// A planned day with no time is an all-day event; with a time, it runs for the
// estimate plus its margin.
export function calEventBody(route, { tz = CAL_DEFAULT_TZ, fit = null, appUrl = CAL_DEFAULT_APP } = {}) {
  const w = calWall(route.planned_ride, tz);
  const mins = calDurationMin(route, fit);
  const est = calEstimateSec(route, fit);
  const facts = [
    route.distance_mi != null ? `${route.distance_mi} mi` : null,
    route.elevation_ft != null ? `${Math.round(route.elevation_ft).toLocaleString('en-GB')} ft` : null,
    est ? `about ${Math.round(est / 60)} min` : null,
  ].filter(Boolean).join(' · ');
  const description = [
    ['Zwift route', (route.maps || []).join(', ')].filter(Boolean).join(' · '),
    facts,
    route.link_zi ? `Zwift Insider: ${route.link_zi}` : null,
    route.link_strava ? `Strava segment: ${route.link_strava}` : null,
    '',
    `Planned from the fitness dashboard: ${appUrl}`,
    'Moving this event moves the plan.',
  ].filter(x => x !== null).join('\n');
  const body = {
    summary: `🚴 ${route.route}`,
    description,
    visibility: 'private',
    extendedProperties: { private: { [CAL_TAG]: '1', [CAL_ROUTE]: route.id } },
  };
  if (w.time) {
    body.start = { dateTime: `${w.date}T${w.time}:00`, timeZone: tz };
    body.end = { dateTime: addMinutes(w.date, w.time, mins), timeZone: tz };
  } else {
    body.start = { date: w.date };
    body.end = { date: nextDay(w.date) };
  }
  return body;
}

// What Notion should hold for a plan read off an event.
export function calNotionDate(key, tz = CAL_DEFAULT_TZ) {
  if (!key) return null;
  return key.length > 10 ? { start: key + ':00', time_zone: tz } : { start: key };
}

// ── Deciding ─────────────────────────────────────────────────────────────────
// routes: the routes that are not Complete. events: every tagged event, deleted
// ones included (Google keeps them, as cancelled, for a while). Returns what to do:
//   { op: 'create', route }
//   { op: 'update', route, event }        move the event to the route's plan
//   { op: 'delete', event }
//   { op: 'notion', route, key }          set the route's plan to key ('' clears it)
export function calPlan(routes, events, tz = CAL_DEFAULT_TZ) {
  const byRoute = {};
  (events || []).forEach(ev => {
    const id = ev.extendedProperties?.private?.[CAL_ROUTE];
    if (id) (byRoute[id] = byRoute[id] || []).push(ev);
  });
  const newest = list => list.slice().sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0] || null;
  const actions = [];
  (routes || []).forEach(r => {
    if (r.status === 'Complete') return;
    const evs = byRoute[r.id] || [];
    const live = evs.filter(e => e.status !== 'cancelled');
    const gone = newest(evs.filter(e => e.status === 'cancelled'));
    const ev = newest(live);
    // Two live events for one route can only be a duplicate; keep the newest.
    live.filter(e => e !== ev).forEach(e => actions.push({ op: 'delete', event: e }));
    const rk = calKey(r.planned_ride, tz);
    const edited = Date.parse(r.last_edited || 0) || 0;
    const googleWins = e => Date.parse(e.updated) > edited + NOTION_SLACK_MS;
    if (rk && !ev) {
      if (gone && googleWins(gone)) actions.push({ op: 'notion', route: r, key: '' });
      else actions.push({ op: 'create', route: r });
    } else if (rk && ev) {
      const ek = eventKey(ev, tz);
      if (ek === rk) {
        if (ev.summary !== `🚴 ${r.route}`) actions.push({ op: 'update', route: r, event: ev });
      } else if (googleWins(ev)) actions.push({ op: 'notion', route: r, key: ek });
      else actions.push({ op: 'update', route: r, event: ev });
    } else if (!rk && ev) {
      if (googleWins(ev)) actions.push({ op: 'notion', route: r, key: eventKey(ev, tz) });
      else actions.push({ op: 'delete', event: ev });
    }
  });
  return actions;
}

// ── Talking to Google ────────────────────────────────────────────────────────
export function calendarConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

async function googleToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // invalid_grant here almost always means the Google app is still in Testing,
    // whose refresh tokens die after seven days; see the README.
    throw new Error(`Google token refresh failed (${res.status} ${json.error || ''})`.trim());
  }
  return json.access_token;
}

async function gcal(token, path, options = {}) {
  const res = await fetch(GCAL + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 204 || res.status === 410) return null;   // deleted, or already gone
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar ${options.method || 'GET'} ${res.status}: ${json.error?.message || ''}`);
  return json;
}

async function listTaggedEvents(token, routeId) {
  const out = [];
  let page = '';
  do {
    const q = new URLSearchParams({ showDeleted: 'true', maxResults: '2500' });
    q.append('privateExtendedProperty', routeId ? `${CAL_ROUTE}=${routeId}` : `${CAL_TAG}=1`);
    if (page) q.set('pageToken', page);
    const json = await gcal(token, '?' + q.toString());
    out.push(...(json.items || []));
    page = json.nextPageToken || '';
  } while (page);
  return out;
}

// ── Doing ────────────────────────────────────────────────────────────────────
// deps: { notionRequest, fetchAllZwiftRoutes, transformNotionRoute, dataSourceId,
// onNotionChange } handed in by the worker, so this file needs nothing of its own
// to reach Notion.
async function applyActions(env, token, actions, deps) {
  const tz = env.ZWIFT_TZ || CAL_DEFAULT_TZ;
  const appUrl = env.APP_URL || CAL_DEFAULT_APP;
  let fit;
  const needFit = async () => {
    if (fit === undefined) {
      try { fit = zwiftFit(await deps.fetchAllZwiftRoutes(env)); } catch (e) { fit = null; }
    }
    return fit;
  };
  const done = [];
  let notionChanged = false;
  for (const a of actions) {
    try {
      if (a.op === 'create') {
        await gcal(token, '', { method: 'POST', body: JSON.stringify(calEventBody(a.route, { tz, fit: await needFit(), appUrl })) });
      } else if (a.op === 'update') {
        await gcal(token, '/' + encodeURIComponent(a.event.id), { method: 'PATCH', body: JSON.stringify(calEventBody(a.route, { tz, fit: await needFit(), appUrl })) });
      } else if (a.op === 'delete') {
        await gcal(token, '/' + encodeURIComponent(a.event.id), { method: 'DELETE' });
      } else if (a.op === 'notion') {
        const properties = { 'Planned Ride': { date: calNotionDate(a.key, tz) } };
        // A day picked for a route nobody has started makes it Planned, as in the app.
        if (a.key && a.route.status === 'Not started') properties.Status = { status: { name: 'Planned' } };
        await deps.notionRequest(`/v1/pages/${a.route.id}`, env, { method: 'PATCH', body: JSON.stringify({ properties }) });
        notionChanged = true;
      }
      done.push({ op: a.op, route: a.route?.route || a.event?.summary || '', key: a.key });
    } catch (err) {
      console.error('calendar sync:', a.op, a.route?.route || a.event?.id, err.message);
      done.push({ op: a.op, route: a.route?.route || '', error: err.message });
    }
  }
  if (notionChanged && deps.onNotionChange) await deps.onNotionChange();
  return done;
}

async function fetchOpenRoutes(env, deps) {
  const out = [];
  let cursor;
  do {
    const res = await deps.notionRequest(`/v1/data_sources/${deps.dataSourceId}/query`, env, {
      method: 'POST',
      body: JSON.stringify({
        page_size: 100,
        filter: { property: 'Status', status: { does_not_equal: 'Complete' } },
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    out.push(...res.results.map(deps.transformNotionRoute));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

// The whole reconcile, from the cron or from /calendar-sync.
export async function syncCalendar(env, deps) {
  if (!calendarConfigured(env)) return { skipped: 'Google Calendar is not set up (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).' };
  const tz = env.ZWIFT_TZ || CAL_DEFAULT_TZ;
  const token = await googleToken(env);
  const [routes, events] = await Promise.all([fetchOpenRoutes(env, deps), listTaggedEvents(token)]);
  const actions = calPlan(routes, events, tz);
  return { routes: routes.length, events: events.length, done: await applyActions(env, token, actions, deps) };
}

// One route, straight after the dashboard saved it: the edit is Notion's, so the
// event follows it.
export async function syncCalendarRoute(env, deps, route) {
  if (!calendarConfigured(env) || !route || route.status === 'Complete') return null;
  const tz = env.ZWIFT_TZ || CAL_DEFAULT_TZ;
  const token = await googleToken(env);
  const events = await listTaggedEvents(token, route.id);
  const fresh = { ...route, last_edited: new Date().toISOString() };
  return applyActions(env, token, calPlan([fresh], events, tz), deps);
}
