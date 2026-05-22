const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { AudioEngine } = require('./managers/audioEngine');
const { ClientManager } = require('./managers/clientManager');
const { PcmSimulationManager } = require('./managers/pcmSimulationManager');
const { StreamManager } = require('./managers/streamManager');
const { TelemetryManager } = require('./managers/telemetryManager');

const PORT = Number(process.env.PORT || 8080);
const HEARTBEAT_MS = 2500;
const TELEMETRY_MS = 650;
const AUDIO_FILE = path.join(__dirname, 'audio', 'test.wav');
const AUDIO_METADATA = {
  title: 'Studio Session',
  engineer: 'KINGZ Studio',
  codec: 'PCM WAV',
  sampleRate: 48000,
  bitDepth: 16,
  channels: 2,
  duration: '--:--',
};

const clientManager = new ClientManager();
const audioEngine = new AudioEngine();
const pcmSimulationManager = new PcmSimulationManager();
const streamManager = new StreamManager({
  audioFile: AUDIO_FILE,
  clientManager,
  audioEngine,
  pcmSimulationManager,
});
const telemetryManager = new TelemetryManager({
  clientManager,
  streamManager,
});

streamManager.load();

function getBaseUrl(request) {
  const host = request.headers.host || `127.0.0.1:${PORT}`;
  return `http://${host}`;
}

function buildStreamPayload(request) {
  const baseUrl = getBaseUrl(request);

  return {
    streamUrl: `${baseUrl}/stream`,
    audioUrl: `${baseUrl}/audio/test.wav`,
    metadataUrl: `${baseUrl}/metadata`,
    realtime: {
      transport: 'real-pcm-websocket-prototype',
      chunkMs: streamManager.intervalMs,
      chunkBytes: streamManager.chunkBytes,
      underrunSimulation: pcmSimulationManager.diagnostics().stressMode !== 'baseline',
    },
    engine: audioEngine.snapshot(),
    simulation: pcmSimulationManager.diagnostics(),
    metadata: AUDIO_METADATA,
  };
}

function sendAudioFile(request, response, options = {}) {
  fs.stat(AUDIO_FILE, (statError, stats) => {
    if (statError) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'audio_file_missing' }));
      return;
    }

    const remoteAddress = request.socket.remoteAddress;
    const streamId = options.trackStream
      ? streamManager.startHttpStream(remoteAddress)
      : null;
    const finishStream = () => {
      if (streamId) {
        streamManager.stopHttpStream(streamId, remoteAddress);
      }
    };

    response.on('close', finishStream);
    response.on('finish', finishStream);

    const range = request.headers.range;
    if (range) {
      const [startText, endText] = range.replace('bytes=', '').split('-');
      const start = Number.parseInt(startText, 10);
      const requestedEnd = endText ? Number.parseInt(endText, 10) : stats.size - 1;
      const end = Math.min(requestedEnd, stats.size - 1);

      if (Number.isNaN(start) || Number.isNaN(requestedEnd) || start >= stats.size) {
        response.writeHead(416, {
          'content-range': `bytes */${stats.size}`,
          'accept-ranges': 'bytes',
        });
        response.end();
        return;
      }

      response.writeHead(206, {
        'content-type': 'audio/wav',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stats.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      fs.createReadStream(AUDIO_FILE, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': stats.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    fs.createReadStream(AUDIO_FILE).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,HEAD,OPTIONS');
  response.setHeader('access-control-allow-headers', 'range,content-type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        service: 'kingz-local-audio-server',
        listeners: clientManager.size,
        activeStreams: streamManager.activeStreamCount(),
      }),
    );
    return;
  }

  if (request.url === '/metadata') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(buildStreamPayload(request)));
    return;
  }

  if (request.url === '/audio/test.wav') {
    sendAudioFile(request, response);
    return;
  }

  if (request.url === '/stream') {
    sendAudioFile(request, response, { trackStream: true });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket, request) => {
  const client = clientManager.add(socket, request, randomId());

  clientManager.send(client, {
    ...clientManager.connectionStatus(),
    clientId: client.id,
    ...buildStreamPayload(request),
  });
  clientManager.send(client, {
    type: 'stream.status',
    status: 'connected',
    buffer: 'Ready',
    network: 'LAN connected',
    droppedPackets: 0,
    latency: '-- ms',
  });
  clientManager.broadcast(clientManager.connectionStatus());

  socket.on('pong', () => {
    client.isAlive = true;
  });

  socket.on('message', (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      clientManager.send(client, { type: 'error', message: 'Invalid JSON message' });
      return;
    }

    if (message.type === 'client.ping') {
      clientManager.send(client, { type: 'pong', sentAt: message.sentAt });
      return;
    }

    if (message.type === 'listen.start') {
      const engineState = streamManager.startClient(client, message.mode);
      clientManager.send(client, {
        type: 'stream.status',
        status: 'buffering',
        buffer: 'Adaptive buffer priming',
        network: 'Realtime transport active',
        droppedPackets: client.droppedPackets,
        latency: '-- ms',
        streamSessionId: streamManager.sessionId,
        engine: engineState,
        ...buildStreamPayload(request),
      });
      return;
    }

    if (message.type === 'listen.prepare') {
      const engineState = streamManager.prepareClient(client, message.mode);
      clientManager.send(client, {
        type: 'engine.status',
        status: 'prepared',
        engine: engineState,
      });
      return;
    }

    if (message.type === 'listen.pause') {
      const engineState = streamManager.pauseClient(client);
      clientManager.send(client, {
        type: 'engine.status',
        status: 'paused',
        engine: engineState,
      });
      return;
    }

    if (message.type === 'listen.stop') {
      const engineState = streamManager.stopClient(client);
      clientManager.send(client, {
        type: 'stream.status',
        status: 'stopped',
        buffer: 'Ready',
        network: 'LAN connected',
        droppedPackets: client.droppedPackets,
        latency: '-- ms',
        engine: engineState,
      });
      return;
    }

    if (message.type === 'listen.reset') {
      const engineState = streamManager.reset();
      clientManager.send(client, {
        type: 'engine.status',
        status: 'reset',
        engine: engineState,
      });
      return;
    }

    if (message.type === 'simulation.set') {
      const diagnostics = pcmSimulationManager.setMode(message.mode);
      clientManager.send(client, {
        type: 'simulation.status',
        status: 'updated',
        simulation: diagnostics,
      });
    }
  });

  socket.on('close', () => {
    streamManager.stopClient(client);
    clientManager.remove(client.id);
    clientManager.broadcast(clientManager.connectionStatus());
  });
});

setInterval(() => {
  for (const client of clientManager.values()) {
    if (!client.isAlive) {
      client.droppedPackets += 1;
      streamManager.stopClient(client);
      client.socket.terminate();
      clientManager.remove(client.id);
      continue;
    }

    client.isAlive = false;
    client.socket.ping();
    clientManager.send(client, { type: 'server.ping', sentAt: Date.now() });
  }

  clientManager.broadcast(clientManager.connectionStatus());
}, HEARTBEAT_MS);

setInterval(() => {
  for (const client of clientManager.values()) {
    clientManager.send(client, telemetryManager.build(client));
  }
}, TELEMETRY_MS);

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = detectLanIp();
  console.log(`KINGZ local audio server listening on 0.0.0.0:${PORT}`);
  console.log(`localhost: http://localhost:${PORT}`);
  console.log(`detected LAN IP: ${lanIp}`);
  console.log(`LAN: http://${lanIp}:${PORT}`);
  console.log(`WebSocket: ws://${lanIp}:${PORT}`);
});

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return '127.0.0.1';
}
