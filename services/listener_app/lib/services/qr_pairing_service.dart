import 'dart:math';

import 'package:flutter/foundation.dart';

class QrPairingService {
  QrPairingService._();

  static final Random _rng = Random.secure();

  // Unambiguous charset — no 0/O, 1/I/L.
  static const _chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  static String generateSessionId() {
    final code = String.fromCharCodes(
      List.generate(4, (_) => _chars.codeUnitAt(_rng.nextInt(_chars.length))),
    );
    final id = 'KZ-$code';
    debugPrint('[qr-pairing] session-id-generated id=$id');
    return id;
  }

  static String buildPrimaryUrl({
    required String host,
    required int port,
    required String sessionId,
  }) {
    final url = 'kingzlisten://join?host=$host&port=$port&session=$sessionId';
    debugPrint('[qr-pairing] lan-url-generated url=$url');
    return url;
  }

  static String buildFallbackUrl({
    required String host,
    required int port,
    required String sessionId,
  }) {
    return 'http://$host:$port?session=$sessionId';
  }

  /// Parses both `kingzlisten://join?...` and `http://host:port?...` formats.
  static ({String? host, int? port, String? session}) parsePairingUrl(
    String raw,
  ) {
    try {
      final uri = Uri.parse(raw.trim());
      if (uri.scheme == 'kingzlisten') {
        return (
          host: uri.queryParameters['host'],
          port: int.tryParse(uri.queryParameters['port'] ?? ''),
          session: uri.queryParameters['session'],
        );
      }
      if (uri.scheme == 'http' || uri.scheme == 'https') {
        final host = uri.host.isNotEmpty ? uri.host : null;
        final port = uri.hasPort ? uri.port : null;
        return (
          host: host,
          port: port,
          session: uri.queryParameters['session'],
        );
      }
    } catch (_) {}
    return (host: null, port: null, session: null);
  }

  static void logListenerOpened() {
    debugPrint('[qr-pairing] listener-opened-from-qr');
  }
}
