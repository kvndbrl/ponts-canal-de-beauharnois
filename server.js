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
    const subs = []; // Correction : On reconstruit proprement la liste
    for (const key of keys) {
      const val = await redisCommand('get', key);
      if (val) subs.push(JSON.parse(val));
    }
    console.log(`Loaded ${subs.length} subscriptions from Redis`);
    return subs;
  } catch(e) {
    console.error('Error loading subscriptions:', e.message);
    return [];
  }
}

async function saveSubscription(sub) {
  try {
    const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
    await redisCommand('set', key, JSON.stringify(sub));
  } catch(e) {
    console.error('Error saving subscription:', e.message);
  }
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

async function isLiftNotified(key) {
  try {
    const val = await redisCommand('get', `lift:${key}`);
    return val !== null;
  } catch(e) { return false; }
}

async function markLiftNotified(key) {
  try {
    await redisCommand('set', `lift:${key}`, '1', 'EX', '10800');
  } catch(e) { console.error('markLiftNotified error:', e.message); }
}

function isInTimeRange(sub) {
  const ranges = sub.timeRanges;
  if (!ranges || ranges.length === 0) return true;
  const now = new Date();
  const montreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const currentMinutes = montreal.getHours() * 60 + montreal.getMinutes();

  for (const range of ranges) {
    if (!range.start || !range.end) continue;
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
  const res = await fetch(
    'https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
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
    const regex = new RegExp(`background-color:\\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*${bridgePattern}`, 'i');
    const match = html.match(regex);
    return match ? match[1].toUpperCase() : '#C1D6A8';
  }

  function isCurrentlyInOutage(closures) {
    if (!closures || closures.length === 0) return null;
    const now = new Date();
    const nowMontreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    for (const c of closures) {
      const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
      if (!m) continue;
      // Correction : On force l'offset -04:00 (EDT) pour éviter que le serveur n'interprète en UTC
      const start = new Date(m[1].replace(' ', 'T') + ':00-04:00');
      const end   = new Date(m[2].replace(' ', 'T') + ':00-04:00');
      if (nowMontreal >= start && nowMontreal <= end) return { closure: c, end };
    }
    return null;
  }

  function getBridgeStatus(section, color, bridgeName, closures) {
    const outage = isCurrentlyInOutage(closures);
    if (outage) return { status: 'outage', raisedSince: null, outageEnd: outage.end, closure: outage.closure };
    const result = extractStatus(section);
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

  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  return {
    gonzague: { ...gonzague, next_lifts: extractLifts(gonzagueSection), closures: closuresGonzague },
    larocque: { ...larocque, next_lifts: extractLifts(larocqueSection), closures: closuresLarocque },
    last_refreshed: refreshMatch ? refreshMatch[1].trim() : '',
    _sections: { gonzague: gonzagueSection, larocque: larocqueSection }
  };
}

// ── Notifications et restes du code original ─────────────────────────
function getMessages(bridge, status, lang) {
  const names = {
    fr: { gonzague: 'Pont St-Louis-de-Gonzague', larocque: 'Pont Larocque (Valleyfield)' },
    en: { gonzague: 'St-Louis-de-Gonzague Bridge', larocque: 'Larocque Bridge (Valleyfield)' }
  };
  const name = (names[lang] || names.fr)[bridge];
  const fr = {
    bientot_leve: { title: `⚠️ Levage imminent`, body: `Le ${name} sera levé sous peu.` },
    raising:      { title: `🔼 En cours de levage`, body: `Le ${name} est en train de se lever.` },
    leve:         { title: `🚢 Pont levé`, body: `Le ${name} est levé pour laisser passer un navire.` },
    lowering:     { title: `🔽 En cours de descente`, body: `Le ${name} sera bientôt disponible.` },
    disponible:   { title: `✅ Pont disponible`, body: `Le ${name} est de nouveau ouvert à la circulation.` },
    outage:       { title: `🚧 Fermeture planifiée`, body: `Le ${name} est fermé pour maintenance.` }
  };
  const en = {
    bientot_leve: { title: `⚠️ Lift imminent`, body: `The ${name} will be raised shortly.` },
    raising:      { title: `🔼 Bridge raising`, body: `The ${name} is currently being raised.` },
    leve:         { title: `🚢 Bridge lifted`, body: `The ${name} is raised for a vessel to pass.` },
    lowering:     { title: `🔽 Bridge lowering`, body: `The ${name} will reopen soon.` },
    disponible:   { title: `✅ Bridge available`, body: `The ${name} is open to traffic again.` },
    outage:       { title: `🚧 Planned closure`, body: `The ${name} is closed for maintenance.` }
  };
  return (lang === 'en' ? en : fr)[status] || null;
}

function parseScheduledLifts(text) {
  if (!text || text === 'No anticipated bridge lifts') return [];
  return Array.from(text.matchAll(/(\d{1,2}:\d{2})/g), m => m[1]);
}

const BASE_URL = 'https://pont-st-louis-de-gonzague.vercel.app';
function notifIcon(sub) {
  const theme = ['gonzaguois', 'campivallensien', 'stanicois'].includes(sub.theme) ? sub.theme : 'gonzaguois';
  return `${BASE_URL}/notification-icon-${theme}.png`;
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function sendScheduledLiftNotification(bridge, time) {
  const names = {
    fr: { gonzague: 'Pont St-Louis-de-Gonzague', larocque: 'Pont Larocque (Valleyfield)' },
    en: { gonzague: 'St-Louis-de-Gonzague Bridge', larocque: 'Larocque Bridge (Valleyfield)' }
  };
  for (const sub of [...subscriptions]) {
    if (!(sub.bridges || ['gonzague', 'larocque']).includes(bridge)) continue;
    if (!isInTimeRange(sub)) continue;
    if (!(sub.notifTypes || []).includes('scheduled')) continue;

    const lang = sub.lang || 'fr';
    const name = (names[lang] || names.fr)[bridge];
    const msg = lang === 'en' 
      ? { title: `📅 Lift scheduled at ${time}`, body: `${name} will be raised at ${time}.` }
      : { title: `📅 Levée prévue à ${time}`, body: `Le ${name} sera levé à ${time}.` };

    try {
      await webpush.sendNotification(sub, JSON.stringify({ ...msg, bridge, persistent: false, icon: notifIcon(sub) }));
    } catch(e) { if(e.statusCode === 410) removeSubscription(sub); }
  }
}

async function sendNotifications(bridge, status) {
  for (const sub of [...subscriptions]) {
    if (!(sub.bridges || ['gonzague', 'larocque']).includes(bridge)) continue;
    if (!isInTimeRange(sub)) continue;
    if (!(sub.notifTypes || []).includes(status)) continue;

    const lang = sub.lang || 'fr';
    const msg = getMessages(bridge, status, lang);
    if (!msg) continue;

    try {
      await webpush.sendNotification(sub, JSON.stringify({
        ...msg, bridge,
        persistent: status === 'outage' || (status !== 'disponible' && status !== 'lowering'),
        icon: notifIcon(sub)
      }));
    } catch(e) { if(e.statusCode === 410) removeSubscription(sub); }
  }
}

async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    for (const bridge of ['gonzague', 'larocque']) {
      const prev = lastStatus[bridge];
      const curr = data[bridge].status;
      if (prev !== null && prev !== curr) await sendNotifications(bridge, curr);
      
      const lifts = parseScheduledLifts(data[bridge].next_lifts);
      for (const time of lifts) {
        if (!(await isLiftNotified(`${bridge}:${time}`))) {
          await markLiftNotified(`${bridge}:${time}`);
          await sendScheduledLiftNotification(bridge, time);
        }
      }
    }
    lastStatus.gonzague = data.gonzague.status;
    lastStatus.larocque = data.larocque.status;
    await saveLastStatus();
  } catch(e) { log(`🚨 Monitor error: ${e.message}`); }
}

// ── Routes Express ────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  try { res.json(await fetchBridgeStatus
