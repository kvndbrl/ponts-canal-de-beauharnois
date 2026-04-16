const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// ── AIS vessel tracking ───────────────────────────────────────────────
const AIS_API_KEY = process.env.AIS_API_KEY || '863161f597fc75bcafa5a947c4b00c97210e84bb';

// Bounding box around canal de Beauharnois
// [minLat, minLon], [maxLat, maxLon]
const AIS_BBOX = [[45.18, -74.02], [45.22, -73.95]];

// Last known vessel in zone per bridge
let vesselNearBridge = { gonzague: null, larocque: null };

// Exact bridge coordinates
const BRIDGES = {
  gonzague: { lat: 45.2053, lon: -73.9855 },
  larocque: { lat: 45.1942, lon: -74.0020 }
};

// Canal de Beauharnois runs roughly E-W
// Valid headings for eastbound (lake → river): 60-120°
// Valid headings for westbound (river → lake): 240-300°
const VALID_HEADINGS = [[60, 120], [240, 300]];

// Track vessel history per MMSI: last N positions + metadata
const vesselHistory = new Map(); // mmsi → [{lat, lon, heading, ts}]
const MAX_HISTORY = 20;

function isValidHeading(cog) {
  if (cog === undefined || cog === null || cog === 511) return true; // unknown → don't filter
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

    // Only consider positions from last 5 minutes
    const recent = history.filter(p => now - p.ts < 300000);
    if (!recent.length) continue;

    const latest = recent[recent.length - 1];
    const distKm = haversineKm(latest.lat, latest.lon, bp.lat, bp.lon);

    // Must be within 2km of the bridge
    if (distKm > 2.0) continue;

    // Check if vessel is moving toward or through the bridge
    // (has more than 1 position point showing movement)
    const isMoving = recent.length > 1;
    const headingOk = isValidHeading(latest.cog);

    let confidence = 0;
    confidence += Math.max(0, 100 - distKm * 50); // closer = higher confidence
    if (headingOk) confidence += 20;
    if (isMoving) confidence += 10;
    // Bonus if vessel has been tracked crossing through bridge zone
    const crossed = recent.some(p => haversineKm(p.lat, p.lon, bp.lat, bp.lon) < 0.3);
    if (crossed) confidence += 30;

    candidates.push({ mmsi, name: latest.name, distKm, confidence, cog: latest.cog });
  }

  if (!candidates.length) return null;

  // Sort by confidence desc
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];

  // Only return if confidence is reasonable
  if (best.confidence < 40) return null;

  return {
    name: best.name,
    mmsi: best.mmsi,
    distKm: Math.round(best.distKm * 10) / 10,
    confidence: Math.round(best.confidence),
    cog: best.cog
  };
}

function startAISTracking() {
  let ws;

  function connect() {
    ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    ws.on('open', () => {
      log('🚢 AIS WebSocket connecté');
      ws.send(JSON.stringify({
        APIKey: AIS_API_KEY,
        BoundingBoxes: [AIS_BBOX],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData']
      }));
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

        // Get COG from PositionReport if available
        const cog = msg.Message?.PositionReport?.Cog ?? null;

        // Update vessel history
        if (!vesselHistory.has(mmsi)) vesselHistory.set(mmsi, []);
        const hist = vesselHistory.get(mmsi);
        hist.push({ lat, lon, cog, name, ts: Date.now() });
        if (hist.length > MAX_HISTORY) hist.shift();

        // Update best vessel per bridge
        for (const bridge of ['gonzague', 'larocque']) {
          const best = getBestVesselForBridge(bridge);
          if (best) {
            vesselNearBridge[bridge] = { ...best, updatedAt: Date.now() };
            if (!vesselNearBridge[bridge]._logged) {
              log(`🚢 Navire détecté [${bridge}]: ${best.name} à ${best.distKm}km (confiance: ${best.confidence})`);
              vesselNearBridge[bridge]._logged = true;
            }
          }
        }
      } catch(e) {}
    });

    ws.on('close', () => {
      log('🚢 AIS WebSocket déconnecté — reconnexion dans 30s');
      setTimeout(connect, 30000);
    });

    ws.on('error', (e) => {
      log(`🚢 AIS erreur: ${e.message}`);
    });
  }

  connect();
}

// Cleanup stale vessel data every minute
setInterval(() => {
  const now = Date.now();
  // Remove old history entries
  for (const [mmsi, hist] of vesselHistory.entries()) {
    const recent = hist.filter(p => now - p.ts < 600000);
    if (!recent.length) vesselHistory.delete(mmsi);
    else vesselHistory.set(mmsi, recent);
  }
  // Re-evaluate best vessel per bridge
  for (const bridge of ['gonzague', 'larocque']) {
    const best = getBestVesselForBridge(bridge);
    if (best) {
      vesselNearBridge[bridge] = { ...best, updatedAt: now };
    } else {
      vesselNearBridge[bridge] = null;
    }
  }
}, 60000);

// ── Umami server-side tracking ────────────────────────────────────────
const UMAMI_URL = 'https://cloud.umami.is/api/send';
const UMAMI_WEBSITE_ID = '1786c8da-b13f-4fec-b8d2-7d2e7102c29b';

async function umamiTrack(eventName, data = {}) {
  try {
    await fetch(UMAMI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PontsBeau/1.0 (Server)'
      },
      body: JSON.stringify({
        type: 'event',
        payload: {
          website: UMAMI_WEBSITE_ID,
          url: '/server',
          name: eventName,
          data,
          hostname: 'pont-st-louis-de-gonzague.onrender.com',
          language: 'fr-CA',
          screen: '0x0'
        }
      })
    });
  } catch(e) {
    // Never let tracking break the app
  }
}

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  // Build URL: first arg is command, rest are path segments
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const res = await fetch(`${REDIS_URL}/${path}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadSubscriptions() {
  try {
    const keys = await redisCommand('keys', 'sub:*');
    if (!keys || keys.length === 0) return [];

    // Use Upstash pipeline to batch all GETs in one HTTP request
    const pipeline = keys.map(k => ['get', k]);
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    const results = await res.json();
    const subs = results
      .map(r => r.result)
      .filter(Boolean)
      .map(v => JSON.parse(v));
    log(`Loaded ${subs.length} subscriptions from Redis (1 pipeline request)`);
    return subs;
  } catch(e) {
    console.error('Error loading subscriptions:', e.message);
    return [];
  }
}

// Throttled save — prevents Redis spam on rapid preference changes
const _savePending = new Map();
async function saveSubscription(sub) {
  const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
  // Clear existing timer for this sub if any
  if (_savePending.has(key)) clearTimeout(_savePending.get(key));
  _savePending.set(key, setTimeout(async () => {
    _savePending.delete(key);
    try {
      await redisCommand('set', key, JSON.stringify(sub));
    } catch(e) {
      console.error('Error saving subscription:', e.message);
    }
  }, 2000)); // 2s debounce
}

async function removeSubscription(sub) {
  try {
    const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
    await redisCommand('del', key);
  } catch(e) {
    console.error('Error removing subscription:', e.message);
  }
}

let subscriptions = [];
let lastStatus = { gonzague: null, larocque: null };

// ── Persist lastStatus in Redis ───────────────────────────────────────
async function saveLastStatus() {
  try {
    await redisCommand('set', 'lastStatus', JSON.stringify(lastStatus));
  } catch(e) { console.error('saveLastStatus error:', e.message); }
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

// ── Lift history — track duration of each lift for estimations ────────
let liftHistory = { gonzague: [], larocque: [] }; // [{raisedAt, loweredAt, duration}]
let liftActive = { gonzague: null, larocque: null }; // timestamp when lift started

async function saveLiftHistory() {
  try {
    await redisCommand('set', 'liftHistory', JSON.stringify(liftHistory));
  } catch(e) { console.error('saveLiftHistory error:', e.message); }
}

async function loadLiftHistory() {
  try {
    const val = await redisCommand('get', 'liftHistory');
    if (val) {
      liftHistory = JSON.parse(val);
      log(`📊 Historique chargé: Gonzague=${liftHistory.gonzague.length} levées, Larocque=${liftHistory.larocque.length} levées`);
    }
  } catch(e) { console.error('loadLiftHistory error:', e.message); }
}

function getAvgLiftDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const recent = h.slice(-20); // use last 20 lifts
  const avg = recent.reduce((a, b) => a + b.duration, 0) / recent.length;
  return Math.round(avg / 60000); // return minutes
}

function getAvgLoweringDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const withLowering = h.slice(-20).filter(e => e.loweringDuration);
  if (!withLowering.length) return null;
  const avg = withLowering.reduce((a, b) => a + b.loweringDuration, 0) / withLowering.length;
  return Math.round(avg / 60000);
}

function trackStatusTransition(bridge, prev, curr) {
  const now = Date.now();
  if ((curr === 'raising' || curr === 'leve') && !liftActive[bridge]) {
    liftActive[bridge] = { raisedAt: now };
  }
  if (curr === 'lowering' && liftActive[bridge] && !liftActive[bridge].loweredAt) {
    liftActive[bridge].loweredAt = now;
    liftActive[bridge].duration = now - liftActive[bridge].raisedAt;
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
    // Keep last 100 entries
    if (liftHistory[bridge].length > 100) liftHistory[bridge].shift();
    liftActive[bridge] = null;
    saveLiftHistory();
    log(`📊 Levée [${bridge}] enregistrée: ~${Math.round((entry.loweredAt||now) - entry.raisedAt) / 60000} min`);
  }
}
async function isLiftNotified(key) {
  try {
    const val = await redisCommand('get', `lift:${key}`);
    return val !== null;
  } catch(e) { return false; }
}

async function markLiftNotified(key) {
  try {
    // Expire after 3 hours so Redis self-cleans
    await redisCommand('set', `lift:${key}`, '1', 'EX', '10800');
  } catch(e) { console.error('markLiftNotified error:', e.message); }
}

// ── Time range check (Montreal time) ─────────────────────────────────
function isInTimeRange(sub) {
  const now = new Date();
  const montreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const currentDay = montreal.getDay();
  const currentMinutes = montreal.getHours() * 60 + montreal.getMinutes();

  const ranges = sub.timeRanges;
  // No ranges → check day filter only
  if (!ranges || ranges.length === 0) {
    const allowedDays = sub.notifDays && sub.notifDays.length > 0 ? sub.notifDays : [0,1,2,3,4,5,6];
    return allowedDays.includes(currentDay);
  }

  // Check each range with its corresponding day filter
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range.start || !range.end) continue;

    // Day filter: range 0 uses notifDays, range 1 uses notifDays2
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

// ── Bridge status fetch ───────────────────────────────────────────────
async function fetchBridgeStatus() {
  const res = await fetch(
    'https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const html = await res.text();

  // Split HTML into two bridge sections more reliably
  // Find the two information-container divs
  const containers = [...html.matchAll(/<div[^>]*class="[^"]*information-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];

  // Identify which container belongs to which bridge by looking for bridge names nearby
  let gonzagueSection = '';
  let larocqueSection = '';

  if (containers.length >= 2) {
    // Find sections by looking at the surrounding context
    const gonzagueIdx = html.toLowerCase().indexOf('gonzague');
    const larocqueIdx = html.toLowerCase().indexOf('larocque');

    // Get the HTML chunk for each bridge based on position
    if (gonzagueIdx < larocqueIdx) {
      gonzagueSection = html.slice(gonzagueIdx, larocqueIdx);
      larocqueSection = html.slice(larocqueIdx, larocqueIdx + 3000);
    } else {
      larocqueSection = html.slice(larocqueIdx, gonzagueIdx);
      gonzagueSection = html.slice(gonzagueIdx, gonzagueIdx + 3000);
    }
  } else {
    // Fallback to original method
    gonzagueSection = html.match(/Gonzague[\s\S]{0,3000}?(?=Larocque|<\/body>)/i)?.[0] || '';
    larocqueSection = html.match(/Larocque[\s\S]{0,3000}?(?=Gonzague|<\/body>)/i)?.[0] || '';
  }

  function extractStatus(section, bridgeName) {
    const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
    const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim().toLowerCase());
    const combined = titles.join(' ');

    if (combined.includes('lowering')) return { status: 'lowering', raisedSince: null };
    if (combined.includes('raising')) return { status: 'raising', raisedSince: null };

    const raisedMatch = combined.match(/raised since\s+(\d{1,2}:\d{2})/i);
    if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };

    if (combined.includes('unavailable')) return { status: 'leve', raisedSince: null };

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
    const regex = new RegExp(
      `background-color:\\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*${bridgePattern}`, 'i'
    );
    const match = html.match(regex);
    return match ? match[1].toUpperCase() : '#C1D6A8';
  }

  function isCurrentlyInOutage(closures) {
    if (!closures || closures.length === 0) return null;
    const nowUTC = new Date(); // UTC timestamp, same reference as parsed dates

    for (const c of closures) {
      // Seaway format: "2026-04-11 03:00 until 2026-04-11 15:00" (times are in ET/Montreal)
      const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
      if (!m) continue;

      // Parse as Montreal time by appending ET offset
      // Montreal is UTC-5 (EST) or UTC-4 (EDT — April is EDT)
      const etOffset = '-04:00'; // April = EDT
      const start = new Date(m[1].replace(' ', 'T') + ':00' + etOffset);
      const end   = new Date(m[2].replace(' ', 'T') + ':00' + etOffset);

      if (isNaN(start) || isNaN(end)) continue;

      if (nowUTC >= start && nowUTC <= end) {
        log(`🚧 Outage actif [closure]: ${c} → fin à ${end.toISOString()}`);
        return { closure: c, end };
      }
    }
    return null;
  }

  function getBridgeStatus(section, color, bridgeName, closures) {
    // Check active outage first — overrides all other statuses
    const outage = isCurrentlyInOutage(closures);
    if (outage) return { status: 'outage', raisedSince: null, outageEnd: outage.end, closure: outage.closure };
    const result = extractStatus(section, bridgeName);
    if (result.status) return { status: result.status, raisedSince: result.raisedSince };
    const colorStatus = colorToStatus(color);
    return { status: colorStatus, raisedSince: null };
  }

  function extractLifts(section) {
    const match = section.match(/class="item-data[^"]*"[^>]*>([^<]+)/);
    return match ? match[1].trim() : 'No anticipated bridge lifts';
  }

  function extractClosures(section) {
    const results = [];
    const matches1 = [...section.matchAll(/class="item-data[^"]*"[^>]*style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*>([^<]+)/gi)];
    const matches2 = [...section.matchAll(/style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*class="item-data[^"]*"[^>]*>([^<]+)/gi)];
    for (const m of [...matches1, ...matches2]) {
      const val = m[1].trim();
      if (val && !results.includes(val)) results.push(val);
    }
    return results.length > 0 ? results : null;
  }

  const colorGonzague = extractColor(html, 'St[\\-\\s]Louis[\\-\\s]de[\\-\\s]Gonzague');
  const colorLarocque = extractColor(html, 'Larocque');

  const closuresGonzague = extractClosures(gonzagueSection);
  const closuresLarocque = extractClosures(larocqueSection);

  const gonzague = getBridgeStatus(gonzagueSection, colorGonzague, 'gonzague', closuresGonzague);
  const larocque = getBridgeStatus(larocqueSection, colorLarocque, 'larocque', closuresLarocque);

  // Warn if sections look empty
  if (gonzagueSection.length < 100)
    log(`⚠️ gonzagueSection trop court (${gonzagueSection.length} chars) — scraping peut avoir échoué`);
  if (larocqueSection.length < 100)
    log(`⚠️ larocqueSection trop court (${larocqueSection.length} chars) — scraping peut avoir échoué`);

  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return {
    gonzague: {
      status: gonzague.status,
      raisedSince: gonzague.raisedSince,
      outageEnd: gonzague.outageEnd || null,
      next_lifts: extractLifts(gonzagueSection),
      closures: closuresGonzague
    },
    larocque: {
      status: larocque.status,
      raisedSince: larocque.raisedSince,
      outageEnd: larocque.outageEnd || null,
      next_lifts: extractLifts(larocqueSection),
      closures: closuresLarocque
    },
    last_refreshed,
    _sections: { gonzague: gonzagueSection, larocque: larocqueSection }
  };
}

// ── Send notifications ────────────────────────────────────────────────

function getMessages(bridge, status, lang, data) {
  const shortNames = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' }
  };
  const n = (shortNames[lang] || shortNames.fr)[bridge];

  // Build vessel string if available
  const vesselStr = data?.vessel?.name
    ? (lang === 'fr' ? ` · Navire: ${data.vessel.name}` : ` · Vessel: ${data.vessel.name}`)
    : '';

  // Build outage time string if available
  let outageStr = '';
  if (status === 'outage' && data && data.outageEnd) {
    const end = new Date(data.outageEnd);
    const hm = end.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
    outageStr = lang === 'fr' ? ` · Fermé jusqu'à ${hm}` : ` · Closed until ${hm}`;
  }

  // Estimated lowering duration
  const avgLow = data?.avgLoweringDuration;
  const lowerStr = avgLow
    ? (lang === 'fr' ? ` · ~${avgLow} min avant réouverture` : ` · ~${avgLow} min to reopen`)
    : '';

  // Estimated lift duration + reopen clock time
  const avgLift = data?.avgLiftDuration || 12; // fallback 12 min
  const reopenTime = new Date(Date.now() + avgLift * 60000);
  const hm = reopenTime.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
  const liftStr = lang === 'fr'
    ? ` · Réouverture prévue ~${hm}`
    : ` · Expected reopen ~${hm}`;

  const fr = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Levage imminent · Prévoir un délai${liftStr}` },
    raising:      { title: `🔼 ${n}`, body: `En cours de levage · Circulation interrompue${liftStr}` },
    leve:         { title: `🚢 ${n}`, body: `Pont levé${vesselStr||(' · Passage d\'un navire')}${liftStr}` },
    lowering:     { title: `🔽 ${n}`, body: `Pont redescend · Bientôt disponible${lowerStr}` },
    disponible:   { title: `✅ ${n}`, body: `Disponible · Circulation normale` },
    outage:       { title: `🚧 ${n}`, body: `Fermeture planifiée${outageStr}` }
  };
  const en = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Lift imminent · Expect delays${liftStr}` },
    raising:      { title: `🔼 ${n}`, body: `Bridge raising · Traffic interrupted${liftStr}` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted${vesselStr||' · Vessel passing'}${liftStr}` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon${lowerStr}` },
    disponible:   { title: `✅ ${n}`, body: `Available · Traffic normal` },
    outage:       { title: `🚧 ${n}`, body: `Planned closure${outageStr}` }
  };

  return (lang === 'en' ? en : fr)[status] || null;
}

// Parse scheduled lift times from next_lifts text
// Input: "Commercial Vessel: 14:30*\nPleasure Craft: 15:00" etc.
function parseScheduledLifts(text) {
  if (!text || text === 'No anticipated bridge lifts') return [];
  const times = [];
  const matches = text.matchAll(/(\d{1,2}:\d{2})/g);
  for (const m of matches) {
    times.push(m[1]);
  }
  return times;
}

// ── Notification icon per theme ───────────────────────────────────────
const BASE_URL = 'https://pont-st-louis-de-gonzague.vercel.app';
const VALID_THEMES = ['gonzaguois', 'campivallensien', 'stanicois'];

function notifIcon(sub) {
  const theme = VALID_THEMES.includes(sub.theme) ? sub.theme : 'gonzaguois';
  return `${BASE_URL}/notification-icon-${theme}.png`;
}

// ── Logging helper ───────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Send scheduled lift notification
async function sendScheduledLiftNotification(bridge, time) {
  const names = {
    fr: { gonzague: 'Pont St-Louis-de-Gonzague', larocque: 'Pont Larocque (Valleyfield)' },
    en: { gonzague: 'St-Louis-de-Gonzague Bridge', larocque: 'Larocque Bridge (Valleyfield)' }
  };

  let sent = 0, skippedRange = 0, skippedBridge = 0, failed = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }
    if (!isInTimeRange(sub)) { skippedRange++; continue; }
    const allowedTypes = sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled'];
    if (!allowedTypes.includes('scheduled')) { skippedBridge++; continue; }

    const lang = sub.lang || 'fr';
    const name = (names[lang] || names.fr)[bridge];
    const msg = lang === 'en'
      ? { title: `📅 Lift scheduled at ${time}`, body: `${name} will be raised at ${time}.` }
      : { title: `📅 Levée prévue à ${time}`, body: `Le ${name} sera levé à ${time}.` };

    const payload = JSON.stringify({ ...msg, bridge, persistent: false, icon: notifIcon(sub) });
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      failed++;
      log(`❌ Push failed [${bridge}] scheduled ${time} — HTTP ${e.statusCode}: ${e.message}`);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
      umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
    }
  }
  log(`📅 Levée planifiée [${bridge}] ${time} — ✅ ${sent} envoyées | ⏰ ${skippedRange} hors plage | 🚫 ${skippedBridge} pont non suivi | ❌ ${failed} échouées`);
}

async function sendNotifications(bridge, status, bridgeData = {}) {
  let sent = 0, skippedRange = 0, skippedBridge = 0, skippedNoMsg = 0, failed = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }

    // Always send 'disponible' regardless of time range or type filter — closes persistent notification
    const isClosing = status === 'disponible';
    if (!isClosing && !isInTimeRange(sub)) { skippedRange++; continue; }

    const allowedTypes = sub.notifTypes || ['bientot_leve','leve','outage'];
    if (!isClosing && !allowedTypes.includes(status)) { skippedNoMsg++; continue; }

    const lang = sub.lang || 'fr';
    const msg = getMessages(bridge, status, lang, bridgeData);
    if (!msg) { skippedNoMsg++; continue; }

    const payload = JSON.stringify({
      ...msg, bridge,
      tag: `pont-${bridge}`,
      persistent: true,
      icon: notifIcon(sub)
    });

    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      failed++;
      log(`❌ Push failed [${bridge}] ${status} — HTTP ${e.statusCode}: ${e.message}`);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
      umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
    }
  }
  log(`🔔 Notification [${bridge}] ${status} — ✅ ${sent} envoyées | ⏰ ${skippedRange} hors plage | 🚫 ${skippedBridge} pont non suivi | ❌ ${failed} échouées`);
}

// ── Monitor ───────────────────────────────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    log(`🌉 Gonzague: ${data.gonzague.status} | Larocque: ${data.larocque.status} | Abonnés: ${subscriptions.length}`);

    const notifications = [];

    // Status change notifications
    for (const bridge of ['gonzague', 'larocque']) {
      const prev = lastStatus[bridge];
      const curr = data[bridge].status;
      if (prev === null) {
        log(`⚡ Boot [${bridge}] — statut initial: ${curr} (pas de notif)`);
      } else if (prev !== curr) {
        const section = data._sections[bridge] || '';
        const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
        const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim());
        log(`🔄 Changement [${bridge}]: ${prev} → ${curr} | titres HTML: [${titles.join(' / ') || 'aucun'}]`);
        trackStatusTransition(bridge, prev, curr);
        notifications.push(sendNotifications(bridge, curr, data[bridge]));
      }
    }

    // Scheduled lift notifications (next 60 min)
    // Skip if bridge is in outage — it's already closed, lift info is irrelevant
    for (const bridge of ['gonzague', 'larocque']) {
      if (data[bridge].status === 'outage') {
        log(`⏭️ Levées planifiées [${bridge}] ignorées — pont en fermeture`);
        continue;
      }
      const lifts = parseScheduledLifts(data[bridge].next_lifts);
      for (const time of lifts) {
        const key = `${bridge}:${time}`;
        const alreadyNotified = await isLiftNotified(key);
        if (!alreadyNotified) {
          log(`📅 Nouvelle levée planifiée [${bridge}] à ${time}`);
          await markLiftNotified(key);
          notifications.push(sendScheduledLiftNotification(bridge, time));
        }
      }
    }

    if (notifications.length === 0) {
      log(`💤 Aucun changement détecté`);
    }

    await Promise.all(notifications);

    lastStatus.gonzague = data.gonzague.status;
    lastStatus.larocque = data.larocque.status;
    await saveLastStatus();

  } catch(e) {
    log(`🚨 Monitor error: ${e.message}`);
    console.error(e);
  }
}

// ── Auto-ping ─────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch('https://pont-st-louis-de-gonzague.onrender.com/ping');
    console.log('Auto-ping OK');
  } catch(e) {
    console.log('Auto-ping failed:', e.message);
  }
}, 600000);

// ── Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Ponts Beauharnois API'));
app.get('/ping', (req, res) => res.send('OK'));

app.get('/status', async (req, res) => {
  try {
    const data = await fetchBridgeStatus();
    // Enrich with lift history data
    for (const bridge of ['gonzague', 'larocque']) {
      data[bridge].avgLiftDuration = getAvgLiftDuration(bridge);
      data[bridge].avgLoweringDuration = getAvgLoweringDuration(bridge);
      data[bridge].liftCount = liftHistory[bridge].length;
      if (liftActive[bridge]) {
        data[bridge].liftingSince = liftActive[bridge].raisedAt;
      }
      // Add vessel info if available
      if (vesselNearBridge[bridge]) {
        data[bridge].vessel = vesselNearBridge[bridge];
      }
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  const existing = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (existing) {
    existing.bridges = sub.bridges || ['gonzague', 'larocque'];
    existing.timeRanges = sub.timeRanges || [];
    existing.lang = sub.lang || 'fr';
    existing.theme = sub.theme || 'gonzaguois';
    existing.notifTypes = sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled','outage'];
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

app.get('/history', (req, res) => {
  res.json({
    gonzague: { entries: liftHistory.gonzague.length, avgDuration: getAvgLiftDuration('gonzague'), avgLowering: getAvgLoweringDuration('gonzague') },
    larocque: { entries: liftHistory.larocque.length, avgDuration: getAvgLiftDuration('larocque'), avgLowering: getAvgLoweringDuration('larocque') }
  });
});

// ── Milestone push notification ───────────────────────────────────────
app.post('/milestone-notif', async (req, res) => {
  const { endpoint, milestone, lang } = req.body;
  if (!endpoint || !milestone) return res.status(400).json({ error: 'missing params' });

  const sub = subscriptions.find(s => s.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'subscriber not found' });

  const isFr = (lang || sub.lang || 'fr') === 'fr';
  const messages = {
    7:  { fr: { title: '🌉 Une semaine ensemble !', body: 'Ça fait 7 jours que l\'app veille sur vos traversées. Un petit mot ?' },
              en: { title: '🌉 One week together!',  body: 'The app has been watching over your crossings for 7 days. Share a thought?' } },
    30: { fr: { title: '📅 Un mois déjà !',         body: 'Merci de nous faire confiance depuis un mois. Votre avis nous aide à améliorer l\'app.' },
              en: { title: '📅 One month already!',  body: 'Thanks for trusting us for a month. Your feedback helps improve the app.' } },
    90: { fr: { title: '🏅 3 mois de traversées !', body: 'Vous faites partie de nos utilisateurs les plus fidèles. Un immense merci !' },
              en: { title: '🏅 3 months of crossings!', body: 'You\'re one of our most loyal users. Thank you so much!' } }
  };

  const msg = (messages[milestone] || {})[isFr ? 'fr' : 'en'];
  if (!msg) return res.status(400).json({ error: 'invalid milestone' });

  try {
    await webpush.sendNotification(sub, JSON.stringify({
      ...msg,
      tag: `milestone-${milestone}`,
      persistent: false,
      icon: notifIcon(sub)
    }));
    umamiTrack('milestone_push_sent', { milestone });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

async function start() {
  subscriptions = await loadSubscriptions();
  await loadLastStatus();
  await loadLiftHistory();
  log(`Ready with ${subscriptions.length} subscriptions — polling every 30s`);
  umamiTrack('subscription_count', { count: subscriptions.length });
  startAISTracking();
  await monitor();
  setInterval(monitor, 30000); // 30s to catch short status windows
}

start();
