import 'package:flutter/material.dart';

import '../models/transport_config.dart';

class MonitoringModeSelector extends StatelessWidget {
  const MonitoringModeSelector({
    required this.selectedMode,
    required this.onModeSelected,
    super.key,
  });

  final MonitoringMode selectedMode;
  final ValueChanged<MonitoringMode> onModeSelected;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: const Color(0xFF0D0D0D).withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFF282216)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Monitoring Mode',
            style: TextStyle(
              color: const Color(0xFFD6A84F).withValues(alpha: 0.78),
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: 1.8,
            ),
          ),
          const SizedBox(height: 9),
          Row(
            children: MonitoringMode.values.map((mode) {
              final isSelected = mode == selectedMode;
              return Expanded(
                child: Padding(
                  padding: EdgeInsets.only(
                    right: mode == MonitoringMode.safeBuffer ? 0 : 8,
                  ),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => onModeSelected(mode),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      decoration: BoxDecoration(
                        color: isSelected
                            ? const Color(0xFFD6A84F).withValues(alpha: 0.16)
                            : const Color(0xFF090909).withValues(alpha: 0.72),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isSelected
                              ? const Color(0xFFD6A84F)
                              : const Color(0xFF221F18),
                        ),
                      ),
                      child: Text(
                        mode.label,
                        textAlign: TextAlign.center,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: isSelected
                              ? const Color(0xFFF0CF83)
                              : Colors.white.withValues(alpha: 0.72),
                          fontSize: 12,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}
