import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:math';
import 'dart:typed_data' as typed;

import 'package:web/web.dart' as web;

import '../models/transport_config.dart';

class _QueuedPcmBytes {
  const _QueuedPcmBytes({
    required this.bytes,
    required this.channels,
    required this.sampleRate,
    required this.bitDepth,
    required this.chunkDurationMs,
  });

  final typed.Uint8List bytes;
  final int channels;
  final int sampleRate;
  final int bitDepth;
  final int chunkDurationMs;
}

class PcmPlaybackTelemetry {
  const PcmPlaybackTelemetry({
    this.audioContextState = 'idle',
    this.playbackBufferDepthMs = 0,
    this.scheduledAudioTimeMs = 0,
    this.underrunCount = 0,
    this.outputActive = false,
    this.decodedSampleRate = 0,
    this.decodedChannels = 0,
    this.chunkDurationMs = 0,
    this.scheduledLeadMs = 0,
    this.resumeAttempts = 0,
    this.lastResumeResult = 'idle',
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
  static const double _resyncDriftSeconds = 0.38;
  static const double _fadeSeconds = 0.003;
  static const Duration _outputRefreshGrace = Duration(milliseconds: 700);
  static const Duration _outputRefreshDebounce = Duration(seconds: 6);
  static const Duration _silentOutputRefreshGrace =
      Duration(milliseconds: 1000);
  static const Duration _silentOutputRefreshCooldown =
      Duration(milliseconds: 3500);
  static const Duration _softFallbackGrace = Duration(milliseconds: 1600);
  static const Duration _softFallbackCooldown = Duration(seconds: 25);
  static const Duration _pcmArrivalWindow = Duration(milliseconds: 900);
  static const Duration _outputRefreshFade = Duration(milliseconds: 30);

  web.AudioContext? _context;
  web.GainNode? _outputGain;
  web.AudioWorkletNode? _workletNode;
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  final List<web.AudioBufferSourceNode> _sources =
      <web.AudioBufferSourceNode>[];
  final List<Timer> _resumeRetryTimers = <Timer>[];
  final List<Map<String, dynamic>> _queuedPcmMessages =
      <Map<String, dynamic>>[];
  final List<_QueuedPcmBytes> _queuedPcmBytes = <_QueuedPcmBytes>[];
  Timer? _outputRefreshProbeTimer;
  Timer? _silentOutputRefreshTimer;
  Timer? _delayedRestoreCheckTimer;
  Timer? _softFallbackTimer;
  DateTime? _lastPcmArrivedAt;
  DateTime? _lastOutputRefreshAt;
  DateTime? _lastSilentOutputRefreshAt;
  DateTime? _lastSoftFallbackAt;
  double _scheduledAt = 0;
  double _targetLeadSeconds = 0.08;
  double _resumeLeadSeconds = 0.10;
  double _maxScheduleAheadSeconds = 0.25;
  int _underrunCount = 0;
  int _generation = 0;
  int _decodedSampleRate = 0;
  int _decodedChannels = 0;
  int _chunkDurationMs = 0;
  int _scheduledLeadMs = 0;
  int _resumeAttempts = 0;
  int _outputRestartCount = 0;
  int _pcmWhileInactiveLogs = 0;
  int _pcmPacketArrivalCount = 0;
  int _playbackControlGeneration = 0;
  String _lastResumeResult = 'idle';
  bool _manualResumeRequired = false;
  bool _active = false;
  bool _starting = false;
  bool _listenersAttached = false;
  bool _resumeInFlight = false;
  bool _silentOutputRefreshInFlight = false;
  bool _softFallbackInFlight = false;
  bool _softFallbackAwaitingRecovery = false;
  bool _awaitingOutputRestart = false;
  bool _workletModuleLoaded = false;
  bool _workletUnavailable = false;
  JSFunction? _visibilityListener;
  JSFunction? _focusListener;
  JSFunction? _pageShowListener;
  JSFunction? _blurListener;
  JSFunction? _pageHideListener;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry();

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {
    _targetLeadSeconds = config.targetBufferMs / 1000;
    _resumeLeadSeconds = max(_targetLeadSeconds, config.safeBufferMs / 1000);
    _maxScheduleAheadSeconds = max(
      _resumeLeadSeconds + 0.08,
      config.safeBufferMs / 1000,
    );
  }

  Future<PcmPlaybackTelemetry> start() async {
    if (_starting) {
      return _telemetry;
    }

    _starting = true;
    try {
      final context = _context ??= web.AudioContext();
      await _ensureWorkletRenderer(context);
      _attachLifecycleListeners();
      _cancelResumeRetries();
      _logRecoveryState('scheduler-start-requested', reason: 'start');
      _playbackControlGeneration += 1;
      _awaitingOutputRestart = false;
      _manualResumeRequired = false;
      _lastResumeResult = 'starting';
      _active = true;
      _scheduledAt = context.currentTime + _targetLeadSeconds;
      _logDiagnostic('start.before-resume');
      await context.resume().toDart;
      _logDiagnostic('start.resume-success');
      _lastResumeResult = 'resumed';
      _logRecoveryState('scheduler-started', reason: 'start');
      return _updateTelemetry(outputActive: true, stateOverride: 'resumed');
    } catch (_) {
      _active = false;
      _lastResumeResult = 'interrupted';
      _logDiagnostic('start.resume-failed');
      _logRecoveryState('scheduler-start-failed', reason: 'start');
      return _updateTelemetry(
          outputActive: false, stateOverride: 'interrupted');
    } finally {
      _starting = false;
    }
  }

  Future<PcmPlaybackTelemetry> stop() async {
    _logRecoveryState('scheduler-stop-requested', reason: 'stop');
    _playbackControlGeneration += 1;
    _active = false;
    _generation += 1;
    _scheduledAt = 0;
    _awaitingOutputRestart = false;
    _manualResumeRequired = false;
    _lastResumeResult = 'stopped';
    _cancelResumeRetries();
    _cancelOutputRefreshProbe();
    _cancelSilentOutputRefresh();
    _cancelDelayedRestoreCheck();
    _cancelSoftFallback();
    _queuedPcmMessages.clear();
    _queuedPcmBytes.clear();
    _stopSources();
    _stopWorkletRenderer();
    _disconnectOutputChain();
    final context = _context;
    if (context != null && context.state != 'closed') {
      try {
        await context.suspend().toDart;
      } catch (_) {}
    }

    _logRecoveryState('scheduler-stopped', reason: 'stop');
    return _updateTelemetry(outputActive: false, stateOverride: 'stopped');
  }

  PcmPlaybackTelemetry enqueue(Map<String, dynamic> message) {
    final context = _context;
    if (!_active || context == null) {
      return _updateTelemetry(outputActive: false);
    }
    _pcmPacketArrivalCount += 1;
    _lastPcmArrivedAt = DateTime.now();

    if (context.state == 'suspended' || context.state == 'interrupted') {
      _queuePcmMessage(message);
      _logRecoveryState(
        'pcm-arrival-context-blocked',
        reason: 'pcm',
        detail: 'arrival-count=$_pcmPacketArrivalCount',
      );
      _logDiagnostic('pcm.arrived-context-blocked');
      _requestForegroundResume('chunk');
      return _updateTelemetry(outputActive: false);
    }

    if (!_telemetry.outputActive) {
      _pcmWhileInactiveLogs += 1;
      if (_pcmWhileInactiveLogs == 1 || _pcmWhileInactiveLogs % 50 == 0) {
        _logRecoveryState(
          'pcm-arrival-output-inactive',
          reason: 'pcm',
          detail: 'arrival-count=$_pcmPacketArrivalCount',
        );
        _logDiagnostic('pcm.arriving-output-inactive');
      }
    }

    final payload = message['payload'];
    if (payload is! String || payload.isEmpty) {
      return _updateTelemetry(outputActive: false);
    }

    final pcm = message['pcm'] is Map<String, dynamic>
        ? message['pcm'] as Map<String, dynamic>
        : <String, dynamic>{};
    final channels = _readInt(pcm['channels'], fallback: 2).clamp(1, 2);
    final bitDepth = _readInt(pcm['bitDepth'], fallback: 16);
    final sampleRate = _readInt(pcm['sampleRate'], fallback: 48000);
    final chunkDurationMs = _readInt(pcm['chunkDurationMs'], fallback: 0);

    if (bitDepth != 16 || sampleRate <= 0) {
      return _updateTelemetry(outputActive: false);
    }

    typed.Uint8List bytes;
    try {
      bytes = base64Decode(payload);
    } catch (_) {
      return _updateTelemetry(outputActive: false);
    }

    final bytesPerFrame = channels * 2;
    final frames = bytes.length ~/ bytesPerFrame;
    if (frames <= 0) {
      return _updateTelemetry(outputActive: false);
    }

    final now = context.currentTime;
    final worklet = _workletNode;
    if (worklet != null) {
      try {
        worklet.port.postMessage(
          <String, Object>{
            'type': 'pcm-bytes',
            'bytes': bytes.toJS,
            'channels': channels,
            'frameCount': frames,
            'sampleRate': sampleRate,
          }.jsify(),
        );
        if (_scheduledAt > 0 && _scheduledAt < now) {
          _underrunCount += 1;
          _scheduledAt = now + _targetLeadSeconds;
        }
        _scheduledAt =
            max(_scheduledAt, now + _targetLeadSeconds) + frames / sampleRate;
        if (_awaitingOutputRestart) {
          _awaitingOutputRestart = false;
          _manualResumeRequired = false;
          _outputRestartCount += 1;
          _lastResumeResult = 'worklet-scheduled';
          _cancelResumeRetries();
        }
        _decodedSampleRate = sampleRate;
        _decodedChannels = channels;
        _chunkDurationMs = chunkDurationMs > 0
            ? chunkDurationMs
            : ((frames / sampleRate) * 1000).round();
        _scheduledLeadMs = max(0, ((_scheduledAt - now) * 1000).round());
        return _updateTelemetry(outputActive: true);
      } catch (_) {
        _workletUnavailable = true;
        _stopWorkletRenderer();
      }
    }

    if (_scheduledAt > 0 && _scheduledAt < now) {
      _underrunCount += 1;
      _scheduledAt = now + _targetLeadSeconds;
    }

    final scheduleDepth = _scheduledAt - now;
    if (scheduleDepth > _resyncDriftSeconds) {
      _generation += 1;
      _stopSources();
      _scheduledAt = now + _targetLeadSeconds;
    } else if (scheduleDepth > _maxScheduleAheadSeconds) {
      return _updateTelemetry(outputActive: true);
    }

    final buffer = context.createBuffer(channels, frames, sampleRate);
    final data = typed.ByteData.sublistView(bytes);

    for (var channel = 0; channel < channels; channel += 1) {
      final samples = typed.Float32List(frames);
      for (var frame = 0; frame < frames; frame += 1) {
        final offset = (frame * channels + channel) * 2;
        final sample = data.getInt16(offset, typed.Endian.little);
        samples[frame] = (sample / 32768).clamp(-1.0, 1.0);
      }
      _smoothEdges(samples, sampleRate);
      buffer.copyToChannel(samples.toJS, channel);
    }

    final source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(_outputDestination(context));
    final generation = _generation;
    source.onended = ((web.Event _) {
      if (generation == _generation) {
        _sources.remove(source);
      }
    }).toJS;
    _sources.add(source);

    final minStartAt = now + _targetLeadSeconds;
    final startAt =
        _scheduledAt <= 0 ? minStartAt : max(minStartAt, _scheduledAt);
    final duration = buffer.duration;
    source.start(startAt);
    _scheduledAt = startAt + duration;
    if (_awaitingOutputRestart) {
      _awaitingOutputRestart = false;
      _manualResumeRequired = false;
      _outputRestartCount += 1;
      _lastResumeResult = 'scheduled';
      if (_softFallbackAwaitingRecovery) {
        _softFallbackAwaitingRecovery = false;
        web.console.log(
          _structuredLog(
            'soft stop-play fallback recovered',
            event: 'soft-fallback-recovered',
            reason: 'pcm-scheduled',
          ).toJS,
        );
      }
      _cancelResumeRetries();
    }
    _decodedSampleRate = sampleRate;
    _decodedChannels = channels;
    _chunkDurationMs =
        chunkDurationMs > 0 ? chunkDurationMs : (duration * 1000).round();
    _scheduledLeadMs = max(0, ((_scheduledAt - now) * 1000).round());
    if (_pcmPacketArrivalCount == 1 || _pcmPacketArrivalCount % 100 == 0) {
      _logRecoveryState(
        'pcm-arrival-count',
        reason: 'pcm',
        detail: 'arrival-count=$_pcmPacketArrivalCount',
      );
    }
    _logDiagnostic('pcm.scheduled');

    return _updateTelemetry(outputActive: true);
  }

  PcmPlaybackTelemetry enqueueBytes(
    typed.Uint8List bytes, {
    int channels = 2,
    int sampleRate = 48000,
    int bitDepth = 16,
    int chunkDurationMs = 10,
  }) {
    final context = _context;
    if (!_active || context == null) {
      return _updateTelemetry(outputActive: false);
    }
    _pcmPacketArrivalCount += 1;
    _lastPcmArrivedAt = DateTime.now();

    if (context.state == 'suspended' || context.state == 'interrupted') {
      _queuePcmBytes(
        bytes,
        channels: channels,
        sampleRate: sampleRate,
        bitDepth: bitDepth,
        chunkDurationMs: chunkDurationMs,
      );
      _logRecoveryState(
        'pcm-arrival-context-blocked',
        reason: 'pcm-bytes',
        detail: 'arrival-count=$_pcmPacketArrivalCount',
      );
      _logDiagnostic('pcm.bytes-arrived-context-blocked');
      _requestForegroundResume('chunk');
      return _updateTelemetry(outputActive: false);
    }

    if (!_telemetry.outputActive) {
      _pcmWhileInactiveLogs += 1;
      if (_pcmWhileInactiveLogs == 1 || _pcmWhileInactiveLogs % 50 == 0) {
        _logRecoveryState(
          'pcm-arrival-output-inactive',
          reason: 'pcm-bytes',
          detail: 'arrival-count=$_pcmPacketArrivalCount',
        );
        _logDiagnostic('pcm.bytes-arriving-output-inactive');
      }
    }

    channels = channels.clamp(1, 2);
    if (bitDepth != 16 || sampleRate <= 0 || bytes.isEmpty) {
      return _updateTelemetry(outputActive: false);
    }

    final bytesPerFrame = channels * 2;
    final frames = bytes.length ~/ bytesPerFrame;
    if (frames <= 0) {
      return _updateTelemetry(outputActive: false);
    }

    final now = context.currentTime;
    final worklet = _workletNode;
    if (worklet != null) {
      try {
        worklet.port.postMessage(
          <String, Object>{
            'type': 'pcm-bytes',
            'bytes': bytes.toJS,
            'channels': channels,
            'frameCount': frames,
            'sampleRate': sampleRate,
          }.jsify(),
        );
        if (_scheduledAt > 0 && _scheduledAt < now) {
          _underrunCount += 1;
          _scheduledAt = now + _targetLeadSeconds;
        }
        _scheduledAt =
            max(_scheduledAt, now + _targetLeadSeconds) + frames / sampleRate;
        if (_awaitingOutputRestart) {
          _awaitingOutputRestart = false;
          _manualResumeRequired = false;
          _outputRestartCount += 1;
          _lastResumeResult = 'worklet-scheduled';
          _cancelResumeRetries();
        }
        _decodedSampleRate = sampleRate;
        _decodedChannels = channels;
        _chunkDurationMs = chunkDurationMs > 0
            ? chunkDurationMs
            : ((frames / sampleRate) * 1000).round();
        _scheduledLeadMs = max(0, ((_scheduledAt - now) * 1000).round());
        return _updateTelemetry(outputActive: true);
      } catch (_) {
        _workletUnavailable = true;
        _stopWorkletRenderer();
      }
    }

    if (_scheduledAt > 0 && _scheduledAt < now) {
      _underrunCount += 1;
      _scheduledAt = now + _targetLeadSeconds;
    }

    final scheduleDepth = _scheduledAt - now;
    if (scheduleDepth > _resyncDriftSeconds) {
      _generation += 1;
      _stopSources();
      _scheduledAt = now + _targetLeadSeconds;
    } else if (scheduleDepth > _maxScheduleAheadSeconds) {
      return _updateTelemetry(outputActive: true);
    }

    final buffer = context.createBuffer(channels, frames, sampleRate);
    final data = typed.ByteData.sublistView(bytes);

    for (var channel = 0; channel < channels; channel += 1) {
      final samples = typed.Float32List(frames);
      for (var frame = 0; frame < frames; frame += 1) {
        final offset = (frame * channels + channel) * 2;
        final sample = data.getInt16(offset, typed.Endian.little);
        samples[frame] = (sample / 32768).clamp(-1.0, 1.0);
      }
      _smoothEdges(samples, sampleRate);
      buffer.copyToChannel(samples.toJS, channel);
    }

    final source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(_outputDestination(context));
    final generation = _generation;
    source.onended = ((web.Event _) {
      if (generation == _generation) {
        _sources.remove(source);
      }
    }).toJS;
    _sources.add(source);

    final minStartAt = now + _targetLeadSeconds;
    final startAt =
        _scheduledAt <= 0 ? minStartAt : max(minStartAt, _scheduledAt);
    final duration = buffer.duration;
    source.start(startAt);
    _scheduledAt = startAt + duration;
    if (_awaitingOutputRestart) {
      _awaitingOutputRestart = false;
      _manualResumeRequired = false;
      _outputRestartCount += 1;
      _lastResumeResult = 'scheduled';
      _cancelResumeRetries();
    }
    _decodedSampleRate = sampleRate;
    _decodedChannels = channels;
    _chunkDurationMs =
        chunkDurationMs > 0 ? chunkDurationMs : (duration * 1000).round();
    _scheduledLeadMs = max(0, ((_scheduledAt - now) * 1000).round());
    if (_pcmPacketArrivalCount == 1 || _pcmPacketArrivalCount % 100 == 0) {
      _logRecoveryState(
        'pcm-byte-arrival-count',
        reason: 'pcm-bytes',
        detail: 'arrival-count=$_pcmPacketArrivalCount bytes=${bytes.length}',
      );
    }
    _logDiagnostic('pcm.bytes-scheduled');

    return _updateTelemetry(outputActive: true);
  }

  Future<PcmPlaybackTelemetry> manualResume() async {
    if (!_active || web.document.hidden) {
      return _updateTelemetry(outputActive: false);
    }

    final context = _context;
    if (context == null || context.state == 'closed') {
      return _updateTelemetry(outputActive: false);
    }

    _manualResumeRequired = false;
    _lastResumeResult = 'manual';
    _playbackControlGeneration += 1;
    _cancelResumeRetries();
    _generation += 1;
    _stopSources();

    try {
      _logDiagnostic('manual.before-resume');
      await context.resume().toDart;
      _logDiagnostic('manual.resume-success');
      _scheduledAt = context.currentTime + _resumeLeadSeconds;
      _awaitingOutputRestart = true;
      _lastResumeResult =
          context.state == 'running' ? 'manual-resumed' : context.state;
      _drainQueuedPcmMessages();
      return _updateTelemetry(
          outputActive: false, stateOverride: _lastResumeResult);
    } catch (_) {
      _manualResumeRequired = true;
      _lastResumeResult = 'manual-failed';
      _logDiagnostic('manual.resume-failed');
      return _updateTelemetry(
          outputActive: false, stateOverride: 'interrupted');
    }
  }

  void _requestForegroundResume(String reason) {
    if (!_active || web.document.hidden) {
      return;
    }

    final context = _context;
    if (context == null || context.state == 'closed') {
      return;
    }

    final needsResume = _awaitingOutputRestart ||
        !_telemetry.outputActive ||
        context.state == 'suspended' ||
        context.state == 'interrupted';
    if (!needsResume) {
      return;
    }

    _generation += 1;
    _stopSources();
    _scheduledAt = context.currentTime + _resumeLeadSeconds;
    _awaitingOutputRestart = true;
    _manualResumeRequired = false;
    _lastResumeResult = 'pending';
    _updateTelemetry(outputActive: false);
    _logDiagnostic('resume.request.$reason');
    _cancelResumeRetries();
    unawaited(_tryResumeAudioContext(reason));
    _resumeRetryTimers.add(
      Timer(const Duration(milliseconds: 250), () {
        if (_awaitingOutputRestart && _active) {
          unawaited(_tryResumeAudioContext('retry-250'));
        }
      }),
    );
    _resumeRetryTimers.add(
      Timer(const Duration(milliseconds: 750), () {
        if (_awaitingOutputRestart && _active) {
          unawaited(_tryResumeAudioContext('retry-750', finalAttempt: true));
        }
      }),
    );
  }

  Future<void> _tryResumeAudioContext(
    String reason, {
    bool finalAttempt = false,
  }) async {
    if (_resumeInFlight || !_active || web.document.hidden) {
      return;
    }

    final context = _context;
    if (context == null || context.state == 'closed') {
      return;
    }

    _resumeInFlight = true;
    _resumeAttempts += 1;
    _lastResumeResult = reason;
    try {
      _logDiagnostic('resume.before.$reason');
      await context.resume().toDart;
      _logDiagnostic('resume.success.$reason');
      _scheduledAt = context.currentTime + _resumeLeadSeconds;
      if (context.state == 'running') {
        _lastResumeResult = 'resumed';
        _manualResumeRequired = false;
        _cancelResumeRetries();
        _drainQueuedPcmMessages();
      } else {
        _lastResumeResult = context.state;
        if (finalAttempt &&
            (context.state == 'suspended' || context.state == 'interrupted')) {
          _manualResumeRequired = true;
          _lastResumeResult = 'manual-required';
        }
      }
      _updateTelemetry(outputActive: false, stateOverride: _lastResumeResult);
    } catch (_) {
      _lastResumeResult = finalAttempt ? 'manual-required' : 'interrupted';
      if (finalAttempt) {
        _manualResumeRequired = true;
      }
      _logDiagnostic('resume.failed.$reason');
      _updateTelemetry(outputActive: false, stateOverride: 'interrupted');
    } finally {
      _resumeInFlight = false;
    }
  }

  void _attachLifecycleListeners() {
    if (_listenersAttached) {
      return;
    }

    _visibilityListener = ((web.Event _) {
      if (web.document.hidden) {
        _logRecoveryState('visibilitychange', reason: 'hidden');
        _logDiagnostic('visibility.hidden');
        _generation += 1;
        _scheduledAt = 0;
        _awaitingOutputRestart = true;
        _manualResumeRequired = false;
        _lastResumeResult = 'suspended';
        _cancelResumeRetries();
        _cancelOutputRefreshProbe();
        _cancelSilentOutputRefresh();
        _cancelDelayedRestoreCheck();
        _cancelSoftFallback();
        _stopSources();
        _updateTelemetry(outputActive: false, stateOverride: 'suspended');
        return;
      }

      _logRecoveryState('visibilitychange', reason: 'visible');
      _logDiagnostic('visibility.visible');
      _logRecoveryState('resume-trigger', reason: 'visibility');
      _requestForegroundResume('visibility');
      _scheduleOutputRefreshProbe('visibility');
      _scheduleSilentOutputRefreshProbe('visibility');
      _scheduleDelayedRestoreCheck('visibility');
    }).toJS;
    _focusListener = ((web.Event _) {
      _logRecoveryState('focus', reason: 'window');
      _logDiagnostic('window.focus');
      _logRecoveryState('resume-trigger', reason: 'focus');
      _requestForegroundResume('focus');
      _scheduleOutputRefreshProbe('focus');
      _scheduleSilentOutputRefreshProbe('focus');
      _scheduleDelayedRestoreCheck('focus');
    }).toJS;
    _pageShowListener = ((web.Event _) {
      _logRecoveryState('pageshow', reason: 'window');
      _logDiagnostic('page.show');
      _logRecoveryState('resume-trigger', reason: 'pageshow');
      _requestForegroundResume('pageshow');
      _scheduleOutputRefreshProbe('pageshow');
      _scheduleSilentOutputRefreshProbe('pageshow');
      _scheduleDelayedRestoreCheck('pageshow');
    }).toJS;
    _blurListener = ((web.Event _) {
      _logRecoveryState('blur', reason: 'window');
      _logDiagnostic('window.blur');
    }).toJS;
    _pageHideListener = ((web.Event _) {
      _logRecoveryState('pagehide', reason: 'window');
      _logDiagnostic('page.hide');
    }).toJS;

    web.document.addEventListener('visibilitychange', _visibilityListener);
    web.window.addEventListener('focus', _focusListener);
    web.window.addEventListener('blur', _blurListener);
    web.window.addEventListener('pageshow', _pageShowListener);
    web.window.addEventListener('pagehide', _pageHideListener);
    _listenersAttached = true;
  }

  void _stopSources() {
    final sources = List<web.AudioBufferSourceNode>.from(_sources);
    _sources.clear();
    for (final source in sources) {
      try {
        source.stop(0);
      } catch (_) {}
      try {
        source.disconnect();
      } catch (_) {}
      source.buffer = null;
    }
  }

  Future<void> dispose() async {
    _active = false;
    _generation += 1;
    _scheduledAt = 0;
    _awaitingOutputRestart = false;
    _manualResumeRequired = false;
    _lastResumeResult = 'stopped';
    _cancelResumeRetries();
    _cancelOutputRefreshProbe();
    _cancelSilentOutputRefresh();
    _cancelDelayedRestoreCheck();
    _cancelSoftFallback();
    _queuedPcmMessages.clear();
    _queuedPcmBytes.clear();
    _stopSources();
    _stopWorkletRenderer();
    _disconnectOutputChain();

    if (_listenersAttached) {
      web.document.removeEventListener('visibilitychange', _visibilityListener);
      web.window.removeEventListener('focus', _focusListener);
      web.window.removeEventListener('blur', _blurListener);
      web.window.removeEventListener('pageshow', _pageShowListener);
      web.window.removeEventListener('pagehide', _pageHideListener);
      _listenersAttached = false;
    }

    final context = _context;
    _context = null;
    if (context != null && context.state != 'closed') {
      try {
        await context.close().toDart;
      } catch (_) {}
    }

    _updateTelemetry(outputActive: false, stateOverride: 'stopped');
  }

  PcmPlaybackTelemetry _updateTelemetry({
    required bool outputActive,
    String? stateOverride,
  }) {
    final context = _context;
    final now = context?.currentTime ?? 0;
    final bufferDepthMs =
        context == null ? 0 : max(0, ((_scheduledAt - now) * 1000).round());
    final scheduledLeadMs = max(_scheduledLeadMs, bufferDepthMs);
    _telemetry = PcmPlaybackTelemetry(
      audioContextState: stateOverride ?? context?.state ?? 'idle',
      playbackBufferDepthMs: bufferDepthMs,
      scheduledAudioTimeMs: scheduledLeadMs,
      underrunCount: _underrunCount,
      outputActive: outputActive && _active && context?.state != 'closed',
      decodedSampleRate: _decodedSampleRate,
      decodedChannels: _decodedChannels,
      chunkDurationMs: _chunkDurationMs,
      scheduledLeadMs: scheduledLeadMs,
      resumeAttempts: _resumeAttempts,
      lastResumeResult: _lastResumeResult,
      outputRestartCount: _outputRestartCount,
      manualResumeRequired: _manualResumeRequired,
    );
    onTelemetry?.call(_telemetry);
    return _telemetry;
  }

  int _readInt(dynamic value, {required int fallback}) {
    if (value is int) {
      return value;
    }

    if (value is num) {
      return value.toInt();
    }

    return fallback;
  }

  void _smoothEdges(typed.Float32List samples, int sampleRate) {
    if (samples.isEmpty || sampleRate <= 0) {
      return;
    }

    final fadeFrames =
        min(samples.length ~/ 2, max(1, (sampleRate * _fadeSeconds).round()));
    for (var index = 0; index < fadeFrames; index += 1) {
      final gain = (index + 1) / fadeFrames;
      samples[index] = (samples[index] * gain).clamp(-1.0, 1.0);
      final tailIndex = samples.length - 1 - index;
      samples[tailIndex] = (samples[tailIndex] * gain).clamp(-1.0, 1.0);
    }
  }

  void _cancelResumeRetries() {
    for (final timer in _resumeRetryTimers) {
      timer.cancel();
    }
    _resumeRetryTimers.clear();
  }

  void _cancelOutputRefreshProbe() {
    _outputRefreshProbeTimer?.cancel();
    _outputRefreshProbeTimer = null;
  }

  void _cancelSilentOutputRefresh() {
    _silentOutputRefreshTimer?.cancel();
    _silentOutputRefreshTimer = null;
  }

  void _cancelDelayedRestoreCheck() {
    _delayedRestoreCheckTimer?.cancel();
    _delayedRestoreCheckTimer = null;
  }

  void _cancelSoftFallback() {
    _softFallbackTimer?.cancel();
    _softFallbackTimer = null;
    _softFallbackAwaitingRecovery = false;
  }

  web.AudioNode _outputDestination(web.AudioContext context) {
    final gain = _outputGain;
    if (gain != null) {
      return gain;
    }

    final nextGain = context.createGain();
    nextGain.gain.value = 1;
    nextGain.connect(context.destination);
    _outputGain = nextGain;
    return nextGain;
  }

  Future<void> _ensureWorkletRenderer(web.AudioContext context) async {
    if (_workletNode != null || _workletUnavailable) {
      return;
    }

    try {
      if (!_workletModuleLoaded) {
        await context.audioWorklet.addModule('kingz_pcm_worklet.js').toDart;
        _workletModuleLoaded = true;
      }
      final node = web.AudioWorkletNode(context, 'kingz-pcm-renderer');
      node.connect(_outputDestination(context));
      _workletNode = node;
    } catch (_) {
      _workletUnavailable = true;
    }
  }

  void _stopWorkletRenderer() {
    final node = _workletNode;
    _workletNode = null;
    if (node == null) {
      return;
    }

    try {
      node.port.postMessage(<String, Object>{'type': 'stop'}.jsify());
    } catch (_) {}
    try {
      node.disconnect();
    } catch (_) {}
  }

  void _disconnectOutputChain() {
    final gain = _outputGain;
    _outputGain = null;
    if (gain == null) {
      return;
    }

    try {
      gain.disconnect();
    } catch (_) {}
  }

  web.AudioNode _rebuildOutputChainWithFade(web.AudioContext context) {
    _logRecoveryState('gain-rebuild-start', reason: 'output-refresh');
    final oldGain = _outputGain;
    final nextGain = context.createGain();
    final now = context.currentTime;
    final fadeSeconds = _outputRefreshFade.inMilliseconds / 1000;

    nextGain.gain.value = 0;
    nextGain.gain.cancelScheduledValues(now);
    nextGain.gain.setValueAtTime(0, now);
    nextGain.gain.linearRampToValueAtTime(1, now + fadeSeconds);
    nextGain.connect(context.destination);
    _outputGain = nextGain;

    if (oldGain != null) {
      final scheduledLead = _scheduledAt <= now
          ? 0
          : min(_maxScheduleAheadSeconds, _scheduledAt - now);
      final cleanupDelay = Duration(
        milliseconds: ((scheduledLead + fadeSeconds) * 1000).round(),
      );

      Timer(cleanupDelay, () {
        try {
          oldGain.disconnect();
        } catch (_) {}
      });
    }

    _logRecoveryState('gain-rebuild-end', reason: 'output-refresh');
    return nextGain;
  }

  void _scheduleOutputRefreshProbe(String reason) {
    if (!_active || web.document.hidden) {
      _logRecoveryState(
        'output-refresh-probe-skipped',
        reason: reason,
        detail: !_active ? 'inactive' : 'hidden',
      );
      return;
    }

    _cancelOutputRefreshProbe();
    _logRecoveryState('output-refresh-probe-scheduled', reason: reason);
    _outputRefreshProbeTimer = Timer(_outputRefreshGrace, () {
      _maybeRefreshOutputChain(reason);
    });
  }

  void _maybeRefreshOutputChain(String reason) {
    final context = _context;
    if (!_active ||
        web.document.hidden ||
        context == null ||
        context.state != 'running') {
      _logRecoveryState(
        'output-refresh-skipped',
        reason: reason,
        detail: !_active
            ? 'inactive'
            : web.document.hidden
                ? 'hidden'
                : context == null
                    ? 'no-context'
                    : 'context-${context.state}',
      );
      return;
    }

    final now = DateTime.now();
    final lastPcmArrivedAt = _lastPcmArrivedAt;
    final pcmStillArriving = lastPcmArrivedAt != null &&
        now.difference(lastPcmArrivedAt) <= _pcmArrivalWindow;
    final supposedToBePlaying = _telemetry.outputActive || _sources.isNotEmpty;
    final lastOutputRefreshAt = _lastOutputRefreshAt;
    final refreshDebounced = lastOutputRefreshAt != null &&
        now.difference(lastOutputRefreshAt) < _outputRefreshDebounce;

    if (!pcmStillArriving || !supposedToBePlaying || refreshDebounced) {
      _logRecoveryState(
        'output-refresh-skipped',
        reason: reason,
        detail: !pcmStillArriving
            ? 'pcm-not-arriving'
            : !supposedToBePlaying
                ? 'not-supposed-playing'
                : 'debounced',
      );
      return;
    }

    _logRecoveryState('output-refresh-start', reason: reason);
    web.console.log(
      _structuredLog(
        'output refresh triggered',
        event: 'output-refresh-triggered',
        reason: reason,
      ).toJS,
    );
    _lastOutputRefreshAt = now;
    _rebuildOutputChainWithFade(context);
    web.console.log(
      _structuredLog(
        'output chain rebuilt',
        event: 'output-chain-rebuilt',
        reason: reason,
      ).toJS,
    );
    _logRecoveryState('output-refresh-end', reason: reason);
    _scheduleSoftFallbackAfterRefresh(reason);

    Timer(const Duration(milliseconds: 250), () {
      final lastPcmArrivedAt = _lastPcmArrivedAt;
      if (_active &&
          !web.document.hidden &&
          _context?.state == 'running' &&
          lastPcmArrivedAt != null &&
          DateTime.now().difference(lastPcmArrivedAt) <= _pcmArrivalWindow) {
        web.console.log(
          _structuredLog(
            'audio recovered',
            event: 'output-refresh-recovered',
            reason: reason,
          ).toJS,
        );
      }
    });
  }

  void _scheduleSoftFallbackAfterRefresh(String reason) {
    _softFallbackTimer?.cancel();
    _logRecoveryState('soft-fallback-timer-scheduled', reason: reason);
    _softFallbackTimer = Timer(_softFallbackGrace, () {
      unawaited(_maybeSoftStopPlayFallback(reason));
    });
  }

  void _scheduleSilentOutputRefreshProbe(String reason) {
    if (!_active || web.document.hidden) {
      return;
    }

    _silentOutputRefreshTimer?.cancel();
    _silentOutputRefreshTimer = Timer(_silentOutputRefreshGrace, () {
      unawaited(_maybeSilentOutputRefresh(reason));
    });
  }

  Future<void> _maybeSilentOutputRefresh(String reason) async {
    if (_silentOutputRefreshInFlight || !_active || web.document.hidden) {
      return;
    }

    final now = DateTime.now();
    final lastRefreshAt = _lastSilentOutputRefreshAt;
    if (lastRefreshAt != null &&
        now.difference(lastRefreshAt) < _silentOutputRefreshCooldown) {
      _logAudioRecovery('skipped-cooldown', reason);
      _logRecoveryState(
        'silent-output-refresh-skipped',
        reason: reason,
        detail: 'cooldown',
      );
      return;
    }

    if (!_isSilentOutputRefreshCandidate(now)) {
      _logRecoveryState(
        'silent-output-refresh-skipped',
        reason: reason,
        detail: 'guard-not-met',
      );
      return;
    }

    _silentOutputRefreshInFlight = true;
    _lastSilentOutputRefreshAt = now;
    _logAudioRecovery('silent-output-suspected', reason);
    _logRecoveryState(
      'silent-output-suspected',
      reason: reason,
      detail:
          'ctx=${_context?.state ?? 'none'} outputActive=${_telemetry.outputActive} awaitingRestart=$_awaitingOutputRestart',
    );

    try {
      final context = _context;
      if (context == null || context.state == 'closed') {
        return;
      }

      _logAudioRecovery('lightweight-output-refresh-start', reason);
      _logRecoveryState('lightweight-output-refresh-start', reason: reason);
      if (context.state == 'suspended' || context.state == 'interrupted') {
        try {
          await context.resume().toDart;
        } catch (_) {}
      }
      if (context.state == 'running') {
        _lastOutputRefreshAt = DateTime.now();
        _rebuildOutputChainWithFade(context);
      }
      _logAudioRecovery('lightweight-output-refresh-complete', reason);
      _logRecoveryState(
        'lightweight-output-refresh-complete',
        reason: reason,
        detail: 'ctx=${context.state}',
      );
    } finally {
      _silentOutputRefreshInFlight = false;
    }
  }

  void _scheduleDelayedRestoreCheck(String reason) {
    if (!_active || web.document.hidden) {
      return;
    }

    final generation = _playbackControlGeneration;
    _delayedRestoreCheckTimer?.cancel();
    _logAudioRecovery('route-reacquire-check-scheduled', reason);
    _logRecoveryState(
      'route-reacquire-check-scheduled',
      reason: reason,
      detail: 'generation=$generation delays=1800ms,6500ms',
    );
    Timer(const Duration(milliseconds: 1800), () {
      unawaited(_maybeDelayedRestoreCheck('$reason-1800ms', generation));
    });
    _delayedRestoreCheckTimer = Timer(
      const Duration(milliseconds: 6500),
      () {
        unawaited(_maybeDelayedRestoreCheck('$reason-6500ms', generation));
      },
    );
  }

  Future<void> _maybeDelayedRestoreCheck(
    String reason,
    int scheduledGeneration,
  ) async {
    _logAudioRecovery('route-reacquire-check-run', reason);
    if (_playbackControlGeneration != scheduledGeneration) {
      _logAudioRecovery('route-reacquire-skipped', reason);
      _logRecoveryState(
        'route-reacquire-check-skipped',
        reason: reason,
        detail:
            'playback-control-generation-changed scheduled=$scheduledGeneration current=$_playbackControlGeneration',
      );
      return;
    }

    if (_silentOutputRefreshInFlight || !_active || web.document.hidden) {
      _logAudioRecovery('route-reacquire-skipped', reason);
      _logRecoveryState(
        'route-reacquire-check-skipped',
        reason: reason,
        detail: _silentOutputRefreshInFlight
            ? 'in-flight'
            : !_active
                ? 'inactive'
                : 'hidden',
      );
      return;
    }

    final now = DateTime.now();
    final lastRefreshAt = _lastSilentOutputRefreshAt;
    if (lastRefreshAt != null &&
        now.difference(lastRefreshAt) < _silentOutputRefreshCooldown) {
      _logAudioRecovery('route-reacquire-skipped', reason);
      _logRecoveryState(
        'route-reacquire-check-skipped',
        reason: reason,
        detail: 'cooldown',
      );
      return;
    }

    if (!_isDelayedRestoreCheckCandidate(now)) {
      _logAudioRecovery('route-reacquire-skipped', reason);
      _logRecoveryState(
        'route-reacquire-check-skipped',
        reason: reason,
        detail: 'guard-not-met',
      );
      return;
    }

    _silentOutputRefreshInFlight = true;
    _lastSilentOutputRefreshAt = now;
    _logAudioRecovery('route-reacquire-suspected', reason);
    _logRecoveryState(
      'route-reacquire-suspected',
      reason: reason,
      detail:
          'ctx=${_context?.state ?? 'none'} outputActive=${_telemetry.outputActive} generation=$scheduledGeneration',
    );

    try {
      final context = _context;
      if (context == null || context.state == 'closed') {
        return;
      }

      _logAudioRecovery('route-reacquire-refresh-start', reason);
      _logRecoveryState(
        'route-reacquire-refresh-start',
        reason: reason,
      );
      if (context.state == 'suspended' || context.state == 'interrupted') {
        try {
          await context.resume().toDart;
        } catch (_) {}
      }
      if (context.state == 'running') {
        _lastOutputRefreshAt = DateTime.now();
        _rebuildOutputChainWithFade(context);
      }
      _logAudioRecovery('route-reacquire-refresh-complete', reason);
      _logRecoveryState(
        'route-reacquire-refresh-complete',
        reason: reason,
        detail: 'ctx=${context.state}',
      );
    } finally {
      _silentOutputRefreshInFlight = false;
    }
  }

  Future<void> _maybeSoftStopPlayFallback(String reason) async {
    if (_softFallbackInFlight) {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: 'in-flight',
      );
      return;
    }
    if (!_active) {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: 'inactive',
      );
      return;
    }
    if (web.document.hidden) {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: 'hidden',
      );
      return;
    }
    if (_awaitingOutputRestart) {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: 'awaiting-output-restart',
      );
      return;
    }

    final context = _context;
    if (context == null || context.state != 'running') {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: context == null ? 'no-context' : 'context-${context.state}',
      );
      return;
    }

    final now = DateTime.now();
    final lastPcmArrivedAt = _lastPcmArrivedAt;
    final pcmStillArriving = lastPcmArrivedAt != null &&
        now.difference(lastPcmArrivedAt) <= _pcmArrivalWindow;
    final supposedToBePlaying = _telemetry.outputActive || _sources.isNotEmpty;
    final lastOutputRefreshAt = _lastOutputRefreshAt;
    final refreshedRecently = lastOutputRefreshAt != null &&
        now.difference(lastOutputRefreshAt) >= _softFallbackGrace &&
        now.difference(lastOutputRefreshAt) <
            _softFallbackGrace + const Duration(milliseconds: 900);
    final lastSoftFallbackAt = _lastSoftFallbackAt;
    final fallbackCoolingDown = lastSoftFallbackAt != null &&
        now.difference(lastSoftFallbackAt) < _softFallbackCooldown;

    if (!pcmStillArriving ||
        !supposedToBePlaying ||
        !refreshedRecently ||
        fallbackCoolingDown) {
      _logRecoveryState(
        'soft-fallback-skipped',
        reason: reason,
        detail: !pcmStillArriving
            ? 'pcm-not-arriving'
            : !supposedToBePlaying
                ? 'not-supposed-playing'
                : !refreshedRecently
                    ? 'refresh-window-expired'
                    : 'cooldown',
      );
      return;
    }

    _softFallbackInFlight = true;
    _lastSoftFallbackAt = now;
    web.console.log(
      _structuredLog(
        'light refresh failed',
        event: 'light-refresh-failed',
        reason: reason,
      ).toJS,
    );
    web.console.log(
      _structuredLog(
        'soft stop-play fallback triggered',
        event: 'soft-fallback-triggered',
        reason: reason,
      ).toJS,
    );
    _logRecoveryState('soft-fallback-start', reason: reason);

    try {
      final contextStateBefore = context.state;
      _generation += 1;
      _stopSources();
      _disconnectOutputChain();
      _scheduledAt = context.currentTime + _resumeLeadSeconds;
      _awaitingOutputRestart = true;
      _manualResumeRequired = false;
      _softFallbackAwaitingRecovery = true;
      _lastResumeResult = 'soft-fallback';
      _updateTelemetry(outputActive: false, stateOverride: 'soft-fallback');

      try {
        _logRecoveryState(
          'soft-fallback-before-suspend',
          reason: reason,
          detail: 'ctx-before=$contextStateBefore',
        );
        await context.suspend().toDart;
      } catch (_) {}
      _logRecoveryState(
        'soft-fallback-after-suspend',
        reason: reason,
        detail: 'ctx-before=$contextStateBefore ctx-after=${context.state}',
      );
      await context.resume().toDart;
      _scheduledAt = context.currentTime + _resumeLeadSeconds;
      _lastResumeResult =
          context.state == 'running' ? 'soft-fallback-resumed' : context.state;
      _updateTelemetry(outputActive: false, stateOverride: _lastResumeResult);
      _logRecoveryState(
        'soft-fallback-after-resume',
        reason: reason,
        detail: 'ctx-before=$contextStateBefore ctx-after=${context.state}',
      );
      _drainQueuedPcmMessages();
      _logRecoveryState('soft-fallback-end', reason: reason);
    } catch (_) {
      _manualResumeRequired = true;
      _softFallbackAwaitingRecovery = false;
      _lastResumeResult = 'manual-required';
      _logDiagnostic('soft-fallback.failed');
      _logRecoveryState('soft-fallback-end', reason: reason, detail: 'failed');
      _updateTelemetry(outputActive: false, stateOverride: 'interrupted');
    } finally {
      _softFallbackInFlight = false;
      _logRecoveryState('soft-fallback-guard-cleared', reason: reason);
    }
  }

  void _logRecoveryState(
    String event, {
    required String reason,
    String detail = '',
  }) {
    web.console.log(
      _structuredLog(detail, event: event, reason: reason).toJS,
    );
  }

  String _structuredLog(
    String detail, {
    required String event,
    required String reason,
  }) {
    final context = _context;
    final now = DateTime.now();
    final lastPcmArrivedAt = _lastPcmArrivedAt;
    final lastOutputRefreshAt = _lastOutputRefreshAt;
    final lastSoftFallbackAt = _lastSoftFallbackAt;
    final pcmAgeMs = lastPcmArrivedAt == null
        ? -1
        : now.difference(lastPcmArrivedAt).inMilliseconds;
    final refreshAgeMs = lastOutputRefreshAt == null
        ? -1
        : now.difference(lastOutputRefreshAt).inMilliseconds;
    final fallbackAgeMs = lastSoftFallbackAt == null
        ? -1
        : now.difference(lastSoftFallbackAt).inMilliseconds;
    final fallbackCoolingDown = lastSoftFallbackAt != null &&
        now.difference(lastSoftFallbackAt) < _softFallbackCooldown;
    final bufferDepthMs = context == null
        ? 0
        : max(0, ((_scheduledAt - context.currentTime) * 1000).round());
    final schedulerState = _schedulerState();
    final expectedAudible = _expectedAudible(pcmAgeMs);
    final playbackState = _playbackState(expectedAudible);

    return 'KINGZ AUDIO RECOVERY ${jsonEncode(<String, Object>{
          'ts': now.toIso8601String(),
          'event': event,
          'reason': reason,
          'detail': detail,
          'visibility': web.document.visibilityState,
          'hidden': web.document.hidden,
          'focus': web.document.hasFocus(),
          'audioContextState': context?.state ?? 'none',
          'active': _active,
          'playbackState': playbackState,
          'schedulerState': schedulerState,
          'outputActive': _telemetry.outputActive,
          'expectedAudible': expectedAudible,
          'awaitingRestart': _awaitingOutputRestart,
          'softFallbackInFlight': _softFallbackInFlight,
          'softFallbackAwaitingRecovery': _softFallbackAwaitingRecovery,
          'softFallbackCooldown': fallbackCoolingDown,
          'pcmPacketArrivalCount': _pcmPacketArrivalCount,
          'pcmAgeMs': pcmAgeMs,
          'lastOutputRefreshAgeMs': refreshAgeMs,
          'lastSoftFallbackAgeMs': fallbackAgeMs,
          'queueDepth': _queuedPcmMessages.length,
          'scheduledSources': _sources.length,
          'bufferedMs': bufferDepthMs,
          'scheduledLeadMs': _scheduledLeadMs,
          'lastResumeResult': _lastResumeResult,
          'manualResumeRequired': _manualResumeRequired,
          'outputRestartCount': _outputRestartCount,
          'underrunCount': _underrunCount,
          'decodedSampleRate': _decodedSampleRate,
          'decodedChannels': _decodedChannels,
          'chunkDurationMs': _chunkDurationMs,
        })}';
  }

  void _logDiagnostic(String event) {
    final context = _context;
    final now = context?.currentTime ?? 0;
    final bufferDepthMs =
        context == null ? 0 : max(0, ((_scheduledAt - now) * 1000).round());
    const gainState = 'direct-output-unity';
    final schedulerState = _schedulerState();
    web.console.log(
      'KINGZ AUDIO DIAG ts=${DateTime.now().toIso8601String()} event=$event visibility=${web.document.visibilityState} hidden=${web.document.hidden} focus=${web.document.hasFocus()} ctx=${context?.state ?? 'none'} outputActive=${_telemetry.outputActive} expectedAudible=${_expectedAudible(_lastPcmArrivedAt == null ? -1 : DateTime.now().difference(_lastPcmArrivedAt!).inMilliseconds)} manualRequired=$_manualResumeRequired scheduler=$schedulerState sources=${_sources.length} queued=${_queuedPcmMessages.length} bufferDepthMs=$bufferDepthMs leadMs=$_scheduledLeadMs pcmPackets=$_pcmPacketArrivalCount resumeAttempts=$_resumeAttempts lastResume=$_lastResumeResult gain=$gainState pcmDecoded=$_decodedSampleRate/${_decodedChannels}ch chunkMs=$_chunkDurationMs'
          .toJS,
    );
  }

  String _schedulerState() {
    if (!_active) {
      return 'stopped';
    }
    if (_awaitingOutputRestart) {
      return 'awaiting-restart';
    }
    if (_sources.isNotEmpty) {
      return 'running';
    }
    return 'active-no-sources';
  }

  bool _expectedAudible(int pcmAgeMs) {
    final context = _context;
    return _active &&
        !web.document.hidden &&
        context?.state == 'running' &&
        (_telemetry.outputActive || _sources.isNotEmpty) &&
        pcmAgeMs >= 0 &&
        pcmAgeMs <= _pcmArrivalWindow.inMilliseconds;
  }

  String _playbackState(bool expectedAudible) {
    final context = _context;
    if (!_active) {
      return 'stopped';
    }
    if (_manualResumeRequired) {
      return 'manual-required';
    }
    if (_awaitingOutputRestart) {
      return 'recovering';
    }
    if (context == null) {
      return 'no-context';
    }
    if (context.state == 'suspended' || context.state == 'interrupted') {
      return context.state;
    }
    if (expectedAudible) {
      return 'playing';
    }
    return 'active-silent-or-idle';
  }

  bool _isSilentOutputRefreshCandidate(DateTime now) {
    final context = _context;
    final lastPcmArrivedAt = _lastPcmArrivedAt;
    final pcmActive = lastPcmArrivedAt != null &&
        now.difference(lastPcmArrivedAt) <= _pcmArrivalWindow;
    final outputStuck = context?.state == 'interrupted' ||
        context?.state == 'suspended' ||
        !_telemetry.outputActive ||
        _awaitingOutputRestart ||
        _lastResumeResult == 'pending';

    return _active &&
        !web.document.hidden &&
        pcmActive &&
        _hasUsableAudioData() &&
        outputStuck;
  }

  bool _isDelayedRestoreCheckCandidate(DateTime now) {
    final context = _context;
    if (context == null || context.state == 'closed') {
      return false;
    }

    final lastPcmArrivedAt = _lastPcmArrivedAt;
    final pcmActive = lastPcmArrivedAt != null &&
        now.difference(lastPcmArrivedAt) <= _pcmArrivalWindow;
    final audioContextCheckable = context.state == 'running' ||
        context.state == 'interrupted' ||
        context.state == 'suspended' ||
        _awaitingOutputRestart ||
        _lastResumeResult == 'pending';

    return _active &&
        !web.document.hidden &&
        pcmActive &&
        _hasUsableAudioData() &&
        audioContextCheckable &&
        _telemetry.outputActive;
  }

  bool _hasUsableAudioData() {
    final context = _context;
    final bufferedMs = context == null
        ? 0
        : max(0, ((_scheduledAt - context.currentTime) * 1000).round());
    return _queuedPcmMessages.isNotEmpty ||
        _sources.isNotEmpty ||
        bufferedMs >= 20;
  }

  void _logAudioRecovery(String event, String reason) {
    web.console.log('[audio-recovery] $event reason=$reason'.toJS);
  }

  void _queuePcmMessage(Map<String, dynamic> message) {
    _queuedPcmMessages.add(Map<String, dynamic>.from(message));
    while (_queuedPcmMessages.length > 8) {
      _queuedPcmMessages.removeAt(0);
    }
  }

  void _queuePcmBytes(
    typed.Uint8List bytes, {
    required int channels,
    required int sampleRate,
    required int bitDepth,
    required int chunkDurationMs,
  }) {
    _queuedPcmBytes.add(
      _QueuedPcmBytes(
        bytes: typed.Uint8List.fromList(bytes),
        channels: channels,
        sampleRate: sampleRate,
        bitDepth: bitDepth,
        chunkDurationMs: chunkDurationMs,
      ),
    );
    while (_queuedPcmBytes.length > 16) {
      _queuedPcmBytes.removeAt(0);
    }
  }

  void _drainQueuedPcmMessages() {
    if (_queuedPcmMessages.isEmpty && _queuedPcmBytes.isEmpty) {
      return;
    }

    final queuedBytes = List<_QueuedPcmBytes>.from(_queuedPcmBytes);
    _queuedPcmBytes.clear();
    for (final packet in queuedBytes) {
      if (!_active || _context?.state != 'running') {
        _queuePcmBytes(
          packet.bytes,
          channels: packet.channels,
          sampleRate: packet.sampleRate,
          bitDepth: packet.bitDepth,
          chunkDurationMs: packet.chunkDurationMs,
        );
        return;
      }
      enqueueBytes(
        packet.bytes,
        channels: packet.channels,
        sampleRate: packet.sampleRate,
        bitDepth: packet.bitDepth,
        chunkDurationMs: packet.chunkDurationMs,
      );
      if (!_awaitingOutputRestart) {
        return;
      }
    }

    final queued = List<Map<String, dynamic>>.from(_queuedPcmMessages);
    _queuedPcmMessages.clear();
    for (final message in queued) {
      if (!_active || _context?.state != 'running') {
        _queuePcmMessage(message);
        return;
      }
      enqueue(message);
      if (!_awaitingOutputRestart) {
        return;
      }
    }
  }
}
