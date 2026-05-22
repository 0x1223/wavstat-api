import WaveSurfer from "wavesurfer.js";

// Singleton audio engine for mobile — lives outside the React component tree
// so comment state changes and re-renders never cause WaveSurfer to be
// destroyed or re-created.

// How long to wait for WaveSurfer's waveform decode before activating the
// audio-only fallback.
const WAVEFORM_TIMEOUT_MS = 12_000;
// Shorter timeout for lite mode (weak devices) — fail faster to audio-only.
const WAVEFORM_TIMEOUT_LITE_MS = 6_000;

let _ws = null;
let _nativeAudio = null; // compat mode: native <audio> element
let _url = null;
let _mobileMode = "standard"; // "standard" | "lite" | "compat"
let _wasPlayingOnHide = false;
const _handlers = { current: null };

// Returns the live HTMLMediaElement for whichever engine is active.
function _getMediaEl() {
  if (_ws) return _ws.getMediaElement?.() ?? null;
  if (_nativeAudio) return _nativeAudio;
  return null;
}

/**
 * 1.5 s after a foreground/bfcache restore, check that currentTime is
 * actually advancing.  If it hasn't moved while the element claims to be
 * playing, the AudioContext is probably suspended (playing-but-silent) or
 * the element is stalled.  We log the details and issue a no-op seek to
 * attempt to unstick a buffering stall.  We do not seek to a different
 * position and do not restart playback — those would break scrubbing.
 */
function _schedulePlaybackVerification(mediaEl) {
  const t0 = mediaEl.currentTime;
  setTimeout(() => {
    if (!mediaEl || mediaEl.paused) return; // paused in the interim — OK
    const t1 = mediaEl.currentTime;
    if (Math.abs(t1 - t0) < 0.05) {
      console.warn("[MixReview] Playback verification FAILED — currentTime stalled", {
        t0: t0.toFixed(2), t1: t1.toFixed(2),
        paused: mediaEl.paused,
        readyState: mediaEl.readyState,
        networkState: mediaEl.networkState,
        error: mediaEl.error
          ? { code: mediaEl.error.code, message: mediaEl.error.message }
          : null,
      });
      // No-op seek: can unstick a buffering stall without changing position.
      try { mediaEl.currentTime = mediaEl.currentTime; } catch (_) {}
    } else {
      console.log("[MixReview] Playback verification OK — audio advancing", {
        t0: t0.toFixed(2), t1: t1.toFixed(2),
      });
    }
  }, 1500);
}

if (typeof document !== "undefined") {
  // ── visibilitychange ──────────────────────────────────────────────────────
  // Goal: keep the native audio element playing through background/lock-screen.
  //
  // We do NOT pause on hide. The HTMLMediaElement owns playback state. If it
  // was playing, it will keep playing natively (the OS/browser handles this for
  // <audio> elements that are not routed through a suspended AudioContext).
  //
  // The AudioContext that MobileSpectrumAnalyzer creates for the analyser is
  // handled there: it closes the context on hide (releasing the media element
  // back to native output) and reconnects on show.
  //
  // Here we only: (a) log, and (b) restart audio if the OS force-stopped it
  // while we were backgrounded.
  document.addEventListener("visibilitychange", () => {
    const mediaEl = _getMediaEl();
    const t = mediaEl?.currentTime;
    const paused = mediaEl?.paused ?? true;

    console.log("[MixReview] visibilitychange", {
      hidden: document.hidden,
      mode: _mobileMode,
      paused,
      currentTime: t != null ? t.toFixed(2) : null,
      readyState: mediaEl?.readyState ?? null,
      networkState: mediaEl?.networkState ?? null,
      error: mediaEl?.error
        ? { code: mediaEl.error.code, message: mediaEl.error.message }
        : null,
    });

    if (document.hidden) {
      // Record actual media element state — not WaveSurfer's cached value.
      _wasPlayingOnHide = !paused;
    } else {
      console.log("[MixReview] Foreground restore", {
        wasPlaying: _wasPlayingOnHide,
        nowPaused: paused,
        currentTime: t != null ? t.toFixed(2) : null,
        readyState: mediaEl?.readyState ?? null,
      });
      // Only restart if audio actually stopped while backgrounded (OS killed it
      // or the element errored). If it is still playing, leave it alone.
      if (_wasPlayingOnHide && paused && mediaEl) {
        console.log("[MixReview] Audio stopped in background — restarting");
        if (_ws) {
          _ws.play().catch((e) =>
            console.warn("[MixReview] ws.play restore failed", e.message)
          );
        } else if (_nativeAudio) {
          _nativeAudio.play().catch((e) =>
            console.warn("[MixReview] native play restore failed", e.message)
          );
        }
      }
      // If the element is already playing on restore, verify it is actually
      // advancing (guards against the AudioContext-suspended-but-playing case).
      if (!paused && mediaEl) _schedulePlaybackVerification(mediaEl);
      _wasPlayingOnHide = false;
    }
  });

  // ── pagehide / pageshow ───────────────────────────────────────────────────
  document.addEventListener("pagehide", () => {
    const mediaEl = _getMediaEl();
    console.log("[MixReview] pagehide", {
      mode: _mobileMode,
      paused: mediaEl?.paused,
      currentTime: mediaEl?.currentTime?.toFixed(2) ?? null,
    });
  });

  document.addEventListener("pageshow", (e) => {
    const mediaEl = _getMediaEl();
    const t = mediaEl?.currentTime;
    const paused = mediaEl?.paused ?? true;
    console.log("[MixReview] pageshow", {
      persisted: e.persisted,
      mode: _mobileMode,
      paused,
      currentTime: t != null ? t.toFixed(2) : null,
      readyState: mediaEl?.readyState ?? null,
      networkState: mediaEl?.networkState ?? null,
      error: mediaEl?.error
        ? { code: mediaEl.error.code, message: mediaEl.error.message }
        : null,
    });

    // bfcache restore (persisted === true): the page was frozen and re-shown.
    // The media element's state is frozen — restart if we were playing.
    if (e.persisted && _wasPlayingOnHide && paused && mediaEl) {
      console.log("[MixReview] pageshow bfcache restore — restarting audio");
      if (_ws) {
        _ws.play().catch((err) =>
          console.warn("[MixReview] ws.play bfcache restore failed", err.message)
        );
      } else if (_nativeAudio) {
        _nativeAudio.play().catch((err) =>
          console.warn("[MixReview] native play bfcache restore failed", err.message)
        );
      }
    }
    // If already playing after a persisted restore, verify audio is advancing.
    if (e.persisted && !paused && mediaEl) _schedulePlaybackVerification(mediaEl);
  });
}

// ── Logging helpers ────────────────────────────────────────────────────────

/** HEAD-probe a URL and log status + content-type. Non-blocking. */
async function probeAudioUrl(url) {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    console.log("[MixReview] Audio URL probe", {
      status: r.status,
      contentType: r.headers.get("content-type") ?? "(none)",
      contentLength: r.headers.get("content-length") ?? "(unknown)",
      url: url.slice(0, 120),
    });
  } catch (e) {
    console.warn("[MixReview] Audio URL probe failed", {
      error: e.message,
      url: url.slice(0, 120),
    });
  }
}

/**
 * Attach non-state-changing event listeners to a media element for logging.
 * These never pause, seek, or modify playback — they only console.log.
 * label: short string identifying the source ("ws" | "native")
 */
function _attachMediaLogging(mediaEl, label) {
  if (!mediaEl) return;
  const t = () => (mediaEl.currentTime || 0).toFixed(2);
  mediaEl.addEventListener("play",    () => console.log(`[MixReview:${label}] play`,    { t: t() }));
  mediaEl.addEventListener("pause",   () => console.log(`[MixReview:${label}] pause`,   { t: t() }));
  mediaEl.addEventListener("ended",   () => console.log(`[MixReview:${label}] ended`,   { t: t() }));
  mediaEl.addEventListener("waiting", () => console.log(`[MixReview:${label}] waiting (buffering)`, { t: t() }));
  mediaEl.addEventListener("stalled", () => console.log(`[MixReview:${label}] stalled`, { t: t() }));
  mediaEl.addEventListener("canplay", () => console.log(`[MixReview:${label}] canplay`, { t: t() }));
  mediaEl.addEventListener("error",   () => console.warn(`[MixReview:${label}] error`, {
    code: mediaEl.error?.code,
    message: mediaEl.error?.message,
    t: t(),
  }));
}

// ── Device / capability detection ─────────────────────────────────────────

/**
 * Detect which mobile playback mode to use for this device.
 *
 * "compat"   — Old iOS (< 15) or no WebAudio API: skip WaveSurfer entirely
 *              and use a native HTMLAudioElement for MP3 playback. No waveform,
 *              no analyzer — but playback starts immediately without a decode
 *              step.
 *
 * "lite"     — Weak or low-memory device: use WaveSurfer but with a shorter
 *              decode timeout (fail faster to audio-only) and signal the
 *              analyzer to run at a reduced frame rate.
 *
 * "standard" — Full experience.
 */
export function detectMobileMode() {
  if (typeof navigator === "undefined") return "standard";
  const ua = navigator.userAgent;

  // Old iOS (< 15): WebAudio decode is unreliable; native audio is safer.
  const iosMatch = ua.match(/(?:iPhone|iPad|iPod).+OS (\d+)[_.]/);
  const iosMajor = iosMatch ? parseInt(iosMatch[1], 10) : null;
  if (iosMajor !== null && iosMajor < 15) return "compat";

  // No Web Audio API at all.
  if (typeof AudioContext === "undefined" && typeof webkitAudioContext === "undefined") {
    return "compat";
  }

  // Weak device signals: low RAM, or few CPU cores on an older iOS build.
  const lowMem = typeof navigator.deviceMemory === "number" && navigator.deviceMemory < 2;
  const fewCores = typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 2;
  const olderIOS = iosMajor !== null && iosMajor < 17;

  if (lowMem || (fewCores && olderIOS)) return "lite";

  return "standard";
}

/** Returns the mode currently active for the mounted engine session. */
export function getMobileMode() {
  return _mobileMode;
}

// ── Native audio path (compat mode) ───────────────────────────────────────

/**
 * Create and load a native HTMLAudioElement for compat mode.
 * Fires onWaveformUnavailable(player, "compat") as soon as canplay fires —
 * no WaveSurfer decode step, no WebAudio required.
 * Fires onError only if the element itself reports a load failure.
 */
function _mountNativeAudio(url, handlers) {
  if (_nativeAudio) {
    _nativeAudio.pause();
    _nativeAudio.src = "";
    _nativeAudio = null;
  }

  const audio = new Audio();
  audio.preload = "auto";
  _nativeAudio = audio;
  _attachMediaLogging(audio, "native");

  let didSettle = false;

  const player = {
    wavesurfer: null,
    mediaElement: audio,
    play: async () => { await audio.play(); },
    pause: () => { audio.pause(); },
    playPause: async () => {
      if (audio.paused) { await audio.play(); } else { audio.pause(); }
    },
    skip: (s) => {
      audio.currentTime = Math.max(0, audio.currentTime + s);
    },
    seekToTime: (time) => {
      const t = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : 0));
      audio.currentTime = t;
      _handlers.current?.onTimeUpdate?.(t);
    },
  };

  audio.addEventListener("durationchange", () => {
    if (_nativeAudio !== audio) return;
    const d = audio.duration;
    if (Number.isFinite(d) && d > 0) _handlers.current?.onDurationChange?.(d);
  });

  audio.addEventListener("canplay", () => {
    if (_nativeAudio !== audio || didSettle) return;
    didSettle = true;
    const d = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (d > 0) _handlers.current?.onDurationChange?.(d);
    audio.muted = false;
    audio.volume = 1;
    console.log("[MixReview] Compat mode: native audio ready", {
      duration: d,
      readyState: audio.readyState,
    });
    _handlers.current?.onWaveformUnavailable?.(player, "compat");
  }, { once: true });

  audio.addEventListener("timeupdate", () => {
    if (_nativeAudio !== audio) return;
    _handlers.current?.onTimeUpdate?.(audio.currentTime);
  });

  audio.addEventListener("play", () => {
    if (_nativeAudio === audio) _handlers.current?.onPlaybackChange?.(true);
  });
  audio.addEventListener("pause", () => {
    if (_nativeAudio === audio) _handlers.current?.onPlaybackChange?.(false);
  });
  audio.addEventListener("ended", () => {
    if (_nativeAudio === audio) _handlers.current?.onPlaybackChange?.(false);
  });

  audio.addEventListener("error", () => {
    if (_nativeAudio !== audio || didSettle) return;
    didSettle = true;
    console.warn("[MixReview] Compat mode: native audio failed", audio.error?.message);
    _handlers.current?.onError?.(new Error("Audio failed to load"));
  }, { once: true });

  // Set src last so all listeners are attached before load begins.
  audio.src = url;
  audio.load();
}

// ── Engine ─────────────────────────────────────────────────────────────────

/**
 * Mount or reuse the singleton audio engine.
 * Returns the WaveSurfer instance (standard/lite modes) or null (compat mode).
 * If called with the same URL as the currently loaded instance, existing
 * playback is preserved and only the handlers are updated.
 *
 * mode: "standard" | "lite" | "compat"
 *
 * handlers: {
 *   onReady, onWaveformUnavailable, onError,
 *   onDurationChange, onTimeUpdate, onPlaybackChange
 * }
 *
 * onReady            — waveform decoded and rendered successfully
 * onWaveformUnavailable(player, reason) — waveform failed/timed out but
 *                      audio is playable; player interface provided.
 *                      reason === "compat" means old-device native-audio mode.
 * onError            — both waveform and audio are unavailable
 */
export function mountMobileEngine(container, url, handlers, mode = "standard") {
  _handlers.current = handlers;
  _mobileMode = mode;

  if (_url === url && (_ws || _nativeAudio)) {
    return _mobileMode === "compat" ? null : _ws;
  }

  if (_ws) {
    _ws.destroy();
    _ws = null;
  }
  if (_nativeAudio) {
    _nativeAudio.pause();
    _nativeAudio.src = "";
    _nativeAudio = null;
  }

  _url = url;

  if (!url) return null;

  // ── Logging ────────────────────────────────────────────────────────────
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  console.log("[MixReview] MobileEngine mount", { mode, ext, url: url.slice(0, 120) });
  probeAudioUrl(url).catch(() => {}); // background, non-blocking

  // ── Compat mode: native <audio>, no WaveSurfer ────────────────────────
  if (mode === "compat") {
    _mountNativeAudio(url, handlers);
    return null;
  }

  // ── WaveSurfer instance (standard / lite) ─────────────────────────────
  const decodeTimeoutMs = mode === "lite" ? WAVEFORM_TIMEOUT_LITE_MS : WAVEFORM_TIMEOUT_MS;

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
  // Attach logging listeners to WaveSurfer's underlying media element.
  // These are informational only and never alter playback state.
  _attachMediaLogging(ws.getMediaElement?.(), "ws");

  // didSettle: true once onReady or onWaveformUnavailable has been called.
  // Prevents duplicate handler calls if both fallback timer and WaveSurfer
  // events fire in close succession.
  let didSettle = false;

  // ── Fallback timer ─────────────────────────────────────────────────────
  const fallbackTimer = setTimeout(() => {
    if (didSettle || _ws !== ws) return;
    console.warn("[MixReview] Waveform decode timeout after", decodeTimeoutMs, "ms — attempting audio-only fallback");
    activateFallback("timeout");
  }, decodeTimeoutMs);

  // ── Audio-only fallback ────────────────────────────────────────────────

  /**
   * Called when waveform decode fails or times out.
   * Tries to enable playback via WaveSurfer's underlying <audio> element.
   */
  function activateFallback(reason) {
    if (didSettle || _ws !== ws) return;

    const mediaEl = ws.getMediaElement?.();

    // Hard failure: the media element itself reported a network/decode error.
    if (mediaEl?.error) {
      didSettle = true;
      clearTimeout(fallbackTimer);
      console.warn("[MixReview] Media element error — audio unavailable", {
        reason,
        code: mediaEl.error.code,
        message: mediaEl.error.message,
      });
      _handlers.current?.onError?.(new Error("Audio decode failed"));
      return;
    }

    if (!mediaEl) {
      didSettle = true;
      clearTimeout(fallbackTimer);
      console.warn("[MixReview] Fallback: no media element");
      _handlers.current?.onError?.(new Error("Audio player unavailable"));
      return;
    }

    // Case A — WaveSurfer's fetch already completed and it set a blob URL on
    // the media element. The decode step failed or timed out, but the element
    // can play because it has audio data.
    if (mediaEl.src || mediaEl.currentSrc) {
      if (mediaEl.readyState >= 2) {
        // Already HAVE_CURRENT_DATA — can play immediately
        didSettle = true;
        clearTimeout(fallbackTimer);
        doFallbackWithEl(mediaEl, reason);
      } else {
        // Media element is still buffering — wait up to 8 s for canplay
        console.log("[MixReview] Fallback: waiting for canplay", { readyState: mediaEl.readyState });
        const giveUp = setTimeout(() => {
          if (didSettle || _ws !== ws) return;
          didSettle = true;
          console.warn("[MixReview] Fallback: media element did not become playable");
          _handlers.current?.onError?.(new Error("Audio loading timeout"));
        }, 8_000);
        mediaEl.addEventListener("canplay", () => {
          clearTimeout(giveUp);
          if (didSettle || _ws !== ws) return;
          didSettle = true;
          clearTimeout(fallbackTimer);
          doFallbackWithEl(mediaEl, reason);
        }, { once: true });
      }
      return;
    }

    // Case B — WaveSurfer's fetch is stalled (it never called setSrc on the
    // media element). Abort the stalled fetch and load the URL directly on
    // the media element so playback can still work.
    console.log("[MixReview] Fallback: fetch stalled — aborting WaveSurfer fetch, loading URL directly");
    try { ws.abortController?.abort(); } catch (_) {}

    mediaEl.preload = "auto";
    mediaEl.src = url;

    const giveUp = setTimeout(() => {
      if (didSettle || _ws !== ws) return;
      didSettle = true;
      console.warn("[MixReview] Fallback: direct audio load timeout");
      _handlers.current?.onError?.(new Error("Audio loading timeout"));
    }, 10_000);

    mediaEl.addEventListener("canplay", () => {
      clearTimeout(giveUp);
      if (didSettle || _ws !== ws) return;
      didSettle = true;
      clearTimeout(fallbackTimer);
      doFallbackWithEl(mediaEl, reason);
    }, { once: true });

    mediaEl.addEventListener("error", () => {
      clearTimeout(giveUp);
      if (didSettle || _ws !== ws) return;
      didSettle = true;
      console.warn("[MixReview] Fallback: direct audio load failed", mediaEl.error?.message);
      _handlers.current?.onError?.(new Error("Audio failed to load"));
    }, { once: true });
  }

  /**
   * Activate audio-only mode using the given media element.
   * WaveSurfer's play/pause/skip/setTime all delegate to the media element,
   * so the existing event forwarding (play → ws.on("play") → onPlaybackChange,
   * etc.) continues to work without wiring extra listeners here.
   */
  function doFallbackWithEl(mediaEl, reason) {
    console.log("[MixReview] Audio-only fallback active", {
      reason,
      readyState: mediaEl.readyState,
      duration: mediaEl.duration,
      src: (mediaEl.currentSrc || mediaEl.src || "").slice(0, 80),
    });

    mediaEl.muted = false;
    mediaEl.volume = 1;

    const duration = Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0;
    if (duration > 0) _handlers.current?.onDurationChange?.(duration);

    // Duration may not be known yet (metadata loading); wire up durationchange
    // so we surface it as soon as it becomes available.
    mediaEl.addEventListener("durationchange", () => {
      if (_ws !== ws) return;
      const d = mediaEl.duration;
      if (Number.isFinite(d) && d > 0) _handlers.current?.onDurationChange?.(d);
    });

    // Build a player that uses WaveSurfer's own methods. ws.play() / ws.pause()
    // / ws.skip() / ws.setTime() all delegate to mediaEl internally, so the
    // WaveSurfer-level play/pause/timeupdate/finish events still fire and our
    // ws.on() subscriptions below keep delivering callbacks correctly.
    const player = {
      wavesurfer: ws,
      mediaElement: mediaEl,
      play: async () => {
        try { await ws.play(); }
        catch (e) { console.warn("[MixReview] ws.play fallback", e.message); try { await mediaEl.play(); } catch (_) {} }
      },
      pause: () => { try { ws.pause(); } catch (_) { mediaEl.pause(); } },
      playPause: async () => {
        try { await ws.playPause(); }
        catch (e) {
          if (mediaEl.paused) { try { await mediaEl.play(); } catch (_) {} } else { mediaEl.pause(); }
        }
      },
      skip: (s) => { try { ws.skip(s); } catch (_) { mediaEl.currentTime = Math.max(0, (mediaEl.currentTime || 0) + s); } },
      seekToTime: (time) => {
        const t = Math.max(0, Math.min(time, Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0));
        try { ws.setTime(t); } catch (_) { mediaEl.currentTime = t; }
        _handlers.current?.onTimeUpdate?.(t);
      },
    };

    _handlers.current?.onWaveformUnavailable?.(player, reason);
  }

  // ── Normal WaveSurfer events ───────────────────────────────────────────

  ws.on("ready", () => {
    if (_ws !== ws) return;
    if (didSettle) {
      // A fallback fired before ready arrived. The waveform has now been
      // rendered (late decode success). Log it but do not call onReady twice.
      console.log("[MixReview] Late waveform decode success after fallback");
      return;
    }
    didSettle = true;
    clearTimeout(fallbackTimer);

    const duration = ws.getDuration();
    const mediaElement = ws.getMediaElement?.();
    if (mediaElement) {
      mediaElement.muted = false;
      mediaElement.volume = 1;
      mediaElement.preload = "auto";
    }
    console.log("[MixReview] WaveSurfer decode success", { duration });
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
    // AbortError is expected when activateFallback(case B) aborts the stalled
    // fetch intentionally — treat it as informational, not a failure.
    if (error?.name === "AbortError") {
      console.log("[MixReview] WaveSurfer fetch aborted (intentional fallback abort)");
      return;
    }
    console.warn("[MixReview] WaveSurfer error", { message: error?.message ?? String(error) });
    if (didSettle) return;
    activateFallback("decode-error");
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
  if (_nativeAudio) {
    _nativeAudio.pause();
    _nativeAudio.src = "";
    _nativeAudio = null;
  }
  _url = null;
  _mobileMode = "standard";
  _wasPlayingOnHide = false;
  _handlers.current = null;
}
