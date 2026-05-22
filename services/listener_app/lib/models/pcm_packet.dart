class PcmPacket {
  const PcmPacket({
    required this.sequenceNumber,
    required this.timestamp,
    required this.sampleRate,
    required this.bitDepth,
    required this.channels,
    required this.chunkDurationMs,
    required this.chunkSize,
    required this.sampleFrames,
    required this.packetDelayMs,
    required this.underrun,
    required this.delayed,
  });

  final int sequenceNumber;
  final int timestamp;
  final int sampleRate;
  final int bitDepth;
  final int channels;
  final int chunkDurationMs;
  final int chunkSize;
  final int sampleFrames;
  final int packetDelayMs;
  final bool underrun;
  final bool delayed;

  factory PcmPacket.fromJson(Map<String, dynamic> message, int arrivalTimeMs) {
    final pcm = message['pcm'] is Map<String, dynamic>
        ? message['pcm'] as Map<String, dynamic>
        : <String, dynamic>{};
    final simulation = message['simulation'] is Map<String, dynamic>
        ? message['simulation'] as Map<String, dynamic>
        : <String, dynamic>{};
    final timestamp = _readInt(pcm['timestamp']);
    final payloadSize = _readInt(message['payloadSize']);

    final sampleRate = _readInt(pcm['sampleRate']);
    final bitDepth = _readInt(pcm['bitDepth']);
    final channels = _readInt(pcm['channels']);
    final chunkSize =
        payloadSize > 0 ? payloadSize : _readInt(simulation['chunkSize']);
    final bytesPerFrame = channels * (bitDepth ~/ 8);

    return PcmPacket(
      sequenceNumber: _readInt(pcm['sequenceNumber']),
      timestamp: timestamp,
      sampleRate: sampleRate,
      bitDepth: bitDepth,
      channels: channels,
      chunkDurationMs: _readInt(pcm['chunkDurationMs']),
      chunkSize: chunkSize,
      sampleFrames: _readInt(simulation['sampleFrames']) > 0
          ? _readInt(simulation['sampleFrames'])
          : bytesPerFrame > 0
              ? chunkSize ~/ bytesPerFrame
              : 0,
      packetDelayMs: (arrivalTimeMs - timestamp).clamp(0, 1 << 31),
      underrun: simulation['underrun'] == true,
      delayed: simulation['delayed'] == true,
    );
  }

  static int _readInt(dynamic value) {
    if (value is int) {
      return value;
    }

    if (value is num) {
      return value.toInt();
    }

    return 0;
  }
}
