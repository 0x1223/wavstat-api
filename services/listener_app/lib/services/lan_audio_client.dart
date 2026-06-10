import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/listener_playback_state.dart';
import '../models/realtime_stream_metrics.dart';
import '../models/stream_telemetry.dart';
import '../models/transport_config.dart';
import 'buffer_controller_service.dart';
import 'listener_audio_engine_service.dart';
import 'pcm_playback_bridge.dart';
import 'realtime_stream_listener.dart';
import 'transport_telemetry_service.dart';
import 'webrtc_playback_bridge.dart';

enum LanAudioConnectionState {
  disconnected,
  connected,
  reconnecting,
  error,
}

class LanAudioEvent {
  const LanAudioEvent({
    this.connectionState,
    this.telemetry,
    this.realtimeMetrics,
    this.playbackState,
    this.transportConfig,
    this.streamStatus,
    this.streamUrl,
    this.durationLabel,
    this.errorMessage,
  });

  final LanAudioConnectionState? connectionState;
  final StreamTelemetry? telemetry;
  final RealtimeStreamMetrics? realtimeMetrics;
  final ListenerPlaybackState? playbackState;
  final TransportConfig? transportConfig;
  final String? streamStatus;
  final Uri? streamUrl;
  final String? durationLabel;
  final String? errorMessage;
}

class LanAudioClient {
  final StreamController<LanAudioEvent> _events =
      StreamController<LanAudioEvent>.broadcast();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _clientPingTimer;
  Timer? _reconnectTimer;
  Timer? _startRetryTimer;
  Timer? _pcmIdleTimer;
  Uri? _uri;
  MonitoringMode? _pendingStartMode;
  MonitoringMode? _activeStartMode;
  bool _manualDisconnect = false;
  bool _wasListening = false;
  bool _isOpening = false;
  bool _isDisposed = false;
  int _reconnectAttempts = 0;
  int _reconnectCount = 0;
  StreamTelemetry _latestTelemetry = const StreamTelemetry();
  final RealtimeStreamListener _realtimeStreamListener =
      RealtimeStreamListener();
  final ListenerAudioEngineService _audioEngineService =
      ListenerAudioEngineService();
  final BufferControllerService _bufferControllerService =
      BufferControllerService();
  final WebRtcPlaybackBridge _webRtcPlaybackBridge = WebRtcPlaybackBridge();
  final PcmPlaybackBridge _pcmPlaybackBridge = PcmPlaybackBridge();
  final TransportTelemetryService _transportTelemetryService =
      TransportTelemetryService();
  bool _webRtcActive = false;
  bool _pcmFallbackActive = false;
  bool _pcmFallbackAllowed = false;

  LanAudioClient() {
    _webRtcPlaybackBridge.onTelemetry = _emitPlaybackTelemetry;
    _pcmPlaybackBridge.onTelemetry = _emitPlaybackTelemetry;
    _webRtcPlaybackBridge
        .configureTransport(_audioEngineService.transportConfig);
    _pcmPlaybackBridge.configureTransport(_audioEngineService.transportConfig);
    debugPrint('[KINGZ] LanAudioClient: bridge=${_pcmPlaybackBridge.telemetry.audioContextState} kIsWeb=$kIsWeb');
  }

  Stream<LanAudioEvent> get events => _events.stream;

  Future<void> connect(Uri uri) async {
    debugPrint('[KINGZ] connect: uri=$uri');
    await _subscription?.cancel();
    _subscription = null;
    _uri = uri;
    _manualDisconnect = false;
    _reconnectAttempts = 0;
    _reconnectCount = 0;
    await _open(uri, isReconnect: false);
  }

  Future<void> disconnect() async {
    _manualDisconnect = true;
    _reconnectTimer?.cancel();
    _clientPingTimer?.cancel();
    _startRetryTimer?.cancel();
    _pcmIdleTimer?.cancel();
    await _subscription?.cancel();
    await _channel?.sink.close();
    _channel = null;
    _subscription = null;
    _reconnectCount = 0;
    _webRtcActive = false;
    _pcmFallbackActive = false;
    _pcmFallbackAllowed = false;
    await _webRtcPlaybackBridge.stop();
    await _pcmPlaybackBridge.stop();
    _latestTelemetry = const StreamTelemetry();
    final realtimeMetrics = _realtimeStreamListener.reset();
    _events.add(
      LanAudioEvent(
        connectionState: LanAudioConnectionState.disconnected,
        telemetry: const StreamTelemetry(),
        realtimeMetrics: realtimeMetrics,
        streamStatus: 'disconnected',
        durationLabel: '--:--',
      ),
    );
  }

  void prepare(MonitoringMode mode) {
    final state = _audioEngineService.selectMode(mode);
    _webRtcPlaybackBridge.configureTransport(state.transportConfig);
    _pcmPlaybackBridge.configureTransport(state.transportConfig);
    _events.add(
      LanAudioEvent(
        playbackState: state.playbackState,
        transportConfig: state.transportConfig,
      ),
    );
    _send({'type': 'listen.prepare', 'mode': mode.wireValue});
  }

  Future<bool> startListening(
    MonitoringMode mode, {
    bool enablePcmPlayback = false,
  }) async {
    debugPrint('[KINGZ] startListening: mode=$mode enablePcmPlayback=$enablePcmPlayback kIsWeb=$kIsWeb');
    _wasListening = true;
    _pcmFallbackAllowed = enablePcmPlayback;
    _pcmFallbackActive = false;
    final state = _audioEngineService.selectMode(mode);
    _webRtcPlaybackBridge.configureTransport(state.transportConfig);
    _pcmPlaybackBridge.configureTransport(state.transportConfig);
    _realtimeStreamListener.startSession();
    await _pcmPlaybackBridge.stop();
    var playbackTelemetry = _webRtcPlaybackBridge.telemetry;
    if (enablePcmPlayback) {
      try {
        _webRtcActive = await _webRtcPlaybackBridge.start(
          sendSignal: _send,
          onFallback: (reason) {
            unawaited(_startPcmFallback(reason));
          },
        );
      } catch (_) {
        _webRtcActive = false;
      }
      if (!_webRtcActive) {
        playbackTelemetry = await _startPcmFallback('webrtc-start-failed');
      }
    } else {
      _webRtcActive = false;
      await _webRtcPlaybackBridge.stop();
      playbackTelemetry = await _pcmPlaybackBridge.stop();
    }
    _events.add(
      LanAudioEvent(
        playbackState: state.playbackState,
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry),
        transportConfig: _bufferControllerService.reset(state.transportConfig),
      ),
    );
    _sendStart(mode);
    return _webRtcActive || playbackTelemetry.outputActive;
  }

  Future<void> stopListening() async {
    _wasListening = false;
    _activeStartMode = null;
    _startRetryTimer?.cancel();
    _pcmIdleTimer?.cancel();
    _webRtcActive = false;
    _pcmFallbackActive = false;
    _pcmFallbackAllowed = false;
    await _webRtcPlaybackBridge.stop();
    final playbackTelemetry = await _pcmPlaybackBridge.stop();
    _realtimeStreamListener.stopped();
    _events.add(
      LanAudioEvent(
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry),
        transportConfig:
            _bufferControllerService.reset(_audioEngineService.transportConfig),
      ),
    );
    _send({'type': 'listen.stop'});
  }

  Future<void> resumeAudioOutput() async {
    final playbackTelemetry = _pcmFallbackActive
        ? await _pcmPlaybackBridge.manualResume()
        : await _webRtcPlaybackBridge.manualResume();
    _events.add(
      LanAudioEvent(
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry),
      ),
    );
  }

  Future<void> dispose() async {
    _isDisposed = true;
    _startRetryTimer?.cancel();
    _pcmIdleTimer?.cancel();
    await disconnect();
    await _webRtcPlaybackBridge.dispose();
    await _pcmPlaybackBridge.dispose();
    await _events.close();
  }

  Future<void> _open(Uri uri, {required bool isReconnect}) async {
    if (_isOpening || _manualDisconnect || _isDisposed) {
      return;
    }

    _isOpening = true;
    _reconnectTimer?.cancel();
    _clientPingTimer?.cancel();
    _startRetryTimer?.cancel();
    _pcmIdleTimer?.cancel();

    if (isReconnect) {
      _events.add(
        LanAudioEvent(
          connectionState: LanAudioConnectionState.reconnecting,
          streamStatus: 'reconnecting',
          realtimeMetrics: _realtimeStreamListener.reconnecting(
            reconnectCount: _reconnectCount,
          ),
          telemetry: _latestTelemetry.copyWith(
            bufferStatus: 'Reconnecting',
            networkStatus: 'Restoring LAN stream',
          ),
        ),
      );
    }

    try {
      final channel = WebSocketChannel.connect(uri);
      _channel = channel;
      await _subscription?.cancel();
      _subscription = channel.stream.listen(
        _handleMessage,
        onError: (_) => _handleConnectionLoss(),
        onDone: _handleConnectionLoss,
        cancelOnError: true,
      );
      await channel.ready;
      if (_channel != channel || _manualDisconnect || _isDisposed) {
        return;
      }
      _reconnectAttempts = 0;
      _events.add(
        const LanAudioEvent(
          connectionState: LanAudioConnectionState.connected,
          streamStatus: 'connected',
        ),
      );
      _startClientPing();
      _isOpening = false;
      if (isReconnect && _wasListening) {
        if (_pcmFallbackAllowed && !_pcmFallbackActive) {
          unawaited(
            _restartWebRtcAfterReconnect(),
          );
        }
        _sendStart(_audioEngineService.transportConfig.mode);
      } else if (_pendingStartMode != null) {
        final mode = _pendingStartMode;
        _pendingStartMode = null;
        _sendStart(mode!);
      }
    } catch (_) {
      _events.add(
        const LanAudioEvent(
          connectionState: LanAudioConnectionState.error,
          errorMessage: 'Unable to connect',
        ),
      );
      _scheduleReconnect();
    } finally {
      _isOpening = false;
    }
  }

  void _handleMessage(dynamic rawMessage) {
    if (rawMessage is! String) {
      return;
    }

    Map<String, dynamic> message;
    try {
      message = jsonDecode(rawMessage) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final type = message['type'] as String?;

    if (type == 'webrtc.answer' ||
        type == 'webrtc.ice-candidate' ||
        type == 'webrtc.connected' ||
        type == 'webrtc.ping' ||
        type == 'webrtc.error') {
      if (type == 'webrtc.ping') {
        _send({'type': 'webrtc.pong', 'sentAt': message['sentAt']});
        return;
      }
      unawaited(_webRtcPlaybackBridge.handleSignal(message));
      return;
    }

    if (type == 'pong') {
      final sentAt = message['sentAt'];
      if (sentAt is int) {
        final pingMs = DateTime.now().millisecondsSinceEpoch - sentAt;
        _latestTelemetry = _latestTelemetry.copyWith(latency: '$pingMs ms');
        _events.add(LanAudioEvent(telemetry: _latestTelemetry));
      }
      return;
    }

    if (type == 'realtime.audio.chunk' ||
        type == 'realtime.pcm.chunk' ||
        type == 'pcm.chunk') {
      _startRetryTimer?.cancel();
      final realtimeMetrics = _realtimeStreamListener.handleChunk(message);
      final playbackTelemetry = _pcmFallbackActive
          ? _pcmPlaybackBridge.enqueue(message)
          : _webRtcPlaybackBridge.telemetry;
      final playbackMetrics =
          _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry);
      _armPcmIdleTimer();
      final engineState = _audioEngineService.applyEngine(_readEngine(message));
      final transportConfig = _bufferControllerService.updateFromChunk(
        engineState.transportConfig,
        receivedPackets: realtimeMetrics.receivedPackets,
        droppedPackets: realtimeMetrics.droppedPackets,
        simulatedUnderruns: realtimeMetrics.simulatedUnderrunCount,
      );
      _latestTelemetry = _transportTelemetryService.updateFromRealtime(
        playbackMetrics,
        _latestTelemetry,
      );
      _events.add(
        LanAudioEvent(
          telemetry: _latestTelemetry,
          realtimeMetrics: playbackMetrics,
          playbackState: engineState.playbackState,
          transportConfig: transportConfig,
          streamStatus: 'playing',
        ),
      );
      return;
    }

    if (type == 'connection.status') {
      final engineState = _audioEngineService.applyEngine(_readEngine(message));
      _events.add(
        LanAudioEvent(
          connectionState: LanAudioConnectionState.connected,
          streamStatus: 'connected',
          playbackState: engineState.playbackState,
          transportConfig: engineState.transportConfig,
          streamUrl: _parseUri(message['streamUrl']),
          durationLabel: _parseDuration(message),
        ),
      );
      return;
    }

    if (type == 'stream.status' ||
        type == 'stream.telemetry' ||
        type == 'engine.status') {
      final engineState = _audioEngineService.applyEngine(_readEngine(message));
      _latestTelemetry = _transportTelemetryService.updateFromJson(
        message,
        _latestTelemetry,
      );
      if (_realtimeStreamListener.metrics.receivedPackets > 0) {
        final realtimeMetrics = _realtimeStreamListener.metrics;
        _latestTelemetry = _transportTelemetryService.updateFromRealtime(
          realtimeMetrics,
          _latestTelemetry,
        );
      }
      _events.add(
        LanAudioEvent(
          telemetry: _latestTelemetry,
          realtimeMetrics: _realtimeStreamListener.metrics,
          playbackState: engineState.playbackState,
          transportConfig: engineState.transportConfig,
          streamStatus: message['status'] as String?,
          streamUrl: _parseUri(message['streamUrl']),
          durationLabel: _parseDuration(message),
        ),
      );
    }
  }

  void _handleConnectionLoss() {
    debugPrint('[KINGZ] _handleConnectionLoss: manualDisconnect=$_manualDisconnect isDisposed=$_isDisposed');
    if (_manualDisconnect || _isDisposed) {
      return;
    }

    _clientPingTimer?.cancel();
    _pcmIdleTimer?.cancel();
    _webRtcActive = false;
    _channel = null;
    _subscription = null;
    _scheduleReconnect();
  }

  void _emitPlaybackTelemetry(PcmPlaybackTelemetry telemetry) {
    if (_isDisposed || _events.isClosed) {
      return;
    }

    _events.add(
      LanAudioEvent(
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(telemetry),
      ),
    );
  }

  void _scheduleReconnect() {
    if (_manualDisconnect ||
        _uri == null ||
        _reconnectTimer?.isActive == true) {
      return;
    }

    _reconnectAttempts += 1;
    _reconnectCount += 1;
    _events.add(
      LanAudioEvent(
        connectionState: LanAudioConnectionState.reconnecting,
        streamStatus: 'reconnecting',
        telemetry: _latestTelemetry.copyWith(
          bufferStatus: 'Reconnecting',
          networkStatus: 'Restoring LAN stream',
        ),
        realtimeMetrics: _realtimeStreamListener.reconnecting(
          reconnectCount: _reconnectCount,
        ),
      ),
    );

    final delaySeconds = _reconnectAttempts.clamp(1, 5);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(seconds: delaySeconds), () {
      final uri = _uri;
      if (uri != null) {
        _open(uri, isReconnect: true);
      }
    });
  }

  void _startClientPing() {
    _clientPingTimer?.cancel();
    _clientPingTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      _send({
        'type': 'client.ping',
        'sentAt': DateTime.now().millisecondsSinceEpoch,
      });
    });
  }

  Future<PcmPlaybackTelemetry> _startPcmFallback(String reason) async {
    if (!_pcmFallbackAllowed ||
        !_wasListening ||
        _manualDisconnect ||
        _isDisposed ||
        _pcmFallbackActive) {
      return _pcmPlaybackBridge.telemetry;
    }

    _webRtcActive = false;
    _pcmFallbackActive = true;
    await _webRtcPlaybackBridge.stop();
    final playbackTelemetry = await _pcmPlaybackBridge.start();
    _events.add(
      LanAudioEvent(
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry),
        streamStatus: 'pcm_fallback_$reason',
      ),
    );
    return playbackTelemetry;
  }

  Future<void> _restartWebRtcAfterReconnect() async {
    try {
      _webRtcActive = await _webRtcPlaybackBridge.start(
        sendSignal: _send,
        onFallback: (reason) {
          unawaited(_startPcmFallback(reason));
        },
      );
    } catch (_) {
      _webRtcActive = false;
    }

    if (!_webRtcActive) {
      await _startPcmFallback('webrtc-reconnect-failed');
    }
  }

  void _send(Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null || _manualDisconnect || _isDisposed) {
      return;
    }

    try {
      channel.sink.add(jsonEncode(payload));
    } catch (e) {
      debugPrint('[KINGZ] _send error (type=${payload['type']}): $e');
      _handleConnectionLoss();
    }
  }

  void _sendStart(MonitoringMode mode) {
    if (_channel == null || _isOpening) {
      _pendingStartMode = mode;
      return;
    }

    _pendingStartMode = null;
    _activeStartMode = mode;
    _send({'type': 'listen.start', 'mode': mode.wireValue});
    _armStartRetry();
  }

  void _armStartRetry() {
    _startRetryTimer?.cancel();
    var attempts = 0;
    _startRetryTimer =
        Timer.periodic(const Duration(milliseconds: 350), (timer) {
      final mode = _activeStartMode;
      if (!_wasListening ||
          mode == null ||
          _realtimeStreamListener.metrics.receivedPackets > 0) {
        timer.cancel();
        return;
      }

      attempts += 1;
      if (attempts > 4) {
        timer.cancel();
        return;
      }

      _send({'type': 'listen.start', 'mode': mode.wireValue});
    });
  }

  void _armPcmIdleTimer() {
    _pcmIdleTimer?.cancel();
    _pcmIdleTimer = Timer(const Duration(seconds: 2), () {
      if (!_wasListening || _manualDisconnect || _isDisposed) {
        return;
      }

      final realtimeMetrics = _realtimeStreamListener.markIdle();
      _latestTelemetry = _transportTelemetryService.updateFromRealtime(
        realtimeMetrics,
        _latestTelemetry,
      );
      _events.add(
        LanAudioEvent(
          telemetry: _latestTelemetry,
          realtimeMetrics: realtimeMetrics,
          streamStatus: 'stream_lost',
        ),
      );
    });
  }

  Uri? _parseUri(dynamic value) {
    if (value is! String || value.isEmpty) {
      return null;
    }

    return Uri.tryParse(value);
  }

  String? _parseDuration(Map<String, dynamic> message) {
    final metadata = message['metadata'];
    if (metadata is! Map<String, dynamic>) {
      return null;
    }

    final duration = metadata['duration'];
    return duration is String ? duration : null;
  }

  Map<String, dynamic>? _readEngine(Map<String, dynamic> message) {
    final engine = message['engine'];
    return engine is Map<String, dynamic> ? engine : null;
  }
}
