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
// Tracks the current track duration so Media Session setPositionState() has
// a stable value between durationchange events.
let _mediaDuration = 0;
// ── Audio interruption recovery ───────────────────────────────────────────
// iOS fires AudioContext statechange → "suspended"/"interrupted" when a phone
// call, Siri, or another audio app takes over the hardware session. These flags
// and cleanup refs support the auto-resume path that fires when the OS gives
// the session back (statechange → "running").
let _interruptedWhilePlaying = false; // OS interrupted us while page was visible + playing
let _detachCtxStateListener  = null;  // cleanup fn for AudioContext statechange
let _detachGestureRecovery   = null;  // cleanup fn for one-time gesture re-prime fallback

// ── Persistent iOS/Safari keep-alive AudioContext ─────────────────────────
// Created once inside the first user Play gesture and never closed during normal
// operation (it survives track switches). A tiny silent looping BufferSource keeps
// iOS from auto-suspending the context, which would cut audio routed through it.
// The primary <audio> element routes exclusively to native hardware — no
// createMediaElementSource, no Web Audio involvement — so the keep-alive is the
// only thing in the graph. Visualization uses position-based rAF (currentTime).
let _sharedCtx = null;
let _keepAliveSrc = null;    // silent looping BufferSourceNode (volume 0)
let _isRestoring = false;    // true while a sequenced ctx-resume → play() is in flight

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
    // Wire the statechange listener so OS audio interruptions (phone calls,
    // Siri, other audio apps) are detected and playback is auto-restored.
    _wireCtxStateListener();

    // 1-sample silent buffer, looping forever.
    // Keeps iOS from reclaiming the audio session by ensuring the context
    // always produces some output (even silence).  The primary <audio> element
    // is never connected to the Web Audio graph — it goes straight to hardware.
    // Visualization reads primaryAudio.currentTime via requestAnimationFrame.
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

/**
 * @deprecated Shadow audio and AnalyserNode have been removed.
 * The visualizer now reads primaryAudio.currentTime via requestAnimationFrame.
 * Kept as a no-op export so existing import statements compile without changes.
 */
export function getSharedAnalyser() { return null; }

/**
 * Returns the primary HTMLAudioElement owned by WaveSurfer, or null if the
 * engine has not been mounted yet. MobileSpectrumStrip reads currentTime from
 * this element each rAF tick to drive the position-based synthetic spectrum.
 */
export function getPrimaryElement() {
  return _ws?.getMediaElement?.() ?? null;
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

// ── Media Session position-state helper ───────────────────────────────────
// Called from both onPlaying and onTimeUpdate. Guards every field so that
// setPositionState() is never called with NaN / Infinity / out-of-range values
// (which throw a DOMException on some iOS builds).
function _msSetPositionState(mediaEl) {
  if (!("mediaSession" in navigator)) return;
  const dur = _mediaDuration > 0 ? _mediaDuration
    : (Number.isFinite(mediaEl?.duration) && mediaEl.duration > 0 ? mediaEl.duration : 0);
  if (dur <= 0) return;
  const pos = Math.min(Math.max(mediaEl?.currentTime ?? 0, 0), dur);
  const rate = mediaEl?.playbackRate > 0 ? mediaEl.playbackRate : 1;
  try {
    navigator.mediaSession.setPositionState({ duration: dur, playbackRate: rate, position: pos });
  } catch (_) {}
}

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
    // Tell the OS the track is playing so lock-screen controls show ⏸ not ▶.
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    _msSetPositionState(mediaEl);
  }
  function onPause() {
    console.log("[MobileEngine] native pause", { t: mediaEl.currentTime?.toFixed(2) });
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }
  function onEnded() {
    console.log("[MobileEngine] native ended");
    if (_ws === ws) _handlers.current?.onPlaybackChange?.(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
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
  function onDurationChange() {
    const d = mediaEl.duration;
    if (Number.isFinite(d) && d > 0) {
      _mediaDuration = d;
      _msSetPositionState(mediaEl);
    }
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
      }
    }
    _lastRealTime = _now;
    _lastMediaTime = _mediaTime;
    if (_ws === ws) _handlers.current?.onTimeUpdate?.(mediaEl.currentTime);
    // Update the lock-screen scrubber position. Throttled by the browser's
    // native timeupdate rate (~4 Hz) so this is inexpensive.
    _msSetPositionState(mediaEl);
  }

  mediaEl.addEventListener("play",           onPlay);
  mediaEl.addEventListener("playing",        onPlaying);
  mediaEl.addEventListener("pause",          onPause);
  mediaEl.addEventListener("ended",          onEnded);
  mediaEl.addEventListener("waiting",        onWaiting);
  mediaEl.addEventListener("stalled",        onStalled);
  mediaEl.addEventListener("canplay",        onCanPlay);
  mediaEl.addEventListener("error",          onError);
  mediaEl.addEventListener("durationchange", onDurationChange);
  mediaEl.addEventListener("timeupdate",     onTimeUpdate);

  return () => {
    mediaEl.removeEventListener("play",           onPlay);
    mediaEl.removeEventListener("playing",        onPlaying);
    mediaEl.removeEventListener("pause",          onPause);
    mediaEl.removeEventListener("ended",          onEnded);
    mediaEl.removeEventListener("waiting",        onWaiting);
    mediaEl.removeEventListener("stalled",        onStalled);
    mediaEl.removeEventListener("canplay",        onCanPlay);
    mediaEl.removeEventListener("error",          onError);
    mediaEl.removeEventListener("durationchange", onDurationChange);
    mediaEl.removeEventListener("timeupdate",     onTimeUpdate);
  };
}

// ── Audio interruption recovery ───────────────────────────────────────────

/**
 * Attach a statechange listener to _sharedCtx so OS audio interruptions
 * (phone calls, Siri, other audio apps grabbing the hardware session) are
 * detected and playback is auto-restored when the session is returned.
 *
 * Called once from startKeepAlive() after _sharedCtx is created. The context
 * lives for the full page session, so we wire this once and never re-wire.
 *
 * States we care about:
 *   "interrupted" — iOS-specific; another app or the OS took the session.
 *   "suspended"   — Can be OS-initiated (when page is still visible) OR our
 *                   own explicit suspend-on-hide. We distinguish them with
 *                   a document.visibilityState check: our suspends happen from
 *                   visibilitychange/pagehide handlers, meaning the page is
 *                   already hidden by the time statechange fires (async). OS
 *                   interruptions happen while the page is actively visible.
 *   "running"     — Session returned. If we flagged an interruption, resume.
 */
function _wireCtxStateListener() {
  if (!_sharedCtx) return;
  // Remove any previous listener (e.g., from a closed-and-recreated context).
  _detachCtxStateListener?.();

  function onStateChange() {
    const state = _sharedCtx?.state;
    console.log("[MobileEngine] AudioContext statechange →", state);

    if (state === "interrupted") {
      // iOS-specific interruption (phone call / Siri / AirPlay takeover).
      // Record whether the primary element was playing so we can resume it.
      const mediaEl = _ws?.getMediaElement?.();
      _interruptedWhilePlaying = Boolean(mediaEl && !mediaEl.paused && !mediaEl.ended);
      if (_interruptedWhilePlaying) {
        console.log("[MobileEngine] OS audio interruption — primary was playing; will restore.");
      }

    } else if (state === "suspended") {
      // Guard: our own intentional suspend-on-hide fires while the page is
      // already hidden (visibilitychange/pagehide set document.hidden before
      // calling suspend()). If the page is STILL VISIBLE here, this suspend
      // was OS-initiated — flag it as an interruption.
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        const mediaEl = _ws?.getMediaElement?.();
        const wasPlaying = Boolean(mediaEl && !mediaEl.paused && !mediaEl.ended);
        if (wasPlaying) {
          _interruptedWhilePlaying = true;
          console.log("[MobileEngine] Unexpected ctx suspension while visible — flagging interruption.");
        }
      }

    } else if (state === "running") {
      // AudioContext session returned. Attempt to resume the primary element
      // if an OS interruption previously paused it.
      if (_interruptedWhilePlaying) {
        _interruptedWhilePlaying = false;
        const mediaEl = _ws?.getMediaElement?.();
        const hasSrc = Boolean(mediaEl?.currentSrc || mediaEl?.src);
        if (mediaEl && mediaEl.paused && !mediaEl.ended && hasSrc) {
          console.log("[MobileEngine] AudioContext restored — resuming primary after interruption; t:",
            mediaEl.currentTime?.toFixed(3));
          _restoreAfterInterruption(mediaEl);
        }
      }
    }
  }

  _sharedCtx.addEventListener("statechange", onStateChange);
  _detachCtxStateListener = () => {
    _sharedCtx?.removeEventListener("statechange", onStateChange);
  };
}

/**
 * Attempt to resume primary element playback after an OS audio interruption.
 * Calls mediaEl.play() directly (not through WaveSurfer) for an immediate
 * hardware response. If iOS blocks it with NotAllowedError, falls back to a
 * one-time gesture listener so the stream recovers on the user's next tap.
 */
function _restoreAfterInterruption(mediaEl) {
  if (_isRestoring) return; // a restore chain is already in flight
  _isRestoring = true;

  // Clear any stale gesture recovery from a previous interruption.
  _detachGestureRecovery?.();
  _detachGestureRecovery = null;

  const p = mediaEl.play();
  if (p && typeof p.then === "function") {
    p.then(() => {
      console.log("[MobileEngine] Interruption recovery play() resolved ✓; t:",
        mediaEl.currentTime?.toFixed(3));
      _isRestoring = false;
    }).catch((e) => {
      console.warn("[MobileEngine] Interruption recovery play() rejected:", e.name, "—", e.message);
      _isRestoring = false;
      // iOS requires a user gesture. Register a one-time tap listener so the
      // stream re-primes the moment the user next touches the screen.
      if (e.name === "NotAllowedError" || e.name === "AbortError") {
        _registerGestureRecovery(mediaEl);
      }
    });
  } else {
    _isRestoring = false;
  }
}

/**
 * Register a one-time touch/pointer/keyboard listener that re-primes the
 * primary audio stream on the user's first interaction after an interruption.
 *
 * iOS blocks autoplay after some interruption types even when the context is
 * running again; the gesture listener gives us the unlocking event we need.
 * The listener self-cleans after firing or when the engine is disposed.
 */
function _registerGestureRecovery(mediaEl) {
  _detachGestureRecovery?.();

  function onGesture() {
    // Self-clean all three event types before doing anything async.
    _detachGestureRecovery?.();
    _detachGestureRecovery = null;

    if (!mediaEl || !mediaEl.paused || mediaEl.ended) return;
    console.log("[MobileEngine] Gesture recovery triggered — re-priming buffer; t:",
      mediaEl.currentTime?.toFixed(3));

    const doResume = (_sharedCtx && _sharedCtx.state !== "running")
      ? _sharedCtx.resume()
      : Promise.resolve();

    doResume.then(() => {
      mediaEl.play().then(() => {
        console.log("[MobileEngine] Gesture recovery play() resolved ✓");
      }).catch((e) => {
        console.warn("[MobileEngine] Gesture recovery play() still rejected:", e.name, "—", e.message);
      });
    }).catch(() => {});
  }

  // Listen on touchstart (iOS), pointerdown (cross-platform), and keydown
  // (keyboard / accessibility). { once: true } removes automatically after fire,
  // but we still keep _detachGestureRecovery for explicit cleanup on dispose.
  document.addEventListener("touchstart",  onGesture, { once: true, passive: true });
  document.addEventListener("pointerdown", onGesture, { once: true, passive: true });
  document.addEventListener("keydown",     onGesture, { once: true });

  _detachGestureRecovery = () => {
    document.removeEventListener("touchstart",  onGesture);
    document.removeEventListener("pointerdown", onGesture);
    document.removeEventListener("keydown",     onGesture);
  };

  console.log("[MobileEngine] Gesture recovery listener armed — tap anywhere to resume.");
}

// ── Media Session API ─────────────────────────────────────────────────────
// Wires the browser/OS lock-screen transport controls (▶ ⏸ ⏩ ⏪ scrubber)
// to the engine's primary audio element. Called from mountMobileEngine() on
// every track load so handlers always reference the live primary element via
// _ws.getMediaElement() at call time (not at registration time).
//
// Critical: 'play' and 'pause' hit mediaEl directly — not through WaveSurfer's
// async state machine — so the OS gets an immediate hardware response with no
// WaveSurfer bookkeeping delay. The shadow visualizer is paused synchronously
// on 'pause' alongside the primary element.

function _setupMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;

  ms.setActionHandler("play", () => {
    const mediaEl = _ws?.getMediaElement?.();
    if (!mediaEl) return;
    // Resume AudioContext first (it may be suspended from a hide cycle) then
    // play the primary element directly — hardware-immediate, no WaveSurfer delay.
    const doResume = (_sharedCtx && _sharedCtx.state !== "running")
      ? _sharedCtx.resume()
      : Promise.resolve();
    doResume.then(() => {
      mediaEl.play().catch((e) => {
        console.warn("[MobileEngine] mediaSession play rejected:", e.name, "—", e.message);
      });
    }).catch(() => {});
  });

  ms.setActionHandler("pause", () => {
    const mediaEl = _ws?.getMediaElement?.();
    // Primary element — synchronous, hardware-immediate.
    if (mediaEl) try { mediaEl.pause(); } catch (_) {}
    _wasPlayingOnHide = false;
    _isRestoring = false;
    _interruptedWhilePlaying = false;
    // WaveSurfer internal state sync (non-critical — native element is already paused).
    try { _ws?.pause(); } catch (_) {}
  });

  ms.setActionHandler("previoustrack", () => {
    _handlers.current?.onPrevTrack?.();
  });

  ms.setActionHandler("nexttrack", () => {
    _handlers.current?.onNextTrack?.();
  });

  ms.setActionHandler("seekto", (evt) => {
    if (evt?.seekTime == null) return;
    const mediaEl = _ws?.getMediaElement?.();
    if (!mediaEl) return;
    const dur = _mediaDuration > 0 ? _mediaDuration
      : (Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0);
    const t = Math.max(0, Math.min(evt.seekTime, dur || Infinity));
    try { mediaEl.currentTime = t; } catch (_) {}
    try { _ws?.setTime(t); } catch (_) {}
    _handlers.current?.onTimeUpdate?.(t);
  });
}

/**
 * Set the Media Session metadata shown on the lock screen and notification shade.
 * Call this from the component as soon as track info is available.
 *
 * @param {Object} opts
 * @param {string}   opts.title   — track/song title
 * @param {string}   [opts.artist] — artist name
 * @param {string}   [opts.album]  — album / project name (optional)
 * @param {Array}    [opts.artwork] — array of { src, sizes, type } objects (optional)
 */
export function setMediaSessionMetadata({ title = "", artist = "", album = "", artwork = [] } = {}) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    console.log("[MobileEngine] MediaSession metadata set:", title, "—", artist);
  } catch (e) {
    console.warn("[MobileEngine] MediaSession metadata failed:", e.message);
  }
}

// ── Mobile lifecycle: background / lock-screen stability ──────────────────
// Goal: native HTMLAudioElement owns playback. Audio is never paused on
// visibility / page-lifecycle events. We only restart if the OS actually
// stopped the element. All lifecycle transitions are logged for diagnostics.
//
// With the keep-alive AudioContext active, iOS keeps audio flowing through
// the Web Audio graph in the background. If iOS does auto-suspend the
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
    if (mediaEl && mediaEl.playbackRate !== 1) mediaEl.playbackRate = 1;
    console.log("[MobileEngine]", _snap("restore"));

    // Resume the AudioContext so the keep-alive stays active.
    const doCtxResume = (_sharedCtx && _sharedCtx.state !== "running")
      ? _sharedCtx.resume()
      : Promise.resolve();

    // ── Primary restart — only if iOS killed the native element ───────────
    // The primary element routes through hardware only (no Web Audio), so iOS
    // should keep it playing in the background. We only intervene if it
    // unexpectedly stopped AND the user intended it to be playing.
    if (_isRestoring) return; // a previous restore chain is already in flight

    // Guard: only restore if the user was playing the same track with time advancing.
    const intendedPlay = _wasPlayingOnHide
      && _url === _urlOnHide
      && _wasTimeAdvancing;

    _wasPlayingOnHide = false;

    if (!_ws || !mediaEl) return;

    const isStillPlaying = !mediaEl.paused && !mediaEl.ended;
    if (isStillPlaying) {
      console.log("[MobileEngine] Primary audio survived background ✓");
      return;
    }

    if (!intendedPlay) return;

    // Primary stopped unexpectedly while hidden — verify it still has a src.
    const hasSrc = Boolean(mediaEl.currentSrc || mediaEl.src);
    if (!hasSrc) {
      console.warn("[MobileEngine] Cannot restore primary — no src");
      return;
    }

    console.log("[MobileEngine] Primary stopped while hidden — restoring; t:",
      mediaEl.currentTime?.toFixed(3));
    _isRestoring = true;

    // Inner play call — checks _isRestoring first so an explicit user Pause
    // between the resume Promise and this call cancels the auto-resume cleanly.
    function _doPlay() {
      if (!_isRestoring) return;
      console.log("[MobileEngine] Calling mediaEl.play(); ctxState:", _sharedCtx?.state ?? "none");
      const p = mediaEl.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          console.log("[MobileEngine] mediaEl.play() resolved ✓; t:",
            mediaEl.currentTime?.toFixed(3), "ctxState:", _sharedCtx?.state ?? "none");
          _isRestoring = false;
        }).catch((e) => {
          console.warn("[MobileEngine] mediaEl.play() rejected after restore:",
            e.name, "—", e.message);
          _isRestoring = false;
        });
      } else {
        _isRestoring = false;
      }
    }

    // Wait for the AudioContext resume Promise from above before calling play().
    // This keeps the shadow restart and primary restart on the same settled chain.
    doCtxResume.then(_doPlay).catch(() => { _isRestoring = false; });
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

      // ── Hard-reset on hide ──────────────────────────────────────────────
      // Cancel any in-flight restore so a slow pageshow/focus chain from a
      // previous unlock cannot race with the new hide.
      _isRestoring = false;

      // Explicitly suspend the AudioContext the moment the page hides.
      // The primary element routes through native hardware (not Web Audio),
      // so this only freezes the keep-alive chain — never primary playback.
      // Gives a clean, known baseline for the resume sequence in
      // _onRestoreVisible() so ctx.state === "running" before any play().
      if (_sharedCtx && _sharedCtx.state === "running") {
        _sharedCtx.suspend().catch(() => {});
      }

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
    // Belt-and-suspenders: suspend the AudioContext on pagehide too.
    // visibilitychange covers most paths but pagehide fires independently on
    // bfcache evictions where visibilitychange may not have fired first.
    if (_sharedCtx && _sharedCtx.state === "running") {
      _sharedCtx.suspend().catch(() => {});
    }
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

  // peaksUrl is an optional property of the handlers/options object.
  // When present we fetch the pre-generated peaks JSON from R2 and hand it
  // to WaveSurfer so it can skip client-side audio decoding entirely.
  const peaksUrl = handlers?.peaksUrl ?? null;

  if (_url === url && _ws) {
    return _ws;
  }

  _wasPlayingOnHide = false;
  _urlOnHide = null;
  _wasTimeAdvancing = false;
  _isRestoring = false;
  _mediaDuration = 0;

  // Reuse the existing WaveSurfer instance when one is available — calling
  // ws.load(newUrl) keeps the same HTMLAudioElement alive so iOS retains the
  // user-gesture audio permission across track switches without a new gesture.
  const _reusingInstance = Boolean(_ws);
  if (_ws) {
    _detachNativeListeners?.();
    _detachNativeListeners = null;
    _interruptedWhilePlaying = false;
    // Scrub per-track WaveSurfer listeners (ready/error) so stale handlers from
    // the previous track don't fire on the new load.  Native <audio> element
    // events (play/pause/timeupdate/ended) survive because attachNativeListeners
    // puts them on the HTMLAudioElement, not on WaveSurfer's EventEmitter.
    _ws.unAll();
    const reuseMediaEl = _ws.getMediaElement?.();
    if (reuseMediaEl) {
      _detachNativeListeners = attachNativeListeners(reuseMediaEl, _ws);
    }
  }

  _url = url;

  if (!url) {
    if (_ws) { _ws.destroy(); _ws = null; }
    return null;
  }

  // ── Logging ────────────────────────────────────────────────────────────
  const ext = url.split("?")[0].split(".").pop().toLowerCase();
  // Detect WAV so we can apply format-specific streaming configuration below.
  // WAV files served from R2 are uncompressed and can be 40–100 MB; they
  // require different preload and CORS treatment than the smaller MP3 assets.
  const isWav = ext === "wav";
  console.log("[MixReview] MobileEngine mount", { ext, isWav, url: url.slice(0, 120) });
  probeAudioUrl(url).catch(() => {}); // background, non-blocking

  // ── Peaks pre-fetch ────────────────────────────────────────────────────
  // Start the peaks JSON fetch now so it runs in parallel with the WaveSurfer
  // constructor and early event-subscription wiring below.
  //
  // WaveSurfer v7 defers its first internal load() to a microtask via
  // Promise.resolve().then(). By omitting `url` from create() options (below)
  // we suppress that deferred load entirely, then fire ws.load(url, peaks)
  // ourselves once the fetch settles — passing peaks skips WaveSurfer's
  // full audio blob fetch + decodeAudioData decode cycle.
  //
  // If peaksUrl is absent, or the fetch fails for any reason, peaksFetch
  // resolves to null and we fall back to ws.load(url) with no peaks
  // (the existing full-decode path), silently.
  const peaksFetch = peaksUrl
    ? fetch(peaksUrl)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .catch((err) => {
          console.warn("[MixReview] Peaks fetch failed — falling back to full decode:", err.message);
          return null;
        })
    : Promise.resolve(null);

  // ── WaveSurfer instance ────────────────────────────────────────────────
  // `url` is intentionally omitted here. WaveSurfer v7 defers its first
  // load() call to a microtask (Promise.resolve().then) and only fires it
  // when `initialUrl` is non-empty. By omitting the url we suppress that
  // auto-load so we can call ws.load(url, peaks) ourselves below, after
  // peaksFetch settles, injecting the pre-generated peaks array directly.
  //
  // `backend: "MediaElement"` selects the HTMLAudioElement path (not
  // WebAudioPlayer), pairing with R2 byte-range streaming. In WaveSurfer v7
  // the check is `options.backend === 'WebAudio' ? new WebAudioPlayer() : undefined`,
  // so any non-WebAudio value keeps the native <audio> element.
  // ── Low-memory canvas guard ────────────────────────────────────────────
  // On low-RAM iOS devices the browser may refuse to allocate a high-DPR
  // canvas (devicePixelRatio ≥ 2–3), causing a silent OOM that surfaces as
  // a blank waveform or a 'Waveform unavailable' fallback.
  // Fixes:
  //   pixelRatio: 1  — always render at 1:1, never 2x or 3x Retina.
  //                    Halves canvas RAM on 2x devices, cuts it to ⅓ on 3x.
  //   minPxPerSec: 1 — prevents WaveSurfer from stretching the canvas to an
  //                    enormous width for long tracks (e.g. a 60-min track at
  //                    the default 50 px/s would need a 180 000-px canvas).
  //   fillParent: true already set — canvas width = container width, so the
  //                    minPxPerSec ceiling only matters when the calculated
  //                    width would exceed fillParent; keep it as a floor guard.
  let ws;
  if (!_reusingInstance) {
    try {
      ws = WaveSurfer.create({
        container,
        backend: "MediaElement",
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
        pixelRatio: 1,
        minPxPerSec: 1,
      });
    } catch (e) {
      console.warn("[MixReview] WaveSurfer.create() failed — canvas unavailable:", e?.message ?? String(e));
      _handlers.current?.onError?.(new Error("Waveform renderer unavailable"));
      return null;
    }

    _ws = ws;

    const earlyMediaEl = ws.getMediaElement?.();
    if (earlyMediaEl) {
      earlyMediaEl.crossOrigin = "anonymous";
      earlyMediaEl.preload = isWav ? "metadata" : "auto";
      _detachNativeListeners?.();
      _detachNativeListeners = null;
      _detachNativeListeners = attachNativeListeners(earlyMediaEl, ws);
    }

    _setupMediaSession();
  } else {
    // Reuse existing instance — same <audio> element, iOS permission intact.
    ws = _ws;
    console.log("[MixReview] MobileEngine reuse — calling ws.load() on existing instance");
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
      pause: () => {
          // Synchronous stop priority: halt the media element immediately as the
          // very first action, bypassing any WaveSurfer async state machine so
          // the hardware audio output is silenced before anything else runs.
          try { mediaEl.pause(); } catch (_) {}
          _wasPlayingOnHide = false; // prevent any pending restore from restarting
          _isRestoring = false;      // cancel in-flight ctx-resume → play() chain
          _interruptedWhilePlaying = false; // user-pause disarms interruption recovery
          _detachGestureRecovery?.();
          _detachGestureRecovery = null;
          try { ws.pause(); } catch (_) {}
        },
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
      pause: () => {
          // Synchronous stop priority: halt the media element immediately as the
          // very first action, bypassing any WaveSurfer async state machine so
          // the hardware audio output is silenced before anything else runs.
          try { mediaElement?.pause(); } catch (_) {}
          _wasPlayingOnHide = false;
          _isRestoring = false;
          _interruptedWhilePlaying = false; // user-pause disarms interruption recovery
          _detachGestureRecovery?.();
          _detachGestureRecovery = null;
          try { ws.pause(); } catch (_) {}
        },
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

  // ── Trigger load with or without peaks ────────────────────────────────
  // This replaces the deferred auto-load we suppressed by omitting `url`
  // from create() options. Once peaksFetch settles (nearly instant when the
  // peaks JSON is already cached at the CDN edge), we hand WaveSurfer the
  // peaks array so it renders the waveform from pre-computed data instead of
  // fetching and decoding the full audio binary. Falls back to the standard
  // load path silently if peaksUrl was absent or the fetch failed.
  // ── ws.load() error handler ────────────────────────────────────────────
  // Funnels Promise rejections from ws.load() into activateFallback so that
  // canvas-allocation failures (OOM on low-RAM iOS) or network errors that
  // WaveSurfer surfaces as rejected Promises don't disappear silently.
  // AbortErrors are informational only — they are expected when activateFallback
  // (case B) calls ws.abortController.abort() to cancel a stalled fetch.
  function _onLoadError(e) {
    if (_ws !== ws) return;
    const name = e?.name ?? "";
    const msg  = e?.message ?? String(e);
    if (name === "AbortError") {
      console.log("[MixReview] ws.load() aborted (intentional)");
      return;
    }
    console.warn("[MixReview] ws.load() rejected:", name, "—", msg);
    if (!didSettle) activateFallback("canvas-error");
  }

  peaksFetch.then((peaks) => {
    // Guard: URL changed or engine was disposed while peaks were in flight.
    if (_ws !== ws || _url !== url) return;
    if (peaks) {
      console.log("[MixReview] Loading WaveSurfer with pre-fetched peaks", {
        numPoints: peaks.length,
        url: url.slice(0, 80),
      });
      ws.load(url, peaks).catch(_onLoadError);
    } else {
      ws.load(url).catch(_onLoadError);
    }
  });

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
  _isRestoring = false;
  _interruptedWhilePlaying = false;
  // Disarm the gesture-recovery listener so a stale handler cannot fire
  // after the engine has been torn down (e.g. on track change or unmount).
  _detachGestureRecovery?.();
  _detachGestureRecovery = null;
  if (_ws) {
    _ws.destroy();
    _ws = null;
  }
  _url = null;
  _wasPlayingOnHide = false;
  _urlOnHide = null;
  _wasTimeAdvancing = false;
  _handlers.current = null;
  // _sharedCtx / _keepAliveSrc / _detachCtxStateListener are
  // intentionally NOT cleared here. They live for the full page session so
  // MobileSpectrumStrip can reuse the already-unlocked context across track
  // switches, and the statechange listener must remain active to detect
  // interruptions between track loads.
}
