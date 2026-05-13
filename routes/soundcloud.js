import { Router } from 'express';

const router = Router();
const BASE = 'https://api.soundcloud.com';

async function scGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('client_id', process.env.SOUNDCLOUD_CLIENT_ID || '');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: 'application/json; charset=utf-8' } });
  if (!res.ok) throw new Error(`SoundCloud ${res.status}: ${await res.text()}`);
  return res.json();
}

router.get('/:artist', async (req, res) => {
  const { artist } = req.params;
  try {
    const users = await scGet('/users', { q: artist, limit: 1 });
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.status(404).json({ error: 'Artist not found', artist });

    const tracks = await scGet(`/users/${user.id}/tracks`, { limit: 10 }).catch(() => []);

    res.json({
      id: user.id,
      name: user.username,
      followers: user.followers_count || 0,
      following: user.followings_count || 0,
      track_count: user.track_count || 0,
      playback_count: user.playback_count || 0,
      likes_count: user.likes_count || 0,
      description: user.description?.slice(0, 300) || '',
      avatar: user.avatar_url || null,
      url: user.permalink_url || null,
      top_tracks: (tracks || []).map(t => ({
        id: t.id,
        title: t.title,
        plays: t.playback_count || 0,
        likes: t.likes_count || 0,
        duration_ms: t.duration || 0,
        genre: t.genre || null,
        url: t.permalink_url || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
