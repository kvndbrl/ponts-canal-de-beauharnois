const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');

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
let subscriptions = [];
let lastStatus = null;

const COLORS = {
  disponible: '#C1D6A8',
  bientot_leve: '#FEEAA8',
  leve: '#E48082'
};

async function fetchBridgeStatus() {
  const res = await fetch(
    'https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const html = await res.text();

  // Extraire le bloc spécifique au pont Gonzague
  const gonzagueMatch = html.match(/St[\-\s]Louis[\-\s]de[\-\s]Gonzague[\s\S]{0,2000}?(?=Larocque|Valleyfield|<\/body>)/i);
  const section = gonzagueMatch ? gonzagueMatch[0] : html;

  // Extraire la couleur dans ce bloc
  const colorMatch = section.match(/background-color:\s*(#[A-Fa-f0-9]{6})/i);
  const color = colorMatch ? colorMatch[1].toUpperCase() : '#C1D6A8';

  let status = 'disponible';
  if (color === '#E48082') status = 'leve';
  else if (color === '#FEEAA8') status = 'bientot_leve';

  // Extraire les levages
  const liftsMatch = section.match(/item-data[^>]*>([^<]+)/);
  const next_lifts = liftsMatch ? liftsMatch[1].trim() : 'No anticipated bridge lifts';

  // Extraire la dernière mise à jour
  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return { status, next_lifts, last_refreshed, debug_color: color };
}

async function sendNotifications(status) {
  const messages = {
    bientot_leve: { title: '⚠️ Pont levé dans moins de 15 min', body: 'Le pont St-Louis-de-Gonzague sera levé sous peu.' },
    leve: { title: '🚢 Pont levé', body: 'Le pont St-Louis-de-Gonzague est levé pour laisser passer un navire.' },
    disponible: { title: '✅ Pont disponible', body: 'Le pont St-Louis-de-Gonzague est de nouveau ouvert à la circulation.' }
  };

  const msg = messages[status];
  if (!msg) return;

  const payload = JSON.stringify({ ...msg, persistent: status !== 'disponible' });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      subscriptions = subscriptions.filter(s => s !== sub);
    }
  }
}

// Surveille le pont toutes les 60 secondes
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    if (lastStatus && lastStatus !== data.status) {
      await sendNotifications(data.status);
    }
    lastStatus = data.status;
    console.log(`[${new Date().toISOString()}] Status: ${data.status}`);
  } catch (e) {
    console.error('Erreur:', e.message);
  }
}

setInterval(monitor, 60000);
monitor();

// Routes
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
    console.log('Nouvel abonné, total:', subscriptions.length);
  }
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Pont St-Louis-de-Gonzague API'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
