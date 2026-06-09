import 'dart:typed_data' as typed;

import '../models/transport_config.dart';

class PcmPlaybackTelemetry {
  const PcmPlaybackTelemetry({
    this.audioContextState = 'native-idle',
    this.playbackBufferDepthMs = 0,
    this.scheduledAudioTimeMs = 0,
    this.underrunCount = 0,
    this.outputActive = false,
    this.decodedSampleRate = 0,
    this.decodedChannels = 0,
    this.chunkDurationMs = 0,
    this.scheduledLeadMs = 0,
    this.resumeAttempts = 0,
    this.lastResumeResult = 'native',
    this.outputRestartCount = 0,
    this.manualResumeRequired = false,
  });

  final String audioContextState;
  final int playbackBufferDepthMs;
  final int scheduledAudioTimeMs;
  final int underrunCount;
  final bool outputActive;
  final int decodedSampleRate;
  final int decodedChannels;
  final int chunkDurationMs;
  final int scheduledLeadMs;
  final int resumeAttempts;
  final String lastResumeResult;
  final int outputRestartCount;
  final bool manualResumeRequired;
}

class PcmPlaybackBridge {
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry();

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {}

  Future<PcmPlaybackTelemetry> start() async {
    _telemetry = const PcmPlaybackTelemetry(
      audioContextState: 'native-ready',
      outputActive: true,
    );
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  Future<PcmPlaybackTelemetry> stop() async {
    _telemetry = const PcmPlaybackTelemetry();
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  PcmPlaybackTelemetry enqueue(Map<String, dynamic> message) {
    _telemetry = const PcmPlaybackTelemetry(
      audioContextState: 'native-receiving',
      outputActive: true,
    );
    return _telemetry;
  }

  PcmPlaybackTelemetry enqueueBytes(
    typed.Uint8List bytes, {
    int channels = 2,
    int sampleRate = 48000,
    int bitDepth = 16,
    int chunkDurationMs = 20,
  }) =>
      _telemetry = PcmPlaybackTelemetry(
        audioContextState: 'native-receiving',
        outputActive: true,
        decodedSampleRate: sampleRate,
        decodedChannels: channels,
        chunkDurationMs: chunkDurationMs,
      );

  Future<PcmPlaybackTelemetry> manualResume() async => _telemetry;

  Future<void> dispose() async {}
}
