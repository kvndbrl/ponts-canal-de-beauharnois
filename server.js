const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ── Persistent subscriptions ──────────────────────────────────────────
const SUBS_FILE = '/tmp/subscriptions.json';

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const data = fs.readFileSync(SUBS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch(e) {
    console.error('Error loading subscriptions:', e.message);
  }
  return [];
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions));
  } catch(e) {
    console.error('Error saving subscriptions:', e.message);
  }
}

let subscriptions = loadSubscriptions();
let lastStatus = null;

console.log(`Loaded ${subscriptions.length} subscriptions from disk`);

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
  console.log(`Sending notifications to ${subscriptions.length} subscribers for status: ${status}`);

  const failed = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      console.error('Failed to send notification:', e.message);
      failed.push(sub);
    }
  }

  if (failed.length > 0) {
    subscriptions = subscriptions.filter(s => !failed.includes(s));
    saveSubscriptions();
    console.log(`Removed ${failed.length} invalid subscriptions`);
  }
}

// ── Monitor bridge every 60 seconds ──────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    console.log(`[${new Date().toISOString()}] Status: ${data.status} (was: ${lastStatus})`);

    if (lastStatus !== null && lastStatus !== data.status) {
      console.log(`Status changed from ${lastStatus} to ${data.status} — sending notifications`);
      await sendNotifications(data.status);
    }
    lastStatus = data.status;
  } catch(e) {
    console.error('Monitor error:', e.message);
  }
}

setInterval(monitor, 60000);
monitor();

// ── Auto-ping to prevent sleep ────────────────────────────────────────
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

app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    saveSubscriptions();
    console.log(`New subscriber! Total: ${subscriptions.length}`);
  }
  res.json({ ok: true });
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
