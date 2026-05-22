class AudioEngine {
  constructor({
    sampleRate = 48000,
    bitDepth = 16,
    channels = 2,
    chunkDurationMs = 20,
  } = {}) {
    this.format = {
      sampleRate,
      bitDepth,
      channels,
      chunkDurationMs,
      encoding: 'pcm16le',
    };
    this.modeConfigs = {
      lowLatency: {
        id: 'lowLatency',
        label: 'Low Latency',
        targetBufferMs: 40,
        safeBufferMs: 80,
        adaptive: true,
      },
      balanced: {
        id: 'balanced',
        label: 'Balanced',
        targetBufferMs: 80,
        safeBufferMs: 140,
        adaptive: true,
      },
      safeBuffer: {
        id: 'safeBuffer',
        label: 'Safe Buffer',
        targetBufferMs: 160,
        safeBufferMs: 240,
        adaptive: false,
      },
    };
    this.lifecycle = 'reset';
    this.sessionConfig = this.modeConfigs.balanced;
  }

  configureFormat(format) {
    this.format = {
      ...this.format,
      ...format,
    };
    return this.snapshot();
  }

  prepare(mode = 'balanced') {
    this.sessionConfig = this.modeConfigs[mode] || this.modeConfigs.balanced;
    this.lifecycle = 'prepared';
    return this.snapshot();
  }

  start() {
    this.lifecycle = 'started';
    return this.snapshot();
  }

  pause() {
    this.lifecycle = 'paused';
    return this.snapshot();
  }

  stop() {
    this.lifecycle = 'stopped';
    return this.snapshot();
  }

  reset() {
    this.lifecycle = 'reset';
    return this.snapshot();
  }

  chunkDescriptor(sequenceNumber, timestamp) {
    return {
      ...this.format,
      sequenceNumber,
      timestamp,
    };
  }

  snapshot() {
    return {
      lifecycle: this.lifecycle,
      format: this.format,
      sessionConfig: this.sessionConfig,
      availableModes: Object.values(this.modeConfigs),
    };
  }
}

module.exports = { AudioEngine };
