import { Router } from 'express';

const router = Router();
const BASE = 'https://ws.audioscrobbler.com/2.0/';

async function lfm(method, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', process.env.LASTFM_KEY || '');
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Last.fm ${res.status}`);
  return res.json();
}

router.get('/:artist', async (req, res) => {
  const { artist } = req.params;
  try {
    const [info, top] = await Promise.all([
      lfm('artist.getinfo', { artist }),
      lfm('artist.gettoptracks', { artist, limit: 10 }),
    ]);
    if (info.error) return res.status(404).json({ error: info.message });
    const a = info.artist;
    res.json({
      name: a.name,
      listeners: parseInt(a.stats?.listeners || 0),
      playcount: parseInt(a.stats?.playcount || 0),
      bio: a.bio?.summary?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) || '',
      tags: (a.tags?.tag || []).map(t => t.name),
      image: a.image?.find(i => i.size === 'extralarge')?.['#text'] || null,
      url: a.url,
      top_tracks: (top.toptracks?.track || []).map(t => ({
        name: t.name,
        playcount: parseInt(t.playcount || 0),
        listeners: parseInt(t.listeners || 0),
        url: t.url,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
