import { Router } from 'express';

const router = Router();

// ── Spotify client-credentials token cache ────────────────────────────────────
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
  if (!d.access_token) throw new Error('Spotify token fetch failed');
  spToken = d.access_token;
  spTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return spToken;
}

// ── Per-platform fetchers ─────────────────────────────────────────────────────

async function fetchSpotify(name) {
  const token = await getSpToken();
  const d = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const a = d.artists?.items?.[0];
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    followers: a.followers?.total || 0,
    popularity: a.popularity || 0,
    genres: a.genres || [],
    image: a.images?.[0]?.url || null,
    url: a.external_urls?.spotify || null,
  };
}

async function fetchLastfm(name) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(name)}&api_key=${process.env.LASTFM_KEY}&format=json`;
  const d = await fetch(url).then(r => r.json());
  if (d.error) return null;
  const a = d.artist;
  return {
    listeners: parseInt(a.stats?.listeners || 0),
    playcount: parseInt(a.stats?.playcount || 0),
    tags: (a.tags?.tag || []).map(t => t.name).slice(0, 5),
    bio: a.bio?.summary?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || '',
  };
}

async function fetchYoutube(name) {
  const key = process.env.YOUTUBE_KEY;
  const search = await fetch(
    `https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(name)}&type=channel&part=snippet&maxResults=1&key=${key}`
  ).then(r => r.json());
  const channelId = search.items?.[0]?.id?.channelId;
  if (!channelId) return null;
  const channel = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=statistics,snippet&key=${key}`
  ).then(r => r.json());
  const ch = channel.items?.[0];
  if (!ch) return null;
  return {
    channel_id: channelId,
    subscribers: parseInt(ch.statistics.subscriberCount || 0),
    total_views: parseInt(ch.statistics.viewCount || 0),
    video_count: parseInt(ch.statistics.videoCount || 0),
    url: `https://youtube.com/channel/${channelId}`,
  };
}

async function fetchSoundcloud(name) {
  const res = await fetch(
    `https://api.soundcloud.com/users?q=${encodeURIComponent(name)}&limit=1&client_id=${process.env.SOUNDCLOUD_CLIENT_ID}`,
    { headers: { Accept: 'application/json; charset=utf-8' } }
  );
  if (!res.ok) return null;
  const users = await res.json();
  const user = Array.isArray(users) ? users[0] : null;
  if (!user) return null;
  return {
    id: user.id,
    followers: user.followers_count || 0,
    track_count: user.track_count || 0,
    playback_count: user.playback_count || 0,
    url: user.permalink_url || null,
  };
}

// ── Aggregated endpoint ───────────────────────────────────────────────────────

router.get('/:name', async (req, res) => {
  const { name } = req.params;
  const [spR, lfR, ytR, scR] = await Promise.allSettled([
    fetchSpotify(name),
    fetchLastfm(name),
    fetchYoutube(name),
    fetchSoundcloud(name),
  ]);
  const sp = spR.value ?? null;
  const lf = lfR.value ?? null;
  const yt = ytR.value ?? null;
  const sc = scR.value ?? null;

  res.json({
    artist: sp?.name || name,
    image: sp?.image || null,
    aggregated: {
      total_followers: (sp?.followers || 0) + (sc?.followers || 0) + (yt?.subscribers || 0),
      spotify_followers: sp?.followers || 0,
      youtube_subscribers: yt?.subscribers || 0,
      soundcloud_followers: sc?.followers || 0,
      lastfm_listeners: lf?.listeners || 0,
      lastfm_playcount: lf?.playcount || 0,
      youtube_views: yt?.total_views || 0,
      soundcloud_plays: sc?.playback_count || 0,
    },
    spotify: sp,
    lastfm: lf,
    youtube: yt,
    soundcloud: sc,
  });
});

// ── Per-platform sub-routes ───────────────────────────────────────────────────

router.get('/:name/spotify',    async (req, res) => {
  try {
    const d = await fetchSpotify(req.params.name);
    d ? res.json(d) : res.status(404).json({ error: 'Not found on Spotify' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/lastfm',     async (req, res) => {
  try {
    const d = await fetchLastfm(req.params.name);
    d ? res.json(d) : res.status(404).json({ error: 'Not found on Last.fm' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/youtube',    async (req, res) => {
  try {
    const d = await fetchYoutube(req.params.name);
    d ? res.json(d) : res.status(404).json({ error: 'Not found on YouTube' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/soundcloud', async (req, res) => {
  try {
    const d = await fetchSoundcloud(req.params.name);
    d ? res.json(d) : res.status(404).json({ error: 'Not found on SoundCloud' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
