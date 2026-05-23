import { useEffect, useRef } from "react";
import { getSharedAudioContext } from "../lib/mobileAudioEngine.js";

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

export function MobileSpectrumAnalyzer({ wsRef, onFrame }) {
  const canvasRef = useRef(null);
  const onFrameRef = useRef(onFrame);

  // Keep onFrameRef.current in sync without re-running the audio effect
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let rafId = null;
    let isPlaying = false;
    let analyser = null;
    let freqData = null;
    let decayBuf = null;
    let audioCtx = null;
    let isSharedCtx = false;  // true when audioCtx is the keep-alive shared context
    let mediaElSrc = null;    // current MediaElementAudioSourceNode (for cleanup)
    let detachWs = null;

    // ── Drawing ──────────────────────────────────────────────────────────
    // dataOverride: optional Float32Array to draw from instead of reading the analyser.
    function paint(dataOverride = null) {
      if (!canvas || !analyser || !freqData) return;

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

      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const slotW = W / N;
      const barW = Math.max(1, slotW - 1);
      const sampleRate = audioCtx.sampleRate;
      const binHz = sampleRate / FFT_SIZE;
      const M = freqData.length;

      for (let i = 0; i < N; i++) {
        const fc = CENTERS[i];
        const bLo = Math.max(0, Math.floor((fc / HALF_BW) / binHz));
        const bHi = Math.min(M - 1, Math.ceil((fc * HALF_BW) / binHz));

        let peak = 0;
        for (let b = bLo; b <= bHi; b++) {
          if (data[b] > peak) peak = data[b];
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
      ctx.fillStyle = "#ffffff";
      for (const [i, label] of FREQ_LABELS) {
        ctx.fillText(label, (i + 0.5) * slotW, 2);
      }
      ctx.restore();
    }

    // ── RAF loop ─────────────────────────────────────────────────────────
    function tick() {
      if (!alive || !isPlaying) return;
      paint();
      try { if (onFrameRef.current) onFrameRef.current(analyser); } catch (_) {}
      rafId = requestAnimationFrame(tick);
    }

    function decayTick() {
      if (!alive || isPlaying || !decayBuf) return;
      let anyActive = false;
      for (let i = 0; i < decayBuf.length; i++) {
        decayBuf[i] *= 0.82;
        if (decayBuf[i] > 0.5) anyActive = true;
      }
      paint(decayBuf);
      rafId = anyActive ? requestAnimationFrame(decayTick) : null;
    }

    function startAnim() {
      isPlaying = true;
      if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
      if (rafId == null) tick();
    }

    function stopAnim() {
      isPlaying = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      decayTick();
    }

    // ── Audio setup ───────────────────────────────────────────────────────
    function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;

      // Prefer the shared keep-alive AudioContext (already unlocked in the
      // user's Play gesture). Falling back to a fresh context only happens
      // on non-iOS browsers where startKeepAlive() is a no-op — there, a
      // new context is fine because iOS auto-suspension isn't a concern.
      const shared = getSharedAudioContext();

      try {
        audioCtx = shared || new (window.AudioContext || window.webkitAudioContext)();
        isSharedCtx = Boolean(shared);

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.78;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        decayBuf = new Float32Array(analyser.frequencyBinCount);

        // Route: mediaElement → source → analyser → destination (pass-through).
        // The silent keep-alive node in the shared context is connected to
        // destination independently and does not affect analyser readings.
        //
        // If a MediaElementAudioSourceNode was already created for this element
        // in a previous mount (stored on window.__wavstatSourceNode), reuse it
        // instead of calling createMediaElementSource again — that would throw
        // InvalidStateError because an element can only have one source node
        // per AudioContext.
        if (window.__wavstatSourceNode) {
          mediaElSrc = window.__wavstatSourceNode;
          mediaElSrc.connect(analyser);
          window.__wavstatNeedsRewire = false;
        } else {
          const src = audioCtx.createMediaElementSource(mediaEl);
          src.connect(audioCtx.destination);
          src.connect(analyser);
          mediaElSrc = src;
          window.__wavstatSourceNode = src;
        }
      } catch (e) {
        console.warn("[MobileSpectrum] audio connect failed:", e.message);
        // Only close if we own the context (not the shared one).
        if (!isSharedCtx) {
          try { audioCtx?.close(); } catch (_) {}
        }
        audioCtx = null;
        isSharedCtx = false;
        mediaElSrc = null;
        analyser = null;
        freqData = null;
        decayBuf = null;
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

    // ── Background / foreground handling ─────────────────────────────────
    // When using the shared keep-alive AudioContext (iOS/Safari):
    //   • The keep-alive node prevents iOS from auto-suspending the context,
    //     so audio continues flowing through the Web Audio graph in background.
    //   • On hide we just stop the animation loop (saves battery); the source
    //     and analyser remain connected.
    //   • On show we resume the context (in case iOS did suspend it despite
    //     the keep-alive) and restart animation if audio is still playing.
    //
    // When using a per-instance context (non-iOS browsers):
    //   • We keep the existing close-on-hide behaviour so the media element
    //     reverts to native routing in background.
    //   • The analyser stays offline after restore — audio priority > visuals.
    function onVisibilityChange() {
      if (!alive) return;
      if (document.hidden) {
        if (isSharedCtx) {
          // Shared context: only stop the animation; keep the graph connected.
          // The keep-alive node will maintain the iOS audio session.
          console.log("[MobileSpectrum] visibilitychange → hidden (shared ctx — animation paused, graph alive)");
          isPlaying = false;
          if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        } else {
          // Own context: close it so the media element reverts to native routing
          // in background (non-iOS path, matches original behaviour).
          console.log("[MobileSpectrum] visibilitychange → hidden (own ctx — closing to allow native playback)");
          isPlaying = false;
          if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
          detachWs?.();
          detachWs = null;
          try { mediaElSrc?.disconnect(); } catch (_) {}
          try { analyser?.disconnect(); } catch (_) {}
          mediaElSrc = null;
          if (audioCtx) {
            try { audioCtx.close(); } catch (_) {}
            audioCtx = null;
          }
          analyser = null;
          freqData = null;
          decayBuf = null;
        }
      } else {
        // Page became visible again.
        if (isSharedCtx && audioCtx) {
          // Shared context path: resume if iOS auto-suspended it, then restart
          // the animation loop if audio is currently playing.
          console.log("[MobileSpectrum] visibilitychange → visible (shared ctx — resuming if needed)");
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
          }
          const ws = wsRef.current;
          if (ws?.isPlaying?.()) {
            startAnim();
          } else {
            // Audio paused / not started: redraw a silent frame so the canvas
            // doesn't show stale frequency bars.
            paint();
          }
        } else {
          // Own context was closed on hide — analyser stays offline.
          // Audio is playing natively; we don't re-route through a new context
          // because that would silence audio that is already playing.
          console.log("[MobileSpectrum] visibilitychange → visible (own ctx closed — analyser stays offline)");
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

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

    // Shared cleanup logic — called from both return paths.
    function cleanup() {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (rafId != null) cancelAnimationFrame(rafId);
      detachWs?.();
      // Always disconnect the source and analyser nodes to release the
      // MediaElementSource binding on the current media element.
      // This is important so that when the next track mounts, a new
      // MediaElementSource can be created for the new element in the same
      // shared AudioContext without conflict.
      try { mediaElSrc?.disconnect(); } catch (_) {}
      try { analyser?.disconnect(); } catch (_) {}
      mediaElSrc = null;
      analyser = null;
      // Only close the AudioContext if we own it.
      // The shared keep-alive context is preserved for the next track.
      if (!isSharedCtx && audioCtx) {
        try { audioCtx.close(); } catch (_) {}
      }
      audioCtx = null;
      ro.disconnect();
    }

    // Attempt setup; poll until WaveSurfer is ready
    if (!tryConnect()) {
      const iv = setInterval(() => {
        if (!alive || tryConnect()) clearInterval(iv);
      }, 80);
      return () => {
        clearInterval(iv);
        cleanup();
      };
    }

    return cleanup;
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
