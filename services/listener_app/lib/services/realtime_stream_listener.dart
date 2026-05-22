import '../models/pcm_packet.dart';
import '../models/realtime_stream_metrics.dart';
import 'packet_queue_manager.dart';
import 'pcm_playback_bridge.dart';
import 'pcm_receive_service.dart';

class RealtimeStreamListener {
  RealtimeStreamMetrics _metrics = const RealtimeStreamMetrics();
  final List<int> _latencyWindow = <int>[];
  final List<int> _arrivalIntervalWindow = <int>[];
  final PacketQueueManager _packetQueueManager = PacketQueueManager();
  final PcmReceiveService _pcmReceiveService = PcmReceiveService();
  int _streamRestartCount = 0;
  int? _lastArrivalMs;
  int? _reconnectStartedAtMs;
  int? _streamStartedAtMs;

  RealtimeStreamMetrics get metrics => _metrics;

  RealtimeStreamMetrics reset() {
    _latencyWindow.clear();
    _arrivalIntervalWindow.clear();
    _lastArrivalMs = null;
    _reconnectStartedAtMs = null;
    _streamStartedAtMs = null;
    _packetQueueManager.reset();
    _pcmReceiveService.reset();
    _pcmReceiveService.resetLifetime();
    _streamRestartCount = 0;
    _metrics = const RealtimeStreamMetrics();
    return _metrics;
  }

  RealtimeStreamMetrics startSession() {
    _latencyWindow.clear();
    _arrivalIntervalWindow.clear();
    _lastArrivalMs = null;
    _reconnectStartedAtMs = null;
    _streamStartedAtMs = null;
    _packetQueueManager.reset();
    _pcmReceiveService.reset();
    _streamRestartCount += 1;
    _metrics = _metrics.copyWith(
      streamSessionId: '--',
      lastSequence: -1,
      receivedPackets: 0,
      droppedPackets: 0,
      latencyMs: 0,
      averageLatencyMs: 0,
      smoothedLatencyMs: 0,
      latencyVarianceMs: 0,
      jitterMs: 0,
      packetTimingConsistency: 'Measuring',
      packetFlow: 'Starting',
      queueDepth: 0,
      packetDelayMs: 0,
      realPcmChunksReceived: 0,
      payloadRateKbps: 0,
      lastPayloadSize: 0,
      streamUptimeMs: 0,
      qualityState: 'Measuring',
      streamRestartCount: _streamRestartCount,
      isReconnecting: false,
    );
    return _metrics;
  }

  RealtimeStreamMetrics reconnecting({int? reconnectCount}) {
    _latencyWindow.clear();
    _arrivalIntervalWindow.clear();
    _lastArrivalMs = null;
    _packetQueueManager.reset();
    _pcmReceiveService.reset();
    _streamRestartCount += 1;
    _reconnectStartedAtMs ??= DateTime.now().millisecondsSinceEpoch;
    _metrics = _metrics.copyWith(
      packetFlow: 'Reconnecting',
      qualityState: 'Recovering',
      bufferTarget: 'Holding buffer',
      packetTimingConsistency: 'Recovering',
      reconnectCount: reconnectCount,
      streamRestartCount: _streamRestartCount,
      isReconnecting: true,
    );
    return _metrics;
  }

  RealtimeStreamMetrics stopped() {
    _metrics = _metrics.copyWith(
      packetFlow: 'Stopped',
      qualityState: 'Idle',
      bufferTarget: 'Adaptive standby',
      packetTimingConsistency: 'Idle',
      isReconnecting: false,
    );
    return _metrics;
  }

  RealtimeStreamMetrics markIdle() {
    _metrics = _metrics.copyWith(
      packetFlow: 'Idle',
      qualityState: 'Idle',
      bufferTarget: 'Adaptive standby',
      packetTimingConsistency: 'Idle',
      isReconnecting: false,
    );
    return _metrics;
  }

  RealtimeStreamMetrics handleChunk(Map<String, dynamic> message) {
    final sequence = _readInt(message['sequence'] ?? message['sequenceNumber']);
    final serverClock = _readInt(message['serverClock']);
    final sessionId = message['streamSessionId'] as String? ?? '--';
    final now = DateTime.now().millisecondsSinceEpoch;
    _streamStartedAtMs ??= now;
    final previousSequence = _metrics.lastSequence;
    final expectedSequence = previousSequence + 1;
    final isNewSession = sessionId != _metrics.streamSessionId &&
        _metrics.streamSessionId != '--';
    final outOfOrder = previousSequence >= 0 && sequence < previousSequence;
    final missedPackets =
        !isNewSession && previousSequence >= 0 && sequence > expectedSequence
            ? sequence - expectedSequence
            : 0;
    final latency = (now - serverClock).clamp(0, 1 << 31);
    final recoveryMs = _reconnectStartedAtMs == null
        ? _metrics.reconnectRecoveryMs
        : now - _reconnectStartedAtMs!;
    _reconnectStartedAtMs = null;

    if (_lastArrivalMs != null) {
      _arrivalIntervalWindow.add(now - _lastArrivalMs!);
      if (_arrivalIntervalWindow.length > 16) {
        _arrivalIntervalWindow.removeAt(0);
      }
    }
    _lastArrivalMs = now;

    _latencyWindow.add(latency);
    if (_latencyWindow.length > 16) {
      _latencyWindow.removeAt(0);
    }

    final averageLatency = _average(_latencyWindow);
    final smoothedLatency = _smoothLatency(latency);
    final variance = _range(_latencyWindow);
    final jitter = _range(_arrivalIntervalWindow);
    final packetTiming = _packetTimingConsistency(jitter);
    final pcmPacket = PcmPacket.fromJson(message, now);
    final receiveSnapshot = _pcmReceiveService.receive(pcmPacket, now);
    final queueSnapshot = _packetQueueManager.push(
      pcmPacket,
      _metrics.droppedPackets + missedPackets,
    );
    _metrics = _metrics.copyWith(
      streamSessionId: sessionId,
      lastSequence: outOfOrder ? previousSequence : sequence,
      receivedPackets: _metrics.receivedPackets + 1,
      droppedPackets: _metrics.droppedPackets + missedPackets,
      latencyMs: latency,
      averageLatencyMs: averageLatency,
      smoothedLatencyMs: smoothedLatency,
      latencyVarianceMs: variance,
      jitterMs: jitter,
      packetTimingConsistency: packetTiming,
      reconnectRecoveryMs: recoveryMs,
      packetFlow: 'Active',
      queueDepth: queueSnapshot.queueDepth,
      packetDelayMs: queueSnapshot.packetDelayMs,
      packetRecoveryState: queueSnapshot.packetRecoveryState,
      bufferPressure: queueSnapshot.bufferPressure,
      streamConfidence: queueSnapshot.streamConfidence,
      streamConfidenceScore: queueSnapshot.streamConfidenceScore,
      bufferPressureTrend: queueSnapshot.bufferPressureTrend,
      packetIntegrityState: queueSnapshot.packetIntegrityState,
      simulatedUnderrunCount: queueSnapshot.underrunCount,
      realPcmChunksReceived: receiveSnapshot.chunksReceived,
      lifetimePcmChunksReceived: receiveSnapshot.lifetimeChunksReceived,
      payloadRateKbps: receiveSnapshot.payloadRateKbps,
      lastPayloadSize: receiveSnapshot.lastPayloadSize,
      lastPacketAtMs: now,
      streamUptimeMs: now - _streamStartedAtMs!,
      qualityState: 'Live',
      bufferTarget: variance > 12 || jitter > 8
          ? 'Expanding buffer'
          : 'Low-latency target',
      isReconnecting: false,
    );
    return _metrics;
  }

  RealtimeStreamMetrics withReconnectCount(int reconnectCount) {
    _metrics = _metrics.copyWith(reconnectCount: reconnectCount);
    return _metrics;
  }

  RealtimeStreamMetrics withPlaybackTelemetry(PcmPlaybackTelemetry telemetry) {
    _metrics = _metrics.copyWith(
      audioContextState: telemetry.audioContextState,
      playbackBufferDepthMs: telemetry.playbackBufferDepthMs,
      scheduledAudioTimeMs: telemetry.scheduledAudioTimeMs,
      playbackUnderrunCount: telemetry.underrunCount,
      outputActive: telemetry.outputActive,
      decodedSampleRate: telemetry.decodedSampleRate,
      decodedChannels: telemetry.decodedChannels,
      chunkDurationMs: telemetry.chunkDurationMs,
      scheduledLeadMs: telemetry.scheduledLeadMs,
      resumeAttempts: telemetry.resumeAttempts,
      lastResumeResult: telemetry.lastResumeResult,
      outputRestartCount: telemetry.outputRestartCount,
      manualResumeRequired: telemetry.manualResumeRequired,
    );
    return _metrics;
  }

  int _readInt(dynamic value) {
    if (value is int) {
      return value;
    }

    if (value is num) {
      return value.toInt();
    }

    return 0;
  }

  int _average(List<int> values) {
    if (values.isEmpty) {
      return 0;
    }

    return (values.reduce((a, b) => a + b) / values.length).round();
  }

  int _smoothLatency(int latency) {
    final current = _metrics.smoothedLatencyMs;
    if (current == 0) {
      return latency;
    }

    return (current * 0.72 + latency * 0.28).round();
  }

  int _range(List<int> values) {
    if (values.length < 2) {
      return 0;
    }

    final min = values.reduce((a, b) => a < b ? a : b);
    final max = values.reduce((a, b) => a > b ? a : b);
    return max - min;
  }

  String _packetTimingConsistency(int jitter) {
    if (_arrivalIntervalWindow.length < 2) {
      return 'Priming';
    }

    if (jitter <= 5) {
      return 'Tight';
    }

    if (jitter <= 10) {
      return 'Stable';
    }

    return 'Variable';
  }
}
