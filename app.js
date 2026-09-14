let ALL_DATA = [];
// Bumped whenever ALL_DATA is replaced, so derived caches know to recompute.
let _dataGen=0;

// ── VIEW STATE, IN THE URL AND REMEMBERED ──
// These four were plain defaults, so every reload dumped you back on Summary /
// all time / all sports / miles, and there was no way to link or bookmark a
// view. They now live in the query string — which makes the back button work
// and a view shareable — and fall back to the last one you used.
const VIEW_KEY='ft-view-v1';
const VALID_TABS=['summary','map','charts','heatmap','records','mex','social','gear','log','zwift'];
// ── ON-DEMAND LIBRARIES ──
// One promise per URL, cached, so concurrent callers share a single fetch and a
// repeat call after it resolves is free.
const _assetPromises={};
function loadScriptOnce(src){
  return _assetPromises[src]||(_assetPromises[src]=new Promise((resolve,reject)=>{
    const el=document.createElement('script');
    el.src=src;el.async=true;
    el.onload=()=>resolve();
    el.onerror=()=>{delete _assetPromises[src];reject(new Error('Could not load '+src));};
    document.head.appendChild(el);
  }));
}
function loadStyleOnce(href){
  return _assetPromises[href]||(_assetPromises[href]=new Promise((resolve,reject)=>{
    const el=document.createElement('link');
    el.rel='stylesheet';el.href=href;
    el.onload=()=>resolve();
    el.onerror=()=>{delete _assetPromises[href];reject(new Error('Could not load '+href));};
    document.head.appendChild(el);
  }));
}

/* Served from this origin, not from a CDN.
 *
 * These used to come from cdnjs and unpkg with no integrity hash, into a page that
 * holds a full location history — and sw.js then cached whatever came back. The
 * obvious fix is SRI, and SRI is the weaker one: it can only tell you the bytes
 * changed, after the request has already been made, and it still leaves the page
 * unable to start when someone else's CDN is having a bad day.
 *
 * Self-hosting removes the question instead of answering it. The files are the
 * official npm artefacts, pinned in git where they can be read and diffed, and they
 * are already the minified production builds — 69KB and 43KB over the wire once
 * gzipped. It also means two fewer hosts in the CSP, no cross-origin special case
 * in the service worker, and a map that works on a first visit offline.
 *
 * The shared-CDN-cache argument for the old arrangement stopped being true years
 * ago: browsers partition the HTTP cache by origin now, so a visitor never arrives
 * with these already downloaded from somebody else's site.
 *
 * To update: npm pack chart.js@<version> / leaflet@<version>, take dist/ verbatim.
 */
const CHART_JS_SRC='/vendor/chart.umd.js';
const LEAFLET_JS_SRC='/vendor/leaflet.js';
const LEAFLET_CSS_SRC='/vendor/leaflet.css';

// Charts are on the Summary tab, so this resolves on essentially every visit — the
// win is that it no longer blocks the parser, not that it is often skipped.
//
// It never rejects. A blocked CDN, a corporate proxy or a dead connection must cost
// you the charts and nothing else: every figure, table, streak and record on this
// page is computed here and needs no library at all, and a dashboard that renders
// none of them because a 200 KB script 404'd is a worse failure than a few empty
// chart cards.
let CHARTS_OK=null;   // null = not tried yet, true = ready, false = gave up
function ensureCharts(){
  if(window.Chart){CHARTS_OK=true;syncChartTheme();return Promise.resolve();}
  if(CHARTS_OK===false)return Promise.resolve();
  return loadScriptOnce(CHART_JS_SRC).then(()=>{
    CHARTS_OK=true;
    syncChartTheme();
  }).catch(err=>{
    CHARTS_OK=false;
    console.error('Charts are unavailable:',err);
  });
}

// Leaflet genuinely is conditional: Map tab, or an activity modal with a route.
let _leafletPromise=null;
function ensureLeaflet(){
  if(window.L)return Promise.resolve();
  if(!_leafletPromise){
    _leafletPromise=Promise.all([loadStyleOnce(LEAFLET_CSS_SRC),loadScriptOnce(LEAFLET_JS_SRC)])
      .catch(err=>{_leafletPromise=null;throw err;});
  }
  return _leafletPromise;
}

// ── THEME ──
// Three states, cycled in this order: system → light → dark. "System" is the
// absence of the attribute, which is what lets the media query decide; the two
// explicit states set it and win over the query in both directions.
const THEME_KEY='fitness_theme';
const THEME_ORDER=['system','light','dark'];

function readTheme(){
  try{const t=localStorage.getItem(THEME_KEY);if(t==='dark'||t==='light')return t;}catch(e){}
  return 'system';
}
function resolvedTheme(){
  const t=readTheme();
  if(t!=='system')return t;
  return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
}
function applyTheme(t){
  if(t==='system')document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme',t);
  try{t==='system'?localStorage.removeItem(THEME_KEY):localStorage.setItem(THEME_KEY,t);}catch(e){}
  resetPalette();
  document.querySelectorAll('#settingsTheme button').forEach(b=>{
    const on=b.dataset.themeOpt===t;
    b.classList.toggle('active',on);
    b.setAttribute('aria-pressed',on?'true':'false');
  });
  syncChartTheme();
}
function setTheme(t){
  if(THEME_ORDER.indexOf(t)===-1)return;
  applyTheme(t);
  // Charts bake their colours in at construction, so they are the one thing a
  // token swap cannot reach on its own.
  redrawChartsForTheme();
}

// Read straight off the cascade rather than keeping a second copy of the palette
// in JS — there is then no way for the two to drift.
function cssVar(name,fallback){
  const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v||fallback;
}
function chartGrid(){return cssVar('--chart-grid','#f0f0f0');}
function chartTick(){return cssVar('--chart-tick','#9ca3af');}

function syncChartTheme(){
  if(!window.Chart)return;
  Chart.defaults.color=chartTick();
  Chart.defaults.borderColor=chartGrid();
  Chart.defaults.font.family="'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif";
}
function redrawChartsForTheme(){
  resetPalette();
  if(!window.Chart)return;
  syncChartTheme();
  Object.keys(charts).forEach(destroyChartNow);
  sweepRetiredCharts();
  if(ALL_DATA.length)renderAll();
}

// A change to the OS setting only matters while we are following it.
if(window.matchMedia){
  const mq=window.matchMedia('(prefers-color-scheme: dark)');
  const onChange=()=>{if(readTheme()==='system')redrawChartsForTheme();};
  mq.addEventListener?mq.addEventListener('change',onChange):mq.addListener(onChange);
}

function readView(){
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(VIEW_KEY)||'{}');}catch(e){}
  const q=new URLSearchParams(location.search);
  const pick=(k,fallback,ok)=>{
    const v=q.get(k)!=null?q.get(k):saved[k];
    return (v!=null&&(!ok||ok(v)))?v:fallback;
  };
  return{
    tab:pick('tab','summary',v=>VALID_TABS.includes(v)),
    year:pick('year','All',v=>isValidScope(v)),
    type:pick('type','All',v=>TYPE_GROUPS.includes(v)),
    unit:pick('unit','mi',v=>v==='mi'||v==='km'),
  };
}
// Called after any state change. replaceState rather than pushState for the
// filters — a back button that stepped through every sport you tried would be
// worse than none — but the tab does push, because moving between tabs is the
// navigation people expect back to undo.
function writeView(push){
  const st={tab:activeTab,year:activeYear,type:activeType,unit};
  try{localStorage.setItem(VIEW_KEY,JSON.stringify(st));}catch(e){}
  const q=new URLSearchParams();
  if(st.tab!=='summary')q.set('tab',st.tab);
  if(st.year!=='All')q.set('year',st.year);
  if(st.type!=='All')q.set('type',st.type);
  if(st.unit!=='mi')q.set('unit',st.unit);
  const url=location.pathname+(q.toString()?'?'+q:'')+location.hash;
  try{history[push?'pushState':'replaceState'](st,'',url);}catch(e){}
}
let logPage=1;const LOG_PAGE_SIZE=50;
let hmShowAll=false;let recentShowAll=false;
let logSort={col:'date',dir:-1};let logSearch='';let charts={};

let ZWIFT_DATA=[];let zwiftLoaded=false;let zwiftSearch='';let zwiftStatusFilter='Not started';
let zwiftEditingId=null;let zwiftSaving=false;let zwiftGroupOpen={};
const ZWIFT_CACHE_KEY='zwift_routes_v1';
const ZWIFT_CHECKLIST_KEY='zwift_checklist_v1';
let zwiftChecklists={};
try{zwiftChecklists=JSON.parse(localStorage.getItem(ZWIFT_CHECKLIST_KEY)||'{}');}catch(e){zwiftChecklists={};}
const ZWIFT_WORKER_BASE='https://activities-api.lk-ff7.workers.dev';
const MAP_ORDER=['Watopia','Makuri Island','Jarvis Island','Scotland','London','Yorkshire','Richmond','France','New York','Innsbruck','Bologna','Gravel Mountain','Crit City','KOM','Rebel Routes','Event Only'];
const MAP_COLOR={'Watopia':'#d9730d','Makuri Island':'#d9730d','Jarvis Island':'#d9730d','Scotland':'#cb912f','London':'#cb912f','Yorkshire':'#cb912f','Richmond':'#cb912f','France':'#cb912f','New York':'#cb912f','Innsbruck':'#cb912f','Bologna':'#9f6b53','Gravel Mountain':'#9f6b53','Crit City':'#9f6b53','KOM':'#c14c8a','Rebel Routes':'#c14c8a','Event Only':'#9b9a97'};
function mapDotColor(name){return MAP_COLOR[name]||'#9b9a97';}
function mapSoftBg(name){const h=MAP_COLOR[name]||'#9b9a97';const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return`rgba(${r},${g},${b},0.07)`;}
const ZWIFT_CATEGORY_TAGS=['Event Only','Rebel Routes','KOM'];
const ZWIFT_CATEGORY_LABEL={'Event Only':'Event','Rebel Routes':'Rebel','KOM':'KOM'};
const ZWIFT_STATUS_ORDER=['Not started','Blocked','Planned','Complete'];
let zwiftCalDate=new Date();zwiftCalDate.setDate(1);
let zwiftCalSelected=null;

const ACCENT_COLORS={All:'#22c55e',Ride:'#1d4ed8',Virtual:'#8b5cf6',Run:'#ef4444',Walk:'#eab308',Swim:'#0ea5e9',Other:'#94a3b8'};
function getAccentColor(){return ACCENT_COLORS[activeType]||'#22c55e';}

// Strava's API doesn't expose gear photos, so pictures are supplied manually here.
// Key must match the gear's exact name/nickname as it comes through from Strava
// (the same string shown on the gear card). Sourced from the Notion Gear database —
// if a Strava nickname doesn't exactly match a key below, add/adjust the entry.
const GEAR_IMAGES={
  'Carrera Virtuoso':'gear-images/carrera-virtuoso.jpg',
  // Same bike as 'Merckx EMX-3', under the name the Product photos sheet uses. Matching is
  // normalised, not fuzzy, so the two spellings need separate keys — both point at the one
  // local file rather than at the sheet's remote URL.
  'Eddy Merckx':'gear-images/merckx-emx-3.jpg',
  'Forme Axe Edge':'gear-images/forme-axe-edge.jpg',
  'Gelert Hiking Boot':'gear-images/gelert-hiking-boot.jpg',
  'Goggles':'gear-images/goggles.jpg',
  'Karrimor Skiddaw Hiking Boots':'gear-images/karrimor-skiddaw-hiking-boots.jpg',
  'Merckx EMX-3':'gear-images/merckx-emx-3.jpg',
  'Nike Air Zoom Pegasus 36':'gear-images/nike-air-zoom-pegasus-36.jpg',
  'Nike Air Zoom Pegasus 38':'gear-images/nike-air-zoom-pegasus-38.jpg',
  'Nike Air Zoom Pegasus 40':'gear-images/nike-air-zoom-pegasus-40.jpg',
  'Nike Juniper Trail 2':'gear-images/nike-juniper-trail-2.jpg',
  'Nike React Pegasus Trail 3':'gear-images/nike-react-pegasus-trail-3.jpg',
  'Nike React Pegasus Trail 4 GORE-TEX':'gear-images/nike-react-pegasus-trail-4-goretex.jpg',
  'Nike ReactX Pegasus Trail 5':'gear-images/nike-reactx-pegasus-trail-5.jpg',
  'Nike ReactX Pegasus Trail 5 GORE-TEX':'gear-images/nike-reactx-pegasus-trail-5-goretex.jpg',
  'Rented Mountain Bike':'gear-images/rented-mountain-bike.jpg',
  'Rented Road Bike':'gear-images/rented-road-bike.jpg',
  'Salomon Alphacross 4 Gore-Tex':'gear-images/salomon-alphacross-4-goretex.jpg',
  'Salomon S-LAB 2':'gear-images/salomon-slab-2.jpg',
  'Storck Aernario':'gear-images/storck-aernario.jpg',
  'Unbranded/Work Shoe':'gear-images/unbranded-work-shoe.jpg',
  'Winter Bike':'gear-images/winter-bike.jpg',
  'Zwift Bike':'gear-images/zwift-bike.jpg',
  // ── Remote, pending local copies ───────────────────────────────────────────
  // The three items above that had no picture, filled from the "Product photos"
  // sheet in Drive. These hotlink to third-party CDNs rather than sitting in
  // gear-images/, which is a stopgap, not the pattern: they are someone else's
  // bandwidth, they rotate without warning, and some hosts refuse requests that
  // carry a foreign Referer. When one goes, the card falls back to its sport
  // icon rather than breaking — but it should still be downloaded into
  // gear-images/ and moved up into the block above. See the README.
  'Rose':'https://www.cycleexchange.co.uk/cdn/shop/files/70959481-001.jpg?v=1733400261',
  'Barbour Wellies':'https://media.johnlewiscontent.com/i/JohnLewis/004999350alt1?fmt=auto&$background-off-white$',
  // Weakest of the three: a Google Images thumbnail-cache URL. Low resolution and
  // the token is not a stable address — expect this one to go first.
  'Under Armour UA Thrill 3':'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS5wY6VS80V-woI10KU9YfYvQYc9oN0iPfqP-tDacNOiQ&s',
};
let GEAR_DATA={};
// Brand, model and retired flag by gear name, from the Worker envelope. The
// lookup that produces them was already being made; this is what stops the
// extra fields being discarded.
let GEAR_META={};

// escapeHtml lives further down, next to the Zwift detail renderer. There used to be a
// second, weaker copy here that the later one silently shadowed — one definition now.

// The Map's own variant, which deliberately has no All case: the map handles that
// branch before it gets here, and calling this with All set returns false for
// everything. Use typeMatches() anywhere that is not the map.
function mapFilterMatches(a){
  const g=typeGroup(a.type);
  if(activeType==='Ride')return g==='Ride'||g==='Virtual';
  return g===activeType;
}
// Kept in step with the --ride/--virtual/... tokens by hand: Chart.js needs a literal
// hex, not a CSS variable. Virtual is violet rather than a second blue — see the token.
// NOTE: the sport palette is written out by hand in five places — this, groupSoft,
// ACCENT_COLORS, typeDotColors and colorFull — plus the CSS tokens. Changing a sport
// colour means changing all six, or it comes out violet on the donut and blue on the
// filter dots. Worth consolidating; not today.
/* ── SPORT AND STANDING COLOURS ──
 * These were the last colours in the app still pinned to the light palette: a
 * second copy of the stylesheet's values, written in JS, that dark mode could not
 * reach. They are what painted chart series, gear fallback tiles and the
 * Regular/Occasional/Lapsed chips in daylight colours on a dark page.
 *
 * They read from the cascade now, so there is one definition of each colour and it
 * is the one the theme already swaps. Cached because groupColor() is called per
 * heatmap cell — hundreds of times in a render — and getComputedStyle is not free.
 * applyTheme() drops the cache.
 */
let _paletteCache=null;
function resetPalette(){_paletteCache=null;}
function palette(){
  if(_paletteCache)return _paletteCache;
  const cs=getComputedStyle(document.documentElement);
  const v=(n,f)=>cs.getPropertyValue(n).trim()||f;
  _paletteCache={
    sport:{
      Ride:   [v('--ride','#1d4ed8'),    v('--ride-soft','#dbeafe')],
      Virtual:[v('--virtual','#8b5cf6'), v('--virtual-soft','#ede9fe')],
      Run:    [v('--run','#ef4444'),     v('--run-soft','#fee2e2')],
      Walk:   [v('--walk','#eab308'),    v('--walk-soft','#fefce8')],
      Swim:   [v('--swim','#0ea5e9'),    v('--swim-soft','#e0f2fe')],
      Other:  [v('--other','#94a3b8'),   v('--other-soft','#f8fafc')],
    },
    standing:{
      Regular:   [v('--standing-reg','#166534'),    v('--standing-reg-bg','#dcfce7')],
      Occasional:[v('--standing-occ','#475569'),    v('--standing-occ-bg','#f1f5f9')],
      Lapsed:    [v('--standing-lapsed','#b45309'), v('--standing-lapsed-bg','#fef3c7')],
    },
  };
  return _paletteCache;
}
function groupColor(g){const p=palette().sport;return (p[g]||p.Other)[0];}
function groupSoft(g){const p=palette().sport;return (p[g]||p.Other)[1];}
// ── CALENDAR CELL COLOUR ──
// Both calendars — the Heatmap tab and the per-year grid on Charts — used to
// interpolate one accent by distance, so the only thing a cell could say was "how
// far". That is the one fact the rest of the page says loudest, and it left the
// calendars unable to show the thing only they can: what the shape of a year is
// made of. Hue is now the sport you spent the most *time* on that day, and
// intensity stays distance.
//
// Time, not activity count, decides the sport: a day with a three-hour ride and a
// ten-minute dog walk is a riding day, and counting activities calls it a draw.
//
// With the sport filter on a single sport every day resolves to that sport, so the
// calendar looks exactly as it did before — which is correct, not a regression.
function dayDominant(dd){
  const by=dd&&(dd.time||dd.types);
  if(!by)return null;
  const e=Object.entries(by).sort((x,y)=>y[1]-x[1])[0];
  return e?e[0]:null;
}
function dayCellBg(dd,maxDist){
  if(!dd)return'var(--hm-empty,#f0f0f0)';
  const g=dayDominant(dd);
  const col=g?groupColor(g):getAccentColor();
  // Square-rooted so the middle of the range is visible: raw distance ratios put
  // almost every ordinary day at the pale end and only the epics anywhere else.
  const t=Math.pow(Math.min(dd.dist/(maxDist*0.6),1),.5);
  // A day with no distance at all — a gym session, a swim logged without one — is
  // still a day you trained, so it gets the floor rather than disappearing.
  const i=Math.max(t,0.18);
  const r=parseInt(col.slice(1,3),16),g2=parseInt(col.slice(3,5),16),b=parseInt(col.slice(5,7),16);
  const mix=c=>Math.round(240+(c-240)*i);
  return`rgb(${mix(r)},${mix(g2)},${mix(b)})`;
}
function typeEmoji(g){const i={Ride:'directions_bike',Virtual:'computer',Run:'directions_run',Walk:'directions_walk',Swim:'pool',Other:'bolt'}[g]||'bolt';return`<span class="ms">${i}</span>`;}
// Gear icons come from the sport an item is actually used for, never from its name.
// Both gear views already tally each item's activity types, so a new bike is right on
// its first ride with no edit here — which the old name-matching version could not do.
const GEAR_TYPE_ICON={Ride:'directions_bike',Virtual:'computer',Run:'directions_run',Walk:'directions_walk',Swim:'pool',Other:'bolt'};
function gearIconName(g){return GEAR_TYPE_ICON[g]||'bolt';}
function dominantType(types){
  const e=Object.entries(types||{});
  return e.length?e.sort((a,b)=>b[1]-a[1])[0][0]:'Other';
}
function gearIconTile(group,cls){
  return`<div class="${cls}" style="background:${groupSoft(group)}"><span class="ms" style="color:${groupColor(group)}">${gearIconName(group)}</span></div>`;
}
const GEAR_IMAGE_INDEX={};
Object.entries(GEAR_IMAGES).forEach(([k,v])=>{GEAR_IMAGE_INDEX[gearKey(k)]=v;});
function gearGuessPath(name){
  const slug=gearSlug(name);
  return slug?'gear-images/'+slug+'.jpg':null;
}
function gearPhoto(name){
  const mapped=GEAR_IMAGE_INDEX[gearKey(name)];
  // A raw Strava id is not a product, so never guess a filename from one.
  if(isUnresolvedGear(name))return mapped||null;
  const guess=gearGuessPath(name);
  // A local file beats a hotlink to someone else's CDN. Three entries in the map
  // are remote stopgaps; pointing at the local slug first means dropping the file
  // into gear-images/ is all it takes to retire one, and until then the remote
  // URL is carried on the element as the first fallback.
  if(mapped&&/^https?:/i.test(mapped))return guess||mapped;
  return mapped||guess;
}
// The remote URL to try if the local guess 404s, or nothing.
function gearPhotoFallback(name){
  const mapped=GEAR_IMAGE_INDEX[gearKey(name)];
  return mapped&&/^https?:/i.test(mapped)?mapped:'';
}
// Strava gear ids look like b1234567 / g1234567. The Worker falls back to the raw id when
// the name lookup fails, and cached activity data can still carry one.
function isUnresolvedGear(name){return /^[bg]\d{5,}$/i.test(String(name||''));}
// "Nike · Pegasus 40" rather than making you read it out of the free-text name.
// Only shown when it adds something the name does not already say.
function gearMetaLine(name){
  const m=GEAR_META[name];if(!m)return'';
  const bits=[m.brand,m.model].filter(Boolean);
  if(!bits.length)return'';
  const joined=bits.join(' ');
  if(gearKey(joined)===gearKey(name))return'';
  return ` <span class="gear-brand">· ${escapeHtml(joined)}</span>`;
}
function gearRetiredTag(name){
  const m=GEAR_META[name];
  return m&&m.retired?' <span class="gear-retired-tag">Retired</span>':'';
}
function isRetiredGear(name){const m=GEAR_META[name];return !!(m&&m.retired);}
function gearLabel(name){return isUnresolvedGear(name)?'Unidentified gear':name;}
// Swap a failed photo for its icon tile rather than removing it and collapsing the card.
// A remote fallback gets one attempt first, so a missing local file falls back to
// the hotlink rather than straight to an icon.
function gearPhotoFailed(img){
  const alt=img.dataset.fallback;
  if(alt&&img.src!==alt){img.dataset.fallback='';img.src=alt;return;}
  const d=document.createElement('div');
  d.className=img.dataset.tile||'gear-icon-tile';
  d.style.background=img.dataset.soft||'var(--bg)';
  const s=document.createElement('span');
  s.className='ms';
  s.style.color=img.dataset.colour||'#94a3b8';
  s.textContent=img.dataset.icon||'bolt';
  d.appendChild(s);
  const modal=img.closest('#gearModal');
  img.replaceWith(d);
  // Only now do we know there is no picture for this item — the guessed filename
  // was the last thing to try. Reveal how to supply one.
  if(modal){const h=modal.querySelector('.gear-photo-hint');if(h)h.classList.remove('is-hidden');}
}

// One renderer for both the Summary list and the heatmap day detail. They were written
// separately and drifted: one used Material Symbols for heart and gear, the other literal
// emoji, so the icons changed under you depending on which list you were looking at.
function recentItemHtml(a,showDate){
  const g=typeGroup(a.type);
  const hr=a.hr?' · <span class="ms ms-fill" style="font-size:13px;color:#ef4444">favorite</span> '+Math.round(a.hr)+' bpm':'';
  const gear=a.gear?' · <span class="ms" style="font-size:13px">'+gearIconName(g)+'</span> '+escapeHtml(gearLabel(a.gear).split(' ').slice(0,2).join(' ')):'';
  return`<div class="recent-item${a.id?' act-row-click':''}"${a.id?` data-act="${escapeAttr(a.id)}" tabindex="0" role="button" aria-label="${escapeAttr((a.name||a.type||'Activity')+', '+fmtDate(a.date))}"`:''} style="border-left-color:${groupColor(g)}">
      <div class="recent-info">
        <div class="recent-name">${escapeHtml(a.name||a.type)}</div>
        <div class="recent-meta">${showDate?fmtDate(a.date)+' · ':''}${typeEmoji(g)} ${g}${hr}${gear}</div>
      </div>
      <div class="recent-stats">
        <div class="recent-dist">${a.dist_mi?fmtDist(a.dist_mi)+' '+distUnit():'—'}</div>
        <div class="recent-time">${fmtTime(a.mt)}</div>
      </div>
      ${a.id&&a.has_map?`<a href="https://www.strava.com/activities/${a.id}" target="_blank" rel="noopener noreferrer" class="strava-link">Strava</a>`:''}
    </div>`;
}


// The scope filters run over every activity, and a rolling window needs today's
// date for each one. Computing it per activity is both wasteful and subtly wrong —
// a render that straddles midnight would filter the first half of the list against
// one day and the second half against the next. Cached for a minute instead.
let _todayCache={at:0,val:''};
function _today(){
  const now=Date.now();
  if(now-_todayCache.at>60000){_todayCache={at:now,val:todayISO()};}
  return _todayCache.val;
}

// Called repeatedly within a single render — the Charts tab alone asks for it from
// a dozen places — and each call was a full scan of the history. One cached result
// per (data, scope, sport, day) is enough; the generation counter is what makes a
// refreshed dataset invalidate it rather than a length comparison that a same-size
// refresh would sail through.
let _filterCache={key:null,val:null};
function getFiltered(){
  const t=_today();
  const key=_dataGen+'|'+activeYear+'|'+activeType+'|'+t;
  if(_filterCache.key===key)return _filterCache.val;
  const val=ALL_DATA.filter(a=>scopeIncludes(a.date,activeYear,t)&&typeMatches(a));
  _filterCache={key,val};
  return val;
}
function getFilteredForYear(year){
  return ALL_DATA.filter(a=>a.date.slice(0,4)===year&&typeMatches(a));
}

// Which sports actually happened in the period on screen.
//
// Scoped by period only, never by the sport filter — this is the list the sport
// filter is built from, so filtering it by the current selection would leave a row
// with one button in it. Cached on the same generation key as getFiltered, because
// it walks the whole history and the filter row is rebuilt on every state change.
let _sportsCache={key:null,val:null};
function sportsInScope(){
  const t=_today();
  const key=_dataGen+'|'+activeYear+'|'+t;
  if(_sportsCache.key===key)return _sportsCache.val;
  const val=new Set();
  for(const a of ALL_DATA){
    if(scopeIncludes(a.date,activeYear,t))val.add(typeGroup(a.type));
  }
  _sportsCache={key,val};
  return val;
}

function buildYearStepper(){
  const years=[...new Set(ALL_DATA.map(a=>a.date.slice(0,4)))].sort();
  const mostRecent=years[years.length-1];
  const displayYear=isYearScope(activeYear)?activeYear:mostRecent;
  const idx=years.indexOf(displayYear);
  const allBtn=document.getElementById('yearAll');
  const display=document.getElementById('yearDisplay');
  const prev=document.getElementById('yearPrev');
  const next=document.getElementById('yearNext');
  if(allBtn)allBtn.classList.toggle('active',activeYear==='All');
  document.querySelectorAll('#yearRolling .year-roll').forEach(b=>
    b.classList.toggle('active',b.dataset.period===activeYear));
  if(display)display.textContent=displayYear||'—';
  if(prev)prev.disabled=isYearScope(activeYear)&&idx===0;
  if(next)next.disabled=isYearScope(activeYear)&&idx===years.length-1;
  const sy=document.getElementById('sheetYears');
  if(sy)sy.innerHTML=['All',...ROLLING_ORDER,...years.slice().reverse()].map(y=>
    `<button class="${y===activeYear?'active':''}" data-on-click="setYear" data-args-click='${escapeAttr(JSON.stringify([y]))}'>${escapeHtml(periodLabel(y))}</button>`).join('');
  updateScopeChip();
}
function stepYear(dir){
  const years=[...new Set(ALL_DATA.map(a=>a.date.slice(0,4)))].sort();
  // Stepping off a rolling window lands on the most recent year rather than
  // nowhere — years.indexOf() of '30d' is -1, which used to walk to index 0.
  let idx=isYearScope(activeYear)?years.indexOf(activeYear)+dir:years.length-1+dir;
  idx=Math.max(0,Math.min(years.length-1,idx));
  setYear(years[idx]);
}
// buildTypeFilters as well as buildYearStepper: which sports are on offer now
// depends on the period, so changing the period has to redraw the sport row.
function setYear(y){activeYear=y;buildYearStepper();buildTypeFilters();writeView(false);renderAll();}

const TYPE_GROUPS=['All','Ride','Virtual','Run','Walk','Swim','Other'];
// The sports worth offering for the period on screen. A sport with nothing in it is
// a button whose only effect is to empty the page: 2026 has no swims in it, so 2026
// should not offer Swim.
//
// The exception is the sport already selected, which stays on the row even when the
// period has none of it. A control that deletes itself while it is active leaves the
// page filtered to nothing with no visible way back — and stepping year by year
// through one sport is exactly when you meet an empty year, so dropping the
// selection there would also lose your place. It is marked empty instead, which is
// the honest reading of a page with nothing on it.
function typeFilterGroups(){
  const present=sportsInScope();
  return TYPE_GROUPS.filter(t=>t==='All'||present.has(t)||t===activeType)
    .map(t=>({t,empty:t!=='All'&&!present.has(t)}));
}

function buildTypeFilters(){
  const groups=typeFilterGroups();
  const el=document.getElementById('headerTypeFilters');
  if(el)el.innerHTML=groups.map(({t,empty})=>{
    const dot=t!=='All'?`<span class="type-dot" style="background:${groupColor(t)}"></span>`:'';
    return`<button class="type-btn${t===activeType?' active':''}${empty?' type-btn-empty':''}" data-type="${t}"${
      empty?` title="No ${t.toLowerCase()} activities in this period"`:''} data-on-click="setType" data-args-click='${escapeAttr(JSON.stringify([t]))}'>${dot}${t}</button>`;
  }).join('');
  const st=document.getElementById('sheetTypes');
  if(st)st.innerHTML=groups.map(({t,empty})=>{
    const dot=t!=='All'?`<span class="type-dot" style="background:${groupColor(t)}"></span>`:'';
    return`<button class="${t===activeType?'active':''}${empty?' type-btn-empty':''}" data-on-click="setType" data-args-click='${escapeAttr(JSON.stringify([t]))}'>${dot}${t==='All'?'All sports':t}${empty?' <span class="type-btn-note">none here</span>':''}</button>`;
  }).join('');
  updateScopeChip();
}
function setType(t){activeType=t;buildTypeFilters();writeView(false);renderAll();}

// ── SCOPE CHIP + SHEET (phone) ──
// The chip states the scope in words and is also the control that changes it,
// so the read-only line this used to duplicate can go.
function updateScopeChip(){
  const el=document.getElementById('scopeChipText');if(!el)return;
  const y=periodLabel(activeYear);
  const t=activeType==='All'?'all sports':activeType.toLowerCase();
  el.innerHTML=`${escapeHtml(y)}<span class="scope-chip-sport">· ${escapeHtml(t)}</span>`;
}
// ── SETTINGS MENU ──
// A popover on a desktop, a bottom sheet on a phone — the breakpoint is the same
// 640px the scope panel uses, and below it the CSS takes over positioning entirely.
const SETTINGS_SHEET_MAX=640;

function settingsIsOpen(){
  const m=document.getElementById('settingsMenu');
  return !!(m&&m.classList.contains('open'));
}

function positionSettingsMenu(){
  const menu=document.getElementById('settingsMenu');
  const btn=document.getElementById('settingsBtn');
  if(!menu||!btn)return;
  if(window.innerWidth<=SETTINGS_SHEET_MAX){
    // Let the bottom-sheet rules win; an inline top/right would beat the media query.
    menu.style.top=menu.style.right='';
    return;
  }
  const r=btn.getBoundingClientRect();
  menu.style.top=(r.bottom+6)+'px';
  menu.style.right=Math.max(8,window.innerWidth-r.right)+'px';
}

function openSettings(){
  const menu=document.getElementById('settingsMenu');
  const btn=document.getElementById('settingsBtn');
  if(!menu)return;
  // Name the tab it would act on, and grey the row out where there is nothing to
  // rearrange — better than letting the press be the way you find out.
  const rr=document.getElementById('reorderChartsBtn');
  if(rr){
    const ok=tabIsReorderable(activeTab);
    rr.disabled=!ok;
    const note=document.getElementById('reorderBtnNote');
    if(note)note.textContent=ok?tabName(activeTab):'nothing to move here';
  }
  const notice=document.getElementById('reorderNotice');
  if(notice)notice.hidden=true;
  closeScopeSheet();
  positionSettingsMenu();
  menu.classList.add('open');
  document.getElementById('settingsBackdrop').classList.add('open');
  if(btn){btn.classList.add('open');btn.setAttribute('aria-expanded','true');}
  trapFocus('settingsMenu');
}

function closeSettings(){
  const menu=document.getElementById('settingsMenu');
  const btn=document.getElementById('settingsBtn');
  if(!menu||!menu.classList.contains('open'))return;
  menu.classList.remove('open');
  document.getElementById('settingsBackdrop').classList.remove('open');
  if(btn){btn.classList.remove('open');btn.setAttribute('aria-expanded','false');}
  releaseFocus();
}

function toggleSettings(e){
  if(e&&e.stopPropagation)e.stopPropagation();
  settingsIsOpen()?closeSettings():openSettings();
}

// Reposition rather than close on a resize: closing a panel out from under someone
// who merely rotated their phone is its own small annoyance.
window.addEventListener('resize',()=>{if(settingsIsOpen())positionSettingsMenu();});

// ── PANEL ORDER ──
// Which box sits where is a preference, on every tab that has more than one.
//
// Two concepts, and only two. A ZONE is a container that holds movable things and
// carries `data-zone`; a PANEL is a movable thing inside one and carries
// `data-panel`. A tab may have one zone (the tab itself) or several — the Charts
// tab has three, one per section, so a chart can be moved between Volume and
// Intensity and still be found again.
//
// The order is stored per zone as a list of panel keys, not as indices: adding a
// chart or a section in a later release must not silently renumber a saved order,
// and a panel the saved order has never seen goes back to its default position
// rather than being swept to the end.
//
// There is only ever ONE order per zone. The desktop grid is two columns and the
// phone grid is one, but both read the same sequence — the grid decides the shape,
// the saved list decides the sequence. Holding a separate order per breakpoint is
// the only thing that would make this complicated, and there is no reason to.
const LAYOUT_KEY='fitness_layout_v1';
const LEGACY_CHART_ORDER_KEY='fitness_chart_order_v1';   // charts-only, before this went tab-wide
let reorderOn=false;
let reorderTab=null;          // the tab being edited, so a render elsewhere cannot confuse it
let DEFAULT_LAYOUT=null;

// Scoped to one tab. Reordering is something you do to the page in front of you,
// and a zone on a hidden tab measures zero, which no drag can hit anyway.
function tabEl(tab){return document.getElementById('tab-'+(tab||activeTab));}
function layoutZones(tab){
  const el=tabEl(tab);
  if(!el)return[];
  // The tab element itself counts. A tab with one flat list of panels carries
  // data-zone on the tab, and querySelectorAll only ever looks at descendants —
  // which silently returned no zones at all for Summary and Social.
  const inner=[...el.querySelectorAll('[data-zone]')];
  return el.dataset.zone?[el,...inner]:inner;
}
function panelsIn(zone){return[...zone.children].filter(el=>el.dataset&&el.dataset.panel);}
// Every panel on the tab, in the order it is read. Zones are part of that order, so
// moving off the end of one lands at the start of the next.
function allPanels(tab){return layoutZones(tab).flatMap(panelsIn);}
function tabIsReorderable(tab){return allPanels(tab).length>1;}

// What to call a panel, in the announcement and on its move buttons. Declared
// where the markup already says it once, read from the heading where it does not,
// rather than a third copy of every title to keep in step.
function panelLabel(panel){
  if(panel.dataset.panelLabel)return panel.dataset.panelLabel;
  const t=panel.querySelector('.chart-title,.section-header h2,h2');
  return t?t.textContent.trim():(panel.dataset.panel||'panel');
}

// Captured from the markup the first time a tab is seen and never again: this is
// what Reset goes back to, and where a panel added in a later release gets slotted
// in for someone who already has an order saved. Per tab rather than in one pass,
// because a tab whose markup is generated (Mex) has no zones to read until it has
// been rendered at least once.
function captureDefaultLayout(tab){
  if(!DEFAULT_LAYOUT)DEFAULT_LAYOUT={};
  layoutZones(tab).forEach(z=>{
    if(DEFAULT_LAYOUT[z.dataset.zone])return;
    DEFAULT_LAYOUT[z.dataset.zone]=panelsIn(z).map(p=>p.dataset.panel);
  });
}

function readLayout(){
  const parse=k=>{
    try{
      const raw=JSON.parse(localStorage.getItem(k)||'null');
      return(raw&&typeof raw==='object'&&!Array.isArray(raw))?raw:null;
    }catch(e){return null;}
  };
  const saved=parse(LAYOUT_KEY);
  if(saved)return saved;
  // Before this was tab-wide it only stored the three chart zones, under its own
  // key. The shape is identical, so an order saved then is carried forward rather
  // than being quietly reset by an upgrade.
  const legacy=parse(LEGACY_CHART_ORDER_KEY);
  if(legacy){
    try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(legacy));
        localStorage.removeItem(LEGACY_CHART_ORDER_KEY);}catch(e){}
    return legacy;
  }
  return null;
}

// Merged, never replaced: saving the Summary tab must not wipe the order somebody
// set on Charts, and only the zones currently in the DOM can be read.
function saveLayout(tab){
  const out=readLayout()||{};
  layoutZones(tab).forEach(z=>{out[z.dataset.zone]=panelsIn(z).map(p=>p.dataset.panel);});
  try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(out));}catch(e){}
}

function layoutIsCustom(tab){
  const saved=readLayout();
  if(!saved)return false;
  return layoutZones(tab).some(z=>{
    const want=saved[z.dataset.zone],def=(DEFAULT_LAYOUT||{})[z.dataset.zone];
    return Array.isArray(want)&&def&&want.join('|')!==def.join('|');
  });
}

// Rebuild each zone from `layout`, which need not be complete or correct: keys for
// panels that no longer exist are dropped, and panels the layout never mentions go
// back to their default index rather than being swept to the end, so a panel added
// later arrives where it was designed to sit.
function applyLayout(layout,tab){
  captureDefaultLayout(tab);
  const zones=layoutZones(tab);
  if(!zones.length)return;
  const byKey={};
  zones.forEach(z=>panelsIn(z).forEach(p=>{byKey[p.dataset.panel]=p;}));
  const plan={};
  zones.forEach(z=>{
    const want=layout&&Array.isArray(layout[z.dataset.zone])?layout[z.dataset.zone]:[];
    // De-duplicated as well as filtered: a hand-edited or half-written entry could
    // name the same panel twice, and a panel can only be in one place.
    const seen=new Set();
    plan[z.dataset.zone]=want.filter(k=>{
      if(!byKey[k]||seen.has(k))return false;
      seen.add(k);return true;
    });
  });
  const placed=new Set(Object.values(plan).flat());
  zones.forEach(z=>{
    const def=(DEFAULT_LAYOUT||{})[z.dataset.zone]||[];
    def.forEach((k,i)=>{
      if(placed.has(k)||!byKey[k])return;
      plan[z.dataset.zone].splice(Math.min(i,plan[z.dataset.zone].length),0,k);
      placed.add(k);
    });
  });
  zones.forEach(z=>plan[z.dataset.zone].forEach(k=>z.appendChild(byKey[k])));
}

// Called after every render as well as at boot. Several tabs rebuild their panels
// from scratch on each render — Mex replaces the whole tab — so an order applied
// only once would survive until the first filter change and no longer.
function restoreLayout(tab){
  captureDefaultLayout(tab);
  const saved=readLayout();
  if(saved)applyLayout(saved,tab);
  if(reorderOn)syncReorderButtons();
}

// Every tab whose markup exists in the document. Tabs that generate their own
// panels (Mex) have none until they have been rendered once, which is why
// renderAll calls restoreLayout for the tab it just drew.
function restoreAllLayouts(){
  TAB_ORDER.forEach(t=>{if(tabEl(t))restoreLayout(t);});
}

function resetLayout(){
  const tab=reorderTab||activeTab;
  captureDefaultLayout(tab);
  const saved=readLayout()||{};
  // Only this tab's zones are reset. Reset sits on the bar you are editing with,
  // so it means "put this tab back", not "put everything back".
  layoutZones(tab).forEach(z=>{delete saved[z.dataset.zone];});
  try{
    Object.keys(saved).length?localStorage.setItem(LAYOUT_KEY,JSON.stringify(saved))
                             :localStorage.removeItem(LAYOUT_KEY);
  }catch(e){}
  applyLayout(DEFAULT_LAYOUT,tab);
  buildReorderControls();
  announceReorder('Layout reset to the default for this tab.');
}

// ── Reorder mode ──
// Rebuilt rather than patched, because several tabs replace their panels wholesale
// on a render: a grip attached once would be thrown away with the panel it was on.
function buildReorderControls(){
  const tab=reorderTab||activeTab;
  allPanels(tab).forEach(panel=>{
    if(!panel.querySelector(':scope > .reorder-grip')){
      const grip=document.createElement('div');
      grip.className='reorder-grip';
      grip.setAttribute('aria-hidden','true');
      grip.innerHTML='<span class="ms">drag_indicator</span>';
      panel.insertBefore(grip,panel.firstChild);
    }
    // Injected rather than read out of the panel: a chart card has a .chart-title, a
    // summary panel has a section heading, a hero card has neither. One label
    // element is the only version that looks the same on every tab.
    let name=panel.querySelector(':scope > .reorder-name');
    if(!name){
      name=document.createElement('div');
      name.className='reorder-name';
      panel.insertBefore(name,panel.querySelector(':scope > .reorder-grip').nextSibling);
    }
    name.textContent=panelLabel(panel);
    if(!panel.querySelector(':scope > .reorder-ctl')){
      // Buttons as well as dragging, and not only as a fallback: they are the whole
      // interaction from a keyboard, they are exact where a drag is approximate, and
      // on a phone they are the difference between reordering and fighting the page.
      const ctl=document.createElement('div');
      ctl.className='reorder-ctl';
      ctl.innerHTML='<button type="button" class="reorder-move" data-dir="-1"><span class="ms">arrow_upward</span></button>'+
                    '<button type="button" class="reorder-move" data-dir="1"><span class="ms">arrow_downward</span></button>';
      ctl.querySelectorAll('.reorder-move').forEach(b=>{
        b.addEventListener('click',ev=>{
          ev.stopPropagation();
          movePanel(panel,+b.dataset.dir,true);
        });
      });
      panel.appendChild(ctl);
    }
    // Focusable as a unit as well as through its buttons: with a panel focused the
    // arrow keys move it, which is the keyboard equivalent of picking it up.
    panel.tabIndex=0;
    panel.setAttribute('aria-roledescription','Reorderable panel');
  });
  syncReorderButtons();
}

// The ends of the list are the only place a move is impossible, and the buttons say
// so rather than doing nothing when pressed.
function syncReorderButtons(){
  const tab=reorderTab||activeTab;
  const panels=allPanels(tab);
  panels.forEach((panel,i)=>{
    const label=panelLabel(panel);
    panel.querySelectorAll(':scope > .reorder-ctl .reorder-move').forEach(b=>{
      const back=+b.dataset.dir<0;
      b.disabled=back?i===0:i===panels.length-1;
      b.setAttribute('aria-label',`Move ${label} ${back?'earlier':'later'}`);
    });
  });
  const reset=document.getElementById('reorderResetBtn');
  if(reset)reset.disabled=!layoutIsCustom(tab);
}

function announceReorder(msg){
  const el=document.getElementById('reorderLive');
  if(el)el.textContent=msg;
}

// One linear list across every zone on the tab, so `insertBefore` into the target's
// own parent is all it takes to cross a zone boundary.
function movePanel(panel,dir,announce){
  const tab=reorderTab||activeTab;
  const panels=allPanels(tab);
  const i=panels.indexOf(panel);
  const j=i+dir;
  if(i<0||j<0||j>=panels.length)return false;
  const target=panels[j];
  target.parentNode.insertBefore(panel,dir<0?target:target.nextSibling);
  saveLayout(tab);
  syncReorderButtons();
  if(announce){
    const zone=panel.closest('[data-zone]');
    const within=panelsIn(zone);
    const where=zone.dataset.zoneLabel?` in ${zone.dataset.zoneLabel}`:'';
    announceReorder(`${panelLabel(panel)} moved to position ${within.indexOf(panel)+1} of ${within.length}${where}.`);
  }
  if(panel.focus)panel.focus();
  return true;
}

// Whatever tab you are looking at. Reordering is something you do to the page in
// front of you, so it does not drag you off to the Charts tab the way the first
// version of this did.
function startReorder(){
  closeSettings();
  const tab=activeTab;
  const el=tabEl(tab);
  if(!el)return;
  if(!tabIsReorderable(tab)){
    // Said out loud rather than leaving a pressed button doing nothing. Several tabs
    // are a single thing — a map, a calendar, one table — and there is no
    // arrangement of one box.
    announceReorder('Nothing to rearrange on this tab.');
    flashReorderNotice(`The ${tabName(tab)} tab is one panel — nothing to rearrange here.`);
    return;
  }
  reorderOn=true;
  reorderTab=tab;
  captureDefaultLayout(tab);
  buildReorderControls();
  el.classList.add('reordering');
  const bar=document.getElementById('reorderBar');
  bar.hidden=false;
  const what=document.getElementById('reorderBarWhat');
  if(what)what.textContent=`Rearranging ${tabName(tab)}`;
  syncReorderButtons();
  announceReorder(`Reorder mode on for ${tabName(tab)}. Use the arrow keys on a focused panel, or its move buttons.`);
}

function tabName(tab){
  const btn=document.getElementById('tabbtn-'+tab);
  const lab=btn&&btn.querySelector('.tab-label');
  return lab?lab.textContent.trim():tab;
}

// A one-off line under the settings button for the tabs that have nothing to move.
function flashReorderNotice(msg){
  const el=document.getElementById('reorderNotice');
  if(!el)return;
  el.textContent=msg;
  el.hidden=false;
  clearTimeout(flashReorderNotice._t);
  flashReorderNotice._t=setTimeout(()=>{el.hidden=true;},4000);
}

// `leaving` is set when the tab is changing underneath us: the charts are about to
// be hidden and repainted by setTab anyway, and stealing focus back to the settings
// button would take it off the tab the user just pressed.
function endReorder(leaving){
  if(!reorderOn)return;
  const tab=reorderTab||activeTab;
  const el=tabEl(tab);
  reorderOn=false;
  cancelChartDrag();
  saveLayout(tab);
  if(el)el.classList.remove('reordering');
  const bar=document.getElementById('reorderBar');
  if(bar)bar.hidden=true;
  allPanels(tab).forEach(p=>{p.removeAttribute('tabindex');p.removeAttribute('aria-roledescription');});
  announceReorder('Reorder mode off.');
  reorderTab=null;
  if(leaving)return;
  // Every canvas on the tab has been display:none the whole time and Chart.js has
  // been sizing itself from a box that was 0×0. Re-render, then resize on the next
  // frame, once the wrappers have a height again.
  if(ALL_DATA&&ALL_DATA.length)renderAll();
  requestAnimationFrame(()=>{
    Object.keys(charts).forEach(k=>{try{charts[k]&&charts[k].resize();}catch(e){}});
  });
  const btn=document.getElementById('settingsBtn');
  if(btn&&btn.focus)btn.focus();
}

// ── Dragging ──
// Pointer events rather than HTML5 drag-and-drop, which does not fire on touch at
// all. One code path for the mouse, the finger and the stylus.
let _dragCard=null,_dragGhost=null,_dragDX=0,_dragDY=0;
let _dragX=0,_dragY=0,_dragStartX=0,_dragStartY=0,_dragLive=false,_dragRAF=0;
const DRAG_SLOP=6;      // px before a press becomes a drag rather than a tap
const DRAG_EDGE=90;     // px from the viewport edge where the page starts scrolling

function cancelChartDrag(){
  if(_dragGhost&&_dragGhost.parentNode)_dragGhost.parentNode.removeChild(_dragGhost);
  if(_dragCard)_dragCard.classList.remove('dragging');
  if(_dragRAF)cancelAnimationFrame(_dragRAF);
  _dragGhost=null;_dragCard=null;_dragLive=false;_dragRAF=0;
}

document.addEventListener('pointerdown',e=>{
  if(!reorderOn||_dragCard)return;
  if(e.button!=null&&e.button!==0)return;
  if(e.target.closest('button'))return;          // the move buttons are not handles
  const card=e.target.closest('[data-panel]');
  if(!card)return;
  _dragCard=card;
  _dragStartX=_dragX=e.clientX;_dragStartY=_dragY=e.clientY;
  const r=card.getBoundingClientRect();
  _dragDX=e.clientX-r.left;_dragDY=e.clientY-r.top;
  // Capture on the card, so a finger that outruns the element still sends us moves.
  try{card.setPointerCapture(e.pointerId);}catch(_){}
});

document.addEventListener('pointermove',e=>{
  if(!_dragCard)return;
  _dragX=e.clientX;_dragY=e.clientY;
  if(!_dragLive){
    if(Math.abs(_dragX-_dragStartX)<DRAG_SLOP&&Math.abs(_dragY-_dragStartY)<DRAG_SLOP)return;
    beginChartDrag();
  }
  e.preventDefault();
  positionDragGhost();
  reorderToPointer(_dragX,_dragY);
});

function beginChartDrag(){
  _dragLive=true;
  const r=_dragCard.getBoundingClientRect();
  // Built rather than cloned. The ghost has to be a child of <body> to be positioned
  // against the viewport, which puts it outside `#tab-charts.reordering` and so
  // outside every rule that makes a card compact — a clone would spring back to full
  // height, canvas and all, the moment it left the tab. Two elements and a title is
  // the whole of what is being dragged anyway.
  _dragGhost=document.createElement('div');
  _dragGhost.className='reorder-ghost';
  _dragGhost.setAttribute('aria-hidden','true');
  _dragGhost.innerHTML='<div class="reorder-grip"><span class="ms">drag_indicator</span></div>'+
                       '<div class="chart-title"></div>';
  _dragGhost.querySelector('.chart-title').textContent=panelLabel(_dragCard);
  _dragGhost.style.width=r.width+'px';
  _dragGhost.style.height=r.height+'px';
  document.body.appendChild(_dragGhost);
  _dragCard.classList.add('dragging');
  positionDragGhost();
  // Held still against the top or bottom of the screen, a finger sends no further
  // move events — so the scroll has to run on its own clock, not on theirs.
  const tick=()=>{
    if(!_dragLive)return;
    const h=window.innerHeight;
    let dy=0;
    if(_dragY<DRAG_EDGE)dy=-Math.ceil((DRAG_EDGE-_dragY)/5);
    else if(_dragY>h-DRAG_EDGE)dy=Math.ceil((_dragY-(h-DRAG_EDGE))/5);
    if(dy){window.scrollBy(0,dy);reorderToPointer(_dragX,_dragY);}
    _dragRAF=requestAnimationFrame(tick);
  };
  _dragRAF=requestAnimationFrame(tick);
}

function positionDragGhost(){
  if(!_dragGhost)return;
  _dragGhost.style.transform=`translate(${_dragX-_dragDX}px,${_dragY-_dragDY}px)`;
}

// Where the pointer is now, expressed as a place in the list.
//
// Nearest card rather than the card under the pointer. A hit test has three dead
// zones — the gutter between cards, the section heading between two sections, and
// the dragged card itself, which is still sitting in the grid under your finger —
// and in all three nothing happens, so the card sticks and then jumps. Distance to
// the nearest rectangle has none of them: there is always an answer, and the answer
// changes exactly when you cross a card's midpoint.
function reorderToPointer(x,y){
  if(!_dragCard)return;
  let target=null,best=Infinity;
  for(const c of allPanels(reorderTab)){
    if(c===_dragCard||!c.offsetParent)continue;
    const b=c.getBoundingClientRect();
    const dx=Math.max(b.left-x,0,x-b.right),dy=Math.max(b.top-y,0,y-b.bottom);
    const d=dx*dx+dy*dy;
    if(d<best){best=d;target=c;}
  }
  if(!target)return;
  const zone=target.closest('[data-zone]');
  if(!zone)return;
  // Which axis settles it is read off the grid itself, which is the whole of the
  // mobile story: the media query drops the section to one column, `cols` becomes 1,
  // and the test is purely vertical without a second code path to keep in step.
  const cols=getComputedStyle(zone).gridTemplateColumns.split(' ').filter(Boolean).length;
  const r=target.getBoundingClientRect();
  // A half-width card sharing a line has a left half and a right half that mean
  // different positions; a full-width one, or one you are above or below rather
  // than beside, only has a top and a bottom.
  const sideBySide=cols>1&&r.width<zone.getBoundingClientRect().width-4&&y>=r.top&&y<=r.bottom;
  const after=sideBySide?(x>r.left+r.width/2):(y>r.top+r.height/2);
  const parent=target.parentNode;
  const ref=after?target.nextSibling:target;
  if(ref===_dragCard)return;
  if(_dragCard.parentNode===parent&&_dragCard.nextSibling===ref)return;
  parent.insertBefore(_dragCard,ref);
}

function finishChartDrag(e){
  if(!_dragCard)return;
  const card=_dragCard,moved=_dragLive;
  // One last placement from where the finger actually left the screen. A pointerup
  // can land further on than the last pointermove reported, and the position you let
  // go at is the one you meant.
  if(moved&&e&&e.clientX!=null)reorderToPointer(e.clientX,e.clientY);
  cancelChartDrag();
  if(!moved)return;
  saveLayout(reorderTab);
  syncReorderButtons();
  const zone=card.closest('[data-zone]');
  if(zone){
    const within=panelsIn(zone);
    const where=zone.dataset.zoneLabel?` in ${zone.dataset.zoneLabel}`:'';
    announceReorder(`${panelLabel(card)} moved to position ${within.indexOf(card)+1} of ${within.length}${where}.`);
  }
}
document.addEventListener('pointerup',finishChartDrag);
document.addEventListener('pointercancel',()=>{const c=_dragCard;cancelChartDrag();if(c)restoreLayout(reorderTab);});

// Arrow keys on a focused card. Left/right as well as up/down because on a desktop
// two cards on the same line read as side by side, and a user who thinks in columns
// should not have to translate that into "one step back in the list".
document.addEventListener('keydown',e=>{
  if(!reorderOn)return;
  const card=e.target&&e.target.closest&&e.target.closest('[data-panel]');
  if(!card||e.target.closest('button'))return;
  let dir=0;
  if(e.key==='ArrowUp'||e.key==='ArrowLeft')dir=-1;
  else if(e.key==='ArrowDown'||e.key==='ArrowRight')dir=1;
  else return;
  e.preventDefault();
  movePanel(card,dir,true);
});

function openScopeSheet(){
  document.getElementById('scopeBackdrop').classList.add('open');
  document.getElementById('scopeSheet').classList.add('open');
  document.getElementById('scopeChip').classList.add('open');
  trapFocus('scopeSheet');
}
function closeScopeSheet(){
  document.getElementById('scopeBackdrop').classList.remove('open');
  document.getElementById('scopeSheet').classList.remove('open');
  document.getElementById('scopeChip').classList.remove('open');
  releaseFocus();
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.getElementById('scopeSheet').classList.contains('open'))closeScopeSheet();
});

const TAB_ORDER=['summary','map','charts','heatmap','records','mex','social','gear','log','zwift'];
function setTab(tab,dir,fromPop){
  // Leaving the charts ends the edit: the bar is fixed to the viewport and would
  // otherwise sit over the Heatmap offering to reorder something that isn't there.
  if(reorderOn&&tab!==reorderTab)endReorder(true);
  if(tab==='mex'&&activeTab!=='mex')mexAnimate=true;
  // A replay left running on a tab you cannot see is a requestAnimationFrame loop
  // burning battery for nothing.
  if(activeTab==='map'&&tab!=='map'&&typeof stopReplay==='function')stopReplay();
  activeTab=tab;
  // Roving tabindex: exactly one tab is in the document's tab order, and the arrow
  // keys move between them. Ten tabs each taking a Tab press is the thing that makes
  // a tab strip unusable from the keyboard.
  document.querySelectorAll('#tabRow .tab-btn').forEach((b,i)=>{
    const on=TAB_ORDER[i]===tab;
    b.classList.toggle('active',on);
    b.setAttribute('aria-selected',on?'true':'false');
    b.tabIndex=on?0:-1;
  });
  document.querySelectorAll('.tab-content').forEach(d=>{
    d.classList.remove('active','enter-from-left','enter-from-right');
    d.hidden=true;
  });
  const el=document.getElementById('tab-'+tab);
  el.classList.add('active');
  el.hidden=false;
  if(dir){
    const cls=dir==='next'?'enter-from-right':'enter-from-left';
    el.classList.add(cls);
    el.addEventListener('animationend',()=>el.classList.remove(cls),{once:true});
  }
  // The tab strip is the navigation now, so a tab reached by swiping has to be
  // scrolled back into view or you lose track of where you are.
  const activeBtn=document.querySelector('#tabRow .tab-btn.active');
  if(activeBtn&&activeBtn.scrollIntoView)activeBtn.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
  // Map and Zwift return before renderAll(), so the scope line has to be refreshed
  // here too — otherwise they inherit whatever the previous tab was showing.
  renderScope();
  // Skipped when the change came from the back button, which is already at the
  // right URL — pushing again would trap you in the history.
  if(!fromPop)writeView(true);
  if(tab==='map'){renderMap(activeType==='All'?ALL_DATA:ALL_DATA.filter(a=>mapFilterMatches(a)));return;}
  if(tab==='zwift'){loadZwiftRoutes();return;}
  renderAll();
  // After the render, not before — renderAll replaces the grid's innerHTML, which
  // would wipe an animation started on the previous tab's cards.
  staggerCards(el);
}
// Arrow keys, Home and End move through the tab strip, per the WAI-ARIA tabs
// pattern. Activation follows focus, which is the right choice here: every panel
// is already rendered client-side, so there is nothing to wait for.
function focusTab(i){
  const btns=[...document.querySelectorAll('#tabRow .tab-btn')];
  if(!btns.length)return;
  const wrapped=(i+btns.length)%btns.length;
  setTab(TAB_ORDER[wrapped]);
  btns[wrapped].focus();
}
document.addEventListener('keydown',e=>{
  const btn=e.target.closest&&e.target.closest('#tabRow .tab-btn');
  if(!btn)return;
  const btns=[...document.querySelectorAll('#tabRow .tab-btn')];
  const i=btns.indexOf(btn);
  const key=e.key;
  if(key==='ArrowRight'||key==='ArrowDown')      {e.preventDefault();focusTab(i+1);}
  else if(key==='ArrowLeft'||key==='ArrowUp')    {e.preventDefault();focusTab(i-1);}
  else if(key==='Home')                          {e.preventDefault();focusTab(0);}
  else if(key==='End')                           {e.preventDefault();focusTab(btns.length-1);}
});

function setUnit(u){unit=u;document.querySelectorAll('.unit-opt').forEach(b=>b.classList.toggle('active',b.dataset.unit===u));writeView(false);renderAll();}

// Put the whole view on screen at once, from a URL or from the back button.
function applyView(v,fromPop){
  unit=v.unit;
  document.querySelectorAll('.unit-opt').forEach(b=>b.classList.toggle('active',b.dataset.unit===unit));
  activeYear=v.year;activeType=v.type;
  buildYearStepper();buildTypeFilters();
  setTab(v.tab,null,fromPop);
}
window.addEventListener('popstate',()=>{
  if(!ALL_DATA||!ALL_DATA.length)return;
  applyView(readView(),true);
});

// ── SWIPE BETWEEN TABS ──
(function(){
  const main=document.querySelector('.main');
  if(!main)return;
  function insideHorizontalScroller(el){
    while(el&&el!==main){
      if(el.scrollWidth>el.clientWidth+2&&/(auto|scroll)/.test(getComputedStyle(el).overflowX))return true;
      el=el.parentElement;
    }
    return false;
  }
  let sx=0,sy=0,tracking=false;
  main.addEventListener('touchstart',e=>{
    // Dragging a card sideways across the grid is a horizontal swipe by any other
    // measure, and would otherwise throw you onto the Heatmap tab mid-reorder.
    if(e.touches.length!==1||reorderOn||insideHorizontalScroller(e.target)){tracking=false;return;}
    sx=e.touches[0].clientX;sy=e.touches[0].clientY;tracking=true;
  },{passive:true});
  main.addEventListener('touchend',e=>{
    if(!tracking)return;
    tracking=false;
    const dx=e.changedTouches[0].clientX-sx;
    const dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)<60||Math.abs(dx)<Math.abs(dy)*1.5)return;
    const idx=TAB_ORDER.indexOf(activeTab);
    if(dx<0&&idx<TAB_ORDER.length-1)setTab(TAB_ORDER[idx+1],'next');
    else if(dx>0&&idx>0)setTab(TAB_ORDER[idx-1],'prev');
  },{passive:true});
})();

// ── SUMMARY ──
function renderSummary(){
  const data=getFiltered();
  const accent=getAccentColor();
  const totalDist=data.reduce((s,a)=>s+(a.dist_mi||0),0);
  const totalTime=data.reduce((s,a)=>s+(a.mt||0),0);
  const totalElv=data.reduce((s,a)=>s+(a.elv||0),0);
  // Eddington: max E where ≥E days had ≥E miles
  const datesDist={};data.forEach(a=>{datesDist[a.date]=(datesDist[a.date]||0)+(a.dist_mi||0);});
  const distsSorted=Object.values(datesDist).sort((a,b)=>b-a);
  let eddington=0;for(let i=0;i<distsSorted.length;i++){if(distsSorted[i]>=i+1)eddington=i+1;else break;}

  // A year-on-year delta used to be computed here for a line under Total Distance.
  // That line has since moved to the cumulative chart, which does the comparison
  // properly — same day of year on both sides — and this was left behind computing
  // it for nobody: two more passes over the filtered history plus a full pass over
  // the previous year, every render, feeding a string that was never printed. Lint
  // found the string; the string was the only thing holding the rest up.
  const spanYears=new Set(data.map(a=>a.date.slice(0,4))).size;
  // Same figure the Mex tab shows, over the same filtered set, so the two never disagree.
  const summaryMex=mexOf(mexBuckets(data));

  // The career totals, demoted from eleven equal cards to one line.
  //
  // Two of the eleven are gone rather than moved. "Avg Speed" was a mean across
  // swims, dog walks and centuries, and "Avg Heart Rate" the same across every
  // sport: numbers that describe no activity you have ever done. The per-sport row
  // above is what replaces them. Longest Ride, Longest Run and Eddington are not
  // repeated here either — they are the Records tab's headline, and this page links
  // there rather than restating it.
  const careerFigs=[
    [fmtDist(totalDist)+' '+distUnit(), activeYear==='All'?`logged over ${spanYears} year${spanYears===1?'':'s'}`:periodPhrase(activeYear)],
    [data.length.toLocaleString('en-GB'), 'activities'],
    [fmtNum(totalTime/3600)+' h', 'moving'],
    [fmtNum(fmtElevVal(totalElv))+fmtElevUnit(), 'climbed'],
    [String(eddington), 'Eddington'],
    [summaryMex+' '+distUnit(), 'Mex'],
  ];
  document.getElementById('heroStats').outerHTML=`<div class="sum-career" id="heroStats">
    <div class="stat-label" style="margin:0 4px 0 0">${escapeHtml(periodLabel(activeYear))}</div>
    ${careerFigs.map(([n,l],k)=>
      `<div class="sum-career-fig"><b>${n}</b><span>${l}</span></div>`+
      (k===careerFigs.length-1?'':'<div class="sum-career-sep"></div>')).join('')}
    <div style="margin-left:auto;display:flex;gap:14px">
      <a href="#" data-on-click="setTabFromLink" data-args-click='["records"]' style="font-size:11px;font-weight:600;color:var(--accent)">Records →</a>
      <a href="#" data-on-click="setTabFromLink" data-args-click='["mex"]' style="font-size:11px;font-weight:600;color:var(--accent)">Mex →</a>
    </div>
  </div>`;

  renderSummaryNow(data);

  // Type cards
  const groups={};
  data.forEach(a=>{const g=typeGroup(a.type);if(!groups[g])groups[g]={count:0,dist:0,time:0};groups[g].count++;groups[g].dist+=a.dist_mi||0;groups[g].time+=a.mt||0;});
  document.getElementById('typeCards').innerHTML=Object.entries(groups).sort((a,b)=>b[1].dist-a[1].dist).map(([g,s])=>`
    <div class="type-card">
      <div class="type-icon" style="background:${groupSoft(g)};color:${groupColor(g)}">${typeEmoji(g)}</div>
      <div class="type-info">
        <div class="type-name" style="color:${groupColor(g)}">${g}</div>
        <div class="type-count">${s.count.toLocaleString('en-GB')} activities · ${fmtTime(s.time)}</div>
        <div class="type-dist">${fmtDist(s.dist)} <small>${distUnit()}</small></div>
      </div>
    </div>`).join('');

  // DOW
  const dayMap={Monday:0,Tuesday:1,Wednesday:2,Thursday:3,Friday:4,Saturday:5,Sunday:6};
  const dowCounts=[0,0,0,0,0,0,0];
  data.forEach(a=>{const i=dayMap[a.dow];if(i!=null)dowCounts[i]++;});
  const maxDow=Math.max(...dowCounts),minDow=Math.min(...dowCounts.filter(v=>v>0))||0,range=maxDow-minDow;
  document.getElementById('dowBars').innerHTML=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d,i)=>{
    const pct=range>0?12+((dowCounts[i]-minDow)/range)*88:50;
    return`<div class="dow-col"><div class="dow-bar-wrap"><div class="dow-bar" style="height:${pct.toFixed(1)}%;background:${accent}"></div></div><div class="dow-label">${d}</div><div class="dow-count">${dowCounts[i].toLocaleString('en-GB')}</div></div>`;
  }).join('');

  // Year table with early years toggle. Sports with nothing anywhere in the table
  // lose their column rather than ruling a line of em dashes down the page.
  const presentHere=new Set(data.map(a=>typeGroup(a.type)));
  const typeKeys=['Ride','Virtual','Run','Walk','Swim','Other'].filter(t=>presentHere.has(t));
  const allYears=[...new Set(data.map(a=>a.date.slice(0,4)))].sort().reverse();
  const recentYears=allYears.filter(y=>parseInt(y)>=2019);
  const earlyYears=allYears.filter(y=>parseInt(y)<2019);
  function yearRow(y){
    const yd=data.filter(a=>a.date.slice(0,4)===y);
    const byType={};yd.forEach(a=>{const g=typeGroup(a.type);byType[g]=(byType[g]||0)+(a.dist_mi||0);});
    const totalT=yd.reduce((s,a)=>s+(a.mt||0),0),totalE=yd.reduce((s,a)=>s+(a.elv||0),0),totalC=yd.reduce((s,a)=>s+(a.cal||0),0);
    return`<tr><td style="font-weight:700">${y}</td><td>${yd.length.toLocaleString('en-GB')}</td>${typeKeys.map(t=>`<td>${byType[t]?fmtDist(byType[t]):'—'}</td>`).join('')}<td>${fmtTime(totalT)}</td><td>${fmtElv(totalE)}</td><td>${fmtNum(totalC)}</td></tr>`;
  }
  const typeDotColors={Ride:'#1d4ed8',Virtual:'#8b5cf6',Run:'#ef4444',Walk:'#eab308',Swim:'#0ea5e9',Other:'#94a3b8'};
  const th=`<tr><th>Year</th><th>Acts</th>${typeKeys.map(t=>`<th><span style="display:inline-block;width:8px;height:8px;border-radius:0;background:${typeDotColors[t]||'#94a3b8'};margin-right:4px;vertical-align:middle"></span>${t} (${distUnit()})</th>`).join('')}<th>Time</th><th>Elev</th><th>Cal</th></tr>`;
  const earlyHtml=earlyYears.length?`
    <tbody id="earlyYearsBody" style="display:none">${earlyYears.map(yearRow).join('')}</tbody>
    <tbody><tr><td colspan="${typeKeys.length+5}" class="early-years-toggle" data-on-click="toggleEarlyYears" id="earlyYearsToggleRow">▶ Show earlier years (2013–2018)</td></tr></tbody>`:'';
  const allYearsForTable=[...new Set(data.map(a=>a.date.slice(0,4)))].sort().reverse();
  const totActs=allYearsForTable.reduce((s,y)=>s+data.filter(a=>a.date.slice(0,4)===y).length,0);
  const totByType={};typeKeys.forEach(t=>{totByType[t]=data.filter(a=>typeGroup(a.type)===t).reduce((s,a)=>s+(a.dist_mi||0),0);});
  const totT=data.reduce((s,a)=>s+(a.mt||0),0),totE=data.reduce((s,a)=>s+(a.elv||0),0),totC=data.reduce((s,a)=>s+(a.cal||0),0);
  const totRow=`<tfoot><tr style="border-top:2px solid var(--border);font-weight:700;background:var(--bg)"><td>Total</td><td>${totActs.toLocaleString('en-GB')}</td>${typeKeys.map(t=>`<td>${totByType[t]?fmtDist(totByType[t]):'—'}</td>`).join('')}<td>${fmtTime(totT)}</td><td>${fmtElv(totE)}</td><td>${fmtNum(totC)}</td></tr></tfoot>`;
  document.getElementById('yearTable').innerHTML=`<thead>${th}</thead><tbody>${recentYears.map(yearRow).join('')}</tbody>${earlyHtml}${totRow}`;

  // Top gear
  const gearMap={};
  data.forEach(a=>{const g=a.gear;if(!g)return;if(!gearMap[g])gearMap[g]={dist:0,count:0,types:{}};gearMap[g].dist+=a.dist_mi||0;gearMap[g].count++;const t=typeGroup(a.type);gearMap[g].types[t]=(gearMap[g].types[t]||0)+1;});
  const topGear=Object.entries(gearMap).sort((a,b)=>b[1].dist-a[1].dist).slice(0,10);
  document.getElementById('topGearList').innerHTML=topGear.map(([name,s],i)=>{
    const grp=dominantType(s.types);
    const img=gearPhoto(name);
    return`
    <div class="top-gear-row">
      <div class="top-gear-rank">${i+1}</div>
      ${img?`<img class="top-gear-photo" src="${escapeAttr(img)}" alt="${escapeAttr(name)}" loading="lazy" data-tile="gear-icon-inline" data-soft="${groupSoft(grp)}" data-colour="${groupColor(grp)}" data-icon="${gearIconName(grp)}" data-fallback="${escapeAttr(gearPhotoFallback(name))}" data-on-error="gearPhotoFailed" data-args-error='["$el"]'>`:gearIconTile(grp,'gear-icon-inline')}
      <div class="top-gear-name">${escapeHtml(gearLabel(name))}</div>
      <div class="top-gear-dist">${fmtDist(s.dist)} ${distUnit()} · ${s.count.toLocaleString('en-GB')} acts</div>
    </div>`;}).join('')+'<button class="gear-view-all" data-on-click="setTab" data-args-click="[&quot;gear&quot;]">View all gear →</button>';

  // Recent
  const recentAll=[...data].reverse();
  const recentCount=recentShowAll?30:15;
  const recent=recentAll.slice(0,recentCount);
  document.getElementById('recentList').innerHTML=recent.map(a=>recentItemHtml(a,true)).join('');
  // View more / go to log
  const recentMoreHtml=recentAll.length>15?(
    !recentShowAll?
    `<button class="view-more-btn" data-on-click="showAllRecent">▼ View more activities (${Math.min(recentAll.length,30)-15} more)</button>`:
    `<button class="go-log-btn" data-on-click="setTab" data-args-click='["log"]'>→ Open Activity Log${activeType!=='All'?' (filtered: '+activeType+')':''}</button>`
  ):'';
  document.getElementById('recentMoreWrap').innerHTML=recentMoreHtml;
}

function toggleEarlyYears(){
  const body=document.getElementById('earlyYearsBody');
  const row=document.getElementById('earlyYearsToggleRow');
  if(!body)return;
  const hidden=body.style.display==='none';
  body.style.display=hidden?'':'none';
  row.textContent=hidden?'▼ Hide earlier years (2013–2018)':'▶ Show earlier years (2013–2018)';
}

// ── THE PRESENT-TENSE SUMMARY ──
// The page used to open on eleven equal cards of career totals, so nothing was read
// and none of it was about now: a lifetime distance moves by about a twentieth of a
// percent per session, which is to say it cannot tell you anything about this week.
// Those totals are still here, on one line at the bottom. What leads is the week.
//
// Nothing below averages across sports. Two of the old cards — a mean speed and a
// mean heart rate taken across swims, dog walks and centuries — described no activity
// anyone had ever done, which is the defect the per-sport row exists to answer.

// Hours per week, over a trailing window ending today.
function sumWindowHours(data,days,endMs){
  const byDay={};
  data.forEach(a=>{byDay[a.date]=(byDay[a.date]||0)+(a.mt||0);});
  let t=0;
  for(let k=0;k<days;k++)t+=byDay[new Date(endMs-k*86400000).toISOString().slice(0,10)]||0;
  return t/3600;
}

// "an 11.2 hour base", not "a". Eight, eleven and eighteen are the figures that read
// with a vowel sound however they are spelled.
// The group names are labels, not nouns you can drop into a sentence.
const SPORT_PLURAL={Ride:'rides',Run:'runs',Virtual:'virtual rides',Walk:'walks',
  Swim:'swims',Other:'other sessions'};

function renderSummaryNow(data){
  const today=new Date().toISOString().slice(0,10);
  const endMs=new Date(today+'T12:00:00').getTime();
  const a7=sumWindowHours(data,7,endMs);
  const c28=sumWindowHours(data,28,endMs)/4;   // ÷4 puts 28 days on a weekly scale
  const ratio=c28>0?a7/c28:0;

  // ── Hero figure ──
  const bigEl=document.getElementById('sumWeekHours');
  if(bigEl)bigEl.innerHTML=`${a7.toFixed(1)}<span class="sum-big-unit">hours</span>`;
  const baseEl=document.getElementById('sumWeekBase');
  if(baseEl)baseEl.textContent=c28>0
    ? `against ${artFor(c28.toFixed(1))} ${c28.toFixed(1)} h/week base built over the last 28 days`
    : 'no training in the last 28 days to compare against';
  const ratioEl=document.getElementById('sumWeekRatio');
  if(ratioEl){
    if(!c28){ratioEl.innerHTML='';}
    else{
      const [col,word]=ratioTone(ratio);
      ratioEl.innerHTML=`<div class="sum-ratio" style="color:${col};background:${col}1a">`+
        `<strong>${ratio.toFixed(2)}×</strong> ${word}</div>`;
    }
  }

  renderLoad(data,SUM_LOAD_TARGET);
  renderWeekDistance(data,SUM_DIST_TARGET);
  renderCumulative(data,SUM_CUM_TARGET);

  // ── Consistency: days trained out of the last 28, plus the streaks ──
  const trained=new Set(data.map(a=>a.date));
  const cells=[];
  for(let k=27;k>=0;k--)cells.push(trained.has(new Date(endMs-k*86400000).toISOString().slice(0,10)));
  const active=cells.filter(Boolean).length;
  const streak=recLongestStreak(data);
  const cur=recCurrentStreak(data,today);
  const consEl=document.getElementById('sumConsistency');
  if(consEl)consEl.innerHTML=
    `<div class="stat-value" style="font-size:34px;margin-top:12px">${active}`+
      `<span class="stat-unit" style="font-size:15px">of 28 days</span></div>`+
    `<div class="chart-sub" style="margin:6px 0 0">You trained on ${Math.round(active/28*100)}% of them</div>`+
    `<div class="sum-cal">${cells.map(x=>
      `<i style="background:${x?getAccentColor():'var(--border)'}"></i>`).join('')}</div>`+
    `<div class="sum-cal-ends"><span>4 weeks ago</span><span>today</span></div>`+
    `<div class="sum-streaks">`+
      `<div><div style="font-size:16px;font-weight:700">${cur} day${cur===1?'':'s'}</div>`+
        `<div class="chart-sub" style="margin:0">current streak</div></div>`+
      `<div style="text-align:right"><div style="font-size:16px;font-weight:700">`+
        `${streak?streak.len+' day'+(streak.len===1?'':'s'):'—'}</div>`+
        `<div class="chart-sub" style="margin:0">${streak?(streak.current?'longest — still running':'longest, '+fmtDate(streak.to)):'no streak yet'}</div></div>`+
    `</div>`;

  // ── Per sport, never averaged together ──
  const groups=['Ride','Run','Virtual','Walk','Swim','Other'];
  const thisYear=new Date().getFullYear().toString();
  const doyNow=todayDoy();
  const cards=[];
  groups.forEach(g=>{
    const all=ALL_DATA.filter(a=>typeGroup(a.type)===g);
    if(!all.length)return;
    const wk=sumWindowHours(all,7,endMs);
    const base=sumWindowHours(all,28,endMs)/4;
    const wkDist=all.filter(a=>a.date>new Date(endMs-7*86400000).toISOString().slice(0,10))
      .reduce((s,a)=>s+(a.dist_mi||0),0);
    const ytd=all.filter(a=>a.date.slice(0,4)===thisYear).reduce((s,a)=>s+(a.dist_mi||0),0);
    // Like for like: last year counted only as far into the year as today.
    const prev=all.filter(a=>a.date.slice(0,4)===String(+thisYear-1)&&dayOfYear(a.date)<=doyNow)
      .reduce((s,a)=>s+(a.dist_mi||0),0);
    const d=prev>0?Math.round((ytd-prev)/prev*100):null;
    cards.push({g,wk,base,wkDist,ytd,d,n:all.length});
  });
  cards.sort((x,y)=>y.n-x.n);
  const badge=document.getElementById('sumSportBadge');
  if(badge)badge.textContent='Week to '+fmtDate(today);
  const wrap=document.getElementById('sumSportCards');
  if(wrap)wrap.innerHTML=cards.slice(0,5).map(c=>{
    const col=groupColor(c.g);
    return`<div class="sum-sport-card" style="border-top-color:${col}">
      <div class="sum-sport-head">
        <span class="ms" style="color:${col}">${gearIconName(c.g)}</span>
        <span class="sum-sport-name" style="color:${col}">${c.g}</span>
      </div>
      <div class="sum-sport-big">${c.wk.toFixed(1)}h</div>
      <div class="chart-sub" style="margin:4px 0 0">this week${c.wkDist>0?' · '+fmtDist(c.wkDist)+' '+distUnit():''}</div>
      <div class="sum-sport-rows">
        <div class="sum-sport-row"><span>28-day base</span><span>${c.base.toFixed(1)}h/wk</span></div>
        <div class="sum-sport-row"><span>${thisYear} so far</span><span>${fmtDist(c.ytd)} ${distUnit()}</span></div>
        <div class="sum-sport-row"><span>on last year</span><span style="color:${
          c.d==null?'var(--text-muted)':c.d>=0?'#16a34a':'#dc2626'}">${
          c.d==null?'—':(c.d>=0?'+':'')+c.d+'%'}</span></div>
      </div>
    </div>`;}).join('');

  // ── The band. One line across all three signals, which is the only thing it says
  //    that the hero's own verdict does not. ──
  const band=document.getElementById('sumBand');
  if(band){
    const ytdAll=cards.reduce((s,c)=>s+c.ytd,0);
    const prevAll=ALL_DATA.filter(a=>a.date.slice(0,4)===String(+thisYear-1)&&dayOfYear(a.date)<=doyNow)
      .reduce((s,a)=>s+(a.dist_mi||0),0);
    const yd=prevAll>0?Math.round((ytdAll-prevAll)/prevAll*100):null;
    // Which sport moved furthest from its own base — the "what is missing" clause.
    const moved=cards.filter(c=>c.base>0.2).sort((x,y)=>(x.wk-x.base)-(y.wk-y.base))[0];
    if(!c28){band.innerHTML='';}
    else{
      const state=ratio>1.3?'building':ratio<0.8?'backing off':'holding steady';
      const stateCol=ratio>1.3?'#b45309':ratio<0.8?'#b45309':'#16a34a';
      const yearBit=yd==null?'':
        ` and <span style="color:${yd>=0?'#16a34a':'#dc2626'}">${Math.abs(yd)}% ${yd>=0?'ahead of':'behind'}</span> `+
        `where you stood this time last year`;
      const sportBit=(moved&&moved.wk<moved.base*0.7)
        ? ` It is the <span style="color:${groupColor(moved.g)}">${SPORT_PLURAL[moved.g]||moved.g.toLowerCase()}</span> that are missing.`
        : '';
      band.innerHTML=`<span class="ms">insights</span><div class="sum-band-text">You are `+
        `<span style="color:${stateCol}">${state}</span> — ${a7.toFixed(1)} hours this week against `+
        `${artFor(c28.toFixed(1))} `+
        `${c28.toFixed(1)} hour base${yearBit}.${sportBit}</div>`;
    }
  }
}

// ── CHARTS ──
/* ── CHART LIFECYCLE ──
 * Toggling mi/km, stepping a year or picking a sport used to destroy and rebuild
 * every chart on the tab — up to 21 `new Chart()` calls for a change that, for most
 * of them, moves the numbers and nothing else. Chart.js can mutate a chart in place
 * and animate between the two states, which is both cheaper and less jarring.
 *
 * The renderers were not restructured for this. Each still calls destroyChart()
 * and then constructs, exactly as before; what changed is that destroyChart() now
 * *retires* a chart rather than destroying it, and upsertChart() may revive it.
 * Anything still retired when the render pass ends is destroyed for real.
 *
 * A chart is only revived when it would draw the same shape onto the same live
 * canvas. Tabs that rebuild their own markup (Mex, Social, Gear) hand over a brand
 * new canvas element every time, and reviving onto the detached old one would leave
 * a chart that updates perfectly and is nowhere on screen.
 */
let _retiredCharts={},_sweepQueued=false;
let __chartStats={created:0,updated:0,destroyed:0};

function destroyChart(id){
  const c=charts[id];
  if(!c)return;
  delete charts[id];
  _retiredCharts[id]=c;
  if(!_sweepQueued){
    _sweepQueued=true;
    // Renders are synchronous, so a microtask lands once the whole pass is done.
    Promise.resolve().then(sweepRetiredCharts);
  }
}

function sweepRetiredCharts(){
  Object.keys(_retiredCharts).forEach(k=>{
    try{_retiredCharts[k].destroy();__chartStats.destroyed++;}catch(e){/* canvas already gone */}
  });
  _retiredCharts={};
  _sweepQueued=false;
}

// Used when the colours themselves have to be rebuilt from scratch, which no
// in-place update can be trusted to do.
function destroyChartNow(id){
  if(charts[id]){try{charts[id].destroy();}catch(e){}delete charts[id];}
  if(_retiredCharts[id]){try{_retiredCharts[id].destroy();}catch(e){}delete _retiredCharts[id];}
}

function noteChartUnavailable(ctx){
  const canvas=ctx&&ctx.canvas?ctx.canvas:ctx;
  const wrap=canvas&&canvas.parentElement;
  if(!wrap||wrap.querySelector('.chart-offline'))return;
  const div=document.createElement('div');
  div.className='chart-offline';
  div.textContent='Chart unavailable offline';
  wrap.appendChild(div);
}

function chartCanReuse(chart,ctx,config){
  if(!chart||!config||!config.data)return false;
  const canvas=ctx&&ctx.canvas?ctx.canvas:ctx;
  if(chart.canvas!==canvas)return false;
  if(!document.contains(chart.canvas))return false;
  if(chart.config.type!==config.type)return false;
  const a=chart.data.datasets||[],b=config.data.datasets||[];
  if(a.length!==b.length)return false;
  // A mixed chart whose dataset types move (bar → line) has to be rebuilt.
  for(let i=0;i<b.length;i++){
    if((a[i].type||null)!==(b[i].type||null))return false;
  }
  return true;
}

function upsertChart(key,ctx,config){
  // No library, no chart — but the surrounding card, its title, its chips and its
  // verdict line are all still rendered by the caller and still worth reading.
  if(!window.Chart){noteChartUnavailable(ctx);return null;}
  const prev=charts[key]||_retiredCharts[key];
  if(chartCanReuse(prev,ctx,config)){
    delete _retiredCharts[key];
    prev.data.labels=config.data.labels;
    // Assign onto the existing dataset objects rather than replacing the array, so
    // Chart.js tweens the bars and lines instead of popping them.
    config.data.datasets.forEach((ds,i)=>Object.assign(prev.data.datasets[i],ds));
    if(config.options)prev.options=config.options;
    prev.update();
    __chartStats.updated++;
    charts[key]=prev;
    return prev;
  }
  if(prev){
    try{prev.destroy();__chartStats.destroyed++;}catch(e){}
    delete _retiredCharts[key];
    delete charts[key];
  }
  const c=new Chart(ctx,config);
  __chartStats.created++;
  return c;
}

// ── CLOSING A READOUT ON A TOUCHSCREEN ──
// Chart.js shows its tooltip on hover and takes it away on mouseout; the calendar
// cells do the same with mouseenter/mouseleave. A touchscreen has no mouseout.
// Tapping a chart pins that dark box over the plot and nothing short of tapping a
// different chart clears it, so the detail you asked for ends up sitting on top of
// the data you wanted to read it against, permanently.
//
// A second tap in the same place closes it now, and a tap anywhere off the plot
// closes whatever is open. Tapping a DIFFERENT point still moves the readout there
// rather than closing it — "tap again to dismiss" should not turn into "one point
// per visit".
//
// Mouse pointers are deliberately left alone: there the tooltip follows the cursor,
// so closing it while the cursor is still over the plot would last exactly until
// the next pixel of movement.
let _touchPointer=false;       // the gesture in progress came from a finger or a pen
let _tapOpenIndex=null;        // which point was showing before this tap landed
let _tapOpenDate=null;         // and which calendar day, for the other tooltip
let _dashSuppress=null;        // a day this gesture has just closed, not to be reopened
let _muffledChart=null;        // a chart whose readout this tap closed
let _muffledUntil=0;           // …and how long the emulated mouse burst gets ignored

function chartTooltipIndex(chart){
  const items=chart&&chart.tooltip&&chart.tooltip.getActiveElements
    ?chart.tooltip.getActiveElements():[];
  return items.length?items[0].index:null;
}

function hideChartTooltip(chart){
  if(!chart||!chart.tooltip)return;
  try{
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([],{x:0,y:0});
    // 'none': closing a readout should not replay every bar underneath it.
    chart.update('none');
  }catch(e){/* a chart torn down mid-gesture has nothing left to clear */}
}

function liveCharts(){return Object.keys(charts).map(k=>charts[k]).filter(Boolean);}
function hideAllChartTooltips(except){
  liveCharts().forEach(c=>{if(c!==except&&chartTooltipIndex(c)!=null)hideChartTooltip(c);});
}

function chartAtEvent(e){
  if(!window.Chart||!Chart.getChart)return null;
  const canvas=e.target&&e.target.closest?e.target.closest('canvas'):null;
  return canvas?(Chart.getChart(canvas)||null):null;
}

// Capture on the document, which runs before the canvas's own listener — so this
// reads what was on screen BEFORE Chart.js handles the touch that is about to
// change it. Without that, "was it already open?" is unanswerable by the time the
// gesture ends.
document.addEventListener('pointerdown',e=>{
  _touchPointer=!!(e.pointerType&&e.pointerType!=='mouse');
  // A real new gesture ends any muffling left over from the last one, so a quick
  // second tap opens the readout again rather than landing in a dead window.
  _dashSuppress=null;_muffledChart=null;_muffledUntil=0;
  if(!_touchPointer)return;
  const chart=chartAtEvent(e);
  _tapOpenIndex=chart?chartTooltipIndex(chart):null;
  const dash=document.getElementById('dashTooltip');
  _tapOpenDate=(dash&&dash.style.display==='block')?dash.dataset.date||null:null;
},true);

document.addEventListener('pointerup',e=>{
  if(!_touchPointer)return;
  const chart=chartAtEvent(e);
  if(!chart){
    hideAllChartTooltips();
    // Calendar days are decided here, both ways, rather than left to the emulated
    // mouseenter that follows: that event does not fire again when the tap lands on
    // the cell the emulated pointer never left, so a repeat tap would neither close
    // the day nor reopen it. Touch gets its own deterministic path; the mouse keeps
    // hovering as it always did.
    const cell=e.target&&e.target.closest?e.target.closest('[data-day-tip]'):null;
    if(!cell){hideDashTooltip();return;}
    const day=cell.dataset.dayTip;
    if(_tapOpenDate===day){
      hideDashTooltip();
      _dashSuppress=day;   // …and the mouseenter, if it does arrive, must not undo it
    }else{
      showDashTooltip(e,day);
    }
    return;
  }
  hideAllChartTooltips(chart);
  hideDashTooltip();
  const now=chartTooltipIndex(chart);
  if(_tapOpenIndex!=null&&now===_tapOpenIndex){
    hideChartTooltip(chart);
    // A lifted finger is followed by a burst of emulated mouse events — mouseover,
    // mousemove, mousedown, mouseup, click — and Chart.js listens for mousemove and
    // click. Left alone they arrive a few milliseconds later at the point that was
    // just closed and open it straight back up, which is why stopping the click on
    // its own was not enough. The burst gets muffled for this one chart instead.
    _muffledChart=chart;
    _muffledUntil=Date.now()+500;
  }
});

// Capture on the document, so a muffled event is stopped on its way down and never
// reaches the canvas that would act on it. mouseout is deliberately not in the list:
// that one CLOSES the tooltip, and blocking it would be working against the point.
['mouseover','mousemove','mousedown','mouseup','click'].forEach(type=>{
  document.addEventListener(type,e=>{
    if(!_muffledChart||Date.now()>_muffledUntil)return;
    if(chartAtEvent(e)!==_muffledChart)return;
    e.stopPropagation();
    if(type==='click')e.preventDefault();
  },true);
});
function getMonthKeys(){
  if(isYearScope(activeYear))return Array.from({length:12},(_,i)=>activeYear+'-'+String(i+1).padStart(2,'0'));
  // A rolling window spans whichever months it touches, which is usually a partial
  // month at each end rather than a clean year.
  if(isRollingScope(activeYear)){
    const t=_today();
    return monthsBetween(periodStart(activeYear,t).slice(0,7),t.slice(0,7));
  }
  const now=new Date();
  return Array.from({length:24},(_,i)=>{const d=new Date(now.getFullYear(),now.getMonth()-23+i,1);return d.toISOString().slice(0,7);});
}

function renderCharts(){
  const data=getFiltered();
  const monthKeys=getMonthKeys();
  const typeKeys=['Ride','Virtual','Run','Walk','Swim','Other'];
  // Order matches typeKeys: Ride, Virtual, Run, Walk, Swim, Other.
  const colorFull=['#1d4ed8','#8b5cf6','#ef4444','#eab308','#0ea5e9','#94a3b8'];
  const isSpecificYear=isYearScope(activeYear);
  const isSpecificType=activeType!=='All';

  // Hide/show conditional charts. Classes rather than inline styles, because the
  // cards can be anywhere in the section now and reorder mode needs to be able to
  // put a hidden one back on screen without having to remember what it painted over.
  // A card promoted to full width stays promoted wherever it has been moved to: the
  // promotion is about its partner being gone, not about which row it started in.
  document.getElementById('donutChartCard').classList.toggle('is-hidden',isSpecificType);
  document.getElementById('yoyChartCard').classList.toggle('span-full',isSpecificType);
  // Run pace only means something for runs. When it goes, Relative Effort takes
  // the whole row rather than sitting half-width beside a hole.
  const showPace=(activeType==='All'||activeType==='Run');
  document.getElementById('paceCard').classList.toggle('is-hidden',!showPace);
  document.getElementById('effortCard').classList.toggle('span-full',!showPace);

  // First chart: year calendar or monthly bar
  // A class, not an inline style: an inline `display:block` outranks every rule in
  // the stylesheet, and this card would then be the one that refused to collapse
  // when the tab went into reorder mode.
  document.getElementById('firstChartMonthly').classList.toggle('is-hidden',isSpecificYear);
  document.getElementById('firstChartCalendar').classList.toggle('is-hidden',!isSpecificYear);
  if(isSpecificYear){
    document.getElementById('firstChartTitle').textContent=activeYear+' Activity Calendar';
    document.getElementById('firstChartSub').textContent='Each square = one day. Colour = dominant activity type. Click for details.';
    renderYearCalendarChart(activeYear,data);
    destroyChart('monthly');
  }else{
    document.getElementById('firstChartTitle').textContent='Monthly Distance';
    document.getElementById('firstChartSub').textContent='Distance per month by activity type (last 24 months)';
    const monthDist={};
    data.forEach(a=>{const m=a.date.slice(0,7);if(!monthDist[m])monthDist[m]={};const g=typeGroup(a.type);monthDist[m][g]=(monthDist[m][g]||0)+(a.dist_mi||0);});
    destroyChart('monthly');
    charts.monthly=upsertChart('monthly',document.getElementById('chartMonthly').getContext('2d'),{
      type:'bar',
      // A sport with nothing in the period gets no series at all. A stack of zero
      // height draws nothing but still claims a legend swatch, so the legend ends up
      // listing sports the chart has no data for.
      data:{labels:monthKeys.map(monthLabel),datasets:typeKeys.map((t,i)=>{
        const visible=!isSpecificType||(activeType==='Ride'?(t==='Ride'||t==='Virtual'):t===activeType);
        return{label:t,data:monthKeys.map(m=>{const v=(monthDist[m]||{})[t]||0;return unit==='mi'?+v.toFixed(1):+(v*1.60934).toFixed(1);})
          ,backgroundColor:colorFull[i],borderRadius:0,borderSkipped:false,hidden:!visible};
      }).filter(ds=>ds.data.some(v=>v>0))},
      options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}}},responsive:true,maintainAspectRatio:false,scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:10}}},y:{stacked:true,grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+' '+distUnit()}}},interaction:{mode:'index'}}
    });
  }

  // ── Rolling 12 months ──
  // This replaced a year-over-year bar chart, which could say "was last year
  // bigger" but never "am I ahead of where I was" — a part-finished year is a
  // short bar for a reason the chart cannot show. Every point on this line
  // covers a full twelve months, so a rise is a real rise. It deliberately
  // ignores the year filter: a rolling year is a multi-year measurement, and
  // the scope line above says so.
  destroyChart('yoy');
  renderRolling12(isSpecificType);

  // Donut (only when All type)
  if(!isSpecificType){
    const dc={};data.forEach(a=>{const g=typeGroup(a.type);dc[g]=(dc[g]||0)+1;});
    destroyChart('donut');
    const dl=Object.keys(dc);
    charts.donut=upsertChart('donut',document.getElementById('chartDonut').getContext('2d'),{
      type:'doughnut',data:{labels:dl,datasets:[{data:dl.map(k=>dc[k]),backgroundColor:dl.map(k=>groupColor(k)),borderWidth:0}]},
      options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}}},responsive:true,maintainAspectRatio:false,cutout:'65%'}
    });
  }

  // Elevation
  const elevConv=unit==='km'?0.3048:1,elevUnitStr=unit==='km'?'m':'ft';
  document.getElementById('elevChartSub').textContent=(unit==='km'?'Metres':'Feet')+' climbed per month';
  const monthElv={};data.forEach(a=>{const m=a.date.slice(0,7);if(!monthElv[m])monthElv[m]=0;monthElv[m]+=(a.elv||0)*elevConv;});
  destroyChart('elev');
  charts.elev=upsertChart('elev',document.getElementById('chartElev').getContext('2d'),{
    type:'bar',data:{labels:monthKeys.map(monthLabel),datasets:[{data:monthKeys.map(m=>Math.round(monthElv[m]||0)),backgroundColor:'#6366f1',borderRadius:0}]},
    options:{plugins:{legend:{display:false}},responsive:true,maintainAspectRatio:false,scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:chartGrid()},ticks:{callback:v=>v.toLocaleString()+elevUnitStr,font:{size:11}}}}}
  });

  // Calories had its own monthly bar chart here. It was Monthly Distance with a
  // different y-axis — calories in this data derive from distance and duration,
  // so the two silhouettes were the same. The total survives as a chip on the
  // distance card, which is the only part of it that was telling you anything.

  // Each one separately, so one that throws takes only its own card with it.
  // Before this, a single bad renderer aborted renderCharts partway down the list:
  // the charts above it kept whatever they had drawn last and looked perfectly
  // current, while everything below simply never updated. A filter change then left
  // half the tab quietly describing the previous filter, which is worse than a
  // visible error because nothing on screen admits it.
  safely('summary lines',()=>renderSummaryLines(data,monthKeys,typeKeys,colorFull));
  safely('extra charts',()=>renderExtraCharts(data,monthKeys));
  safely('training load',()=>renderLoad(data),'chartLoad');
  safely('cumulative',()=>renderCumulative(data),'chartCumulative');
  safely('pace scatter',()=>renderPaceScatter(data),'chartPace');
  safely('efficiency',()=>renderEfficiency(data),'chartEff');
  safely('sport mix by year',()=>renderMixByYear(),'chartMixYear');
  safely('max heart rate',()=>renderMaxHr(data,monthKeys),'chartMaxHr');
  safely('monotony',()=>renderMonotony(data),'chartMono');
  safely('projection',()=>renderProjection(),'chartProject');
}

/* Run one renderer with its failure contained.
 *
 * A chart that cannot draw itself should say so in its own card and let the rest of
 * the page get on with it. The alternative — which is what this replaced — is that
 * the first exception unwinds the whole render and every chart after it silently
 * keeps stale data on screen.
 *
 * `canvasId` is optional: where it is given the card shows the failure in place of
 * its plot, so there is something on screen rather than a chart that just stopped
 * changing. Where it is not, the console is the only trace, which is still better
 * than taking the tab down.
 */
function safely(what,fn,canvasId){
  try{
    fn();
    return true;
  }catch(e){
    console.error(`Chart "${what}" failed to render:`,e);
    if(canvasId){
      try{setChartEmpty(canvasId,`This chart could not be drawn. The rest of the page is unaffected — ${e&&e.message?e.message:'unknown error'}`);}catch(_){}
    }
    return false;
  }
}

// ── WHERE THE YEAR ENDS ──
// Two honest projections and a dial between them. The arithmetic is in calc.js
// (yearEndProjection); this is the part that draws it.
//
// The dial is the feature, not a setting. Ask the recent trend in August and it
// promises a summer's worth of December; ask the seasonal shape while you are
// injured and it has no idea you have stopped. Sliding between them is how you see
// how much of the answer is assumption — and a projection that cannot show you that
// is a number pretending to be a fact.
const PROJ_MEASURE_KEY='fitness_proj_measure_v1';
const PROJ_MIX_KEY='fitness_proj_mix_v1';
const PROJ_MEASURES={
  // distIn returns the active unit, so the series is already in miles or kilometres;
  // fmtDist wants miles, hence the conversion back on the way out. Same shape the
  // cumulative chart next door uses.
  dist :{noun:'distance', pick:a=>distIn(a),
         fmt:v=>fmtDist(unit==='mi'?v:v/1.60934)+' '+distUnit(),
         tick:v=>v.toLocaleString('en-GB')+' '+distUnit()},
  time :{noun:'moving time', pick:a=>(a.mt||0)/3600,
         fmt:v=>chipNum(v,0)+'h',        tick:v=>v.toLocaleString('en-GB')+'h'},
  count:{noun:'activities', pick:()=>1,
         fmt:v=>chipNum(v,0),            tick:v=>v.toLocaleString('en-GB')},
  elev :{noun:'climbing', pick:a=>fmtElevVal(a.elv||0),
         fmt:v=>chipNum(v,0)+fmtElevUnit(), tick:v=>Math.round(v).toLocaleString('en-GB')+fmtElevUnit()},
};
let projMeasure='dist',projMix=0.5;
try{
  const m=localStorage.getItem(PROJ_MEASURE_KEY);if(PROJ_MEASURES[m])projMeasure=m;
  const x=parseFloat(localStorage.getItem(PROJ_MIX_KEY));if(isFinite(x)&&x>=0&&x<=1)projMix=x;
}catch(e){}

function setProjMeasure(m){
  if(!PROJ_MEASURES[m]||m===projMeasure)return;
  projMeasure=m;
  try{localStorage.setItem(PROJ_MEASURE_KEY,m);}catch(e){}
  renderProjection();
}
function setProjMix(v){
  const x=Math.max(0,Math.min(1,(+v||0)/100));
  if(x===projMix)return;
  projMix=x;
  try{localStorage.setItem(PROJ_MIX_KEY,String(x));}catch(e){}
  renderProjection();
}

function renderProjection(){
  const measure=PROJ_MEASURES[projMeasure]||PROJ_MEASURES.dist;
  document.querySelectorAll('#projMeasureCtl .chart-ctl-btn').forEach(b=>{
    const on=b.dataset.measure===projMeasure;
    b.classList.toggle('active',on);
    b.setAttribute('aria-pressed',on?'true':'false');
  });
  const slider=document.getElementById('projMix');
  if(slider&&Math.round(+slider.value)!==Math.round(projMix*100))slider.value=Math.round(projMix*100);

  const today=_today();
  const focus=String(new Date(today+'T12:00:00').getFullYear());
  // Daily series per year, sport filter applied, period filter deliberately not:
  // this chart is about a whole year and the header's year control would leave it
  // with one point.
  const daily={};
  ALL_DATA.forEach(a=>{
    if(!typeMatches(a))return;
    const y=a.date.slice(0,4);
    (daily[y]=daily[y]||new Array(daysInYear(y)+1).fill(0))[dayOfYear(a.date)]+=measure.pick(a)||0;
  });
  const doy=dayOfYear(today);
  if(!daily[focus]){
    setChartEmpty('chartProject',`Nothing logged in ${focus} for this sport yet, so there is nothing to project.`);
    chartSummary('project',[],'');
    const says=document.getElementById('projMixSays');if(says)says.textContent='';
    return;
  }
  setChartEmpty('chartProject');
  const p=yearEndProjection(daily,focus,doy,projMix);

  // Up to three finished years behind it, for the projection to be read against.
  const past=Object.keys(daily).filter(y=>y<focus).sort().reverse().slice(0,3);
  const len=daysInYear(focus);
  const cumOf=(y,stop)=>{
    const src=daily[y]||[],out=[];let run=0;
    for(let d=1;d<=len;d++){run+=src[Math.min(d,src.length-1)]||0;out.push(d<=stop?+run.toFixed(2):null);}
    return out;
  };

  destroyChart('project');
  charts.project=upsertChart('project',document.getElementById('chartProject').getContext('2d'),{
    type:'line',
    data:{labels:Array.from({length:len},(_,i)=>i+1),datasets:[
      ...past.map((y,i)=>({label:y,data:cumOf(y,len),borderColor:yearRamp(past.length+1,i+1),
        backgroundColor:'transparent',borderWidth:1.5,pointRadius:0,tension:.1,fill:false,spanGaps:false})),
      {label:focus,data:cumOf(focus,doy),borderColor:getAccentColor(),
       backgroundColor:'transparent',borderWidth:2.5,pointRadius:0,tension:.1,fill:false,spanGaps:false},
      // Dotted, not dashed, and the only series on the chart that has not happened.
      {label:'Projected',data:p.path.slice(1),borderColor:getAccentColor(),
       borderDash:[2,4],borderCapStyle:'round',backgroundColor:'transparent',
       borderWidth:2,pointRadius:0,tension:.1,fill:false,spanGaps:false},
    ]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{mode:'index',intersect:false,callbacks:{
        title:c=>{const d=+c[0].label;const mi=MONTH_DOY.filter(m=>m<=d).length-1;
          return`${MONTH_ABBR[mi]} ${d-MONTH_DOY[mi]+1}`;},
        label:c=>c.parsed.y==null?null:`${c.dataset.label}: ${measure.fmt(c.parsed.y)}`}}},
      responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      scales:{
        x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:false,
          callback:v=>{const i=MONTH_DOY.indexOf(v+1);return i>=0?MONTH_ABBR[i]:'';}}},
        y:{grid:{color:chartGrid()},beginAtZero:true,ticks:{font:{size:11},callback:measure.tick}}}}
  });

  // What the dial is currently set to, in words. A number between 0 and 100 tells
  // you nothing about what it is mixing.
  const pctRecent=Math.round(p.weight*100);
  const says=document.getElementById('projMixSays');
  if(says)says.textContent=p.seasonal==null
    ? `Your last ${p.window} days, carried to 31 December. No finished year to compare against yet, so the seasonal half of this dial has nothing to work with.`
    : pctRecent>=99?`Entirely your last ${p.window} days, carried to 31 December.`
    : pctRecent<=1?`Entirely the shape of your ${p.teachers} previous year${p.teachers===1?'':'s'} — by this date you are usually ${Math.round(p.fractionDone*100)}% done.`
    : `${100-pctRecent}% the shape of your ${p.teachers} previous year${p.teachers===1?'':'s'}, ${pctRecent}% your last ${p.window} days.`;

  document.getElementById('projSub').textContent=
    `${focus} ${measure.noun} so far, and where it lands with ${p.daysLeft} day${p.daysLeft===1?'':'s'} to go`;

  const lastYear=past[0];
  const lastTotal=lastYear?cumOf(lastYear,len).filter(v=>v!=null).slice(-1)[0]:null;
  const chips=[
    {n:measure.fmt(p.projected),label:'projected year end',col:getAccentColor()},
    {n:measure.fmt(p.ytd),label:`${focus} so far`,col:'#94a3b8'},
  ];
  if(lastTotal){
    const d=Math.round((p.projected-lastTotal)/lastTotal*100);
    chips.push({n:(d>=0?'+':'')+d+'%',label:`on ${lastYear}'s finished year`,col:d>=0?'#22c55e':'#ef4444'});
  }
  // The spread between the two methods IS the uncertainty, so it is a figure rather
  // than a caveat buried in prose.
  if(p.seasonal!=null){
    const lo=Math.min(p.seasonal,p.recent),hi=Math.max(p.seasonal,p.recent);
    chips.push({n:`${measure.fmt(lo)} – ${measure.fmt(hi)}`,label:'the two methods disagree by this much',col:'#8b5cf6'});
  }
  chartSummary('project',chips,(()=>{
    const head=`Two ways of guessing, and the slider is how much you trust each. `;
    if(p.seasonal==null)
      return head+`Only the recent one is available: nothing before ${focus} covers a full year, so there is no seasonal shape to learn from. It is a straight line from here, which will be wrong in whichever direction your winter goes.`;
    const gap=Math.abs(p.seasonal-p.recent)/Math.max(p.recent,1);
    const which=p.recent>p.seasonal
      ? `Your recent form projects higher than your usual shape does, which is what a good patch looks like — or what August looks like if your years tail off.`
      : `Your recent form projects lower than your usual shape does, so either you are in a quiet spell or this year genuinely is one.`;
    const agree=gap<0.05
      ? ` The two agree closely, which is the most confidence this chart is ever able to offer.`
      : ` They are ${Math.round(gap*100)}% apart, so treat the headline as the middle of a range rather than a figure.`;
    return head+which+agree;
  })());
}

// ── HOW THE MIX HAS SHIFTED ──
// The donut is a snapshot: it says what the split is now and nothing about how it
// got there. Fourteen years of 100% bars say whether you have quietly stopped being
// a cyclist.
//
// Three measures, because they genuinely disagree and the disagreement is the
// interesting part: a walk is a large share of your sessions, a middling share of
// your hours and a small share of your distance, and which of those you call "the
// mix" is a choice rather than a fact. Distance is the default because it is the
// number the rest of the dashboard leads with.
//
// The year filter is ignored on purpose — a chart of one year's share against
// itself is a single bar — and the sport filter too, since filtering to one sport
// would leave a chart that reads 100% every year.
const MIX_MEASURE_KEY='fitness_mix_measure_v1';
const MIX_MEASURES={
  // dist_mi rather than distIn(): this is a share, and a share of miles and a share
  // of kilometres are the same number. Using the raw field keeps it that way instead
  // of letting the mi/km toggle move a percentage by a rounding step.
  dist :{pick:a=>a.dist_mi||0, noun:'distance',    sub:'Share of distance by sport'},
  time :{pick:a=>a.mt||0,      noun:'moving time', sub:'Share of moving time by sport'},
  count:{pick:()=>1,           noun:'sessions',    sub:'Share of sessions by sport'},
};
let mixMeasure='dist';
try{const v=localStorage.getItem(MIX_MEASURE_KEY);if(MIX_MEASURES[v])mixMeasure=v;}catch(e){}

function setMixMeasure(m){
  if(!MIX_MEASURES[m]||m===mixMeasure)return;
  mixMeasure=m;
  try{localStorage.setItem(MIX_MEASURE_KEY,m);}catch(e){}
  renderMixByYear();
}

function renderMixByYear(){
  const measure=MIX_MEASURES[mixMeasure]||MIX_MEASURES.dist;
  document.querySelectorAll('#mixMeasureCtl .chart-ctl-btn').forEach(b=>{
    const on=b.dataset.measure===mixMeasure;
    b.classList.toggle('active',on);
    b.setAttribute('aria-pressed',on?'true':'false');
  });
  const years=[...new Set(ALL_DATA.map(a=>a.date.slice(0,4)))].sort();
  const groups=['Ride','Virtual','Run','Walk','Swim','Other'];
  const byYear={};
  // Counted while aggregating: measured by distance, a gym session contributes
  // nothing, and a chart that silently dropped a fifth of the year would be lying
  // by omission rather than by arithmetic.
  let weightless=0;
  ALL_DATA.forEach(a=>{
    const y=a.date.slice(0,4);
    const v=measure.pick(a)||0;
    if(v<=0)weightless++;
    (byYear[y]=byYear[y]||{})[typeGroup(a.type)]=((byYear[y]||{})[typeGroup(a.type)]||0)+v;
  });
  const totals=years.map(y=>groups.reduce((s,g)=>s+((byYear[y]||{})[g]||0),0));
  const live=years.filter((y,i)=>totals[i]>0);
  if(live.length<2){
    setChartEmpty('chartMixYear',mixMeasure==='dist'
      ? 'Two years with recorded distance are needed before a shift can be shown. Try Time or Sessions.'
      : 'Two years of activities are needed before a shift can be shown.');
    chartSummary('mixyear',[],'');
    return;
  }
  setChartEmpty('chartMixYear');
  const pct=(y,g)=>{
    const t=groups.reduce((s,k)=>s+((byYear[y]||{})[k]||0),0);
    return t?+(((byYear[y]||{})[g]||0)/t*100).toFixed(1):0;
  };
  // Sports that never appear get no series rather than a legend entry at zero.
  const present=groups.filter(g=>live.some(y=>pct(y,g)>0));
  destroyChart('mixyear');
  charts.mixyear=upsertChart('mixyear',document.getElementById('chartMixYear').getContext('2d'),{
    type:'bar',
    data:{labels:live,datasets:present.map(g=>({
      label:g,data:live.map(y=>pct(y,g)),backgroundColor:groupColor(g),
      borderRadius:0,borderSkipped:false,
    }))},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y}% of ${measure.noun}`}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:11}}},
        y:{stacked:true,grid:{color:chartGrid()},max:100,
          ticks:{font:{size:11},callback:v=>v+'%'}}}}
  });

  const first=live[0],last=live[live.length-1];
  const moved=present.map(g=>({g,d:pct(last,g)-pct(first,g)})).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));
  const top=present.map(g=>({g,p:pct(last,g)})).sort((a,b)=>b.p-a.p)[0];
  const chips=[{n:top.p+'%',label:`${top.g.toLowerCase()} in ${last}`,col:groupColor(top.g)}];
  moved.slice(0,2).forEach(m=>chips.push({
    n:(m.d>=0?'+':'')+m.d.toFixed(0)+'pt',label:`${m.g.toLowerCase()} since ${first}`,
    col:m.d>=0?'#22c55e':'#ef4444'}));
  document.getElementById('mixYearSub').textContent=
    `${measure.sub}, ${first} to ${last} — every bar is a whole year`;
  chartSummary('mixyear',chips,(()=>{
    const big=moved[0];
    if(!big||Math.abs(big.d)<5)return`The balance has barely moved since ${first}, measured by ${measure.noun}. Whatever you are, you have been it for ${live.length} years.`;
    const second=moved[1]&&Math.abs(moved[1].d)>=5?moved[1]:null;
    // Which way the second sport moved decides the phrase. "At its expense" is only
    // true when the two moved in opposite directions AND this one went up; a sport
    // that fell while another rose lost its share TO it, not at its expense.
    let tail='';
    if(second){
      const opposed=(big.d>0)!==(second.d>0);
      tail=opposed
        ? (big.d>0?`, mostly at ${second.g.toLowerCase()}'s expense`
                  :`, with ${second.g.toLowerCase()} taking up the slack`)
        : `, and ${second.g.toLowerCase()} has moved the same way`;
    }
    // The measure has to be named, not implied. "Ride is down 73 points" is three
    // different claims depending on which button is pressed, and the one that is
    // true by distance can be false by sessions.
    const scale={dist:'your distance',time:'your training time',count:'your sessions'}[mixMeasure];
    const why={
      dist:'Shares are of distance, so a sport you spend hours on slowly counts for less here than the time view suggests.',
      time:'Shares are of time, so this is where the hours went rather than how many sessions you logged.',
      count:'Shares are of session count, so a twenty-minute walk weighs exactly as much as a five-hour ride.',
    }[mixMeasure];
    const omitted=(mixMeasure==='dist'&&weightless)
      ? ` ${weightless.toLocaleString('en-GB')} activit${weightless===1?'y':'ies'} with no distance recorded — gym work and the like — sit outside this view; Time or Sessions counts them.`
      : '';
    return`${big.g} has gone ${big.d>0?'up':'down'} ${Math.abs(big.d).toFixed(0)} points of ${scale} since ${first}${tail}. `+
      why+omitted;
  })());
}

// ── HOW HARD YOU ACTUALLY GO ──
// The zone chart is built from average heart rates, which is a fair picture of a
// session as a whole and says nothing about its hardest minute. max_hr has been
// stored on every activity all along and appeared in exactly one place: the detail
// modal of a single activity. Monthly peaks against monthly averages is the shape
// that answers "am I still going hard, or just going often".
function renderMaxHr(data,monthKeys){
  const withHr=data.filter(a=>a.max_hr>0);
  if(withHr.length<5){
    setChartEmpty('chartMaxHr','Fewer than five activities here have heart-rate data.');
    chartSummary('maxhr',[],'');
    return;
  }
  setChartEmpty('chartMaxHr');
  const byMonth={};
  withHr.forEach(a=>{
    const m=a.date.slice(0,7);
    (byMonth[m]=byMonth[m]||{peak:0,avg:[],n:0});
    byMonth[m].peak=Math.max(byMonth[m].peak,a.max_hr);
    if(a.hr>0)byMonth[m].avg.push(a.hr);
    byMonth[m].n++;
  });
  const mean=v=>v.length?v.reduce((s,x)=>s+x,0)/v.length:null;
  const peaks=monthKeys.map(m=>byMonth[m]?Math.round(byMonth[m].peak):null);
  const avgs=monthKeys.map(m=>byMonth[m]?(mean(byMonth[m].avg)==null?null:Math.round(mean(byMonth[m].avg))):null);
  destroyChart('maxhr');
  charts.maxhr=upsertChart('maxhr',document.getElementById('chartMaxHr').getContext('2d'),{
    type:'line',
    // The fill runs BETWEEN the two lines rather than down to the axis. Filling to
    // the axis shades the whole 0–190 bpm block, which reads as an accumulating
    // quantity — and a heart rate does not accumulate. The band between peak and
    // average is the thing the chart is actually about: how much headroom there is
    // between a typical session and the hardest minute of the month.
    data:{labels:monthKeys.map(monthLabel),datasets:[
      {label:'Hardest beat that month',data:peaks,borderColor:'#ef4444',
       backgroundColor:'rgba(239,68,68,.12)',fill:{target:1},tension:.25,pointRadius:0,borderWidth:2,spanGaps:true},
      {label:'Average heart rate',data:avgs,borderColor:'#94a3b8',
       backgroundColor:'transparent',fill:false,tension:.25,pointRadius:0,borderWidth:2,spanGaps:true},
    ]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{mode:'index',intersect:false,callbacks:{label:c=>c.parsed.y==null?null:`${c.dataset.label}: ${c.parsed.y} bpm`}}},
      responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:true,maxTicksLimit:12}},
        y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+' bpm'}}}}
  });

  const everPeak=Math.max(...withHr.map(a=>a.max_hr));
  const livePeaks=peaks.filter(v=>v!=null),liveAvgs=avgs.filter(v=>v!=null);
  const recent=livePeaks.slice(-3),earlier=livePeaks.slice(0,-3);
  const gap=liveAvgs.length&&livePeaks.length?Math.round(mean(livePeaks)-mean(liveAvgs)):null;
  const chips=[
    {n:Math.round(everPeak)+' bpm',label:'highest in view',col:'#ef4444'},
    {n:Math.round(mean(livePeaks))+' bpm',label:'typical monthly peak',col:'#f59e0b'},
  ];
  if(gap!=null)chips.push({n:gap+' bpm',label:'peak above average',col:'#8b5cf6'});
  chartSummary('maxhr',chips,(()=>{
    if(!earlier.length)return`Your hardest effort in view reached ${Math.round(everPeak)} bpm. The red line is the single hardest beat of each month, not its average — a month can be busy and never touch it.`;
    const d=Math.round(mean(recent)-mean(earlier));
    if(Math.abs(d)<3)return`Monthly peaks are steady at around ${Math.round(mean(livePeaks))} bpm. You are still finding the top end about as often as you were.`;
    return d<0
      ? `Your monthly peaks are ${Math.abs(d)} bpm lower over the last three months than before them. That is what a block of steady volume looks like — worth knowing if you meant to be sharpening.`
      : `Your monthly peaks are ${d} bpm higher over the last three months. Something in the recent block is taking you to the top end more often.`;
  })());
}

// ── SAME WEEK, DIFFERENT TRAINING ──
// The load chart can tell you a week was ten hours. It cannot tell you whether that
// was ten hours spread evenly or ten hours in two sessions, because a total is all
// it has — and those are different training with the same number on them.
function renderMonotony(data){
  const weeks=weeklyLoadStats(data,a=>(a.mt||0)/3600,{today:_today()});
  if(weeks.length<4){
    setChartEmpty('chartMono','Four full weeks of training are needed before a pattern means anything.');
    chartSummary('mono',[],'');
    return;
  }
  setChartEmpty('chartMono');
  const shortLabel=w=>{const[,m,d]=w.split('-');return`${+d} ${MONTH_ABBR[+m-1]}`;};
  destroyChart('mono');
  charts.mono=upsertChart('mono',document.getElementById('chartMono').getContext('2d'),{
    type:'line',
    data:{labels:weeks.map(w=>shortLabel(w.week)),datasets:[
      {label:'Monotony',data:weeks.map(w=>w.monotony),borderColor:getAccentColor(),
       backgroundColor:'transparent',fill:false,tension:.25,pointRadius:0,borderWidth:2},
      // The flagged level, drawn rather than described. A line you have to hold a
      // number against in your head is a number, not a chart.
      {label:`Flagged above ${MONOTONY_CAUTION.toFixed(1)}`,data:weeks.map(()=>MONOTONY_CAUTION),
       borderColor:'#f59e0b',borderDash:[5,4],backgroundColor:'transparent',
       fill:false,pointRadius:0,borderWidth:1.5},
    ]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{mode:'index',intersect:false,callbacks:{
        title:c=>'Week of '+fmtDate(weeks[c[0].dataIndex].week),
        label:c=>c.datasetIndex?null:
          `Monotony ${weeks[c.dataIndex].monotony} · ${fmtHours(weeks[c.dataIndex].total*3600)} over ${weeks[c.dataIndex].days} day${weeks[c.dataIndex].days===1?'':'s'}`}}},
      responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:true,maxTicksLimit:12}},
        y:{grid:{color:chartGrid()},beginAtZero:true,ticks:{font:{size:11}}}}}
  });

  const latest=weeks[weeks.length-1];
  const flagged=weeks.filter(w=>w.monotony>=MONOTONY_CAUTION).length;
  const hardest=weeks.reduce((b,w)=>w.strain>b.strain?w:b,weeks[0]);
  const peak=weeks.reduce((b,w)=>w.monotony>b.monotony?w:b,weeks[0]);
  // Strain is a raw index — hours times monotony — and a bare "27" on a chip means
  // nothing without the weeks either side of it to compare against. It gets a
  // sentence in the verdict instead, where there is room to say what it is. The
  // chips stay on scales the chart itself shows: the same axis, and a count with
  // its denominator.
  chartSummary('mono',[
    {n:latest.monotony.toFixed(2),label:'last full week',
     col:latest.monotony>=MONOTONY_CAUTION?'#f59e0b':'#22c55e'},
    {n:`${flagged} of ${weeks.length}`,label:`weeks above ${MONOTONY_CAUTION.toFixed(1)}`,
     col:flagged?'#ef4444':'#22c55e'},
    {n:peak.monotony.toFixed(2),label:'most samey week',col:'#8b5cf6'},
  ],
  (()=>{
    const base=`Monotony is a week's average day divided by how much its days vary — high means every day looked like every other one. `+
      `Strain is the week's hours multiplied by that, so ${fmtDate(hardest.week)} (${fmtHours(hardest.total*3600)} across ${hardest.days} days) `+
      `cost the most of any week here.`;
    if(latest.monotony>=MONOTONY_CAUTION)
      return base+` Your last full week is at ${latest.monotony.toFixed(2)} — same-again territory. An easy day made easier and a hard day made harder brings it down without losing an hour.`;
    if(flagged===0)return base+` Nothing here is flagged: your weeks have enough shape in them that the hard days stay hard.`;
    return base+` Your last full week is at ${latest.monotony.toFixed(2)}, comfortably varied.`;
  })());
}


function renderRolling12(isSpecificType){
  const sub=document.getElementById('yoyChartSub');
  const match=a=>{
    if(!isSpecificType)return true;
    const g=typeGroup(a.type);
    return activeType==='Ride'?(g==='Ride'||g==='Virtual'):g===activeType;
  };
  const byMonth={};
  ALL_DATA.filter(match).forEach(a=>{const m=a.date.slice(0,7);byMonth[m]=(byMonth[m]||0)+(a.dist_mi||0);});
  const present=Object.keys(byMonth).sort();
  if(sub)sub.textContent=(isSpecificType?activeType+' distance':'Distance')+' in the twelve months ending each month — spans every year, whatever the year filter says';
  if(present.length<12){
    setChartEmpty('chartYoY','A rolling twelve-month total needs at least a year of history behind it. There '+(present.length===1?'is':'are')+' '+present.length+' month'+(present.length===1?'':'s')+' here.');
    chartSummary('roll',[],'');
    return;
  }
  setChartEmpty('chartYoY');
  const months=monthsBetween(present[0],present[present.length-1]);
  const conv=v=>unit==='mi'?v:v*1.60934;
  const pts=[];
  for(let i=11;i<months.length;i++){
    let s=0;for(let j=i-11;j<=i;j++)s+=byMonth[months[j]]||0;
    pts.push({m:months[i],v:conv(s)});
  }
  const col=isSpecificType?groupColor(activeType):'#1d4ed8';
  charts.yoy=upsertChart('yoy',document.getElementById('chartYoY').getContext('2d'),{
    type:'line',
    data:{labels:pts.map(p=>monthLabel(p.m)),datasets:[{
      data:pts.map(p=>Math.round(p.v)),borderColor:col,backgroundColor:col+'14',
      fill:true,tension:.25,pointRadius:0,pointHitRadius:12,borderWidth:2.5}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.parsed.y.toLocaleString()+' '+distUnit()+' in the year to '+c.label}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:10}},y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v.toLocaleString()}}}}
  });
  const last=pts[pts.length-1];
  const yearAgo=pts.length>12?pts[pts.length-13]:null;
  const peak=pts.reduce((b,p)=>p.v>b.v?p:b,pts[0]);
  const chips=[{n:chipNum(last.v),label:distUnit()+', trailing year',col:'#1d4ed8'}];
  if(yearAgo&&yearAgo.v>0){
    const d=(last.v-yearAgo.v)/yearAgo.v*100;
    chips.push({n:(d>=0?'+':'−')+Math.abs(Math.round(d))+'%',label:'vs a year ago',col:d>=0?'#16a34a':'#ff385c'});
  }
  chips.push({n:chipNum(peak.v),label:'peak · '+monthLabel(peak.m),col:'#ff385c'});
  let verdict;
  if(peak.m===last.m)verdict='You are at your twelve-month peak right now — no rolling year in '+pts.length+' months of history has been bigger than the one you have just finished.';
  else{
    const off=Math.round((peak.v-last.v)/Math.max(1,peak.v)*100);
    verdict='Your biggest rolling year ended '+monthLabel(peak.m)+'; you are '+off+'% below it now. Every point here covers twelve full months, so that is a real change rather than a calendar artefact.';
  }
  chartSummary('roll',chips,verdict);
}

// ── FIGURE CHIPS AND VERDICTS ──
// The heart-rate zone card set the pattern: tinted figures under the plot, then one
// line saying what the shape means. Applied here to the charts that have something
// true and non-obvious to say — which, since the Calories chart was folded into a
// chip and Year-over-Year became a rolling twelve-month line, is now every card on
// the tab. The heart-rate card, which invented this treatment, uses the helper too.
function renderSummaryLines(data,monthKeys,typeKeys,colorFull){
  const inScope=m=>monthKeys.includes(m);

  // ── Monthly distance ──
  const byMonth={};
  data.forEach(a=>{const m=a.date.slice(0,7);if(!inScope(m))return;byMonth[m]=(byMonth[m]||0)+(a.dist_mi||0);});
  const months=Object.keys(byMonth);
  const totalDist=months.reduce((s,m)=>s+byMonth[m],0);
  if(!totalDist){chartSummary('dist',[],'');}
  else{
    const active=months.filter(m=>byMonth[m]>0);
    const best=active.reduce((b,m)=>byMonth[m]>byMonth[b]?m:b,active[0]);
    const avg=totalDist/Math.max(1,active.length);
    // On "All" the chart shows the last 24 months, not all time — say which, rather
    // than calling a two-year figure a total.
    const scopeWord=activeYear==='All'?distUnit()+', last 24 months':distUnit()+' '+periodPhrase(activeYear);
    // Calories used to have a monthly bar chart of its own, which was this same
    // chart in different units. The total is the part worth keeping.
    const cals=data.reduce((s,a)=>inScope(a.date.slice(0,7))?s+(a.cal||0):s,0);
    chartSummary('dist',[
      {n:fmtDist(totalDist),label:scopeWord,col:'#1d4ed8'},
      {n:fmtDist(avg),label:distUnit()+'/month',col:'#0ea5e9'},
      {n:fmtDist(byMonth[best]),label:'best · '+monthLabel(best),col:'#ff385c'},
      ...(cals?[{n:cals>=1e6?chipNum(cals/1e6,1)+'M':chipNum(Math.round(cals/1000))+'k',label:'kcal burned',col:'#16a34a'}]:[]),
    ],
    // Only compare years when a full previous year is in scope to compare against.
    (()=>{
      const yrs={};
      data.forEach(a=>{const y=a.date.slice(0,4);yrs[y]=(yrs[y]||0)+(a.dist_mi||0);});
      const ys=Object.keys(yrs).sort();
      if(ys.length<2)return `${active.length} month${active.length===1?'':'s'} with something in them, averaging ${fmtDist(avg)} ${distUnit()}.`;
      const cur=ys[ys.length-1],prev=ys[ys.length-2];
      const d=yrs[cur]-yrs[prev],pct=Math.round(Math.abs(d)/Math.max(1,yrs[prev])*100);
      const curIsPartial=cur===String(new Date().getFullYear());
      if(curIsPartial)return `${cur} is ${fmtDist(yrs[cur])} ${distUnit()} so far against ${fmtDist(yrs[prev])} for all of ${prev} — ${Math.round(yrs[cur]/Math.max(1,yrs[prev])*100)}% of last year's total, with the year not finished.`;
      return `${cur} came to ${fmtDist(yrs[cur])} ${distUnit()}, ${pct}% ${d>=0?'more':'less'} than ${prev}.`;
    })());
  }

  // ── Elevation ──
  // Scoped to monthKeys exactly as the distance figures are. Summing elevation over
  // the whole filtered set while distance covered only the charted months made the
  // ft-per-mile ratio almost double what it should be.
  const totalElv=data.reduce((s,a)=>inScope(a.date.slice(0,7))?s+(a.elv||0):s,0);
  if(!totalElv){chartSummary('elev',[],'');}
  else{
    const perMile=totalDist>0?totalElv/totalDist:0;
    const everests=totalElv/29029;
    chartSummary('elev',[
      {n:fmtElv(totalElv),label:'climbed',col:'#8b5cf6'},
      {n:chipNum(everests,1),label:'× Everest',col:'#ec4899'},
      {n:Math.round(unit==='mi'?perMile:perMile*0.3048/1.60934).toLocaleString('en-GB'),label:(unit==='mi'?'ft':'m')+' per '+distUnit(),col:'#f59e0b'},
    ],
    perMile>0?`That works out at ${Math.round(perMile)} ft of climbing for every mile ridden. Anything over about 60 is properly hilly territory; the Lancashire average sits nearer 50.`:'');
  }

  // ── Activity mix ──
  // The chips count sessions; the verdict says what share of the distance those
  // sessions actually carry, which is the thing a count can't tell you.
  if(activeType==='All'){
    const counts={},dist={};
    data.forEach(a=>{const g=typeGroup(a.type);counts[g]=(counts[g]||0)+1;dist[g]=(dist[g]||0)+(a.dist_mi||0);});
    const total=data.length||1;
    const distTot=Object.values(dist).reduce((s,v)=>s+v,0);
    const present=typeKeys.filter(t=>counts[t]);
    let verdict='';
    if(present.length>1&&distTot>0){
      const topByCount=present.reduce((b,t)=>counts[t]>counts[b]?t:b,present[0]);
      const topByDist=present.reduce((b,t)=>dist[t]>dist[b]?t:b,present[0]);
      const cShare=Math.round(counts[topByCount]/total*100);
      const dShare=Math.round(dist[topByDist]/distTot*100);
      verdict=topByCount===topByDist
        ? `${topByCount} leads on both counts — ${cShare}% of your sessions and ${dShare}% of your distance.`
        : `${topByCount} is your most frequent activity at ${cShare}% of sessions, but ${topByDist} carries ${dShare}% of the distance. The frequent ones are short.`;
    }
    chartSummary('mix',present.map(t=>({
      n:Math.round(counts[t]/total*100)+'%',
      label:t.toLowerCase()+' · '+counts[t].toLocaleString('en-GB'),
      col:colorFull[typeKeys.indexOf(t)],
    })),verdict);
  }else chartSummary('mix',[],'');
}

// ── MOVING VS STOPPED ──
// mt and et are on every single activity and were charted nowhere. The gap
// between them is cafe stops, junctions, regroups and waiting at lights.
function renderMovingChart(data,monthKeys){
  // Guard against the records that would make this meaningless: a paused watch
  // left running overnight gives an elapsed time with no relationship to the
  // ride, so anything claiming more than four hours stopped per hour moving is
  // treated as a recording artefact rather than a very long coffee.
  const usable=data.filter(a=>a.mt>0&&a.et>0&&a.et>=a.mt&&a.et<=a.mt*5);
  if(usable.length<5){
    setChartEmpty('chartMove','Not enough activities here record both moving and elapsed time.');
    chartSummary('move',[],'');
    return;
  }
  setChartEmpty('chartMove');
  const byMonth={};
  usable.forEach(a=>{
    const m=a.date.slice(0,7);if(!monthKeys.includes(m))return;
    if(!byMonth[m])byMonth[m]={mt:0,et:0};
    byMonth[m].mt+=a.mt;byMonth[m].et+=a.et;
  });
  const months=monthKeys.filter(m=>byMonth[m]&&byMonth[m].et>0);
  destroyChart('move');
  charts.move=upsertChart('move',document.getElementById('chartMove').getContext('2d'),{
    type:'line',
    data:{labels:months.map(monthLabel),datasets:[{
      data:months.map(m=>+(byMonth[m].mt/byMonth[m].et*100).toFixed(1)),
      borderColor:'#1d4ed8',backgroundColor:'#1d4ed814',fill:true,tension:.25,
      pointRadius:0,pointHitRadius:12,borderWidth:2.5}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.parsed.y+'% of elapsed time moving'}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:10}},
        y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+'%'}}}}
  });
  const mtAll=usable.reduce((s,a)=>s+a.mt,0),etAll=usable.reduce((s,a)=>s+a.et,0);
  const stopped=etAll-mtAll;
  const share=Math.round(mtAll/etAll*100);
  // Long days out are where stoppage actually accumulates, so compare the top
  // quarter by distance against the rest rather than quoting one average.
  const sorted=usable.slice().sort((a,b)=>(b.dist_mi||0)-(a.dist_mi||0));
  const longs=sorted.slice(0,Math.max(1,Math.floor(sorted.length/4)));
  const longShare=Math.round(longs.reduce((s,a)=>s+(a.et-a.mt),0)/Math.max(1,longs.reduce((s,a)=>s+a.et,0))*100);
  chartSummary('move',[
    {n:share+'%',label:'of elapsed time moving',col:'#1d4ed8'},
    {n:fmtHours(stopped),label:'stopped, all in',col:'#ff385c'},
    {n:longShare+'%',label:'stopped on your longest quarter',col:'#f59e0b'},
  ],
  stopped>86400
    ? `That is ${(stopped/86400).toFixed(1)} days of logged life spent stationary. On your longest quarter of outings ${longShare}% of the clock is stopped — the price of a long day out is mostly not riding.`
    : `${share}% of your elapsed time is spent actually moving, rising to ${100-longShare}% on your longest quarter of outings.`);
}

// Average a numeric field per month, skipping months with nothing to average.
function monthlyMean(acts,monthKeys,pick){
  const acc={};
  acts.forEach(a=>{
    const v=pick(a);if(v==null||!isFinite(v))return;
    const m=a.date.slice(0,7);if(!monthKeys.includes(m))return;
    if(!acc[m])acc[m]={s:0,n:0};
    acc[m].s+=v;acc[m].n++;
  });
  const months=monthKeys.filter(m=>acc[m]&&acc[m].n);
  return{months,mean:m=>acc[m].s/acc[m].n,count:months.reduce((s,m)=>s+acc[m].n,0)};
}

// ── POWER ──
// There is a power record on the Records page but no trend anywhere, and watts
// are the one number here that cannot be inflated by simply riding more often.
function renderPowerChart(data,monthKeys){
  const withPwr=data.filter(a=>a.pwr>0);
  if(withPwr.length<5){
    setChartEmpty('chartPower','No activities in this filter record power. Watts arrive with a power meter, or with Strava’s estimate on a ride recorded by a head unit.');
    chartSummary('power',[],'');
    return;
  }
  setChartEmpty('chartPower');
  const avg=monthlyMean(withPwr,monthKeys,a=>a.pwr);
  const np=monthlyMean(withPwr,monthKeys,a=>a.np);
  // device_watts says whether these came off a meter. An estimate is not useless,
  // but a trend built on one is really a speed trend, so the card says which.
  const real=withPwr.filter(a=>a.pwr_real).length;
  const sub=document.getElementById('powerSub');
  if(sub)sub.textContent=`Average${np.months.length?' and normalised':''} watts per month — ${withPwr.length.toLocaleString('en-GB')} activit${withPwr.length===1?'y':'ies'} with power`
    +(real===0?', all of it estimated by Strava from speed and weight rather than measured'
      :real===withPwr.length?', all measured by a power meter'
      :`, ${Math.round(real/withPwr.length*100)}% of it measured rather than estimated`);
  if(!avg.months.length){
    setChartEmpty('chartPower','No power inside the charted months.');
    chartSummary('power',[],'');return;
  }
  const sets=[{label:'Average',data:avg.months.map(m=>Math.round(avg.mean(m))),
    borderColor:'#6d28d9',backgroundColor:'#6d28d914',fill:true,tension:.25,pointRadius:0,pointHitRadius:12,borderWidth:2.5}];
  if(np.months.length>=avg.months.length*0.5)sets.push({label:'Normalised',
    data:avg.months.map(m=>np.months.includes(m)?Math.round(np.mean(m)):null),
    borderColor:'#f59e0b',borderDash:[5,4],fill:false,tension:.25,pointRadius:0,pointHitRadius:12,borderWidth:2,spanGaps:true});
  destroyChart('power');
  charts.power=upsertChart('power',document.getElementById('chartPower').getContext('2d'),{
    type:'line',data:{labels:avg.months.map(monthLabel),datasets:sets},
    options:{plugins:{legend:{display:sets.length>1,position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{callbacks:{label:c=>c.dataset.label+': '+c.parsed.y+'w'}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:10}},
        y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+'w'}}}}
  });
  const all=avg.months.map(m=>avg.mean(m));
  const overall=all.reduce((s,v)=>s+v,0)/all.length;
  const peakIdx=all.indexOf(Math.max(...all));
  const chips=[{n:Math.round(overall)+'w',label:'average',col:'#6d28d9'}];
  if(np.months.length)chips.push({n:Math.round(np.months.reduce((s,m)=>s+np.mean(m),0)/np.months.length)+'w',label:'normalised',col:'#f59e0b'});
  chips.push({n:Math.round(all[peakIdx])+'w',label:'best month · '+monthLabel(avg.months[peakIdx]),col:'#1d4ed8'});
  let verdict;
  if(all.length>=4){
    const half=Math.floor(all.length/2);
    const early=all.slice(0,half).reduce((s,v)=>s+v,0)/half;
    const late=all.slice(-half).reduce((s,v)=>s+v,0)/half;
    const d=Math.round((late-early)/early*100);
    chips.push({n:(d>=0?'+':'−')+Math.abs(d)+'%',label:'recent vs earlier',col:d>=0?'#16a34a':'#ff385c'});
    verdict=d>=3?`Up ${d}% across the charted months. Distance, elevation and effort all rise when you simply do more; watts do not, so this one is real.`
      :d<=-3?`Down ${Math.abs(d)}% across the charted months — the only chart on this tab where a fall cannot be explained by riding less often.`
      :`Flat within ${Math.abs(d)}% across the charted months. Steady rather than stagnant, depending on what you were training for.`;
  }else verdict=`${all.length} month${all.length===1?'':'s'} with power in them. A trend needs a few more.`;
  chartSummary('power',chips,verdict);
}

// ── CADENCE ──
// Strava reports foot cadence as one leg, so runs are charted at double on their
// own axis. Putting ~85 rpm and ~170 spm on one scale would flatten the bike line.
function renderCadenceChart(data,monthKeys){
  const withCad=data.filter(a=>a.cad>0);
  if(withCad.length<5){
    setChartEmpty('chartCad','No activities in this filter record cadence.');
    chartSummary('cad',[],'');
    return;
  }
  setChartEmpty('chartCad');
  const wheeled=withCad.filter(a=>{const g=typeGroup(a.type);return g==='Ride'||g==='Virtual';});
  const footed=withCad.filter(a=>{const g=typeGroup(a.type);return g==='Run'||g==='Walk';});
  const rpm=monthlyMean(wheeled,monthKeys,a=>a.cad);
  const spm=monthlyMean(footed,monthKeys,a=>a.cad*2);
  const months=monthKeys.filter(m=>rpm.months.includes(m)||spm.months.includes(m));
  if(!months.length){
    setChartEmpty('chartCad','No cadence inside the charted months.');
    chartSummary('cad',[],'');return;
  }
  const sub=document.getElementById('cadSub');
  if(sub)sub.textContent='Average cadence per month — '+withCad.length.toLocaleString('en-GB')+' activit'+(withCad.length===1?'y':'ies')+' with cadence'
    +(footed.length?'. Foot cadence is doubled to steps per minute, the way you would count it':'');
  const sets=[];
  if(rpm.months.length)sets.push({label:'Ride · rpm',yAxisID:'y',
    data:months.map(m=>rpm.months.includes(m)?Math.round(rpm.mean(m)):null),
    borderColor:'#1d4ed8',backgroundColor:'#1d4ed814',fill:true,tension:.25,pointRadius:0,pointHitRadius:12,borderWidth:2.5,spanGaps:true});
  if(spm.months.length)sets.push({label:'Run · spm',yAxisID:rpm.months.length?'y2':'y',
    data:months.map(m=>spm.months.includes(m)?Math.round(spm.mean(m)):null),
    borderColor:'#ef4444',fill:false,tension:.25,pointRadius:0,pointHitRadius:12,borderWidth:2.5,spanGaps:true});
  const scales={x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:10}},
    y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+(rpm.months.length?' rpm':' spm')}}};
  if(rpm.months.length&&spm.months.length)scales.y2={position:'right',grid:{display:false},ticks:{font:{size:11},callback:v=>v+' spm'}};
  destroyChart('cad');
  charts.cad=upsertChart('cad',document.getElementById('chartCad').getContext('2d'),{
    type:'line',data:{labels:months.map(monthLabel),datasets:sets},
    options:{plugins:{legend:{display:sets.length>1,position:'bottom',labels:{boxWidth:10,font:{size:11}}}},
      responsive:true,maintainAspectRatio:false,scales}
  });
  const chips=[];
  if(rpm.months.length)chips.push({n:Math.round(rpm.months.reduce((s,m)=>s+rpm.mean(m),0)/rpm.months.length)+' rpm',label:'riding',col:'#1d4ed8'});
  if(spm.months.length)chips.push({n:Math.round(spm.months.reduce((s,m)=>s+spm.mean(m),0)/spm.months.length)+' spm',label:'on foot',col:'#ef4444'});
  let verdict='';
  const trendOf=(g,unitStr)=>{
    if(g.months.length<4)return null;
    const vals=g.months.map(m=>g.mean(m)),half=Math.floor(vals.length/2);
    const early=vals.slice(0,half).reduce((s,v)=>s+v,0)/half;
    const late=vals.slice(-half).reduce((s,v)=>s+v,0)/half;
    return{d:Math.round(late-early),unitStr};
  };
  const rt=trendOf(rpm,'rpm'),st=trendOf(spm,'spm');
  if(rt&&Math.abs(rt.d)>=2){
    chips.push({n:(rt.d>=0?'+':'−')+Math.abs(rt.d),label:'rpm since earlier',col:rt.d>=0?'#16a34a':'#f59e0b'});
    verdict=rt.d>0?`Riding cadence is up ${rt.d} rpm on the earlier half — spinning more, grinding less.`
      :`Riding cadence is down ${Math.abs(rt.d)} rpm on the earlier half, which usually means bigger gears or more climbing.`;
  }
  if(st&&Math.abs(st.d)>=3)verdict+=(verdict?' ':'')+`Running cadence has moved ${st.d>0?'up':'down'} ${Math.abs(st.d)} spm; 170–180 is the range most coaches aim at.`;
  if(!verdict)verdict='Cadence is steady across the charted months. It is a habit more than a fitness marker, so flat is the normal answer.';
  chartSummary('cad',chips,verdict);
}

// ── RACE DAY ──
// wtype has been stored since the worker was written and only the Activity Log
// ever read it. It answers the question training charts never do: how much is
// left in you when it counts.
function renderRaceChart(data){
  const races=data.filter(isRace);
  if(races.length<2){
    setChartEmpty('chartRace','Fewer than two activities here are marked as a race in Strava. Setting an activity’s type to Race is what fills this in.');
    chartSummary('race',[],'');
    return;
  }
  setChartEmpty('chartRace');
  // Compare like with like: only the sports that actually contain races, and
  // only against your ordinary sessions in that same sport.
  const groups=[...new Set(races.map(a=>typeGroup(a.type)))];
  const speedOf=a=>unit==='mi'?a.speed_mph:a.speed_kph;
  const mean=(arr,pick)=>{const v=arr.map(pick).filter(x=>x>0&&isFinite(x));return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;};
  const rows=groups.map(g=>{
    const r=races.filter(a=>typeGroup(a.type)===g);
    const o=data.filter(a=>!isRace(a)&&typeGroup(a.type)===g);
    return{g,n:r.length,race:mean(r,speedOf),other:mean(o,speedOf),
      raceHr:mean(r,a=>a.hr),otherHr:mean(o,a=>a.hr)};
  }).filter(x=>x.race!=null&&x.other!=null);
  if(!rows.length){
    setChartEmpty('chartRace','Your races have no ordinary sessions in the same sport to compare against.');
    chartSummary('race',[],'');return;
  }
  const sub=document.getElementById('raceSub');
  if(sub)sub.textContent=`${races.length.toLocaleString('en-GB')} race${races.length===1?'':'s'} against your ordinary sessions in the same sport — average speed in ${unit==='mi'?'mph':'km/h'}`;
  destroyChart('race');
  charts.race=upsertChart('race',document.getElementById('chartRace').getContext('2d'),{
    type:'bar',
    data:{labels:rows.map(r=>r.g+' · '+r.n),datasets:[
      {label:'Races',data:rows.map(r=>+r.race.toFixed(1)),backgroundColor:'#ff385c',borderRadius:0},
      {label:'Everything else',data:rows.map(r=>+r.other.toFixed(1)),backgroundColor:'#cbd5e1',borderRadius:0}]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{callbacks:{label:c=>c.dataset.label+': '+c.parsed.y+(unit==='mi'?' mph':' km/h')}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:11}}},y:{grid:{color:chartGrid()},ticks:{font:{size:11}}}},
      interaction:{mode:'index'}}
  });
  const big=rows.reduce((b,r)=>r.n>b.n?r:b,rows[0]);
  const pct=Math.round((big.race-big.other)/big.other*100);
  const chips=[{n:races.length.toLocaleString('en-GB'),label:'race'+(races.length===1?'':'s')+' logged',col:'#ff385c'},
    {n:(pct>=0?'+':'−')+Math.abs(pct)+'%',label:'speed on '+big.g.toLowerCase()+' race day',col:pct>=0?'#16a34a':'#f59e0b'}];
  if(big.raceHr&&big.otherHr){
    const hd=Math.round(big.raceHr-big.otherHr);
    chips.push({n:(hd>=0?'+':'−')+Math.abs(hd),label:'bpm',col:'#ef4444'});
  }
  let verdict;
  if(pct>=5)verdict=`On ${big.g.toLowerCase()} race day you go ${pct}% faster than a normal session`
    +(big.raceHr&&big.otherHr?` at ${Math.round(big.raceHr-big.otherHr)} bpm more`:'')+`. That gap is what a number on your back is worth.`;
  else if(pct<=-5)verdict=`Your ${big.g.toLowerCase()} races average ${Math.abs(pct)}% slower than your ordinary sessions — usually a sign they were longer, hillier, or hotter than a normal day out.`;
  else verdict=`Race day and an ordinary ${big.g.toLowerCase()} come out within ${Math.abs(pct)}% of each other. Either you race your training, or you train your races.`;
  chartSummary('race',chips,verdict);
}

// ── TEMPERATURE ──
// average_temp comes off a head unit sensor, so indoor and phone-recorded
// activities have none. The card says its own coverage rather than quietly
// drawing a chart of the quarter of your rides that happen to carry it.
const TEMP_BANDS=[[-99,4,'under 4°'],[4,8,'4–8°'],[8,12,'8–12°'],[12,16,'12–16°'],[16,20,'16–20°'],[20,24,'20–24°'],[24,99,'24°+']];
function renderTempChart(data){
  const withTemp=data.filter(a=>a.temp!=null&&isFinite(a.temp)&&a.temp>-40&&a.temp<60);
  const sub=document.getElementById('tempSub');
  if(withTemp.length<10){
    setChartEmpty('chartTemp',withTemp.length
      ? `Only ${withTemp.length} activit${withTemp.length===1?'y has':'ies have'} a temperature reading, which is too few to compare bands.`
      : 'No activities here carry a temperature. It comes off a head unit sensor, so indoor rides and phone-recorded sessions have none — and it only arrives from the next Strava refresh onward.');
    if(sub)sub.textContent='Average speed by temperature band';
    chartSummary('temp',[],'');
    return;
  }
  setChartEmpty('chartTemp');
  const cov=Math.round(withTemp.length/Math.max(1,data.length)*100);
  if(sub)sub.textContent=`Average speed by temperature band — ${withTemp.length.toLocaleString('en-GB')} of ${data.length.toLocaleString('en-GB')} activities carry a reading (${cov}%), so this describes the sessions your head unit recorded, not all of them`;
  const bands=TEMP_BANDS.map(([lo,hi,label])=>{
    const inBand=withTemp.filter(a=>a.temp>=lo&&a.temp<hi);
    const sp=inBand.map(a=>unit==='mi'?a.speed_mph:a.speed_kph).filter(v=>v>0&&isFinite(v));
    return{label,n:inBand.length,
      speed:sp.length?sp.reduce((s,v)=>s+v,0)/sp.length:null,
      dist:inBand.reduce((s,a)=>s+(a.dist_mi||0),0)};
  }).filter(b=>b.n>=3);
  // A band keeps its count even when none of its activities carry a usable speed,
  // so `bands` can be non-empty while every entry's speed is null. The summary
  // below reduces over the rated subset and indexes rated[0], which in that case
  // is undefined — and the exception takes the whole Charts tab down with it.
  if(!bands.filter(b=>b.speed!=null).length){
    setChartEmpty('chartTemp','Activities here carry a temperature but no usable speed, so there is nothing to compare across bands.');
    chartSummary('temp',[],'');
    return;
  }
  if(bands.length<2){
    setChartEmpty('chartTemp','Your temperature readings all fall in one band, so there is nothing to compare.');
    chartSummary('temp',[],'');return;
  }
  destroyChart('temp');
  charts.temp=upsertChart('temp',document.getElementById('chartTemp').getContext('2d'),{
    type:'bar',
    data:{labels:bands.map(b=>b.label),datasets:[{
      data:bands.map(b=>b.speed!=null?+b.speed.toFixed(1):null),
      backgroundColor:bands.map(b=>{
        const t=parseFloat(b.label)||0;
        return t<8?'#0ea5e9':t<16?'#22c55e':t<24?'#f59e0b':'#ef4444';
      }),borderRadius:0}]},
    options:{plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>c.parsed.y+(unit==='mi'?' mph':' km/h')+' · '+bands[c.dataIndex].n+' activities'}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:11}}},
        y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+(unit==='mi'?' mph':' km/h')}}}}
  });
  const rated=bands.filter(b=>b.speed!=null);
  const fastest=rated.reduce((b,x)=>x.speed>b.speed?x:b,rated[0]);
  const busiest=bands.reduce((b,x)=>x.n>b.n?x:b,bands[0]);
  const spread=Math.max(...rated.map(b=>b.speed))-Math.min(...rated.map(b=>b.speed));
  chartSummary('temp',[
    {n:busiest.label,label:'where you ride most · '+busiest.n,col:'#1d4ed8'},
    {n:fastest.label,label:'your fastest band',col:'#16a34a'},
    {n:spread.toFixed(1),label:(unit==='mi'?'mph':'km/h')+' between best and worst',col:'#ff385c'},
  ],
  (()=>{
    const sp=unit==='mi'?'mph':'km/h';
    if(spread<1.5)return `Speed barely moves with temperature — ${spread.toFixed(1)} ${sp} across every band. Weather changes how it feels far more than how fast you go.`;
    const i=rated.indexOf(fastest),mid=i>0&&i<rated.length-1;
    const slowest=rated.reduce((b,x)=>x.speed<b.speed?x:b,rated[0]);
    // Only claim the extremes are slowest when the quickest band is actually in
    // the middle. If your best band is the coldest one, say that instead.
    return mid
      ? `You are quickest in the ${fastest.label} band and slower at both ends of the range — ${spread.toFixed(1)} ${sp} separates best from worst, which is more than most people would guess.`
      : `Your quickest riding is in the ${fastest.label} band and your slowest in ${slowest.label}, ${spread.toFixed(1)} ${sp} apart. With your best band at the edge of the range, this is as likely to be which rides you do in that weather as the weather itself.`;
  })());
}

// ── THREE CHARTS OVER DATA THAT WAS ALREADY BEING FETCHED ──
// Heart-rate zones, Relative Effort and time of day were all sitting in the
// activity payload with nothing drawing them.

// Replaced by the Worker's envelope on load; the fallback keeps the chart honest
// about not knowing yet rather than asserting a source.
let HR_ZONE_META={athleteMaxHr:null,source:'derived'};

const ZONE_COLORS=['#94a3b8','#0ea5e9','#22c55e','#f59e0b','#ef4444'];
const ZONE_NAMES=['Z1 Recovery','Z2 Endurance','Z3 Tempo','Z4 Threshold','Z5 VO2 max'];

// Render the figure chips and the verdict line under a chart. Passing nothing for
// either clears it, and the empty container collapses, so a filter that leaves a
// chart with nothing to say leaves no gap behind.
function chartSummary(id,chips,verdict){
  const c=document.getElementById(id+'Chips'),v=document.getElementById(id+'Verdict');
  if(c)c.innerHTML=(chips||[]).map(x=>
    `<div class="chart-chip" style="color:${x.col};background:${x.col}1a"><strong>${escapeHtml(x.n)}</strong> ${escapeHtml(x.label)}</div>`
  ).join('');
  if(v)v.textContent=verdict||'';
}


// Hide a chart's canvas and put a sentence in its place. Passing no message puts
// the canvas back, so the same call handles both directions on a filter change.
function setChartEmpty(canvasId,msg){
  const cv=document.getElementById(canvasId);if(!cv)return;
  const wrap=cv.parentElement;
  let note=wrap.querySelector('.chart-empty');
  if(!msg){cv.style.display='';if(note)note.remove();return;}
  destroyChart(canvasId.replace(/^chart/,'').toLowerCase());
  cv.style.display='none';
  if(!note){note=document.createElement('div');note.className='chart-empty';wrap.appendChild(note);}
  note.textContent=msg;
}


function renderExtraCharts(data,monthKeys){
  // ── Heart-rate zones ──
  const withHr=data.filter(a=>a.hr&&(a.z1||a.z2||a.z3||a.z4||a.z5));
  const tot=[0,0,0,0,0];
  withHr.forEach(a=>{tot[0]+=a.z1||0;tot[1]+=a.z2||0;tot[2]+=a.z3||0;tot[3]+=a.z4||0;tot[4]+=a.z5||0;});
  const totalSec=tot.reduce((s,v)=>s+v,0);
  if(!totalSec){
    setChartEmpty('chartZones','No activities in this filter have heart-rate data.');
    chartSummary('zone',[],'');
  }else{
    setChartEmpty('chartZones');
    // Say plainly where these come from: Strava's summary endpoint gives one average
    // heart rate per activity, not the stream, so the split is modelled from that
    // average and the moving time rather than measured second by second.
    document.getElementById('zoneSub').textContent=
      HR_ZONE_META.source==='strava'
        ? `Estimated from each activity's average heart rate, split across the zones you set in Strava — ${withHr.length.toLocaleString('en-GB')} activit${withHr.length===1?'y':'ies'} with HR data, ${fmtHours(totalSec)} in total`
        : `Estimated from each activity's average heart rate against a max of ${HR_ZONE_META.athleteMaxHr||'—'} bpm, the highest you have recorded. Strava's own zones need a permission this app doesn't ask for. ${withHr.length.toLocaleString('en-GB')} activit${withHr.length===1?'y':'ies'} with HR data, ${fmtHours(totalSec)} in total`;
    destroyChart('zones');
    charts.zones=upsertChart('zones',document.getElementById('chartZones').getContext('2d'),{
      type:'bar',
      data:{labels:ZONE_NAMES,datasets:[{data:tot.map(s=>+(s/3600).toFixed(1)),backgroundColor:ZONE_COLORS,borderRadius:0}]},
      options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.parsed.y}h · ${Math.round(tot[c.dataIndex]/totalSec*100)}% of HR time`}}},
        responsive:true,maintainAspectRatio:false,
        scales:{x:{grid:{display:false},ticks:{font:{size:11}}},y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v+'h'}}}}
    });
    // This card invented the chips-and-verdict treatment, then kept its own copy
    // of the markup while every other card moved to the shared helper. Same
    // output, one implementation.
    const pc=n=>Math.round(n/totalSec*100);
    const easy=pc(tot[0]+tot[1]),mid=pc(tot[2]),hard=pc(tot[3]+tot[4]);
    let v;
    if(easy>=75&&hard>=8)v=`${easy}% easy · ${mid}% tempo · ${hard}% hard — roughly the polarised shape most endurance plans aim for.`;
    else if(easy>=75)v=`${easy}% easy · ${mid}% tempo · ${hard}% hard. The easy base is there; the sharp end is thin.`;
    else if(mid>=25)v=`${easy}% easy · ${mid}% tempo · ${hard}% hard. A lot of this sits in the middle, which is the classic way to be permanently tired without getting faster.`;
    else v=`${easy}% easy · ${mid}% tempo · ${hard}% hard. Most plans would have the easy number closer to 80%.`;
    chartSummary('zone',tot.map((s,i)=>({
      n:pc(s)+'%',label:ZONE_NAMES[i].split(' ')[0]+' · '+fmtHours(s),col:ZONE_COLORS[i],
    })),v);
  }

  renderMovingChart(data,monthKeys);
  renderPowerChart(data,monthKeys);
  renderCadenceChart(data,monthKeys);
  renderRaceChart(data);
  renderTempChart(data);

  // ── Relative Effort ──
  const monthEff={};let effTot=0;
  data.forEach(a=>{const s=a.score||0;if(!s)return;effTot+=s;const m=a.date.slice(0,7);monthEff[m]=(monthEff[m]||0)+s;});
  if(!effTot){
    setChartEmpty('chartEffort','No Relative Effort recorded for these activities. Strava only scores activities with heart-rate data.');
    chartSummary('effort',[],'');
  }else{
    // Recent three months against the rest, which is the question a load chart is
    // actually being asked: am I building or backing off?
    const withVals=monthKeys.filter(m=>monthEff[m]>0);
    const recent=withVals.slice(-3),earlier=withVals.slice(0,-3);
    const mean=ms=>ms.length?ms.reduce((s,m)=>s+monthEff[m],0)/ms.length:0;
    const rAvg=mean(recent),eAvg=mean(earlier);
    const best=withVals.reduce((b,m)=>monthEff[m]>monthEff[b]?m:b,withVals[0]);
    chartSummary('effort',[
      {n:chipNum(effTot),label:'total effort',col:'#ff385c'},
      {n:chipNum(rAvg),label:'recent 3-month average',col:'#f59e0b'},
      {n:chipNum(monthEff[best]),label:'peak · '+monthLabel(best),col:'#8b5cf6'},
    ],
    (()=>{
      if(!earlier.length||!eAvg)return `Peaked in ${monthLabel(best)}. Strava scores an activity only when it has heart-rate data, so a gap here is usually a flat battery rather than a rest week.`;
      const d=Math.round((rAvg-eAvg)/eAvg*100);
      if(d>=20)return `The last three months are running ${d}% above your earlier average. That is a real build — worth knowing whether it was deliberate.`;
      if(d<=-20)return `The last three months are ${Math.abs(d)}% below your earlier average. Either a deliberate back-off, or the season got away from you.`;
      return `The last three months sit within ${Math.abs(d)}% of your earlier average — steady, neither building nor backing off.`;
    })());
  }
  if(effTot){
    setChartEmpty('chartEffort');
    const scored=data.filter(a=>a.score>0).length;
    document.getElementById('effortSub').textContent=
      `Strava's suffer score, totalled per month — ${scored.toLocaleString('en-GB')} of ${data.length.toLocaleString('en-GB')} activities are scored`;
    destroyChart('effort');
    charts.effort=upsertChart('effort',document.getElementById('chartEffort').getContext('2d'),{
      type:'bar',
      data:{labels:monthKeys.map(monthLabel),datasets:[{data:monthKeys.map(m=>Math.round(monthEff[m]||0)),backgroundColor:'#ff385c',borderRadius:0}]},
      options:{plugins:{legend:{display:false}},responsive:true,maintainAspectRatio:false,
        scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v.toLocaleString()}}}}
    });
  }

  // ── Time of day ──
  // a.time only exists on activities cached since the Worker started keeping it,
  // so an older cache legitimately has none and should say so rather than draw a
  // chart of twenty-four zeroes.
  const timed=data.filter(a=>typeof a.time==='string'&&/^\d{2}:\d{2}$/.test(a.time));
  if(!timed.length){
    setChartEmpty('chartTod','Start times arrive with the next Strava refresh.');
    chartSummary('tod',[],'');
  }else{
    setChartEmpty('chartTod');
    const hours=new Array(24).fill(0);
    timed.forEach(a=>{hours[+a.time.slice(0,2)]++;});
    const peak=hours.indexOf(Math.max(...hours));
    const pad=n=>String(n).padStart(2,'0');
    document.getElementById('todSub').textContent=
      `Activities by hour started — busiest hour is ${pad(peak)}:00–${pad((peak+1)%24)}:00 (${hours[peak].toLocaleString('en-GB')})`;
    destroyChart('tod');
    charts.tod=upsertChart('tod',document.getElementById('chartTod').getContext('2d'),{
      type:'bar',
      data:{labels:hours.map((_,h)=>pad(h)),datasets:[{data:hours,backgroundColor:hours.map((_,h)=>h===peak?'#ff385c':'#cbd5e1'),borderRadius:0}]},
      options:{plugins:{legend:{display:false},tooltip:{callbacks:{title:c=>`${pad(c[0].dataIndex)}:00–${pad((c[0].dataIndex+1)%24)}:00`,label:c=>`${c.parsed.y} activit${c.parsed.y===1?'y':'ies'}`}}},
        responsive:true,maintainAspectRatio:false,
        scales:{x:{grid:{display:false},ticks:{font:{size:9},autoSkip:false,maxRotation:0,callback:(v,i)=>i%3===0?pad(i):''}},y:{grid:{color:chartGrid()},ticks:{font:{size:11},precision:0}}}}
    });

    // Before 12, 12 to 17, 17 onwards. Crude, but it is the split people actually
    // think in — before work, in the day, after work.
    const band=(a,b)=>hours.slice(a,b).reduce((s,n)=>s+n,0);
    const morning=band(0,12),afternoon=band(12,17),evening=band(17,24);
    const n=timed.length,p=v=>Math.round(v/n*100);
    chartSummary('tod',[
      {n:p(morning)+'%',label:'before noon',col:'#f59e0b'},
      {n:p(afternoon)+'%',label:'afternoon',col:'#0ea5e9'},
      {n:p(evening)+'%',label:'evening',col:'#8b5cf6'},
    ],
    (()=>{
      const top=Math.max(morning,afternoon,evening);
      const share=p(top);
      const early=band(0,8),late=band(20,24);
      if(share>=60&&top===morning)return `${share}% of your training happens before noon, and ${p(early)}% of it before eight. You are a morning athlete, whatever you tell people.`;
      if(share>=60&&top===evening)return `${share}% after five, ${p(late)}% after eight. Training fits around the day rather than the day around training.`;
      if(share>=60)return `${share}% of it lands in the afternoon — an unusual pattern, and one that suggests a flexible day.`;
      return `Spread fairly evenly: ${p(morning)}% before noon, ${p(afternoon)}% in the afternoon, ${p(evening)}% in the evening. No single habit dominates.`;
    })());
  }
}

// Year calendar chart
function renderYearCalendarChart(year,data){
  const byDay={};
  data.forEach(a=>{
    if(!byDay[a.date])byDay[a.date]={dist:0,types:{},time:{},acts:[]};
    byDay[a.date].dist+=a.dist_mi||0;
    const g=typeGroup(a.type);byDay[a.date].types[g]=(byDay[a.date].types[g]||0)+1;
    byDay[a.date].time[g]=(byDay[a.date].time[g]||0)+(a.mt||0);
    byDay[a.date].acts.push(a);
  });
  const maxDist=Math.max(...Object.values(byDay).map(d=>d.dist),1);
  const sd=new Date(year,0,1),ed=new Date(year,11,31);
  const fd=new Date(sd);const dow0=fd.getDay();fd.setDate(fd.getDate()-(dow0===0?6:dow0-1));
  let weeks=[],cur=new Date(fd),lastMonth='';
  while(cur<=ed){
    const weekCells=[];let monthLabel='';
    for(let d=0;d<7;d++){
      const ds=cur.toISOString().slice(0,10);
      const inY=cur>=sd&&cur<=ed;
      const mn=cur.toLocaleString('en-GB',{month:'short'});
      if(inY&&d===0&&mn!==lastMonth){monthLabel=mn;lastMonth=mn;}
      const dd=inY?byDay[ds]:null;
      let bg;
      if(!inY)bg='transparent';
      else if(!dd)bg='#f0f0f0';
      else bg=dayCellBg(dd,maxDist);
      const cursor=dd?'cursor:pointer;':'';
      weekCells.push(dd?
        `<div class="year-cal-cell" data-day-tip="${ds}" role="gridcell" tabindex="-1" aria-label="${dayCellLabel(ds,dd)}" style="${cursor}background:${bg}" data-on-mouseenter="showDashTooltip" data-args-mouseenter='${escapeAttr(JSON.stringify(["$event", ds]))}' data-on-mouseleave="hideDashTooltip" data-on-click="showYearCalDay" data-args-click='${escapeAttr(JSON.stringify([ds]))}'></div>`:
        `<div class="year-cal-cell" style="background:${bg}"></div>`);
      cur.setDate(cur.getDate()+1);
    }
    weeks.push({cells:weekCells,label:monthLabel});
  }
  const hdr=`<div class="ycal-header-row"><div class="ycal-month-label"></div>${['M','T','W','T','F','S','S'].map(l=>`<div class="ycal-dow-hdr">${l}</div>`).join('')}</div>`;
  const rows=weeks.map(w=>`<div class="ycal-row"><div class="ycal-month-label">${w.label}</div>${w.cells.join('')}</div>`).join('');
  document.getElementById('firstChartCalendar').innerHTML=`<div class="ycal-grid">${hdr}${rows}</div>`;
  armCalendarGrids(document.getElementById('firstChartCalendar'));
}

// Where each of these two charts draws. The Summary hero and the Charts tab show the
// same figures from the same computation against different canvases, rather than two
// implementations that can drift apart.
const LOAD_TARGET={canvas:'chartLoad',key:'load',sub:'loadSub',chips:'load'};
const CUM_TARGET ={canvas:'chartCumulative',key:'cumulative',sub:'cumSub',chips:'cum'};
const SUM_LOAD_TARGET={canvas:'chartSumLoad',key:'sumload',sub:'sumLoadSub',chips:'sumLoad'};
const SUM_CUM_TARGET ={canvas:'chartSumCum',key:'sumcum',sub:'sumCumSub',chips:'sumCum'};
const SUM_DIST_TARGET={canvas:'chartSumDist',key:'sumdist',sub:'sumDistSub',chips:'sumDist'};

function todayDoy(){return dayOfYear(new Date().toISOString().slice(0,10));}
// Day-of-year of the first of each month, for axis ticks. Uses a non-leap year:
// the labels are a scale, and a day's drift after February does not move a tick
// far enough to matter.
const MONTH_DOY=[1,32,60,91,121,152,182,213,244,274,305,335];
const MONTH_ABBR=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];


// The year in focus takes the accent; every earlier year is a grey, stepping
// lighter the further back it is.
//
// The first version of this tinted the accent towards grey instead, which sounded
// like the same idea and was not: five steps between green and grey are five
// greens, and on screen the years were indistinguishable from each other. Keeping
// hue for "the year you are asking about" and lightness alone for "how far back"
// means the comparison you came for is the only coloured line on the chart.
function yearRamp(n,i){
  if(i===0)return getAccentColor();
  if(n<=2)return'#64748b';
  const t=(i-1)/(n-2);              // 0 for last year, 1 for the oldest shown
  const v=Math.round(100+t*105);    // #646464 → #cdcdcd
  return`rgb(${v},${v},${v})`;
}

// ── TRAINING LOAD ──
// Acute (7-day) against chronic (28-day), both expressed as hours per week so
// they sit on one axis and the gap between them is readable directly. Moving
// time, not Relative Effort: `score` only exists on activities with heart-rate
// data, and a load chart that silently drops a third of your training is worse
// than no load chart.
function renderLoad(data,t=LOAD_TARGET){
  if(!data.length){
    setChartEmpty(t.canvas,'No activities in this filter.');
    chartSummary(t.chips,[],'');
    return;
  }
  // The windowing is shared with the distance hero below it, and lives in calc.js
  // where it can be tested. pick() returns hours, so the series comes back in them.
  const w=rollingWeekly(data,a=>(a.mt||0)/3600,{today:_today()});
  const {labels:label,acute,chronic,end,span:SPAN}=w;
  if(!w.hasData){
    setChartEmpty(t.canvas,'No activities in the last year of this filter.');
    chartSummary(t.chips,[],'');
    return;
  }
  setChartEmpty(t.canvas);

  document.getElementById(t.sub).textContent=
    `Hours per week — the last ${SPAN===365?'365 days':'year'}, ending ${fmtDate(end)}. The 28-day line is what you are conditioned for; the 7-day is what you just did.`;

  destroyChart(t.key);
  charts[t.key]=upsertChart(t.key,document.getElementById(t.canvas).getContext('2d'),{
    type:'line',
    data:{labels:label,datasets:[
      {label:'28-day average',data:chronic,borderColor:'#94a3b8',backgroundColor:'rgba(148,163,184,.14)',fill:true,tension:.25,pointRadius:0,borderWidth:2,order:1},
      {label:'7-day total',data:acute,borderColor:getAccentColor(),backgroundColor:'transparent',fill:false,tension:.2,pointRadius:0,borderWidth:2,order:0},
    ]},
    options:{
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:c=>fmtDate(c[0].label),
          label:c=>`${c.dataset.label}: ${c.parsed.y.toFixed(1)}h/week`}}},
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{grid:{display:false},ticks:{font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12,
          callback:function(v){const d=this.getLabelForValue(v);return d?monthLabel(d.slice(0,7)):'';}}},
        y:{grid:{color:chartGrid()},beginAtZero:true,ticks:{font:{size:11},callback:v=>v+'h'}}}}
  });

  const a7=w.latest.acute,c28=w.latest.chronic;
  const ratio=c28>0?a7/c28:0;
  const peak=w.peak;
  chartSummary(t.chips,[
    {n:chipNum(a7,1)+'h',label:'last 7 days',col:getAccentColor()},
    {n:chipNum(c28,1)+'h',label:'28-day average',col:'#94a3b8'},
    {n:c28>0?ratio.toFixed(2)+'×':'—',label:'acute vs chronic',col:ratio>1.5?'#ef4444':ratio<0.8?'#f59e0b':'#22c55e'},
    {n:chipNum(peak,1)+'h',label:'biggest week in view',col:'#8b5cf6'},
  ],
  (()=>{
    if(!c28)return 'Not enough recent training to have a baseline to compare against.';
    if(a7===0)return `Nothing in the last seven days, against a ${c28.toFixed(1)}h/week base. A gap this size is either deliberate or the start of one.`;
    if(ratio>1.5)return `The last week is ${ratio.toFixed(1)}× your 28-day base. Weeks that far above the line are where injuries come from — the number worth watching is not the total, it is the jump.`;
    if(ratio>1.3)return `Building: this week is ${Math.round((ratio-1)*100)}% above your 28-day base. That is a real step up, and a sustainable one if it does not repeat next week.`;
    if(ratio<0.6)return `This week is ${Math.round((1-ratio)*100)}% below your base. Fine as a taper or a rest week, worth noticing if it was not planned.`;
    if(ratio<0.8)return `Backing off slightly — ${a7.toFixed(1)}h against a ${c28.toFixed(1)}h base.`;
    return `Steady: ${a7.toFixed(1)}h this week against a ${c28.toFixed(1)}h base. Neither building nor letting go.`;
  })());
}

// ── CUMULATIVE, BY DAY OF YEAR ──
// The chart the Year-over-Year bars could not be: it holds today against the same
// date in every previous year rather than against those years' finished totals.
// Tone for the acute-vs-chronic ratio, shared by both hero figures so "steady"
// means the same thing whether you are reading hours or miles. Colours come from
// the cascade rather than literals, so they follow the theme.
function ratioTone(ratio){
  const b=ratioBand(ratio);
  const col=b.tone==='danger'?cssVar('--danger','#dc2626')
    :b.tone==='warn'?cssVar('--warn-icon','#b45309')
    :cssVar('--success-fg','#16a34a');
  return[col,b.word];
}

// ── DISTANCE PER WEEK ──
// The same window as the load chart above it, measuring distance instead of time,
// plus this week broken down by sport — which is the question the single line
// cannot answer: whether a big week was one long ride or a fortnight of walking.
function renderWeekDistance(data,t=SUM_DIST_TARGET){
  const u=distUnit();
  const unitWord=u==='mi'?'miles':'km';

  const setFig=(big,base,ratioHtml)=>{
    const b=document.getElementById('sumWeekDist');
    // The id goes back on the span each time: this innerHTML replaces the element
    // that carries it, so updating it separately beforehand would be overwritten.
    if(b)b.innerHTML=`${big}<span class="sum-big-unit" id="sumWeekDistUnit">${unitWord}</span>`;
    const s2=document.getElementById('sumDistBase');
    if(s2)s2.textContent=base;
    const r=document.getElementById('sumDistRatio');
    if(r)r.innerHTML=ratioHtml||'';
  };

  if(!data.length){
    setFig('—','No activities in this filter.','');
    setChartEmpty(t.canvas,'No activities in this filter.');
    chartSummary(t.chips,[],'');
    renderWeekSplit([],0);
    return;
  }

  // actDistIn rather than distIn: it prefers Strava's own kilometre figure over
  // converting the mile one, which differ in the last decimal.
  const w=rollingWeekly(data,a=>actDistIn(a),{today:_today()});
  const a7=w.latest.acute,c28=w.latest.chronic;
  const ratio=c28>0?a7/c28:0;

  setFig(
    chipNum(a7,a7<100?1:0),
    c28>0
      ? `against a ${chipNum(c28,c28<100?1:0)} ${u}/week base built over the last 28 days`
      : 'no training in the last 28 days to compare against',
    c28>0?(()=>{
      const[col,word]=ratioTone(ratio);
      return `<div class="sum-ratio" style="color:${col};background:${col}1a"><strong>${ratio.toFixed(2)}×</strong> ${word}</div>`;
    })():''
  );

  if(!w.hasData){
    setChartEmpty(t.canvas,'No activities in the last year of this filter.');
    chartSummary(t.chips,[],'');
    renderWeekSplit([],0);
    return;
  }
  setChartEmpty(t.canvas);

  document.getElementById(t.sub).textContent=
    `${u==='mi'?'Miles':'Kilometres'} per week — the last ${w.span===365?'365 days':'year'}, ending ${fmtDate(w.end)}. The 28-day line is the distance you have been holding; the 7-day is what you just covered.`;

  destroyChart(t.key);
  charts[t.key]=upsertChart(t.key,document.getElementById(t.canvas).getContext('2d'),{
    type:'line',
    data:{labels:w.labels,datasets:[
      {label:'28-day average',data:w.chronic,borderColor:cssVar('--other','#94a3b8'),backgroundColor:'rgba(148,163,184,.14)',fill:true,tension:.25,pointRadius:0,borderWidth:2,order:1},
      {label:'7-day total',data:w.acute,borderColor:getAccentColor(),backgroundColor:'transparent',fill:false,tension:.2,pointRadius:0,borderWidth:2,order:0},
    ]},
    options:{
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:c=>fmtDate(c[0].label),
          label:c=>`${c.dataset.label}: ${chipNum(c.parsed.y,1)} ${u}/week`}}},
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{grid:{display:false},ticks:{font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12,
          callback:function(v){const d=this.getLabelForValue(v);return d?monthLabel(d.slice(0,7)):'';}}},
        y:{grid:{color:chartGrid()},beginAtZero:true,ticks:{font:{size:11},callback:v=>chipNum(v,0)}}}}
  });

  // ── This week, by sport ──
  const from=new Date(_today()+'T12:00:00').getTime()-6*86400000;
  const fromDay=new Date(from);
  const fromISO=`${fromDay.getFullYear()}-${String(fromDay.getMonth()+1).padStart(2,'0')}-${String(fromDay.getDate()).padStart(2,'0')}`;
  const week=data.filter(a=>a.date>=fromISO&&a.date<=_today());
  const bySport={};
  week.forEach(a=>{const g=typeGroup(a.type);bySport[g]=(bySport[g]||0)+actDistIn(a);});
  const split=Object.entries(bySport).filter(([,d])=>d>0).sort((a,b)=>b[1]-a[1]);
  renderWeekSplit(split,a7);

  chartSummary(t.chips,[
    {n:chipNum(a7,1)+' '+u,label:'last 7 days',col:getAccentColor()},
    {n:chipNum(c28,1)+' '+u,label:'28-day average',col:cssVar('--other','#94a3b8')},
    {n:c28>0?ratio.toFixed(2)+'×':'—',label:'acute vs chronic',col:ratioTone(ratio)[0]},
    {n:chipNum(w.peak,1)+' '+u,label:'biggest week in view',col:cssVar('--virtual','#8b5cf6')},
  ],
  (()=>{
    if(!c28)return 'Not enough recent training to have a baseline to compare against.';
    if(a7===0)return `Nothing covered in the last seven days, against a ${chipNum(c28,1)} ${u}/week base.`;
    const top=split[0];
    const share=top?Math.round(top[1]/a7*100):0;
    const mix=top&&split.length>1
      ? ` ${top[0]} carried ${share}% of it, across ${split.length} sports.`
      : top?` All of it ${top[0].toLowerCase()}.`:'';
    if(ratio>1.5)return `${chipNum(a7,1)} ${u} — ${ratio.toFixed(1)}× your 28-day base. A jump that size is worth a look even when it felt easy.${mix}`;
    if(ratio>1.3)return `${chipNum(a7,1)} ${u}, ${Math.round((ratio-1)*100)}% above your 28-day base.${mix}`;
    if(ratio<0.6)return `${chipNum(a7,1)} ${u}, ${Math.round((1-ratio)*100)}% below your base.${mix}`;
    if(ratio<0.8)return `${chipNum(a7,1)} ${u} against a ${chipNum(c28,1)} ${u} base — a little down on where you have been.${mix}`;
    return `${chipNum(a7,1)} ${u} against a ${chipNum(c28,1)} ${u} base.${mix}`;
  })());
}

// The stacked bar and its key. Same pattern the Social tab uses for solo vs
// company, which is why those classes are no longer named for it.
function renderWeekSplit(split,total){
  const el=document.getElementById('sumDistSplit');
  if(!el)return;
  const u=distUnit();
  if(!split.length||!(total>0)){
    el.innerHTML=`<div class="sum-split"><div class="sum-split-head"><span class="sum-split-t">This week by sport</span></div>`+
      `<div class="sum-split-empty">Nothing logged in the last seven days.</div></div>`;
    return;
  }
  const pct=d=>d/total*100;
  el.innerHTML=`<div class="sum-split">
    <div class="sum-split-head">
      <span class="sum-split-t">This week by sport</span>
      <span class="sum-split-n">${escapeHtml(chipNum(total,1))} ${escapeHtml(u)} across ${split.length} ${split.length===1?'sport':'sports'}</span>
    </div>
    <div class="split-bar">${split.map(([g,d])=>
      `<span style="width:${pct(d).toFixed(2)}%;background:${groupColor(g)}" title="${escapeAttr(g+' · '+chipNum(d,1)+' '+u)}"></span>`).join('')}</div>
    <div class="split-key">${split.map(([g,d])=>
      `<span><i style="background:${groupColor(g)}"></i><b>${escapeHtml(chipNum(d,1))} ${escapeHtml(u)}</b> ${escapeHtml(g)} · ${Math.round(pct(d))}%</span>`).join('')}</div>
  </div>`;
}

function renderCumulative(data,t=CUM_TARGET){
  const years=[...new Set(ALL_DATA.map(a=>a.date.slice(0,4)))].sort().reverse();
  if(!years.length){setChartEmpty(t.canvas,'No activities.');chartSummary(t.chips,[],'');return;}

  // This chart is about years, so the header's year filter would empty it. It
  // takes the sport filter and picks its own set of years around the one in view.
  const focus=isYearScope(activeYear)?activeYear:years[0];
  const fi=years.indexOf(focus);
  const show=years.slice(Math.max(0,fi),Math.max(0,fi)+5);
  const byYear={};
  ALL_DATA.forEach(a=>{
    if(!typeMatches(a))return;
    const y=a.date.slice(0,4);
    if(!show.includes(y))return;
    const d=dayOfYear(a.date);
    (byYear[y]=byYear[y]||new Array(367).fill(0))[d]+=distIn(a);
  });
  if(!Object.keys(byYear).length){
    setChartEmpty(t.canvas,'No activities of this type in the years shown.');
    chartSummary(t.chips,[],'');return;
  }
  setChartEmpty(t.canvas);

  const isCurrent=focus===new Date().getFullYear().toString();
  const cutoff=isCurrent?todayDoy():366;
  const cum={};
  show.forEach(y=>{
    const src=byYear[y]||new Array(367).fill(0);
    const out=[];let run=0;
    // A past year is drawn to its end; the year in progress stops at today rather
    // than flat-lining to December, which would read as a collapse in form.
    const stop=(y===focus&&isCurrent)?cutoff:366;
    for(let d=1;d<=366;d++){run+=src[d];out.push(d<=stop?+run.toFixed(1):null);}
    cum[y]=out;
  });

  // The projection that used to be drawn here has moved to its own panel, "Where
  // the year ends", which can mix a seasonal shape into it and show the spread
  // between the two methods. Two dotted lines on one tab reaching different answers
  // by different arithmetic is worse than one that explains itself.
  destroyChart(t.key);
  charts[t.key]=upsertChart(t.key,document.getElementById(t.canvas).getContext('2d'),{
    type:'line',
    data:{labels:Array.from({length:366},(_,i)=>i+1),
      datasets:show.map((y,i)=>({
        label:y,data:cum[y],
        borderColor:yearRamp(show.length,i),
        backgroundColor:'transparent',
        borderWidth:i===0?2.5:1.5,
        pointRadius:0,tension:.1,fill:false,spanGaps:false,
      }))},
    options:{
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:c=>{const d=+c[0].label;const mi=MONTH_DOY.filter(m=>m<=d).length-1;
            return`${MONTH_ABBR[mi]} ${d-MONTH_DOY[mi]+1} · day ${d}`;},
          label:c=>c.parsed.y==null?null:`${c.dataset.label}: ${fmtDist(unit==='mi'?c.parsed.y:c.parsed.y/1.60934)} ${distUnit()}`}}},
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:false,
          callback:v=>{const i=MONTH_DOY.indexOf(v+1);return i>=0?MONTH_ABBR[i]:'';}}},
        y:{grid:{color:chartGrid()},beginAtZero:true,
          ticks:{font:{size:11},callback:v=>v.toLocaleString()+' '+distUnit()}}}}
  });

  // The like-for-like figures. `at` reads a year's cumulative total on the day of
  // year the focus year has reached — the whole point of the chart.
  const at=(y,d)=>cum[y]?(cum[y][Math.min(d,366)-1]??cum[y].filter(v=>v!=null).slice(-1)[0]??0):null;
  const prev=show[1];
  const hereNow=at(focus,cutoff),thenPrev=prev!=null?at(prev,cutoff):null;
  const fmtD=v=>fmtDist(unit==='mi'?v:v/1.60934);

  document.getElementById(t.sub).textContent=isCurrent
    ? `Distance run up from 1 January, ${focus} against the ${show.length-1} years before it. The comparison is made on day ${cutoff}, the point ${focus} has actually reached.`
    : `Distance run up from 1 January, ${focus} against the years around it.`;

  const chips=[{n:fmtD(hereNow)+' '+distUnit(),label:isCurrent?`${focus} so far`:`${focus} total`,col:getAccentColor()}];
  if(thenPrev!=null)chips.push({n:fmtD(thenPrev)+' '+distUnit(),label:`${prev} at the same point`,col:'#94a3b8'});
  if(thenPrev>0){
    const d=Math.round((hereNow-thenPrev)/thenPrev*100);
    chips.push({n:(d>=0?'+':'')+d+'%',label:'on the year before',col:d>=0?'#22c55e':'#ef4444'});
  }
  if(isCurrent&&hereNow>0)chips.push({n:fmtD(hereNow/cutoff*365)+' '+distUnit(),label:'on pace for',col:'#8b5cf6'});

  chartSummary(t.chips,chips,(()=>{
    if(thenPrev==null||!thenPrev)return `No comparable year before ${focus} in this filter.`;
    const d=Math.round((hereNow-thenPrev)/thenPrev*100);
    const gap=fmtD(Math.abs(hereNow-thenPrev))+' '+distUnit();
    if(!isCurrent)return `${focus} finished ${d>=0?d+'% up on':Math.abs(d)+'% down on'} ${prev} — a difference of ${gap} over the year.`;
    if(Math.abs(d)<3)return `Within ${Math.abs(d)}% of where you were on this date in ${prev}. Effectively the same year so far.`;
    if(d>0)return `${d}% up on this date in ${prev} — ${gap} further. Held to December that is a personal best year, which is a reason to keep the easy weeks easy.`;
    return `${Math.abs(d)}% behind this date in ${prev}, a gap of ${gap}. There are ${366-cutoff} days left to close it.`;
  })());
}

// Which sport group to speak about when a chart can only honestly speak about one.
// A ride and a run have nothing comparable to say about metres per heartbeat, and
// averaging them produces a number that describes neither.
function dominantGroup(acts){
  const c={};acts.forEach(a=>{const g=typeGroup(a.type);c[g]=(c[g]||0)+1;});
  const e=Object.entries(c).sort((x,y)=>y[1]-x[1])[0];
  return e?e[0]:null;
}

// ── PACE AGAINST DISTANCE ──
// Replaces a monthly mean of every run in the month. That number moved with the
// *mix* of sessions — one long run among four parkruns dragged the month — so it
// reported your training schedule and was read as your fitness. A point per run
// separates the two: distance on one axis, pace on the other, year in the colour.
function renderPaceScatter(data){
  const runs=data.filter(a=>typeGroup(a.type)==='Run'&&a.pace_mi>0&&a.pace_mi<1800&&(a.dist_mi||0)>0);
  if(runs.length<5){
    setChartEmpty('chartPace',runs.length?'Too few runs in this filter to show a shape.':'No runs in this filter.');
    chartSummary('pace',[],'');
    return;
  }
  setChartEmpty('chartPace');
  const paceMin=a=>unit==='mi'?a.pace_mi/60:a.pace_mi/1.60934/60;
  // Colour splits the runs the same way the verdict below does — the last twelve
  // months against everything older. Colouring by year instead gave eight series
  // whose only difference was lightness, on a plot already dense enough to overlap;
  // two tones make the one comparison the chart is making legible at a glance.
  const cut=new Date(Date.now()-365*86400000).toISOString().slice(0,10);
  const pt=a=>({x:+distIn(a).toFixed(2),y:+paceMin(a).toFixed(3),_a:a});
  // Named apart from the band-restricted `recent`/`older` the verdict uses below:
  // these are every run, those are only the ones in the comparable distance band.
  const plotOlder=runs.filter(a=>a.date<cut),plotNewer=runs.filter(a=>a.date>=cut);

  destroyChart('pace');
  charts.pace=upsertChart('pace',document.getElementById('chartPace').getContext('2d'),{
    type:'scatter',
    data:{datasets:[
      // Older first so the recent runs draw on top of it rather than under.
      {label:'Earlier',data:plotOlder.map(pt),backgroundColor:'rgba(148,163,184,.45)',
       pointRadius:2.5,pointHoverRadius:5,borderWidth:0},
      {label:'Last 12 months',data:plotNewer.map(pt),backgroundColor:getAccentColor()+'cc',
       pointRadius:3,pointHoverRadius:5,borderWidth:0},
    ]},
    options:{
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{callbacks:{
          title:c=>c[0].raw._a?escapeHtml(c[0].raw._a.name||'Untitled'):'',
          label:c=>{const a=c.raw._a;return`${fmtDate(a.date)} · ${fmtDist(a.dist_mi)} ${distUnit()} · ${fmtPace(a.pace_mi)}`;}}}},
      responsive:true,maintainAspectRatio:false,
      scales:{
        x:{grid:{color:chartGrid()},title:{display:true,text:'Distance ('+distUnit()+')',font:{size:10},color:'#6b7280'},
          ticks:{font:{size:10}}},
        // Reversed: further down the chart is slower, which is the direction a
        // pace figure already reads in.
        y:{reverse:true,grid:{color:chartGrid()},
          ticks:{font:{size:10},callback:v=>{const m=Math.floor(v),s=Math.round((v-m)*60);return m+':'+String(s).padStart(2,'0');}}}}}
  });

  // A like-for-like comparison needs a like-for-like band, so the verdict only
  // looks at mid-distance runs — the ones you do enough of for the median to mean
  // something, and short enough that one marathon cannot move it.
  const lo=unit==='mi'?3:5,hi=unit==='mi'?8:13;
  const band=runs.filter(a=>{const d=distIn(a);return d>=lo&&d<=hi;});
  const median=xs=>{if(!xs.length)return null;const s=[...xs].sort((p,q)=>p-q);const m=s.length>>1;
    return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  const recentCut=new Date(Date.now()-365*86400000).toISOString().slice(0,10);
  const recent=band.filter(a=>a.date>=recentCut),older=band.filter(a=>a.date<recentCut);
  const mAll=median(band.map(a=>a.pace_mi));
  const best=runs.filter(a=>distIn(a)>=lo).reduce((b,a)=>(!b||a.pace_mi<b.pace_mi)?a:b,null);

  document.getElementById('paceSub').textContent=
    `${runs.length.toLocaleString('en-GB')} run${runs.length===1?'':'s'}, one point each. A month's average pace moved with the mix of sessions in it; this does not.`;

  const chips=[{n:runs.length.toLocaleString('en-GB'),label:'runs plotted',col:getAccentColor()}];
  if(mAll)chips.push({n:fmtPace(mAll),label:`median over ${lo}–${hi} ${distUnit()}`,col:'#0ea5e9'});
  if(best)chips.push({n:fmtPace(best.pace_mi),label:`quickest over ${lo} ${distUnit()}`,col:'#8b5cf6'});

  chartSummary('pace',chips,(()=>{
    if(recent.length<4||older.length<4)
      return `Each point is one run. The band from ${lo} to ${hi} ${distUnit()} is where you have enough runs for a median to be worth quoting — there is not yet enough either side of a year ago to say which way it is moving.`;
    const mr=median(recent.map(a=>a.pace_mi)),mo=median(older.map(a=>a.pace_mi));
    const sec=Math.round((mo-mr)*(unit==='mi'?1:1/1.60934));
    if(Math.abs(sec)<4)return `Over ${lo}–${hi} ${distUnit()}, your median pace is within four seconds of where it was more than a year ago. Flat, on this evidence.`;
    if(sec>0)return `Over ${lo}–${hi} ${distUnit()}, the last year's median is ${sec}s/${distUnit()} quicker than everything before it — the recent cloud sits above the older one, which is what getting fitter looks like here.`;
    return `Over ${lo}–${hi} ${distUnit()}, the last year's median is ${Math.abs(sec)}s/${distUnit()} slower than before — the recent cloud sits below the older one. Worth knowing whether that is fitness, terrain, or running more of these easy on purpose.`;
  })());
}

// ── SPEED PER HEARTBEAT ──
// Metres covered per beat: speed divided by heart rate. Pace alone cannot tell a
// fitness gain from simply trying harder on the day; this controls for effort, so
// a line that climbs is a genuine improvement rather than a harder session.
function renderEfficiency(data){
  const withHr=data.filter(a=>a.hr>0&&a.speed_mph>0);
  const grp=dominantGroup(withHr);
  const acts=withHr.filter(a=>typeGroup(a.type)===grp);
  if(acts.length<8){
    setChartEmpty('chartEff',withHr.length?'Too few activities with heart-rate data in one sport to plot.':'No activities with heart-rate data in this filter.');
    chartSummary('eff',[],'');
    return;
  }
  setChartEmpty('chartEff');
  // Metres per beat: (m/s ÷ beats per second) — speed_mph converts to m/s, hr is
  // per minute. Kept as one sport, because a ride and a run are not on one scale.
  const mpb=a=>(a.speed_mph/2.23694)/(a.hr/60);
  const byMonth={};
  acts.forEach(a=>{const m=a.date.slice(0,7);(byMonth[m]=byMonth[m]||[]).push(mpb(a));});
  const months=Object.keys(byMonth).sort().filter(m=>byMonth[m].length>=3);
  if(months.length<6){
    setChartEmpty('chartEff','Not enough months with heart-rate data to show a trend.');
    chartSummary('eff',[],'');
    return;
  }
  const mean=xs=>xs.reduce((s,v)=>s+v,0)/xs.length;
  const vals=months.map(m=>+mean(byMonth[m]).toFixed(2));
  // A twelve-month window, so the seasons cancel: metres per beat falls in summer
  // heat and rises in the cold, and a raw monthly line is mostly that cycle.
  const WIN=Math.min(12,Math.max(3,Math.round(months.length/4)));
  const roll=vals.map((_,i)=>{
    const from=Math.max(0,i-WIN+1);
    return i<WIN-1?null:+mean(vals.slice(from,i+1)).toFixed(2);
  });

  document.getElementById('effSub').textContent=
    `Metres per heartbeat for ${grp.toLowerCase()} activities — ${acts.length.toLocaleString('en-GB')} with heart-rate data, as a ${WIN}-month rolling average. Rising means more speed for the same effort.`;

  destroyChart('eff');
  charts.eff=upsertChart('eff',document.getElementById('chartEff').getContext('2d'),{
    type:'line',
    data:{labels:months.map(monthLabel),datasets:[
      {label:'Monthly',data:vals,borderColor:'rgba(148,163,184,.35)',backgroundColor:'transparent',
       fill:false,tension:.25,pointRadius:1.5,pointBackgroundColor:'rgba(148,163,184,.5)',borderWidth:1,order:1},
      {label:`${WIN}-month average`,data:roll,borderColor:groupColor(grp),backgroundColor:groupColor(grp)+'14',
       fill:true,tension:.3,pointRadius:0,borderWidth:2.5,spanGaps:false,order:0},
    ]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{mode:'index',intersect:false,callbacks:{
        label:c=>c.parsed.y==null?null:`${c.dataset.label}: ${c.parsed.y.toFixed(2)} m/beat`+
          (c.datasetIndex===0?` · ${byMonth[months[c.dataIndex]].length} activities`:'')}}},
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxTicksLimit:14,maxRotation:0}},
        y:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v.toFixed(1)}}}}
  });

  const half=Math.floor(months.length/2);
  const early=mean(vals.slice(0,half)),late=mean(vals.slice(half));
  const pct=early>0?Math.round((late-early)/early*100):0;
  chartSummary('eff',[
    {n:vals[vals.length-1].toFixed(2),label:'latest month, m/beat',col:groupColor(grp)},
    {n:Math.max(...vals).toFixed(2),label:'best month · '+monthLabel(months[vals.indexOf(Math.max(...vals))]),col:'#8b5cf6'},
    {n:(pct>=0?'+':'')+pct+'%',label:'second half vs first',col:pct>=0?'#22c55e':'#ef4444'},
  ],
  (()=>{
    if(Math.abs(pct)<3)return `Flat across the period: you are covering about the same ground per heartbeat now as at the start. Pace alone would not tell you that — this controls for how hard you were going.`;
    if(pct>0)return `Up ${pct}% over the period. More ground per beat is the one number here that separates getting fitter from simply working harder on the day.`;
    return `Down ${Math.abs(pct)}% over the period. That can be fatigue, heat, hillier routes, or a strap reading high — it is a prompt to look, not a diagnosis.`;
  })());
}


// ── HEATMAP ──
const MNAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function renderHeatmap(){
  // The year filter is deliberately not applied here. This tab lists every year at once,
  // and one colour scale shared across all of them is what lets them be read against each
  // other — a per-year scale would make a quiet year look as busy as a big one. The sport
  // filter still applies, and the year stepper still chooses which year sits at the top.
  const data=ALL_DATA.filter(a=>{
    const g=typeGroup(a.type);
    if(activeType==='All')return true;
    if(activeType==='Ride')return g==='Ride'||g==='Virtual';
    return g===activeType;
  });
  const byDay={};
  data.forEach(a=>{
    if(!byDay[a.date])byDay[a.date]={dist:0,types:{},time:{}};
    byDay[a.date].dist+=a.dist_mi||0;
    const g=typeGroup(a.type);
    byDay[a.date].types[g]=(byDay[a.date].types[g]||0)+1;
    // Moving time decides the cell's colour; the count stays because the day-detail
    // panel still reports how many activities there were.
    byDay[a.date].time[g]=(byDay[a.date].time[g]||0)+(a.mt||0);
  });
  const maxDist=Math.max(...Object.values(byDay).map(d=>d.dist),1);
  const accent=getAccentColor();

  // Which year to display (one at a time)
  const allDataYears=[...new Set(ALL_DATA.map(a=>a.date.slice(0,4)))].sort();
  const displayYear=isYearScope(activeYear)?activeYear:allDataYears[allDataYears.length-1];

  // Year nav arrows
  const navEl=document.getElementById('heatmapYearNav');
  if(navEl){
    const idx=allDataYears.indexOf(displayYear);
    const prev=idx>0?allDataYears[idx-1]:null;
    const next=idx<allDataYears.length-1?allDataYears[idx+1]:null;
    navEl.innerHTML=
      (prev?`<button class="hm-nav-btn" data-on-click="setYear" data-args-click='${escapeAttr(JSON.stringify([prev]))}'>← ${prev}</button>`:`<span style="width:64px"></span>`)+
      `<span class="hm-nav-year">${displayYear}</span>`+
      (next?`<button class="hm-nav-btn" data-on-click="setYear" data-args-click='${escapeAttr(JSON.stringify([next]))}'>${next} →</button>`:``);
  }

  // GitHub-style horizontal heatmap (vertical on mobile)
  function renderHeatYear(year){
    const sd=new Date(year,0,1),ed=new Date(year,11,31);
    const start=new Date(sd);
    const dow0=start.getDay();start.setDate(start.getDate()-(dow0===0?6:dow0-1));

    const G=2;

    // Build weeks array [[{ds,inY,dd,mo}×7]×N]
    const weeks=[];let cur=new Date(start);
    while(cur<=ed){
      const wk=[];
      for(let d=0;d<7;d++){
        const ds=cur.toISOString().slice(0,10);
        const inY=cur>=sd&&cur<=ed;
        wk.push({ds,inY,dd:inY?(byDay[ds]||null):null,mo:cur.getMonth()});
        cur.setDate(cur.getDate()+1);
      }
      weeks.push(wk);
    }

    // Cell size: fit the full year into available container width
    const _ctr=document.getElementById('heatmapContainer');
    const _avail=(_ctr?_ctr.offsetWidth:700)-24;
    const C=Math.min(16,Math.max(10,Math.floor((_avail-18-(weeks.length-1)*G)/weeks.length)));
    // The mobile strip lays days out seven across rather than fifty-odd weeks across,
    // so it can afford a tappable cell instead of reusing the desktop's 10px one.
    const CM=Math.min(44,Math.max(C,Math.floor((_avail-34-6*G)/7)));

    function cellBg(dd){return dayCellBg(dd,maxDist);}
    function cellDiv(day,sz){
      if(!day.inY)return`<div style="width:${sz}px;height:${sz}px;border-radius:0;"></div>`;
      const bg=cellBg(day.dd);
      const cls=day.dd?'hm-cell active':'hm-cell';
      const ev=day.dd?`data-day-tip="${day.ds}" role="gridcell" tabindex="-1" aria-label="${dayCellLabel(day.ds,day.dd)}" data-on-mouseenter="showDashTooltip" data-args-mouseenter='${escapeAttr(JSON.stringify(["$event", day.ds]))}' data-on-mouseleave="hideDashTooltip" data-on-click="showDayDetail" data-args-click='${escapeAttr(JSON.stringify([day.ds]))}'`:''
      return`<div class="${cls}" style="width:${sz}px;height:${sz}px;border-radius:0;background:${bg}" ${ev}></div>`;
    }

    // ── DESKTOP: horizontal GitHub strip ──
    let lastMoD=-1;const moLabels=[];
    weeks.forEach((wk,wi)=>{
      const f=wk.find(d=>d.inY);
      if(f&&f.mo!==lastMoD){moLabels.push({mo:f.mo,col:wi});lastMoD=f.mo;}
    });
    const DOW_W=14;
    let dHtml=`<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;">`;
    dHtml+=`<div style="display:inline-block;min-width:max-content;">`;
    // Month label row
    dHtml+=`<div style="display:flex;padding-left:${DOW_W+4}px;height:16px;position:relative;">`;
    moLabels.forEach(({mo,col})=>{
      dHtml+=`<span style="position:absolute;left:${DOW_W+4+col*(C+G)}px;font-size:10px;color:var(--color-text-secondary,#6b7280);white-space:nowrap;">${MNAMES[mo]}</span>`;
    });
    dHtml+=`</div>`;
    // DOW labels + grid row
    dHtml+=`<div style="display:flex;align-items:flex-start;gap:4px;">`;
    dHtml+=`<div style="display:flex;flex-direction:column;gap:${G}px;width:${DOW_W}px;flex-shrink:0;">`;
    ['M','','W','','F','','S'].forEach(d=>{
      dHtml+=`<div style="height:${C}px;font-size:9px;color:var(--color-text-secondary,#6b7280);line-height:${C}px;text-align:right;padding-right:2px;">${d}</div>`;
    });
    dHtml+=`</div>`;
    dHtml+=`<div style="display:grid;grid-template-rows:repeat(7,${C}px);grid-auto-flow:column;grid-auto-columns:${C}px;gap:${G}px;">`;
    weeks.forEach(wk=>wk.forEach(day=>{ dHtml+=cellDiv(day,C); }));
    dHtml+=`</div></div></div></div>`;

    // ── MOBILE: vertical strip (weeks as rows) ──
    let mHtml=`<div>`;
    mHtml+=`<div style="display:flex;gap:${G}px;margin-bottom:${G}px;padding-left:30px;">`;
    ['M','T','W','T','F','S','S'].forEach(d=>{
      mHtml+=`<div style="width:${CM}px;font-size:11px;color:var(--color-text-secondary,#6b7280);text-align:center;">${d}</div>`;
    });
    mHtml+=`</div>`;
    let lastMoM=-1;
    weeks.forEach(wk=>{
      const f=wk.find(d=>d.inY);
      let mo='';
      if(f&&f.mo!==lastMoM){mo=MNAMES[f.mo];lastMoM=f.mo;}
      mHtml+=`<div style="display:flex;align-items:center;gap:${G}px;margin-bottom:${G}px;">`;
      mHtml+=`<div style="width:30px;font-size:11px;color:var(--color-text-secondary,#6b7280);text-align:right;flex-shrink:0;">${mo}</div>`;
      wk.forEach(day=>{ mHtml+=cellDiv(day,CM); });
      mHtml+=`</div>`;
    });
    mHtml+=`</div>`;

    return`<div class="hm-layout-desktop">${dHtml}</div><div class="hm-layout-mobile">${mHtml}</div>`;
  }

  document.getElementById('heatmapContainer').innerHTML=renderHeatYear(displayYear);

  // Every earlier year, newest first, underneath the one in the stepper.
  const priorEl=document.getElementById('heatmapPriorYears');
  if(priorEl){
    const prior=allDataYears.filter(y=>y<displayYear).sort().reverse();
    // Every earlier year used to render its full grid unconditionally. With
    // eleven years of history that made this tab 22,150px tall on a phone —
    // twenty-four screens of scrolling, against 6,525px for the next worst tab.
    // They collapse now, with a summary that still says something: active days,
    // distance, and a twelve-segment bar of the year's shape. Open by default on
    // a wide screen, where reading the years against each other is the point and
    // the whole tab fits in 2,700px anyway.
    const openByDefault=!window.matchMedia('(max-width:640px)').matches;
    priorEl.innerHTML=prior.map(y=>{
      const days=Object.keys(byDay).filter(d=>d.slice(0,4)===y);
      const dist=days.reduce((s,d)=>s+byDay[d].dist,0);
      const months=Array.from({length:12},(_,m)=>{
        const mk=y+'-'+String(m+1).padStart(2,'0');
        return Object.keys(byDay).filter(d=>d.startsWith(mk)).reduce((t,d)=>t+byDay[d].dist,0);
      });
      const mMax=Math.max(...months,1);
      const spark=months.map((v,m)=>
        `<i style="height:${Math.max(8,Math.round(v/mMax*100))}%;background:${v?accent:'#e8e8e8'};opacity:${v?(0.35+0.65*v/mMax).toFixed(2):1}" title="${MNAMES[m]} ${y} · ${fmtDist(v)} ${distUnit()}"></i>`).join('');
      return`<details class="hm-prior"${openByDefault?' open':''}>
        <summary class="hm-prior-head">
          <span class="hm-prior-year">${y}</span>
          <span class="hm-prior-meta">${days.length.toLocaleString('en-GB')} active days · ${fmtDist(dist)} ${distUnit()}</span>
          <span class="hm-prior-spark">${spark}</span>
        </summary>
        ${renderHeatYear(y)}
      </details>`;
    }).join('');
  }

  // Legend
  const steps=[0,.2,.4,.6,.8,1];
  document.getElementById('heatmapLegend').innerHTML=steps.map(i=>{
    if(i===0)return`<div class="heatmap-legend-cell" style="background:#f0f0f0"></div>`;
    const r2l=parseInt(accent.slice(1,3),16),g2l=parseInt(accent.slice(3,5),16),b2l=parseInt(accent.slice(5,7),16);
    const bg=`rgb(${Math.round(240+(r2l-240)*i)},${Math.round(240+(g2l-240)*i)},${Math.round(240+(b2l-240)*i)})`;
    return`<div class="heatmap-legend-cell" style="background:${bg}"></div>`;
  }).join('');
  // Every calendar block on this tab gets its single tab stop back. The grids are
  // rebuilt from innerHTML on each render, so this has to run after, every time.
  armCalendarGrids(document.getElementById('tab-heatmap'));
}

function showDayDetail(date){
  const data=getFiltered().filter(a=>a.date===date);
  const detail=document.getElementById('heatmapDayDetail');
  if(!data.length){detail.style.display='none';return;}
  detail.style.display='block';detail.style.marginTop='20px';
  detail.innerHTML=`<div class="heatmap-wrap"><div class="heatmap-title">${fmtDate(date)}</div><div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">`+
    data.map(a=>recentItemHtml(a,false)).join('')+
  '</div></div>';
}

// The Charts tab's year calendar had a click handler naming this since it was
// written, and the function never existed — so every click on a day threw. The panel
// it fills has been sitting in the markup the whole time.
//
// It is showDayDetail's twin against a different container, with one addition: a
// second click on the day already open closes it, because this calendar sits above
// the rest of the tab and an open panel pushes everything down.
function showYearCalDay(date){
  const detail=document.getElementById('yearCalDayDetail');
  if(!detail)return;
  if(detail.dataset.day===date&&detail.style.display==='block'){
    detail.style.display='none';detail.dataset.day='';return;
  }
  const data=getFiltered().filter(a=>a.date===date);
  if(!data.length){detail.style.display='none';detail.dataset.day='';return;}
  detail.dataset.day=date;
  detail.style.display='block';detail.style.marginTop='20px';
  detail.innerHTML=`<div class="heatmap-wrap"><div class="heatmap-title">${fmtDate(date)}</div><div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">`+
    data.map(a=>recentItemHtml(a,false)).join('')+
  '</div></div>';
}

// ── RECORDS ──
// Rebuilt from 28 equal-weight cards into a hero row plus tables. Three things changed
// substantively, not just visually:
//   1. The year filter reaches this page. It used to read ALL_DATA and ignore both
//      header filters, so "my best of 2026" was not askable.
//   2. Every record carries how long it has stood. The date was always rendered and
//      never did anything with it.
//   3. Records that were only the maximum of a trivial set are gone — Most Calories on
//      a dog walk, 138ft of climbing, a swim pace quoted per mile.

// Records are per-sport by construction, so the sport filter has nothing to add here —
// only the year does. recYear tracks it separately so the header's type filter does not
// silently empty the page.
let recYear='All';

function setRecYear(y){recYear=y;renderRecords();}

// Which records each sport actually deserves. A record needs the sport to have real
// spread in the measure: "most calories on a walk" is arithmetic, not an achievement.
const REC_SPECS={
  Ride:[
    {k:'dist',label:'Longest ride'},
    {k:'elv',label:'Biggest climb'},
    {k:'high',label:'Highest point reached'},
    {k:'speed',label:'Highest avg speed',floor:10},
    {k:'pwr',label:'Highest avg power'},
    {k:'time',label:'Longest time riding'},
  ],
  Run:[
    {k:'dist',label:'Longest run'},
    {k:'pace',label:'Fastest avg pace',floor:3},
    {k:'elv',label:'Biggest climb'},
    {k:'high',label:'Highest point reached'},
    {k:'pr_1km',label:'1 km'},
    {k:'pr_1mi',label:'1 mile'},
    {k:'pr_5km',label:'5 km'},
    {k:'pr_10km',label:'10 km'},
    {k:'pr_hm',label:'Half marathon'},
    {k:'pr_mar',label:'Marathon'},
  ],
  Virtual:[
    {k:'dist',label:'Longest virtual ride'},
    {k:'elv',label:'Biggest climb'},
    {k:'pwr',label:'Highest avg power'},
  ],
  Walk:[
    {k:'dist',label:'Longest walk'},
    {k:'time',label:'Longest time on feet'},
    {k:'high',label:'Highest point reached'},
  ],
  Swim:[
    {k:'dist',label:'Longest swim'},
    {k:'time',label:'Longest time in water'},
  ],
};

const REC_SECTIONS=[
  {group:'Ride',   title:'Cycling',      icon:'directions_bike', noun:'rides'},
  {group:'Run',    title:'Running',      icon:'directions_run',  noun:'runs'},
  {group:'Virtual',title:'Virtual rides',icon:'computer',        noun:'virtual rides'},
  {group:'Walk',   title:'Walking',      icon:'directions_walk', noun:'walks'},
  {group:'Swim',   title:'Swimming',     icon:'pool',            noun:'swims'},
];

// One place that knows how to read, compare and print each measure, so the table, the
// hero row and the margin ranking all agree.
function recMeasure(k){
  if(k.startsWith('pr_'))return{
    get:a=>(a[k]>0&&a[k]<86400)?a[k]:0, lower:true,
    fmt:v=>fmtPRTime(v)};
  return{
    dist :{get:a=>a.dist_mi||0,   fmt:v=>fmtDist(v)+' '+distUnit()},
    elv  :{get:a=>a.elv||0,       fmt:v=>fmtElv(v)},
    speed:{get:a=>a.speed_mph||0, fmt:v=>fmtSpeed(v)},
    pwr  :{get:a=>a.pwr||0,       fmt:v=>fmtNum(v)+'W'},
    time :{get:a=>a.mt||0,        fmt:v=>fmtTime(v)},
    // The highest point the activity reached, not the height climbed on it —
    // elev_hi is an altitude, elv is a sum of ascents.
    high :{get:a=>a.elev_hi||0,   fmt:v=>fmtElv(v)},
    // Lower is better, and fmtPace refuses anything over an hour per mile — a swim
    // pace per mile is technically a number and tells you nothing.
    pace :{get:a=>a.pace_mi||0,   lower:true, fmt:v=>fmtPace(v)},
  }[k];
}

// How long ago, in words, and whether it counts as recent.
function recStanding(dateStr){
  const days=Math.floor((new Date()-new Date(dateStr+'T12:00:00'))/86400000);
  if(days<=90)return{fresh:true,text:days<=1?'today':days<=7?'this week':days<=31?'this month':Math.round(days/7)+' weeks ago'};
  const yrs=days/365.25;
  if(yrs<1)return{fresh:false,text:Math.max(1,Math.round(days/30.4))+' months'};
  return{fresh:false,text:Math.round(yrs)+(Math.round(yrs)===1?' year':' years')};
}

function recFind(acts,spec){
  const m=recMeasure(spec.k);
  if(!m)return null;
  let best=null,bestV=0,runnerV=0;
  acts.forEach(a=>{
    if(spec.floor&&(a.dist_mi||0)<spec.floor)return;
    const v=m.get(a);
    if(!(v>0))return;
    const better=best===null||(m.lower?v<bestV:v>bestV);
    if(better){runnerV=bestV;bestV=v;best=a;}
    else if(m.lower?(runnerV===0||v<runnerV):v>runnerV)runnerV=v;
  });
  if(!best)return null;
  // Margin over the runner-up, used to pick the hero row. Zero when there is nothing
  // to compare against — a single marathon is not "standing out", it is unrepeated.
  const margin=runnerV>0?(m.lower?(runnerV-bestV)/runnerV:(bestV-runnerV)/runnerV):0;
  return{spec,act:best,value:bestV,display:m.fmt(bestV),margin,lone:runnerV===0};
}

function renderRecords(){
  const yearOf=a=>a.date.slice(0,4);
  const years=[...new Set(ALL_DATA.map(yearOf))].sort().reverse();
  if(recYear!=='All'&&!years.includes(recYear))recYear='All';
  const scoped=recYear==='All'?ALL_DATA:ALL_DATA.filter(a=>yearOf(a)===recYear);

  // Year bar. Records are per-sport, so only the year is offered — the header's sport
  // filter is deliberately not applied and the note under the tables says so.
  const bar=document.getElementById('recYearBar');
  if(bar)bar.innerHTML='<span class="lbl">Best of</span>'+
    [['All','All time'],...years.slice(0,6).map(y=>[y,y])].map(([v,l])=>
      `<button class="rec-yr${recYear===v?' on':''}" data-on-click="setRecYear" data-args-click='${escapeAttr(JSON.stringify([v]))}'>${escapeHtml(l)}</button>`).join('');

  // Every record, per section.
  const found={};
  REC_SECTIONS.forEach(sec=>{
    const acts=scoped.filter(a=>typeGroup(a.type)===sec.group);
    found[sec.group]={acts,recs:(REC_SPECS[sec.group]||[]).map(sp=>recFind(acts,sp)).filter(Boolean)};
  });

  // ── Hero row: the four with the biggest margin over their runner-up ──
  const streak=recLongestStreak(scoped);
  const all=[];
  REC_SECTIONS.forEach(sec=>found[sec.group].recs.forEach(r=>all.push({...r,group:sec.group})));
  // A record only belongs in this row if it genuinely stands clear. Ranking by margin
  // alone put a climb 1% above its runner-up, and a virtual ride 0% above, under a
  // heading claiming they stood out — so there is a floor, and the row simply carries
  // fewer cards when fewer qualify.
  const HERO_MARGIN=0.08;
  const hero=all.filter(r=>!r.lone&&r.margin>=HERO_MARGIN)
    .sort((a,b)=>b.margin-a.margin).slice(0,3);
  const heroEl=document.getElementById('recHero');
  const badge=document.getElementById('recHeroBadge');
  const title=document.getElementById('recHeroTitle');
  if(title)title.textContent=hero.length?'The ones that stand out':'Your headline numbers';
  if(badge)badge.textContent=(recYear==='All'?'All time':recYear)+' · '+all.length+' record'+(all.length===1?'':'s');
  if(heroEl){
    if(!all.length){
      heroEl.innerHTML='<div class="chart-empty" style="height:90px;border:1px solid var(--border);background:var(--surface)">Nothing with a distance or a duration in '+escapeHtml(recYear)+'.</div>';
    }else{
      const fallback=hero.length?[]:['Longest ride','Longest run','Longest virtual ride']
        .map(l=>all.find(r=>r.spec.label===l)).filter(Boolean).slice(0,3);
      heroEl.innerHTML=(hero.length?hero:fallback).map(r=>{
        const st=recStanding(r.act.date);
        return `<div class="rec-hero" style="--hc:${groupColor(r.group)}" ${r.act.id?`data-act="${escapeAttr(r.act.id)}"`:''}>
          <div class="rec-hero-lbl">${escapeHtml(r.spec.label)}</div>
          <div class="rec-hero-val">${r.display.replace(/^([\d,.:]+)\s*(.*)$/,(m,n,u)=>n+(u?`<span class="u">${escapeHtml(u)}</span>`:''))}</div>
          <div class="rec-hero-nm">${escapeHtml(r.act.name||r.act.type)}</div>
          <div class="rec-hero-sub">${fmtDate(r.act.date)} · ${st.fresh?'set '+st.text:'has stood '+st.text}${r.margin>=HERO_MARGIN?` · ${Math.round(r.margin*100)}% clear of your next best`:''}</div>
        </div>`;
      }).join('')+(streak?`
        <div class="rec-hero" style="--hc:#22c55e">
          <div class="rec-hero-lbl">Longest streak</div>
          <div class="rec-hero-val">${streak.len}<span class="u">days</span></div>
          <div class="rec-hero-nm">Consecutive active days</div>
          <div class="rec-hero-sub">${fmtDate(streak.from)} → ${fmtDate(streak.to)}${streak.current?' · running now':''}</div>
        </div>`:'');
    }
  }

  // ── Per-sport tables ──
  const tablesEl=document.getElementById('recTables');
  if(tablesEl){
    tablesEl.innerHTML=REC_SECTIONS.map(sec=>{
      const {acts,recs}=found[sec.group];
      if(!recs.length)return '';
      const col=groupColor(sec.group);
      const rows=recs.map(r=>{
        const st=recStanding(r.act.date);
        return `<div class="rec-row"${r.act.id?` data-act="${escapeAttr(r.act.id)}"`:''}>
          <div class="rec-name"><i style="background:${col}"></i>${escapeHtml(r.spec.label)}</div>
          <div class="rec-best">${escapeHtml(r.display)}</div>
          <div class="rec-act" title="${escapeAttr(r.act.name||'')}">${escapeHtml(r.act.name||r.act.type)}</div>
          <div class="rec-set">${fmtDate(r.act.date)}</div>
          <div class="rec-std">${st.fresh?`<span class="rec-fresh">${st.text}</span>`:st.text}</div>
        </div>`;
      }).join('');
      // When one activity holds several of a section's records, say so — the old page
      // rendered the dates and could not notice they were the same day.
      const byId={};
      recs.forEach(r=>{if(r.act.id)byId[r.act.id]=(byId[r.act.id]||[]).concat(r.spec.label);});
      const multi=Object.entries(byId).filter(([,ls])=>ls.length>1)
        .sort((x,y)=>y[1].length-x[1].length)[0];
      const shared=multi?(()=>{
        const a=acts.find(x=>String(x.id)===String(multi[0]));
        return `<div class="rec-shared"><span class="ms">info</span><div>${multi[1].length} of these came from one ${sec.group==='Run'?'run':'outing'} — <strong style="font-weight:600">${escapeHtml(a.name||a.type)}, ${fmtDate(a.date)}</strong>.</div></div>`;
      })():'<div style="height:26px"></div>';
      return `<div class="rec-sect"><h3><span class="ms" style="font-size:15px;color:${col};vertical-align:-2px">${sec.icon}</span> ${sec.title}</h3><span>${acts.length.toLocaleString('en-GB')} ${sec.noun}</span></div>
        <div class="rec-tbl">
          <div class="rec-head"><div>Record</div><div>Best</div><div>Activity</div><div>Set</div><div>Standing</div></div>
          ${rows}
        </div>${shared}`;
    }).join('');
  }

  // ── Totals, in their own vocabulary ──
  const tot=document.getElementById('recTotals');
  const tBadge=document.getElementById('recTotalsBadge');
  if(tot){
    const d=scoped.reduce((s,a)=>s+(a.dist_mi||0),0);
    const e=scoped.reduce((s,a)=>s+(a.elv||0),0);
    const t=scoped.reduce((s,a)=>s+(a.mt||0),0);
    const c=scoped.reduce((s,a)=>s+(a.cal||0),0);
    const days=new Set(scoped.map(a=>a.date)).size;
    const ys=[...new Set(scoped.map(yearOf))].sort();
    const span=ys.length?(ys.length===1?ys[0]:ys[0]+'–'+ys[ys.length-1]):'—';
    if(tBadge)tBadge.textContent=recYear==='All'?span:recYear;
    const cell=(l,v,sub)=>`<div><div class="rec-tot-l">${l}</div><div class="rec-tot-v">${v}</div><div class="rec-tot-s">${sub}</div></div>`;
    tot.innerHTML=
      cell('Distance',fmtDist(d),distUnit()+' · '+span)+
      cell('Moving time',fmtNum(t/3600)+'h',fmtNum(t/86400)+' days')+
      cell('Climbed',fmtElv(e),(e/29029).toFixed(1)+'× Everest')+
      cell('Activities',scoped.length.toLocaleString('en-GB'),days.toLocaleString('en-GB')+' active days')+
      cell('Calories',fmtCal(c),'kcal')+
      cell('Active days',days.toLocaleString('en-GB'),days?(scoped.length/days).toFixed(1)+' activities per active day':'—');
  }

  // ── The note: says what the page is and is not doing ──
  const note=document.getElementById('runPRNote');
  if(note){
    const runs=found.Run?found.Run.acts:[];
    const withPr=runs.filter(a=>['pr_1km','pr_1mi','pr_5km','pr_10km','pr_hm','pr_mar'].some(f=>a[f]>0)).length;
    const bits=[];
    bits.push(activeType==='All'
      ? 'Records are grouped by sport, so the header’s sport filter is not applied here — only the year.'
      : `The header is filtered to ${activeType.toLowerCase()}, which Records deliberately ignores: the sections are already per-sport. The year filter above does apply.`);
    bits.push(withPr
      ? `Segment bests come from Strava’s best-efforts, one request per activity, so they arrive gradually on the daily refresh — ${withPr.toLocaleString('en-GB')} of ${runs.length.toLocaleString('en-GB')} runs checked so far.`
      : 'Segment bests (1 km, 1 mile, 5 km, 10 km, half, marathon) come from Strava’s best-efforts, which the bulk endpoint doesn’t return. They are collected a slice at a time on the daily refresh and will start appearing above.');
    bits.push('Calories and elevation are no longer shown as records for walks and swims: the maximum of a set with no spread in it is arithmetic, not an achievement.');
    note.textContent=bits.join(' ');
  }

  renderPrProgression();
}

// ── PERSONAL BEST PROGRESSION ──
// The pr_* fields are backfilled at forty Strava requests per cron run and then
// shown only as a single best-ever number. This is the same data asked the more
// interesting question: not what your best is, but when it moved.
const PR_PROG=[
  {k:'pr_1km', label:'1 km',          col:'#0ea5e9'},
  {k:'pr_1mi', label:'1 mile',        col:'#22c55e'},
  {k:'pr_5km', label:'5 km',          col:'#1d4ed8'},
  {k:'pr_10km',label:'10 km',         col:'#6d28d9'},
  {k:'pr_hm',  label:'Half marathon', col:'#f59e0b'},
  {k:'pr_mar', label:'Marathon',      col:'#ff385c'},
];
function renderPrProgression(){
  const badge=document.getElementById('prProgBadge');
  const sub=document.getElementById('prProgSub');
  // Deliberately all-time and unscoped by the year stepper: a progression that
  // starts again each January is not a progression.
  const runs=ALL_DATA.filter(a=>typeGroup(a.type)==='Run').sort((x,y)=>x.date.localeCompare(y.date));
  const series=PR_PROG.map(d=>{
    const efforts=runs.filter(a=>a[d.k]>0&&a[d.k]<86400).map(a=>({date:a.date,t:a[d.k]}));
    if(efforts.length<2)return null;
    // The record as it stood on each date: it only ever steps down, and a point
    // is only added where it actually moved.
    // x is epoch milliseconds, not a date string: Chart.js only parses dates with
    // a date adapter, and this page loads chart.umd on its own. A linear axis with
    // a formatting callback needs no extra library.
    const steps=[];let best=Infinity;
    efforts.forEach(e=>{if(e.t<best){best=e.t;steps.push({x:Date.parse(e.date+'T12:00:00'),y:e.t,d:e.date});}});
    if(steps.length<2)return null;
    // Carry the final value to today so the flat run since your last PB is visible
    // rather than the line stopping the day you set it.
    const today=new Date(),todayMs=today.getTime(),todayStr=today.toISOString().slice(0,10);
    if(steps[steps.length-1].d!==todayStr)steps.push({x:todayMs,y:best,d:todayStr});
    return{...d,steps,best,n:efforts.length,first:efforts[0]};
  }).filter(Boolean);

  if(!series.length){
    setChartEmpty('chartPrProg','No distance has two or more recorded best efforts yet. Strava\u2019s best-efforts arrive a slice at a time on the daily refresh, so this fills in as they do.');
    if(badge)badge.textContent='waiting on best efforts';
    chartSummary('prprog',[],'');
    return;
  }
  setChartEmpty('chartPrProg');
  if(badge)badge.textContent=series.length+' distance'+(series.length===1?'':'s')+' · all time';
  if(sub)sub.textContent='Your best time at each distance as it stood on each date. Steps down only, because a personal best cannot get worse — a flat line is a record still standing.';
  destroyChart('prProg');
  charts.prProg=upsertChart('prProg',document.getElementById('chartPrProg').getContext('2d'),{
    type:'line',
    data:{datasets:series.map(d=>({
      label:d.label,data:d.steps.map(p=>({x:p.x,y:p.y})),
      borderColor:d.col,backgroundColor:d.col,stepped:'after',
      fill:false,pointRadius:2.5,pointHoverRadius:4,borderWidth:2,tension:0}))},
    options:{parsing:false,
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{callbacks:{
          title:c=>fmtDate(new Date(c[0].parsed.x).toISOString().slice(0,10)),
          label:c=>c.dataset.label+': '+fmtPRTime(c.parsed.y)}}},
      responsive:true,maintainAspectRatio:false,
      scales:{
        x:{type:'linear',grid:{display:false},
          ticks:{font:{size:10},maxTicksLimit:8,callback:v=>new Date(v).getFullYear()}},
        y:{reverse:true,grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>fmtPRTime(Math.round(v))}}}}
  });
  // The headline distance is the one you have the most efforts at.
  const head=series.reduce((b,d)=>d.n>b.n?d:b,series[0]);
  const cut=head.first.t-head.best;
  chartSummary('prprog',[
    {n:fmtPRTime(head.best),label:head.label+' best',col:head.col},
    {n:(cut>0?'−':'')+fmtPRTime(Math.abs(cut)),label:'off your first '+head.label,col:cut>0?'#16a34a':'#9ca3af'},
    {n:String(series.reduce((s,d)=>s+d.steps.length-1,0)),label:'times a record moved',col:'#1d4ed8'},
  ],(()=>{
    // The last real record, not the carried-to-today point that every series ends on.
    let last=null,which=null;
    series.forEach(d=>{const p=d.steps[d.steps.length-2];if(p&&(!last||p.d>last.d)){last=p;which=d;}});
    if(!last)return'';
    const days=Math.floor((Date.now()-last.x)/86400000);
    if(days<120)return `Your most recent best was the ${which.label} on ${fmtDate(last.d)}. Everything here is still moving.`;
    return `Nothing has moved since the ${which.label} on ${fmtDate(last.d)}, ${Math.round(days/30.4)} months ago. A flat line here is a record standing, not a chart with no data.`;
  })());
}


// ── SOCIAL ──
function logSearchAttr(name){return `data-on-click="goToLogSearch" data-args-click='${escapeAttr(JSON.stringify([String(name)]))}'`;}
// Every clickable row in the app is a div or a tr with a delegated click handler,
// which means a pointer can open it and a keyboard cannot. Making them focusable is
// half the job; this is the other half.
//
// It dispatches a real click rather than calling the opener directly, so one rule
// covers all four kinds — the two that go through document-level delegation and the
// location pills, which carry an inline onclick.
const KEY_ACTIVATABLE='.act-row-click,.soc-row,.gear-card,.loc-pill';
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  if(!e.target.closest)return;
  // Anything natively activatable already does this for itself, and intercepting
  // would double-fire it.
  if(e.target.closest('a,button,input,select,textarea'))return;
  const el=e.target.closest(KEY_ACTIVATABLE);
  if(!el)return;
  e.preventDefault();
  el.click();
});

function goToLogSearch(name){logSearch=name;const el=document.getElementById('logSearch');if(el)el.value=name;logPage=1;setTab('log');}
// ── MEX ──────────────────────────────────────────────────────────────────────
// One activity at every whole unit in ascending order; your Mex is the highest unbroken
// rung before the first gap. It is governed by the LOW end by design — one missing bucket
// caps you however far you have ridden — so the gap list, not the number, is the part you
// can act on. Follows the mi/km switch, which means it is a different number in each.
const MEX_ROW=20;
const MEX_MAX=400;

// Stagger the first grid of cards on a tab you have just switched to. Only the
// first one: staggering every grid down a long tab means the bottom of the page
// is still animating in when you have scrolled past it. The class comes off after
// the run so a later re-render is instant.
function staggerCards(tabEl){
  if(!tabEl)return;
  if(matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  // The first grid that actually has cards in it, not simply the first one: on
  // Records the Running PBs grid comes first and is empty for a ride-only history,
  // and taking it would mean nothing ever staggered.
  const grid=[...tabEl.querySelectorAll('.stats-grid,.records-grid,.gear-grid,.partner-grid,.charts-grid')]
    .find(g=>g.children.length);
  if(!grid)return;
  grid.classList.remove('stagger');
  void grid.offsetWidth;            // force a reflow so re-adding the class restarts it
  grid.classList.add('stagger');
  setTimeout(()=>grid.classList.remove('stagger'),700);
}

// Reveal .reveal children as they scroll into view. Each element is unobserved the
// moment it fires, so nothing re-animates on the way back up. Without IntersectionObserver
// (or with reduced motion on) everything is simply shown.
function revealOnScroll(root){
  const els=[...root.querySelectorAll('.reveal')];
  if(!els.length)return;
  if(!('IntersectionObserver'in window)||matchMedia('(prefers-reduced-motion:reduce)').matches){
    els.forEach(e=>{e.classList.remove('reveal');});return;
  }
  const io=new IntersectionObserver((entries,obs)=>{
    entries.forEach(en=>{
      if(!en.isIntersecting)return;
      en.target.classList.add('shown');
      obs.unobserve(en.target);
    });
  },{rootMargin:'0px 0px -40px 0px',threshold:.06});
  els.forEach(e=>io.observe(e));
}

// The ladder draws itself in only when you arrive at the tab. Re-rendering because
// a filter changed reuses the same DOM shape, and replaying the build there reads
// as a flicker rather than as motion.
let mexAnimate=false;

function renderMex(){
  const u=unit,el=document.getElementById('tab-mex');
  const animate=mexAnimate;mexAnimate=false;
  const buckets=mexBuckets(getFiltered());
  if(!buckets.size){
    el.innerHTML='<div class="mex-empty"><span class="ms" style="font-size:36px;display:block;margin-bottom:8px">stairs</span>No activities match this filter.</div>';
    return;
  }
  const mex=mexOf(buckets),firstGap=mex+1;
  const longest=Math.max(...buckets.keys());
  const ceiling=Math.min(MEX_MAX,Math.max(MEX_ROW,Math.ceil(Math.max(longest,firstGap+9)/MEX_ROW)*MEX_ROW));
  const filled=[...buckets.keys()].filter(n=>n<=ceiling).length;

  // The stagger caps at ~600ms however long the ladder is: a 400-cell ladder
  // stepping 8ms each would take three seconds to finish drawing itself.
  const totalCells=ceiling,step=Math.min(8,600/Math.max(1,totalCells));
  let ladder='';
  for(let start=1;start<=ceiling;start+=MEX_ROW){
    let cells='';
    for(let n=start;n<start+MEX_ROW;n++){
      const b=buckets.get(n),d=`--d:${Math.round((n-1)*step)}ms`;
      if(b){
        const g=dominantType(b.counts);
        cells+=`<div class="mex-cell" style="background:${groupColor(g)};${d}" title="${n} ${u} · mostly ${g}">${n}</div>`;
      }else{
        cells+=`<div class="mex-cell ${n===firstGap?'gap':'empty'}" style="${d}" title="Nothing between ${n}.0 and ${n}.9 ${u}">${n}</div>`;
      }
    }
    ladder+=`<div class="mex-row"><div class="mex-row-label">${start}–${start+MEX_ROW-1}</div><div class="mex-cells">${cells}</div></div>`;
  }

  // Each row assumes every gap above it has already been filled.
  const plan=[];let running=mex;
  for(let g=firstGap;g<=ceiling&&plan.length<5;g++){
    if(buckets.has(g))continue;
    let next=g+1;while(buckets.has(next))next++;
    plan.push({gap:g,from:running,to:next-1});
    running=next-1;
  }

  // Strict sport groups here — Virtual stays out of Ride, unlike the header filter.
  const _t=_today();
  const yearData=ALL_DATA.filter(a=>scopeIncludes(a.date,activeYear,_t));
  const chips=[{g:'All',m:mexOf(mexBuckets(yearData)),col:'#ff385c',soft:'#ffeef1'}];
  ['Ride','Virtual','Run','Walk','Swim','Other'].forEach(g=>{
    const acts=yearData.filter(a=>typeGroup(a.type)===g);
    if(acts.length)chips.push({g,m:mexOf(mexBuckets(acts)),col:groupColor(g),soft:groupSoft(g)});
  });

  const scope=periodLabel(activeYear)+' · '+(activeType==='All'?'all sports':activeType.toLowerCase())+' · '+u;

  el.innerHTML=`
  <div class="section-header"><h2>Mex Score</h2><span class="badge">${scope}</span></div>

  <div data-zone="mex">
  <div class="span-full" data-panel="mex-stats" data-panel-label="Mex, first gap and buckets filled">
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Your Mex</div>
      <div class="stat-value">${mex}<span class="stat-unit">${u}</span></div>
      <div class="stat-sub">${mex?`One activity at every ${u} from 1 to ${mex}`:`Nothing logged between 1.0 and 1.9 ${u} yet`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">First gap</div>
      <div class="stat-value">${firstGap}<span class="stat-unit">${u}</span></div>
      <div class="stat-sub">Nothing between ${firstGap}.0 and ${firstGap}.9</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Buckets filled</div>
      <div class="stat-value">${filled}<span class="stat-unit">of ${ceiling}</span></div>
      <div class="stat-sub">Longest single activity: ${longest} ${u}</div>
    </div>
  </div>
  </div>

  <div class="span-full" data-panel="mex-ladder" data-panel-label="The ladder">
  <div class="chart-card" style="margin-bottom:18px">
    <div class="chart-title">The ladder</div>
    <div class="chart-sub">Each cell is one whole-${u} bucket. An activity counts for the ${u} it lands in, rounded down. Where several sports fill the same bucket, the cell takes the colour of whichever has the most activities in it.</div>
    <div class="mex-ladder${animate?' mex-anim':''}">${ladder}</div>
    <div class="mex-legend">
      ${['Ride','Virtual','Run','Walk','Swim'].map(g=>`<div class="mex-legend-item"><div class="mex-swatch" style="background:${groupColor(g)}"></div><span>${g}</span></div>`).join('')}
      <div class="mex-legend-item"><div class="mex-swatch" style="background:var(--accent-soft);border:2px solid var(--accent)"></div><span>First gap — your ceiling</span></div>
      <div class="mex-legend-item"><div class="mex-swatch" style="background:var(--surface);border:1px dashed var(--border-strong)"></div><span>Empty bucket</span></div>
    </div>
  </div>
  </div>

  <div class="span-full" data-panel="mex-hist" data-panel-label="How far you actually go">
  <div class="chart-card" style="margin-bottom:18px">
    <div class="chart-title">How far you actually go</div>
    <div class="chart-sub" id="distHistSub">The same buckets, counted rather than ticked</div>
    <div class="chart-wrap tall"><canvas id="chartDistHist"></canvas></div>
    <div id="histChips" class="chart-chips"></div>
    <div id="histVerdict" class="chart-verdict"></div>
  </div>
  </div>

  <div class="span-full" data-panel="mex-plan" data-panel-label="Fill these in order">
  <div class="two-col">
    <div class="log-table-wrap">
      <div style="padding:18px 20px 12px">
        <div class="chart-title">Fill these in order</div>
        <div class="chart-sub" style="margin-bottom:0">Each row assumes every gap above it is already filled. One awkward distance can be worth several ${u} of Mex.</div>
      </div>
      ${plan.length?`<div style="border-top:1px solid var(--border)">${plan.map((p,i)=>`
        <div class="mex-plan-row">
          <div class="mex-plan-n">${i+1}</div>
          <div class="mex-plan-main">
            <div class="mex-plan-title">Anything ${p.gap}.0–${p.gap}.9 ${u}</div>
            <div class="mex-plan-sub">Currently the ${i?'next':'first'} empty bucket${i?' after that':''}</div>
          </div>
          <div class="mex-plan-delta">
            <span style="font-size:12px;color:var(--text-muted)">${p.from}</span>
            <span class="ms" style="font-size:14px;color:var(--text-light)">arrow_forward</span>
            <span class="mex-plan-to">${p.to}</span>
            <span class="mex-gain">+${p.to-p.from}</span>
          </div>
        </div>`).join('')}</div>`:`<div style="padding:0 20px 20px;font-size:12px;color:var(--text-muted)">No gaps below ${ceiling} ${u} — the ladder is unbroken to the top of this view.</div>`}
    </div>

    <div style="display:flex;flex-direction:column;gap:18px">
      <div class="chart-card">
        <div class="chart-title">Mex by sport</div>
        <div class="chart-sub">Counted within each sport alone, so every one sits at or below the overall figure.</div>
        <div class="mex-sports">${chips.map(c=>`<div class="mex-sport-chip" style="background:${c.soft};color:${c.col}">${c.g} <strong>${c.m}</strong></div>`).join('')}</div>
        <div class="mex-note" style="margin-top:10px">A sport reads 0 until it has an activity in every bucket from 1 upwards. Hardly anyone rides 1 ${u}, so low figures here are normal — it is the combined ladder that moves.</div>
      </div>
      <div class="chart-card">
        <div class="chart-title">How it's counted</div>
        <div style="display:flex;flex-direction:column;gap:9px;margin-top:10px">
          <div class="mex-note">Distance is rounded <strong>down</strong> to the whole ${u}. One activity fills one bucket — a second ${mex>0?mex:longest} ${u} ride adds nothing.</div>
          <div class="mex-note">Mex follows the <strong>mi / km</strong> switch, so it is a different number in each. Only the km figure is comparable with other riders.</div>
          <div class="mex-note">The year and sport filters narrow it. All time, all sports is the headline figure.</div>
        </div>
      </div>
    </div>
  </div>
  </div>
  </div>`;

  renderDistHistogram(getFiltered(),ceiling);
}

// ── DISTANCE DISTRIBUTION ──
// Everything else in the app is a sum or a maximum, and neither has anything to
// say about shape. Two athletes with the same annual distance and the same longest
// ride can have completely different years: one rides the same loop ninety times,
// the other rides everything from a commute to a double century.
//
// It belongs on this tab rather than with the charts, because Mex is already a
// statement about exactly this distribution — the ladder just reduces it to a
// yes/no per bucket. This is the count the ladder throws away.
function renderDistHistogram(data,ceiling){
  const cv=document.getElementById('chartDistHist');
  if(!cv)return;
  const acts=data.filter(a=>(a.dist_mi||0)>0);
  if(acts.length<10){
    setChartEmpty('chartDistHist','Not enough activities with a distance in this filter to show a distribution.');
    chartSummary('hist',[],'');
    return;
  }
  setChartEmpty('chartDistHist');

  // Bucket 0 is everything under one whole unit. Mex ignores it by construction,
  // but it is real training and often a big share of the count, so leaving it off
  // would misdescribe the distribution this chart exists to show.
  const top=Math.max(1,ceiling);
  const bucketOf=a=>Math.min(top,Math.floor(distIn(a)));
  const groups=[...new Set(acts.map(a=>typeGroup(a.type)))]
    .sort((x,y)=>acts.filter(a=>typeGroup(a.type)===y).length-acts.filter(a=>typeGroup(a.type)===x).length);
  const counts={};
  groups.forEach(g=>{counts[g]=new Array(top+1).fill(0);});
  acts.forEach(a=>{counts[typeGroup(a.type)][bucketOf(a)]++;});

  const labels=Array.from({length:top+1},(_,i)=>i===0?'<1':(i===top?top+'+':String(i)));
  destroyChart('disthist');
  charts.disthist=upsertChart('disthist',cv.getContext('2d'),{
    type:'bar',
    data:{labels,datasets:groups.map(g=>({
      label:g,data:counts[g],backgroundColor:groupColor(g),borderRadius:0,borderSkipped:false}))},
    options:{
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:c=>{const l=c[0].label;
            return l==='<1'?`Under 1 ${unit}`:l.endsWith('+')?`${top} ${unit} and over`:`${l}.0–${l}.9 ${unit}`;},
          label:c=>c.parsed.y?`${c.dataset.label}: ${c.parsed.y}`:null}}},
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{stacked:true,grid:{display:false},
          ticks:{font:{size:9},autoSkip:true,maxTicksLimit:26,maxRotation:0}},
        y:{stacked:true,grid:{color:chartGrid()},beginAtZero:true,
          ticks:{font:{size:11},precision:0}}}}
  });

  // The mode, the median, and how much of the history sits in the busiest handful
  // of buckets — three numbers that between them say whether this is one habit or
  // a range.
  const total=new Array(top+1).fill(0);
  groups.forEach(g=>counts[g].forEach((n,i)=>{total[i]+=n;}));
  const modeI=total.indexOf(Math.max(...total));
  const sorted=acts.map(distIn).sort((a,b)=>a-b);
  const median=sorted[sorted.length>>1];
  const ranked=[...total].sort((a,b)=>b-a);
  const topFive=ranked.slice(0,5).reduce((s,v)=>s+v,0);
  const concentration=Math.round(topFive/acts.length*100);
  const nonEmpty=total.filter(v=>v>0).length;

  document.getElementById('distHistSub').textContent=
    `${acts.length.toLocaleString('en-GB')} activities dropped into the same whole-${unit} buckets as the ladder, stacked by sport. The ladder asks whether a bucket has anything in it; this asks how much.`;

  chartSummary('hist',[
    {n:modeI===0?'under 1':(modeI===top?top+'+':String(modeI)),label:`busiest bucket (${total[modeI]} activities)`,col:getAccentColor()},
    {n:fmtDist(unit==='mi'?median:median/1.60934)+' '+unit,label:'median activity',col:'#0ea5e9'},
    {n:concentration+'%',label:'in the five busiest buckets',col:'#8b5cf6'},
    {n:String(nonEmpty),label:'buckets with anything in them',col:'#94a3b8'},
  ],
  (()=>{
    if(concentration>=60)
      return `${concentration}% of everything you do lands in five distances. That is one strong habit rather than a range — and it is exactly why the Mex ladder above has the gaps it has: the empty buckets are the distances that do not fit your usual outing.`;
    if(concentration>=35)
      return `${concentration}% sits in the five busiest buckets, with a tail either side. A normal shape: a routine distance you repeat, plus the occasional longer day.`;
    return `Only ${concentration}% falls in the five busiest buckets — your distances are unusually spread out. That is the profile the Mex ladder rewards, and it shows: ${nonEmpty} separate buckets have something in them.`;
  })());
}


// Was this activity done with other people? Strava's athlete_count is the real
// answer; the name regex is the fallback for activities cached before the Worker
// started asking for it, and it only ever knew about the names you typed yourself.
function wasSocial(a){
  if(typeof a.athletes==='number')return a.athletes>1;
  return extractPartners(a.name).length>0;
}

// ── SOCIAL ──
// The page used to show two incompatible answers to "how social are you?" twenty pixels
// apart: a stat row counted from Strava's athlete_count, and partner cards counted by
// regex over activity titles. Both were computed correctly; presenting them side by side
// with no stated relationship was the defect. One definition leads now — the participant
// count, which exists on every activity — and the named table is explicitly the subset
// you have written into titles.

const SOC_AVATAR=['#1d4ed8','#ef4444','#eab308','#0ea5e9','#8b5cf6','#ec4899','#f97316','#14b8a6','#84cc16','#a855f7'];

// Regular / Occasional / Lapsed, from the last time you were out together. Whether
// someone is still in your week is more useful than their lifetime total, which is what
// the two old bar charts both ranked by.
// Remembered across re-renders — a unit toggle or a sport filter must not fold
// the group back up underneath you.
let socDormantOpen=false;
function onSocDormantToggle(open){socDormantOpen=open;}

function socStanding(lastDate){
  const days=Math.floor((new Date()-new Date(lastDate+'T12:00:00'))/86400000);
  const label=days<=45?'Regular':days<=240?'Occasional':'Lapsed';
  const [col,bg]=palette().standing[label];
  return{label,col,bg,days};
}

function socAgo(dateStr){
  const d=Math.floor((new Date()-new Date(dateStr+'T12:00:00'))/86400000);
  if(d<=1)return'yesterday';
  if(d<7)return d+' days ago';
  if(d<35){const w=Math.max(1,Math.round(d/7));return w+(w===1?' week ago':' weeks ago');}
  if(d<365){const mo=Math.max(1,Math.round(d/30.4));return mo+(mo===1?' month ago':' months ago');}
  const y=d/365.25;
  return Math.round(y)+(Math.round(y)===1?' year ago':' years ago');
}

let SOC_PARTNERS={};

// ── MERGING THE SAME PERSON WRITTEN SEVERAL WAYS ──
// These names are free text typed into a Strava title over eleven years, with
// no identity behind them, so "Pip", "PiP" and "Pip 💍" arrive as three people
// and "CCC" and "CCC Chaint" as two. The only thing to match on is the text.
//
// Two rules, deliberately conservative:
//   1. Canonical form — emoji, accents, apostrophes, punctuation and case all
//      removed. This is what collapses Pip / PiP / Pip 💍.
//   2. Whole-word prefix absorption — "ccc" swallows "ccc chaint", because the
//      shorter name is how you usually write them and the longer one is the
//      same person with a surname or a club suffix attached. It is a WORD
//      prefix, not a character prefix, so "al" never swallows "alice".
// Resolve every canonical form to the group it belongs to. Sorting shortest
// first means a host is always already resolved when something absorbs into it,
// so "ccc chaint cc" lands on "ccc" in one pass rather than needing a fixpoint.
function socGroupMap(canons){
  const keys=[...new Set(canons)].filter(Boolean).sort((a,b)=>a.length-b.length||a.localeCompare(b));
  const map={};
  keys.forEach(c=>{
    const host=keys.find(k=>k!==c&&k.length>=2&&k.length<c.length&&c.startsWith(k+' '));
    map[c]=host?(map[host]||host):c;
  });
  return map;
}

function renderSocial(){
  const data=getFiltered();

  // ── The lead: one definition, from the field that exists on every activity ──
  const known=data.filter(a=>typeof a.athletes==='number');
  const withCo=known.filter(a=>a.athletes>1);
  const pair=known.filter(a=>a.athletes===2).length;
  const group=known.filter(a=>a.athletes>=3).length;
  const alone=known.filter(a=>a.athletes===1).length;
  const coDist=withCo.reduce((s,a)=>s+(a.dist_mi||0),0);
  const lead=document.getElementById('socLead');
  const badge=document.getElementById('socialBadge');

  if(!known.length){
    if(lead)lead.innerHTML=`<div style="font-size:12px;color:var(--text-muted);line-height:1.6">Strava's participant count arrives with the next refresh. Until then the only signal is the names written into activity titles, which is what the table below reads.</div>`;
    if(badge)badge.textContent='waiting on the next refresh';
  }else{
    const pct=n=>known.length?(n/known.length*100):0;
    if(badge)badge.textContent=`${withCo.length.toLocaleString('en-GB')} of ${known.length.toLocaleString('en-GB')} with company`;
    if(lead)lead.innerHTML=`
      <div class="soc-lead-top">
        <div class="soc-lead-n">${withCo.length.toLocaleString('en-GB')}</div>
        <div class="soc-lead-t">of your ${known.length.toLocaleString('en-GB')} activities had someone else there — ${fmtDist(coDist)} ${distUnit()} in company</div>
      </div>
      <div class="split-bar">
        <span style="width:${pct(alone).toFixed(1)}%;background:#e2e8f0"></span>
        <span style="width:${pct(pair).toFixed(1)}%;background:var(--ride)"></span>
        <span style="width:${pct(group).toFixed(1)}%;background:var(--accent)"></span>
      </div>
      <div class="split-key">
        <span><i style="background:#e2e8f0"></i><b>${alone.toLocaleString('en-GB')}</b> alone</span>
        <span><i style="background:var(--ride)"></i><b>${pair.toLocaleString('en-GB')}</b> with one other</span>
        <span><i style="background:var(--accent)"></i><b>${group.toLocaleString('en-GB')}</b> in a group of three or more</span>
      </div>
      <div class="soc-caveat">
        <span class="ms">edit_note</span>
        <div><strong>The count above knows somebody was there. It does not know who.</strong>
        Names come only from <code style="font-size:11.5px;background:var(--bg);border:1px solid var(--border);padding:0 4px">w/ Name</code> in the title, so the table below covers the company you have written down — never more than that, and possibly much less.</div>
      </div>`;
  }

  // ── Named partners, from the titles ──
  // Two passes: collect every spelling that appears, work out which spellings
  // are the same person, then aggregate against the merged group.
  const raw=[];
  data.forEach(a=>extractPartners(a.name).forEach(p=>raw.push({p,a})));
  const groupOf=socGroupMap(raw.map(r=>socCanon(r.p)));
  const pm={};
  raw.forEach(({p,a})=>{
    const key=groupOf[socCanon(p)]||socCanon(p);
    if(!key)return;
    if(!pm[key])pm[key]={key,count:0,dist:0,time:0,types:{},first:a.date,last:a.date,acts:[],variants:{}};
    const e=pm[key];
    e.count++;e.dist+=a.dist_mi||0;e.time+=a.mt||0;
    e.variants[p]=(e.variants[p]||0)+1;
    const g=typeGroup(a.type);e.types[g]=(e.types[g]||0)+1;
    if(a.date<e.first)e.first=a.date;
    if(a.date>e.last)e.last=a.date;
    e.acts.push(a);
  });
  // Which spelling to show. Frequency alone is not enough: "pip" can outnumber
  // "Pip" and "sam!" can outnumber "Sam", and neither is the name you would
  // write on a card. Score tidiness first — matches the group's canonical form,
  // starts with a capital, carries no stray punctuation or emoji — and only use
  // frequency to break the tie.
  const tidiness=(v,key)=>
    (socCanon(v)===key?8:0)+
    (/^\p{Lu}/u.test(v.trim())?4:0)+
    (/^\p{L}[\p{L} '’-]*$/u.test(v.trim())?2:0);
  Object.values(pm).forEach(e=>{
    const vs=Object.keys(e.variants).sort((x,y)=>
      tidiness(y,e.key)-tidiness(x,e.key)||
      e.variants[y]-e.variants[x]||
      x.length-y.length||x.localeCompare(y));
    e.name=vs[0];
    e.alsoWritten=vs.slice(1);
  });
  // Sorted by recency, not by lifetime total — which is what both old charts did.
  const partners=Object.values(pm).sort((x,y)=>y.last.localeCompare(x.last));
  SOC_PARTNERS={};partners.forEach((p,i)=>{p.colour=SOC_AVATAR[i%SOC_AVATAR.length];SOC_PARTNERS[p.name]=p;});
  const mergedCount=partners.reduce((s,p)=>s+(p.alsoWritten.length?1:0),0);

  const pBadge=document.getElementById('socPartnerBadge');
  if(pBadge){
    const reg=partners.filter(p=>socStanding(p.last).label==='Regular').length;
    pBadge.textContent=partners.length
      ? `${partners.length} ${partners.length===1?'person':'people'} · ${reg} out with you in the last six weeks · most recent first`
      : 'none named yet';
  }

  const wrap=document.getElementById('socPartners');
  if(wrap){
    if(!partners.length){
      wrap.innerHTML=`<div class="chart-empty" style="height:90px;border:1px solid var(--border);background:var(--surface)">No activity titles contain &ldquo;w/ Name&rdquo;, so there is nobody to list. Adding a name in Strava adds a row here.</div>`;
    }else{
      // The sport mix used to be a column of its own. It is three dots now, sized
      // by share and sitting next to the name, which frees the width that the
      // distance and last-out columns used to be dropped to make room for.
      const dots=p=>Object.entries(p.types).sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([g,n])=>`<i style="background:${groupColor(g)};opacity:${(0.45+0.55*n/p.count).toFixed(2)}" title="${escapeAttr(g)} · ${n}"></i>`).join('');

      // Anyone you have been out with in the last six weeks reads as current; the
      // rest are history. Sorted by recency the two were already contiguous, but a
      // long tail of people you last saw a year ago still pushed the ones who
      // matter off the screen — on a phone it was most of the list.
      const current=partners.filter(p=>socStanding(p.last).label==='Regular');
      const dormant=partners.filter(p=>socStanding(p.last).label!=='Regular');
      // Collapsing everything would leave an empty table, so the group opens by
      // default when nobody is current. The toggle stays either way.
      const dormantOpen=socDormantOpen||!current.length;

      const row=p=>{
          const st=socStanding(p.last);
          const also=p.alsoWritten.length
            ? `<em class="soc-also" title="${escapeAttr('Merged from: '+p.alsoWritten.join(', '))}">also ${escapeHtml(p.alsoWritten.slice(0,2).join(', '))}${p.alsoWritten.length>2?' +'+(p.alsoWritten.length-2):''}</em>`
            : '';
          return `<div class="soc-row" data-partner="${escapeAttr(p.name)}" tabindex="0" role="button" aria-label="${escapeAttr(p.name+', '+p.count+' together, last out '+socAgo(p.last))}">
            <div class="soc-avc"><span class="soc-av" style="background:${p.colour}">${escapeHtml(socInitials(p.name))}</span></div>
            <div class="soc-nm">
              <span class="soc-nm-top">${escapeHtml(p.name)}<span class="soc-dots">${dots(p)}</span></span>
              <small>since ${fmtDate(p.first)}${also?' · ':''}${also}</small>
            </div>
            <div class="soc-meta">
              <div class="soc-cell" data-lbl="Together"><b>${p.count.toLocaleString('en-GB')}</b> <span>out</span></div>
              <div class="soc-cell" data-lbl="Distance"><b>${fmtDist(p.dist)}</b> <span>${distUnit()}</span></div>
              <div class="soc-cell soc-ago" data-lbl="Last out">${socAgo(p.last)}</div>
            </div>
            <div class="soc-last"><span class="soc-warm" style="color:${st.col};background:${st.bg}">${st.label}</span></div>
          </div>`;
      };

      const occasional=dormant.filter(p=>socStanding(p.last).label==='Occasional').length;
      const lapsed=dormant.length-occasional;
      const dormantLabel=[occasional?occasional+' occasional':'',lapsed?lapsed+' lapsed':''].filter(Boolean).join(' · ');

      wrap.innerHTML=`<div class="soc-tbl">
        <div class="soc-head"><div></div><div>Partner</div><div>Together</div><div>Distance</div><div>Last out</div><div></div></div>
        ${current.map(row).join('')}
        ${current.length?'':`<div class="soc-empty-current">Nobody in this filter has been out with you in the last six weeks.</div>`}
        ${dormant.length?`<details class="soc-dormant"${dormantOpen?' open':''} data-on-toggle="onSocDormantToggle" data-args-toggle='["$el.open"]'>
          <summary>
            <span class="soc-dormant-n">${dormant.length}</span>
            <span class="soc-dormant-t">${dormant.length===1?'person you have':'people you have'} not been out with recently</span>
            <span class="soc-dormant-sub">${escapeHtml(dormantLabel)}</span>
          </summary>
          ${dormant.map(row).join('')}
        </details>`:''}
      </div>
      <div class="soc-note">${mergedCount
        ? `<strong>${mergedCount} ${mergedCount===1?'person was':'people were'} written more than one way</strong> and have been merged — case, emoji and a trailing surname or club name are ignored, so Pip, PiP and Pip&nbsp;💍 are one row. The merged spellings are listed under each name; open a row to see them all. `
        : ''}Rows carry every figure at every width rather than dropping columns on a narrow screen. A row opens that partner, the way gear and activities do.</div>`;
    }
  }

  // ── The one chart that was pulling its weight ──
  const mk=getMonthKeys(),sbm={},slm={};
  data.forEach(a=>{const m=a.date.slice(0,7);if(wasSocial(a))sbm[m]=(sbm[m]||0)+1;else slm[m]=(slm[m]||0)+1;});
  const sub=document.getElementById('socialTimeSub');
  if(sub)sub.textContent=known.length
    ? `${withCo.length.toLocaleString('en-GB')} of ${known.length.toLocaleString('en-GB')} activities had someone else there`
    : 'Read from activity titles until Strava’s participant count arrives';
  destroyChart('socialTime');
  charts.socialTime=upsertChart('socialTime',document.getElementById('chartSocialTime').getContext('2d'),{
    type:'bar',
    data:{labels:mk.map(monthLabel),datasets:[
      {label:'With others',data:mk.map(m=>sbm[m]||0),backgroundColor:'#1d4ed8',borderRadius:0,borderSkipped:false},
      {label:'Alone',data:mk.map(m=>slm[m]||0),backgroundColor:'#e2e8f0',borderRadius:0,borderSkipped:false}]},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}}},responsive:true,maintainAspectRatio:false,
      scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:10}}},y:{stacked:true,grid:{color:chartGrid()},ticks:{font:{size:11},precision:0}}},interaction:{mode:'index'}}
  });

  // Chips and a verdict, the treatment from the heart-rate card.
  if(known.length){
    const totDist=data.reduce((s,a)=>s+(a.dist_mi||0),0);
    const pctActs=Math.round(withCo.length/known.length*100);
    const pctMiles=totDist>0?Math.round(coDist/totDist*100):0;
    chartSummary('social',[
      {n:pctActs+'%',label:'of activities in company',col:'#1d4ed8'},
      {n:pctMiles+'%',label:'of your distance',col:'#0ea5e9'},
      {n:group.toLocaleString('en-GB'),label:'in groups of three or more',col:'#ff385c'},
    ],(()=>{
      if(!withCo.length)return 'Every activity in this filter was on your own.';
      const d=pctMiles-pctActs;
      if(d>=6)return `One activity in ${Math.max(2,Math.round(known.length/withCo.length))} has company, but those carry ${pctMiles}% of your distance — riding with people makes the day longer, not just more frequent.`;
      if(d<=-6)return `Company accounts for ${pctActs}% of activities but only ${pctMiles}% of distance, so the ones with other people are the shorter outings.`;
      return `${pctActs}% of activities and ${pctMiles}% of distance — company is spread evenly across your week rather than concentrated in the big days out.`;
    })());
  }else chartSummary('social',[],'');

  renderKudos(data);
}

// ── WHAT GETS A REACTION ──
// kudos has been stored on every activity all along and shown in exactly one place:
// the detail modal of a single activity. It is the only number in the dataset that
// is about other people rather than about you, which is why it belongs here and not
// on Charts — and it is worth saying plainly that it measures your followers' habits
// at least as much as your training.
function renderKudos(data){
  const withK=data.filter(a=>typeof a.kudos==='number');
  const total=withK.reduce((s,a)=>s+a.kudos,0);
  if(!withK.length||!total){
    setChartEmpty('chartKudos','No kudos on the activities in this filter.');
    chartSummary('kudos',[],'');
    return;
  }
  setChartEmpty('chartKudos');
  const mk=getMonthKeys(),byMonth={};
  withK.forEach(a=>{
    const m=a.date.slice(0,7);
    (byMonth[m]=byMonth[m]||{k:0,n:0});
    byMonth[m].k+=a.kudos;byMonth[m].n++;
  });
  // An average per activity, not a monthly total: a total rewards a busy month and
  // says nothing about whether any given outing landed.
  const avg=mk.map(m=>byMonth[m]&&byMonth[m].n?+(byMonth[m].k/byMonth[m].n).toFixed(2):null);
  destroyChart('kudos');
  charts.kudos=upsertChart('kudos',document.getElementById('chartKudos').getContext('2d'),{
    type:'bar',
    data:{labels:mk.map(monthLabel),datasets:[{
      data:avg,backgroundColor:'#ff385c',borderRadius:0,borderSkipped:false}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{
      label:c=>{const m=mk[c.dataIndex],b=byMonth[m];
        return b?`${c.parsed.y} kudos per activity · ${b.k.toLocaleString('en-GB')} across ${b.n}`:null;}}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:true,maxTicksLimit:12}},
        y:{grid:{color:chartGrid()},beginAtZero:true,ticks:{font:{size:11}}}}}
  });

  const best=withK.reduce((b,a)=>a.kudos>b.kudos?a:b,withK[0]);
  const perAct=total/withK.length;
  // Which sport does best per outing, rather than in total — the same reason the
  // chart is an average.
  const bySport={};
  withK.forEach(a=>{const g=typeGroup(a.type);(bySport[g]=bySport[g]||{k:0,n:0});bySport[g].k+=a.kudos;bySport[g].n++;});
  const ranked=Object.entries(bySport).filter(([,v])=>v.n>=5)
    .map(([g,v])=>({g,per:v.k/v.n})).sort((a,b)=>b.per-a.per);
  const chips=[
    {n:perAct.toFixed(1),label:'kudos per activity',col:'#ff385c'},
    {n:best.kudos.toLocaleString('en-GB'),label:'best single activity',col:'#8b5cf6'},
  ];
  if(ranked.length)chips.push({n:ranked[0].per.toFixed(1),
    label:`per ${ranked[0].g.toLowerCase()}, your best sport for it`,col:groupColor(ranked[0].g)});
  chartSummary('kudos',chips,(()=>{
    // No escapeHtml: chartSummary writes the verdict with textContent, so escaping
    // here would put a literal &amp; on screen for anyone who trains with Dave & Sarah.
    const head=`${total.toLocaleString('en-GB')} kudos across ${withK.length.toLocaleString('en-GB')} activities. `+
      `The best single one was ${best.name||best.type} on ${fmtDate(best.date)} with ${best.kudos}. `;
    const tail=ranked.length>1
      ? `${ranked[0].g} outings draw ${(ranked[0].per/Math.max(ranked[ranked.length-1].per,0.01)).toFixed(1)}× what ${ranked[ranked.length-1].g.toLowerCase()} ones do. `
      : '';
    return head+tail+`Worth holding loosely: this tracks when your followers are online as much as what you did.`;
  })());
}


// ── PARTNER PANEL ──
// Same shell as gear and activities, so the three read as one idea.
function openPartnerModal(name){
  const p=SOC_PARTNERS[name];
  if(!p)return;
  const st=socStanding(p.last);
  const top=Object.entries(p.types).sort((a,b)=>b[1]-a[1]);
  const stats=[
    {label:'Activities together',value:p.count.toLocaleString('en-GB')},
    {label:'Distance together',value:fmtDist(p.dist)+' '+distUnit()},
    {label:'Moving time',value:fmtTime(p.time)},
    {label:'First out',value:fmtDate(p.first)},
    {label:'Last out',value:fmtDate(p.last)+' · '+socAgo(p.last)},
    {label:'Average outing',value:fmtDist(p.dist/Math.max(1,p.count))+' '+distUnit()},
  ];
  const recent=[...p.acts].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,40);
  document.getElementById('actModal').innerHTML=`
    <div class="soc-modal-head">
      <span class="soc-modal-av" style="background:${p.colour}">${escapeHtml(socInitials(p.name))}</span>
      <div style="flex:1;min-width:0">
        <div class="gear-modal-title">${escapeHtml(p.name)}</div>
        <div class="gear-modal-sub" style="color:${st.col}">${st.label} · ${p.count.toLocaleString('en-GB')} activities together</div>
      </div>
      <button class="gear-modal-close" data-on-click="closeActivityModal" aria-label="Close">✕</button>
    </div>
    <div class="gear-modal-body">
      <div class="gear-modal-stats">${stats.map(s=>`<div><div class="gear-modal-stat-label">${s.label}</div><div class="gear-modal-stat-value">${s.value}</div></div>`).join('')}</div>
      ${p.alsoWritten&&p.alsoWritten.length?`
      <div class="gear-modal-section-title">Also written as</div>
      <div class="soc-variants">${[p.name,...p.alsoWritten].map(v=>
        `<span class="soc-variant${v===p.name?' is-primary':''}">${escapeHtml(v)}<b>${(p.variants[v]||0).toLocaleString('en-GB')}</b></span>`).join('')}
      </div>
      <div class="soc-variant-note">These spellings were merged into one person. If any of them is someone else, the fix is in the Strava activity title — this reads the text, because that is all Strava gives it.</div>`:''}
      <div class="gear-modal-section-title">What you do together</div>
      <div class="gear-modal-types">${top.map(([g,n])=>
        `<div class="gear-modal-type-chip" style="color:${groupColor(g)}">${typeEmoji(g)} ${g} · ${n} · ${fmtDist(p.acts.filter(a=>typeGroup(a.type)===g).reduce((s,a)=>s+(a.dist_mi||0),0))} ${distUnit()}</div>`).join('')}</div>
      <div class="gear-modal-section-title">Together, most recent first${p.acts.length>40?` (showing 40 of ${p.acts.length})`:''}</div>
      <div class="gear-modal-acts">${recent.map(a=>
        `<div class="gear-modal-act-row act-row-click"${a.id?` data-act="${escapeAttr(a.id)}" tabindex="0" role="button"`:''}><span class="gear-modal-act-date">${fmtDate(a.date)}</span>${typeEmoji(typeGroup(a.type))}<span class="gear-modal-act-name" title="${escapeAttr(a.name||'')}">${escapeHtml(a.name||a.type)}</span><span class="gear-modal-act-dist">${fmtDist(a.dist_mi||0)} ${distUnit()}</span></div>`).join('')}</div>
      <div class="act-actions">
        <button ${logSearchAttr(p.name)}>Find in log</button>
      </div>
    </div>`;
  destroyActMap();
  document.getElementById('actModalBackdrop').classList.add('open');
  document.body.style.overflow='hidden';
  trapFocus('actModal');
}

// ── GEAR ──

// Running shoes are the one piece of kit with a service life people actually agree
// on — 300 to 500 miles is the usual guidance. Everything else gets a usage rate
// instead of an invented wear figure, because a made-up chain interval dressed up
// as a forecast is worse than no forecast.
const SHOE_LIFE_MI=500;

function gearForecast(topType,s,col,name){
  // A retired shoe does not need telling it is past its life. Report what it did
  // and stop nagging — the wear bar is advice, and the decision is already made.
  if(name&&isRetiredGear(name)){
    const pctR=Math.round(s.dist/SHOE_LIFE_MI*100);
    return`<div class="gear-forecast"><div class="gear-forecast-sub">Retired${topType==='Run'?` at ${pctR}% of the ${fmtDist(SHOE_LIFE_MI)} ${distUnit()} guideline`:''}, after ${fmtDist(s.dist)} ${distUnit()} and ${s.count.toLocaleString('en-GB')} outing${s.count===1?'':'s'}.</div></div>`;
  }
  const now=new Date(),cutoff=new Date(now.getFullYear(),now.getMonth(),now.getDate()-90).toISOString().slice(0,10);
  const recent=s.acts.filter(a=>a.date>=cutoff).reduce((t,a)=>t+(a.dist_mi||0),0);
  const perWeek=recent/(90/7);
  const rate=perWeek>0.05
    ? `${fmtDist(perWeek)} ${distUnit()}/week over the last 90 days`
    : `Not used in the last 90 days`;

  if(topType!=='Run'){
    return`<div class="gear-forecast"><div class="gear-forecast-sub">${rate}</div></div>`;
  }
  const pct=Math.min(100,Math.round(s.dist/SHOE_LIFE_MI*100));
  const left=Math.max(0,SHOE_LIFE_MI-s.dist);
  // Deliberately NOT the sport colour: groupColor('Run') is #ef4444, so a
  // brand-new pair came out the same red as a worn-out one. Green, amber, red.
  const barCol=pct>=100?'#ef4444':pct>=80?'#f59e0b':'#22c55e';
  let when;
  if(pct>=100)when='Past the usual 500-mile guideline.';
  else if(perWeek>0.05){
    const weeks=Math.ceil(left/perWeek);
    // A date three years out is not a forecast, it is arithmetic with a date on
    // the end. Past eighteen months, say the distance and leave it at that.
    if(weeks>78)when=`${fmtDist(left)} ${distUnit()} to go at this rate.`;
    else{
      const d=new Date(now.getTime()+weeks*7*86400000);
      when=`At this rate, around ${d.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}.`;
    }
  }else when=`${fmtDist(left)} ${distUnit()} to go.`;
  return`<div class="gear-forecast">
    <div class="gear-forecast-head"><span>Wear</span><span>${pct}% of ${fmtDist(SHOE_LIFE_MI)} ${distUnit()}</span></div>
    <div class="gear-forecast-bar"><span style="width:${pct}%;background:${barCol}"></span></div>
    <div class="gear-forecast-sub">${when} ${rate}. The 300–500 mile life is a rule of thumb, not a measurement.</div>
  </div>`;
}

// Lifted out of renderGear so it can be built on demand. GEAR_DATA used to be
// assigned only while the Gear tab rendered, which made openGearModal depend on
// having visited that tab: the "This gear" button inside an activity modal looked up
// an empty object and returned silently on a fresh load. It is one pass over the
// filtered set, so building it when it is asked for costs nothing worth saving.
function gearTotals(data){
  const gm={};
  data.forEach(a=>{
    const g=a.gear;if(!g)return;
    if(!gm[g])gm[g]={count:0,dist:0,time:0,elv:0,cal:0,types:{},typeDist:{},first:a.date,last:a.date,acts:[]};
    gm[g].count++;gm[g].dist+=a.dist_mi||0;gm[g].time+=a.mt||0;gm[g].elv+=a.elv||0;gm[g].cal+=a.cal||0;
    const t=typeGroup(a.type);gm[g].types[t]=(gm[g].types[t]||0)+1;gm[g].typeDist[t]=(gm[g].typeDist[t]||0)+(a.dist_mi||0);
    if(a.date<gm[g].first)gm[g].first=a.date;
    if(a.date>gm[g].last)gm[g].last=a.date;
    gm[g].acts.push(a);
  });
  return gm;
}

function renderGear(){
  const data=getFiltered();
  // Sync indicator — computes dynamically from today's date
  const _lastDate=ALL_DATA.map(a=>a.date).sort().slice(-1)[0];
  const _daysSince=_lastDate?Math.floor((new Date()-new Date(_lastDate+' 12:00:00'))/86400000):null;
  const _syncEl=document.getElementById('gearSyncIndicator');
  if(_syncEl){if(_daysSince!==null&&_daysSince>2){_syncEl.style.display='flex';const _sd=_syncEl.querySelector('.sync-days');if(_sd)_sd.textContent=_daysSince;}else _syncEl.style.display='none';}
  GEAR_DATA=gearTotals(data);
  const gm=GEAR_DATA;
  // Retired items sink below everything still in use. They keep their figures —
  // a retired shoe is still 3,379 miles of your life — but they stop competing
  // with current gear for the top of the page.
  const sorted=Object.entries(gm).sort((a,b)=>
    (isRetiredGear(a[0])?1:0)-(isRetiredGear(b[0])?1:0)||b[1].dist-a[1].dist);
  document.getElementById('gearBadge').textContent=sorted.length+' items';
  const GEAR_COLORS=['#1d4ed8','#ef4444','#eab308','#0ea5e9','#8b5cf6','#22c55e','#f97316','#14b8a6','#84cc16','#a855f7'];
  // Gear cards (top 8)
  document.getElementById('gearCards').innerHTML=sorted.map(([name,s],i)=>{
    const topType=dominantType(s.types);
    const col=groupColor(topType);
    const img=gearPhoto(name);
    return`<div class="gear-card${isRetiredGear(name)?' is-retired':''}" style="border-top:3px solid ${col}" data-gear="${escapeAttr(name)}" tabindex="0" role="button" aria-label="${escapeAttr(gearLabel(name)+', '+fmtDist(s.dist)+' '+distUnit())}">
      ${img?`<img class="gear-photo" src="${escapeAttr(img)}" alt="${escapeAttr(name)}" loading="lazy" data-tile="gear-icon-tile" data-soft="${groupSoft(topType)}" data-colour="${col}" data-icon="${gearIconName(topType)}" data-fallback="${escapeAttr(gearPhotoFallback(name))}" data-on-error="gearPhotoFailed" data-args-error='["$el"]'>`:gearIconTile(topType,'gear-icon-tile')}
      <div class="gear-name" title="${escapeAttr(gearLabel(name))}">${escapeHtml(gearLabel(name))}</div>
      ${isUnresolvedGear(name)?`<div class="gear-unresolved">${escapeHtml(name)}</div>`:''}
      <div class="gear-type" style="color:${col}">${typeEmoji(topType)} ${topType}${gearMetaLine(name)}${gearRetiredTag(name)}</div>
      <div class="gear-hero">
        <div class="gear-hero-label">Distance</div>
        <div class="gear-hero-value">${fmtDist(s.dist)} <em>${distUnit()}</em></div>
      </div>
      <div class="gear-trio">
        <div><div class="gear-trio-label">${topType==='Run'?'Runs':topType==='Walk'?'Walks':topType==='Swim'?'Swims':'Uses'}</div><div class="gear-trio-value">${s.count.toLocaleString('en-GB')}</div></div>
        <div><div class="gear-trio-label">Moving</div><div class="gear-trio-value" title="${escapeAttr(fmtTime(s.time))}">${Math.round(s.time/3600).toLocaleString('en-GB')}h</div></div>
        <div><div class="gear-trio-label">Climbed</div><div class="gear-trio-value">${fmtElv(s.elv)}</div></div>
      </div>
      ${gearForecast(topType,s,col,name)}
      <div class="gear-span"><span>${fmtDate(s.first)}</span><span>${fmtDate(s.last)}</span></div>
    </div>`;
  }).join('');
  // Chart: by distance
  const top10d=sorted.slice(0,10);
  document.getElementById('gearDistSub').textContent=(unit==='mi'?'Miles':'Kilometres')+' logged per item';
  destroyChart('gearDist');
  charts.gearDist=upsertChart('gearDist',document.getElementById('chartGearDist').getContext('2d'),{type:'bar',data:{labels:top10d.map(([n])=>n.length>22?n.slice(0,22)+'…':n),datasets:[{data:top10d.map(([,s])=>+(unit==='mi'?s.dist:s.dist*1.60934).toFixed(0)),backgroundColor:GEAR_COLORS,borderRadius:0}]},options:{indexAxis:'y',plugins:{legend:{display:false}},responsive:true,maintainAspectRatio:false,scales:{x:{grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v.toLocaleString()+' '+distUnit()}},y:{grid:{display:false},ticks:{font:{size:11}}}}}});
  // This used to be "Top Gear by Activities" — the same items in the same order
  // as the chart above it, because with a handful of items each in a different
  // sport, any ranking is just a ranking of your sports. A small collection
  // cannot support a league table, but it can support a history: when each item
  // arrived, when it took over, and when it quietly stopped being used.
  renderGearTimeline(gm,GEAR_COLORS);
}

function renderGearTimeline(gm,COLORS){
  const names=Object.entries(gm).sort((a,b)=>b[1].dist-a[1].dist).slice(0,8).map(([n])=>n);
  const sub=document.getElementById('gearTimeSub');
  const perQ={};let minQ=null,maxQ=null;
  names.forEach(n=>gm[n].acts.forEach(a=>{
    const y=a.date.slice(0,4),q=Math.floor(+a.date.slice(5,7)/3.01)+1;
    const key=y+'Q'+q;
    if(!perQ[key])perQ[key]={};
    perQ[key][n]=(perQ[key][n]||0)+(a.dist_mi||0);
    if(!minQ||key<minQ)minQ=key;if(!maxQ||key>maxQ)maxQ=key;
  }));
  if(!minQ){
    setChartEmpty('chartGearCount','No gear is named on the activities in this filter.');
    return;
  }
  setChartEmpty('chartGearCount');
  // Every quarter between first and last, so a gap reads as a gap.
  const quarters=[];
  let [qy,qq]=[+minQ.slice(0,4),+minQ.slice(5)];
  const [ey,eq]=[+maxQ.slice(0,4),+maxQ.slice(5)];
  while(qy<ey||(qy===ey&&qq<=eq)){quarters.push(qy+'Q'+qq);qq++;if(qq>4){qq=1;qy++;}}
  if(sub)sub.textContent=(unit==='mi'?'Miles':'Kilometres')+' per quarter by item · '+quarters.length+' quarters, '+quarters[0].replace('Q',' Q')+' to '+quarters[quarters.length-1].replace('Q',' Q');
  const conv=v=>+(unit==='mi'?v:v*1.60934).toFixed(0);
  destroyChart('gearCount');
  charts.gearCount=upsertChart('gearCount',document.getElementById('chartGearCount').getContext('2d'),{
    type:'bar',
    data:{labels:quarters.map(q=>q.replace('Q',' Q')),datasets:names.map((n,i)=>({
      label:gearLabel(n),
      data:quarters.map(q=>conv((perQ[q]||{})[n]||0)),
      backgroundColor:COLORS[i%COLORS.length],borderRadius:0,borderSkipped:false}))},
    options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},
      tooltip:{callbacks:{label:c=>c.dataset.label+': '+c.parsed.y.toLocaleString()+' '+distUnit()}}},
      responsive:true,maintainAspectRatio:false,
      scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:9},maxTicksLimit:14,autoSkip:true}},
        y:{stacked:true,grid:{color:chartGrid()},ticks:{font:{size:11},callback:v=>v.toLocaleString()}}},
      interaction:{mode:'index'}}
  });
}

document.getElementById('gearCards').addEventListener('click',e=>{
  const card=e.target.closest('.gear-card');
  if(card)openGearModal(card.dataset.gear);
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  // Reorder mode is the outermost thing Escape can close, so it goes last — a menu
  // opened on top of it should close first and leave you still reordering.
  if(!settingsIsOpen()&&reorderOn){endReorder();return;}
  closeSettings();closeGearModal();closeActivityModal();
});

// One delegated handler covers the recent-activity rows on the Summary and the Log's
// table rows, both now and after any re-render. Links and buttons inside a row keep
// their own behaviour — clicking Strava should go to Strava, not open the modal.
document.addEventListener('click',e=>{
  if(e.target.closest('a,button'))return;
  // The two never nest: a partner row carries no activity id, and the outings listed
  // inside the partner panel carry no partner. So whichever matches is the one meant.
  const act=e.target.closest('[data-act]');
  if(act&&act.dataset.act){openActivityModal(act.dataset.act);return;}
  const partner=e.target.closest('[data-partner]');
  if(partner&&partner.dataset.partner)openPartnerModal(partner.dataset.partner);
});


// ── MODAL FOCUS MANAGEMENT ──
// Escape already closed these. What it did not do was move focus in on open, keep
// Tab inside while open, or give focus back to whatever you were on when it closes
// — so a keyboard or screen-reader user could tab straight out of an open dialog
// into the page behind it and never find their way back.
let _focusReturn=null;
const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusableIn(el){
  return [...el.querySelectorAll(FOCUSABLE)].filter(n=>n.offsetParent!==null||n===document.activeElement);
}

function trapFocus(dialogId){
  const dlg=document.getElementById(dialogId);
  if(!dlg)return;
  _focusReturn=document.activeElement;
  // rAF so the dialog is laid out and its contents are focusable by the time we look.
  requestAnimationFrame(()=>{
    const items=focusableIn(dlg);
    (items[0]||dlg).focus();
  });
}

function releaseFocus(){
  const back=_focusReturn;
  _focusReturn=null;
  if(back&&document.contains(back)&&back.focus)back.focus();
}

function openDialogId(){
  for(const id of ['actModalBackdrop','gearModalBackdrop']){
    const el=document.getElementById(id);
    if(el&&el.classList.contains('open'))return id==='actModalBackdrop'?'actModal':'gearModal';
  }
  const st=document.getElementById('settingsMenu');
  if(st&&st.classList.contains('open'))return 'settingsMenu';
  if(document.getElementById('scopeSheet')&&document.getElementById('scopeSheet').classList.contains('open'))return 'scopeSheet';
  return null;
}

document.addEventListener('keydown',e=>{
  if(e.key!=='Tab')return;
  const id=openDialogId();
  if(!id)return;
  const dlg=document.getElementById(id);
  const items=focusableIn(dlg);
  if(!items.length){e.preventDefault();dlg.focus();return;}
  const first=items[0],last=items[items.length-1];
  if(e.shiftKey&&(document.activeElement===first||document.activeElement===dlg)){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  else if(!dlg.contains(document.activeElement)){e.preventDefault();first.focus();}
});

function openGearModal(name){
  // Build it if the Gear tab has not rendered yet — otherwise this returns silently
  // when opened from an activity modal on a fresh load.
  if(!Object.keys(GEAR_DATA).length)GEAR_DATA=gearTotals(getFiltered());
  const s=GEAR_DATA[name];
  if(!s)return;
  const topType=dominantType(s.types);
  const col=groupColor(topType);
  const img=gearPhoto(name);
  const avgDist=s.count?s.dist/s.count:0;
  const avgTime=s.count?s.time/s.count:0;
  const typeRows=Object.entries(s.types).sort((a,b)=>b[1]-a[1]).map(([t,c])=>
    `<div class="gear-modal-type-chip" style="color:${groupColor(t)}">${typeEmoji(t)} ${t} · ${c} · ${fmtDist(s.typeDist[t]||0)} ${distUnit()}</div>`
  ).join('');
  const actsSorted=[...s.acts].sort((a,b)=>b.date.localeCompare(a.date));
  const actRows=actsSorted.map(a=>
    `<div class="gear-modal-act-row"><span class="gear-modal-act-date">${fmtDate(a.date)}</span>${typeEmoji(typeGroup(a.type))}<span class="gear-modal-act-name" title="${escapeAttr(a.name||'')}">${escapeHtml(a.name||a.type)}</span><span class="gear-modal-act-dist">${fmtDist(a.dist_mi||0)} ${distUnit()}</span></div>`
  ).join('');
  const stats=[
    {label:'Total distance',value:fmtDist(s.dist)+' '+distUnit()},
    {label:'Activities',value:s.count.toLocaleString('en-GB')},
    {label:'Moving time',value:fmtTime(s.time)},
    {label:'Elevation',value:fmtElv(s.elv)},
    {label:'Calories',value:fmtCal(s.cal)},
    {label:'Avg distance',value:fmtDist(avgDist)+' '+distUnit()},
    {label:'Avg duration',value:fmtTime(avgTime)},
    {label:'First used',value:fmtDate(s.first)},
    {label:'Last used',value:fmtDate(s.last)},
    {label:'In use',value:daysBetween(s.first,s.last).toLocaleString('en-GB')+' days'},
  ];
  document.getElementById('gearModal').innerHTML=`
    ${img?`<img class="gear-modal-photo" src="${escapeAttr(img)}" alt="${escapeAttr(name)}" data-tile="gear-modal-icon" data-soft="${groupSoft(topType)}" data-colour="${col}" data-icon="${gearIconName(topType)}" data-fallback="${escapeAttr(gearPhotoFallback(name))}" data-on-error="gearPhotoFailed" data-args-error='["$el"]'>`:gearIconTile(topType,'gear-modal-icon')}
    <div class="gear-modal-head">
      <div><div class="gear-modal-title">${escapeHtml(gearLabel(name))}</div><div class="gear-modal-sub" style="color:${col}">${typeEmoji(topType)} Mostly ${topType.toLowerCase()}</div>${isUnresolvedGear(name)
        ?`<div class="gear-unresolved" style="margin-top:4px">Strava id ${escapeHtml(name)} — the name lookup failed. It is retried on every sync, so this usually fixes itself.</div>`
        :`<div class="gear-photo-hint is-hidden">No photo yet — drop one in as <code>gear-images/${escapeHtml(gearSlug(name))}.jpg</code> and it appears here, no code change needed.</div>`}</div>
      <button class="gear-modal-close" data-on-click="closeGearModal">✕</button>
    </div>
    <div class="gear-modal-body">
      <div class="gear-modal-stats">${stats.map(s=>`<div><div class="gear-modal-stat-label">${s.label}</div><div class="gear-modal-stat-value">${s.value}</div></div>`).join('')}</div>
      <div class="gear-modal-section-title">Activity breakdown</div>
      <div class="gear-modal-types">${typeRows}</div>
      <div class="gear-modal-section-title">All activities (${s.acts.length})</div>
      <div class="gear-modal-acts">${actRows}</div>
    </div>`;
  document.getElementById('gearModalBackdrop').classList.add('open');
  trapFocus('gearModal');
  document.body.style.overflow='hidden';
}

function closeGearModal(){
  document.getElementById('gearModalBackdrop').classList.remove('open');
  document.body.style.overflow='';
  releaseFocus();
}

// ── ACTIVITY DETAIL MODAL ──
// Same shell as the gear modal, so the two read as one idea. The header is a map of
// the route where there is one — privacy-trimmed activities and anything without GPS
// fall back to the sport tile rather than an empty grey box.

let _actMap=null;

// The modal's innerHTML is replaced on every open, which destroys the container the
// map was mounted in, so the map is rebuilt each time rather than reused. Leaflet
// leaks listeners if the container disappears without remove() being called.
function destroyActMap(){
  if(_actMap){try{_actMap.remove();}catch(e){/* container already gone */}_actMap=null;}
}

function actById(id){return ALL_DATA.find(a=>String(a.id)===String(id))||null;}

function openActivityModal(id){
  const a=actById(id);
  if(!a)return;
  const g=typeGroup(a.type),col=groupColor(g);
  const segs=a.polylines||(a.polyline?[a.polyline]:[]);
  const hasRoute=segs.length>0;

  const stopped=(a.et&&a.mt&&a.et-a.mt>=60)?a.et-a.mt:0;
  const isFoot=g==='Run'||g==='Walk';
  const stats=[
    a.dist_mi?{label:'Distance',value:fmtDist(a.dist_mi)+' '+distUnit()}:null,
    a.mt?{label:'Moving time',value:fmtTime(a.mt)}:null,
    stopped?{label:'Stopped',value:fmtTime(stopped)}:null,
    (isFoot&&a.pace_mi)?{label:'Avg pace',value:fmtPace(a.pace_mi)}:(a.speed_mph?{label:'Avg speed',value:fmtSpeed(a.speed_mph)}:null),
    a.elv?{label:'Elevation',value:fmtElv(a.elv)}:null,
    a.hr?{label:'Avg heart rate',value:Math.round(a.hr)+' bpm'}:null,
    a.max_hr?{label:'Max heart rate',value:Math.round(a.max_hr)+' bpm'}:null,
    a.cad?{label:'Cadence',value:cadenceLabel(a.cad,g)}:null,
    a.pwr?{label:'Avg power',value:fmtNum(a.pwr)+'W'}:null,
    a.max_pwr?{label:'Max power',value:fmtNum(a.max_pwr)+'W'}:null,
    a.cal?{label:'Calories',value:fmtCal(a.cal)+' kcal'}:null,
    (()=>{const sh=routeShape(a);return sh?{label:'Route shape',value:sh.label,title:sh.note}:null;})(),
    a.score?{label:'Relative Effort',value:fmtNum(a.score)}:null,
    a.kudos?{label:'Kudos',value:a.kudos.toLocaleString('en-GB')}:null,
    (typeof a.athletes==='number'&&a.athletes>1)?{label:'Group size',value:a.athletes+' people'}:null,
    a.gear?{label:'Gear',value:escapeHtml(gearLabel(a.gear))}:null,
  ].filter(Boolean);

  const marks=[
    isRace(a)?`<span class="act-mark" style="color:var(--accent);background:var(--accent-soft)">Race</span>`:'',
    a.commute?`<span class="act-mark" style="color:#475569;background:#e2e8f0">Commute</span>`:'',
    a.near_home?`<span class="act-mark" style="color:#854d0e;background:#fef9c3">Starts near home · route trimmed</span>`:'',
  ].filter(Boolean).join('');

  // Zone split, same colours as the Charts tab so the two are obviously the same thing.
  const z=[a.z1||0,a.z2||0,a.z3||0,a.z4||0,a.z5||0];
  const zTot=z.reduce((s,v)=>s+v,0);
  const zoneBlock=zTot?`
    <div class="gear-modal-section-title">Heart-rate zones</div>
    <div class="act-zonebar">${z.map((v,i)=>v?`<span style="width:${v/zTot*100}%;background:${ZONE_COLORS[i]}" title="${ZONE_NAMES[i]} · ${fmtTime(v)}"></span>`:'').join('')}</div>
    <div class="act-zonekey">${z.map((v,i)=>v?`<span><i style="background:${ZONE_COLORS[i]}"></i>${ZONE_NAMES[i].split(' ')[0]} ${Math.round(v/zTot*100)}%</span>`:'').join('')}</div>
    <div style="font-size:10px;color:var(--text-light);margin-top:7px">Estimated from this activity's average heart rate, not measured second by second.</div>
  `:'';

  const prs=[['pr_1km','1 km'],['pr_1mi','1 mile'],['pr_5km','5 km'],['pr_10km','10 km'],['pr_hm','Half marathon'],['pr_mar','Marathon']]
    .filter(([f])=>a[f]>0)
    .map(([f,l])=>`<div class="gear-modal-type-chip" style="color:${col}">${l} · ${fmtPRTime(a[f])}</div>`).join('');

  const when=fmtDate(a.date)+(a.time?' · '+a.time:'');

  document.getElementById('actModal').innerHTML=`
    ${hasRoute
      ? `<div id="actModalMap" class="act-map"></div>`
      : `<div class="act-map-none" style="background:${groupSoft(g)}">
           <span class="ms" style="color:${col}">${gearIconName(g)}</span>
           <span class="lbl">${a.near_home?'Route hidden — starts near home':'No GPS route for this activity'}</span>
         </div>`}
    <div class="gear-modal-head">
      <div style="min-width:0">
        <div class="gear-modal-title">${escapeHtml(a.name||a.type)}</div>
        <div class="gear-modal-sub" style="color:${col}">${typeEmoji(g)} ${escapeHtml(a.sport||a.type)} · ${when}</div>
        ${marks?`<div class="act-marks">${marks}</div>`:''}
      </div>
      <button class="gear-modal-close" data-on-click="closeActivityModal" aria-label="Close">✕</button>
    </div>
    <div class="gear-modal-body">
      <div class="gear-modal-stats">${stats.map(s=>`<div${s.title?` title="${escapeAttr(s.title)}"`:''}><div class="gear-modal-stat-label">${s.label}</div><div class="gear-modal-stat-value">${s.value}</div></div>`).join('')}</div>
      ${zoneBlock}
      ${prs?`<div class="gear-modal-section-title" style="margin-top:20px">Segment bests on this run</div><div class="gear-modal-types">${prs}</div>`:''}
      <div class="act-actions">
        ${a.id?`<a class="strava" href="https://www.strava.com/activities/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">↗ View on Strava</a>`:''}
        ${a.gear?`<button data-on-click="openGearFromActivity" data-args-click='${escapeAttr(JSON.stringify([String(a.gear)]))}'>This gear</button>`:''}
        ${a.name?`<button ${logSearchAttr(a.name)}>Find in log</button>`:''}
      </div>
    </div>`;

  document.getElementById('actModalBackdrop').classList.add('open');
  document.body.style.overflow='hidden';
  trapFocus('actModal');

  if(hasRoute)drawActivityMap(segs,col);
}

// Built after the backdrop is shown, so Leaflet measures a laid-out container rather
// than a display:none one and comes up zero-sized.
function drawActivityMap(segs,col){
  destroyActMap();
  // Opening an activity from the log can be the first thing that ever needs Leaflet.
  ensureLeaflet().then(()=>requestAnimationFrame(()=>{
    const el=document.getElementById('actModalMap');
    if(!el||typeof L==='undefined')return;
    try{
      _actMap=L.map(el,{zoomControl:false,attributionControl:false,scrollWheelZoom:false,preferCanvas:true});
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,opacity:.55}).addTo(_actMap);
      const all=[];
      segs.forEach(seg=>{
        const pts=decodePolylinePts(seg);
        if(pts.length<2)return;
        L.polyline(pts,{color:col,weight:3.5,opacity:.95}).addTo(_actMap);
        all.push(...pts);
      });
      if(all.length){
        _actMap.fitBounds(L.latLngBounds(all),{padding:[24,24],maxZoom:15});
        // Start and finish, so a loop can be told from a point-to-point at a glance.
        L.circleMarker(all[0],{radius:5,color:'#fff',weight:2,fillColor:'#16a34a',fillOpacity:1}).addTo(_actMap);
        L.circleMarker(all[all.length-1],{radius:5,color:'#fff',weight:2,fillColor:'#ef4444',fillOpacity:1}).addTo(_actMap);
      }
      _actMap.invalidateSize();
    }catch(e){console.error('Could not draw the activity map:',e);}
  })).catch(e=>console.error('Could not load the map library:',e));
}

function closeActivityModal(){
  destroyActMap();
  document.getElementById('actModalBackdrop').classList.remove('open');
  document.body.style.overflow='';
  releaseFocus();
}

// ── LOG ──
function getLogData(){
  let data=getFiltered().slice().reverse();
  if(logSearch){const q=logSearch.toLowerCase();data=data.filter(a=>(a.name||'').toLowerCase().includes(q)||(a.type||'').toLowerCase().includes(q)||(a.sport||'').toLowerCase().includes(q)||(a.gear||'').toLowerCase().includes(q)||a.date.includes(q));}
  data.sort((a,b)=>{
    if(logSort.col==='date')return logSort.dir*(a.date<b.date?-1:a.date>b.date?1:0);
    const fmap={dist:'dist_mi',time:'mt',elv:'elv',hr:'hr',cal:'cal',speed:'speed_mph'};
    const f=fmap[logSort.col];return f?logSort.dir*((a[f]||0)-(b[f]||0)):0;
  });
  return data;
}
function renderSearchSummary(data){
  const el=document.getElementById('searchSummary');
  if(!logSearch.trim()){el.style.display='none';return;}
  const totalDist=data.reduce((s,a)=>s+(a.dist_mi||0),0);
  const totalTime=data.reduce((s,a)=>s+(a.mt||0),0);
  const totalElv=data.reduce((s,a)=>s+(a.elv||0),0);
  const totalCal=data.reduce((s,a)=>s+(a.cal||0),0);
  const avgDist=data.length?totalDist/data.length:0;
  const avgTime=data.length?totalTime/data.length:0;
  const speeds=data.filter(a=>a.speed_mph>0).map(a=>a.speed_mph);
  const avgSpeed=speeds.length?speeds.reduce((s,v)=>s+v,0)/speeds.length:null;
  el.style.display='grid';
  el.innerHTML=[
    {label:'Activities',value:data.length.toLocaleString('en-GB'),unit:''},
    {label:'Total Distance',value:fmtDist(totalDist),unit:distUnit()},
    {label:'Total Time',value:fmtTime(totalTime),unit:''},
    {label:'Elevation',value:fmtElv(totalElv),unit:''},
    {label:'Calories',value:fmtCal(totalCal),unit:'kcal'},
    {label:'Avg Distance',value:fmtDist(avgDist),unit:distUnit()},
    {label:'Avg Time',value:fmtTime(avgTime),unit:''},
    ...(avgSpeed?[{label:'Avg Speed',value:fmtSpeed(avgSpeed),unit:''}]:[]),
  ].map(s=>`<div><div class="search-summary-label">${s.label}</div><div class="search-summary-value">${s.value}<span class="search-summary-unit">${s.unit}</span></div></div>`).join('');
}
function filterLog(){logSearch=document.getElementById('logSearch').value;logPage=1;renderLog();}
function sortLog(col){
  if(logSort.col===col)logSort.dir*=-1;else{logSort.col=col;logSort.dir=-1;}
  document.querySelectorAll('thead th').forEach(th=>th.classList.remove('sorted'));
  const th=document.getElementById('th-'+col);if(th){th.classList.add('sorted');th.querySelector('.sort-icon').textContent=logSort.dir===1?'↑':'↓';}
  renderLog();
}
function changePage(dir){const data=getLogData();const t=Math.ceil(data.length/LOG_PAGE_SIZE)||1;logPage=Math.max(1,Math.min(t,logPage+dir));renderLog();}

function routeShape(a){
  const segs=a.polylines||(a.polyline?[a.polyline]:[]);
  if(!segs.length)return null;
  // A route passing through a home zone has that part cut out for privacy, so
  // its real start or finish may be missing. Say so rather than calling a ride
  // point-to-point because its ends were trimmed off.
  if(segs.length>1||a.near_home)return{label:'Route trimmed near home',note:'Part of this route sits inside a privacy zone, so its shape cannot be read from what is left.'};
  const pts=decodePolylinePts(segs[0]);
  if(pts.length<20)return null;
  const start=pts[0],end=pts[pts.length-1];
  // Span, not total distance: a big number here means the ride went somewhere.
  let span=0;
  for(let i=0;i<pts.length;i+=Math.max(1,Math.floor(pts.length/60)))span=Math.max(span,haversineMi(start,pts[i]));
  if(span<=0.05)return null;
  const gap=haversineMi(start,end);
  if(gap>span*0.35)return{label:'Point to point',note:`Finished ${fmtDist(gap)} ${distUnit()} from where it started.`};
  // Both ends meet. A loop and an out-and-back look identical at the endpoints,
  // so compare the outward path against the return: on an out-and-back the point
  // a fifth of the way in sits almost on top of the point a fifth from the end.
  let retrace=0,n=0;
  for(let f=0.08;f<=0.46;f+=0.04){
    const i=Math.floor(pts.length*f),j=Math.floor(pts.length*(1-f));
    retrace+=haversineMi(pts[i],pts[j]);n++;
  }
  const mean=retrace/Math.max(1,n);
  return mean<span*0.22
    ? {label:'Out and back',note:`Out ${fmtDist(span)} ${distUnit()} and back along the same road.`}
    : {label:'Loop',note:`A loop reaching ${fmtDist(span)} ${distUnit()} from the start at its furthest.`};
}

// Strava reports foot cadence as one leg's revolutions per minute, so a run at
// "88" is actually 176 steps a minute. Bikes are already whole revolutions.
function cadenceLabel(cad,g){
  if(g==='Run'||g==='Walk')return Math.round(cad*2)+' spm';
  return Math.round(cad)+' rpm';
}

function renderLog(){
  const data=getLogData();
  renderSearchSummary(data);
  const total=data.length,totalPages=Math.ceil(total/LOG_PAGE_SIZE)||1;
  const slice=data.slice((logPage-1)*LOG_PAGE_SIZE,logPage*LOG_PAGE_SIZE);
  document.getElementById('logCount').textContent=total.toLocaleString('en-GB')+' activities';
  document.getElementById('pageInfo').textContent=`Page ${logPage} of ${totalPages}`;
  document.getElementById('prevBtn').disabled=logPage<=1;
  document.getElementById('nextBtn').disabled=logPage>=totalPages;
  document.getElementById('logBody').innerHTML=slice.map(a=>{
    const g=typeGroup(a.type);
    const bc={Ride:'badge-ride',Virtual:'badge-virtual',Run:'badge-run',Walk:'badge-walk',Swim:'badge-swim',Other:'badge-other'}[g]||'badge-other';
    // Show specific sport for Other activities
    const displayType=(g==='Other'&&activeType==='Other')?(a.sport||a.type):g;
    const gearShort=a.gear?gearLabel(a.gear).split(' ').slice(0,2).join(' '):'—';
    // Two new fields go inside cells that already exist rather than into columns of
    // their own — the table is eleven wide already and the phone hides five of them.
    const stopped=(a.et&&a.mt&&a.et-a.mt>=60)?a.et-a.mt:0;
    const marks=[
      isRace(a)?'<span class="row-mark race" title="Race">RACE</span>':'',
      a.commute?'<span class="row-mark commute" title="Commute"><span class="ms">work</span></span>':''
    ].join('');
    return`<tr${a.id?` class="act-row-click" data-act="${escapeAttr(a.id)}" tabindex="0" role="button" aria-label="${escapeAttr((a.name||a.type||'Activity')+', '+fmtDate(a.date))}"`:''}>
      <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${fmtDate(a.date)}${a.time?`<div class="cell-sub">${a.time}</div>`:''}</td>
      <td><span class="type-badge ${bc}">${displayType}</span></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(a.name||'')}">${marks}${escapeHtml(a.name||'—')}</td>
      <td>${a.dist_mi?fmtDist(a.dist_mi)+' '+distUnit():'—'}</td>
      <td>${fmtSpeed(a.speed_mph)}</td>
      <td>${fmtTime(a.mt)}${stopped?`<div class="cell-sub" title="Elapsed time minus moving time">+${fmtTime(stopped)} stopped</div>`:''}</td>
      <td>${a.elv?fmtElv(a.elv):'—'}</td>
      <td>${a.hr?Math.round(a.hr)+'bpm':'—'}${a.cad?`<div class="cell-sub">${cadenceLabel(a.cad,g)}</div>`:''}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-muted)" title="${escapeAttr(a.gear||'')}">${gearShort}</td>
      <td>${a.cal?a.cal.toLocaleString('en-GB'):'—'}</td>
      <td>${a.id&&a.has_map?`<a href="https://www.strava.com/activities/${a.id}" target="_blank" rel="noopener noreferrer" class="strava-link">↗</a>`:''}</td>
    </tr>`;
  }).join('');
}

// ── ZWIFT ROUTES ──

async function loadZwiftRoutes(forceRefresh=false){
  if(!forceRefresh){
    try{
      const cached=localStorage.getItem(ZWIFT_CACHE_KEY);
      if(cached){
        const parsed=JSON.parse(cached);
        ZWIFT_DATA=parsed.data||[];_zwiftRiddenIndex=null;
        zwiftLoaded=true;
        buildZwiftStatusFilters();
        renderZwiftTable();
      }
    }catch(e){ /* bad cache, ignore */ }
  }

  const url=ZWIFT_WORKER_BASE+'/zwift-routes'+(forceRefresh?'?refresh=true':'');
  try{
    const res=await fetch(url);
    const json=await res.json();
    if(!res.ok||json.error){
      throw new Error(json.message||'Failed to load Zwift routes');
    }
    ZWIFT_DATA=json.data;_zwiftRiddenIndex=null;
    zwiftLoaded=true;
    localStorage.setItem(ZWIFT_CACHE_KEY,JSON.stringify({data:json.data,updatedAt:json.updatedAt}));
    buildZwiftStatusFilters();
    renderZwiftTable();
  }catch(e){
    console.error('Could not load Zwift routes from Notion:',e);
    if(ZWIFT_DATA.length){
      console.warn('Zwift routes: showing cached data (offline)');
    }else{
      document.getElementById('zwiftEmpty').style.display='block';
      document.getElementById('zwiftGroups').innerHTML='';
    }
  }
}

function buildZwiftStatusFilters(){
  const el=document.getElementById('zwiftStatusFilters');
  if(!el)return;
  el.innerHTML=['All',...ZWIFT_STATUS_ORDER].map(s=>{
    const active=s===zwiftStatusFilter;
    const color=s==='All'?'#ff385c':zwiftStatusColor(s);
    const style=active?` style="color:${color};background:${color}1a"`:'';
    return`<button class="type-btn${active?' active':''}"${style} data-on-click="setZwiftStatusFilter" data-args-click='${escapeAttr(JSON.stringify([s]))}'>${s}</button>`;
  }).join('');
}
function setZwiftStatusFilter(s){zwiftStatusFilter=s;buildZwiftStatusFilters();renderZwiftTable();}
function filterZwiftRoutes(){zwiftSearch=document.getElementById('zwiftSearch').value.toLowerCase();renderZwiftTable();}

function getZwiftGroups(){
  let rows=ZWIFT_DATA;
  if(zwiftStatusFilter!=='All')rows=rows.filter(r=>r.status===zwiftStatusFilter);
  if(zwiftSearch)rows=rows.filter(r=>r.route.toLowerCase().includes(zwiftSearch)||(r.maps||[]).some(m=>m.toLowerCase().includes(zwiftSearch)));

  const groups=[];
  MAP_ORDER.forEach(mapName=>{
    const matches=rows.filter(r=>(r.maps||[]).includes(mapName));
    if(matches.length)groups.push({name:mapName,routes:sortZwiftRoutes(matches)});
  });
  const unassigned=rows.filter(r=>!(r.maps||[]).length);
  if(unassigned.length)groups.push({name:'Unassigned',routes:sortZwiftRoutes(unassigned)});
  return groups;
}
function sortZwiftRoutes(routes){
  return[...routes].sort((a,b)=>{
    const s=ZWIFT_STATUS_ORDER.indexOf(a.status)-ZWIFT_STATUS_ORDER.indexOf(b.status);
    return s!==0?s:a.route.localeCompare(b.route);
  });
}

const ZWIFT_STATUS_COLOR={'Complete':'#16a34a','Planned':'#1e6fa8','Not started':'#94a3b8','Blocked':'#dc2626'};
function zwiftStatusColor(status){return ZWIFT_STATUS_COLOR[status]||ZWIFT_STATUS_COLOR['Not started'];}

const ZWIFT_CHEVRON_SVG='<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ── ZWIFT ROUTES ↔ VIRTUAL RIDES ──
// Zwift writes the route name into the activity title ("Zwift - Volcano Circuit in
// Watopia"), so the two datasets can be joined on the name without any extra API.
// Names shorter than six characters are skipped: "Hilly" would match half of Watopia.
let _zwiftRiddenIndex=null;

function zwiftNorm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}

function zwiftRiddenIndex(){
  if(_zwiftRiddenIndex)return _zwiftRiddenIndex;
  const virtuals=ALL_DATA.filter(a=>typeGroup(a.type)==='Virtual').map(a=>({n:zwiftNorm(a.name),date:a.date}));
  const idx={};
  ZWIFT_DATA.forEach(r=>{
    const key=zwiftNorm(r.route);
    if(key.length<6)return;
    const hits=virtuals.filter(v=>v.n.includes(key));
    if(hits.length)idx[r.id]={count:hits.length,last:hits.map(h=>h.date).sort().slice(-1)[0]};
  });
  _zwiftRiddenIndex=idx;
  return idx;
}

// Routes the activity history says have been done but Notion still calls unfinished.
function renderZwiftRiddenCallout(){
  const el=document.getElementById('zwiftRiddenCallout');
  if(!el)return;
  const idx=zwiftRiddenIndex();
  const unmarked=ZWIFT_DATA.filter(r=>r.status!=='Complete'&&idx[r.id]);
  if(!unmarked.length){el.style.display='none';el.innerHTML='';return;}
  // The callout is about the whole catalogue, not the filtered view, so a route can
  // be named here and not appear in the list below. Each name carries its current
  // status, which is what explains the absence.
  const names=unmarked.slice(0,4)
    .map(r=>`${escapeHtml(r.route)} <span class="callout-status" style="color:${zwiftStatusColor(r.status)}">${escapeHtml(r.status)}</span>`)
    .join(' · ');
  el.style.display='flex';
  el.innerHTML=`<span class="ms">fact_check</span><div class="callout-body">
    <strong>${unmarked.length} route${unmarked.length===1?'':'s'} you appear to have ridden ${unmarked.length===1?'is':'are'} still not marked Complete.</strong><br>
    ${names}${unmarked.length>4?` · and ${unmarked.length-4} more`:''}<br>
    <span class="callout-note">Matched by route name against your virtual rides, across every status — open a route to set it. Some may be hidden by the filter above.</span></div>`;
}

function renderZwiftTable(){
  const scrollY=window.scrollY;
  const groups=getZwiftGroups();
  const riddenIdx=zwiftRiddenIndex();
  renderZwiftRiddenCallout();
  const totalShown=groups.reduce((n,g)=>n+g.routes.length,0);
  const totalComplete=ZWIFT_DATA.filter(r=>r.status==='Complete').length;
  const pct=ZWIFT_DATA.length?Math.round(totalComplete/ZWIFT_DATA.length*100):0;
  const searchEl=document.getElementById('zwiftSearch');
  if(searchEl)searchEl.placeholder=`${totalShown.toLocaleString('en-GB')} shown · ${ZWIFT_DATA.length.toLocaleString('en-GB')} routes · ${totalComplete} complete (${pct}%)`;

  document.getElementById('zwiftEmpty').style.display=ZWIFT_DATA.length?'none':(zwiftLoaded?'block':'none');

  document.getElementById('zwiftGroups').innerHTML=groups.map(g=>{
    const complete=g.routes.filter(r=>r.status==='Complete').length;
    const rowsHtml=g.routes.map(r=>{
      const open=zwiftEditingId===r.id;
      const stats=[r.distance_mi!=null?fmtDist(r.distance_mi)+' '+distUnit():null,r.elevation_ft!=null?fmtElv(r.elevation_ft):null].filter(Boolean).join(' · ');
      const catBadges=(r.maps||[]).filter(m=>ZWIFT_CATEGORY_TAGS.includes(m)&&m!==g.name).map(m=>
        `<span class="zwift-cat-badge" style="background:${mapDotColor(m)}1a;color:${mapDotColor(m)}">${ZWIFT_CATEGORY_LABEL[m]}</span>`
      ).join('');
      return`<div id="zwift-row-${escapeAttr(r.id)}">
        <div class="zwift-list-row" data-on-click="toggleZwiftEdit" data-args-click='${escapeAttr(JSON.stringify([r.id]))}'>
          <span class="zwift-dot" style="background:${zwiftStatusColor(r.status)}"></span>
          <div class="zwift-row-main">
            <span class="zwift-row-name">${r.route}</span>
            ${catBadges}
            ${riddenIdx[r.id]?`<span class="zwift-ridden" title="Matched ${riddenIdx[r.id].count} virtual ride${riddenIdx[r.id].count===1?'':'s'} by name · last ${fmtDate(riddenIdx[r.id].last)}"><span class="ms">check</span>Ridden ${riddenIdx[r.id].count}×</span>`:''}
            <span class="zwift-row-stats">${stats}</span>
          </div>
          <div class="zwift-row-right">
            <span class="zwift-row-status" style="color:${zwiftStatusColor(r.status)}">${r.status}</span>
            <span class="zwift-chevron${open?' open':''}">${ZWIFT_CHEVRON_SVG}</span>
          </div>
        </div>
        ${open?renderZwiftDetail(r):''}
      </div>`;
    }).join('');
    const groupOpen=zwiftGroupOpen[g.name]===true;
    return`<details class="zwift-group"${groupOpen?' open':''} data-on-toggle="onZwiftGroupToggle" data-args-toggle='${escapeAttr(JSON.stringify([g.name, "$el.open"]))}'>
      <summary style="background:${mapSoftBg(g.name)}"><span class="zwift-summary-left"><span class="zwift-map-dot" style="background:${mapDotColor(g.name)}"></span>${g.name}</span><span class="zwift-group-count">${complete}/${g.routes.length} complete</span></summary>
      ${rowsHtml}
    </details>`;
  }).join('');

  renderZwiftCalendar();
  window.scrollTo(0,scrollY);
}

function onZwiftGroupToggle(name,isOpen){
  zwiftGroupOpen[name]=isOpen;
}

function toggleAllZwiftGroups(open){
  getZwiftGroups().forEach(g=>zwiftGroupOpen[g.name]=open);
  document.querySelectorAll('.zwift-group').forEach(d=>d.open=open);
}

function getZwiftPlannedByDate(){
  const map={};
  ZWIFT_DATA.forEach(r=>{
    if(!r.planned_ride)return;
    (map[r.planned_ride]=map[r.planned_ride]||[]).push(r);
  });
  return map;
}

function stepZwiftCalMonth(dir){
  zwiftCalDate.setMonth(zwiftCalDate.getMonth()+dir);
  zwiftCalSelected=null;
  renderZwiftCalendar();
}

function selectZwiftCalDay(dateStr){
  zwiftCalSelected=zwiftCalSelected===dateStr?null:dateStr;
  renderZwiftCalendar();
}

function goToZwiftRoute(id){
  zwiftEditingId=id;
  renderZwiftTable();
  const el=document.getElementById('zwift-row-'+id);
  if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
}

function renderZwiftCalendar(){
  const el=document.getElementById('zwiftCalendar');
  if(!el)return;
  if(zwiftStatusFilter!=='Planned'){el.style.display='none';el.innerHTML='';return;}
  el.style.display='block';

  const planned=getZwiftPlannedByDate();
  const year=zwiftCalDate.getFullYear(),month=zwiftCalDate.getMonth();
  const firstDow=new Date(year,month,1).getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  const monthLabel=zwiftCalDate.toLocaleDateString('en-GB',{month:'long',year:'numeric'});

  const dowRow=['S','M','T','W','T','F','S'].map(d=>`<div class="zwift-cal-dow">${d}</div>`).join('');
  const blanks=Array.from({length:firstDow},()=>`<div class="zwift-cal-day empty"></div>`).join('');
  const days=Array.from({length:daysInMonth},(_,i)=>{
    const day=i+1;
    const dateStr=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const routes=planned[dateStr]||[];
    const has=routes.length>0;
    const sel=zwiftCalSelected===dateStr;
    return`<div class="zwift-cal-day${has?' has-routes':''}${sel?' selected':''}" ${has?`data-on-click="selectZwiftCalDay" data-args-click='${escapeAttr(JSON.stringify([dateStr]))}'`:''}>${day}${has?'<div class="zwift-cal-dot"></div>':''}</div>`;
  }).join('');

  const selRoutes=zwiftCalSelected?(planned[zwiftCalSelected]||[]):[];
  const detail=zwiftCalSelected?`<div class="zwift-cal-detail">
    <div style="font-weight:600;margin-bottom:4px">${fmtDate(zwiftCalSelected)}</div>
    ${selRoutes.map(r=>`<div class="zwift-cal-detail-item" data-on-click="goToZwiftRoute" data-args-click='${escapeAttr(JSON.stringify([r.id]))}'>
      <span>${r.route}</span><span style="color:var(--text-muted)">${(r.maps||[]).join(', ')}</span>
    </div>`).join('')}
  </div>`:'';

  el.innerHTML=`<div class="zwift-cal">
    <div class="zwift-cal-head">
      <span class="zwift-cal-title">${monthLabel}</span>
      <div class="zwift-cal-nav">
        <button class="page-btn" data-on-click="stepZwiftCalMonth" data-args-click='[-1]'>‹</button>
        <button class="page-btn" data-on-click="stepZwiftCalMonth" data-args-click='[1]'>›</button>
      </div>
    </div>
    <div class="zwift-cal-grid">${dowRow}${blanks}${days}</div>
    ${detail}
  </div>`;
}

function toggleZwiftEdit(id){
  zwiftEditingId=zwiftEditingId===id?null:id;
  renderZwiftTable();
}
function cancelZwiftEdit(){
  zwiftEditingId=null;
  renderZwiftTable();
}

function parseZwiftDirections(text){
  const idx=text.indexOf('Turn by Turn:');
  if(idx===-1)return{leadIn:text.replace(/^Getting Started:\s*/,'').trim(),turns:[],trailing:''};
  const leadIn=text.slice(0,idx).replace(/^Getting Started:\s*/,'').trim();
  const rest=text.slice(idx+'Turn by Turn:'.length);
  const turns=[];const trailing=[];
  rest.split('\n').forEach(line=>{
    const t=line.trim();
    if(!t)return;
    const m=t.match(/^(\d+)\.\s*(.+)$/);
    if(m)turns.push(m[2]);else trailing.push(t);
  });
  return{leadIn,turns,trailing:trailing.join(' ')};
}

function saveZwiftChecklists(){
  try{localStorage.setItem(ZWIFT_CHECKLIST_KEY,JSON.stringify(zwiftChecklists));}catch(e){}
}

function onZwiftTurnToggle(routeId,idx,checked,total){
  if(!zwiftChecklists[routeId])zwiftChecklists[routeId]={};
  if(checked)zwiftChecklists[routeId][idx]=true;
  else delete zwiftChecklists[routeId][idx];
  saveZwiftChecklists();
  const progressEl=document.getElementById('zwift-progress-'+routeId);
  if(progressEl)progressEl.textContent=Object.keys(zwiftChecklists[routeId]).length+'/'+total;
}

function resetZwiftChecklist(routeId,total){
  delete zwiftChecklists[routeId];
  saveZwiftChecklists();
  document.querySelectorAll(`.zwift-turn-check[data-route="${routeId}"]`).forEach(cb=>cb.checked=false);
  const progressEl=document.getElementById('zwift-progress-'+routeId);
  if(progressEl)progressEl.textContent='0/'+total;
}

function boldZwiftTurnDirection(text){
  const m=text.match(/^(\d+(?:\.\d+)?km:\s*)?(Straight\s*\([^)]*\)|Straight\s*\/\s*(?:Left|Right)\b|Straight\b|Left\b|Right\b|U-Turn\b)(.*)$/i);
  if(!m)return escapeHtml(text);
  const prefix=m[1]||'',dir=m[2],rest=m[3];
  return `${escapeHtml(prefix)}<strong>${escapeHtml(dir)}</strong>${escapeHtml(rest)}`;
}


// Route links come from Notion, so they are remote strings landing in an href.
// Escape the attribute and allow only http(s) — a javascript: or data: URL in a
// Notion URL property would otherwise run on click.
function zwiftLink(url,label){
  if(!url)return'';
  let u;
  try{u=new URL(String(url),location.href);}catch(e){return'';}
  if(u.protocol!=='http:'&&u.protocol!=='https:')return'';
  return`<a href="${escapeAttr(u.href)}" target="_blank" rel="noopener noreferrer" data-on-click="stopPropagation" data-args-click='["$event"]'>${escapeHtml(label)}</a>`;
}

function renderZwiftDetail(r){
  const links=[
    zwiftLink(r.link_zi,'Zwift Insider'),
    zwiftLink(r.link_strava,'Strava'),
    zwiftLink(r.link_zh,'ZwiftHacks'),
  ].filter(Boolean).join('');
  let directions='';
  if(r.directions){
    const parsed=parseZwiftDirections(r.directions);
    const checked=zwiftChecklists[r.id]||{};
    const doneCount=Object.keys(checked).length;
    const turnsHtml=parsed.turns.map((t,i)=>`<label class="zwift-turn-row">
      <input type="checkbox" class="zwift-turn-check" data-route="${escapeAttr(r.id)}" ${checked[i]?'checked':''} data-on-change="onZwiftTurnToggle" data-args-change='${escapeAttr(JSON.stringify([r.id, i, "$el.checked", parsed.turns.length]))}'>
      <span>${boldZwiftTurnDirection(t)}</span>
    </label>`).join('');
    directions=`<div class="zwift-directions">
      <div class="zwift-directions-title">
        Directions
        ${parsed.turns.length?`<span class="zwift-turn-progress" id="zwift-progress-${r.id}">${doneCount}/${parsed.turns.length}</span>`:''}
        ${parsed.turns.length?`<button class="zwift-reset-btn" type="button" data-on-click="resetZwiftChecklist" data-args-click='${escapeAttr(JSON.stringify([r.id, parsed.turns.length]))}'>Reset</button>`:''}
      </div>
      ${parsed.leadIn?`<div class="zwift-directions-leadin">${escapeHtml(parsed.leadIn)}</div>`:''}
      ${turnsHtml?`<div class="zwift-turn-list">${turnsHtml}</div>`:''}
      ${parsed.trailing?`<div class="zwift-directions-trailing">${escapeHtml(parsed.trailing)}</div>`:''}
    </div>`;
  }
  return`<div class="zwift-detail" data-on-click="stopPropagation" data-args-click='["$event"]'>
    <div class="zwift-edit-form">
      <label>Status<select id="ze-status-${r.id}" data-on-change="handleZwiftStatusChange" data-args-change='${escapeAttr(JSON.stringify([r.id, r.status]))}'>
        ${ZWIFT_STATUS_ORDER.map(s=>`<option value="${escapeAttr(s)}"${s===r.status?' selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select></label>
      <label>Date completed<input type="date" id="ze-date-${escapeAttr(r.id)}" value="${escapeAttr(r.date_completed||'')}"></label>
      <label>Time (HH:MM:SS)<input type="text" id="ze-time-${escapeAttr(r.id)}" placeholder="00:00:00" value="${escapeAttr(r.time||'')}"></label>
      <button class="page-btn" data-on-click="saveZwiftEdit" data-args-click='${escapeAttr(JSON.stringify([r.id]))}' id="ze-save-${r.id}">Save</button>
      <button class="page-btn" data-on-click="cancelZwiftEdit">Cancel</button>
      <div class="zwift-edit-error" id="ze-error-${r.id}"></div>
    </div>
    <table class="zwift-detail-info">
      <tr><td>Est. duration</td><td>${r.est_duration||'—'}</td></tr>
      <tr><td>Planned ride</td><td>${fmtDate(r.planned_ride)}</td></tr>
      <tr><td>In route list?</td><td>${r.in_route_list?'Yes':'No'}</td></tr>
      <tr><td>Links</td><td>${links||'—'}</td></tr>
    </table>
    ${directions}
  </div>`;
}

function todayLocalISO(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function handleZwiftStatusChange(id,originalStatus){
  const sel=document.getElementById('ze-status-'+id);
  if(sel&&sel.value==='Complete'&&originalStatus!=='Complete'){
    const dateInput=document.getElementById('ze-date-'+id);
    if(dateInput)dateInput.value=todayLocalISO();
  }
}

async function saveZwiftEdit(id){
  if(zwiftSaving)return;
  const errorEl=document.getElementById('ze-error-'+id);
  errorEl.textContent='';

  const status=document.getElementById('ze-status-'+id).value;
  const dateVal=document.getElementById('ze-date-'+id).value;
  const timeVal=document.getElementById('ze-time-'+id).value.trim();

  if(timeVal&&!/^\d{2}:\d{2}:\d{2}$/.test(timeVal)){
    errorEl.textContent='Time must be in HH:MM:SS format.';
    return;
  }

  zwiftSaving=true;
  const saveBtn=document.getElementById('ze-save-'+id);
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='Saving…';}

  try{
    const res=await fetch(`${ZWIFT_WORKER_BASE}/zwift-routes/${id}`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({status,date_completed:dateVal||null,time:timeVal||null}),
    });
    const json=await res.json();
    if(!res.ok||json.error){
      throw new Error(json.message||'Save failed');
    }
    const idx=ZWIFT_DATA.findIndex(r=>r.id===id);
    if(idx!==-1)ZWIFT_DATA[idx]=json.data;
    localStorage.setItem(ZWIFT_CACHE_KEY,JSON.stringify({data:ZWIFT_DATA,updatedAt:new Date().toISOString()}));
    zwiftEditingId=null;
    renderZwiftTable();
    const row=document.getElementById('zwift-row-'+id);
    if(row){row.classList.add('zwift-row-saved');setTimeout(()=>row.classList.remove('zwift-row-saved'),1000);}
  }catch(e){
    errorEl.textContent=e.message||'Could not save — try again.';
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent='Save';}
  }finally{
    // require-atomic-updates flags this because the assignment is in an async
    // function and the guard that reads it is at the top. It is a false positive
    // here: nothing between `if(zwiftSaving)return` and `zwiftSaving=true` awaits,
    // so no other call can interleave between the check and the set, and a second
    // save is turned away rather than racing this one.
    // eslint-disable-next-line require-atomic-updates
    zwiftSaving=false;
  }
}

/* ── EVENT DELEGATION ──
 * Every handler in the markup used to be an inline onclick. A hundred and one of
 * them, and each one is a small piece of JavaScript written inside an HTML
 * attribute — which is exactly what a Content-Security-Policy has to allow with
 * 'unsafe-inline' to let them run. 'unsafe-inline' is not a qualified permission;
 * it turns script-src off. So the policy at the bottom of this file could not exist
 * while these did.
 *
 * They are declarative now: an element names an action and its arguments, and one
 * listener per event type looks the name up in ACTIONS below. The lookup is the
 * point — a name that is not in that table does nothing at all, so markup can never
 * introduce behaviour, only ask for behaviour that already exists here. No eval, no
 * new Function, and nothing to allow in the policy.
 *
 *   <button data-on-click="setTab" data-args-click='["charts"]'>
 *
 * The event name is part of the attribute rather than a value beside it, because a
 * single element often wants two of them — a calendar cell opens its day on click
 * and previews it on mouseenter — and HTML keeps only the first of two attributes
 * with the same name. A `data-on="mouseenter" data-on="click"` pair silently loses
 * the click. Per-event attributes cannot collide.
 *
 * It also leaves `data-act` alone, which predates all of this and means an activity
 * id: the row handler further up reads it to open a modal.
 *
 * Arguments are JSON, with four tokens resolved at call time because some handlers
 * genuinely need the element or the event:
 *   "$el"        the element carrying the action
 *   "$event"     the event object
 *   "$el.value"  / "$el.checked" / "$el.open"   the usual form-control reads
 */
const ACTIONS = {};

// Registered rather than referenced, so the allowlist is written down in one place
// and a typo is a missing action rather than a silent global lookup.
function registerActions(map){
  Object.keys(map).forEach(k=>{ACTIONS[k]=map[k];});
}

function resolveActionArg(a,el,ev){
  if(typeof a!=='string')return a;
  switch(a){
    case'$el':        return el;
    case'$event':     return ev;
    case'$el.value':  return el.value;
    case'$el.checked':return el.checked;
    case'$el.open':   return el.open;
    default:          return a;
  }
}

// dataset keys are camelCase, so data-on-click reads back as dataset.onClick.
function datasetKey(prefix,type){ return prefix+type.charAt(0).toUpperCase()+type.slice(1); }

function runAction(el,ev,type){
  const name=el.dataset[datasetKey('on',type)];
  const fn=ACTIONS[name];
  if(!fn){
    // Loud on purpose. A missing action is a markup/table mismatch, and the old
    // inline version would at least have thrown into the console.
    console.error('No such action:',name,el);
    return;
  }
  let args=[];
  const raw=el.dataset[datasetKey('args',type)];
  if(raw){
    try{args=JSON.parse(raw);}
    catch(e){console.error('Bad action arguments on',el,e);return;}
  }
  fn.apply(null,args.map(a=>resolveActionArg(a,el,ev)));
}

// One listener per event type, on the document, so markup rendered later works
// without anything having to re-bind. `closest` because a click usually lands on a
// span inside the button that carries the action.
['click','input','change'].forEach(type=>{
  document.addEventListener(type,ev=>{
    const el=ev.target.closest&&ev.target.closest(`[data-on-${type}]`);
    if(el)runAction(el,ev,type);
  });
});

// These four do not bubble, so they are delegated in the capture phase instead —
// and without `closest`, since a non-bubbling event's target is the element itself.
['mouseenter','mouseleave','toggle','error'].forEach(type=>{
  document.addEventListener(type,ev=>{
    const el=ev.target;
    if(el&&el.dataset&&el.dataset[datasetKey('on',type)])runAction(el,ev,type);
  },true);
});

/* The allowlist. Every name the markup is permitted to ask for, and nothing else —
 * a name that is not here does nothing, so the markup can only request
 * behaviour that already exists in this file.
 *
 * Most are the function itself. The handful below it are the ones that were
 * compound expressions in an attribute, which is precisely the kind of thing that
 * should have been a named function all along.
 */
registerActions({
  // Scope and navigation
  setTab, setType, setYear, stepYear, setUnit, setTheme, sortLog, changePage,
  filterLog, setRecYear, toggleEarlyYears, goToLogSearch,
  // Panels and sheets
  openScopeSheet, closeScopeSheet, toggleSettings, closeSettings,
  closeGearModal, closeActivityModal, refreshData,
  // Rearranging
  startReorder, endReorder, resetLayout,
  // Chart controls
  setMixMeasure, setProjMeasure, setProjMix,
  // Calendars and detail
  showDashTooltip, hideDashTooltip, showDayDetail, showYearCalDay,
  // Map
  mapJumpHome, mapJumpTo, toggleReplay, stopReplay, setMapWhiteout,
  // Gear
  gearPhotoFailed,
  // Social
  onSocDormantToggle,
  // Zwift
  toggleZwiftEdit, cancelZwiftEdit, saveZwiftEdit, goToZwiftRoute,
  setZwiftStatusFilter, filterZwiftRoutes, toggleAllZwiftGroups, onZwiftGroupToggle,
  onZwiftTurnToggle, resetZwiftChecklist, handleZwiftStatusChange,
  selectZwiftCalDay, stepZwiftCalMonth,

  // ── The ones that were compound expressions in an attribute ──
  // A backdrop closes only when the click landed on the backdrop itself, not on the
  // dialog sitting on top of it.
  closeGearModalIfBackdrop:(ev,el)=>{if(ev.target===el)closeGearModal();},
  closeActivityModalIfBackdrop:(ev,el)=>{if(ev.target===el)closeActivityModal();},
  // An <a> that switches tab rather than following its href.
  setTabFromLink:(tab)=>{setTab(tab);return false;},
  showAllRecent:()=>{recentShowAll=true;renderSummary();},
  openGearFromActivity:(gear)=>{closeActivityModal();openGearModal(gear);},
  // A control inside a row that is itself clickable.
  stopPropagation:(ev)=>ev.stopPropagation(),
});

/* ── KEYBOARD ACCESS FOR THE CALENDARS ──
 * Both calendars are grids of divs with a click handler: a pointer could open any
 * of the 1,800 day cells and a keyboard could open none of them.
 *
 * The naive fix — tabindex="0" on every cell — is worse than the bug. It puts 1,800
 * stops between the calendar and whatever follows it, so anyone tabbing through the
 * page is trapped for the rest of the afternoon.
 *
 * This is the grid pattern instead: exactly ONE cell per calendar is in the tab
 * order, and the arrow keys move within it. Tab reaches the calendar, arrows walk
 * the days, Enter or Space opens one, and Tab again leaves. Home and End jump to the
 * ends of a row, PageUp/PageDown to the same weekday a week away.
 *
 * The roving cell is tracked per grid rather than globally, because the Heatmap tab
 * draws one grid per year and each should remember where you were in it.
 */
function dayCellLabel(ds,dd){
  const d=new Date(ds+'T12:00:00');
  const when=d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  if(!dd)return when+', nothing logged';
  const n=dd.count||(dd.acts?dd.acts.length:0);
  const dist=dd.dist!=null?`, ${fmtDist(dd.dist)} ${distUnit()}`:'';
  return n?`${when}, ${n} activit${n===1?'y':'ies'}${dist}`:when;
}

function dayCellsIn(grid){
  return[...grid.querySelectorAll('[data-day-tip]')].filter(c=>c.offsetParent!==null);
}

// Called after each calendar render: one cell per grid gets the tab stop back.
function armCalendarGrids(root){
  // One grid per calendar block: the year calendar on Charts, and on the Heatmap
  // tab the desktop strip, the mobile layout, and each prior year's disclosure.
  (root||document).querySelectorAll('.ycal-grid,.hm-layout-desktop,.hm-layout-mobile,.hm-prior').forEach(grid=>{
    if(!grid.hasAttribute('role'))grid.setAttribute('role','grid');
    const cells=dayCellsIn(grid);
    if(!cells.length)return;
    if(!cells.some(c=>c.tabIndex===0))cells[0].tabIndex=0;
  });
}

function moveDayFocus(cell,delta){
  const grid=cell.closest('[role="grid"]')||cell.parentElement;
  const cells=dayCellsIn(grid);
  const i=cells.indexOf(cell);
  if(i<0)return false;
  const j=Math.max(0,Math.min(cells.length-1,i+delta));
  if(j===i)return false;
  cells.forEach(c=>{c.tabIndex=-1;});
  cells[j].tabIndex=0;
  cells[j].focus();
  return true;
}

document.addEventListener('keydown',e=>{
  const cell=e.target&&e.target.closest&&e.target.closest('[data-day-tip]');
  if(!cell||cell.tabIndex<0)return;
  // A calendar row is a week, which is what makes up/down a sensible seven.
  const step={ArrowRight:1,ArrowLeft:-1,ArrowDown:7,ArrowUp:-7,PageDown:7,PageUp:-7}[e.key];
  if(step!==undefined){e.preventDefault();moveDayFocus(cell,step);return;}
  if(e.key==='Home'||e.key==='End'){
    e.preventDefault();
    const cells=dayCellsIn(cell.closest('[role="grid"]')||cell.parentElement);
    moveDayFocus(cell,(e.key==='Home'?0:cells.length-1)-cells.indexOf(cell));
    return;
  }
  if(e.key==='Enter'||e.key===' '){
    e.preventDefault();
    cell.click();
  }
});

function showDashTooltip(event,date){
  const el=document.getElementById('dashTooltip');
  // The tap that just closed this day also emits an emulated mouseenter, which
  // lands here and would open it straight back up. The pointerup handler leaves the
  // day's key behind to say "not this one, not this gesture".
  if(_touchPointer&&_dashSuppress===date)return;
  const acts=getFiltered().filter(a=>a.date===date);
  if(!acts.length)return;
  el.dataset.date=date;
  el.innerHTML=`<div style="font-weight:700;margin-bottom:4px;font-size:11px;opacity:.7">${fmtDate(date)}</div>`+
    acts.map(a=>`<div style="margin-top:3px">${typeEmoji(typeGroup(a.type))} <strong>${a.name||a.type}</strong><br><span style="opacity:.75">${a.dist_mi?fmtDist(a.dist_mi)+' '+distUnit():'—'}${a.hr?' · <span class="ms ms-fill" style="font-size:12px;color:#ef4444">favorite</span> '+Math.round(a.hr)+'bpm':''}</span></div>`).join('');
  el.style.display='block';
  const x=Math.min(event.clientX+14,window.innerWidth-280);
  const y=Math.max(event.clientY-10,10);
  el.style.left=x+'px';el.style.top=y+'px';
}
function hideDashTooltip(){
  const el=document.getElementById('dashTooltip');
  if(!el)return;
  el.style.display='none';
  // Cleared too, so a day that has just been closed is not mistaken for the one
  // still on screen the next time a tap lands on it.
  el.dataset.date='';
}

// What each tab is really showing, given the header controls. The year and sport
// filters read as global because they sit in the header on every tab, but several
// tabs ignore one or both — so rather than leave that to be discovered, every tab
// states its scope and flags any control above it that it is not honouring.
function scopeFor(tab){
  const y=periodLabel(activeYear);
  const t=activeType==='All'?'all sports':activeType.toLowerCase();
  const u=distUnit(),ignored=[];
  if(tab==='records'){
    if(activeYear!=='All')ignored.push('year');
    if(activeType!=='All')ignored.push('sport');
    return{text:`All time · all sports · ${u}`,ignored};
  }
  if(tab==='map'){
    if(activeYear!=='All')ignored.push('year');
    return{text:`All time · ${t}`,ignored};
  }
  if(tab==='heatmap')return{text:`${isYearScope(activeYear)?activeYear:'Latest year'} at top, earlier years below · ${t} · one shared colour scale`,ignored};
  // Charts only ever plots the last 24 months unless a single year is chosen, so
  // saying "all time" here would be the very thing this line exists to prevent.
  if(tab==='charts')return{text:`${activeYear==='All'?'Last 24 months':periodLabel(activeYear)} · ${t} · ${u} · year-over-year uses every year`,ignored};
  if(tab==='zwift')return{text:'From Notion · the year and sport filters do not apply here',ignored};
  if(tab==='log'&&logSearch)return{text:`${y} · ${t} · ${u} · matching “${logSearch}”`,ignored};
  return{text:`${y} · ${t} · ${u}`,ignored,plain:true};
}
function renderScope(){
  const el=document.getElementById('scopeLine');if(!el)return;
  const s=scopeFor(activeTab);
  // The header's scope band already states the year and the sport, and it is
  // the live control rather than an echo of it. This line only earns its 24px
  // when the tab is doing something the header cannot say: overriding a
  // filter, or framing what the view actually plots.
  if(s.plain&&!s.ignored.length){el.innerHTML='';el.style.display='none';return;}
  el.style.display='';
  el.innerHTML=`<span class="scope-badge">${escapeHtml(s.text)}</span>`+
    (s.ignored.length?`<span class="scope-warn"><span class="ms">info</span>This tab ignores the ${s.ignored.join(' and ')} filter${s.ignored.length>1?'s':''} above</span>`:'');
}

function renderAll(){
  // Every tab but Map and Zwift draws a canvas somewhere. Chart.js arrives on its
  // own schedule now, so re-enter once it lands rather than throwing halfway
  // through a render and leaving the tab half-painted. If it is never coming,
  // CHARTS_OK is false and we render everything else regardless.
  if(!window.Chart&&CHARTS_OK!==false){ensureCharts().then(renderAll);return;}
  safely('scope line',renderScope);
  // The tab renderers are wrapped too. A throw in one of them used to skip the
  // layout restore below it, which is what turns a broken chart into a tab whose
  // panels have also jumped back to their default order.
  const tabs={
    summary:renderSummary,charts:renderCharts,heatmap:renderHeatmap,records:renderRecords,
    mex:renderMex,social:renderSocial,gear:renderGear,log:renderLog,
    map:()=>renderMap(activeType==='All'?ALL_DATA:ALL_DATA.filter(a=>mapFilterMatches(a))),
    zwift:renderZwiftTable,
  };
  if(tabs[activeTab])safely(activeTab+' tab',tabs[activeTab]);
  // After the render, not before. Mex rebuilds its whole tab and several others
  // rebuild panels inside theirs, so an order applied once at boot would survive
  // until the first filter change and no longer.
  restoreLayout(activeTab);
  if(reorderOn&&reorderTab===activeTab)buildReorderControls();
}


function setUpdatedAt(isoString) {
  const text = formatUpdatedAt(isoString);
  const el = document.getElementById('lastUpdated');
  if (el) el.textContent = text;
  // Repeated beside the Refresh row, where it is the reason you would press it.
  const inMenu = document.getElementById('settingsUpdated');
  if (inMenu) inMenu.textContent = text.replace(/^Updated /, '');
}

const CACHE_KEY = 'fitness_dashboard_v1';

// Write the freshly pulled history to the device, so the copy the page falls back
// to when the network is gone is always the newest data that ever reached it.
//
// The write used to be one attempt in a try/catch. localStorage is a few MB per
// origin and a long history with a route polyline on every activity goes past it,
// so the attempt would throw QuotaExceededError, get logged to a console nobody has
// open, and leave whatever was cached months ago sitting there as "your offline
// data" — the exact opposite of a fallback that is always up to date.
//
// So it degrades instead of failing. Polylines are far the largest field and only
// the Map tab reads them, so they go first and the numbers — which every other tab
// is made of — survive. Each step is tried in turn until one fits.
function cacheActivities(updatedAt) {
  const envelope = (data, note) => ({
    data, updatedAt, hrZones: HR_ZONE_META, gearMeta: GEAR_META,
    // Read back on load so the page can say what it is showing rather than quietly
    // presenting a trimmed history as the whole of it.
    ...(note ? { partial: note } : {}),
  });
  const stripRoutes = (a) => { const { polylines, polyline, ...rest } = a; return rest; };
  const newest = (n) => ALL_DATA.slice(-n);

  const attempts = [
    () => envelope(ALL_DATA),
    // Routes for the recent past only — enough for the Map tab to be worth opening.
    () => envelope(
      ALL_DATA.map((a, i) => (i >= ALL_DATA.length - 300 ? a : stripRoutes(a))),
      'routes kept for the last 300 activities'),
    () => envelope(ALL_DATA.map(stripRoutes), 'routes not cached'),
    () => envelope(newest(2000).map(stripRoutes), 'newest 2,000 activities, no routes'),
    () => envelope(newest(500).map(stripRoutes), 'newest 500 activities, no routes'),
  ];

  for (const build of attempts) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(build()));
      return true;
    } catch (e) {
      // Anything that is not the quota is not going to be fixed by sending less.
      if (!isQuotaError(e)) { console.error('Could not cache activities locally:', e); return false; }
    }
  }
  // Nothing fit. Drop the old entry rather than leave a stale one pretending to be
  // the fallback: an offline page that says it has nothing is more use than one
  // showing last spring's totals as if they were current.
  try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* nothing further to try */ }
  console.error('Could not cache activities locally: too large for this device even trimmed.');
  return false;
}

// Browsers disagree on how they signal a full store: the name, the legacy code 22,
// and Firefox's own code 1014 all mean the same thing here.
function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError'
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || e.code === 22 || e.code === 1014);
}

// Set once, on the first render after data arrives — a later refresh must not
// yank you back to whatever the URL said when the page opened.
let _viewApplied=false;

function renderFromData() {
  buildYearStepper();
  buildTypeFilters();
  if(!_viewApplied){
    _viewApplied=true;
    const v=readView();
    // applyView renders the chosen tab itself, so nothing below needs repeating
    // for anything other than the always-on Summary and Records.
    unit=v.unit;
    document.querySelectorAll('.unit-opt').forEach(b=>b.classList.toggle('active',b.dataset.unit===unit));
    activeYear=v.year;activeType=v.type;
    buildYearStepper();buildTypeFilters();
    renderSummary();
    renderRecords();
    buildLocationPills();
    if(v.tab!=='summary')setTab(v.tab,null,true);
    else if(activeTab==='map')renderMap(activeType==='All'?ALL_DATA:ALL_DATA.filter(a=>mapFilterMatches(a)));
    // After setTab, not before, or activeTab is still 'summary' and the tab drops
    // out of the URL you just arrived on. replaceState rather than push: arriving
    // somewhere is not a navigation to undo.
    writeView(false);
    return;
  }
  renderSummary();
  renderRecords();
  buildLocationPills();
  if(activeTab==='map')renderMap(activeType==='All'?ALL_DATA:ALL_DATA.filter(a=>mapFilterMatches(a)));
}

// ── LOCATION PILLS ──
const LOC_GEO_CACHE = 'nominatim_v1';

// buildLocationPills() and buildMapJumpButtons() both need this, and
// renderFromData() runs once from local cache and again after the fresh
// fetch — without sharing one in-flight computation, those callers each
// start their own sequential Nominatim geocoding loop at the same time,
// and the concurrent bursts trip Nominatim's ~1req/s rate limit (which
// shows up in the browser as a CORS failure, since its error responses
// don't carry CORS headers). Reset only by a forced refresh.
let _locationGroupsPromise = null;
function getLocationGroups() {
  if (!_locationGroupsPromise) _locationGroupsPromise = computeLocationGroups();
  return _locationGroupsPromise;
}

async function computeLocationGroups() {
  const away = ALL_DATA.filter(a => a.near_home === false && a.lat && a.lng && typeGroup(a.type) !== 'Virtual');
  if (!away.length) return [];

  // Group by lat/lng rounded to 2dp (~1 km grid)
  const groups = {};
  away.forEach(a => {
    const key = `${(Math.round(a.lat * 100) / 100).toFixed(2)},${(Math.round(a.lng * 100) / 100).toFixed(2)}`;
    if (!groups[key]) groups[key] = { count: 0, pts: [] };
    groups[key].count++;
    groups[key].pts.push([a.lat, a.lng]);
  });

  // Load persisted geocoding cache
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(LOC_GEO_CACHE) || '{}'); } catch(_) {}

  const uncached = Object.entries(groups).filter(([k]) => !cache[k]);

  // Geocode one at a time — Nominatim allows 1 req/s
  for (const [key] of uncached) {
    const [lat, lng] = key.split(',').map(Number);
    try {
      const res  = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&zoom=8&format=json`,
        { headers: { 'User-Agent': 'FitnessTracker/1.0' } }
      );
      const data = await res.json();
      const addr = data.address || {};
      cache[key] = addr.county || addr.city || addr.town ||
                   addr.state_district || addr.state || addr.country ||
                   (data.display_name || '').split(',')[0] || 'Unknown';
    } catch(_) {
      cache[key] = 'Unknown';
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  if (uncached.length) {
    try { localStorage.setItem(LOC_GEO_CACHE, JSON.stringify(cache)); } catch(_) {}
  }

  // Merge groups that geocoded to the same name, keeping every point so we
  // can fit the map to that name's actual spread rather than guessing a zoom
  const byName = {};
  Object.entries(groups).forEach(([key, g]) => {
    const name = cache[key] || 'Unknown';
    if (!byName[name]) byName[name] = { count: 0, pts: [] };
    byName[name].count += g.count;
    byName[name].pts.push(...g.pts);
  });

  return Object.entries(byName).map(([name, v]) => {
    const lats = v.pts.map(p => p[0]), lngs = v.pts.map(p => p[1]);
    return {
      name,
      count: v.count,
      bounds: [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
    };
  }).sort((a, b) => b.count - a.count);
}

async function buildLocationPills() {
  const el = document.getElementById('locPills');
  if (!el) return;

  // Fall back gracefully if data pre-dates the near_home field
  const hasGpsData = ALL_DATA.some(a => a.near_home !== undefined);
  if (!hasGpsData) {
    el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Sync with Strava to load live locations.</span>';
    return;
  }

  const away = ALL_DATA.filter(a => a.near_home === false && a.lat && a.lng);
  if (!away.length) {
    el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">All activities are from home.</span>';
    return;
  }

  el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Loading locations…</span>';
  const groups = await getLocationGroups();

  const shown = groups.filter(g => g.count >= 5);
  const hiddenCount = groups.length - shown.length;

  let html = shown.map(g =>
    `<div class="loc-pill" style="cursor:pointer" tabindex="0" role="button" aria-label="${escapeAttr('Find '+g.name+' in the activity log')}" ${logSearchAttr(g.name)}>` +
    `<span class="ms ms-fill" style="font-size:13px;color:var(--accent)">location_on</span>` +
    ` ${g.name} <strong style="margin-left:4px;color:var(--text)">${g.count}</strong></div>`
  ).join('');

  if (hiddenCount > 0) {
    html += `<span style="font-size:11px;color:var(--text-muted);align-self:center;margin-left:4px">+${hiddenCount} location${hiddenCount > 1 ? 's' : ''} with fewer than 5 activities not shown</span>`;
  }

  el.innerHTML = html;
}

const API_BASE = 'https://activities-api.lk-ff7.workers.dev';

// The page is only "loaded" once something real has been painted — from cache or
// from the network, whichever arrives first. Until then the skeleton stays up.
function clearLoadingState(){document.body.classList.remove('is-loading');}

function showLoadError(msg,{inline}={}){
  const box=document.getElementById('appError');
  if(!box)return;
  document.getElementById('appErrorMsg').textContent=msg;
  box.classList.toggle('inline',!!inline);
  box.classList.add('show');
}
function hideLoadError(){
  const box=document.getElementById('appError');
  if(box)box.classList.remove('show');
}

// A 200 is not the same as a usable payload. The Worker can answer with a JSON
// error body, and an envelope whose `data` is missing used to sail straight past
// the try/catch below — ALL_DATA became undefined and the *next* render threw,
// outside any handler, leaving the page pinned on "Syncing…" with nothing said.
function normaliseEnvelope(json){
  if(Array.isArray(json))return{data:json,updatedAt:new Date().toISOString()};
  if(json&&Array.isArray(json.data))return json;
  const detail=json&&(json.error||json.message);
  throw new Error(detail?String(detail):'The activities service returned an unexpected response.');
}

async function loadData(forceRefresh = false) {
  if (forceRefresh) _locationGroupsPromise = null; // let a manual refresh re-derive location clusters

  let renderedFromCache = false;
  // Set when the device copy had to be trimmed to fit. Only worth saying out loud if
  // the network then fails and that copy is all there is.
  let cacheNote = null;

  // Render from cache immediately so the page isn't blank on first load
  if (!forceRefresh) {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed.data) && parsed.data.length) {
          ALL_DATA = parsed.data;
          _dataGen++;
          if (parsed.hrZones) HR_ZONE_META = parsed.hrZones;
          if (parsed.gearMeta) GEAR_META = parsed.gearMeta;
          if (parsed.partial) cacheNote = parsed.partial;
          setUpdatedAt(parsed.updatedAt);
          await ensureCharts();
          renderFromData();
          clearLoadingState();
          renderedFromCache = true;
          // Show that a background refresh is in progress
          const lu = document.getElementById('lastUpdated');
          if (lu) lu.textContent += ' · Syncing…';
        }
      }
    } catch(e) { /* bad cache, ignore */ }
  }

  const url = forceRefresh ? API_BASE + '/activities?refresh=true' : API_BASE + '/activities';

  let updatedAt;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The activities service answered ${res.status} ${res.statusText||''}`.trim() + '.');

    let json;
    try { json = await res.json(); }
    catch (e) { throw new Error('The activities service sent a response that was not valid JSON.'); }

    const envelope = normaliseEnvelope(json);
    ALL_DATA = envelope.data;
    _dataGen++;
    updatedAt = envelope.updatedAt || new Date().toISOString();
    // Absent on an envelope cached before the Worker started sending it.
    if (envelope.hrZones) HR_ZONE_META = envelope.hrZones;
    if (envelope.gearMeta) GEAR_META = envelope.gearMeta;
    setUpdatedAt(updatedAt);
  } catch (e) {
    console.error('Could not load activities from Strava Worker:', e);
    const detail = e && e.message ? e.message : 'The request failed.';
    if (ALL_DATA.length) {
      // Cached data is on screen and still worth reading — say the refresh failed
      // and leave it be, rather than replacing a working page with an error.
      const lu = document.getElementById('lastUpdated');
      if (lu) lu.textContent = lu.textContent.replace(' · Syncing…', ' · (offline)');
      showLoadError(detail + ' Showing the last data saved on this device'
        + (cacheNote ? ` (${cacheNote}).` : '.'), {inline:true});
    } else {
      showLoadError(detail);
    }
    clearLoadingState();
    return;
  }

  // Every successful pull is written to the device, so the copy the page falls back
  // to offline is always the newest data that has ever reached it.
  cacheActivities(updatedAt);

  // Rendering is the step that used to throw into the void. A failure here is a
  // bug in a renderer, not a network problem, so it gets its own message — and it
  // must not leave the skeleton shimmering forever either.
  try {
    await ensureCharts();
    hideLoadError();
    renderFromData();
  } catch (e) {
    console.error('Could not render the dashboard:', e);
    if (!renderedFromCache) showLoadError('The data loaded but the dashboard failed to draw it. ' + (e && e.message ? e.message : ''));
  } finally {
    clearLoadingState();
  }
}

async function refreshData() {
  const btn  = document.getElementById('refreshBtn');
  const retry = document.getElementById('appErrorRetry');
  const label = document.getElementById('lastUpdated');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (retry) retry.disabled = true;
  if (label) label.textContent = 'Refreshing…';
  const menuNote = document.getElementById('settingsUpdated');
  if (menuNote) menuNote.textContent = 'refreshing…';

  await loadData(true);

  if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  if (retry) retry.disabled = false;
}

// ── SERVICE WORKER ──
// Registered after load so its install fetches never compete with the first paint.
// An update is applied on the next visit rather than swapped in underneath you —
// hot-replacing a 350 KB page mid-session is how you lose a half-scrolled tab.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err =>
      console.error('Service worker registration failed:', err));
  });
}

// Sets the toggle's icon and label; the palette itself was stamped on <html> in
// the head, before first paint.
applyTheme(readTheme());

// Before the first render, so each panel is drawn where it belongs rather than
// being moved after it has already been painted somewhere else.
restoreAllLayouts();

loadData();
  
// ── MAP ──
let _map=null,_mapLayers=[];
const HOME_CENTER=[53.8362,-2.5964]; // Longridge, Preston, Lancashire, UK
const HOME_ZOOM=13;


let _tileLayer=null;

function initMap(){
  if(_map)return;
  _map=L.map('mapContainer',{preferCanvas:true,zoomControl:true});
  _tileLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom:19
  }).addTo(_map);
  _tileLayer.on('tileerror',e=>console.error('Map tile failed to load:',e.tile?.src,e.error));
}

// Slider fades the tiles toward the map's white background instead of
// layering something on top, so routes stand out more against a plainer map
function setMapWhiteout(pct){
  if(_tileLayer)_tileLayer.setOpacity(1-pct/100);
}

function renderMap(data){
  if(!document.getElementById('mapContainer'))return;
  // Leaflet is fetched on demand, so the first call here usually arrives before it
  // exists. Kick the load off and re-enter — every later call finds window.L and
  // runs straight through.
  if(!window.L){
    const empty=document.getElementById('mapEmpty');
    if(empty){empty.style.display='block';empty.textContent='Loading map…';}
    ensureLeaflet().then(()=>renderMap(data)).catch(err=>{
      console.error(err);
      if(empty){empty.style.display='block';empty.textContent='Could not load the map library. Check your connection and try again.';}
    });
    return;
  }
  initMap();
  _mapLayers.forEach(l=>_map.removeLayer(l));
  _mapLayers=[];

  const segsOf=a=>a.polylines||(a.polyline?[a.polyline]:[]); // polyline: pre-migration cache fallback
  const withRoute=data.filter(a=>segsOf(a).length);
  // near_home activities keep a (zone-centre-snapped) lat/lng even with no surviving
  // route segments — never plot those as a dot, or the marker gives the address away
  const dotOnly=data.filter(a=>!segsOf(a).length&&a.lat&&a.lng&&!a.near_home);
  const empty=document.getElementById('mapEmpty');
  const container=document.getElementById('mapContainer');

  // Deferred a frame: the first call decodes every polyline in the filter, and doing
  // that inline would hold up the map's own paint. Scheduled before the empty-state
  // return so the panel clears itself rather than keeping the last filter's numbers
  // on screen next to an empty map.
  requestAnimationFrame(()=>renderExplored(withRoute,segsOf));

  // Hide the whole object, toolbar included — hiding only the map container left an
  // empty 680px stage with a toolbar on top of it controlling nothing.
  const object=document.querySelector('.map-object');
  if(!withRoute.length&&!dotOnly.length){
    if(empty)empty.style.display='block';
    if(object)object.style.display='none';
    return;
  }
  if(empty)empty.style.display='none';
  if(object)object.style.display='';
  if(container)container.style.display='block';

  const renderer=L.canvas();

  // Routes
  withRoute.forEach(a=>{
    const col=groupColor(mapTypeGroup(a.type));
    segsOf(a).forEach(seg=>{
      const pts=decodePolylinePts(seg);
      if(pts.length<2)return;
      const line=L.polyline(pts,{renderer,color:col,weight:1.5,opacity:0.35});
      line.addTo(_map);
      _mapLayers.push(line);
    });
  });

  // Dot-only
  dotOnly.forEach(a=>{
    const col=groupColor(mapTypeGroup(a.type));
    const m=L.circleMarker([a.lat,a.lng],{renderer,radius:4,color:col,fillColor:col,fillOpacity:0.7,weight:1});
    m.addTo(_map);
    _mapLayers.push(m);
  });

  // Default view is always Longridge/Preston at a fixed close-in zoom rather
  // than fitting to every activity's bounds — trips abroad (Mallorca, Girona,
  // Calpe…) sit thousands of km from home and would otherwise drag the zoom
  // out to fit them all. Use the jump buttons to see those instead.
  // Wait for the tab's display:none->block change to be laid out before
  // measuring the container, otherwise invalidateSize sees a stale size.
  requestAnimationFrame(()=>{
    _map.invalidateSize();
    _map.setView(HOME_CENTER,HOME_ZOOM);
  });
  buildMapJumpButtons();
  buildReplayPicker(withRoute,segsOf);

  // Legend
  // On the map now rather than above it, and carrying a count per sport — the space
  // was free once it moved, so the legend may as well say how much of each there is.
  const legend=document.getElementById('mapLegend');
  if(legend){
    const counts={};
    data.forEach(a=>{const t=mapTypeGroup(a.type);counts[t]=(counts[t]||0)+1;});
    const types=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
    legend.innerHTML=types.length
      ? `<div class="map-legend-title">Sport</div>`+types.map(t=>
          `<div class="map-legend-row"><i style="background:${groupColor(t)}"></i>${t}<b>${counts[t].toLocaleString('en-GB')}</b></div>`
        ).join('')
      : '';
    legend.style.display=types.length?'':'none';
  }
}

// ── ROUTE REPLAY ──
// One route at a time, traced from start to finish with a marker at the head and
// the covered part drawn solid over the faded background layer. Fixed duration
// rather than real time: an eight-hour ride played at any honest speed is not a
// thing anybody watches.
const REPLAY_MS=9000;
const REPLAY_MAX=60;           // routes offered in the picker
let _replayPts=null,_replayLine=null,_replayDot=null,_replayRaf=null,_replayStart=0;
let _replayLookup={};

// Longest first — a 3-mile loop traced across a whole county is a dot moving in a
// corner, and the routes worth watching are the big ones.
// The picker used to offer the 60 longest routes, so it always opened on the same
// monster ride and there was no way to reach last Tuesday. It offers both now:
// Notable first, because that is what you would want to watch, then Recent, because
// that is what you would want to check. Everything here is computed from data already
// in the payload — nothing to configure and nothing extra to fetch.
let _replayCandidates=null;

// Set by renderExplored, which already walks every route in date order counting new
// cells. Recomputing that here would decode every polyline a second time.
let _exploreBestNew=null;

function buildReplayPicker(withRoute,segsOf){
  const sel=document.getElementById('replayPick'),grp=document.getElementById('replayGroup');
  if(!sel)return;
  stopReplay();

  // A route split into segments by a privacy zone is excluded: the marker would jump
  // the gap rather than trace the ride.
  const usable=withRoute.filter(a=>segsOf(a).length===1);
  _replayCandidates={list:usable,segs:segsOf};
  if(!usable.length){
    sel.innerHTML='<option value="">No routes in this filter</option>';
    sel.disabled=true;
    if(grp)grp.style.opacity='.55';
    _replayLookup={};
    setReplayStatus('');
    return;
  }
  sel.disabled=false;
  if(grp)grp.style.opacity='';

  const notable=[];
  const seen=new Set();
  // Each category takes the best route it can still have. One ride is often the
  // winner of several — your biggest climb may also be the furthest from home — and
  // simply skipping a category when its winner is taken quietly deleted the row. It
  // falls to the runner-up instead, so every category that has any candidate at all
  // contributes a line.
  const add=(kind,score,fig)=>{
    let pick=null,pickV=0;
    for(const a of usable){
      if(seen.has(a.id))continue;
      const v=score(a);
      if(v>0&&(!pick||v>pickV)){pick=a;pickV=v;}
    }
    if(!pick)return;
    seen.add(pick.id);
    notable.push({kind,act:pick,fig:fig(pick,pickV)});
  };

  // Order matters, because the first category to claim a ride keeps it. Rarest fact
  // first: a race is a thing that happened, "fastest" is a superlative any ride can
  // hold, so Fastest yields last rather than swallowing the race.
  add('Race',a=>isRace(a)?(new Date(a.date).getTime()||1):0,
    a=>fmtDist(a.dist_mi||0)+' '+distUnit()+' · '+a.date.slice(0,4));
  // A ranked list rather than one winner, so this category can fall through too.
  if(_exploreBestNew&&_exploreBestNew.length){
    const rank={};_exploreBestNew.forEach(e=>{rank[e.act.id]=e;});
    add('Most new ground',a=>rank[a.id]?rank[a.id].pct:0,(a,v)=>v+'% never ridden');
  }
  // 25 miles of floor, so a ride that merely started one town over is not "furthest".
  add('Furthest out',
    a=>(a.lat&&a.lng&&!a.near_home)?(milesFromHome(a.lat,a.lng)>25?milesFromHome(a.lat,a.lng):0):0,
    (a,v)=>fmtDist(v)+' '+distUnit()+' from home');
  add('Biggest climb',a=>a.elv||0,a=>fmtElv(a.elv));
  add('Longest',a=>a.dist_mi||0,a=>fmtDist(a.dist_mi)+' '+distUnit());
  // A distance floor, or the fastest route is a two-mile downhill sprint.
  add('Fastest',a=>(a.dist_mi>=10?a.speed_mph:0)||0,a=>fmtSpeed(a.speed_mph));

  const recent=usable.slice().sort((a,b)=>b.date.localeCompare(a.date))
    .filter(a=>!seen.has(a.id)).slice(0,8);

  const opt=(a,label)=>`<option value="${escapeAttr(a.id)}">${escapeHtml(label)}</option>`;
  sel.innerHTML=
    (notable.length?`<optgroup label="Notable">`+notable.map(n=>
      opt(n.act,`${n.kind} · ${n.fig} · ${n.act.name||n.act.type}`)).join('')+`</optgroup>`:'')+
    (recent.length?`<optgroup label="Recent">`+recent.map(a=>
      opt(a,`${fmtDate(a.date)} · ${fmtDist(a.dist_mi||0)} ${distUnit()} · ${a.name||a.type}`)).join('')+`</optgroup>`:'');

  _replayLookup={};
  usable.forEach(a=>{_replayLookup[a.id]={act:a,segs:segsOf};});
  setReplayStatus('');
}

// Called again once renderExplored has worked out which route covered the most new
// ground, so that row can join the Notable group without decoding anything twice.
function refreshReplayPicker(){
  if(!_replayCandidates)return;
  const sel=document.getElementById('replayPick');
  const keep=sel?sel.value:'';
  buildReplayPicker(_replayCandidates.list,_replayCandidates.segs);
  if(sel&&keep&&sel.querySelector(`option[value="${CSS.escape(keep)}"]`))sel.value=keep;
}

// The readout lives on the map and only while something is playing — an empty status
// line sitting under the toolbar was one more thing taking up space saying nothing.
function setReplayStatus(html){
  const el=document.getElementById('replayStatus');
  if(!el)return;
  if(!html){el.style.display='none';el.innerHTML='';return;}
  el.style.display='';
  el.innerHTML=html;
}

function stopReplay(){
  if(_replayRaf){cancelAnimationFrame(_replayRaf);_replayRaf=null;}
  if(_replayLine&&_map){_map.removeLayer(_replayLine);_replayLine=null;}
  if(_replayDot&&_map){_map.removeLayer(_replayDot);_replayDot=null;}
  _replayPts=null;
  setReplayBtn(false);
  setReplayStatus('');
}

function toggleReplay(){
  if(_replayRaf){stopReplay();return;}
  const sel=document.getElementById('replayPick');
  const entry=sel&&_replayLookup[sel.value];
  if(!entry||!_map)return;
  const a=entry.act;
  const pts=decodePolylinePts(entry.segs(a)[0]||'');
  if(pts.length<2){setReplayStatus('No usable route for this activity.');return;}

  _replayPts=pts;
  _map.flyToBounds(L.latLngBounds(pts),{padding:[50,50],maxZoom:14});
  const col=groupColor(mapTypeGroup(a.type));
  _replayLine=L.polyline([pts[0]],{color:col,weight:4,opacity:.95}).addTo(_map);
  _replayDot=L.circleMarker(pts[0],{radius:6,color:'#fff',weight:2,fillColor:col,fillOpacity:1}).addTo(_map);
  setReplayBtn(true);

  // Reduced motion gets the whole route drawn at once rather than no route at all.
  if(matchMedia('(prefers-reduced-motion:reduce)').matches){
    _replayLine.setLatLngs(pts);_replayDot.setLatLng(pts[pts.length-1]);
    setReplayBtn(false);
    setReplayStatus(replayReadout(a,1));
    return;
  }

  _replayStart=performance.now();
  const step=now=>{
    const t=Math.min(1,(now-_replayStart)/REPLAY_MS);
    const n=Math.max(1,Math.round(t*(pts.length-1)));
    _replayLine.setLatLngs(pts.slice(0,n+1));
    _replayDot.setLatLng(pts[n]);
    setReplayStatus(replayReadout(a,t));
    if(t<1){_replayRaf=requestAnimationFrame(step);return;}
    _replayRaf=null;
    setReplayBtn(false);
    setReplayStatus(replayReadout(a,1));
  };
  _replayRaf=requestAnimationFrame(step);
}

// The button carries an icon, so setting textContent on it wiped the icon out.
function setReplayBtn(playing){
  const b=document.getElementById('replayBtn');
  const i=document.getElementById('replayBtnIcon');
  const t=document.getElementById('replayBtnText');
  if(!b)return;
  b.classList.toggle('playing',!!playing);
  if(i)i.textContent=playing?'stop_circle':'play_arrow';
  if(t)t.textContent=playing?'Stop':'Replay';
}

function replayReadout(a,t){
  const done=t>=1;
  const covered=done?fmtDist(a.dist_mi||0)+' '+distUnit():`${fmtDist((a.dist_mi||0)*t)} of ${fmtDist(a.dist_mi||0)} ${distUnit()}`;
  const sub=[covered,a.elv?fmtElv(a.elv):null,fmtDate(a.date)].filter(Boolean).join(' \u00b7 ');
  return `<div style="min-width:0">
      <div class="map-readout-name">${escapeHtml(a.name||a.type)}</div>
      <div class="map-readout-sub">${sub}</div>
    </div>
    <div class="map-readout-pct">${done?fmtTime(a.mt):Math.round(t*100)+'%'}</div>`;
}

// ── GROUND COVERED ──
// Every route point is dropped into a fixed grid and the distinct cells counted.
// A cell is 0.003° of latitude — about 330 m — which is coarse enough that riding
// the same road on a different side of the white line is the same cell, and fine
// enough that the next valley over is a new one. Longitude is scaled by cos(lat)
// so cells stay roughly square at this latitude instead of stretching east-west.
const CELL_DEG=0.003;
const CELL_M=Math.round(CELL_DEG*69*1609);
const _exploreCache=new WeakMap();

function cellsOf(a,segsOf){
  let c=_exploreCache.get(a);
  if(c)return c;
  c=new Set();
  segsOf(a).forEach(seg=>{
    decodePolylinePts(seg).forEach(([lat,lng])=>{
      c.add(Math.round(lat/CELL_DEG)+','+Math.round(lng/(CELL_DEG/Math.max(.2,Math.cos(lat*Math.PI/180)))));
    });
  });
  _exploreCache.set(a,c);
  return c;
}

// Great-circle distance in miles, so "furthest from home" is a real distance
// rather than a degrees-apart number that means nothing at a glance.
function milesFromHome(lat,lng){
  const R=3958.8,toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat-HOME_CENTER[0]),dLng=toRad(lng-HOME_CENTER[1]);
  const h=Math.sin(dLat/2)**2+Math.cos(toRad(HOME_CENTER[0]))*Math.cos(toRad(lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}

function renderExplored(withRoute,segsOf){
  const statsEl=document.getElementById('exploreStats'),yearsEl=document.getElementById('exploreYears');
  const badgeEl=document.getElementById('exploreBadge'),subEl=document.getElementById('exploreSub');
  if(!statsEl||!yearsEl)return;
  if(!withRoute.length){
    statsEl.innerHTML='';
    yearsEl.innerHTML='<div class="chart-empty" style="height:80px">No GPS routes in this filter.</div>';
    if(badgeEl)badgeEl.textContent='';
    _exploreBestNew=null;
    refreshReplayPicker();
    return;
  }

  // Chronological, so "new" always means new relative to everything before it.
  const acts=[...withRoute].sort((a,b)=>a.date.localeCompare(b.date));
  const seen=new Set(),byYear={};
  let furthest=null,furthestMi=0;const bestNew=[];
  acts.forEach(a=>{
    const y=a.date.slice(0,4);
    if(!byYear[y])byYear[y]={total:0,fresh:0,acts:0,best:null,bestFresh:0};
    const cells=cellsOf(a,segsOf);
    let fresh=0;
    cells.forEach(k=>{if(!seen.has(k)){fresh++;seen.add(k);}});
    byYear[y].total+=cells.size;byYear[y].fresh+=fresh;byYear[y].acts++;
    if(fresh>byYear[y].bestFresh){byYear[y].bestFresh=fresh;byYear[y].best=a;}
    // Proportion, not raw count, so a short ride into genuinely new country beats a
    // long one that was mostly familiar. Handed to the replay picker afterwards.
    if(cells.size>=20){
      const pct=Math.round(fresh/cells.size*100);
      if(pct>=15)bestNew.push({act:a,pct});
    }
    if(a.lat&&a.lng&&!a.near_home){
      const mi=milesFromHome(a.lat,a.lng);
      if(mi>furthestMi){furthestMi=mi;furthest=a;}
    }
  });

  const years=Object.keys(byYear).sort().reverse();
  const latest=years[0],prev=years[1];
  const areaMi2=seen.size*Math.pow(CELL_DEG*69,2); // 1° of latitude ≈ 69 miles
  const pctNew=v=>v.total?Math.round(v.fresh/v.total*100):0;
  const bestAct=byYear[latest].best;
  const bestPct=bestAct?Math.round(byYear[latest].bestFresh/Math.max(1,cellsOf(bestAct,segsOf).size)*100):0;

  if(badgeEl)badgeEl.textContent=`${acts.length.toLocaleString('en-GB')} routes · ${years.length} year${years.length===1?'':'s'}`;
  if(subEl)subEl.textContent=`Each bar is a year, scaled by how much ground it covered. The solid part is ground you had never been over before. Squares are about ${CELL_M} m across.`;

  statsEl.innerHTML=`
    <div class="stat-card">
      <div class="stat-label">Ground covered</div>
      <div class="stat-value">${Math.round(areaMi2).toLocaleString('en-GB')}<span class="stat-unit">sq mi</span></div>
      <div class="stat-sub">${seen.size.toLocaleString('en-GB')} distinct ${CELL_M}m squares touched</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">New ground in ${latest}</div>
      <div class="stat-value">${pctNew(byYear[latest])}<span class="stat-unit">%</span></div>
      <div class="stat-sub">${prev?`${pctNew(byYear[prev])}% in ${prev}`:'First year with GPS routes'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Furthest from home</div>
      <div class="stat-value">${furthest?fmtDist(furthestMi):'—'}${furthest?`<span class="stat-unit">${distUnit()}</span>`:''}</div>
      <div class="stat-sub">${furthest?`${escapeHtml(furthest.name||'Untitled')} · ${fmtDate(furthest.date)}`:'No away-from-home routes in this filter'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Biggest discovery of ${latest}</div>
      <div class="stat-value">${bestPct}<span class="stat-unit">% new</span></div>
      <div class="stat-sub">${bestAct?`${escapeHtml(bestAct.name||'Untitled')} · ${fmtDate(bestAct.date)}`:'—'}</div>
    </div>`;

  // The picker's "Most new ground" row comes from this walk rather than repeating it.
  // Top five by proportion: a ranked list, so if the leader is already claimed by
  // another category the row falls to the next rather than disappearing.
  _exploreBestNew=bestNew.sort((x,y)=>y.pct-x.pct).slice(0,5);
  refreshReplayPicker();

  const maxTotal=Math.max(...years.map(y=>byYear[y].total),1);
  yearsEl.innerHTML=years.map(y=>{
    const v=byYear[y];
    const w=v.total/maxTotal*100,fw=v.total?v.fresh/v.total*100:0;
    return`<div class="explore-row">
      <div class="explore-year">${y}</div>
      <div class="explore-track"><div class="explore-bar" style="width:${Math.max(1,w).toFixed(1)}%"><span style="width:${fw.toFixed(1)}%"></span></div></div>
      <div class="explore-fig"><strong>${pctNew(v)}%</strong> new · ${v.acts.toLocaleString('en-GB')} route${v.acts===1?'':'s'}</div>
    </div>`;
  }).join('');
}

// Always-available jump pills regardless of whether they've been auto-discovered
// yet. Coordinates are approximate town/region centres, not exact addresses.

function mapJumpHome(){if(_map)_map.flyTo(HOME_CENTER,HOME_ZOOM);}
function mapJumpToBounds(bounds,maxZoom){if(_map)_map.flyToBounds(bounds,{padding:[40,40],maxZoom:maxZoom||13});}

const JUMP_LOCATIONS=[
  {name:'Chorley',    bounds:[[53.58,-2.77],[53.73,-2.50]], zoom:12},
  {name:'Girona',     bounds:[[41.88, 2.65],[42.08, 2.98]], zoom:13},
  {name:'Mallorca',   bounds:[[39.25, 2.30],[39.95, 3.50]], zoom:10},
  {name:'London',     bounds:[[51.28,-0.51],[51.69, 0.33]], zoom:11},
  {name:'California', bounds:[[32.50,-124.5],[42.00,-114.1]],zoom:8},
  {name:'France',     bounds:[[42.30,-4.80],[51.10, 8.20]], zoom:6},
  {name:'Denmark',    bounds:[[54.55, 8.07],[57.75,15.20]], zoom:7},
];

// Eight pills were a full row — and a wrapped second row below about 1150px — for
// something used occasionally. Home keeps its button because it is the one you press;
// the rest collapse into a single control.
function buildMapJumpButtons(){
  const el=document.getElementById('mapJumpSelect');
  if(!el)return;
  el.innerHTML='<option value="">Elsewhere…</option>'+
    JUMP_LOCATIONS.map((p,i)=>`<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
}

function mapJumpTo(i){
  const p=JUMP_LOCATIONS[+i];
  if(!p)return;
  mapJumpToBounds(p.bounds,p.zoom);
  // Reset to the prompt so picking the same place twice in a row still fires.
  const el=document.getElementById('mapJumpSelect');
  if(el)el.value='';
}
