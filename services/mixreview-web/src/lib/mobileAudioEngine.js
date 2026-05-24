import WaveSurfer from "wavesurfer.js";

// Singleton audio engine for mobile — lives outside the React component tree
// so comment state changes and re-renders never cause WaveSurfer to be
// destroyed or re-created.

// How long to wait for WaveSurfer's waveform decode (fetch + decodeAudioData)
// before activating the audio-only fallback.
const WAVEFORM_TIMEOUT_MS = 12_000;

let _ws = null;
let _url = null;
let _wasPlayingOnHide = false;
// Guard vars: restore play() is only allowed when the SAME track was audibly
// playing before hide AND currentTime was actually advancing at that moment.
let _urlOnHide = null;          // _url value captured at hide time
let _wasTimeAdvancing = false;  // true if timeupdate fired within 500 ms of hide
let _lastTimeUpdateAt = 0;      // performance.now() of the last timeupdate tick
let _detachNativeListeners = null;
const _handlers = { current: null };

// ── Persistent iOS/Safari keep-alive AudioContext ─────────────────────────
// Created once inside the first user Play gesture and never closed during normal
// operation (it survives track switches). A tiny silent looping BufferSource keeps
// iOS from auto-suspending the context, which would cut audio routed through it.
// MobileSpectrumAnalyzer shares this context rather than creating its own per-track.
let _sharedCtx = null;
let _keepAliveSrc = null;  // silent looping BufferSourceNode (volume 0)
let _mediaSourceNode = null;

function _reconnectSourceNode() {
  if (!_sharedCtx) return;
  try {
    const src = window.__wavstatSourceNode ?? _mediaSourceNode;
    if (!src) return;
    src.disconnect();
    src.connect(_sharedCtx.destination);
    window.__wavstatNeedsRewire = true;
  } catch (e) {
    console.warn("[mobileAudioEngine] _reconnectSourceNode failed:", e);
  }
}

/**
 * Detect iOS / iPadOS / Safari.
 * Matches iPhone, iPod, iPad (modern UA) and macOS with touch (iPadOS desktop mode).
 */
function _isIOSSafari() {
  const ua = navigator.userAgent;
  const isIOS = /iP(hone|od|ad)/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIOS || isSafari;
}

/**
 * Start the persistent keep-alive AudioContext.
 * MUST be called inside a user gesture (e.g. the Play button handler) so that
 * AudioContext.resume() succeeds on iOS/Safari.
 *
 * No-op on non-iOS/Safari browsers or if already started.
 * Returns the shared AudioContext (or null if not applicable / failed).
 */
export function startKeepAlive() {
  if (!_isIOSSafari()) return null;
  if (_sharedCtx && _sharedCtx.state !== "closed") return _sharedCtx;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  try {
    _sharedCtx = new Ctx();
    // Resume within the gesture — this is what unlocks the iOS audio session.
    _sharedCtx.resume().catch(() => {});

    // 1-sample silent buffer, looping forever.
    // Keeps iOS from reclaiming the audio session by ensuring the context is
    // always producing some output (even silence). Must not affect analyser
    // readings — it is connected directly to the destination, not to the analyser.
    const buf = _sharedCtx.createBuffer(1, 1, _sharedCtx.sampleRate);
    // buf.getChannelData(0)[0] === 0 by default (silent)
    const gain = _sharedCtx.createGain();
    gain.gain.value = 0; // completely inaudible
    _keepAliveSrc = _sharedCtx.createBufferSource();
    _keepAliveSrc.buffer = buf;
    _keepAliveSrc.loop = true;
    _keepAliveSrc.connect(gain);
    gain.connect(_sharedCtx.destination);
    _keepAliveSrc.start(0);

    function _restartKeepAliveSrc() {
      if (!_sharedCtx) return;
      try { _keepAliveSrc?.stop(); } catch (_) {}
      const buf2 = _sharedCtx.createBuffer(1, 1, _sharedCtx.sampleRate);
      _keepAliveSrc = _sharedCtx.createBufferSource();
      _keepAliveSrc.buffer = buf2;
      _keepAliveSrc.loop = true;
      _keepAliveSrc.connect(_sharedCtx.destination);
      _keepAliveSrc.start(0);
    }

    setInterval(() => {
      if (!_sharedCtx) return;
      if (_sharedCtx.state !== "running") {
        _sharedCtx.resume().then(_restartKeepAliveSrc).catch(() => {});
      } else {
        _restartKeepAliveSrc();
      }
    }, 30_000);

    console.log("[MobileEngine] Keep-alive AudioContext started, state:", _sharedCtx.state);
    return _sharedCtx;
  } catch (e) {
    console.warn("[MobileEngine] Keep-alive setup failed:", e.message);
    try { _sharedCtx?.close(); } catch (_) {}
    _sharedCtx = null;
    _keepAliveSrc = null;
    return null;
  }
}

/**
 * Returns the shared AudioContext if it has been started and is not closed.
 * Used by MobileSpectrumAnalyzer to tap into the same persistent audio graph.
 */
export function getSharedAudioContext() {
  if (!_sharedCtx || _sharedCtx.state === "closed") return null;
  return _sharedCtx;
}

/** Resume the shared context if iOS auto-suspended it. */
function _resumeSharedCtx() {
  if (_sharedCtx && _sharedCtx.state === "suspended") {
    _sharedCtx.resume().catch((e) => {
      console.warn("[MobileEngine] Shared ctx resume failed:", e.message);
    });
  }
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

// ── Native audio event listeners ───────────────────────────────────────────
// Transport state is driven by native HTMLAudioElement events so it stays
// accurate in background / lock-screen, where WaveSurfer's event forwarding
// may be throttled. This also lets us log every real audio lifecycle event.

function attachNativeListeners(mediaEl, ws) {
  let _lastRealTime = null;
  let _lastMediaTime = null;

  function onPlay() {
    // 'play' fires when .play() is called — audio may not have started yet
    // (could be buffering, or AudioContext still suspended). Log only; do NOT
    // set isPlaying here to avoid fake Pause state.
    console.log("[MobileEngine] native play", { t: mediaEl.currentTime?.toFixed(2) });
  }
  function onPlaying() {
    // 'playing' fires when audio is actually outputting (after any buffering
    // and after AudioContext has resumed). This is the authoritative signal
    // that the user can hear audio.
    console.log("[MobileEngine] native playing", { t: mediaEl.currentTime?.toFixed(2) });
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(true);
  }
  function onPause() {
    console.log("[MobileEngine] native pause", { t: mediaEl.currentTime?.toFixed(2) });
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
  }
  function onEnded() {
    console.log("[MobileEngine] native ended");
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
  }
  function onWaiting() {
    console.log("[MobileEngine] native waiting (buffering)", { t: mediaEl.currentTime?.toFixed(2) });
    // 'waiting' means audio stalled mid-play — drop back to paused UI so the
    // user sees Play rather than a frozen Pause while rebuffering.
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
  }
  function onStalled() {
    console.log("[MobileEngine] native stalled", { t: mediaEl.currentTime?.toFixed(2) });
  }
  function onCanPlay() {
    console.log("[MobileEngine] native canplay", { readyState: mediaEl.readyState });
  }
  function onError() {
    console.warn("[MobileEngine] native error", {
      code: mediaEl.error?.code,
      message: mediaEl.error?.message,
    });
  }
  function onTimeUpdate() {
    _lastTimeUpdateAt = performance.now(); // record wall-clock time of last tick
    const _now = Date.now();
    const _mediaTime = mediaEl.currentTime;
    if (_lastRealTime !== null && _lastMediaTime !== null) {
      const _wallElapsed = (_now - _lastRealTime) / 1000;
      const _mediaElapsed = _mediaTime - _lastMediaTime;
      if (_wallElapsed > 0.1 && _mediaElapsed / _wallElapsed > 1.3) {
        console.warn("[mobileAudioEngine] rate corruption detected, reconnecting");
        if (mediaEl.playbackRate !== 1) mediaEl.playbackRate = 1;
        _reconnectSourceNode();
      }
    }
    _lastRealTime = _now;
    _lastMediaTime = _mediaTime;
    if (_ws === ws) _handlers.current?.onTimeUpdate?.(mediaEl.currentTime);
  }

  mediaEl.addEventListener("play", onPlay);
  mediaEl.addEventListener("playing", onPlaying);
  mediaEl.addEventListener("pause", onPause);
  mediaEl.addEventListener("ended", onEnded);
  mediaEl.addEventListener("waiting", onWaiting);
  mediaEl.addEventListener("stalled", onStalled);
  mediaEl.addEventListener("canplay", onCanPlay);
  mediaEl.addEventListener("error", onError);
  mediaEl.addEventListener("timeupdate", onTimeUpdate);

  return () => {
    mediaEl.removeEventListener("play", onPlay);
    mediaEl.removeEventListener("playing", onPlaying);
    mediaEl.removeEventListener("pause", onPause);
    mediaEl.removeEventListener("ended", onEnded);
    mediaEl.removeEventListener("waiting", onWaiting);
    mediaEl.removeEventListener("stalled", onStalled);
    mediaEl.removeEventListener("canplay", onCanPlay);
    mediaEl.removeEventListener("error", onError);
    mediaEl.removeEventListener("timeupdate", onTimeUpdate);
  };
}

// ── Mobile lifecycle: background / lock-screen stability ──────────────────
// Goal: native HTMLAudioElement owns playback. Audio is never paused on
// visibility / page-lifecycle events. We only restart if the OS actually
// stopped the element. All lifecycle transitions are logged for diagnostics.
//
// With the keep-alive AudioContext active, iOS keeps audio flowing through
// the Web Audio graph in the background. If iOS does auto-suspend the
// context despite the keep-alive, _resumeSharedCtx() brings it back on
// any visibility/focus/resume event — without needing a new gesture, because
// the context object was already unlocked in the original user tap.

if (typeof document !== "undefined") {
  const getMediaEl = () => _ws?.getMediaElement?.() ?? null;

  // ── Diagnostic snapshot helper ──────────────────────────────────────────
  // Returns a plain object with every iOS-relevant field so every log entry
  // captures the same fields in the same order — easier to diff across events.
  function _snap(label) {
    const mediaEl = getMediaEl();
    return {
      event: label,
      visibilityState: document.visibilityState,
      audioCtxState: _sharedCtx?.state ?? "none",
      mediaPaused: mediaEl != null ? mediaEl.paused : "(no el)",
      mediaEnded: mediaEl != null ? mediaEl.ended : "(no el)",
      mediaSrc: (mediaEl?.currentSrc || mediaEl?.src || "").slice(0, 72) || "(none)",
      mediaReadyState: mediaEl?.readyState ?? "(no el)",
      mediaCurrentTime: mediaEl?.currentTime != null ? +mediaEl.currentTime.toFixed(3) : "(n/a)",
      wasPlayingOnHide: _wasPlayingOnHide,
      wasTimeAdvancing: _wasTimeAdvancing,
      sameTrack: _url === _urlOnHide,
    };
  }

  // ── Core restore handler ────────────────────────────────────────────────
  // Called on every event that signals the page is visible/active again:
  // visibilitychange→visible, pageshow, focus, document 'resume'.
  //
  // iOS-critical sequencing:
  //   1. Snapshot diagnostics first (before any state mutation).
  //   2. Resume the AudioContext if suspended.
  //   3. WAIT for the resume Promise to settle before calling play().
  //      Calling play() while the context is still transitioning
  //      suspended→running silently stalls audio on iOS.
  //   4. Call mediaEl.play() directly — WaveSurfer's play() goes through
  //      internal state checks that can be stale after a background
  //      suspension. The native element API is authoritative.
  //   5. Log whether the play() Promise resolves or rejects so we can
  //      distinguish "iOS blocked it (NotAllowedError)" from "succeeded".
  function _onRestoreVisible() {
    const mediaEl = getMediaEl();
    if (mediaEl && mediaEl.playbackRate !== 1) {
      mediaEl.playbackRate = 1;
    }
    const snap = _snap("restore");
    console.log("[MobileEngine]", snap);

    // Guard: only restore if the user was playing the same track.
    const intendedPlay = _wasPlayingOnHide
      && _url === _urlOnHide
      && _wasTimeAdvancing;

    if (!_ws || !mediaEl) {
      _wasPlayingOnHide = false;
      return;
    }

    const isStillPlaying = !mediaEl.paused && !mediaEl.ended;

    if (isStillPlaying) {
      // Audio survived the background — just ensure the AudioContext is
      // running so the analyser keeps working.
      _wasPlayingOnHide = false;
      console.log("[MobileEngine] Audio survived background ✓ — ensuring ctx resumed");
      _resumeSharedCtx();
      _reconnectSourceNode();
      return;
    }

    if (!intendedPlay) {
      // Audio was paused intentionally (or user never played). Nothing to do.
      _wasPlayingOnHide = false;
      return;
    }

    // Audio was stopped unexpectedly while hidden.
    // Verify the element still has a src before trying to play.
    const hasSrc = Boolean(mediaEl.currentSrc || mediaEl.src);
    if (!hasSrc) {
      console.warn("[MobileEngine] Cannot restore — media element has no src");
      _wasPlayingOnHide = false;
      return;
    }

    _wasPlayingOnHide = false;
    console.log("[MobileEngine] Audio stopped while hidden — sequenced restore; t:",
      mediaEl.currentTime?.toFixed(3));

    // Inner play call — always operates on the native element directly.
    // Logs resolve/reject so we can distinguish NotAllowedError (iOS blocked
    // it without a gesture) from any other failure.
    function _doPlay() {
      console.log("[MobileEngine] Calling mediaEl.play(); ctxState:", _sharedCtx?.state ?? "none");
      const p = mediaEl.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          console.log("[MobileEngine] mediaEl.play() resolved ✓; t:",
            mediaEl.currentTime?.toFixed(3), "ctxState:", _sharedCtx?.state ?? "none");
        }).catch((e) => {
          // NotAllowedError → iOS blocked autoplay without a gesture.
          // The user must tap Play again; log clearly so we can tell.
          console.warn("[MobileEngine] mediaEl.play() rejected after restore:",
            e.name, "—", e.message);
        });
      }
    }

    // If the AudioContext is suspended, resume it first and chain play() on
    // the resolved Promise. This guarantees the Web Audio graph is running
    // before media output is expected to flow through it.
    if (_sharedCtx && _sharedCtx.state === "suspended") {
      _sharedCtx.resume().then(() => {
        console.log("[MobileEngine] AudioContext resumed ✓, state:", _sharedCtx?.state);
        _reconnectSourceNode();
        _doPlay();
      }).catch((e) => {
        // Resume failed (rare) — try play() anyway; native audio path may work.
        console.warn("[MobileEngine] AudioContext resume failed:", e.name, "—", e.message,
          "— attempting mediaEl.play() regardless");
        _doPlay();
      });
    } else {
      // Context already running (or no shared ctx on non-iOS).
      _doPlay();
    }
  }

  // ── visibilitychange ────────────────────────────────────────────────────
  document.addEventListener("visibilitychange", () => {
    const mediaEl = getMediaEl();

    if (document.hidden) {
      if (_ws) {
        // Capture state at the moment we go hidden.
        _wasPlayingOnHide = mediaEl ? !mediaEl.paused : _ws.isPlaying();
        _urlOnHide = _url;
        _wasTimeAdvancing = (performance.now() - _lastTimeUpdateAt) < 500;
      }
      // Full diagnostic snapshot on hide — critical for diagnosing iOS suspension.
      console.log("[MobileEngine]", _snap("hide"));
    } else {
      _onRestoreVisible();
    }
  });

  // ── pagehide ────────────────────────────────────────────────────────────
  // More reliable than visibilitychange on some iOS versions.
  window.addEventListener("pagehide", (evt) => {
    const mediaEl = getMediaEl();
    const isNativePlaying = mediaEl ? !mediaEl.paused : (_ws?.isPlaying?.() ?? false);
    // OR-in: don't clobber flags already set by visibilitychange
    if (isNativePlaying) {
      _wasPlayingOnHide = true;
      if (!_urlOnHide) _urlOnHide = _url;
      if (!_wasTimeAdvancing) _wasTimeAdvancing = (performance.now() - _lastTimeUpdateAt) < 500;
    }
    console.log("[MobileEngine]", {
      ..._snap("pagehide"),
      persisted: evt.persisted,
    });
  });

  // ── pageshow ────────────────────────────────────────────────────────────
  window.addEventListener("pageshow", (evt) => {
    console.log("[MobileEngine]", {
      ..._snap("pageshow"),
      persisted: evt.persisted,
    });
    _onRestoreVisible();
  });

  // ── focus ───────────────────────────────────────────────────────────────
  // Fires when the page regains focus after an app-switch or tab switch.
  window.addEventListener("focus", () => {
    console.log("[MobileEngine]", _snap("focus"));
    _onRestoreVisible();
  });

  // ── Page Lifecycle 'resume' ─────────────────────────────────────────────
  // Fires when the page transitions from frozen → active on aggressive
  // memory-reclaim iOS scenarios. Not universally supported; harmless to add.
  document.addEventListener("resume", () => {
    console.log("[MobileEngine]", _snap("page-lifecycle-resume"));
    _onRestoreVisible();
  });
}

// ── Engine ─────────────────────────────────────────────────────────────────

/**
 * Mount or reuse the singleton WaveSurfer instance.
 * Returns the WaveSurfer instance synchronously; it may not be ready yet.
 * If called with the same URL as the currently loaded instance, existing
 * playback is preserved and only the handlers are updated.
 *
 * handlers: {
 *   onReady, onWaveformUnavailable, onError,
 *   onDurationChange, onTimeUpdate, onPlaybackChange
 * }
 *
 * onReady            — waveform decoded and rendered successfully
 * onWaveformUnavailable(player, reason) — waveform failed/timed out but
 *                      audio element is playable; player interface provided
 * onError            — both waveform and audio are unavailable
 */
export function mountMobileEngine(container, url, handlers) {
  _handlers.current = handlers;

  if (_url === url && _ws) {
    return _ws;
  }

  // New URL means a different track is being loaded. Clear all background-play
  // guard state so the visibility/pageshow resume handlers cannot fire play()
  // on a track the user never started in the foreground.
  _wasPlayingOnHide = false;
  _urlOnHide = null;
  _wasTimeAdvancing = false;

  if (_ws) {
    _detachNativeListeners?.();
    _detachNativeListeners = null;
    _ws.destroy();
    _ws = null;
  }

  _url = url;

  if (!url) return null;

  // ── Logging ────────────────────────────────────────────────────────────
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  // Detect WAV so we can apply format-specific streaming configuration below.
  // WAV files served from R2 are uncompressed and can be 40–100 MB; they
  // require different preload and CORS treatment than the smaller MP3 assets.
  const isWav = ext === "wav";
  console.log("[MixReview] MobileEngine mount", { ext, isWav, url: url.slice(0, 120) });
  probeAudioUrl(url).catch(() => {}); // background, non-blocking

  // ── WaveSurfer instance ────────────────────────────────────────────────
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

  // Attach native audio listeners as early as possible. WaveSurfer creates
  // the HTMLAudioElement in its constructor, so it is usually available here.
  // The ready / fallback paths re-check and attach if this missed.
  //
  // We also apply streaming configuration here — before the browser's network
  // stack processes the element, because JS is still on the same call stack as
  // WaveSurfer.create() and the engine hasn't yielded to the event loop yet:
  //
  //  crossOrigin="anonymous"
  //    Sends an Origin header with every HTTP request the browser makes for
  //    this element (including byte-range streaming requests to R2). This lets
  //    Cloudflare R2's CORS policy expose Content-Range / Accept-Ranges response
  //    headers to JavaScript and keeps the request in the CORS-credentialed
  //    cache partition, preventing range-request stalls on cross-origin assets.
  //
  //  preload="metadata"  (WAV only)
  //    Instructs the browser to fetch only the file header (enough to determine
  //    duration and codec) and then stop. Audio data is streamed on-demand via
  //    HTTP byte-range requests when play() is called. This prevents the browser
  //    from trying to buffer a 40–100 MB WAV file on page load.
  //    MP3 files remain at preload="auto" so they buffer freely — they are small
  //    enough that aggressive pre-buffering is harmless and improves seek latency.
  const earlyMediaEl = ws.getMediaElement?.();
  if (earlyMediaEl) {
    earlyMediaEl.crossOrigin = "anonymous";
    earlyMediaEl.preload = isWav ? "metadata" : "auto";
    _detachNativeListeners?.();
    _detachNativeListeners = attachNativeListeners(earlyMediaEl, ws);
  }

  // didSettle: true once onReady or onWaveformUnavailable has been called.
  // Prevents duplicate handler calls if both fallback timer and WaveSurfer
  // events fire in close succession.
  let didSettle = false;

  // ── Fallback timer ─────────────────────────────────────────────────────
  const fallbackTimer = setTimeout(() => {
    if (didSettle || _ws !== ws) return;
    console.warn("[MixReview] Waveform decode timeout after", WAVEFORM_TIMEOUT_MS, "ms — attempting audio-only fallback");
    activateFallback("timeout");
  }, WAVEFORM_TIMEOUT_MS);

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

    // Pipeline reset: pause any partially-loaded stream, then flush the media
    // element's internal buffer pipeline before assigning the new src.  This
    // prevents buffer-drain crashes and memory leaks that can occur when jumping
    // between large WAV assets and lighter MP3 files — the previous (stalled)
    // decode attempt may still hold partial network buffers that must be freed
    // before the element accepts a new source assignment cleanly.
    try { mediaEl.pause(); } catch (_) {}
    mediaEl.crossOrigin = "anonymous";  // ensure CORS is set for direct loads too
    mediaEl.preload = isWav ? "metadata" : "auto";
    mediaEl.src = url;
    mediaEl.load(); // explicit pipeline flush — required after src reassignment

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
   * Native audio events drive transport state (see attachNativeListeners).
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

    // Ensure native listeners are attached (guards against early-attachment miss).
    if (!_detachNativeListeners && _ws === ws) {
      _detachNativeListeners = attachNativeListeners(mediaEl, ws);
    }

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
    // native play/pause/timeupdate events still fire and our native listeners
    // keep delivering callbacks correctly.
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
      // Honour the format-specific preload set during early element setup.
      // WAV → "metadata" keeps byte-range streaming on-demand (do not reset to
      // "auto" — that would cause the browser to aggressively buffer the whole
      // file now that it knows the element is ready).
      // Non-WAV (MP3 etc.) → "auto" allows the browser to buffer freely.
      mediaElement.preload = isWav ? "metadata" : "auto";
      // Ensure native listeners are attached (fallback for early-attachment miss).
      if (!_detachNativeListeners) {
        _detachNativeListeners = attachNativeListeners(mediaElement, ws);
      }
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

  // Transport state is driven by native audio events via attachNativeListeners.
  // WaveSurfer's play / pause / finish / timeupdate events are not subscribed
  // here to avoid duplicate callbacks — native events are more reliable in
  // background / lock-screen where AudioContext may be suspended.

  return ws;
}

/**
 * Destroy the WaveSurfer singleton. Called when a track changes or the
 * component unmounts. The shared keep-alive AudioContext is intentionally
 * preserved — it must survive track switches so MobileSpectrumAnalyzer can
 * reconnect without requiring a new user gesture.
 */
export function disposeMobileEngine() {
  _detachNativeListeners?.();
  _detachNativeListeners = null;
  if (_ws) {
    _ws.destroy();
    _ws = null;
  }
  _url = null;
  _wasPlayingOnHide = false;
  _urlOnHide = null;
  _wasTimeAdvancing = false;
  _handlers.current = null;
  // _sharedCtx / _keepAliveSrc are intentionally NOT cleared here.
  // They live for the full page session so MobileSpectrumAnalyzer can reuse
  // the already-unlocked context across track switches.
}
