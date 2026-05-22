import '../models/pcm_packet.dart';

class PacketQueueSnapshot {
  const PacketQueueSnapshot({
    required this.queueDepth,
    required this.packetDelayMs,
    required this.packetRecoveryState,
    required this.bufferPressure,
    required this.streamConfidence,
    required this.streamConfidenceScore,
    required this.bufferPressureTrend,
    required this.packetIntegrityState,
    required this.underrunCount,
  });

  final int queueDepth;
  final int packetDelayMs;
  final String packetRecoveryState;
  final String bufferPressure;
  final String streamConfidence;
  final int streamConfidenceScore;
  final String bufferPressureTrend;
  final String packetIntegrityState;
  final int underrunCount;
}

class PacketQueueManager {
  final List<PcmPacket> _queue = <PcmPacket>[];
  int _underrunCount = 0;
  int _recoveredPackets = 0;
  int _lastDepth = 0;

  PacketQueueSnapshot push(PcmPacket packet, int droppedPackets) {
    _queue.add(packet);
    if (_queue.length > 24) {
      _queue.removeAt(0);
    }

    if (packet.underrun || _queue.length < 2) {
      _underrunCount += 1;
    }

    if (droppedPackets > 0 && _queue.length >= 4) {
      _recoveredPackets += 1;
    }

    final pressure = _bufferPressure();
    final confidence = _streamConfidence(droppedPackets, packet.packetDelayMs);
    return PacketQueueSnapshot(
      queueDepth: _queue.length,
      packetDelayMs: packet.packetDelayMs,
      packetRecoveryState: _recoveryState(droppedPackets),
      bufferPressure: pressure,
      streamConfidence: confidence,
      streamConfidenceScore: _confidenceScore(confidence),
      bufferPressureTrend: _pressureTrend(),
      packetIntegrityState: _integrityState(droppedPackets, packet.delayed),
      underrunCount: _underrunCount,
    );
  }

  PacketQueueSnapshot reset() {
    _queue.clear();
    _underrunCount = 0;
    _recoveredPackets = 0;
    return const PacketQueueSnapshot(
      queueDepth: 0,
      packetDelayMs: 0,
      packetRecoveryState: 'Ready',
      bufferPressure: 'Idle',
      streamConfidence: 'Idle',
      streamConfidenceScore: 0,
      bufferPressureTrend: 'Flat',
      packetIntegrityState: 'Ready',
      underrunCount: 0,
    );
  }

  String _recoveryState(int droppedPackets) {
    if (droppedPackets == 0) {
      return 'Clean';
    }

    if (_recoveredPackets > 0) {
      return 'Recovered';
    }

    return 'Recovering';
  }

  String _bufferPressure() {
    if (_queue.length < 3) {
      return 'Low';
    }

    if (_queue.length < 12) {
      return 'Nominal';
    }

    return 'High';
  }

  String _streamConfidence(int droppedPackets, int delayMs) {
    if (droppedPackets > 2 || delayMs > 90) {
      return 'Guarded';
    }

    if (_queue.length >= 4 && delayMs < 50) {
      return 'High';
    }

    return 'Building';
  }

  int _confidenceScore(String confidence) {
    return switch (confidence) {
      'High' => 96,
      'Building' => 72,
      'Guarded' => 44,
      _ => 0,
    };
  }

  String _pressureTrend() {
    final currentDepth = _queue.length;
    final trend = currentDepth > _lastDepth
        ? 'Rising'
        : currentDepth < _lastDepth
            ? 'Falling'
            : 'Flat';
    _lastDepth = currentDepth;
    return trend;
  }

  String _integrityState(int droppedPackets, bool delayed) {
    if (droppedPackets > 0) {
      return 'Gap detected';
    }

    if (delayed) {
      return 'Delayed';
    }

    return 'Clean';
  }
}
