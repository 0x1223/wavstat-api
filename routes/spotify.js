import { Router } from 'express';

const router = Router();

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  || 'https://wavstat-api-production.up.railway.app/spotify/callback';
const FRONTEND_URL  = process.env.FRONTEND_URL          || 'https://frontend-production-81287.up.railway.app';

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-library-read',
].join(' ');

const SP_API = 'https://api.spotify.com/v1';

function basicAuth() {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
}

async function spGet(path, token) {
  const res = await fetch(`${SP_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Spotify ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (!CLIENT_ID) return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not configured' });
  const state = Math.random().toString(36).slice(2, 10);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?spotify_error=${encodeURIComponent(error || 'access_denied')}`);
  }
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(),
      },
      body: new URLSearchParams({ code, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);
    const params = new URLSearchParams({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_in:    tokens.expires_in || 3600,
    });
    res.redirect(`${FRONTEND_URL}?${params}`);
  } catch (err) {
    console.error('Spotify callback error:', err.message);
    res.redirect(`${FRONTEND_URL}?spotify_error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
    });
    const data = await tokenRes.json();
    if (data.error) return res.status(401).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', (req, res) => {
  res.json({ configured: !!(CLIENT_ID && CLIENT_SECRET) });
});

// ── Proxy endpoints ───────────────────────────────────────────────────────────

router.get('/me', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Bearer token' });
  try {
    res.json(await spGet('/me', token));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/top-artists', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Bearer token' });
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    res.json(await spGet(`/me/top/artists?time_range=${time_range}&limit=${Math.min(Number(limit), 50)}`, token));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/top-tracks', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Bearer token' });
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    const tracks = await spGet(`/me/top/tracks?time_range=${time_range}&limit=${Math.min(Number(limit), 50)}`, token);
    const ids = tracks.items.map(t => t.id).join(',');
    let features = { audio_features: [] };
    if (ids) {
      try {
        features = await spGet(`/audio-features?ids=${ids}`, token);
      } catch (_) {}
    }
    const featureMap = {};
    for (const f of features.audio_features || []) {
      if (f) featureMap[f.id] = f;
    }
    tracks.items = tracks.items.map(t => ({ ...t, audio_features: featureMap[t.id] || null }));
    res.json(tracks);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/recently-played', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing Bearer token' });
  const { limit = 50 } = req.query;
  try {
    res.json(await spGet(`/me/player/recently-played?limit=${Math.min(Number(limit), 50)}`, token));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
