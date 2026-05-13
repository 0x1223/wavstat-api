import { Router } from 'express';

const router = Router();

// Spotify editorial chart playlist IDs
const PLAYLISTS = {
  global: '37i9dQZEVXbMDoHDwVN2tF',
  us:     '37i9dQZEVXbLRQDuF5jeBp',
  viral:  '37i9dQZEVXbLiRSasKsNU9',  // Viral 50 Global
};

// ── Spotify client-credentials token (shared cache) ───────────────────────────
let spToken = null;
let spTokenExpiry = 0;

async function getSpToken() {
  if (spToken && Date.now() < spTokenExpiry) return spToken;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Spotify token error: ${JSON.stringify(d)}`);
  spToken = d.access_token;
  spTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return spToken;
}

async function spGet(path) {
  const token = await getSpToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify ${res.status}: ${text}`);
  }
  return res.json();
}

// ── GET /api/charts/spotify?chart=global|us|viral ─────────────────────────────
router.get('/spotify', async (req, res) => {
  const chart = req.query.chart || 'global';
  const playlistId = PLAYLISTS[chart] || PLAYLISTS.global;

  try {
    const fields = 'name,external_urls,images,items(track(id,name,popularity,duration_ms,external_urls,artists(id,name),album(id,name,images)))';
    const data = await spGet(`/playlists/${playlistId}?fields=${encodeURIComponent(fields)}&limit=50`);

    const tracks = (data.items || [])
      .map((item, idx) => {
        const t = item?.track;
        if (!t || t.id === null) return null;
        return {
          rank:       idx + 1,
          id:         t.id,
          title:      t.name,
          artists:    (t.artists || []).map(a => ({ id: a.id, name: a.name })),
          artist:     (t.artists || []).map(a => a.name).join(', '),
          album:      t.album?.name || '',
          cover:      t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
          popularity: t.popularity || 0,
          duration_ms: t.duration_ms || 0,
          url:        t.external_urls?.spotify || null,
        };
      })
      .filter(Boolean);

    res.json({
      chart,
      playlist_name: data.name || `Top 50 ${chart}`,
      playlist_url:  data.external_urls?.spotify || null,
      updated_at:    new Date().toISOString(),
      tracks,
    });
  } catch (err) {
    console.error('[charts/spotify]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/charts/new-releases ──────────────────────────────────────────────
router.get('/new-releases', async (req, res) => {
  try {
    const data = await spGet('/browse/new-releases?limit=20&country=US');
    const albums = (data.albums?.items || []).map((a, idx) => ({
      rank:    idx + 1,
      id:      a.id,
      title:   a.name,
      artist:  (a.artists || []).map(x => x.name).join(', '),
      cover:   a.images?.[1]?.url || a.images?.[0]?.url || null,
      type:    a.album_type,
      released: a.release_date,
      url:     a.external_urls?.spotify || null,
    }));
    res.json({ albums });
  } catch (err) {
    console.error('[charts/new-releases]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
