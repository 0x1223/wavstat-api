import '../models/pcm_packet.dart';

class PcmReceiveSnapshot {
  const PcmReceiveSnapshot({
    required this.chunksReceived,
    required this.lifetimeChunksReceived,
    required this.payloadRateKbps,
    required this.lastPayloadSize,
  });

  final int chunksReceived;
  final int lifetimeChunksReceived;
  final int payloadRateKbps;
  final int lastPayloadSize;
}

class PcmReceiveService {
  int _chunksReceived = 0;
  int _lifetimeChunksReceived = 0;
  int _bytesReceived = 0;
  int? _startedAtMs;

  PcmReceiveSnapshot receive(PcmPacket packet, int arrivalTimeMs) {
    _startedAtMs ??= arrivalTimeMs;
    _chunksReceived += 1;
    _lifetimeChunksReceived += 1;
    _bytesReceived += packet.chunkSize;

    final elapsedMs = (arrivalTimeMs - _startedAtMs!).clamp(1, 1 << 31);
    final kbps = ((_bytesReceived * 8) / elapsedMs).round();

    return PcmReceiveSnapshot(
      chunksReceived: _chunksReceived,
      lifetimeChunksReceived: _lifetimeChunksReceived,
      payloadRateKbps: kbps,
      lastPayloadSize: packet.chunkSize,
    );
  }

  PcmReceiveSnapshot reset() {
    _chunksReceived = 0;
    _bytesReceived = 0;
    _startedAtMs = null;
    return const PcmReceiveSnapshot(
      chunksReceived: 0,
      lifetimeChunksReceived: 0,
      payloadRateKbps: 0,
      lastPayloadSize: 0,
    );
  }

  void resetLifetime() {
    _lifetimeChunksReceived = 0;
  }
}
