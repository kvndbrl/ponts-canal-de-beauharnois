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
  const res = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  return data.result;
}

async function loadSubscriptions() {
  try {
    const keys = await redisCommand('keys', 'sub:*');
    if (!keys || keys.length === 0) return [];
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
  const ranges = sub.timeRanges;
  // No ranges configured → always notify
  if (!ranges || ranges.length === 0) return true;

  // Get current Montreal time
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
      // Normal range e.g. 09:00 → 17:00
      if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) return true;
    } else {
      // Overnight range e.g. 22:00 → 06:00
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

  function extractStatus(section) {
    // Extract all status-title h1 text in this section
    const titles = [...section.matchAll(/<h1[^>]*class="status-title"[^>]*>\s*<b>([^<]+)<\/b>/gi)]
      .map(m => m[1].trim().toLowerCase());

    // Combine into one string for pattern matching
    const combined = titles.join(' ');

    if (combined.includes('lowering')) return { status: 'lowering', raisedSince: null };
    if (combined.includes('raising')) return { status: 'raising', raisedSince: null };

    // "raised since HH:MM"
    const raisedMatch = combined.match(/raised since\s+(\d{1,2}:\d{2})/i);
    if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };

    return { status: null, raisedSince: null };
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

  function getBridgeStatus(section, color) {
    const { status: subtitleStatus, raisedSince } = extractStatus(section);
    // Subtitle takes priority for raising/lowering/raised since
    if (subtitleStatus) return { status: subtitleStatus, raisedSince };
    // Fall back to color
    return { status: colorToStatus(color), raisedSince: null };
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

  const gonzagueSection = html.match(/Gonzague[\s\S]{0,3000}?(?=Larocque|<\/body>)/i)?.[0] || '';
  const larocqueSection = html.match(/Larocque[\s\S]{0,3000}?(?=Gonzague|<\/body>)/i)?.[0] || '';

  const colorGonzague = extractColor(html, 'St[\\-\\s]Louis[\\-\\s]de[\\-\\s]Gonzague');
  const colorLarocque = extractColor(html, 'Larocque');

  const gonzague = getBridgeStatus(gonzagueSection, colorGonzague);
  const larocque = getBridgeStatus(larocqueSection, colorLarocque);

  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return {
    gonzague: {
      status: gonzague.status,
      raisedSince: gonzague.raisedSince,
      next_lifts: extractLifts(gonzagueSection),
      closures: extractClosures(gonzagueSection)
    },
    larocque: {
      status: larocque.status,
      raisedSince: larocque.raisedSince,
      next_lifts: extractLifts(larocqueSection),
      closures: extractClosures(larocqueSection)
    },
    last_refreshed
  };
}

// ── Send notifications ────────────────────────────────────────────────
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
    disponible:   { title: `✅ Pont disponible`, body: `Le ${name} est de nouveau ouvert à la circulation.` }
  };
  const en = {
    bientot_leve: { title: `⚠️ Lift imminent`, body: `The ${name} will be raised shortly.` },
    raising:      { title: `🔼 Bridge raising`, body: `The ${name} is currently being raised.` },
    leve:         { title: `🚢 Bridge lifted`, body: `The ${name} is raised for a vessel to pass.` },
    lowering:     { title: `🔽 Bridge lowering`, body: `The ${name} will reopen soon.` },
    disponible:   { title: `✅ Bridge available`, body: `The ${name} is open to traffic again.` }
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

// Send scheduled lift notification
async function sendScheduledLiftNotification(bridge, time) {
  const names = {
    fr: { gonzague: 'Pont St-Louis-de-Gonzague', larocque: 'Pont Larocque (Valleyfield)' },
    en: { gonzague: 'St-Louis-de-Gonzague Bridge', larocque: 'Larocque Bridge (Valleyfield)' }
  };

  console.log(`Sending scheduled lift notification [${bridge}] at ${time}`);

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) continue;
    if (!isInTimeRange(sub)) continue;

    const lang = sub.lang || 'fr';
    const name = (names[lang] || names.fr)[bridge];
    const msg = lang === 'en'
      ? { title: `📅 Lift scheduled at ${time}`, body: `${name} will be raised at ${time}.` }
      : { title: `📅 Levée prévue à ${time}`, body: `Le ${name} sera levé à ${time}.` };

    const payload = JSON.stringify({ ...msg, bridge, persistent: false, icon: notifIcon(sub) });
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      console.error('Failed scheduled lift notification:', e.statusCode);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
    }
  }
}

async function sendNotifications(bridge, status) {
  console.log(`Sending [${bridge}] ${status} to ${subscriptions.length} subscribers`);

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) continue;

    if (!isInTimeRange(sub)) {
      console.log(`Skipping notification for subscriber (outside time range)`);
      continue;
    }

    const lang = sub.lang || 'fr';
    const msg = getMessages(bridge, status, lang);
    if (!msg) continue;

    const payload = JSON.stringify({
      ...msg, bridge,
      persistent: status !== 'disponible' && status !== 'lowering',
      icon: notifIcon(sub)
    });

    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      console.error('Failed notification, removing sub:', e.statusCode, e.message);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
    }
  }
}

// ── Monitor ───────────────────────────────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    console.log(`[${new Date().toISOString()}] Gonzague: ${data.gonzague.status} | Larocque: ${data.larocque.status}`);

    const notifications = [];

    // Status change notifications
    if (lastStatus.gonzague !== null && lastStatus.gonzague !== data.gonzague.status) {
      notifications.push(sendNotifications('gonzague', data.gonzague.status));
    }
    if (lastStatus.larocque !== null && lastStatus.larocque !== data.larocque.status) {
      notifications.push(sendNotifications('larocque', data.larocque.status));
    }

    // Scheduled lift notifications (next 60 min)
    for (const bridge of ['gonzague', 'larocque']) {
      const lifts = parseScheduledLifts(data[bridge].next_lifts);
      for (const time of lifts) {
        const key = `${bridge}:${time}`;
        const alreadyNotified = await isLiftNotified(key);
        if (!alreadyNotified) {
          await markLiftNotified(key);
          notifications.push(sendScheduledLiftNotification(bridge, time));
        }
      }
    }

    await Promise.all(notifications);

    lastStatus.gonzague = data.gonzague.status;
    lastStatus.larocque = data.larocque.status;

  } catch(e) {
    console.error('Monitor error:', e.message);
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
  console.log(`Ready with ${subscriptions.length} subscriptions — starting monitor`);
  await monitor();
  setInterval(monitor, 60000);
}

start();
