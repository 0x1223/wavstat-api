enum MonitoringMode {
  lowLatency,
  balanced,
  safeBuffer,
}

extension MonitoringModeLabel on MonitoringMode {
  String get label => switch (this) {
        MonitoringMode.lowLatency => 'Low Latency',
        MonitoringMode.balanced => 'Balanced',
        MonitoringMode.safeBuffer => 'Safe Buffer',
      };

  String get wireValue => switch (this) {
        MonitoringMode.lowLatency => 'lowLatency',
        MonitoringMode.balanced => 'balanced',
        MonitoringMode.safeBuffer => 'safeBuffer',
      };
}

/// Wire transport for the live audio stream.
///  - [pcm]:  bit-exact Int16 over the WebRTC data channel (our own playout engine).
///  - [opus]: Opus over a WebRTC audio track — NetEq does jitter buffering + clock recovery +
///            catch-up on the receiver, which is what makes low latency viable on a bursty link.
enum StreamTransport { pcm, opus }

extension StreamTransportLabel on StreamTransport {
  String get label => switch (this) {
        StreamTransport.pcm => 'Raw PCM',
        StreamTransport.opus => 'Opus',
      };

  String get wireValue => switch (this) {
        StreamTransport.pcm => 'pcm',
        StreamTransport.opus => 'opus',
      };
}

class TransportConfig {
  const TransportConfig({
    this.mode = MonitoringMode.balanced,
    this.targetBufferMs = 80,
    this.safeBufferMs = 140,
    this.currentBufferMs = 0,
    this.underrunCount = 0,
    this.adaptive = true,
  });

  final MonitoringMode mode;
  final int targetBufferMs;
  final int safeBufferMs;
  final int currentBufferMs;
  final int underrunCount;
  final bool adaptive;

  TransportConfig copyWith({
    MonitoringMode? mode,
    int? targetBufferMs,
    int? safeBufferMs,
    int? currentBufferMs,
    int? underrunCount,
    bool? adaptive,
  }) {
    return TransportConfig(
      mode: mode ?? this.mode,
      targetBufferMs: targetBufferMs ?? this.targetBufferMs,
      safeBufferMs: safeBufferMs ?? this.safeBufferMs,
      currentBufferMs: currentBufferMs ?? this.currentBufferMs,
      underrunCount: underrunCount ?? this.underrunCount,
      adaptive: adaptive ?? this.adaptive,
    );
  }

  factory TransportConfig.fromEngine(
    Map<String, dynamic>? engine,
    TransportConfig fallback,
  ) {
    if (engine == null) {
      return fallback;
    }

    final sessionConfig = engine['sessionConfig'];
    if (sessionConfig is! Map<String, dynamic>) {
      return fallback;
    }

    return fallback.copyWith(
      mode: _modeFromWire(sessionConfig['id'] as String?),
      targetBufferMs:
          _readInt(sessionConfig['targetBufferMs']) ?? fallback.targetBufferMs,
      safeBufferMs:
          _readInt(sessionConfig['safeBufferMs']) ?? fallback.safeBufferMs,
      adaptive: sessionConfig['adaptive'] is bool
          ? sessionConfig['adaptive'] as bool
          : fallback.adaptive,
    );
  }

  static MonitoringMode _modeFromWire(String? value) {
    return switch (value) {
      'lowLatency' => MonitoringMode.lowLatency,
      'safeBuffer' => MonitoringMode.safeBuffer,
      _ => MonitoringMode.balanced,
    };
  }

  static int? _readInt(dynamic value) {
    if (value is int) {
      return value;
    }

    if (value is num) {
      return value.toInt();
    }

    return null;
  }
}
