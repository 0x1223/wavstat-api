import WaveSurfer from "wavesurfer.js";

// Singleton audio engine for mobile — lives outside the React component tree
// so comment state changes and re-renders never cause WaveSurfer to be
// destroyed or re-created.

let _ws = null;
let _url = null;
let _wasPlayingOnHide = false;
const _handlers = { current: null };

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!_ws) return;
    if (document.hidden) {
      _wasPlayingOnHide = _ws.isPlaying();
    } else {
      // Resume a suspended AudioContext when returning from background (iOS)
      try {
        const ac = _ws.options?.audioContext;
        if (ac?.state === "suspended") ac.resume();
      } catch (_) {}
      if (_wasPlayingOnHide) {
        _wasPlayingOnHide = false;
        _ws.play().catch(() => {});
      }
    }
  });
}

/**
 * Mount or reuse the singleton WaveSurfer instance.
 * Returns the WaveSurfer instance synchronously; it may not be ready yet.
 * If called with the same URL as the currently loaded instance, existing
 * playback is preserved and only the handlers are updated.
 *
 * handlers: { onReady, onError, onDurationChange, onTimeUpdate, onPlaybackChange }
 */
export function mountMobileEngine(container, url, handlers) {
  _handlers.current = handlers;

  if (_url === url && _ws) {
    return _ws;
  }

  if (_ws) {
    _ws.destroy();
    _ws = null;
  }

  _url = url;

  if (!url) return null;

  const ws = WaveSurfer.create({
    container,
    url,
    waveColor: "#6d6457",
    progressColor: "#d6a354",
    cursorColor: "#f5efe3",
    cursorWidth: 2,
    height: 180,
    barWidth: 2,
    barGap: 2,
    barRadius: 2,
    autoScroll: false,
    autoCenter: false,
    normalize: true,
    dragToSeek: true,
    fillParent: true,
  });

  _ws = ws;

  ws.on("ready", () => {
    if (_ws !== ws) return;
    const duration = ws.getDuration();
    const mediaElement = ws.getMediaElement?.();
    if (mediaElement) {
      mediaElement.muted = false;
      mediaElement.volume = 1;
      mediaElement.preload = "auto";
    }
    _handlers.current?.onDurationChange?.(duration);
    _handlers.current?.onReady?.({
      wavesurfer: ws,
      mediaElement,
      play: async () => { await ws.play(); },
      pause: () => ws.pause(),
      playPause: async () => { await ws.playPause(); },
      skip: (s) => ws.skip(s),
      seekToTime: (time) => {
        const t = Math.min(Math.max(time, 0), ws.getDuration());
        ws.setTime(t);
        _handlers.current?.onTimeUpdate?.(t);
      },
    });
  });

  ws.on("error", (error) => {
    if (_ws !== ws) return;
    _handlers.current?.onError?.(error);
  });

  ws.on("timeupdate", (time) => {
    if (_ws === ws) _handlers.current?.onTimeUpdate?.(time);
  });

  ws.on("play", () => {
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(true);
  });
  ws.on("pause", () => {
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
  });
  ws.on("finish", () => {
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
  });

  return ws;
}

/** Destroy the singleton. Called when the audio source changes or the session ends. */
export function disposeMobileEngine() {
  if (_ws) {
    _ws.destroy();
    _ws = null;
  }
  _url = null;
  _wasPlayingOnHide = false;
  _handlers.current = null;
}
