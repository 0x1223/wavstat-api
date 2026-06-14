import 'package:flutter/material.dart';

class TransportControls extends StatefulWidget {
  const TransportControls({
    required this.isConnected,
    required this.isPlaying,
    required this.isBuffering,
    required this.isMuted,
    required this.volume,
    required this.onPlay,
    required this.onStop,
    required this.onMute,
    required this.onVolumeChanged,
    super.key,
  });

  final bool isConnected;
  final bool isPlaying;
  final bool isBuffering;
  final bool isMuted;
  final double volume;
  final VoidCallback onPlay;
  final VoidCallback onStop;
  final VoidCallback onMute;
  final ValueChanged<double> onVolumeChanged;

  @override
  State<TransportControls> createState() => _TransportControlsState();
}

class _TransportControlsState extends State<TransportControls>
    with SingleTickerProviderStateMixin {
  bool _isHoveringPlay = false;
  bool _isPressingPlay = false;
  late final AnimationController _pulseController;

  bool get _canPlay =>
      widget.isConnected && !widget.isPlaying && !widget.isBuffering;
  bool get _canStop =>
      widget.isConnected && (widget.isPlaying || widget.isBuffering);

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
      lowerBound: 0,
      upperBound: 1,
    );
  }

  @override
  void didUpdateWidget(covariant TransportControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isBuffering) {
      if (!_pulseController.isAnimating) {
        _pulseController.repeat(reverse: true);
      }
      return;
    }

    _pulseController.stop();
    _pulseController.value = 0;
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 15, 18, 11),
      decoration: BoxDecoration(
        color: const Color(0xFF0C0C0C).withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: const Color(0xFF46391F)),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFD6A84F).withValues(alpha: 0.08),
            blurRadius: 36,
            spreadRadius: -4,
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.34),
            blurRadius: 36,
            offset: const Offset(0, 20),
          ),
        ],
      ),
      child: Column(
        children: [
          Text(
            'MONITOR',
            style: TextStyle(
              color: const Color(0xFFD6A84F).withValues(alpha: 0.78),
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: 2.4,
            ),
          ),
          const SizedBox(height: 11),
          MouseRegion(
            onEnter: (_) => setState(() => _isHoveringPlay = true),
            onExit: (_) => setState(() {
              _isHoveringPlay = false;
              _isPressingPlay = false;
            }),
            child: GestureDetector(
              onTap: _canPlay ? widget.onPlay : null,
              onTapDown: _canPlay
                  ? (_) => setState(() => _isPressingPlay = true)
                  : null,
              onTapUp: _canPlay
                  ? (_) => setState(() => _isPressingPlay = false)
                  : null,
              onTapCancel: _canPlay
                  ? () => setState(() => _isPressingPlay = false)
                  : null,
              child: AnimatedBuilder(
                animation: _pulseController,
                builder: (context, child) {
                  final pulse = _pulseController.value;
                  final isActive = widget.isBuffering;

                  return AnimatedScale(
                    duration: const Duration(milliseconds: 140),
                    curve: Curves.easeOutCubic,
                    scale: _isPressingPlay
                        ? 0.96
                        : isActive
                            ? 1 + pulse * 0.025
                            : _isHoveringPlay && _canPlay
                                ? 1.035
                                : 1,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      curve: Curves.easeOutCubic,
                      width: 120,
                      height: 120,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: _canPlay || isActive
                              ? const [Color(0xFFF0CF83), Color(0xFFC49338)]
                              : const [Color(0xFF37301F), Color(0xFF1F1B14)],
                        ),
                        border: Border.all(
                          color: _canPlay || isActive
                              ? const Color(0xFFFFE0A0)
                              : const Color(0xFF4A402B),
                          width: 1.4,
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: const Color(0xFFD6A84F).withValues(
                              alpha: isActive
                                  ? 0.28 + pulse * 0.18
                                  : _canPlay
                                      ? 0.32
                                      : 0.07,
                            ),
                            blurRadius: isActive
                                ? 38 + pulse * 18
                                : _isHoveringPlay
                                    ? 44
                                    : 34,
                            spreadRadius: isActive
                                ? 2 + pulse * 5
                                : _isHoveringPlay
                                    ? 4
                                    : 1,
                          ),
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.55),
                            blurRadius: 26,
                            offset: const Offset(0, 18),
                          ),
                        ],
                      ),
                      child: widget.isBuffering
                          ? const Center(
                              child: SizedBox(
                                width: 34,
                                height: 34,
                                child: CircularProgressIndicator(
                                  strokeWidth: 3,
                                  color: Color(0xFF090909),
                                ),
                              ),
                            )
                          : Icon(
                              widget.isPlaying
                                  ? Icons.graphic_eq_rounded
                                  : Icons.play_arrow_rounded,
                              size: widget.isPlaying ? 52 : 64,
                              color: _canPlay || isActive
                                  ? const Color(0xFF090909)
                                  : const Color(0xFF8B7A55),
                            ),
                    ),
                  );
                },
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _canStop ? widget.onStop : null,
                  icon: const Icon(Icons.stop_rounded),
                  label: const Text('Stop'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor:
                        _canStop ? const Color(0xFF090909) : Colors.white,
                    backgroundColor: _canStop ? const Color(0xFFD6A84F) : null,
                    disabledForegroundColor:
                        Colors.white.withValues(alpha: 0.34),
                    side: BorderSide(
                      color: _canStop
                          ? const Color(0xFFFFE0A0)
                          : const Color(0xFF3A3A3A),
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 11),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: widget.onMute,
                  icon: Icon(
                    widget.isMuted
                        ? Icons.volume_off_rounded
                        : Icons.volume_up_rounded,
                  ),
                  label: Text(widget.isMuted ? 'Muted' : 'Mute'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Color(0xFF3A3A3A)),
                    padding: const EdgeInsets.symmetric(vertical: 11),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 18),
              activeTrackColor: const Color(0xFFD6A84F),
              inactiveTrackColor: const Color(0xFF2A2A2A),
              thumbColor: const Color(0xFFF0CF83),
              overlayColor: const Color(0xFFD6A84F).withValues(alpha: 0.14),
            ),
            child: Row(
              children: [
                Icon(
                  widget.isMuted
                      ? Icons.volume_off_rounded
                      : Icons.volume_down_rounded,
                  color: const Color(0xFFD6A84F),
                ),
                Expanded(
                  child: Slider(
                    value: widget.volume,
                    min: 0,
                    max: 1,
                    onChanged: widget.onVolumeChanged,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
