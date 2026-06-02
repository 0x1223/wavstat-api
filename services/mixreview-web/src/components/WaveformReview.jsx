import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, mountMobileEngine } from "../lib/mobileAudioEngine.js";

function getPlaybackUrl(audioSource) {
  return audioSource?.previewUrl || audioSource?.playbackUrl || audioSource?.url || "";
}

const STATIC_WAVEFORM_CURVE = [0.15, 0.2, 0.35, 0.5, 0.65, 0.75, 0.8, 0.72, 0.6, 0.45, 0.35, 0.4, 0.55, 0.7, 0.85, 0.9, 0.82, 0.68, 0.5, 0.3, 0.2, 0.15];

function buildStaticPeaks(length = 300) {
  return [Array.from({ length }, (_, i) => STATIC_WAVEFORM_CURVE[i % STATIC_WAVEFORM_CURVE.length])];
}

function normalizePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    return null;
  }
  return Array.isArray(peaks[0]) ? peaks : [peaks];
}

function fetchPeaks(peaksUrl, timeoutMs = 800) {
  if (!peaksUrl) {
    return Promise.resolve(null);
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  return fetch(peaksUrl, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(normalizePeaks)
    .catch((error) => {
      if (error?.name !== "AbortError") {
        console.warn("[WaveformReview] Peaks fetch failed — using static peaks", error.message);
      }
      return null;
    })
    .finally(() => window.clearTimeout(timeoutId));
}


export function WaveformReview({
  audioSource,
  comments,
  selectedCommentId,
  selectedTime,
  previewMarkerTime = null,
  trackTitle,
  trackColor = null,
  onTimestampCreate,
  onMarkerSelect,
  onReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
  isReviewerMode = false,
  onMobileNoteRequest,
  // Mobile first-play helpers.
  // onMobileTapPlay — callback invoked when the "Tap to Listen" overlay is pressed;
  //   caller is responsible for unlocking the audio session and starting playback.
  // mobilePlayUnlocked — when true the overlay is hidden (user has already played once).
  onMobileTapPlay = undefined,
  mobilePlayUnlocked = false,
  onPrevTrack = undefined,
  onNextTrack = undefined,
}) {
  const containerRef = useRef(null);
  const wavesurferRef = useRef(null);
  // Touch-gesture axis lock: populated on touchstart, read on touchmove.
  // touchStartRef   — {x, y} of the first touch point.
  // gestureAxisRef  — 'h' (horizontal/scrub) | 'v' (vertical/scroll) | null (undecided).
  // Once locked to an axis for a given gesture the decision is final until touchend.
  const touchStartRef = useRef(null);
  const gestureAxisRef = useRef(null);
  // ── Pinch-to-zoom refs ────────────────────────────────────────────────────
  // zoomScaleRef    — current scale factor (≥ 1.0).
  // zoomTxRef       — current translateX in px; moves the wrapper left so the focal
  //                   audio point stays visually anchored under the fingers.
  // zoomWrapperRef  — div that wraps canvas + marker-layer; transform written directly
  //                   so both children move on the same GPU layer in the same frame.
  // waveformStageRef — stage element; pinch listeners attached here, not on the canvas.
  // pinchStateRef   — { initialDist, initialZoom, initialTx, focalX, stageWidth }
  //                   captured once on two-finger touchstart; all values are fixed for
  //                   the lifetime of that gesture so onPinchMove can derive the new
  //                   transform purely from the live finger distance.
  // rafPinchId      — cancelAnimationFrame handle; one DOM write per frame.
  const zoomScaleRef = useRef(1.0);
  const zoomTxRef = useRef(0);          // translateX offset in px, always in sync with zoomScaleRef
  const zoomWrapperRef = useRef(null);
  const waveformStageRef = useRef(null);
  const pinchStateRef = useRef(null);
  const rafPinchId = useRef(null);
  // markerLayerRef — direct scaleX DOM write so markers scale in the same RAF frame
  //                  as the WaveSurfer canvas redraw (no React re-render required).
  // durationRef    — mirrors `duration` state so onPinchStart can compute basePxPerSec
  //                  without adding `duration` to the pinch-effect's dependency array.
  const markerLayerRef = useRef(null);
  const durationRef = useRef(0);
  const callbacksRef = useRef({
    onDurationChange,
    onPlaybackChange,
    onReady,
    onTimeUpdate,
    onTimestampCreate,
    onMobileNoteRequest,
  });
  const [duration, setDuration] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isMarkerToolActive, setIsMarkerToolActive] = useState(false);
  const [pendingMarker, setPendingMarker] = useState(null);
  useEffect(() => {
    callbacksRef.current = {
      onDurationChange,
      onPlaybackChange,
      onReady,
      onTimeUpdate,
      onTimestampCreate,
      onMobileNoteRequest,
    };
  }, [onDurationChange, onMobileNoteRequest, onPlaybackChange, onReady, onTimeUpdate, onTimestampCreate]);

  // Keep durationRef current so the pinch-effect (empty deps) can read duration
  // without re-registering its touch listeners on every duration change.
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // ── Pinch-to-zoom: non-passive native listeners on the stage ─────────────
  // Must use addEventListener({ passive: false }) so e.preventDefault() can
  // suppress browser pan/zoom while a 2-finger gesture is active.
  // All mutable state lives in refs so this effect never needs to re-run.
  useEffect(() => {
    const stage = waveformStageRef.current;
    if (!stage) return;

    function getPinchDist(touches) {
      return Math.hypot(
        touches[1].clientX - touches[0].clientX,
        touches[1].clientY - touches[0].clientY,
      );
    }

    function onPinchStart(e) {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      // focalX — horizontal midpoint between the two fingers, measured from the
      // stage's left edge.  This is the screen coordinate that must stay fixed on
      // screen as zoom changes (the "pivot" point for the gesture).
      //
      // basePxPerSec — pixels-per-second at zoom=1, computed from the stage width
      // (which never changes) divided by the current duration. Captured once per
      // gesture so wavesurfer.zoom() is always called relative to the unscaled
      // baseline, regardless of how many sequential pinch gestures have occurred.
      const stageRect = stage.getBoundingClientRect();
      const focalX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - stageRect.left;
      pinchStateRef.current = {
        initialDist:  getPinchDist(e.touches),
        initialZoom:  zoomScaleRef.current,
        initialTx:    zoomTxRef.current,
        focalX,
        stageWidth:   stageRect.width,
        basePxPerSec: durationRef.current > 0 ? stageRect.width / durationRef.current : 0,
      };
    }

    function onPinchMove(e) {
      if (e.touches.length !== 2 || !pinchStateRef.current) return;
      e.preventDefault();
      const { initialDist, initialZoom, initialTx, focalX, stageWidth } = pinchStateRef.current;

      const dist     = getPinchDist(e.touches);
      const nextZoom = Math.min(8.0, Math.max(1.0, initialZoom * (dist / initialDist)));

      // Derive translateX so that the audio position at focalX stays at focalX.
      //
      // With transform: translateX(tx) scaleX(N) and transform-origin: left center,
      // a point at natural waveform coordinate X maps to screen position X*N + tx.
      //
      // The natural coordinate of the focal audio point is:
      //   audioFocal = (focalX - initialTx) / initialZoom
      //
      // We want:  audioFocal * nextZoom + nextTx = focalX
      //   ⟹  nextTx = focalX − (focalX − initialTx) * (nextZoom / initialZoom)
      const rawTx  = focalX - (focalX - initialTx) * (nextZoom / initialZoom);

      // Clamp so the waveform never drifts away from filling the visible stage:
      //   • nextTx ≤ 0            — left edge of waveform cannot go right of stage left
      //   • nextTx ≥ stageWidth*(1−nextZoom) — right edge cannot go left of stage right
      const nextTx = Math.min(0, Math.max(stageWidth * (1 - nextZoom), rawTx));

      if (rafPinchId.current !== null) cancelAnimationFrame(rafPinchId.current);
      rafPinchId.current = requestAnimationFrame(() => {
        rafPinchId.current = null;
        zoomScaleRef.current = nextZoom;
        zoomTxRef.current    = nextTx;

        // translateX pans the canvas to keep the focal audio point under the fingers.
        // scaleX is intentionally omitted — the canvas is redrawn natively below
        // so the waveform peaks are always sharp, never CSS-pixel-stretched.
        if (zoomWrapperRef.current) {
          zoomWrapperRef.current.style.transform = `translateX(${nextTx}px)`;
        }

        // Force WaveSurfer to redraw peaks at the zoomed resolution.
        // basePxPerSec is the zoom=1 baseline (stageWidth / duration) captured at
        // gesture start — always the same reference point regardless of prior zooms.
        const { basePxPerSec } = pinchStateRef.current;
        if (wavesurferRef.current?.zoom && basePxPerSec > 0) {
          wavesurferRef.current.zoom(basePxPerSec * nextZoom);
        }

        // Scale the marker layer to match the zoomed canvas — same RAF frame,
        // no catch-up lag. The markers' `left` values are in zoom=1 pixel space
        // so scaleX(nextZoom) with origin at left maps them to the correct
        // positions on the wider canvas.
        if (markerLayerRef.current) {
          markerLayerRef.current.style.transform = `scaleX(${nextZoom})`;
        }
      });
    }

    function onPinchEnd(e) {
      if (!pinchStateRef.current || e.touches.length >= 2) return;
      pinchStateRef.current = null;
      if (rafPinchId.current !== null) {
        cancelAnimationFrame(rafPinchId.current);
        rafPinchId.current = null;
      }
    }

    stage.addEventListener('touchstart', onPinchStart, { passive: false });
    stage.addEventListener('touchmove', onPinchMove, { passive: false });
    stage.addEventListener('touchend', onPinchEnd, { passive: true });
    stage.addEventListener('touchcancel', onPinchEnd, { passive: true });

    return () => {
      stage.removeEventListener('touchstart', onPinchStart);
      stage.removeEventListener('touchmove', onPinchMove);
      stage.removeEventListener('touchend', onPinchEnd);
      stage.removeEventListener('touchcancel', onPinchEnd);
      if (rafPinchId.current !== null) cancelAnimationFrame(rafPinchId.current);
    };
  }, []); // empty deps — all access is via refs, stable for component lifetime

  // Dispose the mobile engine only when the component truly unmounts (not on
  // URL changes between tracks). Keeping the engine alive across URL changes
  // preserves the same HTMLAudioElement so iOS retains audio session permission.
  useEffect(() => {
    return () => {
      disposeMobileEngine();
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    setIsLoading(true);
    setLoadError("");
    setDuration(0);
    setWaveformWidth(getWaveformMetrics(containerRef.current).width);
    callbacksRef.current.onReady(null);
    callbacksRef.current.onTimeUpdate(0);
    callbacksRef.current.onDurationChange(0);
    callbacksRef.current.onPlaybackChange(false);

    const playbackUrl = getPlaybackUrl(audioSource);
    const resolvedWaveColor = trackColor?.wave || "#6d6457";
    const resolvedProgressColor = trackColor?.progress || "#d6a354";

    // ── Load-start logging ──────────────────────────────────────────────
    const ext = (playbackUrl ?? "").split("?")[0].split(".").pop().toLowerCase();
    const fileSize = audioSource?.size
      ? `${(audioSource.size / 1_048_576).toFixed(1)} MB`
      : "(unknown)";
    console.log("[WaveformReview] Audio source changed", {
      fileName: audioSource?.fileName ?? "(unknown)",
      extension: ext,
      mimeType: audioSource?.mimeType ?? audioSource?.type ?? "(unknown)",
      fileSize,
      url: (playbackUrl ?? "").slice(0, 120),
    });

    if (!playbackUrl) {
      setIsLoading(false);
      callbacksRef.current.onReady(null);
      return undefined;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setWaveformWidth(getWaveformMetrics(entry.target).width);
    });
    resizeObserver.observe(containerRef.current);

    if (isMobileViewport()) {
      // Mobile: singleton engine — survives React re-renders and comment state changes
      console.log("[WaveformReview] Mobile decode start", { url: playbackUrl.slice(0, 100) });
      const ws = mountMobileEngine(containerRef.current, playbackUrl, {
        peaksUrl: audioSource?.peaksUrl || null,
        waveColor: resolvedWaveColor,
        progressColor: resolvedProgressColor,
        onReady: (player) => {
          console.log("[WaveformReview] Mobile decode success");
          setIsLoading(false);
          callbacksRef.current.onReady(player);
        },
        // Called when waveform decode fails/times out but the audio element
        // can still play. Player interface is functional; waveform is empty.
        onWaveformUnavailable: (player, reason) => {
          console.log("[WaveformReview] Waveform unavailable — audio-only mode", { reason });
          setIsLoading(false);
          setLoadError("Waveform unavailable — tap ▶ to listen");
          callbacksRef.current.onReady(player);
        },
        onError: (err) => {
          console.warn("[WaveformReview] Mobile decode failure", err?.message);
          setIsLoading(false);
          setLoadError("This audio file could not be decoded. Try a WAV or MP3 file.");
          callbacksRef.current.onReady(null);
          callbacksRef.current.onDurationChange(0);
          callbacksRef.current.onPlaybackChange(false);
        },
        onDurationChange: (d) => {
          setDuration(d);
          callbacksRef.current.onDurationChange(d);
        },
        onTimeUpdate: (t) => callbacksRef.current.onTimeUpdate(t),
        onPlaybackChange: (p) => callbacksRef.current.onPlaybackChange(p),
        onPrevTrack,
        onNextTrack,
      });
      wavesurferRef.current = ws;
      return () => {
        if (wavesurferRef.current === ws) wavesurferRef.current = null;
        resizeObserver.disconnect();
        // Do NOT dispose engine here — URL change keeps the same <audio> element
        // alive so iOS retains audio session permission across track switches.
        // True unmount disposal is handled by the dedicated empty-deps effect above.
      };
    }

    // Desktop: inline WaveSurfer instance
    //
    // Lifecycle note: WaveSurfer.create() and all event bindings are deferred
    // one animation frame so the CSS grid/flex container has completed its
    // first layout pass before the canvas reads container dimensions.
    // Without this deferral, the initial default track fires the effect while
    // the layout is still computing, giving WaveSurfer a zero-width container
    // and producing a different rendering state than manually switched tracks
    // (which always run after layout is stable). Deferring one frame makes
    // both paths identical.
    let isDisposed = false;
    let hasLoaded = false;
    let wavesurfer = null;
    let decodeTimeout = null;
    let audioReadyTimer = null;

    const peaksFetch = fetchPeaks(audioSource?.peaksUrl || null);

    // Defer DOM binding past first paint — same frame budget for initial load
    // and all subsequent manual track switches.
    const rafId = requestAnimationFrame(() => {
      if (isDisposed || !containerRef.current) return;

      console.log("[WaveformReview] Desktop decode start", {
        url: playbackUrl.slice(0, 120),
        ext,
        fileSize,
        peaksUrl: audioSource?.peaksUrl || null,
      });

      // containerRef, height (180), and fillParent are intentionally fixed —
      // do not alter them; the waveform canvas must not shift or resize.
      wavesurfer = WaveSurfer.create({
        container: containerRef.current,
        backend: "MediaElement",
        waveColor: resolvedWaveColor,
        progressColor: resolvedProgressColor,
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

      wavesurferRef.current = wavesurfer;

      // ── canplay fast-path ──────────────────────────────────────────────────
      // decodeAudioData for large files can take 10–30 s on slow devices even
      // though the browser has buffered enough to start playback within seconds.
      // When the internal <audio> element fires "canplay", start a short grace
      // timer. If WaveSurfer hasn't fired "ready" within that window we surface
      // the player in audio-only mode so the user can listen while decoding
      // continues in the background. When WaveSurfer eventually fires "ready"
      // the waveform canvas updates automatically and we clear the status message.
      {
        const AUDIO_READY_GRACE_MS = 1_500;
        const mediaElEarly = wavesurfer.getMediaElement?.();
        if (mediaElEarly) {
          const onCanPlay = () => {
            if (isDisposed || hasLoaded) return;
            audioReadyTimer = setTimeout(() => {
              if (isDisposed || hasLoaded) return;
              hasLoaded = true;
              clearTimeout(decodeTimeout);
              const dur = Number.isFinite(mediaElEarly.duration) ? mediaElEarly.duration : 0;
              console.log("[WaveformReview] canplay fast-path — surfacing player before full decode", { dur });
              mediaElEarly.muted = false;
              mediaElEarly.volume = 1;
              setDuration(dur);
              setIsLoading(false);
              setLoadError("Waveform loading… tap ▶ to listen now");
              callbacksRef.current.onDurationChange(dur);
              callbacksRef.current.onReady({
                wavesurfer,
                mediaElement: mediaElEarly,
                play: async () => { await wavesurfer.play(); },
                pause: () => wavesurfer.pause(),
                playPause: async () => { await wavesurfer.playPause(); },
                skip: (s) => wavesurfer.skip(s),
                seekToTime: (time) => {
                  const t = Math.min(Math.max(time, 0), wavesurfer.getDuration() || dur);
                  wavesurfer.setTime(t);
                  callbacksRef.current.onTimeUpdate(t);
                },
              });
            }, AUDIO_READY_GRACE_MS);
          };
          mediaElEarly.addEventListener("canplay", onCanPlay, { once: true });
        }
      }

      // ── Desktop decode timeout ────────────────────────────────────────────
      // If WaveSurfer's fetch or decodeAudioData stalls, surface a clear
      // message rather than leaving the UI stuck on "Preparing waveform".
      const DESKTOP_TIMEOUT_MS = 45_000;
      decodeTimeout = setTimeout(() => {
        if (isDisposed || hasLoaded) return;
        hasLoaded = true;
        console.warn("[WaveformReview] Desktop decode timeout after", DESKTOP_TIMEOUT_MS, "ms");
        const mediaEl = wavesurfer.getMediaElement?.();
        if (mediaEl && !mediaEl.error && mediaEl.readyState >= 2) {
          // Audio element has data even though waveform decode stalled — audio-only
          mediaEl.muted = false;
          mediaEl.volume = 1;
          const dur = Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0;
          setDuration(dur);
          setIsLoading(false);
          setLoadError("Waveform unavailable — audio is ready to play");
          callbacksRef.current.onDurationChange(dur);
          callbacksRef.current.onReady({
            wavesurfer,
            mediaElement: mediaEl,
            play: async () => { await wavesurfer.play(); },
            pause: () => wavesurfer.pause(),
            playPause: async () => { await wavesurfer.playPause(); },
            skip: (s) => wavesurfer.skip(s),
            seekToTime: (time) => {
              const t = Math.min(Math.max(time, 0), wavesurfer.getDuration());
              wavesurfer.setTime(t);
              callbacksRef.current.onTimeUpdate(t);
            },
          });
        } else {
          setIsLoading(false);
          setLoadError("Waveform generation timed out — please refresh and try again.");
          callbacksRef.current.onReady(null);
          callbacksRef.current.onDurationChange(0);
          callbacksRef.current.onPlaybackChange(false);
        }
      }, DESKTOP_TIMEOUT_MS);

      wavesurfer.on("ready", () => {
        if (isDisposed) return;
        clearTimeout(audioReadyTimer);

        if (hasLoaded) {
          // canplay fast-path already surfaced the player — the waveform canvas
          // has now finished rendering, so just clear the interim status message
          // and update duration in case it wasn't available at canplay time.
          clearTimeout(decodeTimeout);
          const audioDuration = wavesurfer.getDuration();
          if (audioDuration > 0) {
            setDuration(audioDuration);
            callbacksRef.current.onDurationChange(audioDuration);
          }
          setLoadError("");
          return;
        }

        hasLoaded = true;
        clearTimeout(decodeTimeout);
        const audioDuration = wavesurfer.getDuration();
        const mediaElement = wavesurfer.getMediaElement();
        if (mediaElement) {
          mediaElement.muted = false;
          mediaElement.volume = 1;
          mediaElement.preload = "auto";
        }
        console.log("[WaveformReview] Desktop decode success", {
          duration: audioDuration,
          readyState: mediaElement?.readyState,
        });
        setDuration(audioDuration);
        setIsLoading(false);
        callbacksRef.current.onDurationChange(audioDuration);
        callbacksRef.current.onReady({
          wavesurfer,
          mediaElement,
          play: async () => { await wavesurfer.play(); },
          pause: () => wavesurfer.pause(),
          playPause: async () => { await wavesurfer.playPause(); },
          skip: (seconds) => wavesurfer.skip(seconds),
          seekToTime: (time) => {
            const nextTime = Math.min(Math.max(time, 0), wavesurfer.getDuration());
            wavesurfer.setTime(nextTime);
            callbacksRef.current.onTimeUpdate(nextTime);
          }
        });
      });

      wavesurfer.on("error", (error) => {
        if (isDisposed || hasLoaded) return;

        hasLoaded = true;
        clearTimeout(decodeTimeout);
        clearTimeout(audioReadyTimer);
        console.warn("[WaveformReview] Desktop decode failure", error?.message ?? String(error));
        setIsLoading(false);
        setLoadError("This audio file could not be decoded. Try a WAV or MP3 file.");
        callbacksRef.current.onReady(null);
        callbacksRef.current.onDurationChange(0);
        callbacksRef.current.onPlaybackChange(false);
      });

      wavesurfer.on("timeupdate", (time) => {
        if (!isDisposed) callbacksRef.current.onTimeUpdate(time);
      });

      wavesurfer.on("play", () => {
        if (!isDisposed) callbacksRef.current.onPlaybackChange(true);
      });
      wavesurfer.on("pause", () => {
        if (!isDisposed) callbacksRef.current.onPlaybackChange(false);
      });
      wavesurfer.on("finish", () => {
        if (!isDisposed) callbacksRef.current.onPlaybackChange(false);
      });

      peaksFetch.then((peaks) => {
        if (isDisposed || !wavesurfer) return;
        const resolvedPeaks = peaks || buildStaticPeaks();
        console.log("[WaveformReview] Desktop loading with precomputed peaks", {
          source: peaks ? "peaksUrl" : "static",
          points: resolvedPeaks[0]?.length || 0,
        });
        wavesurfer.load(playbackUrl, resolvedPeaks).catch((error) => {
          if (isDisposed || hasLoaded) return;
          console.warn("[WaveformReview] Desktop load failed", error?.message ?? String(error));
          hasLoaded = true;
          clearTimeout(decodeTimeout);
          clearTimeout(audioReadyTimer);
          setIsLoading(false);
          setLoadError("This audio file could not be loaded. Try a WAV or MP3 file.");
          callbacksRef.current.onReady(null);
          callbacksRef.current.onDurationChange(0);
          callbacksRef.current.onPlaybackChange(false);
        });
      });
    });

    return () => {
      isDisposed = true;
      cancelAnimationFrame(rafId);
      clearTimeout(decodeTimeout);
      clearTimeout(audioReadyTimer);
      if (wavesurfer) {
        if (wavesurferRef.current === wavesurfer) wavesurferRef.current = null;
        wavesurfer.destroy();
      }
      resizeObserver.disconnect();
    };
  }, [
    audioSource?.previewUrl,
    audioSource?.playbackUrl,
    audioSource?.url,
    audioSource?.peaksUrl,
    trackColor?.wave,
    trackColor?.progress,
  ]);

  function seekToTime(time) {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || duration <= 0) {
      return;
    }

    const nextTime = Math.min(Math.max(time, 0), duration);
    wavesurfer.setTime(nextTime);
    callbacksRef.current.onTimeUpdate(nextTime);
  }

  function handleWaveformClick(event) {
    if (event.target.closest(".wave-marker") || isLoading || loadError || duration <= 0) {
      return;
    }

    const metrics = getWaveformMetrics(containerRef.current);
    if (!metrics.width) {
      return;
    }

    const clickRatio = Math.min(1, Math.max(0, (event.clientX - metrics.left) / (metrics.width * zoomScaleRef.current)));
    const clickedTime = clickRatio * duration;

    // Mobile reviewer: WaveSurfer's dragToSeek handles the seek internally on waveform tap,
    // so we skip our redundant seekToTime call to avoid a double-seek audio glitch.
    if (isReviewerMode && isMobileViewport()) {
      event.preventDefault();
      event.stopPropagation();
      if (isMarkerToolActive) {
        callbacksRef.current.onMobileNoteRequest?.(clickedTime);
        setIsMarkerToolActive(false);
      }
      return;
    }

    // Desktop: open the inline comment editor at this timestamp.
    if (isMarkerToolActive) {
      setPendingMarker({ time: clickedTime, text: "" });
      setIsMarkerToolActive(false);
    }
  }
  const hasAudio = Boolean(getPlaybackUrl(audioSource));
  const markerItems = duration > 0
    ? [
        ...comments,
        ...(Number.isFinite(previewMarkerTime)
          ? [{ id: "__mobile-note-preview", time: previewMarkerTime, resolved: false, isPreview: true }]
          : []),
        ...(pendingMarker
          ? [{ id: "__desktop-pending", time: pendingMarker.time, resolved: false, isPreview: true }]
          : [])
      ].map((comment) => ({
        ...comment,
        left:
          duration > 0 && waveformWidth > 0
            ? `${Math.min(waveformWidth, Math.max(0, (comment.time / duration) * waveformWidth))}px`
            : "0px"
      }))
    : [];

  const timelineLabels = duration > 0 ? getTimelineLabels(duration) : [];

  return (
    <section className="waveform-panel" aria-label="Waveform review">
      {hasAudio && (
        <div className="mix-strip">
          <div>
            <p className="eyebrow">Stereo Mix</p>
            <h2>{trackTitle || "Uploaded audio review pass"}</h2>
          </div>
          <span className="selected-time">{formatTimecode(selectedTime)}</span>
        </div>
      )}

      {timelineLabels.length > 0 && (
        <div className="timeline">
          {timelineLabels.map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
      )}

        <div
          ref={waveformStageRef}
          className="waveform-stage"
          style={{ position: "relative", minHeight: "80px" }}
          onClickCapture={(event) => {
            if (!isReviewerMode || !isMarkerToolActive || !isMobileViewport()) return;
            if (event.target.closest(".wave-marker") || isLoading || loadError || duration <= 0) return;
            const metrics = getWaveformMetrics(containerRef.current);
            if (!metrics.width) return;
            event.stopPropagation();
            const ratio = Math.min(1, Math.max(0, (event.clientX - metrics.left) / (metrics.width * zoomScaleRef.current)));
            callbacksRef.current.onMobileNoteRequest?.(ratio * duration);
            setIsMarkerToolActive(false);
          }}
          onClick={handleWaveformClick}
        >
          {/* ── Zoom wrapper ─────────────────────────────────────────────────────
              translateX pans the canvas and marker layer together (same GPU
              composite frame).  scaleX is NOT applied here — the waveform canvas
              is redrawn natively at the correct resolution via wavesurfer.zoom()
              so peaks are always sharp.  The marker layer receives its own
              scaleX(N) written directly on markerLayerRef in the same RAF, keeping
              pins locked to their audio positions without a React re-render.
              willChange: transform promotes to its own GPU layer so pinch updates
              bypass React's commit phase entirely.                               */}
          <div
            ref={zoomWrapperRef}
            style={{
              position: "absolute",
              inset: 0,
              transformOrigin: "left center",
              willChange: "transform",
            }}
          >
            {/* Canvas — WaveSurfer mounts here */}
            <div
              ref={containerRef}
              className="waveform"
              onTouchStart={(event) => {
                if (event.touches.length > 1) return; // 2-finger pinch → stage listener
                // Record the initial touch position so we can determine gesture
                // direction on the first significant movement in onTouchMove.
                const t = event.touches[0];
                if (t) {
                  touchStartRef.current = { x: t.clientX, y: t.clientY };
                  gestureAxisRef.current = null; // reset — axis unknown until first move
                }
              }}
              onTouchMove={(event) => {
                if (event.touches.length > 1) return; // 2-finger pinch → stage listener
                const touch = event.changedTouches?.[0];
                if (!touch || !containerRef.current || !duration) return;

                const start = touchStartRef.current;
                if (!start) return;

                // ── Axis-lock: decide once, commit for the rest of the gesture ──
                // Require at least 6px of movement before committing so a stationary
                // press never accidentally locks to either axis.
                if (!gestureAxisRef.current) {
                  const dx = Math.abs(touch.clientX - start.x);
                  const dy = Math.abs(touch.clientY - start.y);
                  if (dx < 6 && dy < 6) return; // not enough movement yet
                  gestureAxisRef.current = dx >= dy ? 'h' : 'v';
                }

                // Vertical gesture → let the browser's native pan-y scroll take over.
                if (gestureAxisRef.current === 'v') return;

                // Horizontal gesture → scrub the playhead.
                // With WaveSurfer native zoom the wrapper carries only translateX —
                // no CSS scaleX — so getBoundingClientRect().width is the layout
                // width (stageWidth), not the zoomed canvas width. Multiply by the
                // current zoom scale to convert screen pixels into canvas coordinates.
                const rect = containerRef.current.getBoundingClientRect();
                const ratio = Math.min(
                  1,
                  Math.max(0, (touch.clientX - rect.left) / (rect.width * zoomScaleRef.current))
                );
                seekToTime(ratio * duration);
              }}
              onTouchEnd={() => {
                // Clear gesture state so the next touch starts fresh.
                touchStartRef.current = null;
                gestureAxisRef.current = null;
              }}
              onTouchCancel={() => {
                touchStartRef.current = null;
                gestureAxisRef.current = null;
              }}
            />

            {/* Markers live inside the zoom wrapper — scaleX written directly on
                markerLayerRef in the same RAF frame as wavesurfer.zoom() so pins
                stay locked to their audio positions at every zoom level.
                transformOrigin: left center keeps the scale anchored at time=0,
                matching the canvas origin set by transform-origin on the wrapper. */}
            {duration > 0 && (
              <div
                className="marker-layer"
                ref={markerLayerRef}
                style={{ transformOrigin: 'left center' }}
              >
                {markerItems.map((comment) => (
                  <button
                    type="button"
                    className={`wave-marker${comment.resolved ? " resolved" : ""}${
                      comment.id === selectedCommentId ? " selected" : ""
                    }${comment.isPreview ? " preview" : ""}`}
                    key={comment.id}
                    data-time={formatTimecode(comment.time)}
                    style={{ left: comment.left }}
                    aria-label={`Go to comment at ${formatTimecode(comment.time)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!comment || comment.isPreview) return;
                      if (!isMobileViewport()) seekToTime(comment.time);
                      onMarkerSelect?.(comment, { autoplay: !isMobileViewport() });
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Loading / error overlays — outside zoom wrapper so they stay full-width */}
          {hasAudio && isLoading && (
            <div
              className="loading-waveform"
              style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
            >
              Preparing waveform
            </div>
          )}
          {hasAudio && loadError && (
            <div
              className="waveform-error"
              style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
            >
              {loadError}
            </div>
          )}

          {/* Mobile "Tap to Listen" overlay — outside zoom wrapper, bypasses iOS/Android autoplay block */}
          {hasAudio && isMobileViewport() && !mobilePlayUnlocked && (
            <button
              type="button"
              className="tap-to-listen"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 10,
                background: "rgba(0, 0, 0, 0.50)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                border: "none",
                cursor: "pointer",
                color: "#f5efe3",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onMobileTapPlay?.();
              }}
            >
              <span style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden="true">▶</span>
              <span style={{ fontSize: "0.85rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Tap to Listen
              </span>
            </button>
          )}
        </div>

      {(duration > 0 || (isReviewerMode && isMobileViewport())) && (
        <div className="review-console">
          {pendingMarker ? (
            <div className="desktop-comment-box">
              <div className="desktop-comment-box-header">
                <div>
                  <p className="eyebrow">New marker</p>
                  <span className="selected-time" style={{ display: "inline-block" }}>
                    {formatTimecode(pendingMarker.time)}
                  </span>
                </div>
                <button
                  type="button"
                  className="desktop-comment-cancel"
                  aria-label="Cancel"
                  onClick={() => setPendingMarker(null)}
                >
                  Cancel
                </button>
              </div>
              <textarea
                className="desktop-comment-textarea"
                placeholder="Add a note for this timestamp…"
                value={pendingMarker.text}
                rows={3}
                autoFocus
                onChange={(e) =>
                  setPendingMarker((p) => p ? { ...p, text: e.target.value } : p)
                }
              />
              <div className="desktop-comment-actions">
                <button
                  type="button"
                  className="desktop-comment-save"
                  onClick={() => {
                    callbacksRef.current.onTimestampCreate(pendingMarker.time, pendingMarker.text);
                    setPendingMarker(null);
                  }}
                >
                  Save Note
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={`marker-tool-toggle${isMarkerToolActive ? " active" : ""}`}
                aria-pressed={isMarkerToolActive}
                aria-label="Toggle review mode"
                onClick={() => setIsMarkerToolActive((c) => !c)}
              >
                <span aria-hidden="true">✍️</span>
                <span className="tool-label">Review</span>
              </button>
              {isMarkerToolActive && (
                <span className="marker-tool-hint">Click the waveform to place a marker</span>
              )}
            </>
          )}
        </div>
      )}

    </section>
  );
}


function isMobileViewport() {
  // Matches the CSS breakpoint: portrait phones (width ≤ 768px) OR
  // landscape phones (height ≤ 500px in landscape — excludes iPads).
  return (
    window.matchMedia?.("(max-width: 768px)")?.matches ||
    window.innerWidth <= 768 ||
    (window.matchMedia?.("(orientation: landscape) and (max-height: 500px)")?.matches ?? false)
  );
}

function getWaveformMetrics(element) {
  if (!element) {
    return { left: 0, width: 0 };
  }

  const bounds = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const width = Math.max(0, bounds.width - paddingLeft - paddingRight);

  return {
    left: bounds.left + paddingLeft,
    width
  };
}

function getTimelineLabels(duration) {
  const safeDuration = duration > 0 ? duration : 45;
  return [0, 0.33, 0.66, 1].map((position) =>
    formatTimecode(safeDuration * position).replace(/\.\d$/, ""),
  );
}
