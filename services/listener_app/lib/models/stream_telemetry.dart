class StreamTelemetry {
  const StreamTelemetry({
    this.bufferStatus = 'No stream',
    this.networkStatus = 'Idle',
    this.droppedPackets = '--',
    this.latency = '-- ms',
  });

  final String bufferStatus;
  final String networkStatus;
  final String droppedPackets;
  final String latency;

  StreamTelemetry copyWith({
    String? bufferStatus,
    String? networkStatus,
    String? droppedPackets,
    String? latency,
  }) {
    return StreamTelemetry(
      bufferStatus: bufferStatus ?? this.bufferStatus,
      networkStatus: networkStatus ?? this.networkStatus,
      droppedPackets: droppedPackets ?? this.droppedPackets,
      latency: latency ?? this.latency,
    );
  }

  factory StreamTelemetry.fromJson(
    Map<String, dynamic> json,
    StreamTelemetry fallback,
  ) {
    return fallback.copyWith(
      bufferStatus: json['buffer'] as String?,
      networkStatus: json['network'] as String?,
      droppedPackets: json['droppedPackets']?.toString(),
      latency: json['latency'] as String?,
    );
  }
}
