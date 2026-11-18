/* Samflyer v1 — a personal Flighty-style flight tracker. Everything is stored on this device. */
(() => {
'use strict';
const VERSION = '1.0';
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
const DEFAULT_SETTINGS = { units: 'both', theme: 'system', alerts: { delays: true, gates: true, leave: true, landed: true, belt: true } };
function normalise(d) {
  d = d || {};
  const s = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  s.alerts = Object.assign({}, DEFAULT_SETTINGS.alerts, (d.settings && d.settings.alerts) || {});
  return { flights: Array.isArray(d.flights) ? d.flights : [], settings: s };
}
function load() { try { return normalise(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return normalise({}); } }
let db = load();
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
  const opts = { time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, day: { weekday: 'short', day: 'numeric', month: 'short' }, mon: { month: 'short' }, dnum: { day: 'numeric' }, full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } }[kind];
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

/* ---------- Flights ---------- */
function derive(f) {
  const A = AP[f.from], B = AP[f.to];
  if (!A || !B) return null;
  const dep = zonedToUtc(f.depDate, f.depTime, A.tz);
  const arr = zonedToUtc(f.arrDate, f.arrTime, B.tz);
  return Object.assign({}, f, { A, B, dep, arr, mi: gcMiles(A, B), dur: arr - dep });
}
function flightsD() { return db.flights.map(derive).filter(Boolean); }
function findD(id) { const f = db.flights.find((x) => x.id === id); return f ? derive(f) : null; }
function status(f, now = Date.now()) {
  if (now < f.dep) return f.dep - now < 3 * 3600000 ? { key: 'soon', label: 'Departs soon', cls: 'amber' } : { key: 'sched', label: 'Scheduled', cls: 'grey' };
  if (now < f.arr) return { key: 'air', label: 'In the air', cls: 'blue' };
  return { key: 'landed', label: 'Landed', cls: 'green' };
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
  return [...String(str)].map((c) => (c === ':' || c === ' ' || /[a-z]/.test(c))
    ? `<span class="u">${c === ' ' ? '&nbsp;' : esc(c.toUpperCase())}</span>`
    : `<span class="t">${esc(c)}</span>`).join('');
}
function flap(str, size = 'md', attrs = '') { return `<span class="flap ${size}" ${attrs} aria-label="${esc(String(str).toUpperCase())}">${flapInner(str)}</span>`; }
function updateFlap(el, str) {
  const tmp = document.createElement('span');
  tmp.innerHTML = flapInner(str);
  const olds = [...el.children], news = [...tmp.children];
  if (olds.length !== news.length) { el.innerHTML = tmp.innerHTML; return; }
  news.forEach((n, i) => {
    if (olds[i].textContent !== n.textContent) {
      olds[i].textContent = n.textContent;
      olds[i].classList.remove('flip'); void olds[i].offsetWidth; olds[i].classList.add('flip');
    }
  });
  el.setAttribute('aria-label', String(str).toUpperCase());
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
  setTiles();
  if (lastRoutes) drawRoutes(lastRoutes, { fit: false });
}
if (mq.addEventListener) mq.addEventListener('change', applyTheme); else if (mq.addListener) mq.addListener(applyTheme);

/* ---------- Map ---------- */
let map = null, tiles = null, layer = null, tileTheme = null, lastRoutes = null;
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function initMap() {
  if (map) return;
  if (!window.L) { $('#map-fallback').style.display = 'block'; return; }
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 2, maxZoom: 10 }).setView([46, 12], 4);
  map.attributionControl.setPosition('topright');
  map.attributionControl.setPrefix(false);
  layer = L.layerGroup().addTo(map);
  setTiles();
}
function setTiles() {
  if (!map) return;
  const t = currentTheme();
  if (t === tileTheme) return;
  tileTheme = t;
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${t === 'dark' ? 'dark_nolabels' : 'light_nolabels'}/{z}/{x}/{y}{r}.png`, {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
}
function planeSVG(b, color) {
  return `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${b.toFixed(0)}deg)"><path d="M0,-11 L1.6,-3.5 L10,2 L10,3.8 L1.6,1.6 L1.2,7.5 L4.2,9.6 L4.2,10.8 L0,9.8 L-4.2,10.8 L-4.2,9.6 L-1.2,7.5 L-1.6,1.6 L-10,3.8 L-10,2 L-1.6,-3.5 Z" fill="${color}"/></svg>`;
}
/* routes: [{a, b, progress (0..1 or null), dim}] */
function drawRoutes(routes, opts = {}) {
  lastRoutes = routes;
  if (!map) return;
  layer.clearLayers();
  const arc = cssVar('--arc'), dim = cssVar('--arc-dim'), plane = cssVar('--plane');
  const seen = new Set(), bounds = [];
  routes.forEach((r) => {
    const pts = gcPoints(r.a, r.b);
    pts.forEach((p) => bounds.push(p));
    if (r.progress != null && r.progress > 0 && r.progress < 1) {
      const k = Math.min(pts.length - 2, Math.max(1, Math.round(r.progress * (pts.length - 1))));
      const flown = pts.slice(0, k + 1), rest = pts.slice(k);
      L.polyline(flown, { color: arc, weight: 9, opacity: 0.25, interactive: false }).addTo(layer);
      L.polyline(flown, { color: arc, weight: 2.6, opacity: 1, interactive: false }).addTo(layer);
      L.polyline(rest, { color: arc, weight: 2, opacity: 0.7, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(layer);
      const brg = bearing(pts[k - 1], pts[k + 1]);
      L.marker(pts[k], { icon: L.divIcon({ className: 'plane-icon', html: planeSVG(brg, plane), iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false, zIndexOffset: 1000 }).addTo(layer);
    } else {
      L.polyline(pts, { color: arc, weight: 8, opacity: r.dim ? 0.06 : 0.22, interactive: false }).addTo(layer);
      L.polyline(pts, { color: r.dim ? dim : arc, weight: r.dim ? 1.6 : 2.4, opacity: 1, interactive: false }).addTo(layer);
    }
    [r.a, r.b].forEach((ap) => {
      if (seen.has(ap.code)) return;
      seen.add(ap.code);
      L.circleMarker([ap.lat, ap.lon], { radius: 4, color: arc, fillColor: arc, fillOpacity: 1, weight: 1, interactive: false })
        .bindTooltip(ap.code, { permanent: true, direction: 'right', className: 'ap-label', offset: [4, 0] }).addTo(layer);
    });
  });
  if (opts.fit !== false) fitTo(bounds);
}
function fitTo(bounds) {
  if (!map) return;
  map.invalidateSize();
  if (!bounds.length) { map.setView([46, 12], 4, { animate: false }); return; }
  const top = 80, bottom = visibleSheet() + 16;
  map.fitBounds(L.latLngBounds(bounds), { paddingTopLeft: [40, top], paddingBottomRight: [40, bottom], maxZoom: 6, animate: false });
}

/* ---------- Sheet ---------- */
const sheet = $('#sheet'), grab = $('#grab');
let snap = 'half', snaps = { full: 0, half: 0, peek: 0 };
function computeSnaps() {
  const H = sheet.offsetHeight, vh = window.innerHeight;
  snaps = { full: 0, half: Math.max(0, H - Math.round(vh * 0.56)), peek: Math.max(0, H - 190) };
}
function setSnap(s, anim = true) {
  snap = s;
  computeSnaps();
  sheet.classList.toggle('anim', anim);
  sheet.style.transform = `translateY(${snaps[s]}px)`;
}
function visibleSheet() {
  if (document.body.classList.contains('no-map')) return 0;
  computeSnaps();
  return sheet.offsetHeight - (snaps[snap] || 0);
}
let drag = null;
grab.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('no-map')) return;
  if (e.target.closest('button,a,input,select,label')) return;
  computeSnaps();
  drag = { y: e.clientY, start: snaps[snap], cur: snaps[snap], moved: false };
  try { grab.setPointerCapture(e.pointerId); } catch (_) {}
  sheet.classList.remove('anim');
});
grab.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (Math.abs(dy) > 5) drag.moved = true;
  drag.cur = Math.min(snaps.peek, Math.max(0, drag.start + dy));
  sheet.style.transform = `translateY(${drag.cur}px)`;
});
function endDrag(cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) { if (!cancel) setSnap(snap === 'full' ? 'half' : 'full'); else setSnap(snap); return; }
  const best = ['full', 'half', 'peek'].reduce((b, k) => (Math.abs(snaps[k] - d.cur) < Math.abs(snaps[b] - d.cur) ? k : b), 'full');
  setSnap(best);
}
grab.addEventListener('pointerup', () => endDrag(false));
grab.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('resize', () => { if (!document.body.classList.contains('no-map')) setSnap(snap, false); });

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
  mapRefresher = null;
  if (useMap) { initMap(); setSnap(snapTo, false); } else { sheet.classList.remove('anim'); sheet.style.transform = 'none'; }
  $('#content').scrollTop = 0;
}
let toastTimer = null;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}
const pill = (st) => `<span class="pill ${st.cls}">${esc(st.label)}</span>`;

/* ---------- Views ---------- */
let homeTab = 'upcoming', ppPeriod = 'all';

function home() {
  layout({ tab: 'home', snapTo: 'half' });
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

function flightView(id) {
  const f = findD(id);
  if (!f) { location.hash = '#/'; return; }
  layout({ tabs: false, snapTo: 'half', left: `<a class="round" href="#/" aria-label="Back to flights">${ICON.back}</a>`, right: `<button class="round" data-act="fit" aria-label="Show whole route">${ICON.fit}</button><a class="round" href="#/edit/${esc(f.id)}" aria-label="Edit flight">${ICON.edit}</a>` });
  const now = Date.now(), st = status(f, now), p = progress(f, now);
  let cdLabel, cdVal, cdAttr = '', g2Label, g2Val, g3Label, g3Val;
  if (st.key === 'air') { cdLabel = 'Lands in'; cdVal = cd(f.arr - now); cdAttr = `data-cd="${f.arr}"`; g2Label = 'Arr gate'; g2Val = gateStr(f.arrGate); g3Label = 'Bag belt'; g3Val = gateStr(f.belt).replace('TBA', '—'); }
  else if (st.key === 'landed') { cdLabel = 'Landed'; cdVal = fmt(f.arr, f.B.tz, 'time'); g2Label = 'Arr gate'; g2Val = gateStr(f.arrGate); g3Label = 'Bag belt'; g3Val = gateStr(f.belt).replace('TBA', '—'); }
  else { cdLabel = 'Departs in'; cdVal = cd(f.dep - now); cdAttr = `data-cd="${f.dep}"`; g2Label = 'Gate'; g2Val = gateStr(f.depGate); g3Label = 'Seat'; g3Val = f.seat ? String(f.seat).toUpperCase().slice(0, 4) : '—'; }
  const yourTime = (ts, tz) => (tz !== HOME_TZ && tzOffset(ts, tz) !== tzOffset(ts, HOME_TZ)) ? `<div class="muted" style="font-size:11px">${fmt(ts, HOME_TZ, 'time')} your time</div>` : '';
  $('#grab-content').innerHTML = `
    <div class="stack" style="gap:16px;padding-bottom:6px">
      <div class="row"><div class="badge">${esc(codeOf(f))}</div>
        <div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:700">${esc(titleOf(f))}</div><div class="muted" style="font-size:12px">${esc(f.A.city)} → ${esc(f.B.city)} · ${fmt(f.dep, f.A.tz, 'day')}</div></div>
        ${pill(st)}</div>
      <div class="between">
        <div style="display:flex;flex-direction:column;gap:6px">${flap(f.from, 'md')}<div class="num" style="font-size:12px"><span class="muted">Departs</span> <b>${fmt(f.dep, f.A.tz, 'time')}</b></div>${yourTime(f.dep, f.A.tz)}</div>
        <span class="muted">${ICON.plane}</span>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;text-align:right">${flap(f.to, 'md')}<div class="num" style="font-size:12px"><span class="muted">Arrives</span> <b>${fmt(f.arr, f.B.tz, 'time')}</b>${plusDays(f)}</div>${yourTime(f.arr, f.B.tz)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="bar"><i data-prog="${f.dep},${f.arr}" style="width:${(p * 100).toFixed(1)}%"></i>${st.key === 'air' ? `<b data-progdot="${f.dep},${f.arr}" style="left:${(p * 100).toFixed(1)}%"></b>` : ''}</div>
        <div class="between muted num" style="font-size:12px"><span>${st.key === 'air' ? 'Estimated from schedule' : durStr(f.dur) + ' flight'}</span><span>${distStr(f.mi)}</span></div>
      </div>
      <div class="grid3">
        <div style="display:flex;flex-direction:column;gap:6px"><span class="lbl">${cdLabel}</span>${flap(cdVal, 'sm', cdAttr)}</div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:center"><span class="lbl">${g2Label}</span>${flap(g2Val, 'sm')}</div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="lbl">${g3Label}</span>${flap(g3Val, 'sm')}</div>
      </div>
    </div>`;
  const row = (k, v, sub = '') => `<span class="muted">${k}</span><span class="t1 num">${v}${sub ? `<div class="muted" style="font-size:11px;font-weight:500">${sub}</div>` : ''}</span>`;
  const homeSub = (ts, tz) => (tz !== HOME_TZ && tzOffset(ts, tz) !== tzOffset(ts, HOME_TZ)) ? `${fmt(ts, HOME_TZ, 'time')} your time` : '';
  const det = (k, v) => `<div class="stat"><span class="lbl">${k}</span><span class="big">${v ? esc(v) : '<span class="muted">—</span>'}</span></div>`;
  $('#content').innerHTML = `<div class="stack" style="padding-top:12px">
    <div class="card"><h2>Timeline</h2>
      <div class="tl">${row('Departure · ' + f.from, fmt(f.dep, f.A.tz, 'day') + ' ' + fmt(f.dep, f.A.tz, 'time'), homeSub(f.dep, f.A.tz))}
      ${row('Arrival · ' + f.to, fmt(f.arr, f.B.tz, 'day') + ' ' + fmt(f.arr, f.B.tz, 'time'), homeSub(f.arr, f.B.tz))}
      ${row('Flight time', durStr(f.dur))}
      ${st.key === 'landed' ? row('Landed', agoStr(now - f.arr)) : ''}</div>
      <div class="note">${esc(offsetDiffStr(f))}. Times are local to each airport.</div></div>
    <div class="card"><div class="between"><h2>Where's my plane?</h2><span class="pill grey">Live data</span></div>
      <div class="note">Coming with live flight data in the next update: it will show where this plane is now, its previous flight, and whether a delay is heading your way.</div></div>
    <div class="grid2">
      <div class="stat"><span class="lbl">Distance</span><span class="big num" style="font-size:16px">${distStr(f.mi)}</span></div>
      <div class="stat"><span class="lbl">Avg speed</span><span class="big num" style="font-size:16px">${speedStr(f.mi / (f.dur / 3600000))}</span></div>
    </div>
    <div class="card"><div class="between"><h2>Details</h2><a href="#/edit/${esc(f.id)}" style="font-size:14px;font-weight:700">Edit</a></div>
      <div class="grid3">${det('Terminal', f.depTerm)}${det('Gate', f.depGate)}${det('Seat', f.seat)}${det('Arr gate', f.arrGate)}${det('Bag belt', f.belt)}${det('Aircraft', f.aircraft)}</div></div>
    <button class="btn danger" data-act="del" data-v="${esc(f.id)}">Delete flight</button>
  </div>`;
  drawRoutes([{ a: f.A, b: f.B, progress: st.key === 'air' ? p : null }]);
  if (st.key !== 'landed') mapRefresher = () => { const g = findD(id); if (g) drawRoutes([{ a: g.A, b: g.B, progress: status(g).key === 'air' ? progress(g) : null }], { fit: false }); };
}

function formView(id, pastMode) {
  const existing = id ? db.flights.find((x) => x.id === id) : null;
  if (id && !existing) { location.hash = '#/'; return; }
  const f = existing || { flightNo: '', airline: '', from: '', to: '', depDate: pastMode ? '' : localDateTime(Date.now(), HOME_TZ).date, depTime: '', arrDate: '', arrTime: '' };
  layout({ tabs: false, snapTo: 'full', left: `<a class="round" href="${existing ? '#/flight/' + esc(existing.id) : '#/'}" aria-label="Close">${ICON.close}</a>` });
  let mode = pastMode ? 'past' : 'upcoming';
  $('#grab-content').innerHTML = `<div class="between" style="padding-bottom:8px"><h1>${existing ? 'Edit flight' : 'Add flight'}</h1></div>`;
  const opts = Object.values(AP).map((a) => `<option value="${a.code}">${esc(a.city)} — ${esc(a.name)}</option>`).join('');
  const v = (k) => esc(f[k] || '');
  $('#content').innerHTML = `<form id="ff" class="stack" novalidate autocomplete="off">
    ${existing ? '' : `<div class="seg" role="group" aria-label="Flight type"><button type="button" data-mode="upcoming" aria-pressed="${mode === 'upcoming'}">Upcoming</button><button type="button" data-mode="past" aria-pressed="${mode === 'past'}">Past flight</button></div>`}
    <div class="grid2">
      <div class="field"><label for="f-no">Flight number</label><input id="f-no" class="code" value="${v('flightNo')}" placeholder="PC1172" inputmode="text" autocapitalize="characters"></div>
      <div class="field"><label for="f-al">Airline</label><input id="f-al" value="${v('airline')}" placeholder="Auto from number"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="f-from">From</label><input id="f-from" class="code" list="aplist" value="${v('from')}" placeholder="LHR" maxlength="3" autocapitalize="characters"><span class="hint" id="h-from">&nbsp;</span></div>
      <div class="field"><label for="f-to">To</label><input id="f-to" class="code" list="aplist" value="${v('to')}" placeholder="IST" maxlength="3" autocapitalize="characters"><span class="hint" id="h-to">&nbsp;</span></div>
    </div>
    <datalist id="aplist">${opts}</datalist>
    <div class="grid2">
      <div class="field"><label for="f-dd">Departure date</label><input id="f-dd" type="date" value="${v('depDate')}"></div>
      <div class="field"><label for="f-dt">Departs (local)</label><input id="f-dt" type="time" value="${v('depTime')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="f-ad">Arrival date</label><input id="f-ad" type="date" value="${v('arrDate')}"><span class="hint">Fills itself in</span></div>
      <div class="field"><label for="f-at">Arrives (local)</label><input id="f-at" type="time" value="${v('arrTime')}"></div>
    </div>
    <div class="note" id="f-sum">&nbsp;</div>
    <details ${existing && (existing.depGate || existing.seat || existing.depTerm || existing.arrGate || existing.belt || existing.aircraft) ? 'open' : ''}><summary>More details (gate, seat, belt…)</summary>
      <div class="grid3" style="margin-top:8px">
        <div class="field"><label for="f-term">Terminal</label><input id="f-term" value="${v('depTerm')}"></div>
        <div class="field"><label for="f-gate">Gate</label><input id="f-gate" value="${v('depGate')}"></div>
        <div class="field"><label for="f-seat">Seat</label><input id="f-seat" value="${v('seat')}"></div>
        <div class="field"><label for="f-agate">Arr gate</label><input id="f-agate" value="${v('arrGate')}"></div>
        <div class="field"><label for="f-belt">Bag belt</label><input id="f-belt" value="${v('belt')}"></div>
        <div class="field"><label for="f-ac">Aircraft</label><input id="f-ac" value="${v('aircraft')}" placeholder="A320"></div>
      </div></details>
    <div class="hint err" id="f-err" role="alert" style="font-size:13px;color:var(--red)"></div>
    <button class="btn" type="submit" id="f-save">${existing ? 'Save changes' : (mode === 'past' ? 'Add to Passport' : 'Add to My Flights')}</button>
    <div class="note" style="text-align:center">Copy the times from your booking for now. Searching by flight number arrives with live data in the next update.</div>
  </form>`;
  const form = $('#ff'), q = (s) => $(s, form);
  let arrTouched = !!existing;
  q('#f-ad').addEventListener('input', () => { arrTouched = true; });
  $$('[data-mode]', form).forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    $$('[data-mode]', form).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    q('#f-save').textContent = mode === 'past' ? 'Add to Passport' : 'Add to My Flights';
  }));
  q('#f-no').addEventListener('input', (e) => {
    const val = e.target.value.toUpperCase().replace(/\s+/g, '');
    e.target.value = val;
    const name = AIRLINES[val.slice(0, 2)];
    const al = q('#f-al');
    if (name && (!al.value || al.dataset.auto === '1')) { al.value = name; al.dataset.auto = '1'; }
  });
  q('#f-al').addEventListener('input', (e) => { e.target.dataset.auto = '0'; });
  function upd() {
    ['from', 'to'].forEach((k) => {
      const el = q('#f-' + k), h = q('#h-' + k);
      el.value = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
      const a = AP[el.value];
      h.className = 'hint' + (el.value.length === 3 && !a ? ' err' : '');
      h.textContent = a ? `${a.city} · ${a.name}` : (el.value.length === 3 ? 'Not in the airport list yet' : ' ');
    });
    const A = AP[q('#f-from').value], B = AP[q('#f-to').value];
    const dd = q('#f-dd').value, dt = q('#f-dt').value, at = q('#f-at').value;
    if (A && B && dd && dt && at && !arrTouched) {
      const dep = zonedToUtc(dd, dt, A.tz);
      let ad = dd;
      for (let i = 0; i < 3; i++) {
        if (zonedToUtc(ad, at, B.tz) > dep) break;
        const d = new Date(ad + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); ad = d.toISOString().slice(0, 10);
      }
      q('#f-ad').value = ad;
    }
    const ad = q('#f-ad').value;
    if (A && B) {
      let s = distStr(gcMiles(A, B));
      if (dd && dt && ad && at) {
        const dur = zonedToUtc(ad, at, B.tz) - zonedToUtc(dd, dt, A.tz);
        if (dur > 0) s = `${durStr(dur)} flight · ` + s;
      }
      q('#f-sum').textContent = `${A.city} → ${B.city} · ${s}`;
      drawRoutes([{ a: A, b: B }]);
    } else q('#f-sum').textContent = ' ';
  }
  form.addEventListener('input', (e) => { if (e.target.id !== 'f-no' && e.target.id !== 'f-al') upd(); });
  upd();
  if (!A0()) drawRoutes([]);
  function A0() { return AP[q('#f-from').value] && AP[q('#f-to').value]; }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = (m) => { q('#f-err').textContent = m; };
    const rec = {
      id: existing ? existing.id : newId(),
      flightNo: q('#f-no').value.trim().toUpperCase(), airline: q('#f-al').value.trim(),
      from: q('#f-from').value, to: q('#f-to').value,
      depDate: q('#f-dd').value, depTime: q('#f-dt').value, arrDate: q('#f-ad').value, arrTime: q('#f-at').value,
      depTerm: q('#f-term').value.trim(), depGate: q('#f-gate').value.trim(), seat: q('#f-seat').value.trim(),
      arrGate: q('#f-agate').value.trim(), belt: q('#f-belt').value.trim(), aircraft: q('#f-ac').value.trim(),
      demo: false, created: existing ? existing.created : Date.now()
    };
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
    toast(existing ? 'Flight updated' : (d.arr < Date.now() ? 'Added to your Passport' : 'Flight added'));
    location.hash = '#/flight/' + rec.id;
  });
}

function passportView() {
  layout({ tab: 'passport', snapTo: 'half' });
  const now = Date.now();
  const past = flightsD().filter((f) => f.arr <= now);
  const years = [...new Set(past.map(yearOf))].sort((a, b) => b - a);
  if (ppPeriod !== 'all' && !years.includes(+ppPeriod)) ppPeriod = 'all';
  const sel = past.filter((f) => ppPeriod === 'all' || yearOf(f) === +ppPeriod);
  const periodLabel = ppPeriod === 'all' ? 'All time' : String(ppPeriod);
  $('#grab-content').innerHTML = `<div class="between" style="flex-wrap:wrap;padding-bottom:6px"><h1>Passport</h1>
    <div class="chips" role="group" aria-label="Period">${['all', ...years].map((y) => `<button data-act="period" data-v="${y}" aria-pressed="${String(y) === String(ppPeriod)}">${y === 'all' ? 'All time' : y}</button>`).join('')}</div></div>`;
  const routes = dedupeRoutes(sel);
  $('#top-right').innerHTML = past.length ? `<span class="chip-float">${routes.length} route${routes.length === 1 ? '' : 's'} · ${periodLabel}</span>` : '';
  if (!past.length) {
    $('#content').innerHTML = `<div class="card empty" style="margin-top:12px"><div style="font-size:17px;font-weight:800">Your Passport is empty</div><div class="note">Flights you've taken appear here with lifetime miles, hours, airports and countries. Add your older trips to fill it in.</div><a class="btn" href="#/add/past">${ICON.plus}Add a past flight</a>${db.flights.some((f) => f.demo) ? '' : '<button class="btn ghost" data-act="demo">Try it with demo flights</button>'}</div>`;
    drawRoutes([]);
    return;
  }
  const miles = sel.reduce((s, f) => s + f.mi, 0), hrs = sel.reduce((s, f) => s + f.dur, 0) / 3600000;
  const count = (fn) => new Set(sel.flatMap(fn).filter(Boolean)).size;
  const airports = count((f) => [f.from, f.to]), countries = count((f) => [f.A.cc, f.B.cc]);
  const airlines = count((f) => [f.airline || codeOf(f)]), planes = count((f) => [(f.aircraft || '').toUpperCase()]);
  const earth = miles / 24901;
  const topR = routes.sort((a, b) => b.n - a.n).slice(0, 5);
  const alMap = new Map();
  sel.forEach((f) => { const k = f.airline || codeOf(f); alMap.set(k, (alMap.get(k) || 0) + 1); });
  const topA = [...alMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxA = topA.length ? topA[0][1] : 1;
  const stat = (l, v) => `<div class="stat"><span class="lbl">${l}</span>${flap(String(v), 'sm')}</div>`;
  const u = db.settings.units;
  const milesBig = u === 'nm' ? miles * 0.868976 : miles;
  $('#content').innerHTML = `<div class="stack" style="padding-top:12px">
    <div class="card"><span class="lbl">${u === 'nm' ? 'Nautical miles flown' : 'Miles flown'}</span>
      <div style="overflow-x:auto">${flap(nf.format(milesBig).replace(/,/g, ' '), 'md')}</div>
      <span class="muted num" style="font-size:12px">${nf.format(miles * 1.609344)} km${u === 'both' ? ` · ${nf.format(miles * 0.868976)} nm` : ''}</span>
      <div class="bar"><i style="width:${Math.min(100, earth * 100).toFixed(0)}%"></i></div>
      <span style="font-size:12px;font-weight:600">${earth.toFixed(2)}× around the Earth${earth >= 1 ? ' 🌍' : ''}</span></div>
    <div class="grid3">${stat('Flights', sel.length)}${stat('Hours', Math.round(hrs))}${stat('Airports', airports)}${stat('Countries', countries)}${stat('Airlines', airlines)}${stat('Planes', planes || '—')}</div>
    <div class="card"><h2>Top routes</h2>${topR.map((r) => `<div class="between" style="font-size:14px"><span style="font-weight:700">${r.a.code} ↔ ${r.b.code} <span class="muted" style="font-weight:500">${esc(r.a.city)} · ${esc(r.b.city)}</span></span><span class="muted">${r.n}×</span></div>`).join('')}</div>
    <div class="card"><h2>Top airlines</h2>${topA.map(([n, c]) => `<div style="display:flex;flex-direction:column;gap:4px"><div class="between" style="font-size:14px"><span style="font-weight:700">${esc(n)}</span><span class="muted">${c}</span></div><div class="bar"><i style="width:${(c / maxA * 100).toFixed(0)}%"></i></div></div>`).join('')}</div>
    <a class="btn dash" href="#/add/past">${ICON.plus}Add a past flight</a>
  </div>`;
  drawRoutes(routes.map((r) => ({ a: r.a, b: r.b, progress: null })));
}

function settingsView() {
  layout({ useMap: false, tab: 'settings' });
  $('#grab-content').innerHTML = '';
  const s = db.settings;
  const seg = (act, cur, items) => `<div class="seg" role="group">${items.map(([v, l]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  const ex = { mi: 'e.g. 1,553 mi · 845 km/h', nm: 'e.g. 1,350 nm · 456 kn', both: 'e.g. 1,553 mi · 1,350 nm · 845 km/h · 456 kn' }[s.units];
  const alerts = [['delays', 'Delays', 'When departure or arrival times change'], ['gates', 'Gate & terminal changes', 'As soon as the airport posts a change'], ['leave', 'Time to leave', 'Reminder before check-in closes'], ['landed', 'Landed', 'When the plane touches down'], ['belt', 'Bag belt', 'Which belt your bags come out on']];
  const demos = db.flights.filter((f) => f.demo).length;
  $('#content').innerHTML = `<div class="stack">
    <h1>Settings</h1>
    <div class="card"><h2>Units</h2>${seg('units', s.units, [['mi', 'Miles · km/h'], ['nm', 'Nautical · kn'], ['both', 'Both']])}<span class="note">${ex}</span></div>
    <div class="card"><h2>Look</h2>${seg('theme', s.theme, [['system', 'Follow phone'], ['dark', 'Dark'], ['light', 'Light']])}
      <div class="between" style="font-size:14px"><span>Times shown in</span><b>Local airport time</b></div></div>
    <div class="card" style="gap:2px"><h2 style="margin-bottom:6px">Alerts</h2>
      ${alerts.map(([k, l, d]) => `<div class="setrow"><div style="flex:1"><div style="font-size:14px;font-weight:700">${l}</div><div class="note">${d}</div></div><button class="switch" role="switch" aria-label="${l}" aria-checked="${!!s.alerts[k]}" data-act="alert" data-v="${k}"></button></div>`).join('')}
      <div class="notice" style="margin-top:10px">Alerts switch on in a later update — your choices are saved now. They will need the app installed on your home screen.</div></div>
    <div class="card"><div class="between"><h2>Live flight data</h2><span class="pill grey">Next update</span></div>
      <div class="note">Next, you'll paste your own free flight-data key here (it stays on this phone). That unlocks search by flight number, live status and delays, gate changes, the live plane on the map and "Where's my plane?".</div></div>
    <div class="card"><h2>Your data</h2>
      <div class="note">Your flights are saved on this phone only (${db.flights.length} flight${db.flights.length === 1 ? '' : 's'}). Back them up now and then — clearing the browser or changing phones would lose them.</div>
      <div class="grid2"><button class="btn ghost" data-act="export">Export backup</button><button class="btn ghost" data-act="import">Import backup</button></div>
      <input type="file" id="imp" accept="application/json,.json" class="sr" aria-label="Choose backup file">
      ${demos ? `<button class="btn ghost" data-act="removeDemo">Remove ${demos} demo flight${demos === 1 ? '' : 's'}</button>` : ''}</div>
    <div class="note" style="text-align:center">Samflyer ${VERSION} · ${Object.keys(AP).length} airports built in · Map © OpenStreetMap contributors © CARTO</div>
  </div>`;
  $('#imp').addEventListener('change', importBackup);
}

/* ---------- Actions ---------- */
let delArmed = null;
const ACT = {
  homeTab: (el, v) => { homeTab = v; home(); },
  period: (el, v) => { ppPeriod = v === 'all' ? 'all' : +v; passportView(); },
  units: (el, v) => { db.settings.units = v; save(); settingsView(); },
  theme: (el, v) => { db.settings.theme = v; save(); applyTheme(); settingsView(); },
  alert: (el, v) => { db.settings.alerts[v] = !db.settings.alerts[v]; save(); el.setAttribute('aria-checked', String(db.settings.alerts[v])); },
  fit: () => { if (lastRoutes) drawRoutes(lastRoutes); },
  demo: () => { addDemo(); toast('Demo flights added — remove them any time in Settings'); route(); },
  removeDemo: () => { db.flights = db.flights.filter((f) => !f.demo); save(); toast('Demo flights removed'); settingsView(); },
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
    db.flights = db.flights.filter((f) => f.id !== v); save(); toast('Flight deleted'); location.hash = '#/';
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
      toast(`Imported ${ok.length} flight${ok.length === 1 ? '' : 's'}`);
      settingsView();
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
function route() {
  const parts = (location.hash.slice(1) || '/').split('/');
  const a = parts[1] || '', b = parts[2] || '';
  try {
    if (a === 'flight') flightView(decodeURIComponent(b));
    else if (a === 'add') formView(null, b === 'past');
    else if (a === 'edit') formView(decodeURIComponent(b));
    else if (a === 'passport') passportView();
    else if (a === 'settings') settingsView();
    else home();
  } catch (err) {
    console.error(err);
    $('#content').innerHTML = `<div class="card" style="margin-top:12px"><h2>Something went wrong</h2><div class="note">${esc(err.message)}</div><a class="btn ghost" href="#/">Back to My Flights</a></div>`;
  }
}
function tick() {
  const now = Date.now();
  let rerender = false;
  $$('[data-cd]').forEach((el) => {
    const t = +el.dataset.cd;
    if (t <= now) rerender = true; else updateFlap(el, cd(t - now));
  });
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
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__samflyer = { db: () => db, AP, zonedToUtc, gcMiles };
})();
