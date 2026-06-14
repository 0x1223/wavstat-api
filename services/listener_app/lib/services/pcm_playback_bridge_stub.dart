import 'dart:async';
import 'dart:typed_data' as typed;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

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

/// iOS/macOS native audio output via AVAudioEngine.
/// Control commands (start/stop) go through a MethodChannel.
/// PCM bytes flow through a BinaryCodec BasicMessageChannel for efficiency.
class PcmPlaybackBridge {
  static const _controlChannel = MethodChannel(
    'com.kingzbreadent.kingzlisten/pcm',
  );
  static const _audioChannel = BasicMessageChannel<ByteData?>(
    'com.kingzbreadent.kingzlisten/pcm_audio',
    BinaryCodec(),
  );

  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry();
  bool _active = false;
  int _streamSampleRate = 48000;
  TransportConfig _transportConfig = const TransportConfig();

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {
    _transportConfig = config;
    unawaited(_configureNative());
  }

  Future<void> configureStreamSampleRate(int sampleRate) async {
    if (sampleRate <= 0 || sampleRate == _streamSampleRate) {
      return;
    }

    _streamSampleRate = sampleRate;
    await _configureNative();
  }

  Future<void> _configureNative() async {
    try {
      await _controlChannel.invokeMethod<void>(
        'configure',
        <String, Object>{
          'sampleRate': _streamSampleRate,
          'targetBufferMs': _transportConfig.targetBufferMs,
          'safeBufferMs': _transportConfig.safeBufferMs,
          'adaptive': _transportConfig.adaptive,
          'mode': _transportConfig.mode.wireValue,
        },
      );
    } catch (e) {
      debugPrint('[KINGZ PCM] native configure failed: $e');
    }
  }

  Future<PcmPlaybackTelemetry> start() async {
    _active = true;
    try {
      await _controlChannel.invokeMethod<void>('start');
      _telemetry = const PcmPlaybackTelemetry(
        audioContextState: 'native-ready',
        outputActive: false,
      );
    } catch (e) {
      debugPrint('[KINGZ PCM] native start failed: $e');
      _telemetry = PcmPlaybackTelemetry(
        audioContextState: 'native-start-failed: $e',
        outputActive: false,
      );
    }
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  Future<PcmPlaybackTelemetry> stop() async {
    _active = false;
    try {
      await _controlChannel.invokeMethod<void>('stop');
    } catch (e) {
      debugPrint('[KINGZ PCM] native stop failed: $e');
    }
    _telemetry = const PcmPlaybackTelemetry();
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  Future<PcmPlaybackTelemetry> resetToLiveEdge({
    String reason = 'live-edge',
  }) async {
    try {
      await _controlChannel.invokeMethod<void>('flush');
    } catch (e) {
      debugPrint('[KINGZ PCM] native live-edge flush failed: $e');
    }
    _telemetry = PcmPlaybackTelemetry(
      audioContextState: 'native-live-edge',
      outputActive: false,
      decodedSampleRate: _streamSampleRate,
      lastResumeResult: reason,
    );
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
  }) {
    if (!_active) return _telemetry;
    unawaited(configureStreamSampleRate(sampleRate));
    // Fire-and-forget: BinaryCodec skips serialization overhead.
    unawaited(_audioChannel.send(ByteData.sublistView(bytes)));
    _telemetry = PcmPlaybackTelemetry(
      audioContextState: 'native-receiving',
      outputActive: true,
      playbackBufferDepthMs: chunkDurationMs,
      scheduledLeadMs: chunkDurationMs,
      decodedSampleRate: sampleRate,
      decodedChannels: channels,
      chunkDurationMs: chunkDurationMs,
    );
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  Future<PcmPlaybackTelemetry> manualResume() async => _telemetry;

  Future<void> dispose() async => stop();
}
