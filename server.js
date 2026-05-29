import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import spotifyRouter    from './routes/spotify.js';
import lastfmRouter     from './routes/lastfm.js';
import youtubeRouter    from './routes/youtube.js';
import soundcloudRouter from './routes/soundcloud.js';
import artistRouter     from './routes/artist.js';
import chartsRouter     from './routes/charts.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DIGITIZER_URL = process.env.DIGITIZER_URL || 'http://localhost:8081';

// ── Spotify Client Credentials ────────────────────────────────────────────────
let _spotifyToken = null;
let _spotifyTokenExpiresAt = 0;

async function getClientToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiresAt) return _spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  _spotifyToken = data.access_token;
  _spotifyTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return _spotifyToken;
}

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

// ── Spotify Client Credentials proxy ─────────────────────────────────────────
app.get('/api/spotify', async (req, res) => {
  const { path: spPath, ...query } = req.query;
  if (!spPath) return res.status(400).json({ error: 'Missing required query param: path' });
  try {
    const token = await getClientToken();
    const qs = new URLSearchParams(query).toString();
    const url = `https://api.spotify.com/v1/${spPath}${qs ? `?${qs}` : ''}`;
    const spRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await spRes.json();
    res.status(spRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

const KINGZ_LISTEN_SOURCE_ID = 'KINGZ_LISTEN_PLUGIN';
const KINGZ_LISTEN_WEB_SOURCE_ID = 'kingz-listen-web';
const MIXREVIEW_SOURCE_IDS = new Set(['mixreview', 'mixreview-web', 'mixreview-api']);

const telemetryState = {
  kingzListen: new Map(),
  kingzListenReceivers: new Map(),
  mixReview: new Map(),
};

function createTelemetrySession(req) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sourceId: null,
    remoteAddress: req.socket.remoteAddress,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

function validateKingzListenTelemetry(message) {
  if (message.source_id !== KINGZ_LISTEN_SOURCE_ID) {
    return 'Kingz Listen telemetry requires source_id=KINGZ_LISTEN_PLUGIN';
  }

  if (typeof message.type !== 'string' || message.type.length === 0) {
    return 'Kingz Listen telemetry requires a string type';
  }

  if (message.type === 'registration') {
    return null;
  }

  if (message.type === 'telemetry.report') {
    const numericFields = ['activeClientCount', 'bufferHealth', 'latencyMs'];
    for (const field of numericFields) {
      if (typeof message[field] !== 'number' || Number.isNaN(message[field])) {
        return `Kingz Listen telemetry.report requires numeric ${field}`;
      }
    }
    return null;
  }

  if (message.type === 'webrtc-answer' || message.type === 'webrtc-candidate') {
    if (typeof message.sdp !== 'string' && message.type === 'webrtc-answer') {
      return 'Kingz Listen webrtc-answer requires string sdp';
    }
    if (message.type === 'webrtc-candidate' && message.candidate == null) {
      return 'Kingz Listen webrtc-candidate requires candidate';
    }
    return null;
  }

  if (message.type.startsWith('webrtc.') || message.type === 'pong') {
    return null;
  }

  return `Unsupported Kingz Listen telemetry type: ${message.type}`;
}

function validateMixReviewTelemetry(message) {
  if (!MIXREVIEW_SOURCE_IDS.has(message.source_id)) {
    return 'MixReview telemetry source_id is not recognized';
  }

  if (typeof message.type !== 'string' || message.type.length === 0) {
    return 'MixReview telemetry requires a string type';
  }

  if (!message.type.startsWith('mixreview.')) {
    return 'MixReview telemetry type must use the mixreview.* namespace';
  }

  return null;
}

function validateKingzListenReceiverSignal(message) {
  if (message.source_id !== KINGZ_LISTEN_WEB_SOURCE_ID) {
    return 'Kingz Listen receiver signaling requires source_id=kingz-listen-web';
  }

  if (message.type === 'receiver.hello') {
    return null;
  }

  if (message.type === 'webrtc-offer') {
    if (typeof message.sdp !== 'string' || message.sdp.length === 0) {
      return 'Kingz Listen webrtc-offer requires string sdp';
    }
    return null;
  }

  if (message.type === 'webrtc-candidate') {
    if (message.candidate == null) {
      return 'Kingz Listen webrtc-candidate requires candidate';
    }
    return null;
  }

  return `Unsupported Kingz Listen receiver signal type: ${message.type}`;
}

function sendJsonIfOpen(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function forwardToKingzListenPlugin(payload) {
  for (const entry of telemetryState.kingzListen.values()) {
    if (sendJsonIfOpen(entry.ws, payload)) return true;
  }
  return false;
}

function forwardToKingzListenReceivers(payload) {
  let delivered = 0;
  const signalId = payload.signal_id;

  for (const entry of telemetryState.kingzListenReceivers.values()) {
    if (signalId && entry.signalId && signalId !== entry.signalId) continue;
    if (sendJsonIfOpen(entry.ws, payload)) delivered += 1;
  }

  return delivered;
}

function routeTelemetryMessage(ws, session, message) {
  const sourceId = message?.source_id;

  if (sourceId === KINGZ_LISTEN_SOURCE_ID) {
    const validationError = validateKingzListenTelemetry(message);
    if (validationError) return { ok: false, error: validationError };

    if (session.sourceId !== KINGZ_LISTEN_SOURCE_ID && message.type !== 'registration') {
      return {
        ok: false,
        error: 'Kingz Listen plugin must send registration before telemetry or signaling',
      };
    }

    session.sourceId = KINGZ_LISTEN_SOURCE_ID;
    session.lastSeenAt = Date.now();
    telemetryState.kingzListen.set(session.id, {
      session,
      ws,
      lastMessage: message,
    });

    if (message.type === 'webrtc-answer' || message.type === 'webrtc-candidate') {
      const delivered = forwardToKingzListenReceivers(message);
      console.log('[Kingz Listen] Forwarded plugin signal to receiver(s):', {
        type: message.type,
        delivered,
        signalId: message.signal_id,
      });
      return { ok: true, source: 'kingzListen' };
    }

    if (message.type === 'registration') {
      ws.send(JSON.stringify({
        type: 'server.confirm',
        source_id: KINGZ_LISTEN_SOURCE_ID,
        status: 'connected',
        message: 'Kingz Listen telemetry route connected',
      }));
    }

    console.log('[Kingz Listen] Telemetry accepted:', {
      sessionId: session.id,
      type: message.type,
      remoteAddress: session.remoteAddress,
    });
    return { ok: true, source: 'kingzListen' };
  }

  if (sourceId === KINGZ_LISTEN_WEB_SOURCE_ID) {
    const validationError = validateKingzListenReceiverSignal(message);
    if (validationError) return { ok: false, error: validationError };

    session.sourceId = KINGZ_LISTEN_WEB_SOURCE_ID;
    session.lastSeenAt = Date.now();
    telemetryState.kingzListenReceivers.set(session.id, {
      session,
      ws,
      signalId: message.signal_id,
      lastMessage: message,
    });

    if (message.type === 'receiver.hello') {
      ws.send(JSON.stringify({
        type: 'server.confirm',
        source_id: KINGZ_LISTEN_WEB_SOURCE_ID,
        status: 'connected',
        message: 'Kingz Listen receiver route connected',
      }));
      return { ok: true, source: 'kingzListenReceiver' };
    }

    const delivered = forwardToKingzListenPlugin(message);
    if (!delivered) {
      return { ok: false, error: 'No Kingz Listen plugin sender is connected' };
    }

    console.log('[Kingz Listen] Forwarded receiver signal to plugin:', {
      sessionId: session.id,
      type: message.type,
      signalId: message.signal_id,
      remoteAddress: session.remoteAddress,
    });
    return { ok: true, source: 'kingzListenReceiver' };
  }

  if (MIXREVIEW_SOURCE_IDS.has(sourceId)) {
    const validationError = validateMixReviewTelemetry(message);
    if (validationError) return { ok: false, error: validationError };

    session.sourceId = sourceId;
    session.lastSeenAt = Date.now();
    telemetryState.mixReview.set(session.id, {
      session,
      ws,
      lastMessage: message,
    });

    console.log('[MixReview] Telemetry accepted:', {
      sessionId: session.id,
      sourceId,
      type: message.type,
      remoteAddress: session.remoteAddress,
    });
    return { ok: true, source: 'mixReview' };
  }

  return { ok: false, error: 'Missing or unsupported telemetry source_id' };
}

function removeTelemetrySession(session) {
  if (session.sourceId === KINGZ_LISTEN_SOURCE_ID) {
    telemetryState.kingzListen.delete(session.id);
    return;
  }

  if (session.sourceId === KINGZ_LISTEN_WEB_SOURCE_ID) {
    telemetryState.kingzListenReceivers.delete(session.id);
    return;
  }

  if (MIXREVIEW_SOURCE_IDS.has(session.sourceId)) {
    telemetryState.mixReview.delete(session.id);
  }
}

// New WebSocket Server for Plugin Telemetry
const wss = new WebSocket.Server({ port: 8081, host: '0.0.0.0' });

wss.on('connection', (ws, req) => {
    const session = createTelemetrySession(req);
    console.log('--- Handshake initiated from:', req.socket.remoteAddress, '---');
    
    ws.on('message', (data) => {
        try {
            const messageString = data.toString();
            const json = JSON.parse(messageString);

            const routeResult = routeTelemetryMessage(ws, session, json);
            if (!routeResult.ok) {
                console.warn('[Telemetry] Rejected packet:', routeResult.error);
                ws.send(JSON.stringify({
                    type: 'server.error',
                    source_id: json?.source_id ?? 'unknown',
                    error: routeResult.error,
                }));
                return;
            }
        } catch (e) {
            console.log('Raw data received (non-JSON):', data.toString());
            ws.send(JSON.stringify({
                type: 'server.error',
                source_id: 'unknown',
                error: 'Telemetry payload must be valid JSON',
            }));
        }
    });

    ws.on('close', (code, reason) => {
        removeTelemetrySession(session);
        console.log('Connection closed. Code:', code, 'Reason:', reason);
    });

    ws.on('error', (error) => {
        console.error('WebSocket connection error:', error);
    });
});

console.log('WebSocket server is active and waiting for a handshake on port 8081');
