import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DIGITIZER_URL = process.env.DIGITIZER_URL || 'http://localhost:3001';

// Proxy /digitizer/* → digitizer microservice
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

// Serve Vite build output in production
const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => res.sendFile(join(distPath, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({ status: 'ok', note: 'Run npm run build to serve frontend' }));
}

app.listen(PORT, () => console.log(`Main server on port ${PORT}, proxying digitizer → ${DIGITIZER_URL}`));
