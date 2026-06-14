import 'dart:async';
import 'dart:typed_data' as typed;

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../models/transport_config.dart';
import 'pcm_playback_bridge.dart';

/// Native WebRTC transport for plugin PCM delivery.
///
/// Protocol flow:
/// 1. start() → create peer, create offer, set local description, send offer
/// 2. handleSignal(webrtc.answer) → fix SDP setup attribute, set remote description
/// 3. handleSignal(webrtc.ice-candidate) → add ICE candidates
/// 4. onDataChannel (plugin-created kingz-pcm) → attach handlers, receive binary PCM
/// 5. onMessage (PCM bytes) → enqueue to playback bridge, emit onPlaybackStarted on first packet
///
/// Constraints:
/// - Do not modify plugin code
/// - Do not modify plugin DSP/audio callbacks
/// - Do not modify PCM playback bridge (except input wiring)
/// - Do not modify WebSocket protocol shape
class WebRtcPlaybackBridge {
  WebRtcPlaybackBridge() {
    _pcmPlaybackBridge.onTelemetry = (telemetry) {
      _telemetry = telemetry;
      onTelemetry?.call(telemetry);
    };
  }

  RTCPeerConnection? _peer;
  RTCDataChannel? _pcmDataChannel;
  void Function(PcmPlaybackTelemetry telemetry)? onTelemetry;
  void Function(String reason)? onFallback;
  void Function()? onPlaybackStarted;
  void Function(Map<String, dynamic> signal)? _sendSignal;

  PcmPlaybackTelemetry _telemetry = const PcmPlaybackTelemetry(
    audioContextState: 'native-webrtc-idle',
  );

  final PcmPlaybackBridge _pcmPlaybackBridge = PcmPlaybackBridge();
  bool _active = false;
  bool _peerReady =
      false; // NEW: tracks if peer connection is created and ready
  bool _playbackStartedSignaled = false;
  bool _remoteDescriptionSet = false;
  bool _processingSignal =
      false; // NEW: guard against concurrent signal processing
  int _streamSampleRate = 48000;
  int _offerGeneration = 0;
  int _pcmPacketCount = 0;
  Timer? _disconnectTimer;
  Timer? _legacyOfferFallbackTimer;
  String? _lastOfferSdp;
  String _lastOfferType = 'offer';
  bool _legacySignalingFallbackActive = false;
  final List<RTCIceCandidate> _pendingCandidates = [];
  final List<Map<String, dynamic>> _queuedSignalMessages =
      []; // NEW: queue for early-arriving signaling

  PcmPlaybackTelemetry get telemetry => _telemetry;

  void configureTransport(TransportConfig config) {
    _pcmPlaybackBridge.configureTransport(config);
  }

  Future<PcmPlaybackTelemetry> resetToLiveEdge({
    String reason = 'live-edge',
  }) async {
    _playbackStartedSignaled = false;
    _pcmPacketCount = 0;
    return _pcmPlaybackBridge.resetToLiveEdge(reason: reason);
  }

  Future<void> updateStreamFormat(Map<String, dynamic> message) async {
    final sampleRate = message['sampleRate'];
    if (sampleRate is num && sampleRate > 0) {
      _streamSampleRate = sampleRate.round();
      await _pcmPlaybackBridge.configureStreamSampleRate(_streamSampleRate);
    }
  }

  /// Start WebRTC signaling: create peer, offer, and begin ICE.
  Future<bool> start({
    required void Function(Map<String, dynamic> signal) sendSignal,
    required void Function(String reason) onFallback,
  }) async {
    _sendSignal = sendSignal;
    this.onFallback = onFallback;
    _active = true;
    _peerReady = false;

    try {
      await _pcmPlaybackBridge.start();
      await resetToLiveEdge(reason: 'webrtc-start');
      debugPrint('[KINGZ WebRTC] creating peer connection...');
      await _createPeer();
      _peerReady =
          true; // CRITICAL: mark peer as ready BEFORE processing queued messages
      debugPrint(
          '[KINGZ WebRTC] peer connection ready, queued messages: ${_queuedSignalMessages.length}');

      // Flush any signaling messages that arrived while peer was initializing
      final queuedCopy = List<Map<String, dynamic>>.from(_queuedSignalMessages);
      _queuedSignalMessages.clear();

      for (final message in queuedCopy) {
        debugPrint(
            '[KINGZ WebRTC] processing queued signal (${message['type']})');
        await handleSignal(message);
      }

      debugPrint('[KINGZ WebRTC] creating offer...');
      await _createOffer();
      return true;
    } catch (error) {
      debugPrint('[KINGZ WebRTC] start error: $error');
      await stop();
      return false;
    }
  }

  /// Handle incoming WebRTC signaling message.
  /// Messages arriving before peer is ready are queued and processed after initialization.
  Future<void> handleSignal(Map<String, dynamic> message) async {
    final type = message['type'];
    final generation = message['offerGeneration'] as int? ?? -1;

    // CRITICAL FIX: Queue messages if peer isn't ready yet
    if (!_peerReady) {
      debugPrint(
          '[KINGZ WebRTC] queueing signal (peer not ready): type=$type gen=$generation');
      _queuedSignalMessages.add(message);
      return;
    }

    // NEW: Prevent concurrent signal processing which can corrupt peer state
    if (_processingSignal) {
      debugPrint(
          '[KINGZ WebRTC] WARNING: signal processing already in progress, queueing: type=$type');
      _queuedSignalMessages.add(message);
      return;
    }

    _processingSignal = true;

    try {
      final peer = _peer;
      if (peer == null) {
        debugPrint(
            '[KINGZ WebRTC] ERROR: handleSignal called with peerReady=true but peer is null!');
        return;
      }
      if (type == 'webrtc.answer' || type == 'webrtc-answer') {
        if (!_matchesOfferGeneration(generation)) {
          debugPrint(
              '[KINGZ WebRTC] stale answer (gen=$generation, expected=$_offerGeneration), ignoring');
          return;
        }
        _legacyOfferFallbackTimer?.cancel();
        _legacyOfferFallbackTimer = null;
        _legacySignalingFallbackActive = type == 'webrtc-answer';
        final sdp = message['sdp'];
        if (sdp is! String || sdp.isEmpty) {
          throw StateError('ERROR: webrtc.answer missing SDP payload');
        }
        debugPrint(
            '[KINGZ WebRTC] answer received (gen=$generation, sdpLen=${sdp.length})');

        // CRITICAL: PRINT ENTIRE RAW ANSWER SDP FROM JUCE FOR M-LINE DIAGNOSTIC
        debugPrint(
            '======== JUCE ANSWER SDP (BEFORE FIX) (${sdp.length} bytes) ========');
        debugPrint(sdp);
        debugPrint('======== END JUCE ANSWER SDP ========');

        // CRITICAL: Verify peer is still valid and in correct state
        final currentPeer = _peer;
        if (currentPeer == null) {
          throw StateError(
              'ERROR: peer was disposed before setRemoteDescription');
        }
        if (!_active) {
          throw StateError(
              'ERROR: WebRTC bridge is not active, ignoring answer');
        }

        // Fix DTLS setup attribute for answerer role (flutter_webrtc strict validation)
        final fixedSdp = _fixAnswerSdpSetup(sdp);
        debugPrint('[KINGZ WebRTC] fixed SDP: ${fixedSdp.length} bytes');

        // CRITICAL: PRINT ENTIRE FIXED ANSWER SDP BEFORE ATTEMPTING setRemoteDescription
        debugPrint(
            '======== JUCE ANSWER SDP (AFTER FIX) (${fixedSdp.length} bytes) ========');
        debugPrint(fixedSdp);
        debugPrint('======== END FIXED ANSWER SDP ========');

        // Wait for local description to be fully set
        debugPrint(
            '[KINGZ WebRTC] waiting for local description to be ready...');
        await Future.delayed(const Duration(milliseconds: 100));

        // Verify peer is STILL valid (not disposed during delay)
        if (_peer == null) {
          throw StateError(
              'ERROR: peer was disposed while waiting to set remote description');
        }
        if (!_active) {
          throw StateError(
              'ERROR: bridge deactivated while waiting to set remote description');
        }

        debugPrint(
            '[KINGZ WebRTC] calling setRemoteDescription with fixed answer SDP...');
        await currentPeer.setRemoteDescription(
          RTCSessionDescription(fixedSdp, 'answer'),
        );

        _remoteDescriptionSet = true;
        debugPrint('[KINGZ WebRTC] remote description set successfully');

        // Flush any buffered ICE candidates (make a copy to avoid concurrent modification)
        final candidatesToFlush = List.of(_pendingCandidates);
        _pendingCandidates.clear();

        debugPrint(
            '[KINGZ WebRTC] flushing ${candidatesToFlush.length} pending ICE candidates');
        for (final candidate in candidatesToFlush) {
          try {
            await peer.addCandidate(candidate);
          } catch (e) {
            debugPrint('[KINGZ WebRTC] addCandidate error (buffered): $e');
          }
        }
        return;
      }

      if (type == 'webrtc.ice-candidate' || type == 'webrtc-candidate') {
        if (!_matchesOfferGeneration(generation)) {
          debugPrint(
              '[KINGZ WebRTC] stale ICE candidate (gen=$generation), ignoring');
          return;
        }
        final candidate = message['candidate'];
        if (candidate is! Map<String, dynamic>) {
          debugPrint(
              '[KINGZ WebRTC] ERROR: ice-candidate missing candidate data');
          return;
        }

        final iceCandidate = RTCIceCandidate(
          candidate['candidate'] as String? ?? '',
          candidate['sdpMid'] as String?,
          candidate['sdpMLineIndex'] as int? ?? 0,
        );

        // If remote description not set yet, buffer the candidate
        if (!_remoteDescriptionSet) {
          debugPrint(
              '[KINGZ WebRTC] buffering ICE candidate (remote description not set, buffered=${_pendingCandidates.length})');
          _pendingCandidates.add(iceCandidate);
          return;
        }

        debugPrint(
            '[KINGZ WebRTC] adding ICE candidate (buffered=${_pendingCandidates.length})');
        await peer.addCandidate(iceCandidate);
        return;
      }

      if (type == 'webrtc.error') {
        final msg = message['message'] ?? 'unknown';
        debugPrint('[KINGZ WebRTC] server error: $msg');
        await stop();
        onFallback?.call('server-error');
        return;
      }

      debugPrint('[KINGZ WebRTC] unknown signal type: $type');
    } catch (error, stackTrace) {
      debugPrint('[KINGZ WebRTC] handleSignal error: $error\n$stackTrace');
      await stop();
      onFallback?.call('signal-failed');
    } finally {
      _processingSignal = false; // CRITICAL: always reset to allow next message

      if (_active && _peerReady && _queuedSignalMessages.isNotEmpty) {
        final queuedCopy =
            List<Map<String, dynamic>>.from(_queuedSignalMessages);
        _queuedSignalMessages.clear();

        unawaited(Future<void>(() async {
          for (final queuedMessage in queuedCopy) {
            if (!_active || !_peerReady) {
              return;
            }
            debugPrint(
                '[KINGZ WebRTC] draining queued signal (${queuedMessage['type']})');
            await handleSignal(queuedMessage);
          }
        }));
      }
    }
  }

  /// Stop the WebRTC peer connection and playback.
  Future<void> stop() async {
    _active = false;
    _peerReady = false;
    _playbackStartedSignaled = false;
    _remoteDescriptionSet = false;
    _processingSignal = false; // Reset signal processing flag
    _pcmPacketCount = 0;
    _pendingCandidates.clear();
    _queuedSignalMessages.clear();
    _disconnectTimer?.cancel();
    _disconnectTimer = null;
    _legacyOfferFallbackTimer?.cancel();
    _legacyOfferFallbackTimer = null;
    _lastOfferSdp = null;
    _lastOfferType = 'offer';
    _legacySignalingFallbackActive = false;
    _closePeer();
    _sendSignal = null;
    await _pcmPlaybackBridge.stop();
    _updateTelemetry(
        outputActive: false, stateOverride: 'native-webrtc-stopped');
  }

  /// Resume playback (manual user interaction).
  Future<PcmPlaybackTelemetry> manualResume() async {
    return await _pcmPlaybackBridge.manualResume();
  }

  /// Cleanup and dispose.
  Future<void> dispose() async {
    await stop();
    await _pcmPlaybackBridge.dispose();
  }

  /// Create RTCPeerConnection with STUN server and event handlers.
  /// CRITICAL: Create data channel BEFORE creating offer to match plugin m-line order.
  /// Plugin expects: m=application (data channel), then m=audio (audio transceiver)
  Future<void> _createPeer() async {
    debugPrint('[KINGZ WebRTC] closing previous peer if any...');
    _closePeer();

    _remoteDescriptionSet = false;
    _pendingCandidates.clear();

    final config = <String, dynamic>{
      'iceServers': [
        {
          'urls': ['stun:stun.l.google.com:19302'],
        },
      ],
    };

    try {
      debugPrint(
          '[KINGZ WebRTC] calling createPeerConnection() with config: $config');
      _peer = await createPeerConnection(config);
      final generation = ++_offerGeneration;
      debugPrint(
          '[KINGZ WebRTC] peer connection created (generation=$generation)');
    } catch (error, stackTrace) {
      debugPrint(
          '[KINGZ WebRTC] ERROR creating peer connection: $error\n$stackTrace');
      rethrow;
    }
    final peer = _peer!;
    final generation = _offerGeneration;

    // Create data channel BEFORE creating offer so the offer contains m=application.
    // CRITICAL: The offerer's locally-created channel never fires onDataChannel on the
    // offerer side — that callback is for answerer-initiated channels only. We must
    // capture the returned channel and attach PCM handlers immediately.
    try {
      debugPrint(
          '[KINGZ WebRTC] creating kingz-pcm data channel (pre-negotiation)...');
      final dataChannelInit = RTCDataChannelInit()
        ..ordered = false
        ..binaryType = 'binary'
        ..protocol = 'audio/L16;rate=48000;channels=2'
        // flutter_webrtc 0.9.x always serializes an id, and iOS then treats it
        // as an explicit SCTP stream id. The plugin answer uses DTLS active,
        // making this Flutter offerer the passive side, which must use odd ids.
        ..id = 1;
      final localDc =
          await peer.createDataChannel('kingz-pcm', dataChannelInit);
      _attachPcmDataChannel(localDc, generation);
      debugPrint(
          '[KINGZ WebRTC] kingz-pcm data channel created and handlers attached');
    } catch (error) {
      debugPrint(
          '[KINGZ WebRTC] WARNING: failed to pre-create data channel: $error');
    }

    peer.onIceCandidate = (RTCIceCandidate candidate) {
      if (generation != _offerGeneration || !_active) {
        return;
      }
      debugPrint('[KINGZ WebRTC] local ICE candidate');
      final candidatePayload = {
        'candidate': candidate.candidate ?? '',
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex ?? 0,
      };
      _sendSignal?.call({
        'type': 'webrtc.ice-candidate',
        'offerGeneration': generation,
        'candidate': candidatePayload,
      });
      if (_legacySignalingFallbackActive) {
        _sendSignal?.call({
          'type': 'webrtc-candidate',
          'offerGeneration': generation,
          'candidate': candidatePayload,
        });
      }
    };

    peer.onConnectionState = (RTCPeerConnectionState state) {
      if (generation != _offerGeneration || !_active) {
        return;
      }
      debugPrint('[KINGZ WebRTC] connection state: $state');

      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _updateTelemetry(
          outputActive: _pcmPlaybackBridge.telemetry.outputActive,
          stateOverride: 'native-webrtc-connected',
        );
      }

      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _updateTelemetry(
            outputActive: false, stateOverride: 'native-webrtc-$state');
        _scheduleDisconnectRecovery(generation);
      }

      if (state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _updateTelemetry(
            outputActive: false, stateOverride: 'native-webrtc-closed');
      }
    };

    peer.onIceConnectionState = (RTCIceConnectionState state) {
      if (generation != _offerGeneration || !_active) {
        return;
      }
      debugPrint('[KINGZ WebRTC] ICE connection state: $state');
    };

    peer.onIceGatheringState = (RTCIceGatheringState state) {
      if (generation != _offerGeneration || !_active) {
        return;
      }
      debugPrint('[KINGZ WebRTC] ICE gathering state: $state');
    };

    peer.onSignalingState = (RTCSignalingState state) {
      if (generation != _offerGeneration || !_active) {
        return;
      }
      debugPrint('[KINGZ WebRTC] signaling state: $state');
    };

    peer.onDataChannel = (RTCDataChannel channel) {
      if (generation != _offerGeneration || !_active) {
        debugPrint(
            '[KINGZ WebRTC] ignoring data channel (generation mismatch or inactive)');
        return;
      }
      debugPrint('[KINGZ WebRTC] data channel received: ${channel.label}');
      if (channel.label == 'kingz-pcm') {
        _attachPcmDataChannel(channel, generation);
      }
    };
  }

  /// Create WebRTC offer and send to plugin.
  Future<void> _createOffer() async {
    final peer = _peer;
    if (peer == null) {
      throw StateError('ERROR: _createOffer called with peer=null');
    }

    try {
      // Data-channel-only offer: NO audio m-line.
      // The plugin (libdatachannel) has no audio transceiver and will drop any m=audio
      // section from the answer, causing a count/order mismatch on setRemoteDescription.
      // With an empty constraints map the offer contains ONLY m=application (from the
      // kingz-pcm data channel created in _createPeer), so offer and answer always match.
      final constraints = <String, dynamic>{};

      debugPrint(
          '[KINGZ WebRTC] calling peer.createOffer() (data-channel-only, no audio m-line)');
      final offer = await peer.createOffer(constraints);

      if (offer.sdp == null || offer.sdp!.isEmpty) {
        throw StateError('ERROR: peer.createOffer() returned empty SDP');
      }

      debugPrint('[KINGZ WebRTC] offer created: ${offer.sdp!.length} bytes');

      // CRITICAL: PRINT ENTIRE OFFER SDP FOR M-LINE DIAGNOSTIC
      debugPrint(
          '======== FLUTTER OFFER SDP (${offer.sdp!.length} bytes) ========');
      debugPrint(offer.sdp!);
      debugPrint('======== END OFFER SDP ========');

      debugPrint('[KINGZ WebRTC] setting local description with offer');
      await peer.setLocalDescription(offer);

      final generation = _offerGeneration;
      debugPrint(
          '[KINGZ WebRTC] offer created successfully (generation=$generation sdpLen=${offer.sdp!.length})');

      _sendSignal?.call({
        'type': 'webrtc.offer',
        'sdp': offer.sdp ?? '',
        'offerGeneration': generation,
      });
      _armLegacyOfferFallback(
        generation: generation,
        sdp: offer.sdp ?? '',
        descriptionType: offer.type ?? 'offer',
      );
    } catch (error, stackTrace) {
      debugPrint(
          '[KINGZ WebRTC] peer_connection_offer_failed: $error\n$stackTrace');
      rethrow;
    }
  }

  void _armLegacyOfferFallback({
    required int generation,
    required String sdp,
    required String descriptionType,
  }) {
    _legacyOfferFallbackTimer?.cancel();
    _lastOfferSdp = sdp;
    _lastOfferType = descriptionType;
    _legacySignalingFallbackActive = false;

    _legacyOfferFallbackTimer = Timer(const Duration(milliseconds: 900), () {
      if (!_active ||
          generation != _offerGeneration ||
          _remoteDescriptionSet ||
          _sendSignal == null ||
          _lastOfferSdp == null) {
        return;
      }

      _legacySignalingFallbackActive = true;
      debugPrint(
          '[KINGZ WebRTC] no dotted answer yet; sending legacy offer fallback (gen=$generation)');
      _sendSignal?.call({
        'type': 'webrtc-offer',
        'sdp': _lastOfferSdp ?? '',
        'descriptionType': _lastOfferType,
        'offerGeneration': generation,
      });
    });
  }

  /// Attach PCM message and state handlers to plugin's data channel.
  void _attachPcmDataChannel(RTCDataChannel channel, int generation) {
    _pcmDataChannel = channel;
    debugPrint(
        '[KINGZ WebRTC] _attachPcmDataChannel: gen=$generation label=${channel.label} state=${channel.state}');

    channel.onMessage = (RTCDataChannelMessage message) {
      final currentGen = _offerGeneration;
      final isActive = _active;

      if (generation != currentGen || !isActive) {
        debugPrint(
            '[KINGZ PCM] DROPPED: gen=$generation currentGen=$currentGen active=$isActive');
        return;
      }

      // Log isBinary flag before accessing .binary to detect text-vs-binary mismatch.
      final isBinary = message.isBinary;
      final data = message.binary;
      _pcmPacketCount++;

      if (_pcmPacketCount <= 10) {
        debugPrint(
            '[KINGZ PCM] packet #$_pcmPacketCount: isBinary=$isBinary bytes=${data.length}');
      }

      if (data.isEmpty) {
        // If isBinary=true but bytes=0 it means flutter_webrtc decoded it as text.
        debugPrint(
            '[KINGZ PCM] EMPTY packet #$_pcmPacketCount: isBinary=$isBinary text="${isBinary ? '(binary flag set — zero bytes)' : message.text.length > 40 ? message.text.substring(0, 40) : message.text}"');
        return;
      }

      _handlePcmDataChannelMessage(data);
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      if (generation != _offerGeneration) {
        debugPrint(
            '[KINGZ PCM] state change ignored (stale gen=$generation current=$_offerGeneration): $state');
        return;
      }
      debugPrint('[KINGZ PCM] state → $state (gen=$generation)');

      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        debugPrint('[KINGZ PCM] OPEN — plugin should begin sending PCM now');
        _updateTelemetry(
          outputActive: false,
          stateOverride: 'native-webrtc-pcm-channel-open',
        );
      } else if (state == RTCDataChannelState.RTCDataChannelClosed) {
        _updateTelemetry(
          outputActive: false,
          stateOverride: 'native-webrtc-pcm-channel-closed',
        );
      }
    };
  }

  /// Process incoming PCM data and trigger playback started on first packet.
  void _handlePcmDataChannelMessage(typed.Uint8List bytes) {
    PcmPlaybackTelemetry telemetry;
    try {
      telemetry = _pcmPlaybackBridge.enqueueBytes(
        bytes,
        channels: 2,
        sampleRate: _streamSampleRate,
        bitDepth: 16,
        chunkDurationMs: ((bytes.lengthInBytes / 4) * 1000 / _streamSampleRate)
            .round()
            .clamp(1, 100),
      );
    } catch (e, st) {
      debugPrint('[KINGZ PCM] enqueueBytes error (packet dropped): $e\n$st');
      return;
    }
    onTelemetry?.call(telemetry);

    if (!_playbackStartedSignaled && telemetry.outputActive) {
      _playbackStartedSignaled = true;
      debugPrint('[KINGZ WebRTC] first valid PCM received, playback started');
      onPlaybackStarted?.call();
    }
  }

  /// Fix DTLS setup attribute in answer SDP for answerer role.
  /// Valid answerer values: 'active' or 'passive' (not 'actpass').
  /// Normalize invalid values to 'passive' for flutter_webrtc compatibility.
  String _fixAnswerSdpSetup(String originalSdp) {
    final lines = originalSdp.split('\n');
    final fixed = <String>[];

    for (final line in lines) {
      if (line.startsWith('a=setup:')) {
        final value = line.substring('a=setup:'.length).trim();
        if (value == 'active' || value == 'passive') {
          fixed.add(line);
        } else {
          debugPrint('[KINGZ SDP] fixed setup: $line → a=setup:passive');
          fixed.add('a=setup:passive');
        }
      } else {
        fixed.add(line);
      }
    }

    return fixed.join('\n');
  }

  /// Close peer connection and data channel.
  void _closePeer() {
    if (_pcmDataChannel != null) {
      try {
        _pcmDataChannel?.close();
      } catch (_) {}
      _pcmDataChannel = null;
    }

    if (_peer != null) {
      try {
        _peer?.close();
      } catch (_) {}
      _peer = null;
    }
  }

  /// Update telemetry state.
  void _updateTelemetry({
    bool? outputActive,
    String? stateOverride,
  }) {
    _telemetry = PcmPlaybackTelemetry(
      audioContextState: stateOverride ?? _telemetry.audioContextState,
      outputActive: outputActive ?? _telemetry.outputActive,
      playbackBufferDepthMs: _telemetry.playbackBufferDepthMs,
      scheduledAudioTimeMs: _telemetry.scheduledAudioTimeMs,
      underrunCount: _telemetry.underrunCount,
      decodedSampleRate: _telemetry.decodedSampleRate,
      decodedChannels: _telemetry.decodedChannels,
      chunkDurationMs: _telemetry.chunkDurationMs,
      scheduledLeadMs: _telemetry.scheduledLeadMs,
    );
    onTelemetry?.call(_telemetry);
  }

  /// Schedule disconnect recovery after connection failure.
  void _scheduleDisconnectRecovery(int generation) {
    _disconnectTimer?.cancel();
    _disconnectTimer = Timer(const Duration(seconds: 2), () {
      if (generation == _offerGeneration && _active) {
        debugPrint('[KINGZ WebRTC] disconnect recovery triggered');
        onFallback?.call('connection-failed');
      }
    });
  }

  /// Check if offer generation matches (stale message filtering).
  bool _matchesOfferGeneration(dynamic offerGeneration) {
    return offerGeneration is int && offerGeneration == _offerGeneration;
  }
}
