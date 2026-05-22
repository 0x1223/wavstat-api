import 'package:flutter/material.dart';

class StatusPill extends StatefulWidget {
  const StatusPill({required this.status, super.key});

  final String status;

  @override
  State<StatusPill> createState() => _StatusPillState();
}

class _StatusPillState extends State<StatusPill>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController;

  bool get _isReconnecting => widget.status == 'recovering';

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    _syncPulse();
  }

  @override
  void didUpdateWidget(covariant StatusPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.status != widget.status) {
      _syncPulse();
    }
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  void _syncPulse() {
    if (_isReconnecting) {
      _pulseController.repeat(reverse: true);
    } else {
      _pulseController.stop();
      _pulseController.value = 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final isActive = widget.status == 'ready' || widget.status == 'playing';
    final isError = widget.status == 'error';
    final color = isActive
        ? const Color(0xFFD6A84F)
        : isError
            ? const Color(0xFFFFB4A8)
            : _isReconnecting
                ? const Color(0xFFD6A84F)
                : const Color(0xFFA8A8A8);
    final background = isActive
        ? const Color(0xFFD6A84F).withValues(alpha: 0.13)
        : isError
            ? const Color(0xFF3A1510).withValues(alpha: 0.78)
            : const Color(0xFF141414).withValues(alpha: 0.82);

    return AnimatedBuilder(
      animation: _pulseController,
      builder: (context, child) {
        final pulse = _isReconnecting ? _pulseController.value : 0.0;

        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: color.withValues(
                  alpha: isActive || _isReconnecting ? 0.56 : 0.24),
            ),
            boxShadow: isActive || _isReconnecting
                ? [
                    BoxShadow(
                      color: const Color(0xFFD6A84F).withValues(
                        alpha: 0.12 + pulse * 0.1,
                      ),
                      blurRadius: 16 + pulse * 10,
                      spreadRadius: pulse,
                    ),
                  ]
                : null,
          ),
          child: child,
        );
      },
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ScaleTransition(
            scale: Tween<double>(begin: 1, end: 1.35).animate(
              CurvedAnimation(parent: _pulseController, curve: Curves.easeOut),
            ),
            child: Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: 7),
          Text(
            widget.status.toUpperCase(),
            style: TextStyle(
              color: color,
              fontSize: 10.5,
              fontWeight: FontWeight.w900,
              letterSpacing: 1.1,
            ),
          ),
        ],
      ),
    );
  }
}
