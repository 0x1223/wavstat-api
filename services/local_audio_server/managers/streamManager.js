const { performance } = require('node:perf_hooks');
const { WavPcmSource } = require('./wavPcmSource');

class StreamManager {
  constructor({
    audioFile,
    clientManager,
    audioEngine,
    pcmSimulationManager,
    intervalMs = 20,
  }) {
    this.audioFile = audioFile;
    this.clientManager = clientManager;
    this.audioEngine = audioEngine;
    this.pcmSimulationManager = pcmSimulationManager;
    this.intervalMs = intervalMs;
    this.source = new WavPcmSource(audioFile, intervalMs);
    this.chunkBytes = 0;
    this.audioBuffer = Buffer.alloc(0);
    this.sessionId = this.createSessionId();
    this.sequence = 0;
    this.offset = 0;
    this.timer = null;
    this.nextTickAt = 0;
    this.lastTickAt = 0;
    this.intervals = [];
    this.pacingDriftMs = 0;
    this.maxTimingSamples = 64;
    this.httpStreams = new Set();
    this.pendingDelayTimers = new Set();
  }

  load() {
    this.source.load();
    this.audioBuffer = this.source.buffer;
    this.chunkBytes = this.source.chunkBytes();
    this.audioEngine.configureFormat(this.source.format);
    this.audioEngine.prepare();
  }

  prepareClient(client, mode) {
    client.streamMode = mode || client.streamMode || 'balanced';
    return this.audioEngine.prepare(client.streamMode);
  }

  startClient(client, mode) {
    this.prepareClient(client, mode);
    client.isListening = true;
    if (!this.timer) {
      this.sessionId = this.createSessionId();
      this.sequence = 0;
      this.offset = this.source.dataOffset;
      this.resetTiming();
      this.audioEngine.start();
      this.scheduleNextTick();
    }
    console.log(
      `stream started client=${client.id} ip=${client.remoteAddress || 'unknown'}`,
    );
    return this.audioEngine.snapshot();
  }

  pauseClient(client) {
    if (client.isListening) {
      client.isListening = false;
      this.stopLoopIfIdle();
    }

    return this.audioEngine.pause();
  }

  stopClient(client) {
    if (!client.isListening) {
      return this.audioEngine.snapshot();
    }

    client.isListening = false;
    console.log(`stream stopped ${client.id}`);
    const engineState = this.clientManager.listeningClients().length === 0
      ? this.audioEngine.stop()
      : this.audioEngine.snapshot();
    this.stopLoopIfIdle();
    return engineState;
  }

  reset() {
    for (const client of this.clientManager.values()) {
      client.isListening = false;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearPendingDelayTimers();

    this.sequence = 0;
    this.offset = this.source.dataOffset;
    this.resetTiming();
    return this.audioEngine.reset();
  }

  startHttpStream(remoteAddress) {
    const streamId = this.createSessionId();
    this.httpStreams.add(streamId);
    console.log(`stream started ${remoteAddress || 'unknown'}`);
    return streamId;
  }

  stopHttpStream(streamId, remoteAddress) {
    if (!this.httpStreams.has(streamId)) {
      return;
    }

    this.httpStreams.delete(streamId);
    console.log(`stream stopped ${remoteAddress || 'unknown'}`);
  }

  activeStreamCount() {
    return this.clientManager.listeningClients().length + this.httpStreams.size;
  }

  tick() {
    const now = performance.now();
    if (this.lastTickAt > 0) {
      this.recordInterval(now - this.lastTickAt);
    }
    this.lastTickAt = now;
    this.pacingDriftMs = Math.max(0, now - this.nextTickAt);

    const clients = this.clientManager.listeningClients();
    if (clients.length === 0) {
      this.stopLoopIfIdle();
      return;
    }

    if (this.offset >= this.source.dataOffset + this.source.dataSize) {
      this.offset = this.source.dataOffset;
    }

    const { chunk, end } = this.source.slice(this.offset);
    const timestamp = Date.now();
    const pcm = this.audioEngine.chunkDescriptor(this.sequence, timestamp);
    const timing = this.diagnostics();
    const simulation = this.pcmSimulationManager.decorate({
      sequence: this.sequence,
      chunk,
      pcm,
      timing,
    });
    simulation.diagnostics.chunksSent = this.sequence;

    if (simulation.shouldDrop) {
      this.sequence += 1;
      this.offset = end;
      this.nextTickAt += this.intervalMs;
      this.scheduleNextTick();
      return;
    }

    if (simulation.temporaryDisconnect) {
      for (const client of clients) {
        client.socket.close(1012, 'simulated transport recovery');
      }
      this.sequence += 1;
      this.offset = end;
      this.nextTickAt += this.intervalMs;
      this.scheduleNextTick();
      return;
    }

    const payload = {
      type: 'realtime.pcm.chunk',
      streamSessionId: this.sessionId,
      sequence: this.sequence,
      sequenceNumber: this.sequence,
      serverClock: timestamp,
      timestamp,
      byteOffset: this.offset,
      byteLength: chunk.length,
      payloadSize: chunk.length,
      intervalMs: this.intervalMs,
      pcm,
      simulation: simulation.packet,
      simulationDiagnostics: simulation.diagnostics,
      engine: this.audioEngine.snapshot(),
      timing,
      transport: 'real-pcm-websocket-prototype',
      payload: chunk.toString('base64'),
    };

    this.broadcastPayload(clients, payload, simulation.sendDelayMs);

    this.sequence += 1;
    this.offset = end;
    this.nextTickAt += this.intervalMs;
    this.scheduleNextTick();
  }

  broadcastPayload(clients, payload, delayMs) {
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.pendingDelayTimers.delete(timer);
        for (const client of clients) {
          this.sendPcmChunk(client, payload);
        }
      }, delayMs);
      this.pendingDelayTimers.add(timer);
      return;
    }

    for (const client of clients) {
      this.sendPcmChunk(client, payload);
    }

    if (payload.simulation.packetBurst) {
      for (const client of clients) {
        this.clientManager.send(client, {
          ...payload,
          type: 'realtime.audio.burst',
          burstSourceSequence: payload.sequence,
        });
      }
    }
  }

  sendPcmChunk(client, payload) {
    const sent = this.clientManager.send(client, payload);
    if (!sent) {
      return;
    }

    client.pcmChunksSent = (client.pcmChunksSent || 0) + 1;
  }

  stopLoopIfIdle() {
    if (this.clientManager.listeningClients().length > 0 || !this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = null;
    this.clearPendingDelayTimers();
  }

  clearPendingDelayTimers() {
    for (const timer of this.pendingDelayTimers) {
      clearTimeout(timer);
    }
    this.pendingDelayTimers.clear();
  }

  scheduleNextTick() {
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = setTimeout(() => this.tick(), delay);
  }

  resetTiming() {
    const now = performance.now();
    this.nextTickAt = now + this.intervalMs;
    this.lastTickAt = 0;
    this.intervals = [];
    this.pacingDriftMs = 0;
  }

  recordInterval(interval) {
    this.intervals.push(interval);
    if (this.intervals.length > this.maxTimingSamples) {
      this.intervals.shift();
    }
  }

  diagnostics() {
    if (this.intervals.length === 0) {
      return {
        averageSendIntervalMs: this.intervalMs,
        jitterMs: 0,
        pacingConsistency: 'Priming',
        pacingDriftMs: Math.round(this.pacingDriftMs),
      };
    }

    const average =
      this.intervals.reduce((total, interval) => total + interval, 0) /
      this.intervals.length;
    const min = Math.min(...this.intervals);
    const max = Math.max(...this.intervals);
    const jitter = max - min;

    return {
      averageSendIntervalMs: Math.round(average),
      jitterMs: Math.round(jitter),
      pacingConsistency: this.pacingConsistency(jitter),
      pacingDriftMs: Math.round(this.pacingDriftMs),
    };
  }

  pacingConsistency(jitter) {
    if (jitter <= 4) {
      return 'Tight';
    }

    if (jitter <= 10) {
      return 'Stable';
    }

    return 'Variable';
  }

  createSessionId() {
    return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

module.exports = { StreamManager };
