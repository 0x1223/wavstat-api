import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../services/qr_pairing_service.dart';

class QrScannerPage extends StatefulWidget {
  const QrScannerPage._();

  /// Pushes the scanner onto the navigator. Returns the parsed connection
  /// details on a valid scan, or null if the user cancelled.
  static Future<({String host, int port, String? session})?> push(
    BuildContext context,
  ) {
    return Navigator.of(context).push<({String host, int port, String? session})>(
      MaterialPageRoute(builder: (_) => const QrScannerPage._()),
    );
  }

  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  late final MobileScannerController _controller;
  bool _torchOn = false;

  /// Guard flag — prevents multiple pops if the detector fires twice.
  bool _scanned = false;

  @override
  void initState() {
    super.initState();
    _controller = MobileScannerController(
      formats: const [BarcodeFormat.qrCode],
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_scanned) return;
    final barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;
    final raw = barcodes.first.rawValue;
    if (raw == null) return;
    final result = QrPairingService.parsePairingUrl(raw);
    if (result.host == null || result.port == null) return;
    _scanned = true;
    QrPairingService.logListenerOpened();
    Navigator.of(context).pop((
      host: result.host!,
      port: result.port!,
      session: result.session,
    ));
  }

  Future<void> _toggleTorch() async {
    await _controller.toggleTorch();
    setState(() => _torchOn = !_torchOn);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          const _ScanOverlay(),
          // ── Top bar ──────────────────────────────────────────────────────
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _NavChip(
                    onTap: () => Navigator.of(context).pop(null),
                    child: const Icon(
                      Icons.close_rounded,
                      color: Colors.white,
                      size: 22,
                    ),
                  ),
                  const Text(
                    'SCAN QR',
                    style: TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w900,
                      fontSize: 16,
                      letterSpacing: 1.6,
                    ),
                  ),
                  _NavChip(
                    onTap: _toggleTorch,
                    highlighted: _torchOn,
                    child: Icon(
                      _torchOn
                          ? Icons.flashlight_on_rounded
                          : Icons.flashlight_off_rounded,
                      color: _torchOn ? Colors.black : Colors.white,
                      size: 22,
                    ),
                  ),
                ],
              ),
            ),
          ),
          // ── Bottom hint ───────────────────────────────────────────────────
          Positioned(
            bottom: 80,
            left: 0,
            right: 0,
            child: Text(
              'Point at the QR code on the desktop',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.72),
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Nav chip ─────────────────────────────────────────────────────────────────

class _NavChip extends StatelessWidget {
  const _NavChip({
    required this.onTap,
    required this.child,
    this.highlighted = false,
  });

  final VoidCallback onTap;
  final Widget child;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: highlighted
              ? const Color(0xFFD6A84F).withValues(alpha: 0.90)
              : Colors.black.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(10),
        ),
        child: child,
      ),
    );
  }
}

// ── Scan overlay ─────────────────────────────────────────────────────────────

const double _cutoutSize = 264;

class _ScanOverlay extends StatelessWidget {
  const _ScanOverlay();

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _OverlayPainter(),
      child: const SizedBox.expand(),
    );
  }
}

class _OverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2;
    final cy = size.height / 2;
    final rect = Rect.fromCenter(
      center: Offset(cx, cy),
      width: _cutoutSize,
      height: _cutoutSize,
    );

    // Dark vignette with transparent cutout window
    final bgPaint = Paint()..color = Colors.black.withValues(alpha: 0.62);
    final path = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addRRect(RRect.fromRectAndRadius(rect, const Radius.circular(16)))
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(path, bgPaint);

    // Subtle gold border around the cutout
    final borderPaint = Paint()
      ..color = const Color(0xFFD6A84F).withValues(alpha: 0.55)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, const Radius.circular(16)),
      borderPaint,
    );

    // Bright gold corner accents
    const accentLen = 28.0;
    const accentThick = 3.5;
    const cornerInset = 14.0; // start accent after the rounded corner
    final accentPaint = Paint()
      ..color = const Color(0xFFD6A84F)
      ..style = PaintingStyle.stroke
      ..strokeWidth = accentThick
      ..strokeCap = StrokeCap.round;

    final l = rect.left;
    final t = rect.top;
    final r = rect.right;
    final b = rect.bottom;

    // Top-left
    canvas.drawLine(Offset(l, t + cornerInset), Offset(l, t + accentLen), accentPaint);
    canvas.drawLine(Offset(l + cornerInset, t), Offset(l + accentLen, t), accentPaint);
    // Top-right
    canvas.drawLine(Offset(r, t + cornerInset), Offset(r, t + accentLen), accentPaint);
    canvas.drawLine(Offset(r - cornerInset, t), Offset(r - accentLen, t), accentPaint);
    // Bottom-left
    canvas.drawLine(Offset(l, b - cornerInset), Offset(l, b - accentLen), accentPaint);
    canvas.drawLine(Offset(l + cornerInset, b), Offset(l + accentLen, b), accentPaint);
    // Bottom-right
    canvas.drawLine(Offset(r, b - cornerInset), Offset(r, b - accentLen), accentPaint);
    canvas.drawLine(Offset(r - cornerInset, b), Offset(r - accentLen, b), accentPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
