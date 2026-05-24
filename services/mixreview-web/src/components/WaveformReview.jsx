import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, getSharedAudioContext, mountMobileEngine } from "../lib/mobileAudioEngine.js";

// ── Inline mobile spectrum analyzer constants ─────────────────────────────────
// ISO 1/3-octave center frequencies (Hz), 30 bands covering 25 Hz – 20 kHz.
const _SPEC_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10_000, 12_500, 16_000, 20_000,
];
const _SPEC_N = _SPEC_CENTERS.length; // 30
const _SPEC_FFT = 4096;
const _SPEC_HALF_BW = Math.pow(2, 1 / 6); // 1/3-octave half-bandwidth factor
// [band index, label] pairs rendered along the top of the canvas.
const _SPEC_LABELS = [
  [1, "31"], [4, "63"], [7, "125"], [10, "250"], [13, "500"],
  [16, "1k"], [19, "2k"], [22, "4k"], [25, "8k"], [28, "16kHz"],
];
// Module-level: reuse the MediaElementAudioSourceNode across track switches.
// An <audio> element can only have one source node per AudioContext;
// createMediaElementSource throws InvalidStateError if called again for the
// same element. We check .mediaElement identity before deciding to create one.
let _spectrumSrc = null;

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
// Renders a real-time 1/3-octave FFT spectrum on a <canvas>.
// Uses getSharedAudioContext() from the engine — never creates its own context.
// Taps audio passively via a MediaElementAudioSourceNode connected to the
// shared context destination; the analyser is a parallel branch, not in series.
// Re-mounts cleanly on track switch (key prop drives unmount/remount).
function MobileSpectrumStrip({ wsRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let rafId = null;
    let isAnimating = false;
    let analyser = null;
    let freqData = null;
    let decayBuf = null;
    let audioCtx = null;
    let detachWs = null;

    // ── Drawing ──────────────────────────────────────────────────────────
    function paint(dataOverride) {
      if (!canvas || !analyser || !freqData || !audioCtx) return;
      let data;
      if (dataOverride) {
        data = dataOverride;
      } else {
        analyser.getByteFrequencyData(freqData);
        if (decayBuf) for (let i = 0; i < freqData.length; i++) decayBuf[i] = freqData[i];
        data = freqData;
      }

      const ctx2d = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx2d.clearRect(0, 0, W, H);

      const slotW = W / _SPEC_N;
      const barW = Math.max(1, slotW - 1);
      const binHz = audioCtx.sampleRate / _SPEC_FFT;
      const M = data.length;

      for (let i = 0; i < _SPEC_N; i++) {
        const fc = _SPEC_CENTERS[i];
        const bLo = Math.max(0, Math.floor((fc / _SPEC_HALF_BW) / binHz));
        const bHi = Math.min(M - 1, Math.ceil((fc * _SPEC_HALF_BW) / binHz));
        let peak = 0;
        for (let b = bLo; b <= bHi; b++) if (data[b] > peak) peak = data[b];

        const amp = peak / 255;
        // Gradient: blue (240°) for bass → teal/green mids → yellow (60°) for highs
        const hue = (240 - (i / (_SPEC_N - 1)) * 180) | 0;
        const lit = (28 + amp * 42) | 0;
        ctx2d.fillStyle = `hsl(${hue},88%,${lit}%)`;
        const x = (i * slotW + (slotW - barW) / 2) | 0;
        const h = Math.max(2, (amp * H) | 0);
        ctx2d.fillRect(x, H - h, barW, h);
      }

      // Frequency labels along the top edge
      ctx2d.save();
      ctx2d.font = "bold 8px monospace";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.shadowColor = "rgba(0,0,0,0.65)";
      ctx2d.shadowBlur = 2;
      ctx2d.fillStyle = "#fff";
      for (const [i, label] of _SPEC_LABELS) {
        ctx2d.fillText(label, (i + 0.5) * slotW, 2);
      }
      ctx2d.restore();
    }

    // ── Animation loop ────────────────────────────────────────────────────
    function tick() {
      if (!alive || !isAnimating) return;
      paint();
      rafId = requestAnimationFrame(tick);
    }

    // Decay tail: fades bars to black after audio stops, ~0.82× per frame.
    function decayTick() {
      if (!alive || isAnimating || !decayBuf) return;
      let anyActive = false;
      for (let i = 0; i < decayBuf.length; i++) {
        decayBuf[i] *= 0.82;
        if (decayBuf[i] > 0.5) anyActive = true;
      }
      paint(decayBuf);
      rafId = anyActive ? requestAnimationFrame(decayTick) : null;
    }

    function startAnim() {
      isAnimating = true;
      if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
      if (rafId == null) tick();
    }

    function stopAnim() {
      isAnimating = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      decayTick();
    }

    // ── Audio graph setup ─────────────────────────────────────────────────
    // Connects the shared AudioContext's media element to an AnalyserNode.
    // Uses _spectrumSrc (module-level) to reuse an existing source node rather
    // than calling createMediaElementSource again for the same element.
    function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;

      audioCtx = getSharedAudioContext();
      if (!audioCtx || audioCtx.state === "closed") return false;

      try {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = _SPEC_FFT;
        analyser.smoothingTimeConstant = 0.78;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        decayBuf = new Float32Array(analyser.frequencyBinCount);

        if (_spectrumSrc && _spectrumSrc.mediaElement === mediaEl) {
          // Same element already routed through Web Audio — just add the analyser tap.
          _spectrumSrc.connect(analyser);
        } else {
          // New (or first) element: route it through the shared context.
          // src → destination  keeps audio playing.
          // src → analyser     is the passive visualization tap.
          const src = audioCtx.createMediaElementSource(mediaEl);
          src.connect(audioCtx.destination);
          src.connect(analyser);
          _spectrumSrc = src;
        }
      } catch (e) {
        console.warn("[MobileSpectrum] connect failed:", e.message);
        try { analyser?.disconnect(); } catch (_) {}
        analyser = null; freqData = null; decayBuf = null;
        return false;
      }

      // Mirror WaveSurfer play/pause events into the animation loop.
      function onPlay()  { if (alive) startAnim(); }
      function onStop()  { stopAnim(); }
      ws.on("play",   onPlay);
      ws.on("pause",  onStop);
      ws.on("finish", onStop);
      detachWs = () => {
        try { ws.un("play", onPlay); ws.un("pause", onStop); ws.un("finish", onStop); }
        catch (_) {}
      };

      if (ws.isPlaying?.()) startAnim();
      else paint(); // silent initial frame so the canvas isn't blank
      return true;
    }

    // ── Visibility gating ─────────────────────────────────────────────────
    // Pause the RAF loop when hidden (saves battery); resume when visible.
    // The audio graph stays connected — only the canvas animation stops.
    function onVisibilityChange() {
      if (!alive) return;
      if (document.hidden) {
        isAnimating = false;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      } else {
        if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
        const ws = wsRef.current;
        if (ws?.isPlaying?.()) startAnim();
        else if (analyser && freqData) paint();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    // ── Canvas pixel sizing ───────────────────────────────────────────────
    // Keep canvas.width in sync with its CSS display width so bars stay sharp.
    const ro = new ResizeObserver(() => {
      if (!canvas) return;
      const w = canvas.getBoundingClientRect().width | 0;
      if (w > 0 && canvas.width !== w) {
        canvas.width = w;
        if (!isAnimating) paint();
      }
    });
    ro.observe(canvas);
    const initW = canvas.getBoundingClientRect().width | 0;
    if (initW > 0) canvas.width = initW;

    // ── Cleanup ───────────────────────────────────────────────────────────
    function cleanup() {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (rafId != null) cancelAnimationFrame(rafId);
      detachWs?.();
      // Remove only the analyser tap. Keep _spectrumSrc → destination connected
      // so audio continues flowing through the Web Audio graph after unmount.
      try { _spectrumSrc?.disconnect(analyser); } catch (_) {}
      try { analyser?.disconnect(); } catch (_) {}
      analyser = null; freqData = null; decayBuf = null;
      ro.disconnect();
    }

    // Poll until the engine and media element are ready (handles the brief
    // window between key-driven remount and the parent wiring up wsRef).
    if (!tryConnect()) {
      const iv = setInterval(() => { if (!alive || tryConnect()) clearInterval(iv); }, 80);
      return () => { clearInterval(iv); cleanup(); };
    }
    return cleanup;
  }, [wsRef]);

  return (
    <canvas
      ref={canvasRef}
      className="mobile-spectrum-canvas"
      width="300"
      height="84"
      style={{ display: "block", width: "100%", height: "84px", borderRadius: "3px" }}
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
