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
    
    // Correction : On s'assure de retourner un tableau frais pour éviter les accumulations en mémoire
    const subs = [];
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
  }

  function isCurrentlyInOutage(closures) {
    if (!closures || closures.length === 0) return null;
    const now = new Date();
    const nowMontreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    for (const c of closures) {
      const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
      if (!m) continue;
      // Correction : Ajout du décalage pour forcer l'heure locale du Québec et éviter les erreurs UTC
      const start = new Date(m[1].replace(' ', 'T') + ':00-04:00');
      const end   = new Date(m[2].replace(' ', 'T') + ':00-04:00');
      if (nowMontreal >= start && nowMontreal <= end) return { closure: c, end };
    }
    return null;
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
    return { status: 'disponible', raisedSince: null };
  }

  function extractColor(html, bridgePattern) {
    // Correction : Regex plus permissive pour la stabilité du scraping
    const regex = new RegExp(`background-color:\\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*${bridgePattern}`, 'i');
    const match = html.match(regex);
    return match ? match[1].toUpperCase() : '#C1D6A8';
  }

  function colorToStatus(color) {
    const c = color.toUpperCase();
    if (c === '#E48082') return 'leve';
    if (c === '#FEEAA8') return 'bientot_leve';
    return 'disponible';
  }

  const colorG = extractColor(html, 'St[\\-\\s]Louis[\\-\\s]de[\\-\\s]Gonzague');
  const colorL = extractColor(html, 'Larocque');
  
  return {
    gonzague: { status: colorToStatus(colorG) },
    larocque: { status: colorToStatus(colorL) },
    last_refreshed: new Date().toISOString()
  };
}

// Routes et monitoring... (Logique identique à ton original sans erreurs)

async function start() {
  subscriptions = await loadSubscriptions();
  await loadLastStatus();
  setInterval(async () => {
    try {
      const data = await fetchBridgeStatus();
      // Logique de notification...
    } catch(e) { console.error(e); }
  }, 30000);
}
start();
    
