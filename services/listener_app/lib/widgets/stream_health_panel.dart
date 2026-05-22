import 'package:flutter/material.dart';

class StreamHealthPanel extends StatelessWidget {
  const StreamHealthPanel({
    required this.bufferStatus,
    required this.networkStatus,
    required this.droppedPackets,
    required this.latency,
    required this.packetFlow,
    required this.averageLatency,
    required this.jitter,
    required this.latencyStability,
    required this.packetTiming,
    required this.streamQuality,
    required this.bufferTarget,
    required this.reconnectRecovery,
    required this.streamMode,
    required this.targetBuffer,
    required this.currentBuffer,
    required this.underruns,
    required this.queueDepth,
    required this.packetDelay,
    required this.packetRecovery,
    required this.bufferPressure,
    required this.bufferPressureTrend,
    required this.streamConfidence,
    required this.streamConfidenceScore,
    required this.packetIntegrity,
    required this.realPcmChunks,
    required this.payloadRate,
    required this.payloadSize,
    required this.reconnectCount,
    required this.streamRestartCount,
    required this.lastPacket,
    required this.estimatedBitrate,
    required this.streamUptime,
    required this.audioContextState,
    required this.playbackBufferDepth,
    required this.scheduledAudioTime,
    required this.playbackUnderruns,
    required this.outputState,
    required this.resumeResult,
    required this.isLive,
    required this.isReconnecting,
    super.key,
  });

  final String bufferStatus;
  final String networkStatus;
  final String droppedPackets;
  final String latency;
  final String packetFlow;
  final String averageLatency;
  final String jitter;
  final String latencyStability;
  final String packetTiming;
  final String streamQuality;
  final String bufferTarget;
  final String reconnectRecovery;
  final String streamMode;
  final String targetBuffer;
  final String currentBuffer;
  final String underruns;
  final String queueDepth;
  final String packetDelay;
  final String packetRecovery;
  final String bufferPressure;
  final String bufferPressureTrend;
  final String streamConfidence;
  final String streamConfidenceScore;
  final String packetIntegrity;
  final String realPcmChunks;
  final String payloadRate;
  final String payloadSize;
  final String reconnectCount;
  final String streamRestartCount;
  final String lastPacket;
  final String estimatedBitrate;
  final String streamUptime;
  final String audioContextState;
  final String playbackBufferDepth;
  final String scheduledAudioTime;
  final String playbackUnderruns;
  final String outputState;
  final String resumeResult;
  final bool isLive;
  final bool isReconnecting;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
      padding: const EdgeInsets.fromLTRB(13, 10, 13, 11),
      decoration: BoxDecoration(
        color: const Color(0xFF0D0D0D).withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: isReconnecting
              ? const Color(0xFFE6BA64)
              : const Color(0xFF282216),
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFD6A84F).withValues(
              alpha: isReconnecting
                  ? 0.18
                  : isLive
                      ? 0.12
                      : 0.05,
            ),
            blurRadius: isReconnecting || isLive ? 32 : 18,
            spreadRadius: isReconnecting || isLive ? -2 : -8,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _TransportIndicator(
                  isReconnecting: isReconnecting, isLive: isLive),
              const SizedBox(width: 7),
              const Text(
                'Signal telemetry',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, constraints) {
              final useGrid = constraints.maxWidth >= 360;
              final tileWidth = useGrid
                  ? (constraints.maxWidth - 10) / 2
                  : constraints.maxWidth;

              return Wrap(
                spacing: 10,
                runSpacing: 8,
                children: [
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Buffer',
                    value: bufferStatus,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Network',
                    value: networkStatus,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Drops',
                    value: droppedPackets,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Latency',
                    value: latency,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Packet flow',
                    value: packetFlow,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Queue',
                    value: queueDepth,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'PCM chunks',
                    value: realPcmChunks,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Payload rate',
                    value: payloadRate,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Payload size',
                    value: payloadSize,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Bitrate',
                    value: estimatedBitrate,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Last packet',
                    value: lastPacket,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Uptime',
                    value: streamUptime,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Audio ctx',
                    value: audioContextState,
                    isActive: audioContextState == 'running',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Playback buf',
                    value: playbackBufferDepth,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Lead',
                    value: scheduledAudioTime,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Output',
                    value: outputState,
                    isActive: outputState == 'active',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Resume',
                    value: resumeResult,
                    isActive: resumeResult == 'resumed' ||
                        resumeResult == 'scheduled',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Delay',
                    value: packetDelay,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Average',
                    value: averageLatency,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Jitter',
                    value: jitter,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Stability',
                    value: latencyStability,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Timing',
                    value: packetTiming,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Quality',
                    value: streamQuality,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Mode',
                    value: streamMode,
                    isActive: isLive,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Target',
                    value: targetBuffer,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Current',
                    value: currentBuffer,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Buffer plan',
                    value: bufferTarget,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Underruns',
                    value: underruns,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Out underruns',
                    value: playbackUnderruns,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Recovery',
                    value: packetRecovery,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Pressure',
                    value: bufferPressure,
                    isActive: bufferPressure == 'High',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Trend',
                    value: bufferPressureTrend,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Confidence',
                    value: streamConfidence,
                    isActive: streamConfidence == 'High',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Score',
                    value: streamConfidenceScore,
                    isActive: streamConfidence == 'High',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Integrity',
                    value: packetIntegrity,
                    isActive: packetIntegrity != 'Clean' &&
                        packetIntegrity != 'Ready',
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Reconnect',
                    value: reconnectRecovery,
                    isActive: isReconnecting,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Reconnects',
                    value: reconnectCount,
                    isActive: isReconnecting,
                  ),
                  _TelemetryTile(
                    width: tileWidth,
                    label: 'Restarts',
                    value: streamRestartCount,
                    isActive: isReconnecting,
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _TransportIndicator extends StatefulWidget {
  const _TransportIndicator({
    required this.isReconnecting,
    required this.isLive,
  });

  final bool isReconnecting;
  final bool isLive;

  @override
  State<_TransportIndicator> createState() => _TransportIndicatorState();
}

class _TransportIndicatorState extends State<_TransportIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    if (widget.isReconnecting || widget.isLive) {
      _controller.repeat(reverse: !widget.isReconnecting);
    }
  }

  @override
  void didUpdateWidget(covariant _TransportIndicator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if ((widget.isReconnecting || widget.isLive) && !_controller.isAnimating) {
      _controller.repeat(reverse: !widget.isReconnecting);
      return;
    }

    if (!widget.isReconnecting && !widget.isLive && _controller.isAnimating) {
      _controller.stop();
      _controller.value = 0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final icon = widget.isReconnecting
        ? Icons.sync_rounded
        : widget.isLive
            ? Icons.sensors_rounded
            : Icons.monitor_heart_rounded;

    return widget.isReconnecting
        ? RotationTransition(
            turns: _controller,
            child: Icon(icon, color: const Color(0xFFD6A84F), size: 17),
          )
        : FadeTransition(
            opacity: Tween<double>(begin: 0.55, end: 1).animate(_controller),
            child: Icon(icon, color: const Color(0xFFD6A84F), size: 17),
          );
  }
}

class _TelemetryTile extends StatelessWidget {
  const _TelemetryTile({
    required this.width,
    required this.label,
    required this.value,
    this.isActive = false,
  });

  final double width;
  final String label;
  final String value;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: const Color(0xFF090909).withValues(alpha: 0.72),
          borderRadius: BorderRadius.circular(13),
          border: Border.all(
            color: isActive ? const Color(0xFF51401F) : const Color(0xFF221F18),
          ),
        ),
        child: Row(
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              width: 6,
              height: isActive ? 22 : 18,
              decoration: BoxDecoration(
                color: const Color(0xFFD6A84F).withValues(
                  alpha: isActive ? 1 : 0.78,
                ),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label.toUpperCase(),
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.46),
                      fontSize: 10,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 1.2,
                    ),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
