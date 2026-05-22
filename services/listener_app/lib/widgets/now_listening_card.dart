import 'package:flutter/material.dart';

class NowListeningCard extends StatelessWidget {
  const NowListeningCard({
    required this.isPlaying,
    required this.durationLabel,
    required this.latency,
    super.key,
  });

  final bool isPlaying;
  final String durationLabel;
  final String latency;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: const Color(0xFF121212).withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: isPlaying ? const Color(0xFFD6A84F) : const Color(0xFF2C261A),
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFFD6A84F).withValues(
              alpha: isPlaying ? 0.18 : 0.04,
            ),
            blurRadius: isPlaying ? 42 : 24,
            spreadRadius: isPlaying ? -2 : -8,
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.22),
            blurRadius: 30,
            offset: const Offset(0, 18),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Now listening',
            style: TextStyle(
              color: const Color(0xFFD6A84F).withValues(alpha: 0.76),
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: 1.3,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Studio Session',
            style: TextStyle(
              color: Colors.white,
              fontSize: 24,
              fontWeight: FontWeight.w900,
              height: 1,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Engineer: KINGZ Studio',
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.56),
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 11),
          Row(
            children: [
              const Expanded(
                child: _InfoTile(label: 'Quality', value: '48kHz / 16-bit'),
              ),
              const SizedBox(width: 10),
              Expanded(
                  child: _InfoTile(label: 'Duration', value: durationLabel)),
              const SizedBox(width: 10),
              Expanded(child: _InfoTile(label: 'Latency', value: latency)),
            ],
          ),
        ],
      ),
    );
  }
}

class _InfoTile extends StatelessWidget {
  const _InfoTile({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      decoration: BoxDecoration(
        color: const Color(0xFF090909).withValues(alpha: 0.76),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0xFF332A18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.48),
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFFD6A84F),
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}
