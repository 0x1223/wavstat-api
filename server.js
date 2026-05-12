import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DIGITIZER_URL = process.env.DIGITIZER_URL || 'http://localhost:3001';

const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  || 'https://wavstat-api-production.up.railway.app/spotify/callback';
const FRONTEND_URL          = process.env.FRONTEND_URL          || 'https://frontend-production-81287.up.railway.app';

const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-library-read',
].join(' ');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── CORS for Spotify routes ────────────────────────────────────────────────────
app.use('/spotify', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── GET /spotify/login ─────────────────────────────────────────────────────────
app.get('/spotify/login', (req, res) => {
  if (!SPOTIFY_CLIENT_ID) {
    return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not configured' });
  }
  const state = Math.random().toString(36).slice(2, 10);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// ── GET /spotify/callback ──────────────────────────────────────────────────────
app.get('/spotify/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?spotify_error=${encodeURIComponent(error || 'access_denied')}`);
  }

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const params = new URLSearchParams({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_in: tokens.expires_in || 3600,
    });
    res.redirect(`${FRONTEND_URL}?${params}`);
  } catch (err) {
    console.error('Spotify callback error:', err.message);
    res.redirect(`${FRONTEND_URL}?spotify_error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /spotify/refresh ──────────────────────────────────────────────────────
app.post('/spotify/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      }),
    });

    const data = await tokenRes.json();
    if (data.error) return res.status(401).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /spotify/status ────────────────────────────────────────────────────────
app.get('/spotify/status', (req, res) => {
  res.json({ configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) });
});

// ── Proxy /digitizer/* → digitizer microservice ───────────────────────────────
app.use('/digitizer', createProxyMiddleware({
  target: DIGITIZER_URL,
  changeOrigin: true,
  pathRewrite: { '^/digitizer': '' },
  on: {
    error(err, req, res) {
      res.status(502).json({ error: 'Digitizer service unavailable', detail: err.message });
    },
  },
}));

// ── Serve Vite build in production ────────────────────────────────────────────
const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => res.sendFile(join(distPath, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({ status: 'ok', note: 'Run npm run build to serve frontend' }));
}

app.listen(PORT, () => console.log(`Wavstat API on port ${PORT} | digitizer → ${DIGITIZER_URL}`));
