class PcmSimulationManager {
  constructor({
    packetLossEvery = 97,
    delayedPacketEvery = 41,
    underrunEvery = 131,
    delayMs = 34,
  } = {}) {
    this.modes = {
      baseline: {
        id: 'baseline',
        packetLossEvery: 0,
        delayedPacketEvery: 0,
        underrunEvery: 0,
        latencySpikeEvery: 0,
        packetBurstEvery: 0,
        temporaryDisconnectEvery: 0,
        adaptiveSwitchEvery: 0,
        delayMs: 0,
        spikeDelayMs: 0,
      },
      stress: {
        id: 'stress',
        packetLossEvery: 47,
        delayedPacketEvery: 19,
        underrunEvery: 73,
        latencySpikeEvery: 29,
        packetBurstEvery: 37,
        temporaryDisconnectEvery: 151,
        adaptiveSwitchEvery: 67,
        delayMs: 42,
        spikeDelayMs: 140,
      },
      recovery: {
        id: 'recovery',
        packetLossEvery: 59,
        delayedPacketEvery: 23,
        underrunEvery: 89,
        latencySpikeEvery: 31,
        packetBurstEvery: 43,
        temporaryDisconnectEvery: 0,
        adaptiveSwitchEvery: 53,
        delayMs: 48,
        spikeDelayMs: 110,
      },
    };
    this.mode = this.modes.baseline;
    this.lossCount = 0;
    this.delayedCount = 0;
    this.underrunCount = 0;
    this.latencySpikeCount = 0;
    this.packetBurstCount = 0;
    this.temporaryDisconnectCount = 0;
    this.adaptiveSwitchCount = 0;
  }

  setMode(mode) {
    this.mode = this.modes[mode] || this.modes.baseline;
    return this.diagnostics();
  }

  decorate({ sequence, chunk, pcm, timing }) {
    const sampleFrames = Math.floor(chunk.length / (pcm.channels * (pcm.bitDepth / 8)));
    const shouldDrop =
      this.enabled(sequence, this.mode.packetLossEvery);
    const shouldDelay =
      this.enabled(sequence, this.mode.delayedPacketEvery);
    const underrun = this.enabled(sequence, this.mode.underrunEvery);
    const latencySpike =
      this.enabled(sequence, this.mode.latencySpikeEvery);
    const packetBurst =
      this.enabled(sequence, this.mode.packetBurstEvery);
    const temporaryDisconnect =
      this.enabled(sequence, this.mode.temporaryDisconnectEvery);
    const adaptiveSwitch =
      this.enabled(sequence, this.mode.adaptiveSwitchEvery);

    if (shouldDrop) {
      this.lossCount += 1;
    }

    if (shouldDelay) {
      this.delayedCount += 1;
    }

    if (underrun) {
      this.underrunCount += 1;
    }

    if (latencySpike) {
      this.latencySpikeCount += 1;
    }

    if (packetBurst) {
      this.packetBurstCount += 1;
    }

    if (temporaryDisconnect) {
      this.temporaryDisconnectCount += 1;
    }

    if (adaptiveSwitch) {
      this.adaptiveSwitchCount += 1;
    }

    return {
      shouldDrop,
      sendDelayMs: latencySpike
        ? this.mode.spikeDelayMs
        : shouldDelay
          ? this.mode.delayMs
          : 0,
      temporaryDisconnect,
      packet: {
        chunkSize: chunk.length,
        sampleFrames,
        audioTimestamp: pcm.timestamp,
        packetPacingMs: timing.averageSendIntervalMs,
        delayed: shouldDelay,
        lost: shouldDrop,
        underrun,
        latencySpike,
        packetBurst,
        temporaryDisconnect,
        adaptiveSwitch,
        stressMode: this.mode.id,
      },
      diagnostics: this.diagnostics(),
    };
  }

  diagnostics() {
    return {
      stressMode: this.mode.id,
      simulatedLossCount: this.lossCount,
      simulatedDelayedCount: this.delayedCount,
      simulatedUnderrunCount: this.underrunCount,
      simulatedLatencySpikeCount: this.latencySpikeCount,
      simulatedPacketBurstCount: this.packetBurstCount,
      simulatedTemporaryDisconnectCount: this.temporaryDisconnectCount,
      simulatedAdaptiveSwitchCount: this.adaptiveSwitchCount,
      underrunSimulationEnabled: this.mode.underrunEvery > 0,
    };
  }

  enabled(sequence, cadence) {
    return cadence > 0 && sequence > 0 && sequence % cadence === 0;
  }
}

module.exports = { PcmSimulationManager };
