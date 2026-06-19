import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Bridges the iOS lock-screen Now Playing card (native `MPNowPlayingInfoCenter` +
/// `MPRemoteCommandCenter` in AppDelegate) to the app's playback.
///
/// Native remote play/pause/toggle are delivered here and routed to the existing playback entry
/// points (no parallel audio path). State pushes are deduped so callers can sync freely. iOS-only:
/// a no-op on web (lock-screen card there is the browser's own `navigator.mediaSession`).
class NowPlayingService {
  static const MethodChannel _channel =
      MethodChannel('com.kingzbreadent.kingzlisten/nowplaying');

  /// Lock-screen "play" pressed → start playback.
  VoidCallback? onRemotePlay;

  /// Lock-screen "pause" pressed → stop playback.
  VoidCallback? onRemotePause;

  /// Lock-screen play/pause toggle → caller decides based on current state.
  VoidCallback? onRemoteToggle;

  String? _lastTitle;
  String? _lastSubtitle;
  bool? _lastIsPlaying;

  NowPlayingService() {
    if (!kIsWeb) {
      _channel.setMethodCallHandler(_handleNative);
    }
  }

  Future<dynamic> _handleNative(MethodCall call) async {
    if (call.method == 'remoteCommand') {
      switch (call.arguments as String?) {
        case 'play':
          onRemotePlay?.call();
          break;
        case 'pause':
          onRemotePause?.call();
          break;
        case 'toggle':
          onRemoteToggle?.call();
          break;
      }
    }
    return null;
  }

  Future<void> setNowPlaying({
    required String title,
    required String subtitle,
    required bool isPlaying,
  }) async {
    if (kIsWeb) return;
    if (title == _lastTitle &&
        subtitle == _lastSubtitle &&
        isPlaying == _lastIsPlaying) {
      return; // dedupe: nothing changed
    }
    _lastTitle = title;
    _lastSubtitle = subtitle;
    _lastIsPlaying = isPlaying;
    try {
      await _channel.invokeMethod('setNowPlaying', <String, dynamic>{
        'title': title,
        'subtitle': subtitle,
        'isPlaying': isPlaying,
      });
    } catch (_) {
      // Channel not available (e.g. non-iOS) — ignore.
    }
  }

  Future<void> clear() async {
    if (kIsWeb) return;
    if (_lastTitle == null && _lastIsPlaying == null) return; // already cleared
    _lastTitle = null;
    _lastSubtitle = null;
    _lastIsPlaying = null;
    try {
      await _channel.invokeMethod('clear');
    } catch (_) {}
  }

  void dispose() {
    if (!kIsWeb) {
      _channel.setMethodCallHandler(null);
    }
  }
}
