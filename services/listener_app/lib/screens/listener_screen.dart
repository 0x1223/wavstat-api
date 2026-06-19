import 'dart:async';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

import '../models/listener_playback_state.dart';
import '../models/realtime_stream_metrics.dart';
import '../models/stream_telemetry.dart';
import '../models/transport_config.dart';
import '../services/lan_audio_client.dart';
import '../widgets/connection_card.dart';
import '../widgets/monitoring_mode_selector.dart';
import '../widgets/now_listening_card.dart';
import '../widgets/status_pill.dart';
import '../widgets/stream_health_panel.dart';
import '../widgets/transport_controls.dart';

enum ListenerStatus {
  disconnected,
  connected,
  reconnecting,
  buffering,
  playing,
  stopped,
  streamLost,
  error,
}

extension ListenerStatusLabel on ListenerStatus {
  String get label => switch (this) {
        ListenerStatus.disconnected => 'disconnected',
        ListenerStatus.connected => 'ready',
        ListenerStatus.reconnecting => 'recovering',
        ListenerStatus.buffering => 'buffering',
        ListenerStatus.playing => 'playing',
        ListenerStatus.stopped => 'stopped',
        ListenerStatus.streamLost => 'stream lost',
        ListenerStatus.error => 'error',
      };
}

class ListenerScreen extends StatefulWidget {
  const ListenerScreen({super.key});

  @override
  State<ListenerScreen> createState() => _ListenerScreenState();
}

class _ListenerScreenState extends State<ListenerScreen> {
  final TextEditingController _serverIpController = TextEditingController(
    text: _defaultServerHost(),
  );
  final TextEditingController _portController = TextEditingController(
    text: '8082', // Plugin port (handles both HTTP and WebRTC)
  );
  final AudioPlayer _audioPlayer = AudioPlayer();
  final LanAudioClient _lanAudioClient = LanAudioClient();

  StreamSubscription<LanAudioEvent>? _lanAudioSubscription;
  StreamSubscription<PlayerState>? _playerStateSubscription;
  StreamSubscription<Duration?>? _durationSubscription;
  ListenerStatus _status = ListenerStatus.disconnected;
  bool _muted = false;
  bool _playRequestInFlight = false;
  bool _listenSessionActive = false;
  double _volume = 0.82;
  int _playbackOperation = 0;
  StreamTelemetry _telemetry = const StreamTelemetry();
  RealtimeStreamMetrics _realtimeMetrics = const RealtimeStreamMetrics();
  ListenerPlaybackState _playbackState = const ListenerPlaybackState();
  TransportConfig _transportConfig = const TransportConfig();
  String _durationLabel = '--:--';

  bool get _isConnected =>
      _status == ListenerStatus.connected ||
      _status == ListenerStatus.buffering ||
      _status == ListenerStatus.playing ||
      _status == ListenerStatus.stopped ||
      _status == ListenerStatus.streamLost;

  bool get _shouldShowAudioResumeOverlay {
    final lastPacketAt = _realtimeMetrics.lastPacketAtMs;
    final packetAgeMs = lastPacketAt <= 0
        ? 1 << 31
        : DateTime.now().millisecondsSinceEpoch - lastPacketAt;
    final contextBlocked = _realtimeMetrics.audioContextState == 'suspended' ||
        _realtimeMetrics.audioContextState == 'interrupted' ||
        _realtimeMetrics.lastResumeResult == 'manual-required';

    return _realtimeMetrics.manualResumeRequired &&
        _realtimeMetrics.realPcmChunksReceived > 0 &&
        packetAgeMs <= 2500 &&
        !_realtimeMetrics.outputActive &&
        contextBlocked &&
        (_status == ListenerStatus.playing ||
            _status == ListenerStatus.buffering ||
            _status == ListenerStatus.streamLost);
  }

  @override
  void initState() {
    super.initState();
    _audioPlayer.setVolume(_volume);
    _audioPlayer.setLoopMode(LoopMode.one);
    _lanAudioSubscription = _lanAudioClient.events.listen(_handleLanAudioEvent);
    _playerStateSubscription =
        _audioPlayer.playerStateStream.listen(_handlePlayerState);
    _durationSubscription = _audioPlayer.durationStream.listen((duration) {
      if (!mounted || duration == null) {
        return;
      }

      setState(() {
        _durationLabel = _formatDuration(duration);
      });
    });
  }

  @override
  void dispose() {
    _lanAudioSubscription?.cancel();
    _playerStateSubscription?.cancel();
    _durationSubscription?.cancel();
    _lanAudioClient.dispose();
    _audioPlayer.dispose();
    _serverIpController.dispose();
    _portController.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    FocusScope.of(context).unfocus();
    final serverIp = _serverIpController.text.trim();
    final port = _portController.text.trim().isEmpty
        ? '8082' // Plugin single-port (HTTP + WebRTC)
        : _portController.text.trim();

    if (serverIp.isEmpty) {
      _setError('Missing server IP');
      return;
    }

    final uri = _buildWebSocketUri(serverIp, port);

    setState(() {
      _status = ListenerStatus.reconnecting;
      _telemetry = _telemetry.copyWith(
        bufferStatus: 'Connecting',
        networkStatus: 'Opening LAN socket',
      );
    });

    await _lanAudioClient.connect(uri);
  }

  static String _defaultServerHost() => '192.168.0.246';

  Uri _buildWebSocketUri(String serverIp, String port) {
    final normalized = serverIp
        .replaceFirst(RegExp(r'^wss?://'), '')
        .replaceFirst(RegExp(r'^https?://'), '')
        .split('/')
        .first
        .split(':')
        .first;
    return Uri(
      scheme: 'ws',
      host: normalized,
      port: int.tryParse(port) ?? 8082,
    );
  }

  Future<void> _disconnect() async {
    await _stop();
    await _lanAudioClient.disconnect();

    setState(() {
      _status = ListenerStatus.disconnected;
      _telemetry = const StreamTelemetry();
      _realtimeMetrics = const RealtimeStreamMetrics();
      _playbackState = const ListenerPlaybackState();
      _transportConfig = const TransportConfig();
    });
  }

  Future<void> _play() async {
    debugPrint('[KINGZ] _play: ENTRY isConnected=$_isConnected');
    if (_playRequestInFlight ||
        _listenSessionActive ||
        _status == ListenerStatus.playing ||
        _status == ListenerStatus.buffering) {
      debugPrint(
        '[KINGZ] _play: EXIT (already active) '
        'requestInFlight=$_playRequestInFlight '
        'listenSessionActive=$_listenSessionActive status=$_status',
      );
      return;
    }

    if (!_isConnected) {
      debugPrint('[KINGZ] _play: EXIT (not connected)');
      _setError('Connect to LAN server first');
      return;
    }

    setState(() {
      _playRequestInFlight = true;
      _listenSessionActive = true;
      _status = ListenerStatus.buffering;
      _telemetry = _telemetry.copyWith(
        bufferStatus: 'Buffering',
        networkStatus: 'Opening audio stream',
      );
    });

    debugPrint('[KINGZ] _play: mode=${_transportConfig.mode}');
    final operation = ++_playbackOperation;
    try {
      final pcmPlaybackActive = await _lanAudioClient.startListening(
        _transportConfig.mode,
        enablePcmPlayback: true,
      );
      debugPrint(
          '[KINGZ] _play: startListening returned pcmPlaybackActive=$pcmPlaybackActive');
      debugPrint('[KINGZ] _play: status is now $_status');
      debugPrint(
          '[KINGZ] _play: current _telemetry.bufferStatus=${_telemetry.bufferStatus}');
      if (operation != _playbackOperation) {
        debugPrint('[KINGZ] _play: EXIT (operation changed)');
        return;
      }
      if (pcmPlaybackActive) {
        debugPrint(
            '[KINGZ] _play: transport active; waiting for first PCM packet');
        return;
      }
      debugPrint('[KINGZ] _play: ERROR - pcmPlaybackActive=false');
      _listenSessionActive = false;
      _setError('Audio transport unavailable');
    } catch (e, st) {
      debugPrint('[KINGZ] _play error: $e\n$st');
      _listenSessionActive = false;
      _setError('Unable to play stream');
    } finally {
      if (mounted && operation == _playbackOperation) {
        setState(() {
          _playRequestInFlight = false;
        });
      }
    }
  }

  Future<void> _stop({
    bool readyAfterStop = false,
  }) async {
    final operation = ++_playbackOperation;
    _playRequestInFlight = false;
    if (mounted) {
      setState(() {
        _listenSessionActive = false;
        _status = _status == ListenerStatus.disconnected
            ? ListenerStatus.disconnected
            : readyAfterStop
                ? ListenerStatus.connected
                : ListenerStatus.stopped;
        _telemetry = _telemetry.copyWith(
          bufferStatus: 'Stopped',
          networkStatus: 'Stopping audio stream',
        );
      });
    }
    await _lanAudioClient.stopListening();
    await _audioPlayer.stop();

    if (!mounted || operation != _playbackOperation) {
      return;
    }

    setState(() {
      _status = _status == ListenerStatus.disconnected
          ? ListenerStatus.disconnected
          : readyAfterStop
              ? ListenerStatus.connected
              : ListenerStatus.stopped;
      _telemetry = _telemetry.copyWith(
        bufferStatus: 'Stopped',
        networkStatus: 'LAN connected',
      );
    });
  }

  Future<void> _toggleMute() async {
    final nextMuted = !_muted;
    await _audioPlayer.setVolume(nextMuted ? 0 : _volume);
    setState(() {
      _muted = nextMuted;
    });
  }

  Future<void> _resumeAudioOutput() async {
    await _lanAudioClient.resumeAudioOutput();
  }

  Future<void> _setVolume(double value) async {
    await _audioPlayer.setVolume(_muted ? 0 : value);
    setState(() {
      _volume = value;
    });
  }

  void _handleLanAudioEvent(LanAudioEvent event) {
    if (!mounted) {
      return;
    }

    setState(() {
      if (event.telemetry != null) {
        _telemetry = event.telemetry!;
      }

      if (event.streamTransport != null) {
        // Plugin (engineer) dictates the broadcast codec; reflect it on the read-only indicator.
        _streamTransport = event.streamTransport!;
      }

      if (event.dawTransportPlaying != null) {
        final dawPlaying = event.dawTransportPlaying!;
        _telemetry = _telemetry.copyWith(
          networkStatus: dawPlaying ? 'DAW playing' : 'DAW stopped',
        );
      }

      if (event.realtimeMetrics != null) {
        _realtimeMetrics = event.realtimeMetrics!;
      }

      if (event.playbackState != null) {
        _playbackState = event.playbackState!;
      }

      if (event.transportConfig != null) {
        _transportConfig = event.transportConfig!;
      }

      if (event.durationLabel != null) {
        _durationLabel = event.durationLabel!;
      }

      if (event.connectionState != null) {
        _status = switch (event.connectionState!) {
          LanAudioConnectionState.disconnected => ListenerStatus.disconnected,
          LanAudioConnectionState.connected => _listenSessionActive ||
                  _status == ListenerStatus.playing ||
                  _status == ListenerStatus.buffering ||
                  _status == ListenerStatus.stopped
              ? _status
              : ListenerStatus.connected,
          LanAudioConnectionState.reconnecting => ListenerStatus.reconnecting,
          LanAudioConnectionState.error => ListenerStatus.error,
        };
      }

      if (event.streamStatus != null) {
        final nextStatus = switch (event.streamStatus!) {
          'playing' => ListenerStatus.playing,
          'buffering' => ListenerStatus.buffering,
          'stopped' => ListenerStatus.stopped,
          'stream_lost' => ListenerStatus.streamLost,
          'recovering' => ListenerStatus.reconnecting,
          'connected' => ListenerStatus.connected,
          'reconnecting' => ListenerStatus.reconnecting,
          'disconnected' => ListenerStatus.disconnected,
          _ => _status,
        };

        if (nextStatus == ListenerStatus.playing ||
            nextStatus == ListenerStatus.buffering ||
            nextStatus == ListenerStatus.streamLost) {
          _listenSessionActive = true;
          _status = nextStatus;
        } else if (nextStatus == ListenerStatus.stopped ||
            nextStatus == ListenerStatus.disconnected) {
          _listenSessionActive = false;
          _status = nextStatus;
        } else if (!_listenSessionActive) {
          _status = nextStatus;
        }
      }

      if (event.errorMessage != null) {
        _listenSessionActive = false;
        _telemetry = _telemetry.copyWith(
          bufferStatus: 'Stopped',
          networkStatus: event.errorMessage,
        );
      }

      if (event.realtimeMetrics?.packetFlow == 'Active' &&
          (_audioPlayer.playing || _listenSessionActive) &&
          _status == ListenerStatus.streamLost) {
        _status = ListenerStatus.playing;
      }

      if (_listenSessionActive &&
          event.realtimeMetrics?.outputActive == true &&
          _status == ListenerStatus.buffering) {
        _status = ListenerStatus.playing;
        _telemetry = _telemetry.copyWith(
          bufferStatus: 'Playing',
          networkStatus: 'Active LAN stream',
        );
      }

      if (_listenSessionActive &&
          _status != ListenerStatus.playing &&
          _status != ListenerStatus.buffering &&
          _status != ListenerStatus.streamLost &&
          _status != ListenerStatus.reconnecting) {
        _status = ListenerStatus.buffering;
      }
    });
  }

  void _setError(String networkStatus) {
    setState(() {
      _listenSessionActive = false;
      _status = ListenerStatus.error;
      _telemetry = _telemetry.copyWith(
        networkStatus: networkStatus,
        bufferStatus: 'Stopped',
      );
    });
  }

  StreamTransport _streamTransport = StreamTransport.pcm;

  void _selectMonitoringMode(MonitoringMode mode) {
    setState(() {
      _transportConfig = _transportConfig.copyWith(mode: mode);
      _playbackState = _playbackState.copyWith(streamMode: mode.label);
    });
    _lanAudioClient.prepare(mode);
  }


  void _handlePlayerState(PlayerState playerState) {
    if (!mounted) {
      return;
    }

    // Native WebRTC/PCM playback owns state while a listen session is active.
    // The legacy just_audio player can still emit loading/buffering states even
    // though it is no longer the active output path.
    if (_listenSessionActive) {
      return;
    }

    final processingState = playerState.processingState;
    setState(() {
      if (processingState == ProcessingState.buffering ||
          processingState == ProcessingState.loading) {
        if (_status != ListenerStatus.streamLost) {
          _status = ListenerStatus.buffering;
        }
        _telemetry = _telemetry.copyWith(bufferStatus: 'Buffering');
        return;
      }

      if (playerState.playing) {
        if (_status != ListenerStatus.streamLost &&
            _status != ListenerStatus.reconnecting) {
          _status = ListenerStatus.playing;
        }
        _telemetry = _telemetry.copyWith(
          bufferStatus: 'Playing',
          networkStatus: 'Active LAN stream',
        );
        return;
      }

      if (processingState == ProcessingState.idle) {
        _status = _isConnected ? ListenerStatus.stopped : _status;
        _telemetry = _telemetry.copyWith(bufferStatus: 'Stopped');
      }

      if (processingState == ProcessingState.completed) {
        unawaited(_lanAudioClient.stopListening());
        _status = _isConnected ? ListenerStatus.stopped : _status;
        _telemetry = _telemetry.copyWith(bufferStatus: 'Stopped');
      }
    });
  }

  String _formatDuration(Duration duration) {
    final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$minutes:$seconds';
  }

  String _formatPacketTime(int packetAtMs) {
    if (packetAtMs <= 0) {
      return '--';
    }

    final packetAt = DateTime.fromMillisecondsSinceEpoch(packetAtMs);
    final hour = packetAt.hour.toString().padLeft(2, '0');
    final minute = packetAt.minute.toString().padLeft(2, '0');
    final second = packetAt.second.toString().padLeft(2, '0');
    return '$hour:$minute:$second';
  }

  String _formatUptime(int uptimeMs) {
    if (uptimeMs <= 0) {
      return '0s';
    }

    final seconds = uptimeMs ~/ 1000;
    final minutes = seconds ~/ 60;
    final remainingSeconds = seconds.remainder(60).toString().padLeft(2, '0');
    return '$minutes:$remainingSeconds';
  }

  String _formatAverageLatency() {
    if (_realtimeMetrics.receivedPackets < 2) {
      return 'measuring';
    }

    return '${_realtimeMetrics.averageLatencyMs} ms avg';
  }

  String _formatLatencyStability() {
    if (_realtimeMetrics.receivedPackets < 3) {
      return 'warming';
    }

    return '${_realtimeMetrics.latencyVarianceMs} ms variance';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              Color(0xFF141109),
              Color(0xFF070707),
              Color(0xFF0B0B0D),
              Color(0xFF050505),
            ],
            stops: [0, 0.28, 0.68, 1],
          ),
        ),
        child: Stack(
          children: [
            const Positioned.fill(child: _AmbientStudioLight()),
            SafeArea(
              child: Column(
                children: [
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(16, 13, 16, 10),
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 520),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              _Header(status: _status),
                              const SizedBox(height: 14),
                              ConnectionCard(
                                serverIpController: _serverIpController,
                                portController: _portController,
                                isConnected: _isConnected,
                                onConnect: _connect,
                                onDisconnect: _disconnect,
                              ),
                              const SizedBox(height: 12),
                              NowListeningCard(
                                isPlaying: _status == ListenerStatus.playing,
                                durationLabel: _durationLabel,
                                latency: _telemetry.latency,
                              ),
                              const SizedBox(height: 12),
                              MonitoringModeSelector(
                                selectedMode: _transportConfig.mode,
                                onModeSelected: _selectMonitoringMode,
                              ),
                              const SizedBox(height: 12),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 6),
                                    child: Text(
                                      'Broadcast quality · set by studio',
                                      style:
                                          Theme.of(context).textTheme.bodySmall,
                                    ),
                                  ),
                                  // Read-only indicator: the plugin (engineer) dictates the codec
                                  // and the app auto-follows via transport.mode — no user input.
                                  SegmentedButton<StreamTransport>(
                                    segments: const [
                                      ButtonSegment(
                                        value: StreamTransport.pcm,
                                        label: Text('Raw PCM'),
                                      ),
                                      ButtonSegment(
                                        value: StreamTransport.opus,
                                        label: Text('Opus'),
                                      ),
                                    ],
                                    selected: {_streamTransport},
                                    onSelectionChanged: null,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 13),
                              TransportControls(
                                isConnected: _isConnected,
                                isPlaying: _listenSessionActive &&
                                    _status != ListenerStatus.buffering,
                                isBuffering: _listenSessionActive &&
                                    _status == ListenerStatus.buffering,
                                isMuted: _muted,
                                volume: _volume,
                                onPlay: () {
                                  unawaited(_play());
                                },
                                onStop: () {
                                  unawaited(_stop());
                                },
                                onMute: _toggleMute,
                                onVolumeChanged: _setVolume,
                              ),
                              const SizedBox(height: 12),
                              StreamHealthPanel(
                                bufferStatus: _telemetry.bufferStatus,
                                networkStatus: _telemetry.networkStatus,
                                droppedPackets: _telemetry.droppedPackets,
                                latency: _telemetry.latency,
                                packetFlow: _realtimeMetrics.packetFlow,
                                averageLatency: _formatAverageLatency(),
                                jitter:
                                    '${_realtimeMetrics.jitterMs} ms jitter',
                                latencyStability: _formatLatencyStability(),
                                packetTiming:
                                    _realtimeMetrics.packetTimingConsistency,
                                streamQuality: _realtimeMetrics.qualityState,
                                bufferTarget: _realtimeMetrics.bufferTarget,
                                reconnectRecovery: _realtimeMetrics
                                            .reconnectRecoveryMs >
                                        0
                                    ? '${_realtimeMetrics.reconnectRecoveryMs} ms recovery'
                                    : 'Ready',
                                streamMode: _playbackState.streamMode,
                                targetBuffer:
                                    '${_transportConfig.targetBufferMs} ms',
                                currentBuffer:
                                    '${_transportConfig.currentBufferMs} ms',
                                underruns:
                                    _transportConfig.underrunCount.toString(),
                                queueDepth:
                                    _realtimeMetrics.queueDepth.toString(),
                                packetDelay:
                                    '${_realtimeMetrics.packetDelayMs} ms',
                                packetRecovery:
                                    _realtimeMetrics.packetRecoveryState,
                                bufferPressure: _realtimeMetrics.bufferPressure,
                                bufferPressureTrend:
                                    _realtimeMetrics.bufferPressureTrend,
                                streamConfidence:
                                    _realtimeMetrics.streamConfidence,
                                streamConfidenceScore:
                                    '${_realtimeMetrics.streamConfidenceScore}%',
                                packetIntegrity:
                                    _realtimeMetrics.packetIntegrityState,
                                realPcmChunks:
                                    '${_realtimeMetrics.realPcmChunksReceived} session / ${_realtimeMetrics.lifetimePcmChunksReceived} total',
                                payloadRate:
                                    '${_realtimeMetrics.payloadRateKbps} kbps',
                                payloadSize:
                                    '${_realtimeMetrics.lastPayloadSize} bytes',
                                reconnectCount:
                                    _realtimeMetrics.reconnectCount.toString(),
                                streamRestartCount: _realtimeMetrics
                                    .streamRestartCount
                                    .toString(),
                                lastPacket: _formatPacketTime(
                                  _realtimeMetrics.lastPacketAtMs,
                                ),
                                estimatedBitrate:
                                    '${_realtimeMetrics.payloadRateKbps} kbps',
                                streamUptime: _formatUptime(
                                  _realtimeMetrics.streamUptimeMs,
                                ),
                                audioContextState:
                                    _realtimeMetrics.audioContextState,
                                playbackBufferDepth:
                                    '${_realtimeMetrics.playbackBufferDepthMs} ms',
                                scheduledAudioTime:
                                    '${_realtimeMetrics.scheduledLeadMs} ms',
                                playbackUnderruns: _realtimeMetrics
                                    .playbackUnderrunCount
                                    .toString(),
                                outputState: _realtimeMetrics.outputActive
                                    ? 'active'
                                    : 'inactive',
                                resumeResult: _realtimeMetrics.lastResumeResult,
                                isLive: _status == ListenerStatus.playing ||
                                    _status == ListenerStatus.buffering,
                                isReconnecting:
                                    _status == ListenerStatus.reconnecting ||
                                        _realtimeMetrics.isReconnecting,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  _BottomStatusBar(status: _status),
                ],
              ),
            ),
            if (_shouldShowAudioResumeOverlay)
              Positioned.fill(
                child: _AudioResumeOverlay(onResume: _resumeAudioOutput),
              ),
          ],
        ),
      ),
    );
  }
}

class _AudioResumeOverlay extends StatelessWidget {
  const _AudioResumeOverlay({required this.onResume});

  final Future<void> Function() onResume;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black.withValues(alpha: 0.36),
      child: Center(
        child: ElevatedButton.icon(
          onPressed: () {
            unawaited(onResume());
          },
          icon: const Icon(Icons.volume_up_rounded),
          label: const Text('Tap to Resume Audio'),
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFFD6A84F),
            foregroundColor: const Color(0xFF090909),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
            textStyle: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w900,
            ),
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.status});

  final ListenerStatus status;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Positioned(
                  left: -18,
                  top: -22,
                  child: Container(
                    width: 230,
                    height: 76,
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        colors: [
                          const Color(0xFFD6A84F).withValues(alpha: 0.18),
                          Colors.transparent,
                        ],
                      ),
                    ),
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'KINGZ LISTEN',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 30,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 0.7,
                        height: 0.95,
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      'LAN AUDIO RECEIVER',
                      style: TextStyle(
                        color: const Color(0xFFD6A84F).withValues(alpha: 0.78),
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.8,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          StatusPill(status: status.label),
        ],
      ),
    );
  }
}

class _AmbientStudioLight extends StatelessWidget {
  const _AmbientStudioLight();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: const Alignment(-0.45, -0.92),
            radius: 1.2,
            colors: [
              const Color(0xFFD6A84F).withValues(alpha: 0.12),
              const Color(0xFF17110A).withValues(alpha: 0.08),
              Colors.transparent,
            ],
            stops: const [0, 0.42, 1],
          ),
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Colors.white.withValues(alpha: 0.035),
                Colors.transparent,
                Colors.black.withValues(alpha: 0.28),
              ],
              stops: const [0, 0.34, 1],
            ),
          ),
        ),
      ),
    );
  }
}

class _BottomStatusBar extends StatelessWidget {
  const _BottomStatusBar({required this.status});

  final ListenerStatus status;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
      decoration: BoxDecoration(
        color: const Color(0xFF070707).withValues(alpha: 0.94),
        border: const Border(top: BorderSide(color: Color(0xFF262018))),
      ),
      child: Text(
        'STATUS  ${status.label.toUpperCase()}',
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Color(0xFFD6A84F),
          fontSize: 14,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}
