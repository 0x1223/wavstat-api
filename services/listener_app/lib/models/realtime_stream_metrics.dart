class RealtimeStreamMetrics {
  const RealtimeStreamMetrics({
    this.streamSessionId = '--',
    this.lastSequence = -1,
    this.receivedPackets = 0,
    this.droppedPackets = 0,
    this.latencyMs = 0,
    this.averageLatencyMs = 0,
    this.smoothedLatencyMs = 0,
    this.latencyVarianceMs = 0,
    this.jitterMs = 0,
    this.packetTimingConsistency = 'Idle',
    this.reconnectRecoveryMs = 0,
    this.packetFlow = 'Idle',
    this.queueDepth = 0,
    this.packetDelayMs = 0,
    this.packetRecoveryState = 'Ready',
    this.bufferPressure = 'Idle',
    this.streamConfidence = 'Idle',
    this.streamConfidenceScore = 0,
    this.bufferPressureTrend = 'Flat',
    this.packetIntegrityState = 'Ready',
    this.simulatedUnderrunCount = 0,
    this.realPcmChunksReceived = 0,
    this.lifetimePcmChunksReceived = 0,
    this.streamRestartCount = 0,
    this.payloadRateKbps = 0,
    this.lastPayloadSize = 0,
    this.lastPacketAtMs = 0,
    this.reconnectCount = 0,
    this.streamUptimeMs = 0,
    this.audioContextState = 'idle',
    this.playbackBufferDepthMs = 0,
    this.scheduledAudioTimeMs = 0,
    this.playbackUnderrunCount = 0,
    this.outputActive = false,
    this.decodedSampleRate = 0,
    this.decodedChannels = 0,
    this.chunkDurationMs = 0,
    this.scheduledLeadMs = 0,
    this.resumeAttempts = 0,
    this.lastResumeResult = 'idle',
    this.outputRestartCount = 0,
    this.manualResumeRequired = false,
    this.qualityState = 'Idle',
    this.bufferTarget = 'Adaptive standby',
    this.isReconnecting = false,
  });

  final String streamSessionId;
  final int lastSequence;
  final int receivedPackets;
  final int droppedPackets;
  final int latencyMs;
  final int averageLatencyMs;
  final int smoothedLatencyMs;
  final int latencyVarianceMs;
  final int jitterMs;
  final String packetTimingConsistency;
  final int reconnectRecoveryMs;
  final String packetFlow;
  final int queueDepth;
  final int packetDelayMs;
  final String packetRecoveryState;
  final String bufferPressure;
  final String streamConfidence;
  final int streamConfidenceScore;
  final String bufferPressureTrend;
  final String packetIntegrityState;
  final int simulatedUnderrunCount;
  final int realPcmChunksReceived;
  final int lifetimePcmChunksReceived;
  final int streamRestartCount;
  final int payloadRateKbps;
  final int lastPayloadSize;
  final int lastPacketAtMs;
  final int reconnectCount;
  final int streamUptimeMs;
  final String audioContextState;
  final int playbackBufferDepthMs;
  final int scheduledAudioTimeMs;
  final int playbackUnderrunCount;
  final bool outputActive;
  final int decodedSampleRate;
  final int decodedChannels;
  final int chunkDurationMs;
  final int scheduledLeadMs;
  final int resumeAttempts;
  final String lastResumeResult;
  final int outputRestartCount;
  final bool manualResumeRequired;
  final String qualityState;
  final String bufferTarget;
  final bool isReconnecting;

  RealtimeStreamMetrics copyWith({
    String? streamSessionId,
    int? lastSequence,
    int? receivedPackets,
    int? droppedPackets,
    int? latencyMs,
    int? averageLatencyMs,
    int? smoothedLatencyMs,
    int? latencyVarianceMs,
    int? jitterMs,
    String? packetTimingConsistency,
    int? reconnectRecoveryMs,
    String? packetFlow,
    int? queueDepth,
    int? packetDelayMs,
    String? packetRecoveryState,
    String? bufferPressure,
    String? streamConfidence,
    int? streamConfidenceScore,
    String? bufferPressureTrend,
    String? packetIntegrityState,
    int? simulatedUnderrunCount,
    int? realPcmChunksReceived,
    int? lifetimePcmChunksReceived,
    int? streamRestartCount,
    int? payloadRateKbps,
    int? lastPayloadSize,
    int? lastPacketAtMs,
    int? reconnectCount,
    int? streamUptimeMs,
    String? audioContextState,
    int? playbackBufferDepthMs,
    int? scheduledAudioTimeMs,
    int? playbackUnderrunCount,
    bool? outputActive,
    int? decodedSampleRate,
    int? decodedChannels,
    int? chunkDurationMs,
    int? scheduledLeadMs,
    int? resumeAttempts,
    String? lastResumeResult,
    int? outputRestartCount,
    bool? manualResumeRequired,
    String? qualityState,
    String? bufferTarget,
    bool? isReconnecting,
  }) {
    return RealtimeStreamMetrics(
      streamSessionId: streamSessionId ?? this.streamSessionId,
      lastSequence: lastSequence ?? this.lastSequence,
      receivedPackets: receivedPackets ?? this.receivedPackets,
      droppedPackets: droppedPackets ?? this.droppedPackets,
      latencyMs: latencyMs ?? this.latencyMs,
      averageLatencyMs: averageLatencyMs ?? this.averageLatencyMs,
      smoothedLatencyMs: smoothedLatencyMs ?? this.smoothedLatencyMs,
      latencyVarianceMs: latencyVarianceMs ?? this.latencyVarianceMs,
      jitterMs: jitterMs ?? this.jitterMs,
      packetTimingConsistency:
          packetTimingConsistency ?? this.packetTimingConsistency,
      reconnectRecoveryMs: reconnectRecoveryMs ?? this.reconnectRecoveryMs,
      packetFlow: packetFlow ?? this.packetFlow,
      queueDepth: queueDepth ?? this.queueDepth,
      packetDelayMs: packetDelayMs ?? this.packetDelayMs,
      packetRecoveryState: packetRecoveryState ?? this.packetRecoveryState,
      bufferPressure: bufferPressure ?? this.bufferPressure,
      streamConfidence: streamConfidence ?? this.streamConfidence,
      streamConfidenceScore:
          streamConfidenceScore ?? this.streamConfidenceScore,
      bufferPressureTrend: bufferPressureTrend ?? this.bufferPressureTrend,
      packetIntegrityState: packetIntegrityState ?? this.packetIntegrityState,
      simulatedUnderrunCount:
          simulatedUnderrunCount ?? this.simulatedUnderrunCount,
      realPcmChunksReceived:
          realPcmChunksReceived ?? this.realPcmChunksReceived,
      lifetimePcmChunksReceived:
          lifetimePcmChunksReceived ?? this.lifetimePcmChunksReceived,
      streamRestartCount: streamRestartCount ?? this.streamRestartCount,
      payloadRateKbps: payloadRateKbps ?? this.payloadRateKbps,
      lastPayloadSize: lastPayloadSize ?? this.lastPayloadSize,
      lastPacketAtMs: lastPacketAtMs ?? this.lastPacketAtMs,
      reconnectCount: reconnectCount ?? this.reconnectCount,
      streamUptimeMs: streamUptimeMs ?? this.streamUptimeMs,
      audioContextState: audioContextState ?? this.audioContextState,
      playbackBufferDepthMs:
          playbackBufferDepthMs ?? this.playbackBufferDepthMs,
      scheduledAudioTimeMs: scheduledAudioTimeMs ?? this.scheduledAudioTimeMs,
      playbackUnderrunCount:
          playbackUnderrunCount ?? this.playbackUnderrunCount,
      outputActive: outputActive ?? this.outputActive,
      decodedSampleRate: decodedSampleRate ?? this.decodedSampleRate,
      decodedChannels: decodedChannels ?? this.decodedChannels,
      chunkDurationMs: chunkDurationMs ?? this.chunkDurationMs,
      scheduledLeadMs: scheduledLeadMs ?? this.scheduledLeadMs,
      resumeAttempts: resumeAttempts ?? this.resumeAttempts,
      lastResumeResult: lastResumeResult ?? this.lastResumeResult,
      outputRestartCount: outputRestartCount ?? this.outputRestartCount,
      manualResumeRequired: manualResumeRequired ?? this.manualResumeRequired,
      qualityState: qualityState ?? this.qualityState,
      bufferTarget: bufferTarget ?? this.bufferTarget,
      isReconnecting: isReconnecting ?? this.isReconnecting,
    );
  }
}
