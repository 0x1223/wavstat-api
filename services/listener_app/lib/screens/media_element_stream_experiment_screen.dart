import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

class MediaElementStreamExperimentScreen extends StatefulWidget {
  const MediaElementStreamExperimentScreen({super.key});

  @override
  State<MediaElementStreamExperimentScreen> createState() =>
      _MediaElementStreamExperimentScreenState();
}

class _MediaElementStreamExperimentScreenState
    extends State<MediaElementStreamExperimentScreen> {
  web.HTMLAudioElement? _audio;
  JSFunction? _playListener;
  JSFunction? _pauseListener;
  JSFunction? _waitingListener;
  JSFunction? _canPlayListener;
  JSFunction? _errorListener;
  JSFunction? _stalledListener;
  JSFunction? _suspendListener;
  JSFunction? _playingListener;
  JSFunction? _emptiedListener;
  JSFunction? _timeUpdateListener;
  JSFunction? _loadStartListener;
  JSFunction? _loadedMetadataListener;
  Timer? _positionTimer;
  late final Uri _audioUrl;
  String _status = 'ready';
  String _position = '0:00';
  num? _lastMediaTime;
  int? _lastTimeUpdateAtMs;
  int _mediaElementCreateCount = 0;
  bool _playing = false;

  @override
  void initState() {
    super.initState();
    _audioUrl = _resolveExperimentAudioUrl();
    _createMediaElement();
  }

  @override
  void dispose() {
    _positionTimer?.cancel();
    final audio = _audio;
    if (audio != null) {
      if (_playListener != null) {
        audio.removeEventListener('play', _playListener);
      }
      if (_pauseListener != null) {
        audio.removeEventListener('pause', _pauseListener);
      }
      if (_waitingListener != null) {
        audio.removeEventListener('waiting', _waitingListener);
      }
      if (_canPlayListener != null) {
        audio.removeEventListener('canplay', _canPlayListener);
      }
      if (_errorListener != null) {
        audio.removeEventListener('error', _errorListener);
      }
      if (_stalledListener != null) {
        audio.removeEventListener('stalled', _stalledListener);
      }
      if (_suspendListener != null) {
        audio.removeEventListener('suspend', _suspendListener);
      }
      if (_playingListener != null) {
        audio.removeEventListener('playing', _playingListener);
      }
      if (_emptiedListener != null) {
        audio.removeEventListener('emptied', _emptiedListener);
      }
      if (_timeUpdateListener != null) {
        audio.removeEventListener('timeupdate', _timeUpdateListener);
      }
      if (_loadStartListener != null) {
        audio.removeEventListener('loadstart', _loadStartListener);
      }
      if (_loadedMetadataListener != null) {
        audio.removeEventListener('loadedmetadata', _loadedMetadataListener);
      }
      try {
        audio.pause();
      } catch (_) {}
      audio.remove();
    }
    try {
      web.window.navigator.mediaSession.playbackState = 'paused';
    } catch (_) {}
    super.dispose();
  }

  Uri _resolveExperimentAudioUrl() {
    final query = Uri.base.queryParameters;
    final mediaUrl = query['mediaUrl'];
    if (mediaUrl != null && mediaUrl.isNotEmpty) {
      return Uri.parse(mediaUrl);
    }

    final serverHost = query['serverHost']?.trim().isNotEmpty == true
        ? query['serverHost']!.trim()
        : Uri.base.host;
    final serverPort = int.tryParse(query['serverPort'] ?? '') ?? 8080;

    return Uri(
      scheme: 'http',
      host: serverHost.isEmpty ? '127.0.0.1' : serverHost,
      port: serverPort,
      path: '/media_element_stream_experiment/test.mp3',
    );
  }

  void _createMediaElement() {
    final audio = web.HTMLAudioElement();
    _mediaElementCreateCount += 1;
    audio.src = _audioUrl.toString();
    audio.loop = true;
    audio.muted = false;
    audio.defaultMuted = false;
    audio.volume = 1;
    audio.controls = false;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.setAttribute('data-experiment', 'media_element_stream_experiment');
    audio.setAttribute(
      'style',
      'position:fixed;width:1px;height:1px;opacity:0;'
          'pointer-events:none;left:-10000px;top:auto;',
    );

    _playListener = ((web.Event _) {
      _logMediaDiagnostic('play', audio);
      _setPlaybackState('playing', playing: true);
    }).toJS;
    _pauseListener = ((web.Event _) {
      _logMediaDiagnostic('pause', audio);
      _setPlaybackState('paused', playing: false);
    }).toJS;
    _waitingListener = ((web.Event _) {
      _logMediaDiagnostic('waiting', audio);
      _setPlaybackState('buffering');
    }).toJS;
    _canPlayListener = ((web.Event _) {
      _logMediaDiagnostic('canplay', audio);
      if (!_playing) {
        _setPlaybackState('can play');
      }
    }).toJS;
    _errorListener = ((web.Event _) {
      _logMediaDiagnostic('error', audio);
      _setPlaybackState('error: ${audio.error?.message ?? 'media failed'}');
    }).toJS;
    _stalledListener = ((web.Event _) {
      _logMediaDiagnostic('stalled', audio);
    }).toJS;
    _suspendListener = ((web.Event _) {
      _logMediaDiagnostic('suspend', audio);
    }).toJS;
    _playingListener = ((web.Event _) {
      _logMediaDiagnostic('playing', audio);
    }).toJS;
    _emptiedListener = ((web.Event _) {
      _logMediaDiagnostic('emptied', audio);
    }).toJS;
    _timeUpdateListener = ((web.Event _) {
      _logTimeUpdateDiagnostic(audio);
    }).toJS;
    _loadStartListener = ((web.Event _) {
      _logMediaDiagnostic('loadstart', audio);
    }).toJS;
    _loadedMetadataListener = ((web.Event _) {
      _logMediaDiagnostic('loadedmetadata', audio);
    }).toJS;

    audio.addEventListener('play', _playListener);
    audio.addEventListener('pause', _pauseListener);
    audio.addEventListener('waiting', _waitingListener);
    audio.addEventListener('canplay', _canPlayListener);
    audio.addEventListener('error', _errorListener);
    audio.addEventListener('stalled', _stalledListener);
    audio.addEventListener('suspend', _suspendListener);
    audio.addEventListener('playing', _playingListener);
    audio.addEventListener('emptied', _emptiedListener);
    audio.addEventListener('timeupdate', _timeUpdateListener);
    audio.addEventListener('loadstart', _loadStartListener);
    audio.addEventListener('loadedmetadata', _loadedMetadataListener);
    web.document.body?.append(audio);
    _audio = audio;
    _configureMediaSession();
    _logMediaDiagnostic('created', audio);
  }

  void _configureMediaSession() {
    try {
      web.window.navigator.mediaSession.metadata = web.MediaMetadata(
        web.MediaMetadataInit(
          title: 'KINGZ LISTEN',
          artist: 'LAN Audio Receiver',
        ),
      );
      web.window.navigator.mediaSession.playbackState =
          _playing ? 'playing' : 'paused';
    } catch (_) {}
  }

  Future<void> _play() async {
    final audio = _audio;
    if (audio == null) {
      return;
    }

    try {
      _configureMediaSession();
      await audio.play().toDart;
      _setPlaybackState('playing', playing: true);
      _startPositionTimer();
      _logMediaDiagnostic('play-promise-resolved', audio);
      web.console.log(
        '[media-element-stream-experiment] native-html-audio-playing'.toJS,
      );
    } catch (_) {
      _logMediaDiagnostic('play-promise-rejected', audio);
      _setPlaybackState('play blocked');
    }
  }

  void _pause() {
    final audio = _audio;
    if (audio == null) {
      return;
    }

    audio.pause();
    _setPlaybackState('paused', playing: false);
  }

  void _logTimeUpdateDiagnostic(web.HTMLAudioElement audio) {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final mediaTime = audio.currentTime;
    final previousTime = _lastMediaTime;
    final previousWallTime = _lastTimeUpdateAtMs;

    if (previousTime != null && previousWallTime != null) {
      final mediaDelta = mediaTime - previousTime;
      final wallDelta = (nowMs - previousWallTime) / 1000;
      final jump = (mediaDelta - wallDelta).abs();
      final loopBoundary = previousTime > 25 && mediaTime < 2;

      if (jump > 1.25 && !loopBoundary) {
        _logMediaDiagnostic(
          'currentTime-jump',
          audio,
          detail:
              'previous=${previousTime.toStringAsFixed(3)} current=${mediaTime.toStringAsFixed(3)} wallDelta=${wallDelta.toStringAsFixed(3)}',
        );
      } else if (loopBoundary) {
        _logMediaDiagnostic(
          'loop-boundary',
          audio,
          detail:
              'previous=${previousTime.toStringAsFixed(3)} current=${mediaTime.toStringAsFixed(3)}',
        );
      }
    }

    _lastMediaTime = mediaTime;
    _lastTimeUpdateAtMs = nowMs;
  }

  void _logMediaDiagnostic(
    String event,
    web.HTMLAudioElement audio, {
    String detail = '',
  }) {
    web.console.log(
      '[media-element-stream-experiment] '
              'event=$event '
              'detail=$detail '
              'created=$_mediaElementCreateCount '
              'hidden=${web.document.hidden} '
              'visibility=${web.document.visibilityState} '
              'paused=${audio.paused} '
              'ended=${audio.ended} '
              'currentTime=${audio.currentTime.toStringAsFixed(3)} '
              'duration=${audio.duration.isFinite ? audio.duration.toStringAsFixed(3) : audio.duration} '
              'readyState=${audio.readyState} '
              'networkState=${audio.networkState} '
              'buffered=${_formatBufferedRanges(audio)} '
              'src=${audio.currentSrc.isNotEmpty ? audio.currentSrc : audio.src}'
          .toJS,
    );
  }

  String _formatBufferedRanges(web.HTMLAudioElement audio) {
    final buffered = audio.buffered;
    final ranges = <String>[];
    for (var index = 0; index < buffered.length; index += 1) {
      try {
        ranges.add(
          '${buffered.start(index).toStringAsFixed(3)}-${buffered.end(index).toStringAsFixed(3)}',
        );
      } catch (_) {}
    }
    return ranges.isEmpty ? 'empty' : ranges.join(',');
  }

  void _setPlaybackState(String status, {bool? playing}) {
    if (!mounted) {
      return;
    }

    setState(() {
      _status = status;
      if (playing != null) {
        _playing = playing;
      }
      _position = _formatSeconds(_audio?.currentTime ?? 0);
    });
    try {
      web.window.navigator.mediaSession.playbackState =
          _playing ? 'playing' : 'paused';
    } catch (_) {}
  }

  void _startPositionTimer() {
    _positionTimer?.cancel();
    _positionTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) {
        return;
      }
      setState(() {
        _position = _formatSeconds(_audio?.currentTime ?? 0);
      });
    });
  }

  String _formatSeconds(num seconds) {
    final wholeSeconds = seconds.floor();
    final minutes = wholeSeconds ~/ 60;
    final remainder = wholeSeconds.remainder(60).toString().padLeft(2, '0');
    return '$minutes:$remainder';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'media_element_stream_experiment',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 12),
              Text('Source: $_audioUrl'),
              const SizedBox(height: 8),
              Text('Status: $_status'),
              Text('Position: $_position'),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _playing ? null : _play,
                child: const Text('Play Native Media Element'),
              ),
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _playing ? _pause : null,
                child: const Text('Pause'),
              ),
              const SizedBox(height: 22),
              const Text(
                'Use this screen only to test whether native HTMLAudioElement '
                'playback appears on the iPhone lock screen and survives lock, '
                'minimize, and app switching.',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
