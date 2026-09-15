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

// How long a thing was in service, in calendar years and months. Calendar rather
// than averaged (365.25 days, 30.44 days): "first worn in March, last worn in
// September" is seven months to anyone counting on their fingers, and a figure
// that disagrees with the two dates printed either side of it reads as a bug
// rather than as a rounding convention.
//
// Note this measures first logged use to last logged use — the only span the
// activity data actually supports. It is not purchase to retirement: Strava's
// gear record carries neither date.
function fmtServiceSpan(first,last){
  if(!first||!last)return'\u2014';
  const[y1,m1,d1]=first.split('-').map(Number);
  const[y2,m2,d2]=last.split('-').map(Number);
  let months=(y2-y1)*12+(m2-m1);
  // Not a whole month until the day of the month comes round again.
  if(d2<d1)months--;
  if(months<0)return'\u2014';
  // Under a month there is nothing to round to, so say it in days. daysBetween
  // counts inclusively, so a thing used once reads "1d" rather than "0d".
  if(months===0)return daysBetween(first,last)+'d';
  const y=Math.floor(months/12),m=months%12;
  if(!y)return m+'m';
  return m?`${y}y ${m}m`:`${y}y`;
}

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

/* ── ZWIFT ROUTE TIME ESTIMATE ──
 *
 * Every completed route carries the time it actually took, so the outstanding ones
 * do not need a guess from first principles — they need the same rider's own history
 * fitted and extrapolated.
 *
 * The model is deliberately the simplest thing that respects the physics:
 *
 *     seconds = a x distance_mi + b x elevation_ft
 *
 * Two coefficients, no intercept, fitted by ordinary least squares. No intercept
 * because a route of no length takes no time, and letting the line float gave a
 * meaningless positive constant that made every short segment look slow.
 *
 * `a` is seconds per flat mile (3600/a is a speed you can sanity-check) and `b` is
 * the seconds each foot of climbing adds on top. Both are interpretable, which
 * matters more here than squeezing out the last of the variance: if the fit ever
 * reports 40 mph or a negative climbing cost, something is wrong with the data and
 * the numbers say so out loud.
 *
 * Fitted on 313 completed routes this reads ~24.8 mph on the flat and ~7.3 minutes
 * per 1000 ft climbed, R2 0.984, typical error under six minutes.
 *
 * WHY THE SPEED FILTER: the logged times are hand-entered and some are impossible —
 * a 19.8-mile route recorded as 60 seconds, a 6.5-mile one as 44. Three such rows
 * dragged the fitted flat speed up and the climbing cost with it. Anything implying
 * an average outside 4-40 mph is refused a vote; it is not a real ride time and the
 * fit is better without it.
 */
const ZW_MIN_MPH=4, ZW_MAX_MPH=40, ZW_MIN_FIT=8;

// A completed route only informs the fit if it has all three numbers and the time it
// claims is one a person could actually have ridden.
function zwiftFitRows(routes){
  return (routes||[]).filter(r=>{
    const d=r.distance_mi,e=r.elevation_ft,t=r.time_sec;
    if(!(d>0)||!(t>0)||e==null||!isFinite(e))return false;
    const mph=d/(t/3600);
    return mph>=ZW_MIN_MPH&&mph<=ZW_MAX_MPH;
  });
}

/* Least squares through the origin. Returns null when there is not enough to fit,
 * so a caller shows nothing rather than a confident number built on four rides.
 *
 * If the two columns are collinear — every route climbing the same feet per mile —
 * the determinant collapses and the split between "distance" and "climbing" is
 * arbitrary. The same happens if the fit comes back saying climbing makes you
 * faster. Both fall back to distance alone, which is worse but never absurd.
 */
function zwiftFit(routes){
  const rows=zwiftFitRows(routes);
  if(rows.length<ZW_MIN_FIT)return null;
  let sdd=0,sde=0,see=0,sdt=0,set_=0,stt=0;
  rows.forEach(({distance_mi:d,elevation_ft:e,time_sec:t})=>{
    sdd+=d*d;sde+=d*e;see+=e*e;sdt+=d*t;set_+=e*t;stt+=t*t;
  });
  const det=sdd*see-sde*sde;
  let a=null,b=0;
  if(Math.abs(det)>1e-6){
    a=(sdt*see-set_*sde)/det;
    b=(sdd*set_-sde*sdt)/det;
  }
  if(a==null||!(a>0)||b<0){a=sdd?sdt/sdd:null;b=0;}
  if(!(a>0))return null;
  // Uncentred R2 and the typical miss, so the tab can say how much to trust this.
  const ssRes=stt-2*(a*sdt+b*set_)+(a*a*sdd+2*a*b*sde+b*b*see);
  return {
    a,b,n:rows.length,
    mph:3600/a,
    minPer1000ft:b*1000/60,
    r2:stt?Math.max(0,1-ssRes/stt):0,
    rmseSec:Math.sqrt(Math.max(0,ssRes)/rows.length),
  };
}

function zwiftPredictSec(fit,distanceMi,elevationFt){
  if(!fit||!(distanceMi>0))return null;
  return fit.a*distanceMi+fit.b*(elevationFt>0?elevationFt:0);
}

// H:MM:SS, or M:SS under an hour — the same shape the logged times already use.
function fmtEstTime(sec){
  if(sec==null||!isFinite(sec)||sec<0)return'—';
  const t=Math.round(sec);
  const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          :`${m}:${String(s).padStart(2,'0')}`;
}

/* ── EDDINGTON ──
 *
 * E is the largest number for which you have E days of at least E units. It is
 * governed by the MIDDLE of a history rather than its top: one enormous ride does
 * nothing for it, and neither does a thousand short ones. Every step costs at
 * least one more qualifying day than the last, which is the whole appeal and also
 * why it flattens off — going from 80 to 81 means another day at 81+, and you
 * already need 80 of them.
 *
 * Counted by DAY by default, which is Eddington's own definition — he counted
 * days, not rides. Per activity is offered alongside because it is how most people
 * describe it out loud.
 *
 * Neither basis dominates the other, which is not obvious and is worth stating.
 * Splitting a day across two rides lowers each distance but raises the COUNT of
 * entries, and E is capped by both: two 30s and a 50 give days of [60,50] and an E
 * of 2, but rides of [50,30,30] and an E of 3. Per day is usually the higher figure
 * for a history of single-outing days; it is not a rule, and the tab shows whichever
 * basis you asked for rather than the flattering one.
 *
 * Like Mex, this follows the mi/km switch and is a different number in each. Only
 * the mile figure is comparable with what cyclists usually quote.
 */
function eddDistances(acts,basis){
  if(basis==='ride')return acts.map(actDistIn).filter(d=>d>0).sort((a,b)=>b-a);
  const byDay={};
  acts.forEach(a=>{const d=actDistIn(a);if(d>0)byDay[a.date]=(byDay[a.date]||0)+d;});
  return Object.values(byDay).sort((a,b)=>b-a);
}

// `sorted` descending. Once an entry falls below its own rank nothing after it can
// recover — the entries only get smaller and the rank only gets bigger — so the
// walk stops there rather than scanning a whole history.
function eddingtonOf(sorted){
  let e=0;
  for(let i=0;i<sorted.length;i++){if(sorted[i]>=i+1)e=i+1;else break;}
  return e;
}

// How many further qualifying days a target would take. The honest version of
// "what do I do next": reaching E+1 is not one more ride, it is however many days
// at E+1 or more you are still short of.
function eddingtonNeed(sorted,target){
  if(!(target>0))return 0;
  let have=0;
  while(have<sorted.length&&sorted[have]>=target)have++;
  return Math.max(0,target-have);
}

// The curve behind the number: for every threshold, how many days clear it. Your
// Eddington is where that falling count meets the rising threshold. Walks one
// pointer down the sorted list rather than counting the list again per threshold.
function eddingtonCurve(sorted,upTo){
  const out=[];let i=sorted.length;
  for(let n=1;n<=upTo;n++){
    while(i>0&&sorted[i-1]<n)i--;
    out.push({n,days:i});
  }
  return out;
}

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

/* ── THE CALENDAR WEEK ──
 * "This week" on the Summary tab means the week you are standing in — Monday to
 * today — and not the last seven days. The two are only the same thing on a Sunday
 * evening. A rolling window answers "what have I just done", which is the question
 * the hero CHART answers and why its lines stay rolling; the figure above it
 * answers "how is this week going", and on a Monday morning the honest answer to
 * that is usually nothing yet.
 *
 * Weeks run Monday to Sunday, matching weeklyLoadStats below and the week people
 * actually plan in.
 *
 * ── What it is measured against ──
 * A part-week cannot be held against a whole-week average: on Tuesday you would be
 * "80% below your base" every single week, which is noise dressed as a warning. So
 * the base here is the SAME SLICE of the preceding weeks — Monday-to-Tuesday of the
 * last four weeks, averaged — which is a like-for-like comparison and needs no
 * pro-rating. Pro-rating a weekly average by days elapsed would assume training is
 * spread evenly across the week, and almost nobody's is; it would mark every
 * weekend-loaded week as behind until Saturday.
 *
 * Empty weeks count towards that average. They are real weeks, and dropping them
 * would quietly compare you against your good weeks only.
 *
 * Early in the week the ratio is built on very little — one Monday session against
 * four previous Mondays — so it moves hard. That is a true reading of a small
 * sample rather than a fault, but it is why the figure leads and the ratio follows.
 */
const WEEK_BASE_WEEKS=4;

// Monday of the week containing `iso`. Anchored at local noon like every other date
// step in this file, so a DST boundary cannot move it onto the day before.
function weekStartISO(iso){
  const d=new Date(iso+'T12:00:00');
  d.setDate(d.getDate()-((d.getDay()+6)%7));   // getDay: 0=Sun; (d+6)%7 puts Mon=0
  return isoOf(d.getTime());
}

function isoOf(ms){
  const d=new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function calendarWeek(acts,pick,opts){
  const o=opts||{};
  const today=o.today||todayISO();
  const back=o.weeks===undefined?WEEK_BASE_WEEKS:o.weeks;

  const byDay={};
  (acts||[]).forEach(a=>{byDay[a.date]=(byDay[a.date]||0)+(pick(a)||0);});

  const weekStart=weekStartISO(today);
  const startMs=new Date(weekStart+'T12:00:00').getTime();
  // Days of this week that have happened, today included: Monday is 1, Sunday is 7.
  const elapsed=Math.round((new Date(today+'T12:00:00').getTime()-startMs)/86400000)+1;

  const sliceFrom=(ms,n)=>{let s=0;for(let k=0;k<n;k++)s+=byDay[isoOf(ms+k*86400000)]||0;return s;};

  const total=sliceFrom(startMs,elapsed);

  const prior=[];
  for(let w=1;w<=back;w++){
    const ms=startMs-w*7*86400000;
    prior.push({start:isoOf(ms),toDate:sliceFrom(ms,elapsed),full:sliceFrom(ms,7)});
  }
  const mean=xs=>xs.length?xs.reduce((s,v)=>s+v,0)/xs.length:0;
  const pace=mean(prior.map(p=>p.toDate));
  const fullWeek=mean(prior.map(p=>p.full));

  return{
    weekStart,elapsed,total,pace,fullWeek,prior,
    complete:elapsed===7,
    ratio:pace>0?total/pace:0,
    days:Array.from({length:7},(_,k)=>{
      const date=isoOf(startMs+k*86400000);
      return{date,value:byDay[date]||0,future:k>=elapsed};
    }),
  };
}

/* ── WEEKLY TOTALS ──
 * The last N calendar weeks, Monday to Sunday, oldest first, the current week as far
 * as it has got. What the sparklines under the sport rows are drawn from: weekly,
 * not daily, because a day-by-day series for anything but the main sport is mostly
 * zeros and reads as noise rather than a shape.
 */
function weeklyTotals(acts,pick,opts){
  const o=opts||{};
  const today=o.today||todayISO();
  const weeks=o.weeks||12;
  const start=new Date(weekStartISO(today)+'T12:00:00').getTime();
  const out=new Array(weeks).fill(0);
  (acts||[]).forEach(a=>{
    // Whole days between this week's Monday and the activity, DST-proof at noon.
    const days=Math.round((new Date(a.date+'T12:00:00').getTime()-start)/86400000);
    if(days>6)return;                                   // after this week: not possible, but not counted
    const back=days>=0?0:Math.ceil(-days/7);            // 0 = this week, 1 = last week, …
    if(back>=weeks)return;
    out[weeks-1-back]+=pick(a)||0;
  });
  return out;
}

/* ── THE CALENDAR MONTH AND YEAR ──
 * The hero cards can be read by month or by year as well as by week, and the
 * arithmetic is the calendar week's, one size up: the period you are standing in, from
 * its first day to today, held against the SAME SLICE of the periods before it — the
 * first fourteen days of each of the last three months, or the first 257 days of each
 * of the last three years — averaged. The reasoning holds at every size: a part-month
 * against whole months would call the 3rd of every month a collapse.
 */
const PERIOD_BASE={week:WEEK_BASE_WEEKS,month:3,year:3};

function periodStartISO(iso,unit){
  if(unit==='week')return weekStartISO(iso);
  if(unit==='year')return iso.slice(0,4)+'-01-01';
  return iso.slice(0,7)+'-01';
}
// The first day of the period `n` before the one containing `iso`.
function periodBackISO(iso,unit,n){
  if(unit==='week')return isoOf(new Date(weekStartISO(iso)+'T12:00:00').getTime()-n*7*86400000);
  const d=new Date(iso+'T12:00:00');
  if(unit==='year')return String(d.getFullYear()-n)+'-01-01';
  const m=new Date(d.getFullYear(),d.getMonth()-n,1,12);
  return `${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}-01`;
}
function periodLength(startISO,unit){
  if(unit==='week')return 7;
  const d=new Date(startISO+'T12:00:00');
  if(unit==='year')return daysInYear(d.getFullYear());
  return new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
}

// The same shape whatever the unit: start, elapsed, length, total, pace (the base's
// same-slice average), fullPeriod (the base's whole-period average), prior, complete,
// ratio. The week is calendarWeek's answer under these names.
function calendarPeriod(acts,pick,opts){
  const o=opts||{};
  const unit=o.unit||'week';
  if(unit==='week'){
    const cw=calendarWeek(acts,pick,o);
    return Object.assign({},cw,{unit:'week',start:cw.weekStart,length:7,fullPeriod:cw.fullWeek});
  }
  const today=o.today||todayISO();
  const back=o.back===undefined?PERIOD_BASE[unit]:o.back;

  const byDay={};
  (acts||[]).forEach(a=>{byDay[a.date]=(byDay[a.date]||0)+(pick(a)||0);});

  const start=periodStartISO(today,unit);
  const startMs=new Date(start+'T12:00:00').getTime();
  const elapsed=Math.round((new Date(today+'T12:00:00').getTime()-startMs)/86400000)+1;
  const length=periodLength(start,unit);
  const sliceFrom=(ms,n)=>{let s=0;for(let k=0;k<n;k++)s+=byDay[isoOf(ms+k*86400000)]||0;return s;};

  const total=sliceFrom(startMs,elapsed);
  const prior=[];
  for(let p=1;p<=back;p++){
    const ps=periodBackISO(today,unit,p);
    const ms=new Date(ps+'T12:00:00').getTime();
    const len=periodLength(ps,unit);
    // A 31-day slice of a 30-day month is the whole of it, never its neighbour's first day.
    prior.push({start:ps,toDate:sliceFrom(ms,Math.min(elapsed,len)),full:sliceFrom(ms,len)});
  }
  const mean=xs=>xs.length?xs.reduce((s,v)=>s+v,0)/xs.length:0;
  const pace=mean(prior.map(p=>p.toDate));
  const fullPeriod=mean(prior.map(p=>p.full));
  return{unit,start,elapsed,length,total,pace,fullPeriod,prior,complete:elapsed>=length,ratio:pace>0?total/pace:0};
}

/* ── PERIOD TOTALS ──
 * The last N calendar months, or every calendar year since the first activity, oldest
 * first, the current one as far as it has got — what the hero chart draws when it is
 * read by month or by year. Anything dated after today is not counted.
 */
function periodTotals(acts,pick,opts){
  const o=opts||{};
  const unit=o.unit||'month';
  const today=o.today||todayISO();
  const byKey={};
  let earliest=null;
  (acts||[]).forEach(a=>{
    if(!a.date||a.date>today)return;
    const k=unit==='year'?a.date.slice(0,4):a.date.slice(0,7);
    byKey[k]=(byKey[k]||0)+(pick(a)||0);
    if(!earliest||a.date<earliest)earliest=a.date;
  });
  const out=[];
  if(unit==='year'){
    const thisYear=+today.slice(0,4);
    const first=earliest?+earliest.slice(0,4):thisYear;
    const count=o.count||(thisYear-first+1);
    for(let y=thisYear-count+1;y<=thisYear;y++){
      const k=String(y);
      out.push({key:k,start:k+'-01-01',value:byKey[k]||0,partial:y===thisYear});
    }
  }else{
    const count=o.count||24;
    const d=new Date(today.slice(0,7)+'-01T12:00:00');
    for(let i=count-1;i>=0;i--){
      const m=new Date(d.getFullYear(),d.getMonth()-i,1,12);
      const k=`${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}`;
      out.push({key:k,start:k+'-01',value:byKey[k]||0,partial:k===today.slice(0,7)});
    }
  }
  return out;
}

/* ── TRAINING MONOTONY AND STRAIN ──
 * Foster's pair. Monotony is a week's mean daily load divided by the standard
 * deviation of those same seven days; strain is the week's total load multiplied
 * by its monotony.
 *
 * What they add that a total cannot: two weeks can carry identical volume and be
 * completely different training. Ten hours spread evenly across seven days and ten
 * hours in two sessions have the same total and nothing else in common, and the
 * load chart cannot tell them apart, because a total is all it has. Monotony is
 * the number that separates them — high means every day looks like every other
 * day, which is the pattern associated with staleness rather than adaptation.
 *
 * Rest days count as zeros, deliberately. They are most of what creates the
 * variation in the first place, and a week averaged over "the days you trained"
 * would score a hard-easy week and a relentless one identically.
 *
 * Population SD (over n), not the sample estimate (n-1): these seven days are the
 * whole week, not a sample drawn from a larger one.
 */
const MONOTONY_CAUTION=2.0;   // the level the literature flags; drawn on the chart
const MONOTONY_CAP=5;         // seven identical non-zero days divide by zero
function weeklyLoadStats(acts,pick,opts){
  const o=opts||{};
  const end=o.end||o.today||todayISO();
  const byDay={};
  (acts||[]).forEach(a=>{if(a&&a.date)byDay[a.date]=(byDay[a.date]||0)+(pick(a)||0);});
  const dates=Object.keys(byDay).sort();
  if(!dates.length)return[];

  // Anchored at local noon and stepped in whole days, for the same reason
  // rollingWeekly is: midnight drifts across a DST boundary and repeats or skips one.
  const dayAt=ms=>{
    const d=new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  // Weeks run Monday to Sunday, because that is the week people plan in.
  const first=new Date(dates[0]+'T12:00:00');
  first.setDate(first.getDate()-((first.getDay()+6)%7));
  const endMs=new Date(end+'T12:00:00').getTime();

  const out=[];
  for(let ms=first.getTime();ms<=endMs;ms+=7*86400000){
    const days=[];
    for(let k=0;k<7;k++)days.push(byDay[dayAt(ms+k*86400000)]||0);
    // A week still in progress is not a week: its later days are zeros that have
    // not happened yet, which would read as the most varied week of the year.
    if(ms+6*86400000>endMs)break;
    const total=days.reduce((s,v)=>s+v,0);
    if(total<=0)continue;                       // a week off has no monotony to report
    const mean=total/7;
    const sd=Math.sqrt(days.reduce((s,v)=>s+(v-mean)*(v-mean),0)/7);
    const monotony=sd>0?Math.min(mean/sd,MONOTONY_CAP):MONOTONY_CAP;
    out.push({
      week:dayAt(ms),
      total:+total.toFixed(2),
      mean:+mean.toFixed(3),
      sd:+sd.toFixed(3),
      monotony:+monotony.toFixed(2),
      strain:+(total*monotony).toFixed(1),
      days:days.filter(v=>v>0).length,
    });
  }
  return out;
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

/* ── YEAR-END PROJECTION ──
 * Where the year lands if it carries on at some rate — and the dial is which rate.
 *
 * At the left, the rate of THIS YEAR SO FAR: every day since 1 January, averaged, run
 * out to 31 December. It is the steadiest guess and the slowest to notice anything —
 * ask it in September after two months off and it still remembers May.
 *
 * At the right, JUST THE LAST SEVEN DAYS at their own rate. It notices everything,
 * including a rest week, and will happily promise you fifty-two of whatever you did
 * this week.
 *
 * In between, the window shrinks from the one to the other. Geometrically, not
 * linearly: halfway on day 257 is about six weeks, not four months, because "the
 * last few weeks" is the question people actually have in the middle of the dial.
 * No other year is consulted — the previous years are on the chart to be read
 * against, not to shape the guess.
 *
 * `mix` runs 0 (this year so far) to 1 (the last seven days).
 */
const PROJ_WINDOW_MIN=7;

// How many days the dial is currently reading, for a year `doy` days in.
function projectionWindow(mix,doy){
  const m=Math.max(0,Math.min(1,mix==null?0.5:mix));
  const whole=Math.max(PROJ_WINDOW_MIN,doy|0);
  const w=Math.exp(Math.log(whole)+(Math.log(PROJ_WINDOW_MIN)-Math.log(whole))*m);
  return Math.max(PROJ_WINDOW_MIN,Math.min(whole,Math.round(w)));
}

function daysInYear(y){return(+y%4===0&&(+y%100!==0||+y%400===0))?366:365;}

/* daily: { '2026': Array(367) of per-day values, ... } — index 1 is 1 January.
 * Returns the projection, the two ends of the dial, and the path to draw.
 */
function yearEndProjection(daily,focus,doy,mix){
  const len=daysInYear(focus);
  const day=Math.max(1,Math.min(doy|0,len));
  const cur=daily[focus]||[];
  let ytd=0;
  for(let d=1;d<=day;d++)ytd+=cur[d]||0;
  const left=len-day;

  // The last `win` days at their own rate, carried to 31 December.
  const carry=win=>{
    let sum=0;
    for(let d=Math.max(1,day-win+1);d<=day;d++)sum+=cur[d]||0;
    return ytd+(sum/win)*left;
  };
  const win=projectionWindow(mix,day);
  const projected=carry(win);
  // The two ends of the dial, so the spread between them can be shown: that gap is
  // the uncertainty, and it belongs on screen rather than in a caveat.
  const yearRate=carry(day);
  const weekRate=carry(Math.min(day,PROJ_WINDOW_MIN));

  // A straight line from today to the projection — a rate carried forward is a
  // straight line, and drawing anything else would claim knowledge the dial has not got.
  const path=new Array(len+1).fill(null);
  for(let d=day;d<=len;d++)path[d]=+(ytd+(projected-ytd)*(left?(d-day)/left:1)).toFixed(2);

  return{
    ytd:+ytd.toFixed(2),
    projected:+projected.toFixed(2),
    yearRate:+yearRate.toFixed(2),
    weekRate:+weekRate.toFixed(2),
    window:win,
    wholeYear:win>=day,
    daysLeft:left,
    path,
  };
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
    typeMatches,isFootSport,isRace,dayOfYear,daysBetween,monthsBetween,fmtServiceSpan,monthLabel,haversineMi,
    decodePolylinePts,gearKey,gearSlug,socCanon,socInitials,extractPartners,formatUpdatedAt,
    recLongestStreak,recCurrentStreak,mexBuckets,mexOf,eddDistances,eddingtonOf,eddingtonNeed,eddingtonCurve,actDistIn,distIn,
    zwiftFitRows,zwiftFit,zwiftPredictSec,fmtEstTime,ZW_MIN_FIT,
    ROLLING_PERIODS,ROLLING_ORDER,todayISO,isYearScope,isRollingScope,periodStart,
    scopeIncludes,periodLabel,periodPhrase,isValidScope,rollingWeekly,ratioBand,RATIO_BANDS,
    calendarWeek,weekStartISO,isoOf,WEEK_BASE_WEEKS,weeklyTotals,
    calendarPeriod,periodTotals,periodStartISO,periodBackISO,periodLength,PERIOD_BASE,
    CHRONIC_DAYS,CHRONIC_WEIGHTS,weeklyLoadStats,MONOTONY_CAUTION,MONOTONY_CAP,
    yearEndProjection,projectionWindow,daysInYear,PROJ_WINDOW_MIN,
    setScope(s){
      if(s.unit!==undefined)unit=s.unit;
      if(s.activeYear!==undefined)activeYear=s.activeYear;
      if(s.activeType!==undefined)activeType=s.activeType;
      if(s.activeTab!==undefined)activeTab=s.activeTab;
    },
    getScope(){return{unit,activeYear,activeType,activeTab};}
  };
}
