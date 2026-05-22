import '../models/listener_playback_state.dart';
import '../models/transport_config.dart';

class ListenerAudioEngineService {
  ListenerPlaybackState _playbackState = const ListenerPlaybackState();
  TransportConfig _transportConfig = const TransportConfig();

  ListenerPlaybackState get playbackState => _playbackState;
  TransportConfig get transportConfig => _transportConfig;

  ({ListenerPlaybackState playbackState, TransportConfig transportConfig})
      applyEngine(Map<String, dynamic>? engine) {
    _transportConfig = TransportConfig.fromEngine(engine, _transportConfig);
    _playbackState = _playbackState.copyWith(
      engineState: engine?['lifecycle'] as String?,
      streamMode: _transportConfig.mode.label,
      sampleRate: _readFormatInt(engine, 'sampleRate') ?? 48000,
      bitDepth: _readFormatInt(engine, 'bitDepth') ?? 16,
      channels: _readFormatInt(engine, 'channels') ?? 2,
      chunkDurationMs: _readFormatInt(engine, 'chunkDurationMs') ?? 20,
    );

    return (
      playbackState: _playbackState,
      transportConfig: _transportConfig,
    );
  }

  ({ListenerPlaybackState playbackState, TransportConfig transportConfig})
      selectMode(MonitoringMode mode) {
    _transportConfig = switch (mode) {
      MonitoringMode.lowLatency => const TransportConfig(
          mode: MonitoringMode.lowLatency,
          targetBufferMs: 40,
          safeBufferMs: 80,
          adaptive: true,
        ),
      MonitoringMode.balanced => const TransportConfig(),
      MonitoringMode.safeBuffer => const TransportConfig(
          mode: MonitoringMode.safeBuffer,
          targetBufferMs: 160,
          safeBufferMs: 240,
          adaptive: false,
        ),
    };
    _playbackState = _playbackState.copyWith(streamMode: mode.label);

    return (
      playbackState: _playbackState,
      transportConfig: _transportConfig,
    );
  }

  int? _readFormatInt(Map<String, dynamic>? engine, String key) {
    final format = engine?['format'];
    if (format is! Map<String, dynamic>) {
      return null;
    }

    final value = format[key];
    if (value is int) {
      return value;
    }

    if (value is num) {
      return value.toInt();
    }

    return null;
  }
}
