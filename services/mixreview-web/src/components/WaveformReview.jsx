import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, mountMobileEngine } from "../lib/mobileAudioEngine.js";
import { MobileSpectrumAnalyzer } from "./MobileSpectrumAnalyzer.jsx";

export function WaveformReview({
  audioSource,
  comments,
  selectedCommentId,
  selectedTime,
  previewMarkerTime = null,
  trackTitle,
  onTimestampCreate,
  onMarkerSelect,
  onReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
  isReviewerMode = false,
  onMobileNoteRequest,
  onMeterUpdate
}) {
  const containerRef = useRef(null);
  const wavesurferRef = useRef(null);
  const callbacksRef = useRef({
    onDurationChange,
    onPlaybackChange,
    onReady,
    onTimeUpdate,
    onTimestampCreate,
    onMobileNoteRequest,
    onMeterUpdate
  });
  const [duration, setDuration] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isMarkerToolActive, setIsMarkerToolActive] = useState(false);
  const [pendingMarker, setPendingMarker] = useState(null);
  // Mobile-only: which marker's text bubble is currently expanded (tap-to-reveal)
  const [activeBubbleId, setActiveBubbleId] = useState(null);
  const meterThrottleRef = useRef(0);
  const meterBufRef = useRef(null);

  // ── Mobile pinch-to-zoom ────────────────────────────────────────────────
  // State drives the render; refs give synchronous access inside passive-false
  // touch listeners (closures capture the ref, not stale state values).
  const [zoomScale, setZoomScale] = useState(1.0);
  const [zoomScrollX, setZoomScrollX] = useState(0);
  const zoomScaleRef = useRef(1.0);
  const zoomScrollXRef = useRef(0);
  const gestureRef = useRef(null); // tracks active pinch or pan gesture
  const zoomInnerRef = useRef(null); // the zoom-transform wrapper div

  // Called on every animation frame tick from MobileSpectrumAnalyzer's RAF loop.
  // Reads time-domain data from the already-running analyser — no new audio graph nodes.
  const handleMeterFrame = useCallback((analyser) => {
    try {
      if (!analyser) return;
      const now = performance.now();
      if (now - meterThrottleRef.current < 100) return; // ~10 fps
      meterThrottleRef.current = now;
      const bufLen = analyser.fftSize;
      if (!meterBufRef.current || meterBufRef.current.length !== bufLen) {
        meterBufRef.current = new Float32Array(bufLen);
      }
      analyser.getFloatTimeDomainData(meterBufRef.current);
      const buf = meterBufRef.current;
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const abs = Math.abs(buf[i]);
        sum += buf[i] * buf[i];
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sum / buf.length);
      const lufsVal = rms > 1e-9 ? (20 * Math.log10(rms)).toFixed(1) : "–";
      const tpVal = peak > 1e-9 ? (20 * Math.log10(peak)).toFixed(1) : "–";
      callbacksRef.current.onMeterUpdate?.({ lufs: lufsVal, lra: "–", tp: tpVal });
    } catch (_) {}
  }, []);

  // Keep refs in sync so touch-listener closures always read current values.
  zoomScaleRef.current = zoomScale;
  zoomScrollXRef.current = zoomScrollX;

  useEffect(() => {
    callbacksRef.current = {
      onDurationChange,
      onPlaybackChange,
      onReady,
      onTimeUpdate,
      onTimestampCreate,
      onMobileNoteRequest,
      onMeterUpdate
    };
  }, [onDurationChange, onMobileNoteRequest, onMeterUpdate, onPlaybackChange, onReady, onTimeUpdate, onTimestampCreate]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    // Reset zoom whenever audio source changes.
    setZoomScale(1.0);
    setZoomScrollX(0);
    zoomScaleRef.current = 1.0;
    zoomScrollXRef.current = 0;

    setIsLoading(true);
    setLoadError("");
    setDuration(0);
    setWaveformWidth(getWaveformMetrics(containerRef.current).width);
    callbacksRef.current.onReady(null);
    callbacksRef.current.onTimeUpdate(0);
    callbacksRef.current.onDurationChange(0);
    callbacksRef.current.onPlaybackChange(false);

    const playbackUrl = audioSource?.playbackUrl || audioSource?.url;

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
      });
      wavesurferRef.current = ws;
      return () => {
        if (wavesurferRef.current === ws) wavesurferRef.current = null;
        resizeObserver.disconnect();
        disposeMobileEngine();
      };
    }

    // Desktop: inline WaveSurfer instance
    let isDisposed = false;
    let hasLoaded = false;
    console.log("[WaveformReview] Desktop decode start", {
      url: playbackUrl.slice(0, 120),
      ext,
      fileSize,
    });
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      url: playbackUrl,
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
      fillParent: true
    });

    wavesurferRef.current = wavesurfer;

    // ── Desktop decode timeout ──────────────────────────────────────────
    // If WaveSurfer's fetch or decodeAudioData stalls, surface a clear message
    // rather than leaving the UI stuck on "Preparing waveform" forever.
    const DESKTOP_TIMEOUT_MS = 20_000;
    const decodeTimeout = setTimeout(() => {
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
      if (isDisposed) {
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
      if (isDisposed || hasLoaded) {
        return;
      }

      hasLoaded = true;
      clearTimeout(decodeTimeout);
      console.warn("[WaveformReview] Desktop decode failure", error?.message ?? String(error));
      setIsLoading(false);
      setLoadError("This audio file could not be decoded. Try a WAV or MP3 file.");
      callbacksRef.current.onReady(null);
      callbacksRef.current.onDurationChange(0);
      callbacksRef.current.onPlaybackChange(false);
    });

    wavesurfer.on("timeupdate", (time) => {
      if (!isDisposed) {
        callbacksRef.current.onTimeUpdate(time);
      }
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

    return () => {
      isDisposed = true;
      clearTimeout(decodeTimeout);
      if (wavesurferRef.current === wavesurfer) {
        wavesurferRef.current = null;
      }
      wavesurfer.destroy();
      resizeObserver.disconnect();
    };
  }, [audioSource?.playbackUrl, audioSource?.url]);

  // ── Pinch-to-zoom touch listeners (mobile only) ─────────────────────────
  // Registered with passive:false so e.preventDefault() actually works.
  // Reads state only through refs so the closure never goes stale.
  useEffect(() => {
    const el = zoomInnerRef.current;
    if (!el || !isMobileViewport()) return;

    function dist2(touches) {
      return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
      );
    }

    // Natural (un-zoomed) width of the waveform canvas area, in px.
    function outerW() {
      if (!containerRef.current) return 1;
      return containerRef.current.getBoundingClientRect().width /
        Math.max(1, zoomScaleRef.current);
    }

    function onTouchStart(e) {
      if (e.touches.length === 2) {
        gestureRef.current = {
          mode: "pinch",
          startDist: dist2(e.touches),
          startScale: zoomScaleRef.current,
          startScrollX: zoomScrollXRef.current,
          outerW: outerW(),
        };
        e.preventDefault();
      } else if (e.touches.length === 1 && zoomScaleRef.current > 1) {
        gestureRef.current = {
          mode: "pan",
          startX: e.touches[0].clientX,
          startScrollX: zoomScrollXRef.current,
          outerW: outerW(),
        };
      } else {
        gestureRef.current = null;
      }
    }

    function onTouchMove(e) {
      const g = gestureRef.current;
      if (!g) return;

      if (g.mode === "pinch" && e.touches.length === 2) {
        const newDist = dist2(e.touches);
        const ratio = g.startDist > 0 ? newDist / g.startDist : 1;
        const newScale = Math.min(8, Math.max(1, g.startScale * ratio));

        // Preserve proportional scroll position as scale changes.
        const oldMax = g.outerW * Math.max(0, g.startScale - 1);
        const newMax = g.outerW * Math.max(0, newScale - 1);
        const pct = oldMax > 0 ? g.startScrollX / oldMax : 0;
        const newScrollX = Math.min(newMax, Math.max(0, pct * newMax));

        zoomScaleRef.current = newScale;
        zoomScrollXRef.current = newScrollX;
        setZoomScale(newScale);
        setZoomScrollX(newScrollX);
        e.preventDefault();
      } else if (g.mode === "pan" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - g.startX;
        const maxScroll = g.outerW * Math.max(0, zoomScaleRef.current - 1);
        const newScrollX = Math.min(maxScroll, Math.max(0, g.startScrollX - dx));
        zoomScrollXRef.current = newScrollX;
        setZoomScrollX(newScrollX);
        e.preventDefault();
      }
    }

    function onTouchEnd(e) {
      // Clear gesture state once fewer than 2 fingers remain.
      if (e.touches.length < 2) gestureRef.current = null;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []); // register once on mount; all state is accessed via refs

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

    const clickRatio = Math.min(1, Math.max(0, (event.clientX - metrics.left) / metrics.width));
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
  const hasAudio = Boolean(audioSource?.url);
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
  className="waveform-stage"
  onClickCapture={(event) => {
    if (!isReviewerMode || !isMarkerToolActive || !isMobileViewport()) return;
    if (event.target.closest(".wave-marker") || isLoading || loadError || duration <= 0) return;
    const metrics = getWaveformMetrics(containerRef.current);
    if (!metrics.width) return;
    event.stopPropagation();
    const ratio = Math.min(1, Math.max(0, (event.clientX - metrics.left) / metrics.width));
    callbacksRef.current.onMobileNoteRequest?.(ratio * duration);
    setIsMarkerToolActive(false);
  }}
  onClick={handleWaveformClick}>
  {hasAudio && isLoading && <div className="loading-waveform">Preparing waveform</div>}
  {hasAudio && loadError && <div className="waveform-error">{loadError}</div>}

  <div
    ref={zoomInnerRef}
    className="waveform-zoom-inner"
    style={isMobileViewport() ? {
      width: `${zoomScale * 100}%`,
      transform: zoomScrollX !== 0 ? `translateX(${-zoomScrollX}px)` : undefined,
      willChange: zoomScale > 1 ? "transform" : undefined,
    } : undefined}
  >
  <div
  ref={containerRef}
  className="waveform"
  onTouchMove={(event) => {
    if (gestureRef.current) return;
    const touch = event.changedTouches?.[0];
    if (!touch || !containerRef.current || !duration) return;

    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (touch.clientX - rect.left) / rect.width)
    );

    seekToTime(ratio * duration);
  }}
/>
        {duration > 0 && (
          <div className="marker-layer">
            {markerItems.map((comment) => {
              // Precompute bubble visibility and alignment once per marker.
              // Bubble only appears for real saved comments that have text,
              // in reviewer mode on mobile — never on preview/pending markers.
              const showBubble =
                isReviewerMode &&
                isMobileViewport() &&
                !comment.isPreview &&
                Boolean(comment.text);
              // Flip bubble to the left when the marker is in the right 38%
              // of the waveform, so the bubble stays inside the visible area.
              const bubbleAlign =
                showBubble && waveformWidth > 0 && parseFloat(comment.left) / waveformWidth > 0.62
                  ? "right"
                  : "left";
              const bubbleText =
                showBubble && comment.text.length > 30
                  ? `${comment.text.slice(0, 30).trimEnd()}…`
                  : comment.text;

              return (
                <button
                  type="button"
                  className={`wave-marker${comment.resolved ? " resolved" : ""}${
                    comment.id === selectedCommentId ? " selected" : ""
                  }${comment.isPreview ? " preview" : ""}`}
                  key={comment.id}
                  data-time={formatTimecode(comment.time)}
                  data-bubble-align={showBubble ? bubbleAlign : undefined}
                  data-bubble-active={showBubble && activeBubbleId === comment.id ? "true" : undefined}
                  style={{ left: comment.left }}
                  aria-label={`Go to comment at ${formatTimecode(comment.time)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!comment || comment.isPreview) return;
                    // Mobile: toggle the text bubble for this marker; desktop: seek
                    if (isMobileViewport() && isReviewerMode) {
                      setActiveBubbleId((prev) => (prev === comment.id ? null : comment.id));
                    } else {
                      seekToTime(comment.time);
                    }
                    onMarkerSelect?.(comment, { autoplay: !isMobileViewport() });
                  }}
                >
                  {showBubble && (
                    <span
                      className={`marker-bubble${comment.resolved ? " marker-bubble--resolved" : ""}`}
                      aria-hidden="true"
                    >
                      {bubbleText}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
  </div>
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

      {isReviewerMode && isMobileViewport() && duration > 0 && (
        <div className="mobile-spectrum-container">
          <MobileSpectrumAnalyzer
            key={audioSource?.playbackUrl || audioSource?.url}
            wsRef={wavesurferRef}
            onFrame={handleMeterFrame}
          />
        </div>
      )}
    </section>
  );
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 768px)")?.matches || window.innerWidth <= 768;
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
