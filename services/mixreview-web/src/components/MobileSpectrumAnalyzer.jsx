import { useEffect, useRef } from "react";

// Standard ISO 1/3-octave center frequencies, 25 Hz – 20 kHz (30 bands)
const CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];
const N = CENTERS.length; // 30
const FFT_SIZE = 4096;
const CANVAS_H = 72;
// 1/3-octave half-bandwidth factor: 2^(1/6)
const HALF_BW = Math.pow(2, 1 / 6);

// [band index, label] pairs aligned to their bars; last entry includes "Hz" suffix
const FREQ_LABELS = [
  [1, "31"], [4, "63"], [7, "125"], [10, "250"], [13, "500"],
  [16, "1k"], [19, "2k"], [22, "4k"], [25, "8k"], [28, "16kHz"],
];

export function MobileSpectrumAnalyzer({ wsRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let rafId = null;
    let isPlaying = false;
    let analyser = null;
    let freqData = null;
    let audioCtx = null;
    let detachWs = null;

    // ── Drawing ──────────────────────────────────────────────────────────
    function paint() {
      if (!canvas || !analyser || !freqData) return;
      analyser.getByteFrequencyData(freqData);

      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const slotW = W / N;
      const barW = Math.max(1, (slotW * 0.74) | 0);
      const sampleRate = audioCtx.sampleRate;
      const binHz = sampleRate / FFT_SIZE;
      const M = freqData.length;

      for (let i = 0; i < N; i++) {
        const fc = CENTERS[i];
        const bLo = Math.max(0, Math.floor((fc / HALF_BW) / binHz));
        const bHi = Math.min(M - 1, Math.ceil((fc * HALF_BW) / binHz));

        let peak = 0;
        for (let b = bLo; b <= bHi; b++) {
          if (freqData[b] > peak) peak = freqData[b];
        }

        const amp = peak / 255;
        // blue(240°) lows → cyan(180°) → green(120°) → yellow(60°) → red(0°) highs
        const hue = (240 - (i / (N - 1)) * 240) | 0;
        const lit = (28 + amp * 42) | 0;
        ctx.fillStyle = `hsl(${hue},88%,${lit}%)`;

        const x = (i * slotW + (slotW - barW) / 2) | 0;
        const h = Math.max(2, (amp * H) | 0);
        ctx.fillRect(x, H - h, barW, h);
      }

      ctx.save();
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = 2;
      ctx.fillStyle = "rgba(255,255,255,0.40)";
      for (const [i, label] of FREQ_LABELS) {
        ctx.fillText(label, (i + 0.5) * slotW, 2);
      }
      ctx.restore();
    }

    // ── RAF loop ─────────────────────────────────────────────────────────
    function tick() {
      if (!alive || !isPlaying) return;
      paint();
      rafId = requestAnimationFrame(tick);
    }

    function startAnim() {
      isPlaying = true;
      if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
      if (rafId == null) tick();
    }

    function stopAnim() {
      isPlaying = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      paint(); // freeze last frame
    }

    // ── Audio setup ───────────────────────────────────────────────────────
    function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;

      try {
        // Mobile WaveSurfer uses HTMLAudioElement directly (no Web Audio backend),
        // so we create one AudioContext purely for the AnalyserNode tap.
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.78;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        freqData = new Uint8Array(analyser.frequencyBinCount);

        // Route: mediaElement → source → analyser → destination (pass-through)
        const src = audioCtx.createMediaElementSource(mediaEl);
        src.connect(audioCtx.destination);
        src.connect(analyser);
      } catch (e) {
        console.warn("[MobileSpectrum] audio connect failed:", e.message);
        return false;
      }

      // Subscribe to WaveSurfer play/pause events
      function onPlay() { if (alive) startAnim(); }
      function onStop() { stopAnim(); }
      ws.on("play", onPlay);
      ws.on("pause", onStop);
      ws.on("finish", onStop);
      detachWs = () => {
        try { ws.un("play", onPlay); ws.un("pause", onStop); ws.un("finish", onStop); }
        catch (_) {}
      };

      if (ws.isPlaying?.()) startAnim();
      else paint(); // draw silent initial frame

      return true;
    }

    // ── Canvas pixel sizing ───────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      if (!canvas) return;
      const w = canvas.getBoundingClientRect().width | 0;
      if (w > 0 && canvas.width !== w) {
        canvas.width = w;
        if (!isPlaying) paint();
      }
    });
    ro.observe(canvas);
    const initW = canvas.getBoundingClientRect().width | 0;
    if (initW > 0) canvas.width = initW;

    // Attempt setup; poll until WaveSurfer is ready
    if (!tryConnect()) {
      const iv = setInterval(() => {
        if (!alive || tryConnect()) clearInterval(iv);
      }, 80);
      return () => {
        alive = false;
        clearInterval(iv);
        if (rafId != null) cancelAnimationFrame(rafId);
        detachWs?.();
        try { analyser?.disconnect(); } catch (_) {}
        ro.disconnect();
      };
    }

    return () => {
      alive = false;
      if (rafId != null) cancelAnimationFrame(rafId);
      detachWs?.();
      try { analyser?.disconnect(); } catch (_) {}
      ro.disconnect();
    };
  }, [wsRef]);

  return (
    <canvas
      ref={canvasRef}
      className="mobile-spectrum-canvas"
      width="300"
      height={CANVAS_H}
      aria-hidden="true"
    />
  );
}
