import { Router } from 'express';

const router = Router();

let _token = null;
let _expiry = 0;

async function getToken() {
  if (_token && Date.now() < _expiry) return _token;
  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || 'Token failed');
  _token = data.access_token;
  _expiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

router.get('/search', async (req, res) => {
  try {
    const token = await getToken();
    const { q, type = 'artist', limit = 5 } = req.query;
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`;
    const data = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
