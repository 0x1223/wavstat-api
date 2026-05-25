import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, getPrimaryElement, mountMobileEngine } from "../lib/mobileAudioEngine.js";

// ── Mobile spectrum analyzer ─────────────────────────────────────────────
const _SPEC_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10_000, 12_500, 16_000, 20_000,
];
const _SPEC_N = _SPEC_CENTERS.length; // 30
const _SPEC_LABELS = [
  [1, "31"], [4, "63"], [7, "125"], [10, "250"], [13, "500"],
  [16, "1k"], [19, "2k"], [22, "4k"], [25, "8k"], [28, "16kHz"],
];
// 6-stop gradient: Blue → Cyan → Green → Yellow-Green → Yellow → Orange (no red)
const _SPEC_STOPS = [
  { h: 212, s: 80,  l: 42 }, // #1565C0 blue
  { h: 187, s: 100, l: 42 }, // #00BCD4 cyan
  { h: 122, s: 39,  l: 49 }, // #4CAF50 green
  { h: 88,  s: 50,  l: 53 }, // #8BC34A yellow-green
  { h: 54,  s: 100, l: 62 }, // #FFEB3B yellow
  { h: 36,  s: 100, l: 50 }, // #FF9800 orange
];

function spectrumBandColor(i, amp) {
  const t = i / (_SPEC_N - 1);
  const seg = Math.min(_SPEC_STOPS.length - 2, Math.floor(t * (_SPEC_STOPS.length - 1)));
  const frac = t * (_SPEC_STOPS.length - 1) - seg;
  const a = _SPEC_STOPS[seg], b = _SPEC_STOPS[seg + 1];
  const hue = (a.h + frac * (b.h - a.h)) | 0;
  const sat = (a.s + frac * (b.s - a.s)) | 0;
  const baseL = a.l + frac * (b.l - a.l);
  const lit = (28 + amp * Math.max(0, baseL - 28)) | 0;
  return `hsl(${hue},${sat}%,${lit}%)`;
}

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
  ref={containerRef}
  className="waveform"
  onTouchMove={(event) => {
    const touch = event.changedTouches?.[0];
    if (!touch || !containerRef.current || !duration) return;

    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (touch.clientX - rect.left) / rect.width)
    );

    const nextTime = ratio * duration;

    seekToTime(nextTime);
  }}
/>
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

      {isMobileViewport() && hasAudio && (
        <div className="mobile-spectrum-container">
          <MobileSpectrumStrip
            key={audioSource?.playbackUrl || audioSource?.url}
            wsRef={wavesurferRef}
          />
        </div>
      )}

    </section>
  );
}

// ── MobileSpectrumStrip ───────────────────────────────────────────────────────
// Position-based synthetic spectrum. Reads primaryAudio.currentTime each rAF
// tick and drives 30 frequency bars with per-band sinusoidal modulation.
// Zero Web Audio API involvement — no AnalyserNode, no createMediaElementSource,
// no connections to the <audio> element — nothing that can interfere with
// native playback or iOS lock-screen audio.
//
// When playing  → bars animate, driven by currentTime so seeking changes phase.
// When paused   → bars freeze at their last amplitude then decay to a floor.
// When hidden   → rAF cancelled immediately; restarts cleanly on show.
function MobileSpectrumStrip({ wsRef: _wsRef }) {  // wsRef kept for call-site compat
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let rafId = null;

    // ── Frozen horizontal grid ─────────────────────────────────────────────
    // Column x-positions and bar pixel width are computed ONCE per resize and
    // stored here. The draw loop reads only from these arrays — no per-frame
    // division, no float rounding, nothing time-dependent can affect X coords.
    let barPx   = 1;            // integer pixel width of each bar
    let colX    = new Int32Array(_SPEC_N);  // left edge of each column, pixels
    let labelX  = new Float32Array(_SPEC_N); // centre of each column for labels
    let canvasH = canvas.height || 80;

    function buildGrid(w) {
      // Integer slot width, gap of 1px between bars.
      const slot = Math.max(2, (w / _SPEC_N) | 0);
      barPx = Math.max(1, slot - 1);
      const gutter = ((slot - barPx) / 2) | 0; // left padding within slot
      for (let i = 0; i < _SPEC_N; i++) {
        colX[i]   = i * slot + gutter;
        labelX[i] = i * slot + slot / 2;
      }
    }

    // ── Per-band state ─────────────────────────────────────────────────────
    // displayed[i]: current rendered amplitude [0,1].
    // Lerped toward the target each frame for smooth attack and decay.
    const displayed = new Float32Array(_SPEC_N).fill(0);

    // ── Vertical amplitude — pure time + band index, no cross-column terms ─
    // scale = 0.1 + 0.9 × |sin(t × 11.5 + i × 4.7)|
    //   → range [0.1, 1.0] per band, fully independent across columns.
    //   → no cos(), no shared wobble that could bleed into neighbour bars.
    // Analyzer slope: bass cols reach 90% max, treble cols 40% max.
    //   maxScale = 0.9 − norm × 0.5   (norm = i / 29, 0..1)
    function targetAmp(i, t) {
      const norm     = i / (_SPEC_N - 1);
      const scale    = 0.1 + 0.9 * Math.abs(Math.sin(t * 11.5 + i * 4.7));
      const maxScale = 0.9 - norm * 0.5;  // 0.90 (bass) → 0.40 (treble)
      return scale * maxScale;
    }

    // ── Drawing ────────────────────────────────────────────────────────────
    function paint(t, playing) {
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const W = canvas.width;
      const H = canvasH;
      ctx2d.clearRect(0, 0, W, H);

      for (let i = 0; i < _SPEC_N; i++) {
        if (playing) {
          const tgt = targetAmp(i, t);
          // Fast attack (lerp 55% of gap per frame), slow decay (12% drop).
          // Mimics professional LED bar meters: bars jump up quickly and
          // fall down gradually, giving the "bouncing" mechanical feel.
          if (tgt > displayed[i]) {
            displayed[i] += (tgt - displayed[i]) * 0.55;
          } else {
            displayed[i] *= 0.88;
          }
        } else {
          // Paused: smooth decay to absolute zero.
          displayed[i] *= 0.88;
          if (displayed[i] < 0.004) displayed[i] = 0;
        }

        const amp = displayed[i];
        ctx2d.fillStyle = spectrumBandColor(i, amp);
        // X is read from the pre-built frozen grid — never computed here.
        const h = Math.max(1, (amp * H) | 0);
        ctx2d.fillRect(colX[i], H - h, barPx, h);
      }

      // Frequency labels — x coords also from frozen grid.
      ctx2d.save();
      ctx2d.font = "bold 8px monospace";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.shadowColor = "rgba(0,0,0,0.65)";
      ctx2d.shadowBlur = 2;
      ctx2d.fillStyle = "#ffffff";
      for (const [i, label] of _SPEC_LABELS) {
        ctx2d.fillText(label, labelX[i], 2);
      }
      ctx2d.restore();
    }

    // ── RAF loop ──────────────────────────────────────────────────────────
    function tick() {
      if (!alive || document.hidden) { rafId = null; return; }
      const el      = getPrimaryElement();
      const t       = el?.currentTime ?? 0;
      const playing = Boolean(el && !el.paused && !el.ended);
      paint(t, playing);
      rafId = requestAnimationFrame(tick);
    }

    function startRaf() {
      if (rafId == null && alive && !document.hidden) {
        rafId = requestAnimationFrame(tick);
      }
    }
    function stopRaf() {
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    // ── Visibility handling ───────────────────────────────────────────────
    function onVisibilityChange() {
      if (!alive) return;
      if (document.hidden) stopRaf();
      else startRaf();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    // ── Canvas sizing ─────────────────────────────────────────────────────
    // Rebuild the frozen grid whenever the container width changes.
    // Setting canvas.width clears the bitmap — that is expected and harmless.
    function applyWidth(w) {
      if (w > 0 && canvas.width !== w) {
        canvas.width = w;
        buildGrid(w);
      }
    }
    const ro = new ResizeObserver(() => {
      if (!canvas) return;
      applyWidth(canvas.getBoundingClientRect().width | 0);
    });
    ro.observe(canvas);
    const initW = canvas.getBoundingClientRect().width | 0;
    applyWidth(initW || 300); // safe fallback if layout hasn't settled yet

    // Start immediately — no polling, no analyser to wait for.
    startRaf();

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopRaf();
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="mobile-spectrum-canvas"
      width="300"
      height="80"
      style={{ display: "block", width: "100%", height: "80px", borderRadius: "3px" }}
      aria-hidden="true"
    />
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
