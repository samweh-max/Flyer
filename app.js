/* Samflyer v1 — a personal Flighty-style flight tracker. Everything is stored on this device. */
(() => {
'use strict';
const VERSION = '1.15';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/* ---------- Reference data ---------- */
const AP = {};
(window.SF_AIRPORTS_RAW || '').trim().split('\n').forEach((l) => {
  const [code, name, city, cc, lat, lon, tz] = l.split('|');
  if (code) AP[code] = { code, name, city, cc, lat: +lat, lon: +lon, tz };
});
const AIRLINES = window.SF_AIRLINES || {};
const HOME_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';

/* ---------- Storage ---------- */
const KEY = 'samflyer.v1';
const DEFAULT_SETTINGS = { units: 'both', theme: 'system', globe: 'sat', apiKey: '', autoRefresh: true, leaveH: 3, alerts: { delays: true, gates: true, leave: true, checkin: true, landed: true, belt: true } };
function normalise(d) {
  d = d || {};
  const s = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  s.alerts = Object.assign({}, DEFAULT_SETTINGS.alerts, (d.settings && d.settings.alerts) || {});
  return { flights: Array.isArray(d.flights) ? d.flights : [], settings: s, usage: d.usage || { month: '', units: 0 }, airports: d.airports || {}, alerts: Array.isArray(d.alerts) ? d.alerts.slice(0, 200) : [] };
}
function load() { try { return normalise(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return normalise({}); } }
let db = load();
Object.values(db.airports).forEach((a) => { if (!AP[a.code]) AP[a.code] = a; });
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save — phone storage may be full'); }
}

/* ---------- Time zones ---------- */
const dtfCache = {};
function partsAt(ts, tz) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {};
  f.formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function tzOffset(ts, tz) {
  const p = partsAt(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}
function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffset(guess, tz);
  let utc = guess - off;
  const off2 = tzOffset(utc, tz);
  if (off2 !== off) utc = guess - off2;
  return utc;
}
function localDateTime(ts, tz) {
  const p = partsAt(ts, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}
const fmtCache = {};
function fmt(ts, tz, kind) {
  const k = tz + kind;
  const opts = { time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, day: { weekday: 'short', day: 'numeric', month: 'short' }, mon: { month: 'short' }, dnum: { day: 'numeric' }, full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, short: { day: 'numeric', month: 'short' }, year: { year: 'numeric' } }[kind];
  const f = fmtCache[k] || (fmtCache[k] = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz }, opts)));
  return f.format(new Date(ts));
}
function durStr(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
function agoStr(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function offsetDiffStr(f) {
  const diff = Math.round((tzOffset(f.arr, f.B.tz) - tzOffset(f.dep, f.A.tz)) / 60000);
  if (!diff) return `${f.B.city} is on the same time as ${f.A.city}`;
  const h = Math.floor(Math.abs(diff) / 60), m = Math.abs(diff) % 60;
  const amt = m ? `${h}h ${m}m` : `${h}h`;
  return `${f.B.city} is ${amt} ${diff > 0 ? 'ahead of' : 'behind'} ${f.A.city}`;
}

/* ---------- Geography ---------- */
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function gcMiles(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function gcPoints(a, b, n = 64) {
  const p1 = rad(a.lat), l1 = rad(a.lon), p2 = rad(b.lat), l2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-6) return [[a.lat, a.lon], [b.lat, b.lon]];
  const out = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = deg(Math.atan2(y, x));
    const lat = deg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    if (prev != null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
    prev = lon;
    out.push([lat, lon]);
  }
  return out;
}
function bearing(p, q) {
  const y = Math.sin(rad(q[1] - p[1])) * Math.cos(rad(q[0]));
  const x = Math.cos(rad(p[0])) * Math.sin(rad(q[0])) - Math.sin(rad(p[0])) * Math.cos(rad(q[0])) * Math.cos(rad(q[1] - p[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/* ---------- Units ---------- */
function distStr(mi) {
  const u = db.settings.units, nm = mi * 0.868976;
  if (u === 'mi') return `${nf.format(mi)} mi`;
  if (u === 'nm') return `${nf.format(nm)} nm`;
  return `${nf.format(mi)} mi · ${nf.format(nm)} nm`;
}
function speedStr(mph) {
  const u = db.settings.units, kmh = mph * 1.609344, kn = mph * 0.868976;
  if (u === 'mi') return `${nf.format(kmh)} km/h`;
  if (u === 'nm') return `${nf.format(kn)} kn`;
  return `${nf.format(kmh)} km/h · ${nf.format(kn)} kn`;
}

/* ---------- Live data (AeroDataBox via RapidAPI + free ADS-B positions) ---------- */
const ADB_HOST = 'aerodatabox.p.rapidapi.com';
const UNITS_PER_LOOKUP = 2, FREE_UNITS = 400, AUTO_STOP_AT = 360;
const monthKey = () => localDateTime(Date.now(), HOME_TZ).date.slice(0, 7);
function unitsUsed() { if (db.usage.month !== monthKey()) db.usage = { month: monthKey(), units: 0 }; return db.usage.units; }
function addUnits(n) { unitsUsed(); db.usage.units += n; save(); }
const hasKey = () => !!(db.settings.apiKey && db.settings.apiKey.trim());
async function adb(path, cost = UNITS_PER_LOOKUP) {
  if (!hasKey()) throw new Error('nokey');
  const res = await fetch(`https://${ADB_HOST}${path}`, { headers: { 'x-rapidapi-key': db.settings.apiKey.trim(), 'x-rapidapi-host': ADB_HOST } });
  if (cost) addUnits(cost);
  if (res.status === 204 || res.status === 404) return [];
  if (res.status === 401 || res.status === 403) throw new Error('badkey');
  if (res.status === 429) throw new Error('quota');
  if (!res.ok) throw new Error('http' + res.status);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}
const ERR_TEXT = { nokey: 'Add your flight-data key in Settings first.', badkey: "The key wasn't accepted. Check it in Settings, and that you're subscribed to AeroDataBox's free plan.", quota: "This month's free lookups are used up.", offline: 'No internet connection.' };
const errText = (e) => ERR_TEXT[e.message] || (e.name === 'TypeError' ? ERR_TEXT.offline : "Couldn't reach the flight-data service.");
const parseT = (t) => (t && t.utc ? Date.parse(t.utc.replace(' ', 'T')) : null);
function ensureAirport(a) {
  if (!a) return null;
  const code = a.iata || a.icao;
  if (!code) return null;
  if (AP[code]) return code;
  if (!a.location || !a.timeZone) return null;
  const rec = { code, name: a.shortName || a.name, city: a.municipalityName || a.name, cc: a.countryCode || '', lat: +a.location.lat, lon: +a.location.lon, tz: a.timeZone };
  AP[code] = rec; db.airports[code] = rec; save();
  return code;
}
/* Turn one AeroDataBox flight into our fields */
function fromAdb(x) {
  const d = x.departure || {}, a = x.arrival || {};
  const from = ensureAirport(d.airport), to = ensureAirport(a.airport);
  const depS = parseT(d.scheduledTime), arrS = parseT(a.scheduledTime);
  const best = (m) => parseT(m.runwayTime) || parseT(m.revisedTime) || parseT(m.predictedTime) || parseT(m.scheduledTime);
  const loc = x.location;
  return {
    from, to, depS, arrS,
    flightNo: (x.number || '').replace(/\s+/g, ''), airline: (x.airline && x.airline.name) || '',
    live: {
      status: x.status || 'Unknown', depBest: best(d), arrBest: best(a),
      depTerm: d.terminal || '', depGate: d.gate || '', checkIn: d.checkInDesk || '', arrTerm: a.terminal || '', arrGate: a.gate || '', belt: a.baggageBelt || '',
      model: (x.aircraft && x.aircraft.model) || '', reg: (x.aircraft && x.aircraft.reg) || '', modeS: ((x.aircraft && x.aircraft.modeS) || '').toLowerCase(),
      callSign: x.callSign || '', fetchedAt: Date.now(),
      pos: loc && loc.lat != null ? { lat: loc.lat, lon: loc.lon, altFt: loc.altitude && loc.altitude.feet, gsKt: loc.groundSpeed && loc.groundSpeed.kt, track: loc.trueTrack && loc.trueTrack.deg, at: parseT({ utc: loc.reportedAtUtc }) || Date.now(), src: 'AeroDataBox' } : null
    }
  };
}
/* ---------- Alerts (no server: recorded when the app refreshes, shown in-app) ---------- */
const ALERT_KIND = { delay: 'delays', gate: 'gates', landed: 'landed', belt: 'belt' };
function addAlert(f, type, title, sub) {
  if (f.friend || !db.settings.alerts[ALERT_KIND[type]]) return;
  db.alerts.unshift({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), flightId: f.id, type, title, sub, at: Date.now(), read: false });
  db.alerts = db.alerts.slice(0, 200);
}
function unreadAlerts() { return db.alerts.filter((x) => !x.read).length; }
function updateAlertDot() { const d = $('#alert-dot'); if (d) d.hidden = !unreadAlerts(); }
const leaveHOf = (f) => (f.leaveH != null ? f.leaveH : db.settings.leaveH);
const leaveLabel = (h) => (h % 1 ? `${Math.floor(h)}½h` : `${h}h`);
/* Calendar file: one event per flight with "time to leave" and "check-in" alarms built in */
function icsFor(list) {
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = (s) => String(s).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Samflyer//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  list.forEach((f) => {
    const h = leaveHOf(f), al = db.settings.alerts;
    lines.push('BEGIN:VEVENT', `UID:${f.id}@samflyer`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(f.dep)}`, `DTEND:${stamp(f.arr)}`,
      `SUMMARY:${escI(`✈ ${prettyNo(f) || "Flight"} ${f.from} → ${f.to}`)}`, `LOCATION:${escI(f.A.name + ', ' + f.A.city)}`,
      `DESCRIPTION:${escI(`${titleOf(f)}\nDeparts ${fmt(f.dep, f.A.tz, 'time')} ${f.A.city} time · arrives ${fmt(f.arr, f.B.tz, 'time')} ${f.B.city} time${f.depTerm ? '\nTerminal ' + f.depTerm : ''}`)}`);
    if (al.leave) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(`Leave for ${f.A.city} airport`)}`, `TRIGGER:-PT${Math.round(h * 60)}M`, 'END:VALARM');
    if (al.checkin) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Check-in opens', 'TRIGGER:-PT24H', 'END:VALARM');
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
async function sendCalendar(list, name) {
  const text = icsFor(list);
  const file = new File([text], name + '.ics', { type: 'text/calendar' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = name + '.ics'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* Refresh one stored flight. Returns a list of human-readable changes. */
async function refreshFlight(id) {
  const f = db.flights.find((x) => x.id === id);
  if (!f || !f.flightNo) throw new Error('nonumber');
  const list = await adb(`/flights/number/${encodeURIComponent(f.flightNo)}/${f.depDate}?withAircraftImage=false&withLocation=true&dateLocalRole=Departure`);
  const arr = Array.isArray(list) ? list : [list];
  const match = arr.map(fromAdb).find((m) => m.from === f.from && m.to === f.to) || (arr.length === 1 ? fromAdb(arr[0]) : null);
  if (!match) { f.live = Object.assign({}, f.live || {}, { fetchedAt: Date.now(), notFound: true }); save(); return []; }
  const old = f.live || {}, L = match.live, changes = [];
  const tzA = AP[f.from].tz, tzB = AP[f.to].tz, sched = match.depS || zonedToUtc(f.depDate, f.depTime, tzA);
  const note = (type, title, sub) => { changes.push(title); addAlert(f, type, title, sub); };
  const lateMin = (t) => Math.round((t - sched) / 60000);
  const landedNow = /arrived|landed/i.test(L.status || '') && !/arrived|landed/i.test(old.status || '');
  if (old.fetchedAt) {
    if (L.depGate && L.depGate !== old.depGate) note('gate', old.depGate ? `Gate ${old.depGate} → ${L.depGate}` : `Gate ${L.depGate}`, old.depGate ? 'Gate changed' : 'Gate posted');
    if (L.depTerm && old.depTerm && L.depTerm !== old.depTerm) note('gate', `Terminal ${old.depTerm} → ${L.depTerm}`, 'Terminal changed');
    if (old.depBest && L.depBest && Math.abs(L.depBest - old.depBest) >= 5 * 60000 && !landedNow) {
      const m = lateMin(L.depBest);
      note('delay', m >= 5 ? `Delayed ${lateStr(m).replace(' late', '')}` : 'Back on time', `Now leaves ${fmt(L.depBest, tzA, 'time')}`);
    }
    if (landedNow) note('landed', `Landed in ${AP[f.to].city}`, `At ${fmt(L.arrBest || Date.now(), tzB, 'time')}${L.arrGate ? ' · gate ' + L.arrGate : ''}`);
    if (L.belt && L.belt !== old.belt) note('belt', `Bags on belt ${L.belt}`, AP[f.to].name || AP[f.to].city);
    if (L.status !== old.status && (L.status === 'Canceled' || L.status === 'Diverted')) note('delay', `Flight ${L.status === 'Canceled' ? 'cancelled' : 'diverted'}`, 'Check with the airline');
  } else if (L.depBest && lateMin(L.depBest) >= 15) {
    note('delay', `Delayed ${lateStr(lateMin(L.depBest)).replace(' late', '')}`, `Now leaves ${fmt(L.depBest, tzA, 'time')}`);
  }
  if (old.inbound) L.inbound = old.inbound;
  if (!L.pos && old.pos && old.pos.src !== 'AeroDataBox') L.pos = old.pos;
  f.live = L;
  if (match.depS && match.arrS) {
    const dl = localDateTime(match.depS, AP[f.from].tz), al = localDateTime(match.arrS, AP[f.to].tz);
    Object.assign(f, { depDate: dl.date, depTime: dl.time, arrDate: al.date, arrTime: al.time });
  }
  ['depTerm', 'depGate', 'arrGate', 'belt'].forEach((k) => { if (L[k]) f[k] = L[k]; });
  if (L.model && !f.aircraft) f.aircraft = L.model;
  if (L.reg && !f.reg) f.reg = L.reg.toUpperCase();
  if (!f.airline && match.airline) f.airline = match.airline;
  save();
  return changes;
}
/* Where's my plane: this aircraft's flights around your departure */
async function checkInbound(id) {
  const f = db.flights.find((x) => x.id === id);
  if (!f || !f.live || !f.live.reg) throw new Error('noreg');
  const list = await adb(`/flights/reg/${encodeURIComponent(f.live.reg)}/${f.depDate}?withAircraftImage=false&withLocation=false&dateLocalRole=Both`);
  const D = derive(f);
  const legs = (Array.isArray(list) ? list : [list]).map((x) => {
    const d = x.departure || {}, a = x.arrival || {};
    const best = (m) => parseT(m.runwayTime) || parseT(m.revisedTime) || parseT(m.predictedTime) || parseT(m.scheduledTime);
    return { no: x.number || '', from: (d.airport && (d.airport.iata || d.airport.icao)) || '?', to: (a.airport && (a.airport.iata || a.airport.icao)) || '?', status: x.status || '', depS: parseT(d.scheduledTime), depBest: best(d), arrS: parseT(a.scheduledTime), arrBest: best(a) };
  }).filter((l) => l.depS && l.arrS);
  const prev = legs.filter((l) => l.to === f.from && l.arrS <= D.depS).sort((a, b) => b.arrS - a.arrS)[0] || null;
  const next = legs.filter((l) => l.from === f.to && l.depS >= D.arrS).sort((a, b) => a.depS - b.depS)[0] || null;
  f.live.inbound = { prev, next, fetchedAt: Date.now() };
  save();
}
/* Free live position from community ADS-B networks (no key). */
async function fetchPosition(hex) {
  const urls = [`https://api.adsb.lol/v2/icao/${hex}`, `https://api.airplanes.live/v2/hex/${hex}`];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      const ac = (j.ac || j.aircraft || [])[0];
      if (ac && ac.lat != null) return { lat: ac.lat, lon: ac.lon, altFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : ac.alt_geom, gsKt: ac.gs, track: ac.track != null ? ac.track : ac.true_heading, at: Date.now(), src: u.includes('adsb.lol') ? 'adsb.lol' : 'airplanes.live', ground: ac.alt_baro === 'ground' };
    } catch (e) { /* try the next source */ }
  }
  return null;
}

/* ---------- Flights ---------- */
function derive(f) {
  const A = AP[f.from], B = AP[f.to];
  if (!A || !B) return null;
  const depS = zonedToUtc(f.depDate, f.depTime, A.tz);
  const arrS = zonedToUtc(f.arrDate, f.arrTime, B.tz);
  const L = f.live || null;
  const dep = (L && L.depBest) || depS, arr = (L && L.arrBest) || arrS;
  return Object.assign({}, f, { A, B, depS, arrS, dep, arr, live: L, mi: gcMiles(A, B), dur: arr - dep });
}
function flightsD() { return db.flights.filter((f) => !f.friend).map(derive).filter(Boolean); }
function friendsD() { return db.flights.filter((f) => f.friend).map(derive).filter(Boolean); }
function findD(id) { const f = db.flights.find((x) => x.id === id); return f ? derive(f) : null; }
const lateStr = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${pad(min % 60)}m late` : `${min}m late`);
const LIVE_WORD = { CheckIn: 'Check-in open', Boarding: 'Boarding', GateClosed: 'Gate closed' };
function status(f, now = Date.now()) {
  const L = f.live, st = L && L.status;
  if (st === 'Canceled' || st === 'CanceledUncertain') return { key: 'cancel', label: 'Cancelled', cls: 'red' };
  if (st === 'Diverted') return { key: 'divert', label: 'Diverted', cls: 'red' };
  const depLate = Math.round((f.dep - f.depS) / 60000), arrLate = Math.round((f.arr - f.arrS) / 60000);
  const flying = st === 'Departed' || st === 'EnRoute' || st === 'Approaching';
  if (st === 'Arrived' || now >= f.arr) return arrLate >= 5 ? { key: 'landed', label: `Landed ${lateStr(arrLate)}`, cls: 'amber' } : { key: 'landed', label: 'Landed', cls: 'green' };
  if (flying || now >= f.dep) return { key: 'air', label: arrLate >= 5 ? `In the air · ${lateStr(arrLate)}` : 'In the air', cls: 'blue' };
  const soon = f.dep - now < 3 * 3600000;
  if (L) {
    if (depLate >= 5) return { key: soon ? 'soon' : 'sched', label: lateStr(depLate), cls: 'amber' };
    return { key: soon ? 'soon' : 'sched', label: (soon && LIVE_WORD[st]) || 'On time', cls: 'green' };
  }
  return soon ? { key: 'soon', label: 'Departs soon', cls: 'amber' } : { key: 'sched', label: 'Scheduled', cls: 'grey' };
}
const progress = (f, now = Date.now()) => Math.min(1, Math.max(0, (now - f.dep) / (f.arr - f.dep)));
const prettyNo = (f) => (f.flightNo || '').replace(/^([A-Z0-9]{2})(\d)/, '$1 $2');
const titleOf = (f) => [prettyNo(f), f.airline].filter(Boolean).join(' · ') || 'Flight';
const codeOf = (f) => (f.flightNo || '').slice(0, 2) || '✈';
const yearOf = (f) => partsAt(f.dep, f.A.tz).y;
const plusDays = (f) => {
  const n = Math.round((Date.UTC(...f.arrDate.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...f.depDate.split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 86400000);
  return n > 0 ? ` <span class="muted" style="font-size:11px">+${n}</span>` : (n < 0 ? ` <span class="muted" style="font-size:11px">${n}</span>` : '');
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- Split-flap ---------- */
function flapInner(str) {
  return [...String(str)].map((c, i) => (c === ':' || c === ' ' || /[a-z]/.test(c))
    ? `<span class="u">${c === ' ' ? '&nbsp;' : esc(c.toUpperCase())}</span>`
    : `<span class="t" style="--d:${i}">${esc(c)}</span>`).join('');
}
function flap(str, size = 'md', attrs = '') { return `<span class="flap ${size}" ${attrs} aria-label="${esc(String(str).toUpperCase())}">${flapInner(str)}</span>`; }
/* A real split-flap: the top half of the old card falls, then the bottom half of the new one lands.
   Digits and letters roll through up to two in-between characters, like a station board. */
const FLAP_SEQ = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function flapSteps(from, to) {
  if (from === to) return [];
  const i = FLAP_SEQ.indexOf(from), j = FLAP_SEQ.indexOf(to);
  if (i < 0 || j < 0) return [to];
  const dist = (j - i + FLAP_SEQ.length) % FLAP_SEQ.length, out = [];
  if (dist > 1) out.push(FLAP_SEQ[(i + 1) % FLAP_SEQ.length]);
  if (dist > 2) out.push(FLAP_SEQ[(i + 2) % FLAP_SEQ.length]);
  out.push(to);
  return out;
}
function halfEl(cls, ch) { const h = document.createElement('span'); h.className = 'fh ' + cls; h.innerHTML = `<b>${esc(ch) || '&nbsp;'}</b>`; return h; }
function flipTile(tile, steps, delay) {
  if (!steps.length) return;
  if (tile._flipping) { tile._flipping.cancel = true; }
  const job = { cancel: false }; tile._flipping = job;
  const per = steps.length > 1 ? 120 : 200, half = per / 2;
  let from = tile.dataset.ch != null ? tile.dataset.ch : tile.textContent;
  const run = async () => {
    for (const to of steps) {
      if (job.cancel) return;
      tile.classList.add('flipping');
      const sTop = halfEl('top', to), sBot = halfEl('bot', from), fTop = halfEl('top fly', from), fBot = halfEl('bot fly', to);
      fBot.style.transform = 'rotateX(90deg)';
      tile.append(sTop, sBot, fTop, fBot);
      await fTop.animate([{ transform: 'rotateX(0deg)', filter: 'brightness(1)' }, { transform: 'rotateX(-90deg)', filter: 'brightness(.55)' }], { duration: half, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
      await fBot.animate([{ transform: 'rotateX(90deg)', filter: 'brightness(1.35)' }, { transform: 'rotateX(0deg)', filter: 'brightness(1)' }], { duration: half, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {});
      tile.firstChild.nodeType === 3 ? (tile.firstChild.nodeValue = to) : tile.prepend(document.createTextNode(to));
      tile.dataset.ch = to; from = to;
      [sTop, sBot, fTop, fBot].forEach((n) => n.remove());
    }
    tile.classList.remove('flipping');
    if (tile._flipping === job) tile._flipping = null;
  };
  setTimeout(run, delay);
}
function updateFlap(el, str) {
  const want = [...String(str)];
  const tiles = [...el.children];
  el.setAttribute('aria-label', String(str).toUpperCase());
  const instant = reduceMotion();
  // Rebuild when the shape changes (more/fewer characters), keeping old characters right-aligned so numbers roll in place.
  const shape = (cs) => cs.map((c) => (c === ':' || c === ' ' || /[a-z]/.test(c) ? 'u' : 't')).join('');
  const oldChars = tiles.map((t) => (t.classList.contains('u') ? t.textContent.replace(/ /, ' ') : (t.dataset.ch != null ? t.dataset.ch : t.textContent)));
  if (shape(oldChars) !== shape(want)) {
    const pad = want.length - oldChars.length;
    const prev = want.map((c, i) => { const o = oldChars[i - pad]; return o != null && shape([o]) === shape([c]) ? o : ' '; });
    el.innerHTML = want.map((c, i) => (c === ':' || c === ' ' || /[a-z]/.test(c))
      ? `<span class="u">${c === ' ' ? '&nbsp;' : esc(c.toUpperCase())}</span>`
      : `<span class="t still" data-ch="${esc(instant ? c : prev[i])}">${esc(instant ? c : prev[i])}</span>`).join('');
  }
  let n = 0;
  [...el.children].forEach((t, i) => {
    const c = want[i]; if (c == null) return;
    if (t.classList.contains('u')) { const v = c === ' ' ? ' ' : c.toUpperCase(); if (t.textContent !== v) t.textContent = v; return; }
    const cur = t.dataset.ch != null ? t.dataset.ch : t.textContent;
    if (cur === c) return;
    if (instant) { t.textContent = c; t.dataset.ch = c; return; }
    flipTile(t, flapSteps(cur.toUpperCase(), c.toUpperCase()).map((x, k, arr) => (k === arr.length - 1 ? c : x)), n++ * 35);
  });
}
function cd(ms) {
  if (ms <= 0) return 'NOW';
  const m = Math.ceil(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d >= 1 ? `${d}d${pad(h)}h` : `${pad(h)}:${pad(mm)}`;
}
const gateStr = (g) => (g && String(g).trim() ? String(g).trim().toUpperCase().slice(0, 4) : 'TBA');

/* ---------- Theme ---------- */
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => (db.settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : db.settings.theme);
function applyTheme() {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0B1220' : '#CFE0F2');
  restyle();
}
if (mq.addEventListener) mq.addEventListener('change', applyTheme); else if (mq.addListener) mq.addListener(applyTheme);

/* ---------- Map (MapLibre globe) ---------- */
const OFM = 'https://tiles.openfreemap.org';
const GIBS = (layer, ext) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.${ext}`;
const EMPTY = { type: 'FeatureCollection', features: [] };
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let userMoved = false;
let map = null, mapReady = false, lastRoutes = null, styleKey = '', planeMarker = null, nightBroken = false, nightErrors = 0;
let lineData = EMPTY, apData = EMPTY;
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function globeMode() {
  const g = db.settings.globe || 'sat';
  if (g === 'flat') return 'flat';
  if (g === 'day' || nightBroken) return 'day';
  return currentTheme() === 'dark' ? 'night' : 'day';
}
function buildStyle() {
  const mode = globeMode(), dark = currentTheme() === 'dark', flat = mode === 'flat';
  const arc = cssVar('--arc') || '#5EC8FF';
  const onImage = !flat;
  const label = onImage ? '#F4F7FB' : (dark ? '#9AA8BF' : '#3F4A5C');
  const halo = onImage ? 'rgba(0,0,0,0.75)' : (dark ? '#0B1220' : '#F4F1EA');
  const sources = {
    omt: { type: 'vector', url: OFM + '/planet' },
    lines: { type: 'geojson', data: lineData },
    aps: { type: 'geojson', data: apData },
    traffic: { type: 'geojson', data: trafficGeo() },
    trail: { type: 'geojson', data: trailGeo() }
  };
  const layers = [];
  if (flat) {
    layers.push({ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1A2233' : '#F4F1EA' } });
    layers.push({ id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': dark ? '#0B1220' : '#CFE0F2' } });
    layers.push({ id: 'borders', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': dark ? '#2F3B57' : '#C4BCAD', 'line-width': 0.8 } });
  } else {
    layers.push({ id: 'bg', type: 'background', paint: { 'background-color': mode === 'night' ? '#02040A' : '#0A2A4A' } });
    sources.sat = { type: 'raster', tiles: [mode === 'night' ? GIBS('VIIRS_Black_Marble', 'png') : GIBS('BlueMarble_NextGeneration', 'jpeg')], tileSize: 256, minzoom: 1, maxzoom: 8 };
    layers.push({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 200 } });
    if (mode === 'night') layers.push({ id: 'borders', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': 'rgba(150,180,220,0.25)', 'line-width': 0.7 } });
  }
  const name = ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];
  layers.push({ id: 'cities', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 3.6,
    filter: ['==', ['get', 'class'], 'city'],
    layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 3.6, 10, 8, 13], 'symbol-sort-key': ['coalesce', ['get', 'rank'], 10], 'text-padding': 10 },
    paint: { 'text-color': label, 'text-halo-color': halo, 'text-halo-width': 1.2, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 3.6, 0, 4.2, 0.85] } });
  const core = dark || onImage ? '#D8F3FF' : arc;
  const main = ['in', ['get', 'k'], ['literal', ['full', 'flown']]];
  layers.push(
    { id: 'l-halo', type: 'line', source: 'lines', filter: main, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': arc, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 12, 5, 18], 'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 16], 'line-opacity': 0.28 } },
    { id: 'l-glow', type: 'line', source: 'lines', filter: main, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': arc, 'line-width': 5, 'line-blur': 3, 'line-opacity': 0.55 } },
    { id: 'l-dim', type: 'line', source: 'lines', filter: ['==', ['get', 'k'], 'dim'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': arc, 'line-width': 1.4, 'line-opacity': 0.5, 'line-dasharray': [1, 2.5] } },
    { id: 'l-rest', type: 'line', source: 'lines', filter: ['==', ['get', 'k'], 'rest'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': arc, 'line-width': 1.8, 'line-opacity': 0.75, 'line-dasharray': [1, 2] } },
    { id: 'l-main', type: 'line', source: 'lines', filter: ['==', ['get', 'k'], 'full'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': arc, 'line-width': 2.2 } },
    { id: 'l-flown', type: 'line', source: 'lines', filter: ['==', ['get', 'k'], 'flown'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': core, 'line-width': 2.8 } },
    { id: 'ap-ring', type: 'circle', source: 'aps', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': core, 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.7 } },
    { id: 'ap-dot', type: 'circle', source: 'aps', paint: { 'circle-radius': ['case', ['==', ['get', 'sel'], 1], 6, ['==', ['get', 'pri'], 0], 4.5, 3.2], 'circle-color': core, 'circle-stroke-color': onImage || dark ? '#0B1220' : '#FFFFFF', 'circle-stroke-width': 1.5 } },
    { id: 'ap-hit', type: 'circle', source: 'aps', paint: { 'circle-radius': 18, 'circle-color': '#000', 'circle-opacity': 0.01 } },
    { id: 'ap-lbl', type: 'symbol', source: 'aps', layout: { 'text-field': ['get', 'code'], 'text-font': ['Noto Sans Bold'], 'text-size': ['case', ['==', ['get', 'pri'], 0], 11.5, 10.5], 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.75, 'text-justify': 'auto', 'text-allow-overlap': false, 'text-optional': true, 'text-padding': 3, 'symbol-sort-key': ['get', 'pri'], 'text-letter-spacing': 0.06 },
      paint: { 'text-color': onImage ? '#FFFFFF' : (dark ? '#CFE3FF' : '#18324F'), 'text-halo-color': onImage ? 'rgba(0,0,0,0.75)' : halo, 'text-halo-width': 1.3,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 1.8, ['case', ['==', ['get', 'pri'], 0], 1, 0], 2.4, ['case', ['==', ['get', 'pri'], 0], 1, 0.9]] } }
  );
  layers.push(
    { id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#FFC14D', 'line-width': 2.2, 'line-opacity': 0.9 } },
    { id: 'traffic-sel', type: 'circle', source: 'traffic', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 16, 'circle-color': 'rgba(255,193,77,0.18)', 'circle-stroke-color': '#FFC14D', 'circle-stroke-width': 1.5 } },
    { id: 'traffic', type: 'symbol', source: 'traffic', layout: { 'icon-image': 'tplane', 'icon-rotate': ['get', 'trk'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.42, 8, 0.62], 'symbol-sort-key': ['get', 'sel'] },
      paint: { 'icon-color': ['case', ['==', ['get', 'sel'], 1], '#FFC14D', onImage || dark ? '#F3F7FF' : '#18324F'], 'icon-halo-color': onImage || dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)', 'icon-halo-width': 1 } },
    { id: 'traffic-hit', type: 'circle', source: 'traffic', paint: { 'circle-radius': 14, 'circle-color': '#000', 'circle-opacity': 0.01 } }
  );
  return {
    version: 8, projection: { type: 'globe' },
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
    glyphs: OFM + '/fonts/{fontstack}/{range}.pbf',
    sources, layers
  };
}
function initMap() {
  if (map) return;
  if (!window.maplibregl) { $('#map-fallback').style.display = 'block'; return; }
  try {
    map = new maplibregl.Map({ container: 'map', style: buildStyle(), center: [10, 45], zoom: 1.1, minZoom: 0, maxZoom: 9, attributionControl: false, interactive: true, dragPan: true, scrollZoom: true, doubleClickZoom: true, touchZoomRotate: true, pitchWithRotate: false, dragRotate: false, keyboard: false, fadeDuration: 150 });
    map.on('movestart', (e) => { if (e && e.originalEvent) { userMoved = true; if (TR.follow) { TR.follow = false; paintPlaneCard(); } } });
  } catch (e) { map = null; $('#map-fallback').textContent = "This phone can't draw the 3D map"; $('#map-fallback').style.display = 'block'; return; }
  styleKey = globeMode() + currentTheme();
  if (map.touchZoomRotate && map.touchZoomRotate.disableRotation) map.touchZoomRotate.disableRotation();
  map.on('load', () => { mapReady = true; if (lastRoutes) drawRoutes(lastRoutes.routes, lastRoutes.opts); });
  map.on('click', 'ap-hit', (e) => {
    const ft = e.features && e.features[0]; const code = ft && ft.properties && ft.properties.code;
    if (code && AP[code] && location.hash !== '#/airport/' + code) location.hash = '#/airport/' + code;
  });
  map.on('styleimagemissing', (e) => { if (e.id === 'tplane' && !map.hasImage('tplane')) map.addImage('tplane', tplaneImage(), { sdf: true }); });
  map.on('style.load', () => { if (!map.hasImage('tplane')) map.addImage('tplane', tplaneImage(), { sdf: true }); trafficPaint(); });
  map.on('click', 'traffic-hit', (e) => { const ft = e.features && e.features[0]; if (ft) selectPlane(ft.properties.hex); });
  map.on('moveend', () => { if (db.settings.traffic) trafficSoon(); });
  map.on('error', (e) => {
    if (e && e.sourceId === 'sat' && globeMode() === 'night' && ++nightErrors > 6) { nightBroken = true; restyle(); }
  });
}
function restyle() {
  if (!map) return;
  const k = globeMode() + currentTheme();
  if (k === styleKey) { if (mapReady) { try { const arc = cssVar('--arc'); ['l-halo', 'l-glow', 'l-dim', 'l-rest', 'l-main'].forEach((id) => map.setPaintProperty(id, 'line-color', arc));  } catch (e) {} } return; }
  styleKey = k;
  map.setStyle(buildStyle(), { diff: false });
}
const setTiles = restyle;
function planeEl() {
  const el = document.createElement('div');
  el.className = 'plane-icon';
  el.innerHTML = '<svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true"><path d="M0,-11 L1.6,-3.5 L10,2 L10,3.8 L1.6,1.6 L1.2,7.5 L4.2,9.6 L4.2,10.8 L0,9.8 L-4.2,10.8 L-4.2,9.6 L-1.2,7.5 L-1.6,1.6 L-10,3.8 L-10,2 L-1.6,-3.5 Z" fill="currentColor"/></svg>';
  return el;
}

/* ---------- Live planes (like Flightradar), from the free ADS-B feeds ---------- */
const TR = { planes: new Map(), sel: null, follow: false, trail: [], routes: {}, timer: 0, glide: 0, busy: false, last: 0, soon: 0, note: '' };
function tplaneImage() {
  const S = 64, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d'); g.translate(S / 2, S / 2); g.scale(2.6, 2.6);
  g.fillStyle = '#fff';
  g.fill(new Path2D('M0,-11 L1.6,-3.5 L10,2 L10,3.8 L1.6,1.6 L1.2,7.5 L4.2,9.6 L4.2,10.8 L0,9.8 L-4.2,10.8 L-4.2,9.6 L-1.2,7.5 L-1.6,1.6 L-10,3.8 L-10,2 L-1.6,-3.5 Z'));
  return g.getImageData(0, 0, S, S);
}
function trafficGeo() {
  const now = Date.now(), feats = [];
  TR.planes.forEach((p, hex) => {
    // glide: move each plane along its heading since its last report (max 30 s ahead)
    const dt = Math.min(30, (now - p.at) / 1000), d = (p.gs || 0) * 1.852 / 3600 * dt; // km
    const tr = (p.trk || 0) * RAD, lat = p.lat + (d / 111.2) * Math.cos(tr), lon = p.lon + (d / (111.2 * Math.max(0.1, Math.cos(p.lat * RAD)))) * Math.sin(tr);
    p.vlat = lat; p.vlon = lon;
    feats.push({ type: 'Feature', properties: { hex, trk: p.trk || 0, sel: hex === TR.sel ? 1 : 0 }, geometry: { type: 'Point', coordinates: [lon, lat] } });
  });
  return { type: 'FeatureCollection', features: feats };
}
function trailGeo() {
  const p = TR.sel && TR.planes.get(TR.sel);
  const pts = TR.trail.slice(); if (p && p.vlat != null) pts.push([p.vlon, p.vlat]);
  return { type: 'FeatureCollection', features: pts.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }] : [] };
}
function trafficPaint() {
  if (!map || !mapReady) return;
  const s1 = map.getSource('traffic'), s2 = map.getSource('trail');
  if (s1) s1.setData(trafficGeo()); if (s2) s2.setData(trailGeo());
  if (TR.follow && TR.sel) { const p = TR.planes.get(TR.sel); if (p && p.vlat != null) map.easeTo({ center: [p.vlon, p.vlat], duration: 900, essential: true }); }
}
function trafficSoon() { clearTimeout(TR.soon); TR.soon = setTimeout(fetchTraffic, 350); }
function trafficButton() {
  const on = !!db.settings.traffic;
  return `<button class="round live-btn${on ? ' on' : ''}" data-act="traffic" aria-pressed="${on}" aria-label="Live planes ${on ? 'on' : 'off'}"><svg width="20" height="20" viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0,-11 L1.6,-3.5 L10,2 L10,3.8 L1.6,1.6 L1.2,7.5 L4.2,9.6 L4.2,10.8 L0,9.8 L-4.2,10.8 L-4.2,9.6 L-1.2,7.5 L-1.6,1.6 L-10,3.8 L-10,2 L-1.6,-3.5 Z" fill="currentColor"/></svg></button>`;
}
function setTrafficNote(t) { TR.note = t; const n = $('#traffic-note'); if (n) { n.textContent = t; n.hidden = !t; } }
async function fetchTraffic() {
  if (!db.settings.traffic || !map || !mapReady || document.body.classList.contains('no-map') || document.hidden) return;
  const z = map.getZoom();
  if (z < 4) { TR.planes.clear(); trafficPaint(); setTrafficNote('Zoom in to see live planes'); return; }
  if (TR.busy) return; TR.busy = true;
  try {
    const c = map.getCenter(), b = map.getBounds();
    const radiusNm = Math.min(250, Math.max(25, gcMiles({ lat: c.lat, lon: c.lng }, { lat: b.getNorth(), lon: b.getEast() }) * 0.868976));
    const urls = [`https://api.adsb.lol/v2/point/${c.lat.toFixed(3)}/${c.lng.toFixed(3)}/${Math.round(radiusNm)}`, `https://api.airplanes.live/v2/point/${c.lat.toFixed(3)}/${c.lng.toFixed(3)}/${Math.round(radiusNm)}`];
    let data = null;
    for (const u of urls) { try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) { data = await r.json(); break; } } catch (e) { /* try the next feed */ } }
    if (!data) { setTrafficNote('Live planes unavailable right now'); return; }
    const now = Date.now(), seen = new Set();
    const list = (data.ac || data.aircraft || []).filter((x) => x.lat != null && x.lon != null && x.alt_baro !== 'ground')
      .map((x) => Object.assign(x, { _d: Math.hypot(x.lat - c.lat, (x.lon - c.lng) * Math.cos(c.lat * RAD)) }))
      .sort((p, q) => p._d - q._d).slice(0, 300);
    list.forEach((x) => {
      const hex = x.hex; seen.add(hex);
      const at = now - Math.min(30, x.seen_pos || x.seen || 0) * 1000;
      TR.planes.set(hex, { hex, lat: x.lat, lon: x.lon, trk: x.track != null ? x.track : (x.true_heading || 0), gs: x.gs || 0, alt: typeof x.alt_baro === 'number' ? x.alt_baro : x.alt_geom, cs: (x.flight || '').trim(), t: x.t || '', r: x.r || '', at });
      if (hex === TR.sel) { TR.trail.push([x.lon, x.lat]); if (TR.trail.length > 200) TR.trail.shift(); }
    });
    TR.planes.forEach((p, hex) => { if (!seen.has(hex) && hex !== TR.sel) TR.planes.delete(hex); });
    setTrafficNote(list.length ? '' : 'No planes reported here');
    trafficPaint();
    if (TR.sel) paintPlaneCard();
  } finally { TR.busy = false; }
}
function startTraffic() {
  stopTraffic(true);
  if (!db.settings.traffic) return;
  fetchTraffic();
  TR.timer = setInterval(fetchTraffic, 5000);
  TR.glide = setInterval(trafficPaint, 1000);
}
function stopTraffic(keep) {
  clearInterval(TR.timer); clearInterval(TR.glide); TR.timer = TR.glide = 0;
  if (!keep) { TR.planes.clear(); closePlane(); trafficPaint(); setTrafficNote(''); }
}
async function routeFor(p) {
  if (!p.cs) return null;
  if (TR.routes[p.cs] !== undefined) return TR.routes[p.cs];
  TR.routes[p.cs] = null;
  try {
    const r = await fetch('https://api.adsb.lol/api/0/routeset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planes: [{ callsign: p.cs, lat: p.lat, lng: p.lon }] }) });
    const j = await r.json(); const x = Array.isArray(j) ? j[0] : null;
    const codes = x && (x._airport_codes_iata || x.airport_codes || '');
    if (codes && codes !== 'unknown') { const parts = codes.split('-'); TR.routes[p.cs] = { from: parts[0], to: parts[parts.length - 1], sure: x.plausible !== false && x.plausible !== 0 }; }
  } catch (e) { /* route stays unknown */ }
  return TR.routes[p.cs];
}
function selectPlane(hex) {
  const p = TR.planes.get(hex); if (!p) return;
  TR.sel = hex; TR.follow = false; TR.trail = [[p.lon, p.lat]];
  trafficPaint(); paintPlaneCard();
  routeFor(p).then(() => { if (TR.sel === hex) paintPlaneCard(); });
}
function closePlane() { TR.sel = null; TR.follow = false; TR.trail = []; const c = $('#plane-card'); if (c) c.hidden = true; trafficPaint(); }
function paintPlaneCard() {
  const c = $('#plane-card'), p = TR.sel && TR.planes.get(TR.sel);
  if (!c) return;
  if (!p) { c.hidden = true; return; }
  const u = db.settings.units, rt = TR.routes[p.cs];
  const alt = p.alt != null ? `${nf.format(p.alt)} ft` : '—';
  const spd = u === 'nm' ? `${nf.format(p.gs)} kt` : u === 'mi' ? `${nf.format(p.gs * 1.15078)} mph` : `${nf.format(p.gs * 1.15078)} mph · ${nf.format(p.gs)} kt`;
  const type = p.t ? (acType(p.t) || {}).name || p.t : '';
  const apName = (code) => (AP[code] ? AP[code].city : code);
  c.innerHTML = `<div class="between" style="gap:10px"><div style="min-width:0"><div class="row" style="gap:8px">${flap((p.cs || p.r || p.hex).toUpperCase().slice(0, 8), 'sm')}</div>
      <div class="muted" style="font-size:12px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc([type, p.r].filter(Boolean).join(' · ') || 'Unknown aircraft')}</div></div>
      <button class="round" data-act="planeClose" aria-label="Close" style="flex:none">${ICON.close}</button></div>
    <div style="font-size:15px;font-weight:800;margin-top:8px">${rt ? `${esc(rt.from)} → ${esc(rt.to)} <span class="muted" style="font-size:12px;font-weight:600">${esc(apName(rt.from))} → ${esc(apName(rt.to))}${rt.sure ? '' : ' · unconfirmed'}</span>` : `<span class="muted" style="font-size:13px;font-weight:600">${p.cs ? 'Route unknown' : 'No callsign'}</span>`}</div>
    <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:8px;margin-top:8px"><div class="stat"><span class="lbl">Altitude</span><span class="big num" style="font-size:15px;white-space:nowrap">${alt}</span></div><div class="stat"><span class="lbl">Speed</span><span class="big num" style="font-size:15px">${spd}</span></div></div>
    <button class="btn ${TR.follow ? '' : 'ghost'}" data-act="planeFollow" style="margin-top:8px;min-height:44px">${TR.follow ? 'Following — tap to stop' : 'Follow on map'}</button>`;
  c.hidden = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && db.settings.traffic) fetchTraffic(); });
window.SF_DEBUG = { TR, selectPlane };

/* routes: [{a, b, progress (0..1 or null), pos, dim}] */
function drawRoutes(routes, opts = {}) {
  lastRoutes = { routes, opts };
  const feats = [], aps = new Map(), bounds = [];
  let plane = null;
  const ls = (coords, k) => feats.push({ type: 'Feature', properties: { k }, geometry: { type: 'LineString', coordinates: coords.map((p) => [p[1], p[0]]) } });
  routes.forEach((r) => {
    const pts = gcPoints(r.a, r.b);
    pts.forEach((p) => bounds.push(p));
    if (r.pos || (r.progress != null && r.progress > 0 && r.progress < 1)) {
      let k, here, brg;
      if (r.pos) {
        let best = Infinity;
        pts.forEach((p, i) => { const dd = (p[0] - r.pos.lat) ** 2 + (p[1] - r.pos.lon) ** 2; if (dd < best) { best = dd; k = i; } });
        k = Math.min(pts.length - 2, Math.max(1, k));
        let lon = r.pos.lon; while (lon - pts[k][1] > 180) lon -= 360; while (lon - pts[k][1] < -180) lon += 360;
        here = [r.pos.lat, lon];
        brg = r.pos.track != null ? r.pos.track : bearing(pts[k - 1], pts[k + 1]);
        bounds.push(here);
      } else {
        k = Math.min(pts.length - 2, Math.max(1, Math.round(r.progress * (pts.length - 1))));
        here = pts[k];
        brg = bearing(pts[k - 1], pts[k + 1]);
      }
      ls(pts.slice(0, k).concat([here]), 'flown');
      ls([here].concat(pts.slice(k + 1)), 'rest');
      plane = { lng: here[1], lat: here[0], brg };
    } else ls(pts, r.dim ? 'dim' : 'full');
    [r.a, r.b].forEach((ap) => {
      const pri = r.dim ? 1 : 0, prev = aps.get(ap.code);
      if (prev && prev.properties.pri <= pri) return;
      aps.set(ap.code, { type: 'Feature', properties: { code: ap.code, pri: routes.length > 6 && !opts.sel ? 1 : pri, sel: opts.sel === ap.code ? 1 : 0 }, geometry: { type: 'Point', coordinates: [ap.lon, ap.lat] } });
    });
  });
  lineData = { type: 'FeatureCollection', features: feats };
  apData = { type: 'FeatureCollection', features: [...aps.values()] };
  if (!map) return;
  if (plane) {
    if (!planeMarker) planeMarker = new maplibregl.Marker({ element: planeEl(), rotationAlignment: 'map', pitchAlignment: 'map' });
    planeMarker.setLngLat([plane.lng, plane.lat]).setRotation(plane.brg);
    if (!planeMarker._map) planeMarker.addTo(map);
  } else if (planeMarker) { planeMarker.remove(); planeMarker = null; }
  if (!mapReady) return;
  try { map.getSource('lines').setData(lineData); map.getSource('aps').setData(apData); } catch (e) { /* style still loading */ }
  if (opts.fit !== false) fitTo(bounds, opts.force);
}
/* Fit the routes into the part of the screen the card leaves free.
   Works out the zoom from the globe's real size on screen rather than trusting fitBounds,
   which on the 3D globe tends to leave routes under the card or too zoomed in. */
const RAD = Math.PI / 180;
function fitTo(bounds, force) {
  if (!map || !mapReady) return;
  if (userMoved && !force) return;
  if (snap === 'full' && !document.body.classList.contains('no-map')) return;
  const H = appH(), W = appEl.offsetWidth || window.innerWidth;
  const safeTop = safeTopPx();
  const hasTopButtons = !!$('#top-left').children.length || !!$('#top-right').querySelector('a,button');
  const top = safeTop + (hasTopButtons ? 64 : 16);
  const bottom = Math.max(24, Math.min(visibleSheet() + 16, H - top - 140));
  const side = 28;
  const avail = Math.max(110, Math.min(W - 2 * side, H - top - bottom));
  const duration = reduceMotion() ? 0 : 700;
  map.resize();
  // MapLibre draws the globe with radius worldSize / (2π cos(lat)), worldSize = 512 · 2^zoom
  const zoomFor = (diameterPx, lat) => Math.log2(diameterPx * Math.PI * Math.cos(Math.max(-80, Math.min(80, lat)) * RAD) / 512);
  let cLat = 30, cLon = 20, spread = Math.PI / 2;
  if (bounds.length) {
    let x = 0, y = 0, z = 0;
    bounds.forEach(([la, lo]) => { const p = la * RAD, l = lo * RAD; x += Math.cos(p) * Math.cos(l); y += Math.cos(p) * Math.sin(l); z += Math.sin(p); });
    const n = Math.hypot(x, y, z);
    if (n > 1e-6) {
      cLat = Math.asin(z / n) / RAD; cLon = Math.atan2(y, x) / RAD;
      const cp = cLat * RAD, cl = cLon * RAD;
      spread = 0;
      bounds.forEach(([la, lo]) => {
        const p = la * RAD, l = lo * RAD;
        const c = Math.sin(cp) * Math.sin(p) + Math.cos(cp) * Math.cos(p) * Math.cos(l - cl);
        spread = Math.max(spread, Math.acos(Math.max(-1, Math.min(1, c))));
      });
    }
  }
  // A point at angle θ from the centre sits r·sin θ from the middle of the globe on screen.
  const s = spread >= Math.PI / 2 ? 1 : Math.max(Math.sin(spread), 0.004);
  let zoom = zoomFor(0.88 * avail / s, cLat);
  zoom = Math.min(zoom, 5.2);
  zoom = Math.max(zoom, zoomFor(Math.min(avail, 260), cLat) - 0.4);
  map.easeTo({ center: [cLon, cLat], zoom, bearing: 0, pitch: 0, padding: { top, bottom, left: 0, right: 0 }, duration, essential: true });
}
function refit() { if (lastRoutes && !userMoved) drawRoutes(lastRoutes.routes, Object.assign({}, lastRoutes.opts, { fit: true, force: false })); }

/* ---------- Screen size (iPhone home-screen apps report a short height) ---------- */
const appEl = $('#app');
const isStandalone = () => navigator.standalone === true || (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches));
function cssHeight(unit) {
  const p = document.createElement('div');
  p.style.cssText = `position:fixed;top:0;left:0;width:1px;height:100${unit};visibility:hidden;pointer-events:none`;
  document.body.appendChild(p);
  const h = p.offsetHeight; p.remove(); return h;
}
function safeTopPx() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden';
  document.body.appendChild(p); const h = p.offsetHeight; p.remove(); return h;
}
function setAppHeight() {
  const inner = Math.max(window.innerHeight, document.documentElement.clientHeight);
  const vh = cssHeight('vh');
  let h = inner;
  // Home-screen apps on iPhone can report a height that is short by the status bar.
  // Other apps of Samer's use 100vh and fill the screen, so trust 100vh whenever there is no browser toolbar in the way.
  if (isStandalone() || (vh > inner && vh - inner < 90)) {
    h = Math.max(inner, vh);
    if (isStandalone()) {
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      const sh = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
      h = Math.max(h, sh);
    }
  }
  document.documentElement.style.setProperty('--app-h', h + 'px');
}
setAppHeight();
const appH = () => appEl.offsetHeight || window.innerHeight;

/* ---------- Sheet ---------- */
const sheet = $('#sheet'), grab = $('#grab');
let snap = 'half', snaps = { full: 0, half: 0, peek: 0 };
function computeSnaps() {
  const H = sheet.offsetHeight, vh = appH();
  snaps = { full: 0, half: Math.max(0, H - Math.round(vh * 0.52)), peek: Math.max(0, H - 190) };
}
function setSnap(s, anim = true) {
  snap = s;
  computeSnaps();
  sheet.style.transition = '';
  sheet.classList.toggle('anim', anim);
  sheet.style.transform = `translateY(${snaps[s]}px)`;
  sheet.style.setProperty('--off', snaps[s] + 'px');
}
function visibleSheet() {
  if (document.body.classList.contains('no-map')) return 0;
  computeSnaps();
  return sheet.offsetHeight - (snaps[snap] || 0);
}
/* Dragging the card: follows the finger 1:1 (drawn once per frame), stretches a little past the ends,
   and on release goes to the stop you flicked towards, with a quick ease that matches the speed. */
let drag = null, dragRaf = 0;
const SNAP_ORDER = ['full', 'half', 'peek'];
function rubber(v, lo, hi) { if (v < lo) return lo - Math.sqrt(lo - v) * 3; if (v > hi) return hi + Math.sqrt(v - hi) * 3; return v; }
function paintDrag() { dragRaf = 0; if (drag) sheet.style.transform = `translateY(${drag.cur}px)`; }
function dragStart(y) {
  computeSnaps();
  sheet.classList.remove('anim'); sheet.style.transition = 'none';
  const st = getComputedStyle(sheet).transform; let now = snaps[snap];
  if (st && st !== 'none') { const m = st.match(/matrix.*\((.+)\)/); if (m) { const p = m[1].split(','); now = parseFloat(p[p.length === 6 ? 5 : 13]) || now; } }
  drag = { y, start: now, cur: now, moved: false, samples: [[performance.now(), y]] };
}
function dragMove(y) {
  if (!drag) return;
  const dy = y - drag.y;
  if (Math.abs(dy) > 4) drag.moved = true;
  drag.cur = rubber(drag.start + dy, 0, snaps.peek);
  const t = performance.now(); drag.samples.push([t, y]); while (drag.samples.length > 2 && t - drag.samples[0][0] > 90) drag.samples.shift();
  if (!dragRaf) dragRaf = requestAnimationFrame(paintDrag);
}
function settleTo(s, velocity) {
  const from = drag ? drag.cur : snaps[snap];
  snap = s; computeSnaps();
  const to = snaps[s], dist = Math.abs(to - from);
  const ms = reduceMotion() ? 0 : Math.round(Math.max(180, Math.min(420, dist / Math.max(0.9, Math.abs(velocity || 0) * 1.4) + 120)));
  sheet.style.transition = ms ? `transform ${ms}ms cubic-bezier(.22,.9,.3,1)` : 'none';
  sheet.style.transform = `translateY(${to}px)`;
  sheet.style.setProperty('--off', to + 'px');
}
function endDrag(cancel) {
  if (!drag) return;
  const d = drag;
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
  const was = snap;
  const s0 = d.samples[0], s1 = d.samples[d.samples.length - 1];
  const v = s1 && s0 && s1[0] > s0[0] ? (s1[1] - s0[1]) / (s1[0] - s0[0]) : 0; // px per ms, + is down
  let best;
  if (!d.moved) best = cancel ? snap : (snap === 'full' ? 'half' : 'full');
  else if (Math.abs(v) > 0.45) {
    // a flick: go one stop in that direction from where the card is now
    const pos = d.cur, stops = SNAP_ORDER.map((k) => [k, snaps[k]]);
    best = v > 0 ? (stops.find(([, y]) => y > pos + 8) || stops[2])[0] : ([...stops].reverse().find(([, y]) => y < pos - 8) || stops[0])[0];
  } else {
    const aim = d.cur + v * 160;
    best = SNAP_ORDER.reduce((b, k) => (Math.abs(snaps[k] - aim) < Math.abs(snaps[b] - aim) ? k : b), 'full');
  }
  settleTo(best, v);
  drag = null;
  if (best !== was && best !== 'full') setTimeout(refit, 80);
}
grab.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('no-map')) return;
  if (e.target.closest('button,a,input,select,label')) return;
  dragStart(e.clientY);
  try { grab.setPointerCapture(e.pointerId); } catch (_) {}
});
grab.addEventListener('pointermove', (e) => dragMove(e.clientY));
grab.addEventListener('pointerup', () => endDrag(false));
grab.addEventListener('pointercancel', () => endDrag(true));
/* Dragging from the card's content: moves the card unless it's fully open and you're scrolling the list. */
(() => {
  const content = $('#content');
  let t0 = null, mode = null;
  content.addEventListener('touchstart', (e) => {
    if (document.body.classList.contains('no-map') || e.touches.length !== 1) { t0 = null; return; }
    t0 = { y: e.touches[0].clientY, x: e.touches[0].clientX }; mode = null;
  }, { passive: true });
  content.addEventListener('touchmove', (e) => {
    if (!t0) return;
    const y = e.touches[0].clientY, dy = y - t0.y, dx = e.touches[0].clientX - t0.x;
    if (!mode) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      if (Math.abs(dx) > Math.abs(dy)) { mode = 'none'; return; }
      const atTop = content.scrollTop <= 0;
      mode = (snap !== 'full' || (atTop && dy > 0)) ? 'sheet' : 'none';
      if (mode === 'sheet') { dragStart(t0.y); drag.moved = true; }
    }
    if (mode === 'sheet') { e.preventDefault(); dragMove(y); }
  }, { passive: false });
  const end = () => { if (mode === 'sheet') endDrag(false); t0 = null; mode = null; };
  content.addEventListener('touchend', end); content.addEventListener('touchcancel', end);
})();
function onResize() { setAppHeight(); if (!document.body.classList.contains('no-map')) setSnap(snap, false); moveTabPill(pillTab); if (map) { map.resize(); if (lastRoutes) drawRoutes(lastRoutes.routes, Object.assign({}, lastRoutes.opts, { fit: true })); } }
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

/* ---------- Layout + toast ---------- */
const ICON = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  fit: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  edit: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  plane: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(45deg)"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>'
};
let mapRefresher = null;
function layout({ useMap = true, tabs = true, snapTo = 'half', left = '', right = '', tab = '' }) {
  document.body.classList.toggle('no-map', !useMap);
  document.body.classList.toggle('no-tabs', !tabs);
  $('#top-left').innerHTML = left;
  $('#top-right').innerHTML = right;
  $$('#tabbar .tab').forEach((t) => { if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  moveTabPill(tab);
  if (navDir != null) userMoved = false;
  mapRefresher = null;
  if (posTimer) { clearInterval(posTimer); posTimer = null; }
  const wasMap = !document.body.dataset.nomap;
  document.body.dataset.nomap = useMap ? '' : '1';
  if (useMap) {
    initMap(); setSnap(snapTo, navDir != null && wasMap && !reduceMotion());
    $('#map-tools').innerHTML = trafficButton();
    if (db.settings.traffic && !TR.timer) startTraffic();
  } else { sheet.classList.remove('anim'); sheet.style.transition = ''; sheet.style.transform = 'none'; stopTraffic(true); closePlane(); }
  $('#content').scrollTop = 0;
}
let navDir = null, prevScreen = null, pillTab = null;
function moveTabPill(tab) {
  const pillEl = $('#tabpill'), t = tab && $(`#tabbar .tab[data-tab="${tab}"]`);
  if (!pillEl) return;
  if (!t) { pillEl.style.opacity = '0'; pillTab = null; return; }
  const place = () => { pillEl.style.left = (t.offsetLeft + 4) + 'px'; pillEl.style.width = (t.offsetWidth - 8) + 'px'; pillEl.style.opacity = '1'; };
  if (pillTab && pillTab !== tab && !reduceMotion()) {
    place();
    pillEl.classList.remove('squash'); void pillEl.offsetWidth; pillEl.classList.add('squash');
    t.classList.remove('hop'); void t.offsetWidth; t.classList.add('hop');
  } else {
    const tr = pillEl.style.transition; pillEl.style.transition = 'none'; place(); void pillEl.offsetWidth; pillEl.style.transition = tr;
  }
  pillTab = tab;
}
function applyEnter(dir, contentOnly) {
  if (!dir || reduceMotion()) return;
  const els = contentOnly ? [$('#content')] : [$('#grab-content'), $('#content')];
  els.forEach((el) => { el.classList.remove('a-sl', 'a-sr', 'a-up', 'a-fade'); void el.offsetWidth; el.classList.add('a-' + dir); });
  const host = $('#content').firstElementChild;
  if (host && host.children.length > 1) {
    [...host.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10)));
    host.classList.remove('stg'); void host.offsetWidth; host.classList.add('stg');
  }
}
let toastTimer = null;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); appEl.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}
const pill = (st) => `<span class="pill ${st.cls}">${esc(st.label)}</span>`;

/* ---------- Views ---------- */
let homeTab = 'upcoming', ppPeriod = 'all';

function home() {
  layout({ tab: 'home', snapTo: 'half', right: `<button class="round" data-act="fit" aria-label="Re-centre the globe">${ICON.fit}</button>` });
  const now = Date.now();
  const all = flightsD();
  const upcoming = all.filter((f) => f.arr > now).sort((a, b) => a.dep - b.dep);
  const past = all.filter((f) => f.arr <= now).sort((a, b) => b.dep - a.dep);
  $('#grab-content').innerHTML = `
    <div class="between" style="margin-bottom:12px">
      <div><div class="eyebrow">${upcoming.length} upcoming · ${past.length} flown</div><h1>My Flights</h1></div>
      <a class="round" href="#/add" aria-label="Add flight" style="background:var(--card);box-shadow:none">${ICON.plus}</a>
    </div>
    <div class="seg" role="group" aria-label="Show">
      <button data-act="homeTab" data-v="upcoming" aria-pressed="${homeTab === 'upcoming'}">Upcoming</button>
      <button data-act="homeTab" data-v="past" aria-pressed="${homeTab === 'past'}">Past</button>
    </div>`;
  let html = '';
  if (homeTab === 'upcoming') {
    if (!upcoming.length) {
      html = `<div class="card empty"><div style="font-size:17px;font-weight:800">No upcoming flights</div>
        <div class="note">Add a flight from your booking and it will show here with a countdown, gate and the route on the map.</div>
        <a class="btn" href="#/add">${ICON.plus}Add flight</a>
        ${db.flights.some((f) => f.demo) ? '' : '<button class="btn ghost" data-act="demo">Try it with demo flights</button>'}</div>`;
    } else {
      html = heroCard(upcoming[0]);
      if (upcoming.length > 1) html += `<div class="eyebrow" style="margin:18px 4px 10px">Later</div><div class="stack" style="gap:8px">${upcoming.slice(1).map(rowHTML).join('')}</div>`;
    }
    drawRoutes(upcoming.map((f, i) => ({ a: f.A, b: f.B, progress: status(f, now).key === 'air' ? progress(f, now) : null, dim: i > 0 })));
    if (upcoming.some((f) => f.dep < now + 86400000)) mapRefresher = () => drawRoutes(upcoming.map((f, i) => ({ a: f.A, b: f.B, progress: status(f).key === 'air' ? progress(f) : null, dim: i > 0 })), { fit: false });
  } else {
    if (!past.length) html = `<div class="card empty"><div style="font-size:17px;font-weight:800">No past flights yet</div><div class="note">Flights move here once they land. You can also add older trips for your Passport.</div><a class="btn ghost" href="#/add/past">${ICON.plus}Add a past flight</a></div>`;
    else {
      let yr = null;
      past.forEach((f) => {
        const y = yearOf(f);
        if (y !== yr) { html += `<div class="eyebrow" style="margin:${yr ? 18 : 4}px 4px 10px">${y}</div>`; yr = y; }
        html += `<div style="margin-bottom:8px">${rowHTML(f)}</div>`;
      });
    }
    drawRoutes(dedupeRoutes(past).map((r) => ({ a: r.a, b: r.b, progress: null, dim: false })));
  }
  $('#content').innerHTML = `<div style="padding-top:14px">${html}</div>`;
}
function heroCard(f) {
  const now = Date.now(), st = status(f, now), air = st.key === 'air';
  const target = air ? f.arr : f.dep;
  return `<a class="card" href="#/flight/${esc(f.id)}" aria-label="${esc(f.from + ' to ' + f.to + ', ' + st.label)}">
    <div class="row"><div class="badge">${esc(codeOf(f))}</div>
      <div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800">${f.from} → ${f.to}${f.demo ? ' <span class="pill grey" style="font-size:10px;padding:3px 7px">Demo</span>' : ''}</div><div class="muted" style="font-size:12px">${esc(titleOf(f))} · ${fmt(f.dep, f.A.tz, 'day')}</div></div>
      ${pill(st)}</div>
    <div class="between">
      <div style="display:flex;flex-direction:column;gap:4px"><span class="lbl">${air ? 'Lands in' : 'Departs in'}</span>${flap(cd(target - now), 'sm', `data-cd="${target}"`)}</div>
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="lbl">${air ? 'Arr gate' : 'Gate'}</span>${flap(gateStr(air ? f.arrGate : f.depGate), 'sm')}</div>
    </div>
    <div class="between num" style="font-size:13px"><span><b>${fmt(f.dep, f.A.tz, 'time')}</b> <span class="muted">${esc(f.A.city)}</span></span><span><span class="muted">${esc(f.B.city)}</span> <b>${fmt(f.arr, f.B.tz, 'time')}</b>${plusDays(f)}</span></div>
    ${air ? `<div class="bar"><i data-prog="${f.dep},${f.arr}" style="width:${(progress(f, now) * 100).toFixed(1)}%"></i></div>` : ''}
  </a>`;
}
function rowHTML(f) {
  return `<a class="list-row" href="#/flight/${esc(f.id)}">
    <div class="date"><span>${fmt(f.dep, f.A.tz, 'mon').toUpperCase()}</span><span>${fmt(f.dep, f.A.tz, 'dnum')}</span></div>
    <div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800">${f.from} → ${f.to}${f.demo ? ' <span class="pill grey" style="font-size:10px;padding:3px 7px">Demo</span>' : ''}</div>
      <div class="muted" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(titleOf(f))} · ${durStr(f.dur)}</div></div>
    <span class="timechip">${fmt(f.dep, f.A.tz, 'time')}</span></a>`;
}
function dedupeRoutes(list) {
  const m = new Map();
  list.forEach((f) => {
    const k = [f.from, f.to].sort().join('-');
    if (!m.has(k)) m.set(k, { a: f.A, b: f.B, n: 0, key: k });
    m.get(k).n++;
  });
  return [...m.values()];
}

let posTimer = null;
function timeHTML(best, sched, tz) {
  const b = fmt(best, tz, 'time');
  if (Math.abs(best - sched) < 60000) return `<b>${b}</b>`;
  return `<s class="muted">${fmt(sched, tz, 'time')}</s> <b style="color:${best > sched ? 'var(--amber)' : 'var(--green)'}">${b}</b>`;
}
function liveLine(f) {
  if (!f.flightNo || f.demo) return '';
  if (!hasKey()) return `<div class="between" style="font-size:12px"><span class="muted">Live status is off</span><a href="#/settings" style="font-weight:700">Turn on in Settings</a></div>`;
  const L = f.live;
  const when = L && L.fetchedAt ? (L.notFound ? `Not found in live data · ${agoStr(Date.now() - L.fetchedAt)}` : `Live · updated ${agoStr(Date.now() - L.fetchedAt)}`) : 'Not checked yet';
  return `<div class="between" style="font-size:12px"><span class="muted" id="live-when">${esc(when)}</span><button class="pill blue" style="border:none;min-height:32px" data-act="refresh" data-v="${esc(f.id)}">Refresh</button></div>`;
}
function freshPos(f) { const p = f.live && f.live.pos; return p && Date.now() - p.at < 20 * 60000 && !p.ground ? p : null; }
const AL_ICON = {
  delay: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4M9 2h6"/></svg>',
  gate: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-6h6v6"/></svg>',
  landed: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 20h20"/><path d="M4 14l5 1 6-6 3 .5-4 6 4 1"/></svg>',
  belt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V4h6v3"/></svg>',
  cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>'
};
const AL_TONE = { delay: 'amber', gate: 'amber', landed: 'green', belt: 'blue' };
function alertIcon(type) { return `<span class="al-ic ${AL_TONE[type] || 'blue'}">${AL_ICON[type] || AL_ICON.gate}</span>`; }
function whenStr(t) { const d = Date.now() - t; return d < 86400000 ? agoStr(d) : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
function happenedHTML(f) {
  const list = db.alerts.filter((x) => x.flightId === f.id).slice(0, 8);
  if (!list.length) return '';
  const fresh = list.filter((x) => !x.read).length;
  return `<div class="between" style="margin-top:4px"><span class="lbl">What's happened</span>${fresh ? `<span class="lbl" style="color:var(--blue)">${fresh} new</span>` : ''}</div>
    <ol class="happened">${list.map((x) => `<li>${alertIcon(x.type)}<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800">${esc(x.title)}</div><div class="muted" style="font-size:12px">${esc(x.sub || '')}</div></div><span class="muted num" style="font-size:11px">${whenStr(x.at)}</span></li>`).join('')}</ol>`;
}
function leaveCard(f, st) {
  if (f.demo || f.friend || !db.settings.alerts.leave || !(st.key === 'sched' || st.key === 'soon') || f.dep < Date.now()) return '';
  const h = leaveHOf(f), al = db.settings.alerts;
  const leaveAt = f.dep - h * 3600000;
  return `<div class="card" style="gap:10px"><div class="between"><h2>Leave for the airport</h2><span class="num" style="font-size:13px;font-weight:800">${al.leave ? `by ${fmt(leaveAt, f.A.tz, 'time')}` : ''}</span></div>
    <div class="row" style="gap:6px"><div class="chips" role="group" aria-label="How long before take-off">${[2, 2.5, 3, 4].map((v) => `<button data-act="leave" data-v="${esc(f.id)}|${v}" aria-pressed="${h === v}">${leaveLabel(v)}</button>`).join('')}</div>
      <button class="round cal" data-act="cal" data-v="${esc(f.id)}" aria-label="Add reminders to Calendar" style="margin-left:auto">${AL_ICON.cal}</button></div>
    <div class="note">Before take-off${f.live && f.live.depBest ? ', moved with any delay' : ''}. Tap the calendar to get the reminder${al.checkin ? ' and a check-in alert 24h before' : ''} on your phone, even with the app closed.</div></div>`;
}

/* ---------- Aircraft: types, best guesses, photos ---------- */
// [test on the model text, key, display name, Wikipedia page for the photo]
const AC_TYPES = [
  [/A318/i, 'A318', 'Airbus A318', 'Airbus_A318'],
  [/A319.*neo|A19N/i, 'A319N', 'Airbus A319neo', 'Airbus_A320neo_family'],
  [/A320.*neo|A20N/i, 'A20N', 'Airbus A320neo', 'Airbus_A320neo_family'],
  [/A321.*neo|A21N/i, 'A21N', 'Airbus A321neo', 'Airbus_A321neo'],
  [/A319/i, 'A319', 'Airbus A319', 'Airbus_A319'],
  [/A320/i, 'A320', 'Airbus A320', 'Airbus_A320_family'],
  [/A321/i, 'A321', 'Airbus A321', 'Airbus_A321'],
  [/A220|BCS[13]|CS[13]00/i, 'A220', 'Airbus A220', 'Airbus_A220'],
  [/A330.*neo|A33[89]|A330-[89]00/i, 'A330N', 'Airbus A330neo', 'Airbus_A330neo'],
  [/A330|A33[23]/i, 'A330', 'Airbus A330', 'Airbus_A330'],
  [/A340/i, 'A340', 'Airbus A340', 'Airbus_A340'],
  [/A350|A35K|A359/i, 'A350', 'Airbus A350', 'Airbus_A350'],
  [/A380|A388/i, 'A380', 'Airbus A380', 'Airbus_A380'],
  [/737.*MAX|737-?[89]\s?MAX|B3[89]M|737-8200/i, 'B38M', 'Boeing 737 MAX', 'Boeing_737_MAX'],
  [/737-?[6789]00|B73[6789]|737NG/i, 'B738', 'Boeing 737-800', 'Boeing_737_Next_Generation'],
  [/737/i, 'B737', 'Boeing 737', 'Boeing_737'],
  [/747/i, 'B747', 'Boeing 747', 'Boeing_747'],
  [/757/i, 'B757', 'Boeing 757', 'Boeing_757'],
  [/767/i, 'B767', 'Boeing 767', 'Boeing_767'],
  [/777|B77[23LW]/i, 'B777', 'Boeing 777', 'Boeing_777'],
  [/787|B78[89X]/i, 'B787', 'Boeing 787 Dreamliner', 'Boeing_787_Dreamliner'],
  [/E-?1[79]5|E-?1[79]0|E[79]\dE?|ERJ-?1[79]|Embraer 1[79]/i, 'EJET', 'Embraer E-Jet', 'Embraer_E-Jet_family'],
  [/ATR/i, 'ATR', 'ATR 72', 'ATR_72'],
  [/Q400|DH8|Dash 8/i, 'DH8D', 'Dash 8 Q400', 'De_Havilland_Canada_Dash_8'],
  [/CRJ/i, 'CRJ', 'Bombardier CRJ', 'Bombardier_CRJ700_series']
];
function acType(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const [re, key, name, wiki] of AC_TYPES) if (re.test(s)) return { key, name, wiki };
  return { key: s.toUpperCase(), name: s, wiki: '' };
}
// What an airline usually flies, by airline and (sometimes) route and year. Used only when nothing better is known.
function guessAircraft(f) {
  const al = (f.flightNo || '').slice(0, 2).toUpperCase(), y = +String(f.depDate).slice(0, 4);
  const long = f.mi > 2500, has = (c) => f.from === c || f.to === c;
  const G = {
    ME: () => (has('LHR') || has('CDG') ? (y < 2022 ? 'A330' : 'A321neo') : 'A320neo'),
    TK: () => (long ? 'B777' : 'A321neo'), PC: () => 'A320neo', VF: () => 'B737-800',
    BA: () => (long ? 'B787' : 'A320'), U2: () => 'A320', FR: () => 'B737-800', RK: () => 'B737-800',
    VY: () => 'A320', SU: () => 'A320', SK: () => 'A320neo', UA: () => (has('LHR') || has('GVA') || has('BRU') || has('CDG') ? 'B767' : 'B737-800'),
    SV: () => (long ? 'B787' : 'A320neo'), A3: () => 'A320neo', RJ: () => (long ? 'B787' : 'A320'), AZ: () => 'A320neo',
    RO: () => 'B737-700', EK: () => (long ? 'A380' : 'B777'), QR: () => (long ? 'B787' : 'A320'), W6: () => 'A321neo', LH: () => 'A320', AF: () => 'A320', KL: () => 'B737-800', LX: () => 'A220', EW: () => 'A320', TP: () => 'A320neo', IB: () => 'A320', LS: () => 'B737-800'
  };
  return G[al] ? G[al]() : '';
}
// Type for stats: what's recorded, else the best guess (marked likely)
function planeOf(f) {
  if (f.aircraft) { const t = acType(f.aircraft); if (t) return Object.assign({ likely: false }, t); }
  const g = guessAircraft(f); const t = g && acType(g);
  return t ? Object.assign({ likely: true }, t) : null;
}
// Photos: Wikipedia's lead image for the type, with the Commons credit. Kept on the phone after the first load.
const IMG_KEY = 'samflyer.img';
let imgCache = {}; try { imgCache = JSON.parse(localStorage.getItem(IMG_KEY)) || {}; } catch (e) { imgCache = {}; }
const imgPending = {};
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
async function planePhoto(wiki) {
  if (!wiki) return null;
  const hit = imgCache[wiki];
  if (hit && (hit.src || Date.now() - (hit.at || 0) < 86400000)) return hit.src ? hit : null;
  if (imgPending[wiki]) return imgPending[wiki];
  imgPending[wiki] = (async () => {
    try {
      const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail|name&pithumbsize=640&redirects=1&titles=${encodeURIComponent(wiki)}`);
      const j = await r.json();
      const pg = Object.values((j.query && j.query.pages) || {})[0] || {};
      if (!pg.thumbnail) { imgCache[wiki] = { at: Date.now() }; return null; }
      const rec = { src: pg.thumbnail.source, file: pg.pageimage || '', credit: '', at: Date.now() };
      if (rec.file) {
        try {
          const r2 = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=extmetadata&titles=${encodeURIComponent('File:' + rec.file)}`);
          const j2 = await r2.json();
          const m = ((Object.values((j2.query && j2.query.pages) || {})[0] || {}).imageinfo || [{}])[0].extmetadata || {};
          const who = stripHtml(m.Artist && m.Artist.value).slice(0, 40), lic = stripHtml(m.LicenseShortName && m.LicenseShortName.value);
          rec.credit = [who, lic].filter(Boolean).join(' · ');
        } catch (e) { /* credit stays generic */ }
      }
      imgCache[wiki] = rec;
      try { localStorage.setItem(IMG_KEY, JSON.stringify(imgCache)); } catch (e) {}
      return rec;
    } catch (e) { return null; } finally { delete imgPending[wiki]; }
  })();
  return imgPending[wiki];
}
function fillPhotos(root) {
  $$('[data-photo]', root || document).forEach(async (box) => {
    const rec = await planePhoto(box.dataset.photo);
    if (!rec || !box.isConnected || box.querySelector('img')) return;
    const img = new Image(); img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onload = () => box.classList.add('loaded');
    img.src = rec.src;
    box.prepend(img);
    const c = box.querySelector('.credit-ph'); if (c) c.textContent = (rec.credit ? rec.credit + ' · ' : '') + 'Wikimedia Commons';
  });
}
/* Look up the real plane (type + tail number) for past flights, one at a time */
async function lookupAircraft(id) {
  const f = db.flights.find((x) => x.id === id);
  if (!f || !f.flightNo) return false;
  const list = await adb(`/flights/number/${encodeURIComponent(f.flightNo)}/${f.depDate}?withAircraftImage=false&withLocation=false&dateLocalRole=Departure`);
  const arr = Array.isArray(list) ? list : [list];
  const m = arr.find((x) => { const d = x.departure && x.departure.airport, ar = x.arrival && x.arrival.airport; return d && ar && d.iata === f.from && ar.iata === f.to; }) || (arr.length === 1 ? arr[0] : null);
  const ac = m && m.aircraft;
  f.acTried = Date.now();
  if (ac && (ac.model || ac.reg)) {
    if (ac.model && !f.aircraft) { f.aircraft = ac.model; f.acSrc = 'live'; }
    if (ac.reg && !f.reg) f.reg = ac.reg.toUpperCase();
    save(); return true;
  }
  save(); return false;
}
let lookupRun = null;

/* ---------- Friends ---------- */
const AV_COLS = ['#FFC14D', '#7EE0A1', '#B9A6FF', '#FF9C8A', '#6FD3FF', '#F5A3D8', '#C8E66B'];
function avatarHTML(name, size = 40) {
  const n = String(name || '?').trim(); let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const ini = n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return `<span class="av" aria-hidden="true" style="width:${size}px;height:${size}px;border-radius:${size / 2}px;background:${AV_COLS[h % AV_COLS.length]}">${esc(ini)}</span>`;
}
let friendsFilter = 'all';
function friendsView() {
  layout({ tab: 'friends', snapTo: 'half' });
  const now = Date.now();
  const all = friendsD().map((f) => Object.assign(f, { st: status(f, now) }));
  const groupOf = (f) => (f.st.key === 'air' ? 'air' : (f.arr <= now || f.st.key === 'landed' || f.st.key === 'cancel' || f.st.key === 'divert') ? 'landed' : 'up');
  const recentCut = now - 3 * 86400000;
  let list = all.filter((f) => friendsFilter === 'all' ? (groupOf(f) !== 'landed' || f.arr > recentCut) : groupOf(f) === friendsFilter);
  const rank = { air: 0, up: 1, landed: 2 };
  list.sort((p, q) => rank[groupOf(p)] - rank[groupOf(q)] || (groupOf(p) === 'landed' ? q.arr - p.arr : p.dep - q.dep));
  $('#grab-content').innerHTML = `<div class="between" style="padding-bottom:8px"><h1>Friends</h1><a class="round addbtn" href="#/friends/add" aria-label="Add a friend's flight">${ICON.plus}</a></div>
    <div class="chips" role="group" aria-label="Show">${[['all', 'All'], ['air', 'In the air'], ['up', 'Upcoming'], ['landed', 'Landed']].map(([k, l]) => `<button data-act="friendsFilter" data-v="${k}" aria-pressed="${friendsFilter === k}">${l}</button>`).join('')}</div>`;
  const when = (f) => {
    const g = groupOf(f);
    if (g === 'air') return `lands ${fmt(f.arr, f.B.tz, 'time')}`;
    if (g === 'landed') return f.st.key === 'landed' ? `landed ${agoStr(now - f.arr)}` : f.st.label;
    return `${fmt(f.dep, f.A.tz, 'day')} ${fmt(f.dep, f.A.tz, 'time')}`;
  };
  const pillFor = (f) => { const g = groupOf(f); if (g === 'up' && !/late|delay/i.test(f.st.label) && f.st.key !== 'soon') return `<span class="pill grey">${esc(fmt(f.dep, f.A.tz, 'short'))}</span>`; return pill(f.st); };
  $('#content').innerHTML = `<div class="stack">
    ${list.length ? `<ul class="flist">${list.map((f) => `<li><a href="#/flight/${esc(f.id)}">${avatarHTML(f.friend)}<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800">${f.from} → ${f.to}</div><div class="muted" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.friend)} · ${esc(prettyNo(f) || 'Flight')} · ${esc(when(f))}</div></div>${pillFor(f)}</a></li>`).join('')}</ul>`
      : `<div class="card empty"><div style="font-size:16px;font-weight:800">${all.length ? 'Nothing here' : 'No friends\u2019 flights yet'}</div><div class="note">${all.length ? 'Try another filter.' : 'Add a friend\u2019s flight by its number and date to follow it here.'}</div>${all.length ? '' : `<a class="btn" href="#/friends/add">${ICON.plus}Add a friend\u2019s flight</a>`}</div>`}
    <div class="note">Friends' flights refresh about hourly on travel day, every 30 min in the air, and once after landing — so they use only a few lookups each. They don't count in your Passport.</div>
  </div>`;
  const shown = list.filter((f) => groupOf(f) !== 'landed');
  const routesAt = (t) => (shown.length ? shown : list).slice(0, 12).map((f, i) => ({ a: f.A, b: f.B, progress: groupOf(f) === 'air' ? progress(f, t) : null, pos: groupOf(f) === 'air' ? freshPos(f) : null, dim: groupOf(f) === 'landed' || (groupOf(f) === 'up' && i > 2) }));
  drawRoutes(routesAt(now));
  if (shown.some((f) => groupOf(f) === 'air')) mapRefresher = () => drawRoutes(routesAt(Date.now()), { fit: false });
}

/* ---------- Airport (tap one on the globe) ---------- */
const regionName = (() => { try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); return (cc) => { try { return dn.of(cc) || cc; } catch (e) { return cc; } }; } catch (e) { return (cc) => cc; } })();
function airportView(code) {
  const A = AP[code];
  if (!A) { location.hash = '#/'; return; }
  const back = prevHash && !prevHash.startsWith('#/airport') ? prevHash : '#/';
  layout({ tabs: false, snapTo: 'half', left: `<a class="round" href="${esc(back)}" aria-label="Close airport">${ICON.close}</a>` });
  const now = Date.now();
  const touch = (f) => f.from === code || f.to === code;
  const mine = flightsD().filter(touch), friends = friendsD().filter(touch);
  const up = mine.concat(friends).filter((f) => f.arr > now).sort((p, q) => p.dep - q.dep).slice(0, 5);
  const before = mine.filter((f) => f.arr <= now).sort((p, q) => q.dep - p.dep).slice(0, 5);
  const diffH = (tzOffset(now, A.tz) - tzOffset(now, HOME_TZ)) / 3600000;
  const diff = diffH === 0 ? 'Same' : (diffH > 0 ? '+' : '−') + (Math.abs(diffH) % 1 ? Math.abs(diffH).toFixed(1).replace('.5', '½') : Math.abs(diffH)) + 'h';
  $('#grab-content').innerHTML = `<div class="row" style="gap:12px;padding-bottom:6px">${flap(code, 'md')}<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800">${esc(A.name)}</div><div class="muted" style="font-size:12px">${esc(A.city)} · ${esc(regionName(A.cc))}</div></div></div>`;
  const row = (f) => `<a class="mrow" href="#/flight/${esc(f.id)}"><span class="mdate"><span>${fmt(f.dep, f.A.tz, 'mon').toUpperCase()}</span><span>${fmt(f.dep, f.A.tz, 'dnum')}</span></span><div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800">${f.from} → ${f.to}</div><div class="muted" style="font-size:12px">${f.friend ? esc(f.friend) + ' · ' : ''}${esc(prettyNo(f) || 'Flight')} · ${f.arr > now ? fmt(f.dep, f.A.tz, 'time') : fmt(f.dep, f.A.tz, 'year')}</div></div><span class="muted">›</span></a>`;
  $('#content').innerHTML = `<div class="stack" style="padding-top:10px">
    <div class="grid3">
      <div class="stat"><span class="lbl">Local time</span><span class="big num" data-clock="${esc(A.tz)}">${fmt(now, A.tz, 'time')}</span></div>
      <div class="stat"><span class="lbl">vs you</span><span class="big">${diff}</span></div>
      <div class="stat"><span class="lbl">Your visits</span><span class="big">${mine.length} <span class="muted" style="font-size:12px">flight${mine.length === 1 ? '' : 's'}</span></span></div>
    </div>
    ${mine.length ? (() => {
      const done = mine.filter((f) => f.arr <= now).sort((p, q) => p.dep - q.dep);
      const rt = new Map(); mine.forEach((f) => { const k = f.from === code ? f.to : f.from; rt.set(k, (rt.get(k) || 0) + 1); });
      const fav = topOf(rt), far = [...mine].sort((p, q) => q.mi - p.mi)[0];
      const items = [];
      if (fav) items.push(['Most flown with', `${code} ↔ ${fav[0]}`, `${fav[1]} flight${fav[1] === 1 ? '' : 's'} · ${AP[fav[0]] ? AP[fav[0]].city : ''}`]);
      if (far) items.push(['Longest from here', `${far.from} → ${far.to}`, `${durStr(far.dur)} · ${nf.format(far.mi * 1.609344)} km`]);
      const yrs = new Set(done.map(yearOf)); if (yrs.size > 1) items.push(['Years visited', `${yrs.size}`, [...yrs].sort().join(' · ')]);
      return items.length ? `<div class="facts">${items.map(([l, v, s]) => `<div class="fact"><span class="lbl">${esc(l)}</span><span class="fv">${esc(v)}</span><span class="muted" style="font-size:11px;line-height:1.35">${esc(s)}</span></div>`).join('')}</div>` : '';
    })() : ''}
    ${up.length ? `<div><div class="lbl" style="margin-bottom:2px">Coming up</div>${up.map(row).join('')}</div>` : ''}
    ${before.length ? `<div><div class="lbl" style="margin-bottom:2px">Before</div>${before.map(row).join('')}</div>` : ''}
    ${!up.length && !before.length ? '<div class="note">No flights through here yet.</div>' : ''}
  </div>`;
  const routes = dedupeRoutes(mine.concat(friends)).map((r) => ({ a: r.a, b: r.b, progress: null, dim: true }));
  drawRoutes(routes.length ? routes : [{ a: A, b: A }], { sel: code });
}

function alertsView() {
  layout({ useMap: false, tab: 'settings' });
  $('#grab-content').innerHTML = '';
  const byId = new Map(db.flights.map((f) => [f.id, f]));
  const unread = new Set(db.alerts.filter((x) => !x.read).map((x) => x.id));
  const rows = db.alerts.slice(0, 60).map((x) => {
    const f = byId.get(x.flightId);
    const head = f ? `${esc(prettyNo(f) || (f.from + '→' + f.to))} · ` : '';
    const inner = `${alertIcon(x.type)}<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800">${head}${esc(x.title)}</div><div class="muted" style="font-size:12px">${f ? esc(f.from + ' → ' + f.to) + ' · ' : ''}${esc(x.sub || '')}</div></div><span class="muted" style="font-size:12px">${whenStr(x.at)}</span>${unread.has(x.id) ? '<span class="newdot" aria-label="New"></span>' : ''}`;
    return f ? `<li><a href="#/flight/${esc(f.id)}">${inner}</a></li>` : `<li><div>${inner}</div></li>`;
  }).join('');
  $('#content').innerHTML = `<div class="stack">
    <div class="row" style="gap:10px"><a class="round" href="#/settings" aria-label="Back to Settings">${ICON.back}</a><h1 style="margin:0">Recent alerts</h1></div>
    ${rows ? `<ul class="alist">${rows}</ul>` : `<div class="card"><div class="note">No alerts yet. When a delay, gate change, landing or bag belt turns up for one of your flights, it's listed here and on the flight itself.</div></div>`}
    <div class="note">These are collected while Samflyer is open (it refreshes as soon as you open it). Reminders you add to Calendar arrive even when it's closed.</div>
    ${db.alerts.length ? '<button class="linkbtn" data-act="clearAlerts">Clear all</button>' : ''}
  </div>`;
  if (unread.size) { db.alerts.forEach((x) => { x.read = true; }); save(); }
  updateAlertDot();
}
function alertsCardHTML() {
  const s = db.settings, n = unreadAlerts();
  const kinds = [['delays', 'Delays', '15 min or more'], ['gates', 'Gate & terminal changes', ''], ['landed', 'Landed', ''], ['belt', 'Bag belt', ''], ['leave', 'Leave for the airport', 'Calendar reminder'], ['checkin', 'Check-in opens', '24h before']];
  const up = flightsD().filter((f) => !f.demo && f.dep > Date.now());
  return `<div class="card" style="gap:6px"><h2>Alerts</h2>
    <a class="minirow" href="#/alerts" style="color:var(--text);text-decoration:none"><span style="flex:1;font-size:14px;font-weight:700">Recent alerts</span>${n ? `<span class="pill blue">${n} new</span>` : `<span class="muted" style="font-size:13px">${db.alerts.length || 'None'}</span>`}<span class="muted" aria-hidden="true">›</span></a>
    <div class="mini-list" style="padding:0">
      ${kinds.map(([k, l, d]) => `<div class="minirow"><span style="flex:1"><span style="font-size:14px;font-weight:600">${l}</span>${d ? ` <span class="muted" style="font-size:12px">· ${d}</span>` : ''}</span><button class="mini" role="switch" aria-label="${l}" aria-checked="${!!s.alerts[k]}" data-act="alert" data-v="${k}"></button></div>`).join('')}
    </div>
    ${s.alerts.leave ? `<div class="stack" style="gap:8px;margin-top:6px"><span class="lbl">Usual time before take-off</span>
      <div class="chips" role="group" aria-label="Usual time before take-off">${[2, 2.5, 3, 4].map((v) => `<button data-act="defLeave" data-v="${v}" aria-pressed="${s.leaveH === v}">${leaveLabel(v)}</button>`).join('')}</div>
      <div class="note">Change it on any flight from its own screen.</div></div>` : ''}
    ${(s.alerts.leave || s.alerts.checkin) && up.length ? `<button class="btn ghost" data-act="calAll" style="margin-top:6px">${AL_ICON.cal} Add all ${up.length} upcoming to Calendar</button>` : ''}
    <div class="note">Delays, gates, landing and bags are noticed while the app is open. Calendar reminders arrive even when it's closed.</div>
  </div>`;
}
function flightView(id) {
  const f = findD(id);
  if (!f) { location.hash = '#/'; return; }
  layout({ tabs: false, snapTo: 'half', left: `<a class="round" href="${f.friend ? '#/friends' : '#/'}" aria-label="Back">${ICON.back}</a>`, right: `<button class="round" data-act="fit" aria-label="Show whole route">${ICON.fit}</button><a class="round" href="#/edit/${esc(f.id)}" aria-label="Edit flight">${ICON.edit}</a>` });
  const now = Date.now(), st = status(f, now), p = progress(f, now), L = f.live || {};
  const air = st.key === 'air', done = st.key === 'landed' || st.key === 'cancel' || st.key === 'divert';
  const pos = air ? freshPos(f) : null;
  let cdLabel, cdVal, cdAttr = '', g2Label, g2Val, g3Label, g3Val;
  if (air) { cdLabel = 'Lands in'; cdVal = cd(f.arr - now); cdAttr = `data-cd="${f.arr}"`; g2Label = 'Arr gate'; g2Val = gateStr(f.arrGate); g3Label = 'Bag belt'; g3Val = gateStr(f.belt).replace('TBA', '—'); }
  else if (done) { cdLabel = st.key === 'landed' ? 'Landed' : 'Status'; cdVal = st.key === 'landed' ? fmt(f.arr, f.B.tz, 'time') : (st.key === 'cancel' ? 'CXL' : 'DIV'); g2Label = 'Arr gate'; g2Val = gateStr(f.arrGate); g3Label = 'Bag belt'; g3Val = gateStr(f.belt).replace('TBA', '—'); }
  else { cdLabel = 'Departs in'; cdVal = cd(f.dep - now); cdAttr = `data-cd="${f.dep}"`; g2Label = 'Gate'; g2Val = gateStr(f.depGate); g3Label = 'Seat'; g3Val = f.seat ? String(f.seat).toUpperCase().slice(0, 4) : '—'; }
  const yourTime = (ts, tz) => (tz !== HOME_TZ && tzOffset(ts, tz) !== tzOffset(ts, HOME_TZ)) ? `<div class="muted" style="font-size:11px">${fmt(ts, HOME_TZ, 'time')} your time</div>` : '';
  $('#grab-content').innerHTML = `
    <div class="stack" style="gap:14px;padding-bottom:6px">
      <div class="row"><div class="badge">${esc(codeOf(f))}</div>
        <div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:700">${f.friend ? esc(f.friend) + ' · ' : ''}${esc(titleOf(f))}</div><div class="muted" style="font-size:12px">${esc(f.A.city)} → ${esc(f.B.city)} · ${fmt(f.depS, f.A.tz, 'day')}</div></div>
        ${pill(st)}</div>
      <div class="between">
        <div style="display:flex;flex-direction:column;gap:6px">${flap(f.from, 'md')}<div class="num" style="font-size:12px"><span class="muted">Departs</span> ${timeHTML(f.dep, f.depS, f.A.tz)}</div>${yourTime(f.dep, f.A.tz)}</div>
        <span class="muted">${ICON.plane}</span>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;text-align:right">${flap(f.to, 'md')}<div class="num" style="font-size:12px"><span class="muted">Arrives</span> ${timeHTML(f.arr, f.arrS, f.B.tz)}${plusDays(f)}</div>${yourTime(f.arr, f.B.tz)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="bar"><i data-prog="${f.dep},${f.arr}" style="width:${(p * 100).toFixed(1)}%"></i>${air ? `<b data-progdot="${f.dep},${f.arr}" style="left:${(p * 100).toFixed(1)}%"></b>` : ''}</div>
        <div class="between muted num" style="font-size:12px"><span id="pos-src">${air ? (pos ? 'Live position · ' + esc(pos.src) : 'Estimated from schedule') : durStr(f.dur) + ' flight'}</span><span>${distStr(f.mi)}</span></div>
      </div>
      <div class="grid3">
        <div style="display:flex;flex-direction:column;gap:6px"><span class="lbl">${cdLabel}</span>${flap(cdVal, 'sm', cdAttr)}</div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:center"><span class="lbl">${g2Label}</span>${flap(g2Val, 'sm')}</div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="lbl">${g3Label}</span>${flap(g3Val, 'sm')}</div>
      </div>
      ${liveLine(f)}
    </div>`;
  const row = (k, v, sub = '') => `<span class="muted">${k}</span><span class="t1 num">${v}${sub ? `<div class="muted" style="font-size:11px;font-weight:500">${sub}</div>` : ''}</span>`;
  const schedSub = (best, sched, tz) => (Math.abs(best - sched) >= 60000 ? `scheduled ${fmt(sched, tz, 'time')}` : '');
  const det = (k, v) => `<div class="stat"><span class="lbl">${k}</span><span class="big">${v ? esc(v) : '<span class="muted">—</span>'}</span></div>`;
  $('#content').innerHTML = `<div class="stack" style="padding-top:12px">
    ${air ? `<div class="grid3" id="live-card">
      <div class="stat"><span class="lbl">Altitude</span><span class="big num" id="lv-alt">${pos && pos.altFt ? nf.format(pos.altFt) + ' ft' : '—'}</span></div>
      <div class="stat"><span class="lbl">Speed</span><span class="big num" id="lv-gs" style="font-size:14px">${pos && pos.gsKt ? speedStr(pos.gsKt * 1.15078) : '—'}</span></div>
      <div class="stat"><span class="lbl">Heading</span><span class="big num" id="lv-trk">${pos && pos.track != null ? Math.round(pos.track) + '°' : '—'}</span></div></div>` : ''}
    ${leaveCard(f, st)}
    <div class="card"><h2>Timeline</h2>
      <div class="tl">${row('Departure · ' + f.from, fmt(f.dep, f.A.tz, 'day') + ' ' + fmt(f.dep, f.A.tz, 'time'), schedSub(f.dep, f.depS, f.A.tz))}
      ${row('Arrival · ' + f.to, fmt(f.arr, f.B.tz, 'day') + ' ' + fmt(f.arr, f.B.tz, 'time'), schedSub(f.arr, f.arrS, f.B.tz))}
      ${row('Flight time', durStr(f.dur))}
      ${st.key === 'landed' ? row('Landed', agoStr(now - f.arr)) : ''}
      ${L.checkIn ? row('Check-in desk', esc(L.checkIn)) : ''}</div>
      <div class="note">${esc(offsetDiffStr(f))}. Times are local to each airport.</div>
      ${happenedHTML(f)}</div>
    ${planeCard(f, st)}
    <div class="grid2">
      <div class="stat"><span class="lbl">Distance</span><span class="big num" style="font-size:16px">${distStr(f.mi)}</span></div>
      <div class="stat"><span class="lbl">Avg speed</span><span class="big num" style="font-size:16px">${speedStr(f.mi / (f.dur / 3600000))}</span></div>
    </div>
    <div class="card"><div class="between"><h2>Details</h2><a href="#/edit/${esc(f.id)}" style="font-size:14px;font-weight:700">Edit</a></div>
      <div class="grid3">${det('Terminal', f.depTerm)}${det('Gate', f.depGate)}${det('Seat', f.seat)}${det('Arr gate', f.arrGate)}${det('Bag belt', f.belt)}${det('Aircraft', f.aircraft || (planeOf(f) ? planeOf(f).name + ' (likely)' : ''))}${det('Tail no.', f.reg || (L.reg || ''))}</div>
      ${L.model && f.aircraft !== L.model ? `<div class="note">Live data: ${esc(L.model)}</div>` : ''}</div>
    <button class="btn danger" data-act="del" data-v="${esc(f.id)}">Delete flight</button>
  </div>`;
  const routeNow = (g) => { const s2 = status(g), fp = s2.key === 'air' ? freshPos(g) : null; return [{ a: g.A, b: g.B, pos: fp, progress: s2.key === 'air' && !fp ? progress(g) : null }]; };
  drawRoutes(routeNow(f));
  if (db.alerts.some((x) => x.flightId === id && !x.read)) { db.alerts.forEach((x) => { if (x.flightId === id) x.read = true; }); save(); updateAlertDot(); }
  if (!done) mapRefresher = () => { const g = findD(id); if (g) drawRoutes(routeNow(g), { fit: false }); };
  if (air && L.modeS) {
    const poll = async () => {
      const got = await fetchPosition(L.modeS);
      const rec = db.flights.find((x) => x.id === id);
      if (!got || !rec || !location.hash.includes(id)) return;
      rec.live = Object.assign({}, rec.live, { pos: got }); save();
      const g = findD(id);
      drawRoutes(routeNow(g), { fit: false });
      const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
      set('#lv-alt', got.altFt ? nf.format(got.altFt) + ' ft' : '—');
      set('#lv-gs', got.gsKt ? speedStr(got.gsKt * 1.15078) : '—');
      set('#lv-trk', got.track != null ? Math.round(got.track) + '°' : '—');
      set('#pos-src', 'Live position · ' + got.src);
    };
    poll();
    posTimer = setInterval(poll, 30000);
  }
}
function planeCard(f, st) {
  const L = f.live || {};
  const head = `<div class="between"><h2>Where's my plane?</h2>${L.reg ? `<span class="pill grey">${esc(L.reg)}</span>` : ''}</div>`;
  if (!f.flightNo) return `<div class="card">${head}<div class="note">Add the flight number to use this.</div></div>`;
  if (!hasKey()) return `<div class="card">${head}<div class="note">Turn on live data in <a href="#/settings">Settings</a> to see which plane is flying your route, where it is now, and whether its earlier flight is running late.</div></div>`;
  if (!L.reg) return `<div class="card">${head}<div class="note">Airlines usually assign the plane a day or so before departure. Check back closer to the time — it appears here after a refresh.</div></div>`;
  const ib = L.inbound;
  const btn = st.key === 'sched' || st.key === 'soon' ? `<button class="btn ghost" data-act="inbound" data-v="${esc(f.id)}">${ib ? 'Check again' : 'Check the inbound plane'} <span class="muted" style="font-weight:500">· uses 1 lookup</span></button>` : '';
  if (!ib) return `<div class="card">${head}<div class="note">${L.model ? esc(L.model) + '. ' : ''}See this plane's flight before yours and whether a delay is coming your way.</div>${btn}</div>`;
  const legRow = (l, label, me) => {
    if (!l) return '';
    const late = l.arrBest && l.arrS ? Math.round((l.arrBest - l.arrS) / 60000) : 0;
    const dotC = me ? 'var(--blue)' : (late >= 10 ? 'var(--amber)' : 'var(--muted)');
    const stTxt = me ? 'Your flight' : (l.status === 'Arrived' ? `Landed ${l.arrBest ? fmtAny(l.arrBest, f.from) : ''}` : (l.status || '')) + (late >= 5 && !me ? ` · ${lateStr(late)}` : '');
    return `<div class="row" style="align-items:flex-start"><span style="width:12px;height:12px;border-radius:6px;background:${dotC};margin-top:4px;flex-shrink:0"></span><div style="flex:1;min-width:0"><div class="between" style="font-size:14px"><b>${esc(l.from)} → ${esc(l.to)}</b><span class="muted" style="font-size:12px">${esc(l.no)}</span></div><div class="note">${esc(label)} · ${esc(stTxt)}</div></div></div>`;
  };
  const me = { from: f.from, to: f.to, no: prettyNo(f), status: '' };
  let msg = '';
  if (ib.prev) {
    const landBy = ib.prev.arrBest || ib.prev.arrS;
    const gap = Math.round((f.dep - landBy) / 60000);
    msg = f.dep <= Date.now() ? `The plane landed ${durStr(Math.max(0, gap) * 60000)} before your flight left.` : (gap < 35 ? `The plane is due in only ${Math.max(0, gap)} min before your departure — your flight may be delayed.` : `The plane should be on the ground ${durStr(gap * 60000)} before you leave.`);
  } else msg = "No earlier flight found for this plane today — it may be starting its day with your flight.";
  return `<div class="card">${head}<div class="stack" style="gap:10px">${legRow(ib.prev, "Plane's previous flight")}${legRow(me, 'Now', true)}${legRow(ib.next, 'Its next flight')}</div>
    <div class="notice">${esc(msg)}</div><div class="note">Checked ${agoStr(Date.now() - ib.fetchedAt)}.</div>${btn}</div>`;
}
const fmtAny = (ts, code) => (AP[code] ? fmt(ts, AP[code].tz, 'time') : '');

function formView(id, pastMode, friendMode) {
  const existing = id ? db.flights.find((x) => x.id === id) : null;
  const forFriend = !!(friendMode || (existing && existing.friend));
  if (id && !existing) { location.hash = '#/'; return; }
  const today = localDateTime(Date.now(), HOME_TZ).date;
  const shiftDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const f = existing || { flightNo: '', airline: '', from: '', to: '', depDate: today, depTime: '', arrDate: '', arrTime: '' };
  let mode = pastMode ? 'past' : 'upcoming';
  let manualOpen = !!existing || !hasKey();
  let found = [], picked = null, pendingLive = null, arrTouched = !!existing;
  layout({ tabs: false, snapTo: 'full', left: `<a class="round" href="${existing ? '#/flight/' + esc(existing.id) : (forFriend ? '#/friends' : '#/')}" aria-label="Close">${ICON.close}</a>` });
  $('#grab-content').innerHTML = `<div class="between" style="padding-bottom:8px"><h1>${existing ? 'Edit flight' : (forFriend ? 'Friend\u2019s flight' : 'Add a flight')}</h1>
    ${existing || forFriend ? '' : `<div class="modes" role="group" aria-label="Flight type"><button type="button" data-mode="upcoming">Upcoming</button><span class="muted">·</span><button type="button" data-mode="past">Past</button></div>`}</div>`;
  const opts = Object.values(AP).map((a) => `<option value="${a.code}">${esc(a.city)} — ${esc(a.name)}</option>`).join('');
  const v = (k) => esc(f[k] || '');
  const friendNames = [...new Set(db.flights.filter((x) => x.friend).map((x) => x.friend))];
  $('#content').innerHTML = `<form id="ff" class="stack" novalidate autocomplete="off">
    ${forFriend ? `<div class="field"><label for="f-friend">Friend's name</label><input id="f-friend" list="friendlist" value="${esc((existing && existing.friend) || '')}" placeholder="e.g. Sara" autocapitalize="words"><datalist id="friendlist">${friendNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>` : ''}
    <div class="searchbox">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <label for="f-no" class="sr">Flight number</label>
      <input id="f-no" value="${v('flightNo')}" placeholder="Flight no. e.g. PC1172" autocapitalize="characters" spellcheck="false" enterkeyhint="search">
      <span id="f-alname" class="muted" style="font-size:12px;font-weight:700;white-space:nowrap"></span>
    </div>
    <div class="chips datechips" id="f-chips" role="group" aria-label="Departure date"></div>
    ${hasKey() ? `<button type="button" class="btn ghost" id="f-look">Find flight <span class="muted" style="font-weight:500">· 1 lookup</span></button>` : (existing ? '' : `<div class="note">Searching needs live data — <a href="#/settings">turn it on in Settings</a>. For now, type the details in below.</div>`)}
    <div id="f-result" class="stack" style="gap:10px"></div>
    <div class="hint err" id="f-err" role="alert" style="font-size:13px;color:var(--red)"></div>
    <button class="btn" type="submit" id="f-save"></button>
    <button type="button" class="linkbtn" id="f-mtoggle"></button>
    <div id="f-manual" class="stack" ${manualOpen ? '' : 'hidden'}>
      <div class="field"><label for="f-al">Airline</label><input id="f-al" value="${v('airline')}" placeholder="Fills in from the number"></div>
      <div class="grid2">
        <div class="field"><label for="f-from">From</label><input id="f-from" class="code" list="aplist" value="${v('from')}" placeholder="LHR" maxlength="3" autocapitalize="characters"><span class="hint" id="h-from">&nbsp;</span></div>
        <div class="field"><label for="f-to">To</label><input id="f-to" class="code" list="aplist" value="${v('to')}" placeholder="IST" maxlength="3" autocapitalize="characters"><span class="hint" id="h-to">&nbsp;</span></div>
      </div>
      <datalist id="aplist">${opts}</datalist>
      <div class="grid2">
        <div class="field"><label for="f-dt">Departs (local)</label><input id="f-dt" type="time" value="${v('depTime')}"></div>
        <div class="field"><label for="f-at">Arrives (local)</label><input id="f-at" type="time" value="${v('arrTime')}"></div>
      </div>
      <div class="field"><label for="f-ad">Arrival date</label><input id="f-ad" type="date" value="${v('arrDate')}"><span class="hint">Fills itself in, including overnight flights</span></div>
      <details ${existing && (existing.depGate || existing.seat || existing.depTerm || existing.arrGate || existing.belt || existing.aircraft) ? 'open' : ''}><summary>Gate, seat, belt…</summary>
        <div class="grid3" style="margin-top:8px">
          <div class="field"><label for="f-term">Terminal</label><input id="f-term" value="${v('depTerm')}"></div>
          <div class="field"><label for="f-gate">Gate</label><input id="f-gate" value="${v('depGate')}"></div>
          <div class="field"><label for="f-seat">Seat</label><input id="f-seat" value="${v('seat')}"></div>
          <div class="field"><label for="f-agate">Arr gate</label><input id="f-agate" value="${v('arrGate')}"></div>
          <div class="field"><label for="f-belt">Bag belt</label><input id="f-belt" value="${v('belt')}"></div>
          <div class="field"><label for="f-ac">Aircraft</label><input id="f-ac" value="${v('aircraft')}" placeholder="A320"></div>
          <div class="field"><label for="f-reg">Tail no.</label><input id="f-reg" value="${v('reg')}" placeholder="G-EUYB" autocapitalize="characters" spellcheck="false"></div>
        </div></details>
    </div>
    <input type="hidden" id="f-dd" value="${v('depDate')}">
  </form>`;
  const form = $('#ff'), q = (s) => $(s, form);
  const dd = () => q('#f-dd').value;
  /* ----- mode + date chips ----- */
  function paintModes() { $$('#grab-content [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode))); }
  function paintChips() {
    const d = dd();
    const presets = mode === 'past' ? [[today, 'Today'], [shiftDay(today, -1), 'Yesterday']] : [[today, 'Today'], [shiftDay(today, 1), 'Tomorrow']];
    const isPreset = presets.some(([pd]) => pd === d);
    const other = d && !isPreset ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z')) : 'Other date…';
    q('#f-chips').innerHTML = presets.map(([pd, l]) => `<button type="button" data-day="${pd}" aria-pressed="${pd === d}">${l}</button>`).join('') +
      `<label class="datechip" aria-pressed="${!!d && !isPreset}">${esc(other)}<input type="date" id="f-pick" value="${d}" aria-label="Pick a date"></label>`;
    $$('[data-day]', form).forEach((b) => b.addEventListener('click', () => setDate(b.dataset.day)));
    q('#f-pick').addEventListener('change', (e) => { if (e.target.value) setDate(e.target.value); });
  }
  function setDate(d) { q('#f-dd').value = d; if (!existing) arrTouched = false; found = []; picked = null; paintChips(); renderResult(); upd(); }
  $$('#grab-content [data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode; paintModes();
    if (mode === 'past' && dd() > today) setDate(today); else paintChips();
    paintSave();
  }));
  /* ----- airline from number ----- */
  function paintAirline() {
    const no = q('#f-no').value, name = AIRLINES[no.slice(0, 2)];
    q('#f-alname').textContent = (picked && picked.airline) || name || '';
    const al = q('#f-al');
    if (name && (!al.value || al.dataset.auto === '1')) { al.value = name; al.dataset.auto = '1'; }
  }
  q('#f-no').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/\s+/g, ''); paintAirline(); });
  q('#f-al').addEventListener('input', (e) => { e.target.dataset.auto = '0'; });
  q('#f-no').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (q('#f-look')) q('#f-look').click(); } });
  /* ----- result card ----- */
  function cardHTML(m, i, sel) {
    const A = AP[m.from], B = AP[m.to];
    const st = m.status ? `<span class="pill ${m.status === 'Canceled' ? 'red' : 'grey'}">${esc(m.status === 'Expected' || m.status === 'Unknown' ? 'Scheduled' : m.status.replace(/([a-z])([A-Z])/g, '$1 $2'))}</span>` : '';
    const days = Math.round((Date.parse(localDateTime(m.arrS, B.tz).date) - Date.parse(localDateTime(m.depS, A.tz).date)) / 86400000);
    return `<div class="card resultcard${sel ? ' sel' : ''}" ${i != null ? `data-pick="${i}" role="button" tabindex="0" aria-pressed="${sel}"` : ''}>
      <div class="between"><span style="font-size:12px;font-weight:800;color:var(--green)">${i == null ? 'Your flight' : (found.length > 1 ? (sel ? '✓ This one' : 'Tap to choose') : '✓ Found your flight')}</span>${st}</div>
      <div class="between">
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">${flap(m.from, 'md')}<span class="muted" style="font-size:12px">${esc(A.city)} ${esc(A.name !== A.city ? A.name : '')}</span><span style="font-size:18px;font-weight:800" class="num">${fmt(m.depS, A.tz, 'time')}</span></div>
        <div class="muted num" style="display:flex;flex-direction:column;align-items:center;font-size:11px;gap:2px;text-align:center"><span>${durStr(m.arrS - m.depS)}</span><span>${nf.format(gcMiles(A, B))} mi</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;text-align:right;min-width:0">${flap(m.to, 'md')}<span class="muted" style="font-size:12px">${esc(B.city)} ${esc(B.name !== B.city ? B.name : '')}</span><span style="font-size:18px;font-weight:800" class="num">${fmt(m.arrS, B.tz, 'time')}${days > 0 ? ` <span class="muted" style="font-size:12px">+${days}</span>` : ''}</span></div>
      </div>
      ${m.airline || m.flightNo ? `<span class="muted" style="font-size:12px">${esc([m.airline, (m.flightNo || '').replace(/^([A-Z0-9]{2})(\d)/, '$1 $2'), m.model].filter(Boolean).join(' · '))}</span>` : ''}
    </div>`;
  }
  function manualPreview() {
    const A = AP[q('#f-from').value], B = AP[q('#f-to').value];
    if (!A || !B || !dd() || !q('#f-dt').value || !q('#f-ad').value || !q('#f-at').value) return null;
    const depS = zonedToUtc(dd(), q('#f-dt').value, A.tz), arrS = zonedToUtc(q('#f-ad').value, q('#f-at').value, B.tz);
    return arrS > depS ? { from: A.code, to: B.code, depS, arrS, airline: q('#f-al').value, flightNo: q('#f-no').value } : null;
  }
  function renderResult() {
    const box = q('#f-result');
    if (found.length) {
      box.innerHTML = found.map((m, i) => cardHTML(Object.assign({ model: m.live.model, status: m.live.status }, m), i, found.length === 1 || picked === m)).join('');
      $$('[data-pick]', box).forEach((c) => { const go = () => { usePick(found[+c.dataset.pick]); }; c.addEventListener('click', go); c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }); });
    } else {
      const m = manualPreview();
      box.innerHTML = m ? cardHTML(m, null, false) : '';
    }
    paintSave();
  }
  function paintSave() {
    const btn = q('#f-save');
    const ready = !!(picked || manualPreview());
    btn.textContent = existing ? 'Save changes' : (forFriend ? 'Follow this flight' : (mode === 'past' ? 'Add to Passport' : 'Add to My Flights'));
    btn.hidden = !ready && !manualOpen;
    q('#f-mtoggle').innerHTML = manualOpen ? (existing ? '' : 'Hide the details') : `No flight number? <u>Type it in yourself</u>`;
    q('#f-mtoggle').hidden = !!existing;
  }
  function usePick(m) {
    picked = m;
    const dl = localDateTime(m.depS, AP[m.from].tz), al = localDateTime(m.arrS, AP[m.to].tz);
    q('#f-from').value = m.from; q('#f-to').value = m.to;
    q('#f-dd').value = dl.date; q('#f-dt').value = dl.time; q('#f-ad').value = al.date; q('#f-at').value = al.time;
    if (m.airline) { q('#f-al').value = m.airline; q('#f-al').dataset.auto = '0'; }
    const L = m.live || {};
    if (L.depTerm) q('#f-term').value = L.depTerm;
    if (L.depGate) q('#f-gate').value = L.depGate;
    if (L.arrGate) q('#f-agate').value = L.arrGate;
    if (L.belt) q('#f-belt').value = L.belt;
    if (L.model) q('#f-ac').value = L.model;
    arrTouched = true; pendingLive = m.live || null;
    paintAirline(); paintChips(); renderResult(); upd(true);
  }
  q('#f-mtoggle').addEventListener('click', () => { manualOpen = !manualOpen; q('#f-manual').hidden = !manualOpen; paintSave(); if (manualOpen) setTimeout(() => q('#f-manual').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }), 50); });
  const look = q('#f-look');
  if (look) look.addEventListener('click', async () => {
    const no = q('#f-no').value.trim().toUpperCase(), date = dd(), box = q('#f-result');
    q('#f-err').textContent = '';
    if (!no) { q('#f-err').textContent = 'Type the flight number first.'; q('#f-no').focus(); return; }
    if (!date) { q('#f-err').textContent = 'Pick the departure date.'; return; }
    look.disabled = true; look.innerHTML = 'Finding…'; box.innerHTML = '<div class="card"><div class="note">Looking up ' + esc(no) + '…</div></div>';
    try {
      const list = await adb(`/flights/number/${encodeURIComponent(no)}/${date}?withAircraftImage=false&withLocation=false&dateLocalRole=Departure`);
      found = (Array.isArray(list) ? list : [list]).map(fromAdb).filter((m) => m.from && m.to && m.depS && m.arrS);
      picked = null;
      if (!found.length) { box.innerHTML = `<div class="card"><div class="note">No flight ${esc(no)} found on that date. Check the number and the day, or type it in yourself below.</div></div>`; manualOpen = true; q('#f-manual').hidden = false; paintSave(); return; }
      if (found.length === 1) usePick(found[0]); else renderResult();
    } catch (e) { box.innerHTML = `<div class="card"><div class="note" style="color:var(--red)">${esc(errText(e))}</div></div>`; }
    finally { look.disabled = false; look.innerHTML = 'Find flight <span class="muted" style="font-weight:500">· 1 lookup</span>'; }
  });
  /* ----- manual fields ----- */
  q('#f-ad').addEventListener('input', () => { arrTouched = true; });
  function upd(skipFound) {
    ['from', 'to'].forEach((k) => {
      const el = q('#f-' + k), h = q('#h-' + k);
      el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
      const a = AP[el.value];
      h.className = 'hint' + (el.value.length === 3 && !a ? ' err' : '');
      h.textContent = a ? `${a.city} · ${a.name}` : (el.value.length === 3 ? 'Not in the airport list yet' : ' ');
    });
    const A = AP[q('#f-from').value], B = AP[q('#f-to').value], dt = q('#f-dt').value, at = q('#f-at').value;
    if (A && B && dd() && dt && at && !arrTouched) {
      const dep = zonedToUtc(dd(), dt, A.tz);
      let ad = dd();
      for (let i = 0; i < 3; i++) { if (zonedToUtc(ad, at, B.tz) > dep) break; ad = shiftDay(ad, 1); }
      q('#f-ad').value = ad;
    }
    if (A && B) drawRoutes([{ a: A, b: B }], { fit: false });
    if (!skipFound && !found.length) renderResult(); else paintSave();
  }
  q('#f-manual').addEventListener('input', (e) => { if (e.target.id !== 'f-al') { if (picked) { picked = null; found = []; } upd(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = (m) => { q('#f-err').textContent = m; if (!manualOpen) { manualOpen = true; q('#f-manual').hidden = false; paintSave(); } };
    const rec = {
      id: existing ? existing.id : newId(),
      flightNo: q('#f-no').value.trim().toUpperCase(), airline: q('#f-al').value.trim(),
      from: q('#f-from').value, to: q('#f-to').value,
      depDate: dd(), depTime: q('#f-dt').value, arrDate: q('#f-ad').value, arrTime: q('#f-at').value,
      depTerm: q('#f-term').value.trim(), depGate: q('#f-gate').value.trim(), seat: q('#f-seat').value.trim(),
      arrGate: q('#f-agate').value.trim(), belt: q('#f-belt').value.trim(), aircraft: q('#f-ac').value.trim(), reg: q('#f-reg').value.trim().toUpperCase(),
      demo: false, created: existing ? existing.created : Date.now()
    };
    if (forFriend) { rec.friend = (q('#f-friend').value || '').trim(); if (!rec.friend) return err('Add your friend\u2019s name.'); }
    if (existing) ['leaveH', 'acTried', 'acSrc'].forEach((k) => { if (existing[k] != null) rec[k] = existing[k]; });
    if (pendingLive) rec.live = pendingLive; else if (existing && existing.live && existing.flightNo === rec.flightNo && existing.depDate === rec.depDate) rec.live = existing.live;
    if (!AP[rec.from]) return err('Pick a known departure airport (3-letter code).');
    if (!AP[rec.to]) return err('Pick a known arrival airport (3-letter code).');
    if (rec.from === rec.to) return err('Departure and arrival airports are the same.');
    if (!rec.depDate || !rec.depTime) return err('Add the departure date and time.');
    if (!rec.arrDate || !rec.arrTime) return err('Add the arrival time.');
    const d = derive(rec);
    if (d.dur <= 0) return err('Arrival is before departure. Check the arrival date and time.');
    if (d.dur > 22 * 3600000) return err('That flight would be over 22 hours. Check the dates.');
    if (existing) Object.assign(existing, rec); else db.flights.push(rec);
    save();
    toast(existing ? 'Flight updated' : (forFriend ? `Following ${rec.friend}\u2019s flight` : (d.arr < Date.now() ? 'Added to your Passport' : 'Flight added')));
    location.hash = '#/flight/' + rec.id;
  });
  paintModes(); paintChips(); paintAirline(); upd();
  const A0 = AP[q('#f-from').value], B0 = AP[q('#f-to').value];
  if (!(A0 && B0)) drawRoutes([]);
  if (!existing) setTimeout(() => { if (!q('#f-no').value) q('#f-no').focus({ preventScroll: true }); }, 350);
}

function planeStats(list) {
  const m = new Map();
  list.forEach((f) => {
    const t = planeOf(f); if (!t) return;
    const r = m.get(t.key) || { key: t.key, name: t.name, wiki: t.wiki, n: 0, likely: 0, hrs: 0, airlines: new Set() };
    r.n++; if (t.likely) r.likely++; r.hrs += f.dur / 3600000; r.airlines.add(f.airline || AIRLINES[codeOf(f)] || codeOf(f));
    m.set(t.key, r);
  });
  return [...m.values()].sort((p, q) => q.n - p.n || q.hrs - p.hrs);
}
function repeatPlanes(list) {
  const m = new Map();
  list.forEach((f) => { const reg = (f.reg || (f.live && f.live.reg) || '').toUpperCase().replace(/\s+/g, ''); if (!reg) return; if (!m.has(reg)) m.set(reg, []); m.get(reg).push(f); });
  return [...m.entries()].filter(([, fs]) => fs.length > 1).map(([reg, fs]) => ({ reg, fs: fs.sort((p, q) => p.dep - q.dep) })).sort((p, q) => q.fs.length - p.fs.length);
}
function photoBox(t, h = 116) {
  return `<div class="ph" style="height:${h}px" ${t.wiki ? `data-photo="${esc(t.wiki)}"` : ''}><svg class="ph-sil" viewBox="0 0 300 120" aria-hidden="true"><path d="M40,64 C40,56 52,52 70,52 L230,52 C250,52 262,58 266,64 C262,70 250,74 230,74 L70,74 C52,74 40,70 40,64 Z M130,62 L178,62 L150,98 L138,98 Z M60,54 L48,30 L60,30 L82,54 Z"/></svg>${t.wiki ? '<span class="credit-ph">Wikimedia Commons</span>' : ''}</div>`;
}
function aircraftSection(sel) {
  const stats = planeStats(sel);
  if (!stats.length) return '';
  const all = flightsD().filter((f) => f.arr <= Date.now());
  const reps = repeatPlanes(sel);
  const makers = new Set(stats.map((s) => s.name.split(' ')[0])).size;
  const pending = all.filter((f) => !f.demo && f.flightNo && !f.acTried && (!f.aircraft || !f.reg)).length;
  const left = Math.max(0, Math.floor((AUTO_STOP_AT - unitsUsed()) / UNITS_PER_LOOKUP));
  const likelyN = stats.reduce((s, r) => s + r.likely, 0);
  const card = (r) => `<div class="pcard">${photoBox(r)}<div class="between" style="align-items:baseline;gap:6px"><span style="font-size:15px;font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span><span style="font-size:18px;font-weight:800">${r.n}×</span></div><span class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Math.round(r.hrs)}h${r.likely ? ` · ${r.likely} likely` : ''} · ${esc([...r.airlines].slice(0, 3).join(', '))}</span></div>`;
  const regRow = (p) => { const f0 = p.fs[p.fs.length - 1], t = planeOf(f0); return `<a class="mrow" href="#/flight/${esc(p.fs[p.fs.length - 1].id)}"><span class="regchip">${esc(p.reg)}</span><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800">${esc(t ? t.name : 'Aircraft')} · ${esc(f0.airline || AIRLINES[codeOf(f0)] || codeOf(f0))}</div><div class="muted" style="font-size:12px">${p.fs.map((f) => fmt(f.dep, f.A.tz, 'short') + ' ' + fmt(f.dep, f.A.tz, 'year')).join(' · ')}</div></div><span style="font-size:13px;font-weight:800;color:var(--blue)">${p.fs.length}×</span></a>`; };
  return `<div class="stack" style="gap:10px">
    <div class="between"><span class="lbl">Most flown aircraft</span><a href="#/passport/aircraft" style="font-size:13px;font-weight:700">See all ${stats.length}</a></div>
    <div class="pcards">${stats.slice(0, 8).map(card).join('')}</div>
    <div class="grid3"><div class="stat"><span class="lbl">Types</span><span class="big">${stats.length}</span></div><div class="stat"><span class="lbl">Makers</span><span class="big">${makers}</span></div><div class="stat"><span class="lbl">Repeat planes</span><span class="big">${reps.length}</span></div></div>
    ${likelyN || pending ? `<div class="card" style="gap:8px">${likelyN ? `<div class="note">${likelyN} flight${likelyN === 1 ? ' uses a' : 's use a'} best guess (“likely”) from the airline and route.</div>` : ''}
      ${pending ? (hasKey() ? `<button class="btn ghost" data-act="lookupPlanes" ${lookupRun ? 'disabled' : ''}>${lookupRun ? `Looking up… ${lookupRun.done} of ${lookupRun.total}` : `Look up the real planes for ${pending} flight${pending === 1 ? '' : 's'}`}</button>
        <div class="note">About ${pending} lookups of the ${left} you have left this month. Older flights may not be found — those keep the best guess.</div>` : `<div class="note"><a href="#/settings">Turn on live data</a> to look up the real planes and tail numbers.</div>`) : ''}</div>` : ''}
    <div class="card" style="gap:0;padding:6px 14px 8px"><div style="min-height:38px;display:flex;align-items:center"><span class="lbl">Same plane again</span></div>
      ${reps.length ? reps.slice(0, 6).map(regRow).join('') : '<div class="note" style="padding-bottom:6px">None yet. Tail numbers are saved from lookups and live updates, or type one into a flight\u2019s details.</div>'}</div>
  </div>`;
}
function aircraftAllView() {
  layout({ useMap: false, tabs: true, tab: 'passport', left: '' });
  $('#grab-content').innerHTML = '';
  const now = Date.now();
  const past = flightsD().filter((f) => f.arr <= now);
  const sel = past.filter((f) => ppPeriod === 'all' || yearOf(f) === +ppPeriod);
  const stats = planeStats(sel), reps = repeatPlanes(sel);
  $('#content').innerHTML = `<div class="stack">
    <div class="row" style="gap:10px"><a class="round" href="#/passport" aria-label="Back to Passport">${ICON.back}</a><h1 style="margin:0">Aircraft</h1><span class="muted" style="margin-left:auto;font-size:13px">${ppPeriod === 'all' ? 'All time' : ppPeriod}</span></div>
    ${stats.map((r, i) => `<div class="card" style="gap:10px">${photoBox(r, 150)}<div class="between" style="align-items:baseline"><span style="font-size:18px;font-weight:800">${i + 1}. ${esc(r.name)}</span><span style="font-size:20px;font-weight:800">${r.n}×</span></div><span class="muted" style="font-size:12px">${Math.round(r.hrs)} hours · ${esc([...r.airlines].join(', '))}${r.likely ? ` · ${r.likely} likely` : ''}</span>
      ${reps.filter((p) => (planeOf(p.fs[0]) || {}).key === r.key).map((p) => `<div class="row" style="gap:8px;font-size:12px"><span class="regchip">${esc(p.reg)}</span><span class="muted">flown ${p.fs.length}×</span></div>`).join('')}</div>`).join('')}
    <div class="note">Photos from Wikipedia / Wikimedia Commons, free-licensed; they show the type, not your exact plane.</div>
  </div>`;
  fillPhotos($('#content'));
}
/* ---------- Fun facts ---------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function topOf(map) { let best = null; map.forEach((v, k) => { if (!best || v > best[1]) best = [k, v]; }); return best; }
function funFacts(sel, past, period) {
  if (!sel.length) return [];
  const F = [], local = (f) => partsAt(f.dep, f.A.tz);
  const mins = (f) => { const p = local(f); return p.h * 60 + p.mi; };
  const dateStr = (f) => `${fmt(f.dep, f.A.tz, 'short')} ${fmt(f.dep, f.A.tz, 'year')}`;
  if (period === 'all') {
    const by = new Map(); past.forEach((f) => by.set(yearOf(f), (by.get(yearOf(f)) || 0) + 1));
    const b = topOf(by); if (b) F.push(['Busiest year', String(b[0]), `${b[1]} flights`]);
  } else {
    const by = new Map(); sel.forEach((f) => { const m = local(f).m; by.set(m, (by.get(m) || 0) + 1); });
    const b = topOf(by); if (b) F.push(['Busiest month', MONTHS[b[0] - 1], `${b[1]} flight${b[1] === 1 ? '' : 's'}`]);
  }
  const byLen = [...sel].sort((p, q) => q.dur - p.dur);
  F.push(['Longest flight', `${byLen[0].from} → ${byLen[0].to}`, `${durStr(byLen[0].dur)} · ${nf.format(byLen[0].mi * 1.609344)} km`]);
  if (sel.length > 1) { const s = byLen[byLen.length - 1]; F.push(['Shortest hop', `${s.from} → ${s.to}`, `${durStr(s.dur)} · ${nf.format(s.mi * 1.609344)} km`]); }
  const early = [...sel].sort((p, q) => ((mins(p) + 1440 - 240) % 1440) - ((mins(q) + 1440 - 240) % 1440))[0];
  F.push(['Earliest take-off', fmt(early.dep, early.A.tz, 'time'), `${early.from} → ${early.to} · ${dateStr(early)}`]);
  const reds = sel.filter((f) => { const m = mins(f); return m >= 22 * 60 || m < 6 * 60; }).length;
  if (reds) F.push(['Night flights', `${reds}`, `took off between 10pm and 6am`]);
  const days = sel.reduce((s, f) => s + f.dur, 0) / 86400000;
  F.push(['Time in the air', days >= 1 ? `${days.toFixed(1)} days` : `${Math.round(days * 24)} hours`, 'sitting in a seat, gate to gate']);
  const miles = sel.reduce((s, f) => s + f.mi, 0), moon = miles / 238855;
  F.push(moon >= 1 ? ['To the Moon', `${moon.toFixed(2)}×`, 'the distance to the Moon'] : ['To the Moon', `${Math.round(moon * 100)}%`, 'of the way there']);
  const wd = new Map(); sel.forEach((f) => { const d = new Date(Date.UTC(local(f).y, local(f).m - 1, local(f).d)).getUTCDay(); wd.set(d, (wd.get(d) || 0) + 1); });
  const w = topOf(wd); if (w && sel.length > 2) F.push(['Favourite day to fly', WEEKDAYS[w[0]], `${w[1]} of your flights`]);
  const tzh = sel.reduce((s, f) => s + Math.abs(tzOffset(f.dep, f.B.tz) - tzOffset(f.dep, f.A.tz)), 0) / 3600000;
  if (tzh) F.push(['Clock changes', `${nf.format(tzh)} hours`, 'of time zones crossed']);
  const dayMap = new Map(); sel.forEach((f) => { const k = `${local(f).y}-${local(f).m}-${local(f).d}`; if (!dayMap.has(k)) dayMap.set(k, []); dayMap.get(k).push(f); });
  const bigDay = [...dayMap.values()].sort((p, q) => q.length - p.length)[0];
  if (bigDay && bigDay.length > 1) F.push(['Busiest day', `${bigDay.length} flights`, `${dateStr(bigDay[0])} · ${bigDay.map((f) => f.from).concat(bigDay[bigDay.length - 1].to).join(' → ')}`]);
  if (period !== 'all') {
    const before = new Set(past.filter((f) => yearOf(f) < +period).flatMap((f) => [f.from, f.to]));
    const fresh = [...new Set(sel.flatMap((f) => [f.from, f.to]))].filter((c) => !before.has(c));
    if (fresh.length) F.push(['New airports', `${fresh.length}`, fresh.slice(0, 5).join(' · ')]);
  }
  return F;
}

/* Passport. On a period change only the numbers change, with a flip or a count, instead of redrawing the page. */
function tweenNum(el, to) {
  const from = parseFloat(el.dataset.n || '0'); el.dataset.n = String(to);
  const fmtN = (v) => (el.dataset.dec ? v.toFixed(+el.dataset.dec) : nf.format(Math.round(v))) + (el.dataset.suf || '');
  if (reduceMotion() || from === to) { el.textContent = fmtN(to); return; }
  const t0 = performance.now(), D = 420;
  const step = (t) => { const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3); el.textContent = fmtN(from + (to - from) * e); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function passportView(soft) {
  const now = Date.now();
  const past = flightsD().filter((f) => f.arr <= now);
  const years = [...new Set(past.map(yearOf))].sort((a, b) => b - a);
  if (ppPeriod !== 'all' && !years.includes(+ppPeriod)) ppPeriod = 'all';
  const sel = past.filter((f) => ppPeriod === 'all' || yearOf(f) === +ppPeriod);
  const periodLabel = ppPeriod === 'all' ? 'All time' : String(ppPeriod);
  const routes = dedupeRoutes(sel);
  const canSoft = soft && past.length && $('#content .pp');
  if (!canSoft) {
    layout({ tab: 'passport', snapTo: 'half', right: `<button class="round" data-act="fit" aria-label="Re-centre the globe">${ICON.fit}</button>` });
    $('#grab-content').innerHTML = `<div class="between" style="flex-wrap:wrap;padding-bottom:6px"><h1>Passport</h1>
      <div class="chips" role="group" aria-label="Period">${['all', ...years].map((y) => `<button data-act="period" data-v="${y}" aria-pressed="${String(y) === String(ppPeriod)}">${y === 'all' ? 'All time' : y}</button>`).join('')}</div></div>`;
  } else {
    $$('#grab-content [data-act=period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(ppPeriod))));
  }
  $('#top-right').innerHTML = (past.length ? `<span class="chip-float">${routes.length} route${routes.length === 1 ? '' : 's'} · ${periodLabel}</span>` : '') + `<button class="round" data-act="fit" aria-label="Re-centre the globe">${ICON.fit}</button>`;
  if (!past.length) {
    $('#content').innerHTML = `<div class="card empty" style="margin-top:12px"><div style="font-size:17px;font-weight:800">Your Passport is empty</div><div class="note">Flights you've taken appear here with lifetime miles, hours, airports and countries. Add your older trips to fill it in.</div><a class="btn" href="#/add/past">${ICON.plus}Add a past flight</a>${db.flights.some((f) => f.demo) ? '' : '<button class="btn ghost" data-act="demo">Try it with demo flights</button>'}</div>`;
    drawRoutes([]);
    return;
  }
  const miles = sel.reduce((s, f) => s + f.mi, 0), hrs = sel.reduce((s, f) => s + f.dur, 0) / 3600000;
  const count = (fn) => new Set(sel.flatMap(fn).filter(Boolean)).size;
  const airports = count((f) => [f.from, f.to]), countries = count((f) => [f.A.cc, f.B.cc]);
  const airlines = count((f) => [f.airline || codeOf(f)]), planes = count((f) => [(planeOf(f) || {}).key]);
  const earth = miles / 24901;
  const topR = [...routes].sort((a, b) => b.n - a.n).slice(0, 5);
  const alMap = new Map();
  sel.forEach((f) => { const k = f.airline || codeOf(f); alMap.set(k, (alMap.get(k) || 0) + 1); });
  const topA = [...alMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxA = topA.length ? topA[0][1] : 1;
  const stat = (k, l, v) => `<div class="stat"><span class="lbl">${l}</span>${flap(String(v), 'sm', `data-k="${k}"`)}</div>`;
  const u = db.settings.units;
  const milesBig = u === 'nm' ? miles * 0.868976 : miles;
  const facts = funFacts(sel, past, ppPeriod);
  const html = `<div class="stack pp" style="padding-top:12px">
    <div class="card"><span class="lbl">${u === 'nm' ? 'Nautical miles flown' : 'Miles flown'}</span>
      <div style="overflow-x:auto">${flap(nf.format(milesBig).replace(/,/g, ' '), 'md', 'data-k="miles"')}</div>
      <span class="muted num" style="font-size:12px"><span data-k="km" data-n="${miles * 1.609344}">${nf.format(miles * 1.609344)}</span> km${u === 'both' ? ` · <span data-k="nm" data-n="${miles * 0.868976}">${nf.format(miles * 0.868976)}</span> nm` : ''}</span>
      <div class="bar"><i data-k="earthbar" data-w="${Math.min(100, earth * 100).toFixed(0)}" style="width:${Math.min(100, earth * 100).toFixed(0)}%"></i></div>
      <span style="font-size:12px;font-weight:600"><span data-k="earth" data-n="${earth}" data-dec="2" data-suf="×">${earth.toFixed(2)}×</span> around the Earth</span></div>
    <div class="grid3">${stat('s-fl', 'Flights', sel.length)}${stat('s-hr', 'Hours', Math.round(hrs))}${stat('s-ap', 'Airports', airports)}${stat('s-co', 'Countries', countries)}${stat('s-al', 'Airlines', airlines)}${stat('s-pl', 'Planes', planes || '—')}</div>
    <div class="stack" style="gap:10px"><span class="lbl">Fun facts</span>
      <div class="facts" data-k="facts">${facts.map(([l, v, s]) => `<div class="fact"><span class="lbl">${esc(l)}</span><span class="fv">${esc(v)}</span><span class="muted" style="font-size:11px;line-height:1.35">${esc(s)}</span></div>`).join('')}</div></div>
    <div class="card"><h2>Top routes</h2><div class="stack" style="gap:12px" data-k="routes">${topR.map((r) => `<div class="between" style="font-size:14px"><span style="font-weight:700">${r.a.code} ↔ ${r.b.code} <span class="muted" style="font-weight:500">${esc(r.a.city)} · ${esc(r.b.city)}</span></span><span class="muted">${r.n}×</span></div>`).join('')}</div></div>
    <div class="card"><h2>Top airlines</h2><div class="stack" style="gap:12px" data-k="airlines">${topA.map(([n, c]) => `<div style="display:flex;flex-direction:column;gap:4px"><div class="between" style="font-size:14px"><span style="font-weight:700">${esc(n)}</span><span class="muted">${c}</span></div><div class="bar"><i style="width:${(c / maxA * 100).toFixed(0)}%"></i></div></div>`).join('')}</div></div>
    <div data-k="aircraft">${aircraftSection(sel)}</div>
    <a class="btn dash" href="#/add/past">${ICON.plus}Add a past flight</a>
  </div>`;
  if (canSoft) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    $$('[data-k]', tmp).forEach((nw) => {
      const old = $(`#content [data-k="${nw.dataset.k}"]`); if (!old) return;
      if (old.classList.contains('flap')) updateFlap(old, nw.getAttribute('aria-label') === '—' ? '—' : nw.getAttribute('aria-label').replace(/ /g, ' '));
      else if (nw.dataset.n != null) tweenNum(old, parseFloat(nw.dataset.n));
      else if (nw.dataset.w != null) old.style.width = nw.dataset.w + '%';
      else if (old.innerHTML !== nw.innerHTML) {
        old.innerHTML = nw.innerHTML;
        if (!reduceMotion()) { old.classList.remove('swap'); void old.offsetWidth; old.classList.add('swap'); }
        if (nw.dataset.k === 'aircraft') fillPhotos(old);
      }
    });
  } else {
    $('#content').innerHTML = html;
    fillPhotos($('#content'));
  }
  drawRoutes(routes.map((r) => ({ a: r.a, b: r.b, progress: null })));
}

function settingsView() {
  layout({ useMap: false, tab: 'settings' });
  $('#grab-content').innerHTML = '';
  const s = db.settings;
  const seg = (act, cur, items) => `<div class="seg" role="group">${items.map(([v, l]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  const ex = { mi: 'e.g. 1,553 mi · 845 km/h', nm: 'e.g. 1,350 nm · 456 kn', both: 'e.g. 1,553 mi · 1,350 nm · 845 km/h · 456 kn' }[s.units];
  const demos = db.flights.filter((f) => f.demo).length;
  $('#content').innerHTML = `<div class="stack">
    <h1>Settings</h1>
    <div class="card"><h2>Units</h2>${seg('units', s.units, [['mi', 'Miles · km/h'], ['nm', 'Nautical · kn'], ['both', 'Both']])}<span class="note">${ex}</span></div>
    <div class="card"><h2>Look</h2>${seg('theme', s.theme, [['system', 'Follow phone'], ['dark', 'Dark'], ['light', 'Light']])}
      <div class="between" style="font-size:14px"><span>Times shown in</span><b>Local airport time</b></div></div>
    <div class="card"><h2>Globe</h2>${seg('globe', s.globe || 'sat', [['sat', 'Satellite'], ['day', 'Day photo'], ['flat', 'Flat map']])}
      <span class="note">${{ sat: 'NASA Earth photo in light mode, city lights at night in dark mode.', day: 'NASA daytime Earth photo all the time.', flat: 'Clean drawn map in the app colours — sharpest when zoomed in.' }[s.globe || 'sat']} City names appear as you zoom in.</span></div>
    ${alertsCardHTML()}
    <div class="card"><div class="between"><h2>Live flight data</h2>${hasKey() ? '<span class="pill green">On</span>' : '<span class="pill grey">Off</span>'}</div>
      ${hasKey() ? `<div class="note">Your AeroDataBox key is saved on this phone only.</div>
        <div class="grid2"><button class="btn ghost" data-act="testKey">Test key</button><button class="btn ghost" data-act="removeKey">Remove key</button></div>
        <div style="display:flex;flex-direction:column;gap:6px"><div class="between" style="font-size:13px"><span class="muted">Lookups this month (approx.)</span><b>${Math.round(unitsUsed() / UNITS_PER_LOOKUP)} of ${FREE_UNITS / UNITS_PER_LOOKUP}</b></div>
        <div class="bar"><i style="width:${Math.min(100, unitsUsed() / FREE_UNITS * 100).toFixed(0)}%"></i></div></div>
        <div class="setrow" style="border-top:none"><div style="flex:1"><div style="font-size:14px;font-weight:700">Auto-refresh</div><div class="note">While the app is open: every 30 min in the 6 hours before departure, every 15 min in the last 3 hours and in the air. Pauses at ${AUTO_STOP_AT / UNITS_PER_LOOKUP} lookups.</div></div><button class="switch" role="switch" aria-label="Auto-refresh" aria-checked="${!!s.autoRefresh}" data-act="autoRefresh"></button></div>
        <div class="note">Plane positions on the map come free from adsb.lol / airplanes.live and don't use lookups.</div>`
      : `<div class="note">Turns on: look up flights by number, live delays and gate changes, the real plane on the map, and "Where's my plane?".</div>
        <ol class="note" style="margin:0;padding-left:18px;line-height:1.6"><li>Go to <a href="https://rapidapi.com" target="_blank" rel="noopener">rapidapi.com</a>, sign up, and search for <b>AeroDataBox</b>.</li><li>Subscribe to the free <b>Basic</b> plan (about 200 lookups a month).</li><li>Copy your <b>X-RapidAPI-Key</b> and paste it below.</li></ol>
        <div class="field"><label for="key">Your key</label><input id="key" type="password" autocomplete="off" placeholder="Paste key"></div>
        <button class="btn" data-act="saveKey">Save key</button>
        <div class="note">It stays on this phone only and is sent only to RapidAPI.</div>`}</div>
    <div class="card"><h2>Your data</h2>
      <div class="note">Your flights are saved on this phone only (${db.flights.length} flight${db.flights.length === 1 ? '' : 's'}). Back them up now and then — clearing the browser or changing phones would lose them.</div>
      <div class="grid2"><button class="btn ghost" data-act="export">Export backup</button><button class="btn ghost" data-act="import">Import backup</button></div>
      <input type="file" id="imp" accept="application/json,.json" class="sr" aria-label="Choose backup file">
      ${demos ? `<button class="btn ghost" data-act="removeDemo">Remove ${demos} demo flight${demos === 1 ? '' : 's'}</button>` : ''}</div>
    <div class="note" style="text-align:center">Samflyer ${VERSION} · ${Object.keys(AP).length} airports built in · Map © OpenStreetMap contributors · OpenFreeMap · Earth imagery NASA GIBS</div>
  </div>`;
  $('#imp').addEventListener('change', importBackup);
}

/* ---------- Actions ---------- */
let delArmed = null;
function rerenderSettings() { const y = $('#content').scrollTop; navDir = null; settingsView(); $('#content').scrollTop = y; }
const ACT = {
  homeTab: (el, v) => { if (homeTab === v) return; homeTab = v; navDir = null; home(); applyEnter(v === 'past' ? 'sl' : 'sr', true); },
  period: (el, v) => { ppPeriod = v === 'all' ? 'all' : +v; navDir = null; passportView(true); },
  units: (el, v) => { db.settings.units = v; save(); rerenderSettings(); },
  theme: (el, v) => { db.settings.theme = v; save(); applyTheme(); rerenderSettings(); },
  globe: (el, v) => { db.settings.globe = v; save(); nightBroken = false; nightErrors = 0; restyle(); rerenderSettings(); },
  alert: (el, v) => { db.settings.alerts[v] = !db.settings.alerts[v]; save(); el.setAttribute('aria-checked', String(db.settings.alerts[v])); if (v === 'leave' || v === 'checkin') setTimeout(rerenderSettings, 220); },
  lookupPlanes: async () => {
    if (lookupRun) return;
    const todo = flightsD().filter((f) => f.arr <= Date.now() && !f.demo && f.flightNo && !f.acTried && (!f.aircraft || !f.reg)).sort((p, q) => q.dep - p.dep);
    const left = Math.floor((AUTO_STOP_AT - unitsUsed()) / UNITS_PER_LOOKUP);
    if (left <= 0) return toast(ERR_TEXT.quota);
    const run = todo.slice(0, left);
    lookupRun = { done: 0, total: run.length, found: 0 };
    const paint = () => { const b = $('[data-act=lookupPlanes]'); if (b) b.textContent = `Looking up… ${lookupRun.done} of ${lookupRun.total}`; };
    paint();
    let stop = '';
    for (const f of run) {
      try { if (await lookupAircraft(f.id)) lookupRun.found++; }
      catch (e) { if (['quota', 'badkey', 'nokey'].includes(e.message) || e.name === 'TypeError') { stop = errText(e); break; } const r = db.flights.find((x) => x.id === f.id); if (r) { r.acTried = Date.now(); save(); } }
      lookupRun.done++; paint();
      await new Promise((r) => setTimeout(r, 1100));
    }
    const res = lookupRun; lookupRun = null;
    toast(stop || `Found ${res.found} of ${res.total} planes${res.total - res.found ? ' — the rest keep the best guess' : ''}`);
    if (location.hash.startsWith('#/passport')) { navDir = null; const y = $('#content').scrollTop; route(); $('#content').scrollTop = y; appEl.scrollTop = 0; }
  },
  traffic: () => {
    db.settings.traffic = !db.settings.traffic; save();
    $('#map-tools').innerHTML = trafficButton();
    if (db.settings.traffic) { startTraffic(); if (map && map.getZoom() < 4) toast('Live planes on. Zoom in to see them'); }
    else stopTraffic();
  },
  planeClose: () => closePlane(),
  planeFollow: () => { TR.follow = !TR.follow; paintPlaneCard(); trafficPaint(); },
  friendsFilter: (el, v) => { friendsFilter = v; navDir = null; friendsView(); },
  defLeave: (el, v) => { db.settings.leaveH = parseFloat(v); save(); rerenderSettings(); },
  leave: (el, v) => {
    const [id, h] = v.split('|'); const f = db.flights.find((x) => x.id === id); if (!f) return;
    f.leaveH = parseFloat(h); save();
    const y = $('#content').scrollTop; navDir = null; flightView(id); $('#content').scrollTop = y;
  },
  cal: (el, v) => { const f = findD(v); if (f) sendCalendar([f], `Flight ${prettyNo(f) || f.from + '-' + f.to}`.replace(/\s+/g, ' ')); },
  calAll: () => { const up = flightsD().filter((f) => !f.demo && f.dep > Date.now()); if (up.length) sendCalendar(up, 'Samflyer flights'); },
  clearAlerts: () => { db.alerts = []; save(); navDir = null; alertsView(); updateAlertDot(); },
  fit: () => { userMoved = false; if (lastRoutes) drawRoutes(lastRoutes.routes, Object.assign({}, lastRoutes.opts, { fit: true, force: true })); },
  refresh: async (el, v) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { const ch = await refreshFlight(v); toast(ch.length ? ch.join(' · ') : 'Up to date'); }
    catch (e) { toast(e.message === 'nonumber' ? 'Add a flight number first' : errText(e)); }
    route();
  },
  inbound: async (el, v) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { await checkInbound(v); } catch (e) { toast(errText(e)); }
    route();
  },
  saveKey: () => {
    const k = ($('#key').value || '').trim();
    if (!k) return toast('Paste your key first');
    db.settings.apiKey = k; save(); toast('Key saved on this phone'); rerenderSettings();
  },
  removeKey: () => { db.settings.apiKey = ''; save(); toast('Key removed'); rerenderSettings(); },
  testKey: async (el) => {
    el.disabled = true; el.textContent = 'Testing…';
    try {
      const res = await fetch(`https://${ADB_HOST}/health/services/feeds/FlightSchedules`, { headers: { 'x-rapidapi-key': db.settings.apiKey.trim(), 'x-rapidapi-host': ADB_HOST } });
      toast(res.ok ? 'Key works ✓' : (res.status === 401 || res.status === 403 ? ERR_TEXT.badkey : `Service answered ${res.status}`));
    } catch (e) { toast(errText(e)); }
    el.disabled = false; el.textContent = 'Test key';
  },
  autoRefresh: (el) => { db.settings.autoRefresh = !db.settings.autoRefresh; save(); el.setAttribute('aria-checked', String(db.settings.autoRefresh)); },
  demo: () => { addDemo(); toast('Demo flights added — remove them any time in Settings'); route(); },
  removeDemo: () => { db.flights = db.flights.filter((f) => !f.demo); save(); toast('Demo flights removed'); rerenderSettings(); },
  export: () => {
    const blob = new Blob([JSON.stringify({ app: 'samflyer', version: VERSION, exported: new Date().toISOString(), flights: db.flights, settings: db.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `samflyer-backup-${localDateTime(Date.now(), HOME_TZ).date}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  import: () => $('#imp').click(),
  del: (el, v) => {
    if (delArmed !== v) { delArmed = v; el.classList.add('armed'); el.textContent = 'Tap again to delete'; setTimeout(() => { if (delArmed === v) { delArmed = null; el.classList.remove('armed'); el.textContent = 'Delete flight'; } }, 3500); return; }
    delArmed = null;
    const wasFriend = (db.flights.find((f) => f.id === v) || {}).friend; db.flights = db.flights.filter((f) => f.id !== v); save(); toast('Flight deleted'); location.hash = wasFriend ? '#/friends' : '#/';
  }
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, el.dataset.v, e); }
});
function importBackup(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!data || !Array.isArray(data.flights)) throw new Error('bad');
      const ok = data.flights.filter((f) => f && f.id && AP[f.from] && AP[f.to] && /^\d{4}-\d{2}-\d{2}$/.test(f.depDate) && /^\d{2}:\d{2}$/.test(f.depTime) && /^\d{4}-\d{2}-\d{2}$/.test(f.arrDate) && /^\d{2}:\d{2}$/.test(f.arrTime));
      const byId = new Map(db.flights.map((f) => [f.id, f]));
      ok.forEach((f) => byId.set(f.id, f));
      db.flights = [...byId.values()];
      if (data.settings) db.settings = normalise({ settings: data.settings }).settings;
      save(); applyTheme();
      const skip = data.flights.length - ok.length;
      toast(`Imported ${ok.length} flight${ok.length === 1 ? '' : 's'}` + (skip ? ` · ${skip} skipped` : ''));
      rerenderSettings();
    } catch (err) { toast("That file isn't a Samflyer backup"); }
  };
  r.readAsText(file);
}
function addDemo() {
  const now = Date.now();
  const mk = (from, to, depUtc, durMin, extra) => {
    const A = AP[from], B = AP[to];
    const d = localDateTime(depUtc, A.tz), a = localDateTime(depUtc + durMin * 60000, B.tz);
    return Object.assign({ id: newId(), from, to, depDate: d.date, depTime: d.time, arrDate: a.date, arrTime: a.time, demo: true, created: now }, extra);
  };
  db.flights.push(
    mk('STN', 'SAW', now - 95 * 60000, 230, { flightNo: 'PC1172', airline: 'Pegasus', depTerm: '', depGate: '', arrGate: '204', belt: '7', aircraft: 'A320neo' }),
    mk('SAW', 'BEY', now + 5 * 3600000, 115, { flightNo: 'PC1830', airline: 'Pegasus', depGate: '' }),
    mk('LHR', 'BEY', now - 40 * 86400000, 285, { flightNo: 'ME202', airline: 'Middle East Airlines', aircraft: 'A321neo' }),
    mk('BEY', 'LHR', now - 30 * 86400000, 320, { flightNo: 'ME201', airline: 'Middle East Airlines', aircraft: 'A321neo' }),
    mk('LHR', 'LIS', now - 400 * 86400000, 165, { flightNo: 'TP1351', airline: 'TAP Air Portugal', aircraft: 'A320' }),
    mk('LIS', 'LHR', now - 395 * 86400000, 160, { flightNo: 'TP1352', airline: 'TAP Air Portugal', aircraft: 'A320' })
  );
  save();
}

/* ---------- Router + ticker ---------- */
const TAB_ORDER = { home: 0, friends: 1, passport: 2, settings: 3 };
let prevHash = '', curHash = '';
function route() {
  const parts = (location.hash.slice(1) || '/').split('/');
  const a = parts[1] || '', b = parts[2] || '';
  const screen = (a || 'home') + (b ? '/' + b : '');
  const kind = a || 'home';
  if (prevScreen === null) navDir = 'fade';
  else if (prevScreen === screen) navDir = null;
  else {
    const pk = prevScreen.split('/')[0];
    if (kind in TAB_ORDER && pk in TAB_ORDER) navDir = TAB_ORDER[kind] > TAB_ORDER[pk] ? 'sl' : 'sr';
    else if (!(kind in TAB_ORDER)) navDir = 'up';
    else navDir = 'fade';
  }
  prevScreen = screen;
  if (appEl.scrollTop) appEl.scrollTop = 0;
  if (location.hash !== curHash) { prevHash = curHash; curHash = location.hash; }
  try {
    if (a === 'flight') flightView(decodeURIComponent(b));
    else if (a === 'add') formView(null, b === 'past');
    else if (a === 'edit') formView(decodeURIComponent(b));
    else if (a === 'passport') { if (b === 'aircraft') aircraftAllView(); else passportView(); }
    else if (a === 'settings') settingsView();
    else if (a === 'alerts') alertsView();
    else if (a === 'friends') { if (b === 'add') formView(null, false, true); else friendsView(); }
    else if (a === 'airport') airportView(decodeURIComponent(b).toUpperCase());
    else home();
    applyEnter(navDir);
  } catch (err) {
    console.error(err);
    $('#content').innerHTML = `<div class="card" style="margin-top:12px"><h2>Something went wrong</h2><div class="note">${esc(err.message)}</div><a class="btn ghost" href="#/">Back to My Flights</a></div>`;
  }
}
let refreshing = false;
async function autoRefreshTick() {
  if (refreshing || !hasKey() || !db.settings.autoRefresh || unitsUsed() >= AUTO_STOP_AT || navigator.onLine === false || document.hidden) return;
  const now = Date.now();
  let due = flightsD().filter((f) => f.flightNo && !f.demo && now >= f.dep - 6 * 3600000 && now <= f.arr + 90 * 60000).find((f) => {
    const st = status(f, now);
    if (st.key === 'cancel' || st.key === 'divert') return false;
    const every = (st.key === 'air' || f.dep - now < 3 * 3600000) ? 15 * 60000 : 30 * 60000;
    return !(f.live && f.live.fetchedAt) || now - f.live.fetchedAt >= every;
  });
  // Friends: hourly from 6h before, every 30 min in the air, one last look after landing.
  if (!due) due = friendsD().filter((f) => f.flightNo && now >= f.dep - 6 * 3600000 && now <= f.arr + 3 * 3600000).find((f) => {
    const st = status(f, now), last = (f.live && f.live.fetchedAt) || 0;
    if (st.key === 'cancel' || st.key === 'divert') return false;
    if (now >= f.arr + 20 * 60000) return last < f.arr + 15 * 60000 && !/arrived|landed/i.test((f.live && f.live.status) || '');
    return !last || now - last >= (st.key === 'air' ? 30 : 60) * 60000;
  });
  if (!due) return;
  refreshing = true;
  try {
    const ch = await refreshFlight(due.id);
    if (ch.length) { toast(`${due.from}→${due.to}: ${ch.join(' · ')}`); updateAlertDot(); }
    if (!$('#ff')) route();
  } catch (e) { /* stay quiet; manual Refresh shows errors */ }
  refreshing = false;
}
function tick() {
  autoRefreshTick();
  const now = Date.now();
  let rerender = false;
  $$('[data-cd]').forEach((el) => {
    const t = +el.dataset.cd;
    if (t <= now) rerender = true; else updateFlap(el, cd(t - now));
  });
  $$('[data-clock]').forEach((el) => { el.textContent = fmt(now, el.dataset.clock, 'time'); });
  $$('[data-prog]').forEach((el) => { const [s, e] = el.dataset.prog.split(',').map(Number); el.style.width = (Math.min(1, Math.max(0, (now - s) / (e - s))) * 100).toFixed(1) + '%'; });
  $$('[data-progdot]').forEach((el) => { const [s, e] = el.dataset.progdot.split(',').map(Number); el.style.left = (Math.min(1, Math.max(0, (now - s) / (e - s))) * 100).toFixed(1) + '%'; });
  if (rerender && !$('#ff')) { route(); return; }
  if (mapRefresher) mapRefresher();
}
setInterval(tick, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
window.addEventListener('hashchange', route);

applyTheme();
route();
updateAlertDot();
setTimeout(autoRefreshTick, 1500);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
window.__samflyer = { db: () => db, AP, zonedToUtc, gcMiles, checkInbound, route };
})();
