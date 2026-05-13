import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import spotifyRouter    from './routes/spotify.js';
import lastfmRouter     from './routes/lastfm.js';
import youtubeRouter    from './routes/youtube.js';
import soundcloudRouter from './routes/soundcloud.js';
import artistRouter     from './routes/artist.js';
import chartsRouter     from './routes/charts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DIGITIZER_URL = process.env.DIGITIZER_URL || 'http://localhost:3001';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use('/spotify',         spotifyRouter);
app.use('/api/lastfm',      lastfmRouter);
app.use('/api/youtube',     youtubeRouter);
app.use('/api/soundcloud',  soundcloudRouter);
app.use('/api/artist',      artistRouter);
app.use('/api/charts',      chartsRouter);

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
