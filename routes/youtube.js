import { Router } from 'express';

const router = Router();
const BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('key', process.env.YOUTUBE_KEY || '');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube ${res.status}: ${await res.text()}`);
  return res.json();
}

router.get('/:artist', async (req, res) => {
  const { artist } = req.params;
  try {
    const search = await ytGet('/search', { q: artist, type: 'channel', part: 'snippet', maxResults: 1 });
    const channelId = search.items?.[0]?.id?.channelId;
    if (!channelId) return res.status(404).json({ error: 'Channel not found', artist });

    const [channelRes, videosRes] = await Promise.all([
      ytGet('/channels', { id: channelId, part: 'statistics,snippet' }),
      ytGet('/search', { channelId, type: 'video', part: 'snippet', order: 'date', maxResults: 5 }),
    ]);

    const ch = channelRes.items?.[0];
    if (!ch) return res.status(404).json({ error: 'Channel data unavailable' });

    res.json({
      channel_id: channelId,
      name: ch.snippet.title,
      description: ch.snippet.description?.slice(0, 300) || '',
      subscribers: parseInt(ch.statistics.subscriberCount || 0),
      total_views: parseInt(ch.statistics.viewCount || 0),
      video_count: parseInt(ch.statistics.videoCount || 0),
      thumbnail: ch.snippet.thumbnails?.high?.url || null,
      url: `https://youtube.com/channel/${channelId}`,
      recent_videos: (videosRes.items || []).map(v => ({
        id: v.id.videoId,
        title: v.snippet.title,
        published: v.snippet.publishedAt,
        thumbnail: v.snippet.thumbnails?.medium?.url || null,
        url: `https://youtube.com/watch?v=${v.id.videoId}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
