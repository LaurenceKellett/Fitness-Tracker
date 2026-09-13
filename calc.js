/* calc.js — the dashboard's pure derivations and formatters.
 *
 * Everything here is a function of its arguments and the scope state declared at
 * the top, with no reference to the DOM, to fetch, or to Chart.js. That is the
 * whole point of the file: it is the part of the dashboard that can be asserted
 * on in a test runner, which for a 6,000-line single-file app is otherwise
 * nothing at all.
 *
 * Loaded as a classic script by index.html — these declarations share the global
 * lexical scope with the inline script that follows, so nothing there had to
 * change to keep using them. The module.exports at the bottom is what lets Vitest
 * require the same file; it is skipped in the browser, where `module` is undefined.
 *
 * If you add a function here, add a test for it in test/calc.test.js.
 */

/* ── SCOPE STATE ──
 * Unit, period and sport filter. Declared here rather than in index.html because
 * the formatters below read `unit` directly and a second declaration of the same
 * name in a later classic script is a SyntaxError, not a shadow. index.html
 * assigns to these as before.
 */
let unit='mi',activeYear='All',activeType='All',activeTab='summary';

const SOC_EMOJI=/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

function fmtDist(v){if(v==null)return'—';const d=unit==='mi'?v:v*1.60934;return parseFloat(d>=100?d.toFixed(0):d.toFixed(1)).toLocaleString('en-GB');}

function distUnit(){return unit;}

function fmtElv(ft){if(!ft&&ft!==0)return'—';if(unit==='km')return Math.round(ft*0.3048).toLocaleString('en-GB')+'m';return Math.round(ft).toLocaleString('en-GB')+'ft';}

function fmtElevUnit(){return unit==='km'?'m':'ft';}

function fmtElevVal(ft){return unit==='km'?ft*0.3048:ft;}

function fmtTime(s){if(!s)return'—';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>0?h.toLocaleString('en-GB')+'h '+String(m).padStart(2,'0')+'m':m+'m';}

function fmtSpeed(mph){if(!mph||mph<=0)return'—';const v=unit==='mi'?mph:mph*1.60934;return v.toFixed(1)+(unit==='mi'?' mph':' km/h');}

// Round to whole seconds FIRST, then split. Rounding the remainder on its own let
// 479.7 s/mi print as "7:60/mi" — a time that does not exist, and it was on screen
// for roughly one pace in fifty.
function fmtPace(s_per_mi){if(!s_per_mi||s_per_mi<=0||s_per_mi>3600)return'—';const raw=unit==='mi'?s_per_mi:s_per_mi/1.60934;const t=Math.round(raw);const m=Math.floor(t/60),sec=t%60;return m+':'+String(sec).padStart(2,'0')+'/'+(unit==='mi'?'mi':'km');}

function fmtDate(d){if(!d)return'—';const[y,m,dn]=d.split('-');return dn+'/'+m+'/'+y;}

function fmtNum(n){return n!=null?Math.round(n).toLocaleString('en-GB'):'—';}

function fmtCal(c){return c?c.toLocaleString('en-GB'):'—';}

// ── RECORDS ──
function fmtPRTime(s){if(!s)return'—';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:m+':'+String(sec).padStart(2,'0');}

function fmtHours(sec){
  if(sec<3600)return Math.round(sec/60)+'m';
  const h=sec/3600;
  return (h<10?h.toFixed(1):Math.round(h))+'h';
}

// "12,480" from 12480.4, in the app's locale. Chips are figures, not prose.
function chipNum(v,dp){return Number(dp?(+v).toFixed(dp):Math.round(v)).toLocaleString('en-GB');}

function artFor(n){return /^(8|11|18)(\D|$)/.test(String(n))?'an':'a';}

function escapeAttr(s){return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Swim means swimming. Kayaking used to be folded in here on the grounds that it
// happens in water, and the Records tab then reported a paddled distance as a
// swimming best — 5km "swims" nobody swam. Being on the water and being in it are
// different sports with different speeds, and nothing downstream can tell them
// apart once they share a group. Strava has one `Swim` type covering pool, indoor
// and open water; the boats (Kayaking, Canoeing, Rowing, StandUpPaddling, Surfing,
// Kitesurf, Windsurf, Sail) are craft you sit on and go to Other with the rest.
function typeGroup(t){
  if(t==='VirtualRide')return'Virtual';
  if(['Ride','EBikeRide','Velomobile'].includes(t))return'Ride';
  if(['Run','TrailRun'].includes(t))return'Run';
  if(t==='Walk')return'Walk';
  if(t==='Swim')return'Swim';
  return'Other';
}

// Map tab only: Ride folds in Virtual, everything not Ride/Walk/Run/Swim is Other
function mapTypeGroup(t){
  if(t==='Ride'||t==='VirtualRide')return'Ride';
  if(t==='Walk')return'Walk';
  if(t==='Run')return'Run';
  if(t==='Swim')return'Swim';
  return'Other';
}

// The Map used to match the raw Strava type, so choosing Ride silently excluded
// VirtualRide and EBikeRide while every other tab folded them in.
// Does this activity pass the header's sport filter? The rule — All matches
// everything, Ride folds Virtual in with it, anything else is exact — was written
// out by hand in three places, which is two too many for something every tab
// depends on agreeing about.
function typeMatches(a){
  if(activeType==='All')return true;
  const g=typeGroup(a.type);
  if(activeType==='Ride')return g==='Ride'||g==='Virtual';
  return g===activeType;
}

function isFootSport(g){return g==='Run'||g==='Walk';}

// Strava's workout_type: 1 is a race for runs, 11 is a race for rides.
function isRace(a){return a.wtype===1||a.wtype===11;}

// ── DAY OF YEAR ──
// The unit that makes a part-finished year comparable with a finished one. A
// year-to-date total held up against a full previous year is not a comparison,
// it is a subtraction with nine months missing from one side.
function dayOfYear(dateStr){
  const[y,m,d]=dateStr.split('-').map(Number);
  return Math.round((Date.UTC(y,m-1,d)-Date.UTC(y,0,1))/86400000)+1;
}

function daysBetween(d1,d2){return Math.round((new Date(d2)-new Date(d1))/86400000)+1;}

// Enumerate every month from first to last inclusive, including the empty ones —
// a rolling total that skipped a month with no activities would quietly shorten
// its own window and overstate the result.
function monthsBetween(first,last){
  const out=[];let [y,m]=first.split('-').map(Number);
  const [ly,lm]=last.split('-').map(Number);
  while(y<ly||(y===ly&&m<=lm)){out.push(y+'-'+String(m).padStart(2,'0'));m++;if(m>12){m=1;y++;}}
  return out;
}

function monthLabel(m){const[y,mo]=m.split('-');return new Date(y,mo-1).toLocaleDateString('en-GB',{month:'short',year:'2-digit'});}

// ── ROUTE SHAPE ──
// Loop, out-and-back, or point-to-point, read off the polyline the map already
// decodes. No new field is needed: end_latlng would only tell you whether the
// finish is near the start, which cannot separate a loop from an out-and-back —
// both return to where they began. The retrace test below can.
function haversineMi(a,b){
  const R=3958.8,toRad=d=>d*Math.PI/180;
  const dLat=toRad(b[0]-a[0]),dLng=toRad(b[1]-a[1]);
  const s1=Math.sin(dLat/2),s2=Math.sin(dLng/2);
  const h=s1*s1+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*s2*s2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}

function decodePolylinePts(str){
  let i=0,lat=0,lng=0;const pts=[];
  while(i<str.length){
    let b,shift=0,val=0;
    do{b=str.charCodeAt(i++)-63;val|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20);
    lat+=(val&1)?~(val>>1):(val>>1);shift=val=0;
    do{b=str.charCodeAt(i++)-63;val|=(b&0x1f)<<shift;shift+=5;}while(b>=0x20);
    lng+=(val&1)?~(val>>1):(val>>1);
    pts.push([lat/1e5,lng/1e5]);
  }
  return pts;
}

// GEAR_IMAGES is hand-keyed on the Strava nickname, so any rename, case change or stray
// punctuation used to drop the photo silently. Match on a normalised key instead.
function gearKey(s){return String(s).toLowerCase().replace(/[^a-z0-9]/g,'');}

// The filename a photo for this item should have. Adding a picture used to mean
// editing the GEAR_IMAGES map above as well as dropping the file in; now the
// file alone is enough, because an unlisted item is guessed at by name and the
// existing onerror handler quietly swaps in the sport icon when the guess is
// wrong. The map stays for the cases a slug cannot reach — "Eddy Merckx" and
// "Merckx EMX-3" being one bike with one photo.
function gearSlug(name){
  return String(name||'').toLowerCase()
    .replace(/[''’]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'');
}

function socCanon(name){
  return String(name||'')
    .replace(SOC_EMOJI,' ')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/['’`.]/g,'')
    .replace(/[^A-Za-z0-9 ]+/g,' ')
    .trim().replace(/\s+/g,' ')
    .toLowerCase();
}

function socInitials(name){
  return String(name).trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
}

function extractPartners(name){
  if(!name)return[];
  const m=name.match(/\bw\/\s*(.+)/i);
  if(!m)return[];
  return m[1].trim().split(/,\s*|\s+&\s+|\s+and\s+/i).map(p=>p.trim().replace(/\s*[-–—#].*/,'')).filter(p=>p.length>1&&p.length<35);
}

function formatUpdatedAt(isoString) {
  if (!isoString) return '';
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60)  return 'Updated just now';
  if (diff < 3600) return `Updated ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `Updated ${Math.floor(diff / 3600)}h ago`;
  return `Updated ${Math.floor(diff / 86400)}d ago`;
}

// Longest run of consecutive active days, and whether it is the one you are on.
function recLongestStreak(acts){
  const days=[...new Set(acts.map(a=>a.date))].sort();
  if(!days.length)return null;
  let bestLen=0,bestTo=null,len=0,prev=null,startOf={};
  let curStart=null;
  days.forEach(d=>{
    if(prev&&(new Date(d)-new Date(prev))/86400000===1)len++;
    else{len=1;curStart=d;}
    if(len>bestLen){bestLen=len;bestTo=d;startOf[d]=curStart;}
    prev=d;
  });
  if(!bestTo)return null;
  const last=days[days.length-1];
  const daysSinceEnd=Math.floor((new Date()-new Date(last+'T12:00:00'))/86400000);
  return{len:bestLen,from:startOf[bestTo],to:bestTo,current:bestTo===last&&daysSinceEnd<=1};
}

// Rounded DOWN, never to nearest: a 14.7 run fills 14, not 15. One activity fills one
// bucket, so a second 12-unit ride adds nothing.
function mexBuckets(acts){
  const b=new Map();
  acts.forEach(a=>{
    const d=actDistIn(a);
    if(!(d>=1))return;
    const n=Math.floor(d),g=typeGroup(a.type);
    const cur=b.get(n)||{counts:{}};
    cur.counts[g]=(cur.counts[g]||0)+1;
    b.set(n,cur);
  });
  return b;
}

function mexOf(buckets){let n=1;while(buckets.has(n))n++;return n-1;}

function actDistIn(a){
  if(unit==='mi')return a.dist_mi||0;
  return a.dist_km!=null?a.dist_km:(a.dist_mi||0)*1.60934;
}

// Distance in the displayed unit, summed. Every chart below works in whatever the
// header is set to rather than converting at the last moment and rounding twice.
function distIn(a){return unit==='mi'?(a.dist_mi||0):(a.dist_mi||0)*1.60934;}

/* Walks back from today until it finds a day with nothing logged.
 *
 * This replaces an inline loop that carried a `if(k>400)break` guard, which was
 * not a safety net but a ceiling: a streak longer than 401 days reported exactly
 * 401, every time, while the longest-streak figure beside it — which has no such
 * guard — happily reported the true length. Two algorithms, one answer each, and
 * the wrong one was the headline.
 *
 * There is no bound here and none is needed: the set of trained days is finite, so
 * the walk always reaches a day that is missing from it and stops.
 */
function recCurrentStreak(acts,today){
  const days=new Set((acts||[]).map(a=>a.date));
  if(!days.size)return 0;
  const d=new Date((today||todayISO())+'T00:00:00Z');
  let cur=0;
  for(let k=0;;k++){
    const iso=d.toISOString().slice(0,10);
    if(days.has(iso))cur++;
    // Today not being logged yet is not a broken streak, so the count may start
    // at yesterday. Any earlier gap ends it.
    else if(k>0)break;
    d.setUTCDate(d.getUTCDate()-1);
  }
  return cur;
}

/* ── SCOPE PERIODS ──
 * The period control used to offer exactly two things: one calendar year, or all
 * time. For training, the calendar year is usually the wrong window — nothing about
 * your form resets on January 1st — so three rolling windows sit alongside the
 * years. They are tokens in the same slot as the year, which is what keeps the URL,
 * the saved view and every consumer on one concept rather than two.
 *
 * `todayISO` is deliberately local, not UTC: "the last 30 days" has to end on the
 * day you think it is, and after 1am BST those two disagree.
 */
const ROLLING_PERIODS={
  '30d':{days:30,label:'Last 30 days',short:'30d'},
  '90d':{days:90,label:'Last 90 days',short:'90d'},
  '12m':{days:365,label:'Last 12 months',short:'12m'},
};
const ROLLING_ORDER=['30d','90d','12m'];

function todayISO(){
  const d=new Date();
  return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}
function isYearScope(v){return /^\d{4}$/.test(String(v==null?activeYear:v));}
function isRollingScope(v){return ROLLING_ORDER.indexOf(String(v==null?activeYear:v))!==-1;}

// Inclusive of today, so "30 days" spans today and the 29 before it.
function periodStart(scope,today){
  const p=ROLLING_PERIODS[scope];
  if(!p)return null;
  const d=new Date((today||todayISO())+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()-(p.days-1));
  return d.toISOString().slice(0,10);
}
function scopeIncludes(dateStr,scope,today){
  if(!dateStr)return false;
  const sc=scope==null?activeYear:scope;
  if(sc==='All')return true;
  if(isYearScope(sc))return String(dateStr).slice(0,4)===String(sc);
  const t=today||todayISO();
  const from=periodStart(sc,t);
  if(!from)return true;               // an unknown token must not hide everything
  const d=String(dateStr).slice(0,10);
  return d>=from&&d<=t;
}
function periodLabel(scope){
  const sc=scope==null?activeYear:scope;
  if(sc==='All')return'All time';
  if(ROLLING_PERIODS[sc])return ROLLING_PERIODS[sc].label;
  return String(sc);
}
// Reads as a sentence fragment after a figure: "142 mi in 2026" / "…in the last 30 days".
function periodPhrase(scope){
  const sc=scope==null?activeYear:scope;
  if(ROLLING_PERIODS[sc])return'in the '+ROLLING_PERIODS[sc].label.toLowerCase();
  return'in '+String(sc);
}
function isValidScope(v){return v==='All'||isYearScope(v)||isRollingScope(v);}

/* ── ROLLING WEEKLY SERIES ──
 * The shape behind both hero charts: for every day in the window, the total over
 * the preceding 7 days and the preceding 28 days put on the same weekly scale.
 *
 * `pick` decides what is being totalled, and returns it in its final unit — hours
 * for training load, miles or kilometres for distance. Keeping the conversion in
 * the caller is what lets one function serve both without knowing about either.
 *
 * Days before the window still count towards a 28-day average that reaches back
 * over its edge, so the first plotted point is a real average rather than a ramp
 * up from zero. Only the plotting starts at the window.
 *
 * Dates are anchored at local noon and stepped in whole days. Midnight would drift
 * across a DST boundary and produce a repeated or skipped day in the series.
 *
 * The 28-day line is WEIGHTED (see CHRONIC_WEIGHTS). A flat 28-day average is a
 * box filter, and a box filter is the worst-behaved smoother there is: every day
 * enters the window at full weight and leaves it at full weight 28 days later. One
 * long ride therefore steps the line up the day you ride it, holds it flat for four
 * weeks, and steps it down again on a day you may not have trained at all — a jolt
 * created by the filter rather than by anything that happened. Tapering the weights
 * to almost nothing at both ends removes both edges.
 */
/* Weights for the 28-day line: a raised cosine (Hann), heaviest in the middle of
 * the window and tapering to almost nothing at both ends.
 *
 * Why this shape, having measured the alternatives on a year of realistic data
 * (roughness = mean day-to-day change, turns = direction changes, step = worst
 * single-day move; all on the same series, lower is smoother):
 *
 *   flat 28 days (what this replaced)   roughness 0.358   turns 138   step 1.98
 *   exponential decay, 28-day constant            0.514   turns 174   step —
 *   triangular, newest day heaviest               0.511   turns 174   step 3.21
 *   raised cosine, 28 days                        0.182   turns  25   step 0.76
 *
 * The two obvious candidates are both WORSE than the flat average, which is the
 * opposite of what you would guess. Exponential decay is the textbook answer for
 * training load and it decays beautifully — but it reacts to each new day with a
 * fixed share of that day's total, so a five-hour ride jolts it harder than the
 * flat average does. Same for any weighting that puts the most weight on the
 * newest day. Smoothness comes from tapering at BOTH ends, not one.
 *
 * The centre of mass is 13.5 days back — identical to the flat average — so this
 * is not a slower line, just a cleaner one. Across the same year the two differ in
 * mean by 0.02 h/wk, which is why the figures under the chart did not move.
 */
const CHRONIC_DAYS=28;
const CHRONIC_WEIGHTS=Array.from({length:CHRONIC_DAYS},(_,k)=>
  0.5-0.5*Math.cos(2*Math.PI*(k+1)/(CHRONIC_DAYS+1)));
const CHRONIC_WEIGHT_SUM=CHRONIC_WEIGHTS.reduce((s,v)=>s+v,0);

function rollingWeekly(acts,pick,opts){
  const o=opts||{};
  const today=o.today||todayISO();
  const scope=o.scope===undefined?activeYear:o.scope;

  const byDay={};
  (acts||[]).forEach(a=>{byDay[a.date]=(byDay[a.date]||0)+(pick(a)||0);});

  // The window ends today for an open-ended scope, or on the last day of the year
  // being looked at — showing "the last 365 days" of 2019 would end the line on a
  // date that has not happened in that year's terms.
  const end=isYearScope(scope)
    ? (String(scope)<today.slice(0,4)?scope+'-12-31':today)
    : today;
  // A rolling scope plots its own length plus the 28-day base it is measured
  // against, so the first point still has a full base behind it.
  const span=isYearScope(scope)?370
    :(isRollingScope(scope)?ROLLING_PERIODS[scope].days+28:365);

  const endMs=new Date(end+'T12:00:00').getTime();
  const startMs=endMs-(span-1)*86400000;
  const dayAt=ms=>{
    const d=new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const sumBack=(ms,days)=>{
    let t=0;
    for(let k=0;k<days;k++)t+=byDay[dayAt(ms-k*86400000)]||0;
    return t;
  };
  // Weighted mean of the same 28 days, back on a weekly scale. Written as a mean
  // times seven rather than a sum over four so the weights can be anything: with
  // CHRONIC_WEIGHTS all ones this is exactly the flat average it replaces.
  const weightedBack=ms=>{
    let t=0;
    for(let k=0;k<CHRONIC_DAYS;k++)t+=(byDay[dayAt(ms-k*86400000)]||0)*CHRONIC_WEIGHTS[k];
    return t/CHRONIC_WEIGHT_SUM*7;
  };

  const labels=[],acute=[],chronic=[];
  for(let ms=startMs;ms<=endMs;ms+=86400000){
    labels.push(dayAt(ms));
    // The 7-day line is left as a plain total. It is the "what have I just done"
    // line and it is supposed to react; smoothing both would leave nothing to read
    // the smooth one against.
    acute.push(+sumBack(ms,7).toFixed(2));
    chronic.push(+weightedBack(ms).toFixed(2));
  }

  const dates=Object.keys(byDay);
  return{
    labels,acute,chronic,end,span,
    hasData:dates.some(d=>d>=labels[0]&&d<=end),
    latest:{acute:acute[acute.length-1]||0,chronic:chronic[chronic.length-1]||0},
    peak:acute.length?Math.max.apply(null,acute):0,
  };
}

// Shared by both hero figures, so "steady" means the same thing in hours and miles.
const RATIO_BANDS=[
  {over:1.5,tone:'danger', word:'stepping up hard'},
  {over:1.3,tone:'warn',   word:'building'},
  {under:0.6,tone:'warn',  word:'backing off'},
  {under:0.8,tone:'warn',  word:'easing off'},
  {tone:'good',            word:'steady'},
];
function ratioBand(ratio){
  for(const b of RATIO_BANDS){
    if(b.over!==undefined){if(ratio>b.over)return b;continue;}
    if(b.under!==undefined){if(ratio<b.under)return b;continue;}
    return b;
  }
  return RATIO_BANDS[RATIO_BANDS.length-1];
}

/* ── TEST HOOKS ──
 * Browser-invisible: `module` is undefined in a classic script, so this whole
 * block is skipped there. In Node it exposes the functions plus a setter for the
 * scope state, which the browser mutates directly through the shared global
 * lexical scope and a test cannot.
 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fmtDist,distUnit,fmtElv,fmtElevUnit,fmtElevVal,fmtTime,fmtSpeed,fmtPace,fmtDate,fmtNum,
    fmtCal,fmtPRTime,fmtHours,chipNum,artFor,escapeAttr,escapeHtml,typeGroup,mapTypeGroup,
    typeMatches,isFootSport,isRace,dayOfYear,daysBetween,monthsBetween,monthLabel,haversineMi,
    decodePolylinePts,gearKey,gearSlug,socCanon,socInitials,extractPartners,formatUpdatedAt,
    recLongestStreak,recCurrentStreak,mexBuckets,mexOf,actDistIn,distIn,
    ROLLING_PERIODS,ROLLING_ORDER,todayISO,isYearScope,isRollingScope,periodStart,
    scopeIncludes,periodLabel,periodPhrase,isValidScope,rollingWeekly,ratioBand,RATIO_BANDS,
    CHRONIC_DAYS,CHRONIC_WEIGHTS,
    setScope(s){
      if(s.unit!==undefined)unit=s.unit;
      if(s.activeYear!==undefined)activeYear=s.activeYear;
      if(s.activeType!==undefined)activeType=s.activeType;
      if(s.activeTab!==undefined)activeTab=s.activeTab;
    },
    getScope(){return{unit,activeYear,activeType,activeTab};}
  };
}
