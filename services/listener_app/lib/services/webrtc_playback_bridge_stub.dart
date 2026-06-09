import '../models/transport_config.dart';
import 'pcm_playback_bridge.dart';

class WebRtcPlaybackBridge {
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  void Function(String reason)? onFallback;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry(
    audioContextState: 'native-webrtc-unavailable',
  );

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {}

  Future<bool> start({
    required void Function(Map<String, dynamic> signal) sendSignal,
    required void Function(String reason) onFallback,
  }) async {
    this.onFallback = onFallback;
    _telemetry = const PcmPlaybackTelemetry(
      audioContextState: 'native-webrtc-unavailable',
    );
    onTelemetry?.call(_telemetry);
    return false;
  }

  Future<PcmPlaybackTelemetry> stop() async {
    _telemetry = const PcmPlaybackTelemetry(
      audioContextState: 'native-webrtc-stopped',
    );
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  Future<void> handleSignal(Map<String, dynamic> signal) async {}

  Future<PcmPlaybackTelemetry> manualResume() async => _telemetry;

  Future<void> dispose() async {}
}
