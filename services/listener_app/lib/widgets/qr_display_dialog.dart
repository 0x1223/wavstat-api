import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../services/qr_pairing_service.dart';

class QrDisplayDialog extends StatefulWidget {
  const QrDisplayDialog._({required this.host, required this.port});

  final String host;
  final int port;

  static Future<void> show(
    BuildContext context, {
    required String host,
    required int port,
  }) {
    return showDialog<void>(
      context: context,
      builder: (_) => QrDisplayDialog._(host: host, port: port),
    );
  }

  @override
  State<QrDisplayDialog> createState() => _QrDisplayDialogState();
}

class _QrDisplayDialogState extends State<QrDisplayDialog> {
  late final String _sessionId;
  late final String _primaryUrl;
  late final String _fallbackUrl;

  @override
  void initState() {
    super.initState();
    _sessionId = QrPairingService.generateSessionId();
    _primaryUrl = QrPairingService.buildPrimaryUrl(
      host: widget.host,
      port: widget.port,
      sessionId: _sessionId,
    );
    _fallbackUrl = QrPairingService.buildFallbackUrl(
      host: widget.host,
      port: widget.port,
      sessionId: _sessionId,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: const Color(0xFF1A1610),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'SCAN TO CONNECT',
              style: TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.8,
              ),
            ),
            const SizedBox(height: 18),
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
              ),
              padding: const EdgeInsets.all(12),
              child: QrImageView(
                data: _primaryUrl,
                version: QrVersions.auto,
                size: 230,
                backgroundColor: Colors.white,
              ),
            ),
            const SizedBox(height: 14),
            // Session-ID badge
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xFFD6A84F).withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: const Color(0xFFD6A84F).withValues(alpha: 0.45),
                ),
              ),
              child: Text(
                _sessionId,
                style: const TextStyle(
                  color: Color(0xFFD6A84F),
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 3,
                ),
              ),
            ),
            const SizedBox(height: 10),
            // Subtle fallback URL
            Text(
              _fallbackUrl,
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.35),
                fontSize: 10,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text(
                'Done',
                style: TextStyle(
                  color: Color(0xFFD6A84F),
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
