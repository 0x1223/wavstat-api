import '../models/transport_config.dart';

class BufferControllerService {
  TransportConfig updateFromChunk(
    TransportConfig config, {
    required int receivedPackets,
    required int droppedPackets,
    required int simulatedUnderruns,
  }) {
    final estimatedBuffer = (receivedPackets % 12) * 20;

    return config.copyWith(
      currentBufferMs: estimatedBuffer.clamp(0, config.safeBufferMs),
      underrunCount: simulatedUnderruns,
    );
  }

  TransportConfig reset(TransportConfig config) {
    return config.copyWith(currentBufferMs: 0, underrunCount: 0);
  }
}
