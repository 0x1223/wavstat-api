import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'pcm_playback_bridge.dart';

class WebRtcPlaybackBridge {
  web.RTCPeerConnection? _peer;
  web.HTMLAudioElement? _audio;
  web.MediaStream? _remoteStream;
  JSFunction? _iceCandidateHandler;
  JSFunction? _connectionStateHandler;
  JSFunction? _trackHandler;
  JSFunction? _playHandler;
  JSFunction? _pauseHandler;
  JSFunction? _mediaSessionPlayHandler;
  JSFunction? _mediaSessionPauseHandler;
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  void Function(String reason)? onFallback;
  void Function(Map<String, dynamic> signal)? _sendSignal;
  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry(
    audioContextState: 'webrtc-idle',
  );
  bool _active = false;

  PcmPlaybackTelemetry get telemetry => _telemetry;

  Future<bool> start({
    required void Function(Map<String, dynamic> signal) sendSignal,
    required void Function(String reason) onFallback,
  }) async {
    _sendSignal = sendSignal;
    this.onFallback = onFallback;
    _active = true;

    try {
      _log('signaling-start');
      final peer = web.RTCPeerConnection();
      _peer = peer;
      _ensureAudioElement();
      _configureMediaSession();
      _attachPeerHandlers(peer);
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
        'sdp': offer.sdp,
      });
      _updateTelemetry(outputActive: false, stateOverride: 'webrtc-offer');
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
    _sendSignal?.call({'type': 'webrtc.stop'});
    _sendSignal = null;
    final peer = _peer;
    _peer = null;
    if (peer != null) {
      peer.close();
    }

    final stream = _remoteStream;
    _remoteStream = null;
    if (stream != null) {
      final tracks = stream.getTracks().toDart;
      for (final track in tracks) {
        track.stop();
      }
    }

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

  Future<void> dispose() async {
    await stop();
    final audio = _audio;
    _audio = null;
    _detachAudioHandlers(audio);
    audio?.remove();
  }

  void _attachPeerHandlers(web.RTCPeerConnection peer) {
    _iceCandidateHandler = ((web.Event event) {
      final candidate = (event as web.RTCPeerConnectionIceEvent).candidate;
      if (candidate == null) {
        return;
      }
      _log('ice-candidate');
      _sendSignal?.call({
        'type': 'webrtc.ice-candidate',
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
      });
    }).toJS;
    _connectionStateHandler = ((web.Event _) {
      final state = peer.connectionState;
      if (state == 'connected') {
        _log('peer-connected');
        _updateTelemetry(
          outputActive: _audio?.paused == false,
          stateOverride: 'webrtc-connected',
        );
      }
      if (state == 'failed' || state == 'disconnected' || state == 'closed') {
        _log('error', 'connection-$state');
        onFallback?.call('connection-$state');
      }
    }).toJS;
    _trackHandler = ((web.Event event) {
      final trackEvent = event as web.RTCTrackEvent;
      _log('remote-track');
      final stream = web.MediaStream();
      stream.addTrack(trackEvent.track);
      _remoteStream = stream;
      final audio = _ensureAudioElement();
      audio.srcObject = stream;
      unawaited(_playRemoteAudio(audio));
    }).toJS;

    peer.onicecandidate = _iceCandidateHandler;
    peer.onconnectionstatechange = _connectionStateHandler;
    peer.ontrack = _trackHandler;
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
    }
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
