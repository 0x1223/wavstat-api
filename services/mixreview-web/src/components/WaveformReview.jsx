import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";
import { disposeMobileEngine, getSharedAudioContext, mountMobileEngine } from "../lib/mobileAudioEngine.js";

// ── Mobile spectrum analyzer ─────────────────────────────────────────────
const _SPEC_CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10_000, 12_500, 16_000, 20_000,
];
const _SPEC_N = _SPEC_CENTERS.length; // 30
const _SPEC_FFT = 4096;
const _SPEC_HALF_BW = Math.pow(2, 1 / 6);
const _SPEC_LABELS = [
  [1, "31"], [4, "63"], [7, "125"], [10, "250"], [13, "500"],
  [16, "1k"], [19, "2k"], [22, "4k"], [25, "8k"], [28, "16kHz"],
];
// 6-stop gradient: blue → cyan → green → yellow-green → yellow → orange (no red)
const _SPEC_STOPS = [
  { h: 212, s: 80,  l: 42 }, // blue
  { h: 187, s: 100, l: 42 }, // cyan
  { h: 122, s: 39,  l: 49 }, // green
  { h: 88,  s: 50,  l: 53 }, // yellow-green
  { h: 54,  s: 100, l: 62 }, // yellow
  { h: 36,  s: 100, l: 50 }, // orange
];
// Module-level guard: an <audio> element can only have one MediaElementAudioSourceNode
// per AudioContext. _spectrumSrc persists across React renders and track switches.
let _spectrumSrc = null;

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

function MobileSpectrumStrip({ wsRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let rafId = null;
    let isAnimating = false;
    let lastDrawTime = null;
    let analyser = null;
    let freqData = null;
    let decayBuf = null;
    let audioCtx = null;
    let detachWs = null;

    // ── Drawing ────────────────────────────────────────────────────────────
    function paint(dataOverride = null) {
      if (!canvas || !analyser || !freqData || !audioCtx) return;

      let data;
      if (dataOverride) {
        data = dataOverride;
      } else {
        analyser.getByteFrequencyData(freqData);
        if (decayBuf) {
          for (let i = 0; i < freqData.length; i++) decayBuf[i] = freqData[i];
        }
        data = freqData;
      }

      const ctx2d = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx2d.clearRect(0, 0, W, H);

      const slotW = W / _SPEC_N;
      const barW = Math.max(1, slotW - 1);
      const binHz = audioCtx.sampleRate / _SPEC_FFT;
      const M = freqData.length;

      for (let i = 0; i < _SPEC_N; i++) {
        const fc = _SPEC_CENTERS[i];
        const bLo = Math.max(0, Math.floor((fc / _SPEC_HALF_BW) / binHz));
        const bHi = Math.min(M - 1, Math.ceil((fc * _SPEC_HALF_BW) / binHz));
        let peak = 0;
        for (let b = bLo; b <= bHi; b++) {
          if (data[b] > peak) peak = data[b];
        }
        const amp = peak / 255;
        ctx2d.fillStyle = spectrumBandColor(i, amp);
        const x = (i * slotW + (slotW - barW) / 2) | 0;
        const h = Math.max(2, (amp * H) | 0);
        ctx2d.fillRect(x, H - h, barW, h);
      }

      ctx2d.save();
      ctx2d.font = "bold 8px monospace";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.shadowColor = "rgba(0,0,0,0.65)";
      ctx2d.shadowBlur = 2;
      ctx2d.fillStyle = "#ffffff";
      for (const [i, label] of _SPEC_LABELS) {
        ctx2d.fillText(label, (i + 0.5) * slotW, 2);
      }
      ctx2d.restore();
    }

    // ── RAF loop ──────────────────────────────────────────────────────────
    function tick(now) {
      if (!alive || !isAnimating || document.hidden) { rafId = null; return; }
      const dt = lastDrawTime !== null ? now - lastDrawTime : 0;
      lastDrawTime = now;
      // Flush stale analyser buffer accumulated during background suspension
      if (dt > 200 && analyser && freqData) {
        analyser.getByteFrequencyData(freqData); // discard; next paint() reads fresh
      }
      paint();
      rafId = requestAnimationFrame(tick);
    }

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
      if (rafId == null) rafId = requestAnimationFrame(tick);
    }

    function stopAnim() {
      isAnimating = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      decayTick();
    }

    // ── Audio setup ───────────────────────────────────────────────────────
    function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;

      const shared = getSharedAudioContext();
      try {
        audioCtx = shared || new (window.AudioContext || window.webkitAudioContext)();

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = _SPEC_FFT;
        analyser.smoothingTimeConstant = 0.78;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        decayBuf = new Float32Array(analyser.frequencyBinCount);

        // Reuse the existing source node if it's for the same media element;
        // create a new one only when the track changes (different element).
        if (_spectrumSrc && _spectrumSrc.mediaElement === mediaEl) {
          _spectrumSrc.connect(analyser);
        } else {
          const src = audioCtx.createMediaElementSource(mediaEl);
          src.connect(audioCtx.destination);
          src.connect(analyser);
          _spectrumSrc = src;
        }
      } catch (e) {
        console.warn("[MobileSpectrumStrip] connect failed:", e.message);
        try { analyser?.disconnect(); } catch (_) {}
        audioCtx = null;
        analyser = null;
        freqData = null;
        decayBuf = null;
        return false;
      }

      function onPlay() { if (alive) startAnim(); }
      function onStop() { if (alive) stopAnim(); }
      ws.on("play", onPlay);
      ws.on("pause", onStop);
      ws.on("finish", onStop);
      detachWs = () => {
        try { ws.un("play", onPlay); ws.un("pause", onStop); ws.un("finish", onStop); }
        catch (_) {}
      };

      if (ws.isPlaying?.()) startAnim();
      else paint();

      return true;
    }

    // ── Visibility handling (iOS background safety) ───────────────────────
    // On hide: cancel RAF immediately — no draws while backgrounded.
    // On show: reset lastDrawTime so the first tick's dt is 0 (no false stale-flush),
    //          resume context if iOS suspended it, restart RAF if audio is playing.
    function onVisibilityChange() {
      if (!alive) return;
      if (document.hidden) {
        isAnimating = false;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      } else {
        lastDrawTime = null;
        if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
        const ws = wsRef.current;
        if (ws?.isPlaying?.()) startAnim();
        else if (analyser && freqData) paint();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    // ── Canvas sizing ─────────────────────────────────────────────────────
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
      // Sever source → analyser link only; keep source → destination so audio
      // continues playing through the shared context after unmount.
      try { if (_spectrumSrc && analyser) _spectrumSrc.disconnect(analyser); } catch (_) {}
      try { analyser?.disconnect(); } catch (_) {}
      analyser = null;
      freqData = null;
      decayBuf = null;
      audioCtx = null;
      ro.disconnect();
    }

    if (!tryConnect()) {
      const iv = setInterval(() => {
        if (!alive || tryConnect()) clearInterval(iv);
      }, 80);
      return () => { clearInterval(iv); cleanup(); };
    }

    return cleanup;
  }, [wsRef]);

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
