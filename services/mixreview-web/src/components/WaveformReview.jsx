import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, mountMobileEngine } from "../lib/mobileAudioEngine.js";


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
  // Mobile first-play helpers.
  // onMobileTapPlay — callback invoked when the "Tap to Listen" overlay is pressed;
  //   caller is responsible for unlocking the audio session and starting playback.
  // mobilePlayUnlocked — when true the overlay is hidden (user has already played once).
  onMobileTapPlay = undefined,
  mobilePlayUnlocked = false,
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

    // ── HLS peak bypass ─────────────────────────────────────────────────────
    // HLS streams (.m3u8) must never be decoded on the frontend. WaveSurfer's
    // default path (fetch → decodeAudioData) downloads every segment into an
    // ArrayBuffer and runs WebAudio decoding, causing severe lag on Android
    // and crashes on old iOS/WebKit where decodeAudioData rejects HLS.
    //
    // When isHLSStream: supply peaks directly to WaveSurfer so it renders
    // immediately and skips all fetch+decodeAudioData work. The <audio>
    // element is still created from the URL for normal playback — only the
    // peak extraction path is bypassed.
    //
    // Plain JS arrays throughout — no Float32Array/typed-array construction —
    // to avoid Safari/Android WebView compatibility issues.
    const isHLSStream = /\.m3u8(\?|$)/i.test(playbackUrl ?? "");
    const staticCurve = [0.15, 0.2, 0.35, 0.5, 0.65, 0.75, 0.8, 0.72, 0.6, 0.45, 0.35, 0.4, 0.55, 0.7, 0.85, 0.9, 0.82, 0.68, 0.5, 0.3, 0.2, 0.15];
    const precalcPeaks = isHLSStream
      ? [Array.from({ length: 300 }, (_, i) => staticCurve[i % staticCurve.length])]
      : undefined;

    // Defer DOM binding past first paint — same frame budget for initial load
    // and all subsequent manual track switches.
    const rafId = requestAnimationFrame(() => {
      if (isDisposed || !containerRef.current) return;

      console.log("[WaveformReview] Desktop decode start", {
        url: playbackUrl.slice(0, 120),
        ext,
        fileSize,
        hlsBypass: isHLSStream,
        peaksSource: isHLSStream
          ? (audioSource?.peaks ? "backend" : "static-fallback")
          : "wavesurfer-decode",
      });

      // containerRef, height (180), and fillParent are intentionally fixed —
      // do not alter them; the waveform canvas must not shift or resize.
      wavesurfer = WaveSurfer.create({
        container: containerRef.current,
        url: playbackUrl,
        // HLS only: pre-calculated peaks suppress fetch+decodeAudioData entirely.
        // Direct audio files (WAV/MP3/FLAC/etc.): omit so WaveSurfer decodes real peaks.
        ...(precalcPeaks && { peaks: precalcPeaks }),
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
  }, [audioSource?.playbackUrl, audioSource?.url]);

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
  style={{ position: "relative" }}
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

  {/* Canvas container always renders first so the layout height is reserved */}
  <div
    ref={containerRef}
    className="waveform"
    style={{ minHeight: 180 }}
    onTouchMove={(event) => {
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

  {/* Loading / error overlays sit on top of the canvas, never push it down */}
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

  {/* Mobile "Tap to Listen" overlay — bypasses iOS/Android autoplay block */}
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

        {duration > 0 && (
          <div className="marker-layer">
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
