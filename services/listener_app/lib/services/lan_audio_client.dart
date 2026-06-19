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
    this.streamTransport,
    this.streamStatus,
    this.streamUrl,
    this.durationLabel,
    this.dawTransportPlaying,
    this.dawTransportChanged,
    this.dawPositionSeconds,
    this.dawPpqPosition,
    this.dawBpm,
    this.errorMessage,
  });

  final LanAudioConnectionState? connectionState;
  final StreamTelemetry? telemetry;
  final RealtimeStreamMetrics? realtimeMetrics;
  final ListenerPlaybackState? playbackState;
  final TransportConfig? transportConfig;
  /// Broadcast codec the plugin currently dictates (LISTENTO-parity auto-follow). The UI shows
  /// this as a read-only indicator; the client switches transports automatically.
  final StreamTransport? streamTransport;
  final String? streamStatus;
  final Uri? streamUrl;
  final String? durationLabel;
  final bool? dawTransportPlaying;
  final bool? dawTransportChanged;
  final double? dawPositionSeconds;
  final double? dawPpqPosition;
  final double? dawBpm;
  final String? errorMessage;
}

class LanAudioClient {
  final StreamController<LanAudioEvent> _events =
      StreamController<LanAudioEvent>.broadcast();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _clientPingTimer;
  Timer? _reconnectTimer;
  Timer? _pcmIdleTimer;
  Uri? _uri;
  MonitoringMode? _pendingStartMode;
  bool _manualDisconnect = false;
  bool _wasListening = false;
  bool _isOpening = false;
  bool _isDisposed = false;
  int _reconnectAttempts = 0;
  int _reconnectCount = 0;
  int _lastTransportSyncSequence = 0;
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

  /// Selected wire transport (PCM data channel vs Opus audio track). Set by the UI; applied to the
  /// WebRTC bridge at the next startListening (renegotiation picks the m-lines). Default PCM.
  StreamTransport streamTransport = StreamTransport.pcm;

  LanAudioClient() {
    _webRtcPlaybackBridge.onTelemetry = _emitPlaybackTelemetry;
    _pcmPlaybackBridge.onTelemetry = _emitPlaybackTelemetry;
    _webRtcPlaybackBridge
        .configureTransport(_audioEngineService.transportConfig);
    _pcmPlaybackBridge.configureTransport(_audioEngineService.transportConfig);
    debugPrint(
        '[KINGZ] LanAudioClient: bridge=${_pcmPlaybackBridge.telemetry.audioContextState} kIsWeb=$kIsWeb');
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
    _pcmIdleTimer?.cancel();
    await _subscription?.cancel();
    await _channel?.sink.close();
    _channel = null;
    _subscription = null;
    _reconnectCount = 0;
    _webRtcActive = false;
    _pcmFallbackActive = false;
    _pcmFallbackAllowed = false;
    _resetTransportSync();
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
    debugPrint(
        '[KINGZ] startListening: ENTRY mode=$mode enablePcmPlayback=$enablePcmPlayback kIsWeb=$kIsWeb channel=${_channel != null}');
    _wasListening = true;
    _resetTransportSync();
    _pcmFallbackAllowed = enablePcmPlayback;
    _pcmFallbackActive = false;
    final state = _audioEngineService.selectMode(mode);
    _webRtcPlaybackBridge.configureTransport(state.transportConfig);
    _pcmPlaybackBridge.configureTransport(state.transportConfig);
    _webRtcPlaybackBridge.transport = streamTransport; // PCM data channel vs Opus audio track
    _realtimeStreamListener.startSession();
    await _pcmPlaybackBridge.stop();
    await _webRtcPlaybackBridge.resetToLiveEdge(reason: 'listen-start');
    var playbackTelemetry = _webRtcPlaybackBridge.telemetry;
    if (enablePcmPlayback) {
      try {
        _webRtcPlaybackBridge.onPlaybackStarted = () {
          debugPrint(
              '[KINGZ] startListening: WebRTC playback started (first PCM packet)');
          _events.add(
            const LanAudioEvent(
              streamStatus: 'playing',
            ),
          );
        };
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
    final result = _webRtcActive || playbackTelemetry.outputActive;
    debugPrint('[KINGZ] startListening: _webRtcActive=$_webRtcActive');
    debugPrint(
        '[KINGZ] startListening: playbackTelemetry.outputActive=${playbackTelemetry.outputActive}');
    debugPrint(
        '[KINGZ] startListening: playbackTelemetry.audioContextState=${playbackTelemetry.audioContextState}');
    debugPrint('[KINGZ] startListening: EXIT returning $result');
    return result;
  }

  Future<void> resetPlaybackToLiveEdge({String reason = 'live-edge'}) async {
    if (!_wasListening || _manualDisconnect || _isDisposed) {
      return;
    }

    final playbackTelemetry = _pcmFallbackActive
        ? await _pcmPlaybackBridge.resetToLiveEdge(reason: reason)
        : await _webRtcPlaybackBridge.resetToLiveEdge(reason: reason);
    _events.add(
      LanAudioEvent(
        realtimeMetrics:
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry),
      ),
    );
  }

  Future<void> stopListening() async {
    _wasListening = false;
    _pcmIdleTimer?.cancel();
    _resetTransportSync();
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
        debugPrint('[KINGZ] _open: RECONNECT - WebRTC will re-negotiate');
      } else if (_pendingStartMode != null) {
        final mode = _pendingStartMode;
        _pendingStartMode = null;
        debugPrint(
            '[KINGZ] _open: PENDING mode - will initiate WebRTC with mode=$mode');
      } else {
        debugPrint(
            '[KINGZ] _open: INITIAL connection - WebRTC signaling will begin on startListening()');
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
      debugPrint(
          '[KINGZ] _handleMessage: received non-string (${rawMessage.runtimeType})');
      return;
    }

    Map<String, dynamic> message;
    try {
      message = jsonDecode(rawMessage) as Map<String, dynamic>;
    } catch (e, st) {
      debugPrint('[KINGZ] _handleMessage: JSON decode failed: $e\n$st');
      _events.add(
        LanAudioEvent(
          connectionState: LanAudioConnectionState.error,
          errorMessage:
              'Malformed server message: ${e.toString().split('\n').first}',
        ),
      );
      return;
    }

    final type = message['type'] as String?;
    if (type != 'transport.sync' && type != 'transport.state') {
      debugPrint('[KINGZ] _handleMessage: RECEIVED type=$type');
    }

    if (type == 'transport.sync' || type == 'transport.state') {
      _handleTransportMessage(message,
          isStateMessage: type == 'transport.state');
      return;
    }

    if (type == 'transport.mode') {
      _handleTransportModeMessage(message);
      return;
    }

    if (type == 'webrtc.answer' ||
        type == 'webrtc-answer' ||
        type == 'webrtc.ice-candidate' ||
        type == 'webrtc-candidate' ||
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
      try {
        final realtimeMetrics = _realtimeStreamListener.handleChunk(message);
        final playbackTelemetry = _pcmFallbackActive
            ? _pcmPlaybackBridge.enqueue(message)
            : _webRtcPlaybackBridge.telemetry;
        final playbackMetrics =
            _realtimeStreamListener.withPlaybackTelemetry(playbackTelemetry);
        _armPcmIdleTimer();
        final engineState =
            _audioEngineService.applyEngine(_readEngine(message));
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
      } catch (e, st) {
        debugPrint(
            '[KINGZ] _handleMessage: PCM chunk processing failed: $e\n$st');
        _events.add(
          LanAudioEvent(
            connectionState: LanAudioConnectionState.error,
            errorMessage: 'PCM decode error: ${e.toString().split('\n').first}',
          ),
        );
      }
      return;
    }

    if (type == 'webrtc.data-channel-open' ||
        type == 'webrtc-data-channel-open') {
      debugPrint(
          '[KINGZ] _handleMessage: RECEIVED webrtc.data-channel-open - PCM channel ready');
      unawaited(_webRtcPlaybackBridge.updateStreamFormat(message));
      final engineState = _audioEngineService.applyEngine(_readEngine(message));
      _events.add(
        LanAudioEvent(
          connectionState: LanAudioConnectionState.connected,
          streamStatus: 'connected',
          playbackState: engineState.playbackState,
          transportConfig: engineState.transportConfig,
          durationLabel: _parseDuration(message),
        ),
      );
      return;
    }

    if (type == 'webrtc.error') {
      debugPrint(
          '[KINGZ] _handleMessage: RECEIVED webrtc.error - ${message['message']}');
      _events.add(
        const LanAudioEvent(
          connectionState: LanAudioConnectionState.error,
          streamStatus: 'webrtc-error',
          errorMessage: 'WebRTC signaling failed',
        ),
      );
      return;
    }
  }

  void _handleTransportMessage(
    Map<String, dynamic> message, {
    required bool isStateMessage,
  }) {
    // Live DAW format rides every transport.sync/state. Apply the source sample
    // rate continuously so playback stays rate-agnostic (44.1/48/88.2/96k...) and
    // self-heals within ~100ms, instead of trusting only the one-shot handshake.
    // Both bridges share the same native MethodChannel — sync both so that
    // subsequent configureTransport() calls (prepare, startListening) use the
    // correct rate and don't overwrite it with the fallback bridge's stale 48k default.
    final syncedRate = _readInt(message['sampleRate']);
    if (syncedRate > 0) {
      unawaited(_webRtcPlaybackBridge.updateStreamFormat(message));
      unawaited(_pcmPlaybackBridge.configureStreamSampleRate(syncedRate));
    }
    final sequence = _readInt(message['sequence']);
    final hostPlaying = message['hostPlaying'] == true;
    final targetLeadMs = _readInt(message['targetLeadMs']);
    final hostTimeSeconds = _readDouble(message['hostTimeSeconds']);
    final ppqPosition = _readDouble(message['ppqPosition']);
    final bpm = _readDouble(message['bpm']);
    final stateChanged = message['stateChanged'] == true;
    final droppedSyncs =
        !isStateMessage && _lastTransportSyncSequence > 0 && sequence > 0
            ? (sequence - _lastTransportSyncSequence - 1).clamp(0, 9999)
            : 0;

    if (!isStateMessage) {
      _lastTransportSyncSequence = sequence;
    }

    final leadLabel = targetLeadMs > 0 ? '$targetLeadMs ms target' : 'tracking';
    final transportLabel = hostPlaying ? 'DAW playing' : 'DAW stopped';
    _latestTelemetry = _latestTelemetry.copyWith(
      networkStatus: !isStateMessage && droppedSyncs > 0
          ? 'Sync catching up'
          : '$transportLabel / $leadLabel',
    );

    _events.add(
      LanAudioEvent(
        telemetry: _latestTelemetry,
        dawTransportPlaying: hostPlaying,
        dawTransportChanged: stateChanged,
        dawPositionSeconds: hostTimeSeconds,
        dawPpqPosition: ppqPosition,
        dawBpm: bpm,
      ),
    );
  }

  /// LISTENTO-parity auto-follow: the plugin (the engineer) dictates the broadcast codec via a
  /// `transport.mode` message (announced on connect and re-broadcast on every change). The listener
  /// adopts it automatically — no manual step. If a playback session is live and the codec actually
  /// changed, renegotiate invisibly (a brief automatic re-buffer at that instant is unavoidable for
  /// a codec/transport switch; steady-state and sample-rate changes stay seamless).
  void _handleTransportModeMessage(Map<String, dynamic> message) {
    // Auto-follow is native (iOS) only. The Flutter-web bridge has no Opus path and web-over-HTTP
    // can't host the worklet without HTTPS, so the web receiver stays PCM and ignores the broadcast
    // (showing "Opus" while playing PCM would be misleading; renegotiating it would just thrash).
    if (kIsWeb) {
      return;
    }
    final wire = (message['transport'] as String?)?.toLowerCase();
    final mode = wire == 'opus' ? StreamTransport.opus : StreamTransport.pcm;
    if (mode == streamTransport) {
      // Unchanged (e.g. the announce-on-connect echo): still surface so the UI indicator is right.
      _events.add(LanAudioEvent(streamTransport: streamTransport));
      return;
    }
    debugPrint(
        '[KINGZ] transport.mode: plugin switched ${streamTransport.wireValue} -> ${mode.wireValue}');
    streamTransport = mode;
    // Applied at the next startListening if no session is live; _applyTransportChange re-sets it.
    _webRtcPlaybackBridge.transport = mode;
    _events.add(LanAudioEvent(streamTransport: mode));
    if (_wasListening &&
        _pcmFallbackAllowed &&
        !_manualDisconnect &&
        !_isDisposed) {
      unawaited(_applyTransportChange());
    }
  }

  /// Tear down the live WebRTC session and renegotiate with the new transport's m-lines. An
  /// explicit stop() first is required so the native PCM engine is stopped when switching to Opus
  /// (start() only starts the native engine for PCM, never stops it for Opus) and rebuilt cleanly
  /// the other way.
  Future<void> _applyTransportChange() async {
    if (!_wasListening || _manualDisconnect || _isDisposed) {
      return;
    }
    _webRtcPlaybackBridge.transport = streamTransport;
    _pcmFallbackActive = false;
    await _webRtcPlaybackBridge.stop();
    await _restartWebRtcAfterReconnect();
  }

  void _handleConnectionLoss() {
    debugPrint(
        '[KINGZ] _handleConnectionLoss: manualDisconnect=$_manualDisconnect isDisposed=$_isDisposed');
    if (_manualDisconnect || _isDisposed) {
      return;
    }

    _clientPingTimer?.cancel();
    _pcmIdleTimer?.cancel();
    _webRtcActive = false;
    _resetTransportSync();
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
    await _pcmPlaybackBridge.start();
    final playbackTelemetry = await _pcmPlaybackBridge.resetToLiveEdge(
      reason: 'pcm-fallback-$reason',
    );
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
      await _webRtcPlaybackBridge.resetToLiveEdge(reason: 'reconnect');
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
    debugPrint(
        '[KINGZ] _send: type=${payload['type']} channel=${channel != null} manualDisconnect=$_manualDisconnect isDisposed=$_isDisposed');
    if (channel == null || _manualDisconnect || _isDisposed) {
      debugPrint(
          '[KINGZ] _send: SKIP (channel=${channel != null} manualDisconnect=$_manualDisconnect isDisposed=$_isDisposed)');
      return;
    }

    try {
      channel.sink.add(jsonEncode(payload));
      debugPrint('[KINGZ] _send: TRANSMITTED type=${payload['type']}');
    } catch (e) {
      debugPrint('[KINGZ] _send error (type=${payload['type']}): $e');
      _handleConnectionLoss();
    }
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

  int _readInt(dynamic value, {int fallback = 0}) {
    if (value is int) {
      return value;
    }
    if (value is num) {
      return value.round();
    }
    if (value is String) {
      return int.tryParse(value) ?? fallback;
    }
    return fallback;
  }

  double _readDouble(dynamic value, {double fallback = 0}) {
    if (value is int) {
      return value.toDouble();
    }
    if (value is num) {
      return value.toDouble();
    }
    if (value is String) {
      return double.tryParse(value) ?? fallback;
    }
    return fallback;
  }

  void _resetTransportSync() {
    _lastTransportSyncSequence = 0;
  }
}
