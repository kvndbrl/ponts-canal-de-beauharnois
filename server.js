const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const AIS_API_KEY = process.env.AIS_API_KEY || 'f34af67c17c71094f8c307646b6e5db74f860168';
const AIS_BBOX = [[45.18, -74.02], [45.22, -73.95]];
let vesselNearBridge = { gonzague: null, larocque: null };
const BRIDGES = {
  gonzague: { lat: 45.2053, lon: -73.9855 },
  larocque: { lat: 45.1942, lon: -74.0020 }
};
const VALID_HEADINGS = [[60, 120], [240, 300]];
const vesselHistory = new Map();
const MAX_HISTORY = 20;

function isValidHeading(cog) {
  if (cog === undefined || cog === null || cog === 511) return true;
  return VALID_HEADINGS.some(([min, max]) => cog >= min && cog <= max);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getBestVesselForBridge(bridge) {
  const bp = BRIDGES[bridge];
  const now = Date.now();
  const candidates = [];
  for (const [mmsi, history] of vesselHistory.entries()) {
    if (!history.length) continue;
    const recent = history.filter(p => now - p.ts < 300000);
    if (!recent.length) continue;
    const latest = recent[recent.length - 1];
    const distKm = haversineKm(latest.lat, latest.lon, bp.lat, bp.lon);
    if (distKm > 2.0) continue;
    const isMoving = recent.length > 1;
    const headingOk = isValidHeading(latest.cog);
    let confidence = 0;
    confidence += Math.max(0, 100 - distKm * 50);
    if (headingOk) confidence += 20;
    if (isMoving) confidence += 10;
    const crossed = recent.some(p => haversineKm(p.lat, p.lon, bp.lat, bp.lon) < 0.3);
    if (crossed) confidence += 30;
    candidates.push({ mmsi, name: latest.name, distKm, confidence, cog: latest.cog });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  if (best.confidence < 40) return null;
  return { name: best.name, mmsi: best.mmsi, distKm: Math.round(best.distKm * 10) / 10, confidence: Math.round(best.confidence), cog: best.cog };
}

function startAISTracking() {
  let ws;
  let reconnectDelay = 30000;
  const MAX_DELAY = 300000;
  function connect() {
    ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.on('open', () => {
      log('AIS WebSocket connect\u00e9');
      reconnectDelay = 30000;
      ws.send(JSON.stringify({ APIKey: AIS_API_KEY, BoundingBoxes: [AIS_BBOX], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const meta = msg.MetaData;
        if (!meta) return;
        const lat = meta.latitude;
        const lon = meta.longitude;
        const mmsi = String(meta.MMSI || '');
        const name = meta.ShipName?.trim().replace(/[^\x20-\x7E]/g, '').trim() || null;
        if (!name || name === '!!!ANYSUCHVESSEL!!!' || !mmsi) return;
        const cog = msg.Message?.PositionReport?.Cog ?? null;
        if (!vesselHistory.has(mmsi)) vesselHistory.set(mmsi, []);
        const hist = vesselHistory.get(mmsi);
        hist.push({ lat, lon, cog, name, ts: Date.now() });
        if (hist.length > MAX_HISTORY) hist.shift();
        for (const bridge of ['gonzague', 'larocque']) {
          const best = getBestVesselForBridge(bridge);
          if (best) {
            vesselNearBridge[bridge] = { ...best, updatedAt: Date.now() };
            if (!vesselNearBridge[bridge]._logged) {
              log('Navire d\u00e9tect\u00e9 [' + bridge + ']: ' + best.name + ' \u00e0 ' + best.distKm + 'km');
              vesselNearBridge[bridge]._logged = true;
            }
          }
        }
      } catch(e) {}
    });
    ws.on('close', () => {
      log('AIS WebSocket d\u00e9connect\u00e9 - reconnexion dans ' + reconnectDelay/1000 + 's');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    });
    ws.on('error', (e) => {
      log('AIS erreur: ' + e.message);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    });
  }
  connect();
}

setInterval(() => {
  const now = Date.now();
  for (const [mmsi, hist] of vesselHistory.entries()) {
    const recent = hist.filter(p => now - p.ts < 600000);
    if (!recent.length) vesselHistory.delete(mmsi);
    else vesselHistory.set(mmsi, recent);
  }
  for (const bridge of ['gonzague', 'larocque']) {
    const best = getBestVesselForBridge(bridge);
    if (best) { vesselNearBridge[bridge] = { ...best, updatedAt: now }; }
    else { vesselNearBridge[bridge] = null; }
  }
}, 60000);

const UMAMI_URL = 'https://cloud.umami.is/api/send';
const UMAMI_WEBSITE_ID = '1786c8da-b13f-4fec-b8d2-7d2e7102c29b';

async function umamiTrack(eventName, data = {}) {
  try {
    await fetch(UMAMI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PontsBeau/1.0 (Server)' },
      body: JSON.stringify({ type: 'event', payload: { website: UMAMI_WEBSITE_ID, url: '/server', name: eventName, data, hostname: 'pont-st-louis-de-gonzague.onrender.com', language: 'fr-CA', screen: '0x0' } })
    });
  } catch(e) {}
}

webpush.setVapidDetails(process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const res = await fetch(`${REDIS_URL}/${path}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadSubscriptions() {
  try {
    const keys = await redisCommand('keys', 'sub:*');
    if (!keys || keys.length === 0) return [];
    const pipeline = keys.map(k => ['get', k]);
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    const results = await res.json();
    const subs = results.map(r => r.result).filter(Boolean).map(v => JSON.parse(v));
    log(`Loaded ${subs.length} subscriptions from Redis`);
    return subs;
  } catch(e) {
    console.error('Error loading subscriptions:', e.message);
    return [];
  }
}

const _savePending = new Map();
async function saveSubscription(sub) {
  const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
  if (_savePending.has(key)) clearTimeout(_savePending.get(key));
  _savePending.set(key, setTimeout(async () => {
    _savePending.delete(key);
    try { await redisCommand('set', key, JSON.stringify(sub)); }
    catch(e) { console.error('Error saving subscription:', e.message); }
  }, 2000));
}

async function removeSubscription(sub) {
  try {
    const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
    await redisCommand('del', key);
  } catch(e) { console.error('Error removing subscription:', e.message); }
}

let subscriptions = [];
let lastStatus = { gonzague: null, larocque: null };
let monitorTimeout = null;
let widgetUpdateTimeout = null;

async function saveLastStatus() {
  try { await redisCommand('set', 'lastStatus', JSON.stringify(lastStatus)); }
  catch(e) { console.error('saveLastStatus error:', e.message); }
}

async function loadLastStatus() {
  try {
    const val = await redisCommand('get', 'lastStatus');
    if (val) {
      lastStatus = JSON.parse(val);
      console.log(`Restored lastStatus from Redis: Gonzague=${lastStatus.gonzague} Larocque=${lastStatus.larocque}`);
    }
  } catch(e) { console.error('loadLastStatus error:', e.message); }
}

let liftHistory = { gonzague: [], larocque: [] };
let liftActive = { gonzague: null, larocque: null };

async function saveLiftHistory() {
  try { await redisCommand('set', 'liftHistory', JSON.stringify(liftHistory)); }
  catch(e) { console.error('saveLiftHistory error:', e.message); }
}

async function loadLiftHistory() {
  try {
    const val = await redisCommand('get', 'liftHistory');
    if (val) {
      liftHistory = JSON.parse(val);
      log(`Historique charg\u00e9: Gonzague=${liftHistory.gonzague.length} lev\u00e9es, Larocque=${liftHistory.larocque.length} lev\u00e9es`);
    }
  } catch(e) { console.error('loadLiftHistory error:', e.message); }
}

function getAvgLiftDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const recent = h.slice(-20);
  const avg = recent.reduce((a, b) => a + b.duration, 0) / recent.length;
  return Math.max(5, Math.round(avg / 60000)); // minimum 5 min
}

function getAvgLoweringDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const withLowering = h.slice(-20).filter(e => e.loweringDuration);
  if (!withLowering.length) return null;
  const avg = withLowering.reduce((a, b) => a + b.loweringDuration, 0) / withLowering.length;
  return Math.max(2, Math.round(avg / 60000)); // minimum 2 min
}

function isBusyPeriod(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length < 5) return false;
  const now = new Date();
  const currentHour = now.getHours();
  const window = h.filter(e => Math.abs(e.hour - currentHour) <= 1);
  return window.length >= 3 || (window.length / h.length) >= 0.25;
}

function trackStatusTransition(bridge, prev, curr) {
  const now = Date.now();
  if ((curr === 'raising' || curr === 'leve') && !liftActive[bridge]) {
    liftActive[bridge] = { raisedAt: now };
    saveLiftActive();
  }
  if (curr === 'lowering' && liftActive[bridge] && !liftActive[bridge].loweredAt) {
    liftActive[bridge].loweredAt = now;
    liftActive[bridge].duration = now - liftActive[bridge].raisedAt;
    saveLiftActive();
  }
  if (curr === 'disponible' && liftActive[bridge]) {
    const entry = liftActive[bridge];
    const loweringDuration = entry.loweredAt ? (now - entry.loweredAt) : null;
    liftHistory[bridge].push({
      raisedAt: entry.raisedAt,
      duration: entry.loweredAt ? (entry.loweredAt - entry.raisedAt) : (now - entry.raisedAt),
      loweringDuration,
      day: new Date(entry.raisedAt).getDay(),
      hour: new Date(entry.raisedAt).getHours()
    });
    if (liftHistory[bridge].length > 100) liftHistory[bridge].shift();
    liftActive[bridge] = null;
    saveLiftHistory();
    saveLiftActive();
    log(`Lev\u00e9e [${bridge}] enregistr\u00e9e: ~${Math.round((entry.loweredAt||now) - entry.raisedAt) / 60000} min`);
  }
}

async function isLiftNotified(key) {
  try {
    const val = await redisCommand('get', `lift:${key}`);
    return val !== null;
  } catch(e) { return false; }
}

async function markLiftNotified(key) {
  try { await redisCommand('set', `lift:${key}`, '1', 'EX', '10800'); }
  catch(e) { console.error('markLiftNotified error:', e.message); }
}

const lastScheduledNotif = { gonzague: 0, larocque: 0 };
const SCHEDULED_NOTIF_COOLDOWN = 20 * 60 * 1000;

function isInTimeRange(sub) {
  const now = new Date();
  const montreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const currentDay = montreal.getDay();
  const currentMinutes = montreal.getHours() * 60 + montreal.getMinutes();
  const ranges = sub.timeRanges;
  if (!ranges || ranges.length === 0) {
    const allowedDays = sub.notifDays && sub.notifDays.length > 0 ? sub.notifDays : [0,1,2,3,4,5,6];
    return allowedDays.includes(currentDay);
  }
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range.start || !range.end) continue;
    const daysKey = i === 0 ? 'notifDays' : 'notifDays2';
    const allowedDays = sub[daysKey] && sub[daysKey].length > 0 ? sub[daysKey] : [0,1,2,3,4,5,6];
    if (!allowedDays.includes(currentDay)) continue;
    const [startH, startM] = range.start.split(':').map(Number);
    const [endH, endM] = range.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    if (startMinutes <= endMinutes) {
      if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) return true;
    } else {
      if (currentMinutes >= startMinutes || currentMinutes <= endMinutes) return true;
    }
  }
  return false;
}

async function fetchBridgeStatus() {
  const res = await fetch('https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const containers = [...html.matchAll(/<div[^>]*class="[^"]*information-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];
  let gonzagueSection = '';
  let larocqueSection = '';
  if (containers.length >= 2) {
    const gonzagueIdx = html.toLowerCase().indexOf('gonzague');
    const larocqueIdx = html.toLowerCase().indexOf('larocque');
    if (gonzagueIdx < larocqueIdx) {
      gonzagueSection = html.slice(gonzagueIdx, larocqueIdx);
      larocqueSection = html.slice(larocqueIdx, larocqueIdx + 3000);
    } else {
      larocqueSection = html.slice(larocqueIdx, gonzagueIdx);
      gonzagueSection = html.slice(gonzagueIdx, gonzagueIdx + 3000);
    }
  } else {
    gonzagueSection = html.match(/Gonzague[\s\S]{0,3000}?(?=Larocque|<\/body>)/i)?.[0] || '';
    larocqueSection = html.match(/Larocque[\s\S]{0,3000}?(?=Gonzague|<\/body>)/i)?.[0] || '';
  }

  function extractStatus(section) {
    const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
    const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim().toLowerCase());
    const combined = titles.join(' ');
    if (combined.includes('lowering')) return { status: 'lowering', raisedSince: null };
    if (combined.includes('raising soon')) return { status: 'bientot_leve', raisedSince: null };
    if (combined.includes('raising')) return { status: 'raising', raisedSince: null };
    const raisedMatch = combined.match(/raised since\s+(\d{1,2}:\d{2})/i);
    if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };
    if (combined.includes('unavailable')) return { status: 'lowering', raisedSince: null };
    if (combined.includes('available')) return { status: 'disponible', raisedSince: null };
    return { status: null, raisedSince: null, titles };
  }

  function colorToStatus(color) {
    if (!color) return 'disponible';
    const c = color.toUpperCase();
    if (c === '#E48082') return 'leve';
    if (c === '#FEEAA8') return 'bientot_leve';
    return 'disponible';
  }

  function extractColor(html, bridgePattern) {
    const regex = new RegExp(`background-color:\\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*${bridgePattern}`, 'i');
    const match = html.match(regex);
    return match ? match[1].toUpperCase() : '#C1D6A8';
  }

  function isCurrentlyInOutage(closures) {
    if (!closures || closures.length === 0) return null;
    const nowUTC = new Date();
    for (const c of closures) {
      const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
      if (!m) continue;
      const etOffset = '-04:00';
      const start = new Date(m[1].replace(' ', 'T') + ':00' + etOffset);
      const end   = new Date(m[2].replace(' ', 'T') + ':00' + etOffset);
      if (isNaN(start) || isNaN(end)) continue;
      if (nowUTC >= start && nowUTC <= end) {
        log(`Outage actif [closure]: ${c}`);
        return { closure: c, end };
      }
    }
    return null;
  }

  function getBridgeStatus(section, color, closures) {
    const outage = isCurrentlyInOutage(closures);
    if (outage) return { status: 'outage', raisedSince: null, outageEnd: outage.end, closure: outage.closure };
    const result = extractStatus(section);
    if (result.status) return { status: result.status, raisedSince: result.raisedSince };
    return { status: colorToStatus(color), raisedSince: null };
  }

  function extractLifts(section) {
    const matches = [...section.matchAll(/class="item-data[^"]*"[^>]*>([^<]+)/g)];
    const lifts = matches.map(m => m[1].trim()).filter(v => v && v !== 'No anticipated bridge lifts' && v !== 'Aucune lev\u00e9e de pont pr\u00e9vue');
    if (lifts.length === 0) return 'No anticipated bridge lifts';
    return lifts.join('\n');
  }

  function extractClosures(section) {
    const results = [];
    const matches1 = [...section.matchAll(/class="item-data[^"]*"[^>]*style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*>([^<]+)/gi)];
    const matches2 = [...section.matchAll(/style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*class="item-data[^"]*"[^>]*>([^<]+)/gi)];
    const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    for (const m of [...matches1, ...matches2]) {
      const val = m[1].trim();
      if (!val || results.includes(val)) continue;
      // Filter out past closures: parse end date from "YYYY-MM-DD HH:MM until YYYY-MM-DD HH:MM"
      const endMatch = val.match(/until\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/i);
      if (endMatch) {
        const endEST = new Date(new Date(`${endMatch[1]}T${endMatch[2]}:00`).toLocaleString('en-US', { timeZone: 'America/Toronto' }));
        if (endEST < nowEST) continue; // skip past closures
      }
      results.push(val);
    }
    return results.length > 0 ? results : null;
  }

  const colorGonzague = extractColor(html, 'St[\\-\\s]Louis[\\-\\s]de[\\-\\s]Gonzague');
  const colorLarocque = extractColor(html, 'Larocque');
  const closuresGonzague = extractClosures(gonzagueSection);
  const closuresLarocque = extractClosures(larocqueSection);
  const gonzague = getBridgeStatus(gonzagueSection, colorGonzague, closuresGonzague);
  const larocque = getBridgeStatus(larocqueSection, colorLarocque, closuresLarocque);

  if (gonzagueSection.length < 100) log(`gonzagueSection trop court (${gonzagueSection.length} chars)`);
  if (larocqueSection.length < 100) log(`larocqueSection trop court (${larocqueSection.length} chars)`);

  const refreshMatch = html.match(/Last Refreshed at[:\s]*(\d[\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return {
    gonzague: { status: gonzague.status, raisedSince: gonzague.raisedSince, outageEnd: gonzague.outageEnd || null, next_lifts: extractLifts(gonzagueSection), closures: closuresGonzague },
    larocque: { status: larocque.status, raisedSince: larocque.raisedSince, outageEnd: larocque.outageEnd || null, next_lifts: extractLifts(larocqueSection), closures: closuresLarocque },
    last_refreshed,
    _sections: { gonzague: gonzagueSection, larocque: larocqueSection }
  };
}

function getMessages(bridge, status, lang, data) {
  const shortNames = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' }
  };
  const n = (shortNames[lang] || shortNames.fr)[bridge];
  let outageStr = '';
  if (status === 'outage' && data && data.outageEnd) {
    const end = new Date(data.outageEnd);
    const hm = end.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
    outageStr = lang === 'fr' ? ` \u00b7 Ferm\u00e9 jusqu'\u00e0 ${hm}` : ` \u00b7 Closed until ${hm}`;
  }
  const avgLift = data?.avgLiftDuration || 12;
  const reopenTime = new Date(Date.now() + avgLift * 60000);
  const hm = reopenTime.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
  const fr = {
    bientot_leve: { title: `\u26a0\ufe0f ${n}`, body: `Bient\u00f4t lev\u00e9 \u00b7 Pr\u00e9voir un d\u00e9lai` },
    raising:      { title: `\ud83d\udd3c ${n}`, body: `En cours de levage \u00b7 R\u00e9ouverture ~${hm}` },
    leve:         { title: `\ud83d\udea2 ${n}`, body: `Pont lev\u00e9 \u00b7 R\u00e9ouverture pr\u00e9vue ~${hm}` },
    lowering:     { title: `\ud83d\udd3d ${n}`, body: `Pont redescend \u00b7 Bient\u00f4t disponible` },
    disponible:   { title: `\u2705 ${n}`, body: `Circulation normale` },
    outage:       { title: `\ud83d\udea7 ${n}`, body: `Fermeture planifi\u00e9e${outageStr}` }
  };
  const en = {
    bientot_leve: { title: `\u26a0\ufe0f ${n}`, body: `Lift soon \u00b7 Expect delays` },
    raising:      { title: `\ud83d\udd3c ${n}`, body: `Bridge raising \u00b7 Reopen ~${hm}` },
    leve:         { title: `\ud83d\udea2 ${n}`, body: `Bridge lifted \u00b7 Expected reopen ~${hm}` },
    lowering:     { title: `\ud83d\udd3d ${n}`, body: `Bridge lowering \u00b7 Opening soon` },
    disponible:   { title: `\u2705 ${n}`, body: `Traffic normal` },
    outage:       { title: `\ud83d\udea7 ${n}`, body: `Planned closure${outageStr}` }
  };
  return (lang === 'en' ? en : fr)[status] || null;
}

function parseScheduledLifts(text) {
  if (!text || text === 'No anticipated bridge lifts') return [];
  const times = [];
  const matches = text.matchAll(/(\d{1,2}:\d{2})/g);
  for (const m of matches) times.push(m[1]);
  return times;
}

const BASE_URL = 'https://ponts-canal-de-beauharnois.vercel.app';
const VALID_THEMES = ['gonzaguois', 'campivallensien', 'stanicois'];

function notifIcon(sub) {
  const theme = VALID_THEMES.includes(sub.theme) ? sub.theme : 'gonzaguois';
  return `${BASE_URL}/notification-icon-${theme}.png`;
}

function statusBadge(status) {
  const map = {
    bientot_leve: '/badge-warning.png',
    raising:      '/badge-raising.png',
    leve:         '/badge-leve.png',
    lowering:     '/badge-lowering.png',
    disponible:   '/badge-disponible.png',
    outage:       '/badge-outage.png',
    scheduled:    '/badge-scheduled.png',
    achalandage:  '/badge-warning.png',
  };
  return `${BASE_URL}${map[status] || '/badge-default.png'}`;
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function sendScheduledLiftNotification(bridge, times) {
  // times can be a single time string or array of times
  const timesArr = Array.isArray(times) ? times : [times];
  // Build widget statuses with scheduled info appended
  const statuses = {
    gonzague: { status: lastStatus.gonzague || 'disponible', avgLiftDuration: getAvgLiftDuration('gonzague'), avgLoweringDuration: getAvgLoweringDuration('gonzague'), outageEnd: null, liftingSince: liftActive.gonzague?.raisedAt || null, scheduledTimes: bridge === 'gonzague' ? timesArr : null },
    larocque: { status: lastStatus.larocque || 'disponible', avgLiftDuration: getAvgLiftDuration('larocque'), avgLoweringDuration: getAvgLoweringDuration('larocque'), outageEnd: null, liftingSince: liftActive.larocque?.raisedAt || null, scheduledTimes: bridge === 'larocque' ? timesArr : null },
  };
  let sent = 0, skipped = 0, failed = 0;
  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skipped++; continue; }
    if (!isInTimeRange(sub)) { skipped++; continue; }
    const bridgeKey = bridge === 'gonzague' ? 'notifTypesGonzague' : 'notifTypesLarocque';
    const allowedTypes = sub[bridgeKey] || sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled'];
    if (!allowedTypes.includes('scheduled')) { skipped++; continue; }
    const lang = sub.lang || 'fr';
    const isFr = lang === 'fr';
    const body = buildWidgetBody(sub, statuses);
    const title = isFr ? 'Ponts Beauharnois' : 'Beauharnois Bridges';
    const STATUS_PRIORITY = ['outage', 'leve', 'raising', 'lowering', 'bientot_leve', 'disponible'];
    const activeStatuses = bridges.map(b => statuses[b]?.status).filter(Boolean);
    const criticalStatus = STATUS_PRIORITY.find(s => activeStatuses.includes(s)) || 'scheduled';
    const payload = JSON.stringify({ title, body, tag: 'pont-widget', icon: notifIcon(sub), badge: statusBadge(criticalStatus) });
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 300 });
      sent++;
    } catch(e) {
      failed++;
      log(`Push failed [${bridge}] scheduled ${time} - HTTP ${e.statusCode}: ${e.message}`);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
      umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
    }
  }
  log(`Lev\u00e9e planifi\u00e9e [${bridge}] ${time} - ${sent} envoy\u00e9es | ${skipped} ignor\u00e9es | ${failed} \u00e9chou\u00e9es`);
}


// ── Widget notification (single persistent) ────────────────────────
const STATUS_EMOJI = {
  disponible:   '\u2705',
  bientot_leve: '\u26a0\ufe0f',
  raising:      '🔼',
  leve:         '⛔',
  lowering:     '🔽',
  outage:       '🚧',
};

const STATUS_LABEL_FR = {
  disponible:   'Disponible',
  bientot_leve: 'Bient\u00f4t lev\u00e9',
  raising:      'En levage',
  leve:         'Lev\u00e9',
  lowering:     'Descente',
  outage:       'Ferm\u00e9',
};

const STATUS_LABEL_EN = {
  disponible:   'Available',
  bientot_leve: 'Lifting soon',
  raising:      'Raising',
  leve:         'Lifted',
  lowering:     'Lowering',
  outage:       'Closed',
};

function buildWidgetBody(sub, bridgeStatuses) {
  const lang = sub.lang || 'fr';
  const bridges = sub.bridges || ['gonzague', 'larocque'];
  const isFr = lang === 'fr';
  const labels = isFr ? STATUS_LABEL_FR : STATUS_LABEL_EN;
  const bridgeNames = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' },
  };
  const lines = [];
  for (const bridge of ['gonzague', 'larocque']) {
    if (!bridges.includes(bridge)) continue;
    const d = bridgeStatuses[bridge];
    if (!d) continue;
    const emoji = STATUS_EMOJI[d.status] || '\u2705';
    const label = labels[d.status] || d.status;
    let line = `${emoji} ${bridgeNames[lang][bridge]}: ${label}`;
    // Add reopen time if lifted or lowering
    if ((d.status === 'leve' || d.status === 'lowering' || d.status === 'raising') && d.avgLiftDuration) {
      let reopenTime;
      const avgTotal = (d.avgLiftDuration || 12) + (d.avgLoweringDuration || 3);
      if (d.status === 'lowering') {
        reopenTime = new Date(Date.now() + (d.avgLoweringDuration || 3) * 60000);
      } else if (d.liftingSince) {
        // Bug fix 1: liftingSince est un timestamp UTC ms — calcul direct sans conversion fuseau
        const elapsedMin = Math.max(0, (Date.now() - d.liftingSince) / 60000);
        const remaining = Math.max(1, avgTotal - elapsedMin);
        reopenTime = new Date(Date.now() + remaining * 60000);
      } else {
        reopenTime = new Date(Date.now() + avgTotal * 60000);
      }
      // If another vessel is scheduled soon after reopen, delay reopen estimate
      if (d.scheduledTimes && d.scheduledTimes.length > 0) {
        const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
        for (const t of d.scheduledTimes) {
          const match = t.replace('*','').trim().match(/(\d{1,2}):(\d{2})/);
          if (!match) continue;
          const scheduled = new Date(nowEST);
          scheduled.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);
          if (scheduled < nowEST) scheduled.setDate(scheduled.getDate() + 1);
          // Bug fix 2: pousser la réouverture si un navire arrive AVANT ou dans les 20 min APRÈS l'estimation actuelle
          const gap = (scheduled - reopenTime) / 60000;
          if (gap <= 20) {
            const nextReopen = new Date(scheduled.getTime() + avgTotal * 60000);
            if (nextReopen > reopenTime) reopenTime = nextReopen;
          }
        }
      }
      const avgTotal2 = (d.avgLiftDuration || 12) + (d.avgLoweringDuration || 3);
      const elapsed2 = d.liftingSince ? (Date.now() - d.liftingSince) / 60000 : 0;
      if (elapsed2 > avgTotal2 + 2) {
        line += isFr ? ' \u00b7 \u26a0\ufe0f Retard possible' : ' \u00b7 \u26a0\ufe0f Possible delay';
      } else {
        const hm = reopenTime.toLocaleTimeString(isFr ? 'fr-CA' : 'en-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
        line += isFr ? ` \u00b7 R\u00e9ouverture ~${hm}` : ` \u00b7 Reopen ~${hm}`;
      }
    }
    if (d.status === 'outage' && d.outageEnd) {
      const end = new Date(d.outageEnd);
      const hm = end.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
      line += isFr ? ` \u00b7 jusqu'\u00e0 ${hm}` : ` \u00b7 until ${hm}`;
    }
    // Add scheduled time if available
    if (d.scheduledTimes && d.scheduledTimes.length > 0 && d.status === 'disponible') {
      const times = d.scheduledTimes.join(', ');
      const plural = d.scheduledTimes.length > 1;
      line += isFr
        ? ` \u00b7 ${plural ? 'Lev\u00e9es pr\u00e9vues' : 'Lev\u00e9e pr\u00e9vue'} ${times}`
        : ` \u00b7 ${plural ? 'Lifts' : 'Lift'} at ${times}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function sendWidgetUpdate(bridgeStatuses) {
  let sent = 0, failed = 0;
  // Priority order for badge: outage > leve > raising > lowering > bientot_leve > disponible
  const STATUS_PRIORITY = ['outage', 'leve', 'raising', 'lowering', 'bientot_leve', 'disponible'];
  for (const sub of [...subscriptions]) {
    const lang = sub.lang || 'fr';
    const isFr = lang === 'fr';
    const body = buildWidgetBody(sub, bridgeStatuses);
    if (!body) continue;
    const title = isFr ? 'Ponts Beauharnois' : 'Beauharnois Bridges';
    // Pick most critical status for badge
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    const activeStatuses = bridges.map(b => bridgeStatuses[b]?.status).filter(Boolean);
    const criticalStatus = STATUS_PRIORITY.find(s => activeStatuses.includes(s)) || 'disponible';
    const payload = JSON.stringify({
      title, body,
      tag: 'pont-widget',
      icon: notifIcon(sub),
      badge: statusBadge(criticalStatus),
    });
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'low', TTL: 900 });
      sent++;
    } catch(e) {
      failed++;
      if (e.statusCode === 410) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        await removeSubscription(sub);
        umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
      }
    }
  }
  if (sent > 0 || failed > 0) log(`Widget update - ${sent} envoy\u00e9es | ${failed} \u00e9chou\u00e9es`);
}

// sendNotifications now delegates to widget update
async function sendNotifications(bridge, status, bridgeData = {}) {
  // Build current statuses from lastStatus + this update
  const statuses = {
    gonzague: { status: lastStatus.gonzague || 'disponible', avgLiftDuration: getAvgLiftDuration('gonzague'), avgLoweringDuration: getAvgLoweringDuration('gonzague'), outageEnd: null, liftingSince: liftActive.gonzague?.raisedAt || null, scheduledTimes: parseScheduledLifts(bridgeData.next_lifts_gonzague || '') },
    larocque: { status: lastStatus.larocque || 'disponible', avgLiftDuration: getAvgLiftDuration('larocque'), avgLoweringDuration: getAvgLoweringDuration('larocque'), outageEnd: null, liftingSince: liftActive.larocque?.raisedAt || null, scheduledTimes: parseScheduledLifts(bridgeData.next_lifts_larocque || '') },
  };
  statuses[bridge] = {
    status,
    avgLiftDuration: bridgeData.avgLiftDuration || getAvgLiftDuration(bridge),
    avgLoweringDuration: bridgeData.avgLoweringDuration || getAvgLoweringDuration(bridge),
    outageEnd: bridgeData.outageEnd || null,
    liftingSince: liftActive[bridge]?.raisedAt || null,
    scheduledTimes: parseScheduledLifts(bridgeData.next_lifts || ''),
  };
  await sendWidgetUpdate(statuses);
  log(`Notification widget [${bridge}] ${status}`);
}

async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    log(`Gonzague: ${data.gonzague.status} | Larocque: ${data.larocque.status} | Abonn\u00e9s: ${subscriptions.length}`);
    const notifications = [];
    for (const bridge of ['gonzague', 'larocque']) {
      const prev = lastStatus[bridge];
      const curr = data[bridge].status;
      if (prev === null) {
        log(`Boot [${bridge}] - statut initial: ${curr}`);
      } else if (prev !== curr) {
        log(`Changement [${bridge}]: ${prev} -> ${curr}`);
        trackStatusTransition(bridge, prev, curr);
        notifications.push(sendNotifications(bridge, curr, {
          ...data[bridge],
          next_lifts_gonzague: data.gonzague.next_lifts,
          next_lifts_larocque: data.larocque.next_lifts,
        }));
      }
    }
    for (const bridge of ['gonzague', 'larocque']) {
      if (data[bridge].status === 'outage') continue;
      const lifts = parseScheduledLifts(data[bridge].next_lifts);
      const newTimes = [];
      for (const time of lifts) {
        const key = `${bridge}:${time}`;
        const alreadyNotified = await isLiftNotified(key);
        const cooldownOk = (Date.now() - lastScheduledNotif[bridge]) > SCHEDULED_NOTIF_COOLDOWN;
        if (!alreadyNotified && cooldownOk) {
          log(`Nouvelle levée planifiée [${bridge}] à ${time}`);
          await markLiftNotified(key);
          newTimes.push(time);
        }
      }
      if (newTimes.length > 0) {
        lastScheduledNotif[bridge] = Date.now();
        notifications.push(sendScheduledLiftNotification(bridge, newTimes));
      }
    }
    if (notifications.length === 0) log(`Aucun changement d\u00e9tect\u00e9`);
    await Promise.all(notifications);
    lastStatus.gonzague = data.gonzague.status;
    lastStatus.larocque = data.larocque.status;
    await saveLastStatus();
    const anyActive = ['gonzague','larocque'].some(b => ['bientot_leve','raising','leve','lowering'].includes(data[b].status));
    clearTimeout(monitorTimeout);
    monitorTimeout = setTimeout(monitor, anyActive ? 5000 : 10000);
    // Send widget update every 30 seconds when a bridge is active (for live reopen time)
    if (anyActive) {
      clearTimeout(widgetUpdateTimeout);
      widgetUpdateTimeout = setTimeout(async () => {
        await sendWidgetUpdate({
          gonzague: { status: lastStatus.gonzague || 'disponible', avgLiftDuration: getAvgLiftDuration('gonzague'), avgLoweringDuration: getAvgLoweringDuration('gonzague'), outageEnd: null, liftingSince: liftActive.gonzague?.raisedAt || null, scheduledTimes: parseScheduledLifts(data.gonzague.next_lifts) },
          larocque: { status: lastStatus.larocque || 'disponible', avgLiftDuration: getAvgLiftDuration('larocque'), avgLoweringDuration: getAvgLoweringDuration('larocque'), outageEnd: null, liftingSince: liftActive.larocque?.raisedAt || null, scheduledTimes: parseScheduledLifts(data.larocque.next_lifts) },
        });
      }, 30 * 1000);
    }
  } catch(e) {
    log(`Monitor error: ${e.message}`);
    console.error(e);
    clearTimeout(monitorTimeout);
    monitorTimeout = setTimeout(monitor, 15000);
  }
}

setInterval(async () => {
  try {
    await fetch('https://pont-st-louis-de-gonzague.onrender.com/ping');
    console.log('Auto-ping OK');
  } catch(e) { console.log('Auto-ping failed:', e.message); }
}, 600000);

app.get('/', (req, res) => res.send('Ponts Beauharnois API'));
app.get('/ping', (req, res) => res.json({ ok: true, subs: subscriptions.length }));

app.post('/vessel-update', (req, res) => {
  const { bridge, name, mmsi, confidence, cog } = req.body;
  if (!bridge || !['gonzague','larocque'].includes(bridge)) return res.status(400).json({ error: 'Invalid bridge' });
  if (name && mmsi) {
    vesselNearBridge[bridge] = { name, mmsi, confidence: confidence || 50, cog, updatedAt: Date.now() };
    log(`Navire [${bridge}] via client: ${name}`);
  } else {
    vesselNearBridge[bridge] = null;
  }
  res.json({ ok: true });
});

app.get('/status', async (req, res) => {
  try {
    const data = await fetchBridgeStatus();
    for (const bridge of ['gonzague', 'larocque']) {
      data[bridge].avgLiftDuration = getAvgLiftDuration(bridge);
      data[bridge].avgLoweringDuration = getAvgLoweringDuration(bridge);
      data[bridge].liftCount = liftHistory[bridge].length;
      if (liftActive[bridge]) data[bridge].liftingSince = liftActive[bridge].raisedAt;
      if (vesselNearBridge[bridge]) data[bridge].vessel = vesselNearBridge[bridge];
    }
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  const existing = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (existing) {
    existing.bridges = sub.bridges || ['gonzague', 'larocque'];
    existing.timeRanges = sub.timeRanges || [];
    existing.lang = sub.lang || 'fr';
    existing.theme = sub.theme || 'gonzaguois';
    existing.notifTypes = sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled','outage','achalandage'];
    if (sub.notifTypesGonzague) existing.notifTypesGonzague = sub.notifTypesGonzague;
    if (sub.notifTypesLarocque) existing.notifTypesLarocque = sub.notifTypesLarocque;
    existing.notifDays = sub.notifDays !== undefined ? sub.notifDays : [0,1,2,3,4,5,6];
    existing.notifDays2 = sub.notifDays2 !== undefined ? sub.notifDays2 : [0,1,2,3,4,5,6];
    await saveSubscription(existing);
    console.log(`Updated subscriber. Lang: ${existing.lang}, Bridges: ${existing.bridges}`);
  } else {
    subscriptions.push(sub);
    await saveSubscription(sub);
    console.log(`New subscriber! Lang: ${sub.lang}, Bridges: ${sub.bridges}. Total: ${subscriptions.length}`);
    umamiTrack('subscription_new', { total: subscriptions.length, lang: sub.lang || 'fr' });
  }
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  const key = `sub:${Buffer.from(endpoint).toString('base64').slice(0, 50)}`;
  await redisCommand('del', key);
  console.log(`Unsubscribed. Total: ${subscriptions.length}`);
  umamiTrack('subscription_lost', { reason: 'user', total: subscriptions.length });
  res.json({ ok: true });
});

app.get('/assistant', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const lang = req.query.lang || 'fr';
  const parts = [];
  for (const bridge of ['gonzague', 'larocque']) {
    const name = bridge === 'gonzague'
      ? (lang === 'fr' ? 'Pont St-Louis' : 'St-Louis Bridge')
      : (lang === 'fr' ? 'Pont Larocque' : 'Larocque Bridge');
    const s = lastStatus[bridge];
    let desc;
    if (lang === 'fr') {
      if (s === 'disponible') desc = 'est disponible';
      else if (s === 'bientot_leve') desc = 'sera bient\u00f4t lev\u00e9';
      else if (s === 'raising') desc = 'est en cours de levage';
      else if (s === 'leve') desc = 'est lev\u00e9';
      else if (s === 'lowering') desc = 'redescend';
      else desc = 'statut inconnu';
    } else {
      if (s === 'disponible') desc = 'is available';
      else if (s === 'bientot_leve') desc = 'will be lifted soon';
      else if (s === 'raising') desc = 'is raising';
      else if (s === 'leve') desc = 'is lifted';
      else if (s === 'lowering') desc = 'is lowering';
      else desc = 'status unknown';
    }
    parts.push(`${name} ${desc}`);
  }
  const text = parts.join(lang === 'fr' ? '. ' : '. ');
  res.json({ text, gonzague: lastStatus.gonzague, larocque: lastStatus.larocque });
});

app.get('/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  function getLastLift(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return null;
    const last = h[h.length - 1];
    return last.raisedAt ? new Date(last.raisedAt).toISOString() : null;
  }
  function getOldestLift(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return null;
    const oldest = h[0];
    return oldest.raisedAt ? new Date(oldest.raisedAt).toISOString() : null;
  }
  function getHeatmap(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const map = {};
    for (const e of h) {
      if (e.raisedAt && e.raisedAt < cutoff) continue;
      if (e.day === undefined || e.hour === undefined) continue;
      const key = `${e.day}-${e.hour}`;
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }
  res.json({
    gonzague: { entries: liftHistory.gonzague.length, avgDuration: getAvgLiftDuration('gonzague'), avgLowering: getAvgLoweringDuration('gonzague'), lastLift: getLastLift('gonzague'), oldestLift: getOldestLift('gonzague'), heatmap: getHeatmap('gonzague') },
    larocque: { entries: liftHistory.larocque.length, avgDuration: getAvgLiftDuration('larocque'), avgLowering: getAvgLoweringDuration('larocque'), lastLift: getLastLift('larocque'), oldestLift: getOldestLift('larocque'), heatmap: getHeatmap('larocque') }
  });
});

app.post('/milestone-notif', async (req, res) => {
  const { endpoint, milestone, lang } = req.body;
  if (!endpoint || !milestone) return res.status(400).json({ error: 'missing params' });
  const sub = subscriptions.find(s => s.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'subscriber not found' });
  const isFr = (lang || sub.lang || 'fr') === 'fr';
  const messages = {
    7:  { fr: { title: 'Une semaine ensemble\u00a0!', body: 'Ca fait 7 jours que l\'app veille sur vos travers\u00e9es.' }, en: { title: 'One week together!', body: 'The app has been watching over your crossings for 7 days.' } },
    30: { fr: { title: 'Un mois d\u00e9j\u00e0\u00a0!', body: 'Merci de nous faire confiance depuis un mois.' }, en: { title: 'One month already!', body: 'Thanks for trusting us for a month.' } },
    90: { fr: { title: '3 mois de travers\u00e9es\u00a0!', body: 'Vous faites partie de nos utilisateurs les plus fid\u00e8les.' }, en: { title: '3 months of crossings!', body: 'You\'re one of our most loyal users.' } }
  };
  const msg = (messages[milestone] || {})[isFr ? 'fr' : 'en'];
  if (!msg) return res.status(400).json({ error: 'invalid milestone' });
  try {
    await webpush.sendNotification(sub, JSON.stringify({ ...msg, tag: `milestone-${milestone}`, persistent: false, icon: notifIcon(sub) }), { urgency: 'high', TTL: 300 });
    umamiTrack('milestone_push_sent', { milestone });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

app.post('/send-test', async (req, res) => {
  const bridge = req.body.bridge || 'gonzague';
  const status = req.body.status || 'leve';
  try {
    await sendNotifications(bridge, status, { avgLiftDuration: 12, avgLoweringDuration: 5 });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const busyAlertSentToday = { gonzague: null, larocque: null };

function getBusyHoursForBridge(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length < 5) return [];
  const counts = {};
  for (const entry of h) { counts[entry.hour] = (counts[entry.hour] || 0) + 1; }
  const threshold = Math.max(3, h.length * 0.15);
  return Object.entries(counts).filter(([, count]) => count >= threshold).map(([hour]) => parseInt(hour));
}

async function checkBusyPeriodAlerts() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  for (const bridge of ['gonzague', 'larocque']) {
    if (busyAlertSentToday[bridge] === todayStr) continue;
    const busyHours = getBusyHoursForBridge(bridge);
    if (!busyHours.length) continue;
    const inRange = busyHours.some(h => {
      const minsUntil = (h * 60) - (currentHour * 60 + currentMin);
      return minsUntil >= 25 && minsUntil <= 35;
    });
    if (!inRange) continue;
    busyAlertSentToday[bridge] = todayStr;
    log(`Alerte achalandage [${bridge}] - envoi notifications`);
    umamiTrack('busy_alert_sent', { bridge });
    const bridgeName = { fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' }, en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' } };
    let sent = 0, skipped = 0;
    for (const sub of subscriptions) {
      try {
        const allowedTypes = sub.notifTypes || ['bientot_leve', 'leve', 'outage'];
        if (!allowedTypes.includes('achalandage')) { skipped++; continue; }
        if (sub.bridges && !sub.bridges.includes(bridge)) { skipped++; continue; }
        const lang = sub.lang || 'fr';
        const name = bridgeName[lang]?.[bridge] || bridgeName.fr[bridge];
        const icon = sub.theme === 'gonzaguois' ? '/notification-icon-gonzaguois.png'
          : sub.theme === 'campivallensien' ? '/notification-icon-campivallensien.png'
          : sub.theme === 'stanicois' ? '/notification-icon-stanicois.png'
          : '/notification-icon.png';
        const payload = lang === 'fr'
          ? { title: `\u26a0\ufe0f ${name}`, body: `P\u00e9riode achaland\u00e9e dans ~30 min`, icon, badge: statusBadge('achalandage'), tag: `pont-busy-${bridge}`, renotify: true }
          : { title: `\u26a0\ufe0f ${name}`, body: `Busy period in ~30 min`, icon, badge: statusBadge('achalandage'), tag: `pont-busy-${bridge}`, renotify: true };
        await webpush.sendNotification(sub, JSON.stringify(payload), { urgency: 'high', TTL: 300 });
        sent++;
      } catch (e) {
        if (e.statusCode === 410) subscriptions = subscriptions.filter(s => s !== sub);
      }
    }
    log(`Alerte achalandage [${bridge}] - ${sent} envoy\u00e9es | ${skipped} ignor\u00e9es`);
  }
}

setInterval(checkBusyPeriodAlerts, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

async function saveLiftActive() {
  try { await redisCommand('set', 'liftActive', JSON.stringify(liftActive)); }
  catch(e) { console.error('saveLiftActive error:', e.message); }
}

async function loadLiftActive() {
  try {
    const val = await redisCommand('get', 'liftActive');
    if (val) {
      liftActive = JSON.parse(val);
      const now = Date.now();
      for (const bridge of ['gonzague', 'larocque']) {
        if (liftActive[bridge]) {
          const age = now - liftActive[bridge].raisedAt;
          if (age > 2 * 60 * 60 * 1000) {
            log('Boot: liftActive [' + bridge + '] trop ancien (' + Math.round(age/60000) + ' min), annul\u00e9');
            liftActive[bridge] = null;
          } else {
            log('Boot: liftActive [' + bridge + '] restaur\u00e9 depuis Redis (' + Math.round(age/60000) + ' min)');
          }
        }
      }
    }
  } catch(e) { console.error('loadLiftActive error:', e.message); }
}

async function start() {
  subscriptions = await loadSubscriptions();
  await loadLastStatus();
  await loadLiftHistory();
  await loadLiftActive();
  log(`Ready with ${subscriptions.length} subscriptions`);
  umamiTrack('subscription_count', { count: subscriptions.length });
  // Send widget update on boot if status was already active (e.g. after reboot)
  if (lastStatus.gonzague || lastStatus.larocque) {
    log(`Boot: envoi widget avec statut restaure (Gonzague=${lastStatus.gonzague}, Larocque=${lastStatus.larocque})`);
    await sendWidgetUpdate({
      gonzague: { status: lastStatus.gonzague || 'disponible', avgLiftDuration: getAvgLiftDuration('gonzague'), outageEnd: null },
      larocque: { status: lastStatus.larocque || 'disponible', avgLiftDuration: getAvgLiftDuration('larocque'), outageEnd: null },
    });
  }
  await monitor();
}

start();
