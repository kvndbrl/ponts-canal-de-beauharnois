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

// ── Upstash Redis helpers ─────────────────────────────────────────────
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
let lastStatus = null;

// ── Bridge status fetch ───────────────────────────────────────────────
async function fetchBridgeStatus() {
  const res = await fetch(
    'https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const html = await res.text();

  const colorMatch = html.match(/background-color:\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*St[\-\s]Louis[\-\s]de[\-\s]Gonzague/i);
  const color = colorMatch ? colorMatch[1].toUpperCase() : '#C1D6A8';

  let status = 'disponible';
  if (color === '#E48082') status = 'leve';
  else if (color === '#FEEAA8') status = 'bientot_leve';

  const gonzagueMatch = html.match(/St[\-\s]Louis[\-\s]de[\-\s]Gonzague[\s\S]{0,2000}?(?=Larocque|Valleyfield|<\/body>)/i);
  const section = gonzagueMatch ? gonzagueMatch[0] : html;

  const liftsMatch = section.match(/item-data[^>]*>([^<]+)/);
  const next_lifts = liftsMatch ? liftsMatch[1].trim() : 'No anticipated bridge lifts';

  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return { status, next_lifts, last_refreshed, debug_color: color };
}

// ── Send notifications ────────────────────────────────────────────────
async function sendNotifications(status) {
  const messages = {
    bientot_leve: {
      title: '⚠️ Pont levé dans moins de 15 min',
      body: 'Le pont St-Louis-de-Gonzague sera levé sous peu.'
    },
    leve: {
      title: '🚢 Pont levé',
      body: 'Le pont St-Louis-de-Gonzague est levé pour laisser passer un navire.'
    },
    disponible: {
      title: '✅ Pont disponible',
      body: 'Le pont St-Louis-de-Gonzague est de nouveau ouvert à la circulation.'
    }
  };

  const msg = messages[status];
  if (!msg) return;

  const payload = JSON.stringify({ ...msg, persistent: status !== 'disponible' });
  console.log(`Sending to ${subscriptions.length} subscribers — status: ${status}`);

  for (const sub of [...subscriptions]) {
    try {
      await webpush.sendNotification(sub, payload);
      console.log('Notification sent successfully');
    } catch(e) {
      console.error('Failed notification, removing sub:', e.message);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
    }
  }
}

// ── Monitor ───────────────────────────────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    console.log(`[${new Date().toISOString()}] Status: ${data.status} (was: ${lastStatus})`);

    if (lastStatus !== null && lastStatus !== data.status) {
      console.log(`Changed: ${lastStatus} → ${data.status}`);
      await sendNotifications(data.status);
    }
    lastStatus = data.status;
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
app.get('/', (req, res) => res.send('Pont St-Louis-de-Gonzague API'));

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
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    await saveSubscription(sub);
    console.log(`New subscriber! Total: ${subscriptions.length}`);
  }
  res.json({ ok: true });
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// ── Start: load subscriptions BEFORE monitoring ───────────────────────
async function start() {
  subscriptions = await loadSubscriptions();
  console.log(`Ready with ${subscriptions.length} subscriptions — starting monitor`);
  await monitor();
  setInterval(monitor, 60000);
}

start();
