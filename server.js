const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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

// ── Notified lifts — Redis-backed to survive server restarts ──────────
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
const MAPS_URL = {
  gonzague: {
    google: 'https://www.google.com/maps/search/pont+alternatif+Saint-Louis-de-Gonzague',
    apple:  'https://maps.apple.com/?q=pont+alternatif+Saint-Louis-de-Gonzague'
  },
  larocque: {
    google: 'https://www.google.com/maps/search/pont+alternatif+Valleyfield',
    apple:  'https://maps.apple.com/?q=pont+alternatif+Valleyfield'
  }
};

function getMessages(bridge, status, lang, data) {
  const shortNames = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' }
  };
  const n = (shortNames[lang] || shortNames.fr)[bridge];

  // Build outage time string if available
  let outageStr = '';
  if (status === 'outage' && data && data.outageEnd) {
    const end = new Date(data.outageEnd);
    const hm = end.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
    outageStr = lang === 'fr' ? ` · Fermé jusqu'à ${hm}` : ` · Closed until ${hm}`;
  }

  const fr = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Levage imminent · Prévoir un délai` },
    raising:      { title: `🔼 ${n}`, body: `En cours de levage · Circulation interrompue` },
    leve:         { title: `🚢 ${n}`, body: `Pont levé · Passage d'un navire` },
    lowering:     { title: `🔽 ${n}`, body: `Pont redescend · Bientôt disponible` },
    disponible:   { title: `✅ ${n}`, body: `Disponible · Circulation normale` },
    outage:       { title: `🚧 ${n}`, body: `Fermeture planifiée${outageStr}` }
  };
  const en = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Lift imminent · Expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Bridge raising · Traffic interrupted` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted · Vessel passing` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon` },
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
    }
  }
  log(`📅 Levée planifiée [${bridge}] ${time} — ✅ ${sent} envoyées | ⏰ ${skippedRange} hors plage | 🚫 ${skippedBridge} pont non suivi | ❌ ${failed} échouées`);
}

async function sendNotifications(bridge, status, bridgeData = {}) {
  let sent = 0, skippedRange = 0, skippedBridge = 0, skippedNoMsg = 0, failed = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }

    // Always send 'disponible' regardless of time range — closes persistent notification
    const isClosing = status === 'disponible';
    if (!isClosing && !isInTimeRange(sub)) { skippedRange++; continue; }

    const allowedTypes = sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled','outage'];
    if (!allowedTypes.includes(status)) { skippedNoMsg++; continue; }
    if (!allowedTypes.includes(status)) { skippedNoMsg++; continue; }

    const lang = sub.lang || 'fr';
    const msg = getMessages(bridge, status, lang, bridgeData);
    if (!msg) { skippedNoMsg++; continue; }

    // Detect iOS by endpoint (heuristic) — default to Google Maps
    const mapsUrl = MAPS_URL[bridge]?.google || '';

    const payload = JSON.stringify({
      ...msg, bridge,
      tag: `pont-${bridge}`,           // same tag = replaces previous notification
      persistent: true,                 // always persistent — user dismisses manually
      mapsUrl,
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
        // Log scraping details only when there's a change
        const section = data._sections[bridge] || '';
        const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
        const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim());
        log(`🔄 Changement [${bridge}]: ${prev} → ${curr} | titres HTML: [${titles.join(' / ') || 'aucun'}]`);
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
  }
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  const key = `sub:${Buffer.from(endpoint).toString('base64').slice(0, 50)}`;
  await redisCommand('del', key);
  console.log(`Unsubscribed. Total: ${subscriptions.length}`);
  res.json({ ok: true });
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

async function start() {
  subscriptions = await loadSubscriptions();
  await loadLastStatus();
  log(`Ready with ${subscriptions.length} subscriptions — polling every 30s`);
  await monitor();
  setInterval(monitor, 30000); // 30s to catch short status windows
}

start();
