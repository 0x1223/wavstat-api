import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data' as typed;

import 'package:web/web.dart' as web;

import '../models/transport_config.dart';
import 'pcm_playback_bridge.dart';

class WebRtcPlaybackBridge {
  WebRtcPlaybackBridge() {
    _pcmPlaybackBridge.onTelemetry = (telemetry) {
      _telemetry = telemetry;
      onTelemetry?.call(telemetry);
    };
  }

  web.RTCPeerConnection? _peer;
  web.HTMLAudioElement? _audio;
  web.MediaStream? _remoteStream;
  web.RTCDataChannel? _pcmDataChannel;
  JSFunction? _iceCandidateHandler;
  JSFunction? _connectionStateHandler;
  JSFunction? _trackHandler;
  JSFunction? _dataChannelHandler;
  JSFunction? _pcmDataChannelOpenHandler;
  JSFunction? _pcmDataChannelMessageHandler;
  JSFunction? _pcmDataChannelCloseHandler;
  JSFunction? _playHandler;
  JSFunction? _pauseHandler;
  JSFunction? _visibilityHandler;
  JSFunction? _pageShowHandler;
  JSFunction? _focusHandler;
  JSFunction? _resumeTapHandler;
  JSFunction? _mediaSessionPlayHandler;
  JSFunction? _mediaSessionPauseHandler;
  web.HTMLButtonElement? _resumeOverlay;
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  void Function(String reason)? onFallback;
  void Function(Map<String, dynamic> signal)? _sendSignal;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry(
    audioContextState: 'webrtc-idle',
  );
  final PcmPlaybackBridge _pcmPlaybackBridge = PcmPlaybackBridge();
  bool _active = false;
  bool _signalingInFlight = false;
  int _offerGeneration = 0;
  Timer? _pendingDisconnectedTimer;
  DateTime? _backgroundedAt;

  static const Duration _coldWakeThreshold = Duration(minutes: 5);

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {
    _pcmPlaybackBridge.configureTransport(config);
  }

  Future<bool> start({
    required void Function(Map<String, dynamic> signal) sendSignal,
    required void Function(String reason) onFallback,
  }) async {
    _sendSignal = sendSignal;
    this.onFallback = onFallback;
    _active = true;

    try {
      _ensureAudioElement();
      _configureMediaSession();
      _attachLifecycleHandlers();
      await _pcmPlaybackBridge.start();
      await _createOffer();
      return true;
    } catch (error) {
      _log('error', '$error');
      await stop();
      return false;
    }
  }

  Future<void> handleSignal(Map<String, dynamic> message) async {
    final type = message['type'];
    final peer = _peer;
    if (peer == null) {
      return;
    }

    try {
      if (type == 'webrtc.answer') {
        if (!_matchesOfferGeneration(message['offerGeneration'])) {
          _log('stale-answer');
          return;
        }
        final sdp = message['sdp'];
        if (sdp is! String || sdp.isEmpty) {
          throw StateError('missing-answer-sdp');
        }
        _log('answer-received');
        await peer
            .setRemoteDescription(
              web.RTCSessionDescriptionInit(type: 'answer', sdp: sdp),
            )
            .toDart;
        return;
      }

      if (type == 'webrtc.ice-candidate') {
        if (!_matchesOfferGeneration(message['offerGeneration'])) {
          _log('stale-ice-candidate');
          return;
        }
        final candidate = message['candidate'];
        if (candidate is! Map<String, dynamic>) {
          return;
        }
        _log('ice-candidate');
        await peer
            .addIceCandidate(
              web.RTCIceCandidateInit(
                candidate: candidate['candidate'] as String? ?? '',
                sdpMid: candidate['sdpMid'] as String?,
                sdpMLineIndex: candidate['sdpMLineIndex'] as int?,
              ),
            )
            .toDart;
        return;
      }

      if (type == 'webrtc.connected') {
        _log('peer-connected');
        _updateTelemetry(
          outputActive: _audio?.paused == false,
          stateOverride: 'webrtc-connected',
        );
        return;
      }

      if (type == 'webrtc.error') {
        _log('error', '${message['message'] ?? 'server-error'}');
        await stop();
        onFallback?.call('server-error');
      }
    } catch (error) {
      _log('error', '$error');
      await stop();
      onFallback?.call('signal-failed');
    }
  }

  Future<void> stop() async {
    _active = false;
    _signalingInFlight = false;
    _pendingDisconnectedTimer?.cancel();
    _pendingDisconnectedTimer = null;
    _hideResumeOverlay();
    _detachLifecycleHandlers();
    _closePeer(notifyServer: true);
    _sendSignal = null;
    await _pcmPlaybackBridge.stop();

    final audio = _audio;
    if (audio != null) {
      try {
        audio.pause();
      } catch (_) {}
      audio.srcObject = null;
    }

    _setMediaSessionState('paused');
    _updateTelemetry(outputActive: false, stateOverride: 'webrtc-stopped');
  }

  Future<PcmPlaybackTelemetry> manualResume() async {
    final telemetry = await _pcmPlaybackBridge.manualResume();
    final audio = _audio;
    if (audio != null && audio.srcObject != null && audio.paused) {
      unawaited(_playRemoteAudio(audio));
    }
    return telemetry;
  }

  Future<void> dispose() async {
    await stop();
    await _pcmPlaybackBridge.dispose();
    final audio = _audio;
    _audio = null;
    _hideResumeOverlay();
    _detachAudioHandlers(audio);
    audio?.remove();
  }

  void _attachPeerHandlers(web.RTCPeerConnection peer, int generation) {
    _iceCandidateHandler = ((web.Event event) {
      if (generation != _offerGeneration || peer != _peer) {
        return;
      }
      final candidate = (event as web.RTCPeerConnectionIceEvent).candidate;
      if (candidate == null) {
        return;
      }
      _log('ice-candidate');
      _sendSignal?.call({
        'type': 'webrtc.ice-candidate',
        'offerGeneration': generation,
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
      });
    }).toJS;
    _connectionStateHandler = ((web.Event _) {
      if (generation != _offerGeneration || peer != _peer) {
        return;
      }
      final state = peer.connectionState;
      if (state == 'connected') {
        _pendingDisconnectedTimer?.cancel();
        _pendingDisconnectedTimer = null;
        _log('peer-connected');
        _updateTelemetry(
          outputActive: _audio?.paused == false,
          stateOverride: 'webrtc-connected',
        );
      }
      if (state == 'disconnected' || state == 'failed') {
        _log('connection-lost', state);
        _updateTelemetry(
          outputActive: false,
          stateOverride: 'webrtc-$state',
          manualResumeRequired: web.document.hidden,
        );
        _scheduleDisconnectedRecovery('connection-$state', generation);
      }
      if (state == 'closed') {
        _log('connection-closed');
        _updateTelemetry(
          outputActive: false,
          stateOverride: 'webrtc-closed',
          manualResumeRequired: web.document.hidden,
        );
      }
    }).toJS;
    _trackHandler = ((web.Event event) {
      if (generation != _offerGeneration || peer != _peer) {
        return;
      }
      final trackEvent = event as web.RTCTrackEvent;
      _log('remote-track');
      final stream = web.MediaStream();
      stream.addTrack(trackEvent.track);
      _remoteStream = stream;
      final audio = _ensureAudioElement();
      audio.srcObject = stream;
      unawaited(_playRemoteAudio(audio));
    }).toJS;
    _dataChannelHandler = ((web.Event event) {
      if (generation != _offerGeneration || peer != _peer) {
        return;
      }
      final channel = (event as web.RTCDataChannelEvent).channel;
      _attachPcmDataChannel(channel, generation);
    }).toJS;

    peer.onicecandidate = _iceCandidateHandler;
    peer.onconnectionstatechange = _connectionStateHandler;
    peer.ontrack = _trackHandler;
    peer.ondatachannel = _dataChannelHandler;
  }

  void _attachPcmDataChannel(web.RTCDataChannel channel, int generation) {
    if (channel.label != 'kingz-pcm' ||
        generation != _offerGeneration ||
        _peer == null) {
      return;
    }

    _detachPcmDataChannel();
    channel.binaryType = 'arraybuffer';
    _pcmDataChannel = channel;

    _pcmDataChannelOpenHandler = ((web.Event _) {
      _log(
        'pcm-data-channel-open',
        'ordered=${channel.ordered} maxRetransmits=${channel.maxRetransmits}',
      );
      _updateTelemetry(
        outputActive: _pcmPlaybackBridge.telemetry.outputActive,
        stateOverride: 'webrtc-pcm-channel-open',
      );
    }).toJS;
    _pcmDataChannelMessageHandler = ((web.Event event) {
      if (generation != _offerGeneration || channel != _pcmDataChannel) {
        return;
      }
      unawaited(_handlePcmDataChannelMessage(event as web.MessageEvent));
    }).toJS;
    _pcmDataChannelCloseHandler = ((web.Event _) {
      if (channel == _pcmDataChannel) {
        _log('pcm-data-channel-closed');
        _pcmDataChannel = null;
        _updateTelemetry(
          outputActive: false,
          stateOverride: 'webrtc-pcm-channel-closed',
        );
      }
    }).toJS;

    channel.onopen = _pcmDataChannelOpenHandler;
    channel.onmessage = _pcmDataChannelMessageHandler;
    channel.onclose = _pcmDataChannelCloseHandler;

    if (channel.readyState == 'open') {
      _log(
        'pcm-data-channel-open',
        'ordered=${channel.ordered} maxRetransmits=${channel.maxRetransmits}',
      );
    }
  }

  Future<void> _handlePcmDataChannelMessage(web.MessageEvent event) async {
    final bytes = await _readBinaryPayload(event.data);
    if (bytes == null) {
      _log('pcm-data-channel-nonbinary');
      return;
    }
    if (bytes.lengthInBytes != 1920) {
      _log('pcm-data-channel-size', '${bytes.lengthInBytes}');
    }

    _pcmPlaybackBridge.enqueueBytes(
      bytes,
      channels: 2,
      sampleRate: 48000,
      bitDepth: 16,
      chunkDurationMs: 10,
    );
  }

  Future<typed.Uint8List?> _readBinaryPayload(JSAny? data) async {
    if (data == null) {
      return null;
    }

    final dartValue = data.dartify();
    if (dartValue is typed.ByteBuffer) {
      return typed.Uint8List.view(dartValue);
    }
    if (dartValue is typed.Uint8List) {
      return dartValue;
    }

    try {
      final buffer = await (data as web.Blob).arrayBuffer().toDart;
      return typed.Uint8List.view(buffer.toDart);
    } catch (_) {
      return null;
    }
  }

  web.HTMLAudioElement _ensureAudioElement() {
    final existing = _audio;
    if (existing != null) {
      return existing;
    }

    final audio = web.document.createElement('audio') as web.HTMLAudioElement;
    audio.autoplay = true;
    audio.controls = false;
    audio.muted = false;
    audio.defaultMuted = false;
    audio.volume = 1;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.setAttribute('data-kingz-webrtc-audio', 'true');
    audio.setAttribute(
      'style',
      'position:fixed;width:1px;height:1px;opacity:0;'
          'pointer-events:none;left:-10000px;top:auto;',
    );

    _playHandler = ((web.Event _) {
      _setMediaSessionState('playing');
      _updateTelemetry(outputActive: true, stateOverride: 'webrtc-playing');
    }).toJS;
    _pauseHandler = ((web.Event _) {
      _setMediaSessionState('paused');
      _updateTelemetry(outputActive: false, stateOverride: 'webrtc-paused');
    }).toJS;
    audio.addEventListener('play', _playHandler);
    audio.addEventListener('playing', _playHandler);
    audio.addEventListener('pause', _pauseHandler);
    web.document.body?.append(audio);
    _audio = audio;
    return audio;
  }

  void _detachAudioHandlers(web.HTMLAudioElement? audio) {
    if (audio == null) {
      return;
    }
    if (_playHandler != null) {
      audio.removeEventListener('play', _playHandler);
      audio.removeEventListener('playing', _playHandler);
    }
    if (_pauseHandler != null) {
      audio.removeEventListener('pause', _pauseHandler);
    }
    _playHandler = null;
    _pauseHandler = null;
  }

  Future<void> _playRemoteAudio(web.HTMLAudioElement audio) async {
    try {
      _configureMediaSession();
      await audio.play().toDart;
      _log('audio-element-playing');
      _updateTelemetry(outputActive: true, stateOverride: 'webrtc-playing');
    } catch (error) {
      _log('error', 'audio-play-$error');
      _updateTelemetry(
        outputActive: false,
        stateOverride: 'webrtc-play-blocked',
        manualResumeRequired: true,
      );
      if (_isNotAllowedError(error)) {
        _showResumeOverlay();
      }
    }
  }

  Future<void> _createOffer() async {
    if (!_active || _signalingInFlight) {
      return;
    }

    final sendSignal = _sendSignal;
    if (sendSignal == null) {
      throw StateError('missing-signal-sender');
    }

    _signalingInFlight = true;
    try {
      _log('signaling-start');
      final generation = _offerGeneration + 1;
      _offerGeneration = generation;
      _closePeer(notifyServer: false);
      final peer = web.RTCPeerConnection();
      _peer = peer;
      _attachPeerHandlers(peer, generation);
      final localPcmChannel = peer.createDataChannel(
        'kingz-pcm',
        web.RTCDataChannelInit(
          ordered: false,
          maxRetransmits: 0,
          protocol: 'audio/L16;rate=48000;channels=2',
        ),
      );
      _attachPcmDataChannel(localPcmChannel, generation);
      peer.addTransceiver(
        'audio'.toJS,
        web.RTCRtpTransceiverInit(direction: 'recvonly'),
      );

      final offer = await peer.createOffer().toDart;
      if (offer == null) {
        throw StateError('offer-null');
      }
      _log('offer-created');
      await peer
          .setLocalDescription(
            web.RTCLocalSessionDescriptionInit(
              type: offer.type,
              sdp: offer.sdp,
            ),
          )
          .toDart;
      sendSignal({
        'type': 'webrtc.offer',
        'offerGeneration': generation,
        'sdp': offer.sdp,
      });
      _updateTelemetry(outputActive: false, stateOverride: 'webrtc-offer');
    } finally {
      _signalingInFlight = false;
    }
  }

  Future<void> _resignal(String reason) async {
    if (!_active || web.document.hidden) {
      return;
    }

    try {
      _log('resignal', reason);
      await _createOffer();
    } catch (error) {
      _log('error', 'resignal-$error');
      await stop();
      onFallback?.call('resignal-failed');
    }
  }

  void _scheduleDisconnectedRecovery(String reason, int generation) {
    _pendingDisconnectedTimer?.cancel();
    _pendingDisconnectedTimer = Timer(const Duration(seconds: 2), () {
      _pendingDisconnectedTimer = null;
      if (!_active ||
          web.document.hidden ||
          generation != _offerGeneration ||
          _peer == null) {
        return;
      }

      final state = _peer?.connectionState;
      if (state == 'connected' || state == 'connecting') {
        return;
      }
      unawaited(_resignal(reason));
    });
  }

  void _closePeer({required bool notifyServer}) {
    if (notifyServer) {
      _sendSignal?.call({'type': 'webrtc.stop'});
    }

    _detachPcmDataChannel();
    final peer = _peer;
    _peer = null;
    if (peer != null) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.ontrack = null;
      peer.ondatachannel = null;
      try {
        peer.close();
      } catch (_) {}
    }

    final stream = _remoteStream;
    _remoteStream = null;
    if (stream != null) {
      final tracks = stream.getTracks().toDart;
      for (final track in tracks) {
        try {
          track.stop();
        } catch (_) {}
      }
    }
  }

  void _detachPcmDataChannel() {
    final channel = _pcmDataChannel;
    if (channel != null) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      try {
        channel.close();
      } catch (_) {}
    }
    _pcmDataChannel = null;
    _pcmDataChannelOpenHandler = null;
    _pcmDataChannelMessageHandler = null;
    _pcmDataChannelCloseHandler = null;
  }

  void _attachLifecycleHandlers() {
    if (_visibilityHandler != null ||
        _pageShowHandler != null ||
        _focusHandler != null) {
      return;
    }

    _visibilityHandler = ((web.Event _) {
      if (web.document.hidden) {
        _backgroundedAt = DateTime.now();
        return;
      }
      if (!web.document.hidden) {
        _handleForeground('visibilitychange');
      }
    }).toJS;
    _pageShowHandler = ((web.Event _) {
      _handleForeground('pageshow');
    }).toJS;
    _focusHandler = ((web.Event _) {
      _handleForeground('focus');
    }).toJS;

    web.document.addEventListener('visibilitychange', _visibilityHandler);
    web.window.addEventListener('pageshow', _pageShowHandler);
    web.window.addEventListener('focus', _focusHandler);
  }

  void _detachLifecycleHandlers() {
    if (_visibilityHandler != null) {
      web.document.removeEventListener('visibilitychange', _visibilityHandler);
    }
    if (_pageShowHandler != null) {
      web.window.removeEventListener('pageshow', _pageShowHandler);
    }
    if (_focusHandler != null) {
      web.window.removeEventListener('focus', _focusHandler);
    }
    _visibilityHandler = null;
    _pageShowHandler = null;
    _focusHandler = null;
  }

  void _handleForeground(String reason) {
    if (!_active || web.document.hidden) {
      return;
    }

    final backgroundedAt = _backgroundedAt;
    _backgroundedAt = null;
    if (backgroundedAt != null &&
        DateTime.now().difference(backgroundedAt) > _coldWakeThreshold) {
      _log('cold-wake', reason);
      _pendingDisconnectedTimer?.cancel();
      _pendingDisconnectedTimer = null;
      _closePeer(notifyServer: false);
      unawaited(_resignal('cold-wake-$reason'));
      return;
    }

    final state = _peer?.connectionState;
    _log('foreground', '$reason state=${state ?? 'none'}');
    if (state == 'disconnected' || state == 'failed' || state == 'closed') {
      unawaited(_resignal(reason));
      return;
    }

    final audio = _audio;
    if (audio != null && audio.paused) {
      unawaited(_playRemoteAudio(audio));
    }
  }

  bool _isNotAllowedError(Object error) {
    final text = error.toString();
    return text.contains('NotAllowedError') ||
        text.contains('not allowed') ||
        text.contains('user gesture');
  }

  bool _matchesOfferGeneration(dynamic value) {
    if (value is int) {
      return value == _offerGeneration;
    }
    if (value is num) {
      return value.toInt() == _offerGeneration;
    }
    return false;
  }

  void _showResumeOverlay() {
    if (!_active || _resumeOverlay != null) {
      return;
    }

    final overlay =
        web.document.createElement('button') as web.HTMLButtonElement;
    overlay.textContent = 'Tap to Resume Monitoring';
    overlay.setAttribute('type', 'button');
    overlay.setAttribute('aria-label', 'Tap to Resume Monitoring');
    overlay.setAttribute(
      'style',
      'position:fixed;inset:0;z-index:2147483647;'
          'display:flex;align-items:center;justify-content:center;'
          'border:0;margin:0;padding:0;background:rgba(0,0,0,0.01);'
          'color:white;font:600 18px -apple-system,BlinkMacSystemFont,'
          '"Segoe UI",sans-serif;text-shadow:0 1px 8px rgba(0,0,0,0.7);'
          'cursor:pointer;-webkit-tap-highlight-color:transparent;',
    );

    _resumeTapHandler = ((web.Event event) {
      event.preventDefault();
      _hideResumeOverlay();
      final currentAudio = _audio;
      if (currentAudio != null && currentAudio.srcObject != null) {
        unawaited(_playRemoteAudio(currentAudio));
      }
    }).toJS;
    overlay.addEventListener('click', _resumeTapHandler);
    overlay.addEventListener('touchend', _resumeTapHandler);
    web.document.body?.append(overlay);
    _resumeOverlay = overlay;
    _log('resume-overlay-shown');
  }

  void _hideResumeOverlay() {
    final overlay = _resumeOverlay;
    if (overlay == null) {
      _resumeTapHandler = null;
      return;
    }

    if (_resumeTapHandler != null) {
      overlay.removeEventListener('click', _resumeTapHandler);
      overlay.removeEventListener('touchend', _resumeTapHandler);
    }
    overlay.remove();
    _resumeOverlay = null;
    _resumeTapHandler = null;
  }

  void _configureMediaSession() {
    try {
      web.window.navigator.mediaSession.metadata = web.MediaMetadata(
        web.MediaMetadataInit(
          title: 'KINGZ LISTEN',
          artist: 'WebRTC Pro Monitor',
        ),
      );
      web.window.navigator.mediaSession.playbackState =
          _audio?.paused == false ? 'playing' : 'paused';

      _mediaSessionPlayHandler ??= (() {
        final audio = _audio;
        if (audio != null) {
          unawaited(_playRemoteAudio(audio));
        }
      }).toJS;
      _mediaSessionPauseHandler ??= (() {
        try {
          _audio?.pause();
        } catch (_) {}
      }).toJS;

      web.window.navigator.mediaSession.setActionHandler(
        'play',
        _mediaSessionPlayHandler,
      );
      web.window.navigator.mediaSession.setActionHandler(
        'pause',
        _mediaSessionPauseHandler,
      );
    } catch (_) {}
  }

  void _setMediaSessionState(String state) {
    try {
      web.window.navigator.mediaSession.playbackState = state;
    } catch (_) {}
  }

  void _updateTelemetry({
    required bool outputActive,
    required String stateOverride,
    bool manualResumeRequired = false,
  }) {
    _telemetry = PcmPlaybackTelemetry(
      audioContextState: stateOverride,
      outputActive: outputActive && _active,
      lastResumeResult: stateOverride,
      manualResumeRequired: manualResumeRequired,
    );
    onTelemetry?.call(_telemetry);
  }

  void _log(String event, [String detail = '']) {
    web.console.log(
      ('[webrtc] $event${detail.isEmpty ? '' : ' $detail'}').toJS,
    );
  }
}
