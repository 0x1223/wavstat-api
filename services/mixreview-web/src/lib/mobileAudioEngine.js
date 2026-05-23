import WaveSurfer from "wavesurfer.js";

// Singleton audio engine for mobile — lives outside the React component tree
// so comment state changes and re-renders never cause WaveSurfer to be
// destroyed or re-created.

// How long to wait for WaveSurfer's waveform decode (fetch + decodeAudioData)
// before activating the audio-only fallback.
const WAVEFORM_TIMEOUT_MS = 12_000;

let _ws = null;
let _url = null;
let _detachNativeListeners = null;
const _handlers = { current: null };

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
// Goal: native HTMLAudioElement owns playback. Audio is never paused or
// restarted on visibility / page-lifecycle events. All lifecycle transitions
// are logged for diagnostics.

if (typeof document !== "undefined") {
  const getMediaEl = () => _ws?.getMediaElement?.() ?? null;

  document.addEventListener("visibilitychange", () => {
    if (!_ws) return;
    const mediaEl = getMediaEl();

    if (document.hidden) {
      // Use native paused property — more reliable than WaveSurfer.isPlaying()
      console.log("[MobileEngine] visibilitychange → hidden", {
        wasPlaying: mediaEl ? !mediaEl.paused : _ws.isPlaying(),
        currentTime: mediaEl?.currentTime?.toFixed(2) ?? "(n/a)",
      });
    } else {
      const isStillPlaying = mediaEl ? !mediaEl.paused : false;
      console.log("[MobileEngine] visibilitychange → visible", {
        isStillPlaying,
        currentTime: mediaEl?.currentTime?.toFixed(2) ?? "(n/a)",
      });
      if (isStillPlaying) {
        console.log("[MobileEngine] Audio continued in background — no restart needed");
      }
    }
  });

  // pagehide is more reliable than visibilitychange on some iOS versions.
  window.addEventListener("pagehide", (evt) => {
    const mediaEl = getMediaEl();
    const isNativePlaying = mediaEl ? !mediaEl.paused : (_ws?.isPlaying?.() ?? false);
    console.log("[MobileEngine] pagehide", {
      persisted: evt.persisted,
      isPlaying: isNativePlaying,
      currentTime: mediaEl?.currentTime?.toFixed(2) ?? "(n/a)",
    });
  });

  window.addEventListener("pageshow", (evt) => {
    const mediaEl = getMediaEl();
    const isStillPlaying = mediaEl ? !mediaEl.paused : false;
    console.log("[MobileEngine] pageshow", {
      persisted: evt.persisted,
      isStillPlaying,
      currentTime: mediaEl?.currentTime?.toFixed(2) ?? "(n/a)",
    });
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
  console.log("[MixReview] MobileEngine mount", { ext, url: url.slice(0, 120) });
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
  const earlyMediaEl = ws.getMediaElement?.();
  if (earlyMediaEl) {
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
      mediaElement.preload = "auto";
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

/** Destroy the singleton. Called when the audio source changes or the session ends. */
export function disposeMobileEngine() {
  _detachNativeListeners?.();
  _detachNativeListeners = null;
  if (_ws) {
    _ws.destroy();
    _ws = null;
  }
  _url = null;
  _handlers.current = null;
}
