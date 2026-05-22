class TelemetryManager {
  constructor({ clientManager, streamManager }) {
    this.clientManager = clientManager;
    this.streamManager = streamManager;
  }

  build(client) {
    const activeStreams = this.streamManager.activeStreamCount();
    const isStreaming = client.isListening || activeStreams > 0;
    const timing = this.streamManager.diagnostics();

    return {
      type: 'stream.telemetry',
      buffer: isStreaming ? 'Adaptive buffer armed' : 'Ready',
      network: client.isAlive
        ? isStreaming
          ? 'Realtime transport active'
          : 'LAN stable'
        : 'Reconnecting',
      droppedPackets: client.droppedPackets,
      latency: isStreaming ? `${timing.averageSendIntervalMs} ms cadence` : '-- ms',
      activeStreams,
      quality: isStreaming ? timing.pacingConsistency : 'Idle',
      timing,
      engine: this.streamManager.audioEngine.snapshot(),
      simulation: this.streamManager.pcmSimulationManager.diagnostics(),
    };
  }
}

module.exports = { TelemetryManager };
