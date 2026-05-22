import { useEffect, useRef } from "react";

// Standard ISO 1/3-octave center frequencies, 25 Hz – 20 kHz (30 bands)
const CENTERS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200,
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];
const N = CENTERS.length; // 30
const FFT_SIZE = 4096; // default full-quality fftSize
const CANVAS_H = 72;
// 1/3-octave half-bandwidth factor: 2^(1/6)
const HALF_BW = Math.pow(2, 1 / 6);

// [band index, label] pairs aligned to their bars; last entry includes "Hz" suffix
const FREQ_LABELS = [
  [1, "31"], [4, "63"], [7, "125"], [10, "250"], [13, "500"],
  [16, "1k"], [19, "2k"], [22, "4k"], [25, "8k"], [28, "16kHz"],
];

export function MobileSpectrumAnalyzer({ wsRef, onFrame, liteMode = false }) {
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
    let detachWs = null;
    let reconnectIv = null;
    let connectPending = false; // guard: only one tryConnect() in-flight at a time
    let frameCount = 0;

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
      // Use the analyser's actual fftSize so lite mode (fftSize=1024) maps bins correctly.
      const binHz = sampleRate / analyser.fftSize;
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
    // Lite mode: paint at ~15 fps (every 4th frame) instead of 60 fps to
    // reduce canvas draw workload on weak/low-memory devices.
    function tick() {
      if (!alive || !isPlaying) return;
      if (!liteMode || ++frameCount % 4 === 0) {
        paint();
        try { if (onFrameRef.current) onFrameRef.current(analyser); } catch (_) {}
      }
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

    // ── Audio teardown ────────────────────────────────────────────────────
    // Closes the AudioContext, which releases the HTMLMediaElement from the
    // Web Audio graph.  After close(), the media element reverts to its native
    // audio output path so it can keep playing while the page is backgrounded
    // (iOS suspends AudioContexts in the background, which would otherwise
    // stop audio routed through them).
    function tearDownAudio() {
      stopAnim();
      connectPending = false; // abort any in-flight async connect attempt
      detachWs?.();
      detachWs = null;
      try { analyser?.disconnect(); } catch (_) {}
      if (audioCtx && audioCtx.state !== "closed") {
        audioCtx.close().catch(() => {});
      }
      audioCtx = null;
      analyser = null;
      freqData = null;
      decayBuf = null;
    }

    // ── Reconnect management ──────────────────────────────────────────────
    function clearReconnect() {
      if (reconnectIv != null) { clearInterval(reconnectIv); reconnectIv = null; }
    }

    // Kick off one async connect attempt if none is already in-flight.
    function _runConnect() {
      if (connectPending || !alive || audioCtx) return;
      connectPending = true;
      tryConnect().then((ok) => {
        connectPending = false;
        if (ok) clearReconnect();
      }).catch(() => {
        connectPending = false;
      });
    }

    function startReconnectLoop() {
      clearReconnect();
      connectPending = false;
      _runConnect(); // first attempt immediately
      reconnectIv = setInterval(() => {
        if (!alive) { clearReconnect(); return; }
        if (audioCtx) { clearReconnect(); return; } // already connected
        _runConnect();
      }, 300);
    }

    // ── Audio setup ───────────────────────────────────────────────────────
    // Connects the WaveSurfer media element to a new AudioContext for analysis.
    // createMediaElementSource() routes the element's audio through the context;
    // we connect to both destination (so the user hears audio) and analyser.
    //
    // IMPORTANT: On iOS a new AudioContext always starts in "suspended" state.
    // Calling createMediaElementSource() on a suspended context silences the
    // media element even though mediaEl.paused === false — the "playing but
    // silent" bug after background/sleep restore.  We therefore attempt
    // ctx.resume() first and bail out — WITHOUT touching the media element —
    // if the context cannot reach "running" state.  This keeps native playback
    // alive while the reconnect loop retries on a subsequent user-gesture tick.
    //
    // This binding is released when tearDownAudio() calls audioCtx.close().
    // After close(), the element plays natively again.
    async function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;
      if (audioCtx) return true; // already connected

      // ── Create and warm up the AudioContext ─────────────────────────────
      let ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        console.log("[MobileSpectrum] new AudioContext state:", ctx.state);

        if (ctx.state !== "running") {
          try { await ctx.resume(); } catch (_) {}
          // Give the browser up to 80 ms to flip the state.
          await new Promise((r) => setTimeout(r, 80));
        }

        if (ctx.state !== "running") {
          // Still suspended — connecting now would silence the media element.
          // Close it so the element stays on the native output path, and let
          // the reconnect loop retry on the next user-gesture tick.
          console.warn(
            "[MobileSpectrum] AudioContext not running after resume — state:",
            ctx.state,
            "— deferring connect to preserve native audio",
          );
          ctx.close().catch(() => {});
          return false;
        }
      } catch (e) {
        console.warn("[MobileSpectrum] AudioContext creation failed:", e.message);
        try { ctx?.close(); } catch (_) {}
        return false;
      }

      // ── Wire the audio graph ────────────────────────────────────────────
      try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = liteMode ? 1024 : FFT_SIZE;
        analyser.smoothingTimeConstant = 0.78;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        decayBuf = new Float32Array(analyser.frequencyBinCount);

        // Route: mediaElement → source → destination (pass-through to speakers)
        //                              → analyser    (spectrum data)
        const src = ctx.createMediaElementSource(mediaEl);
        src.connect(ctx.destination);
        src.connect(analyser);
        audioCtx = ctx;
        console.log("[MobileSpectrum] analyser connected, ctx state:", ctx.state);
      } catch (e) {
        console.warn("[MobileSpectrum] audio graph wiring failed:", e.message);
        try { ctx.close(); } catch (_) {}
        analyser = null;
        freqData = null;
        decayBuf = null;
        return false;
      }

      // ── Monitor context for late suspensions ────────────────────────────
      // e.g. incoming call, brief re-background before reconnect loop fires
      ctx.addEventListener("statechange", () => {
        if (!alive) return;
        console.log("[MobileSpectrum] AudioContext statechange →", ctx.state);
        if (ctx.state === "suspended" && isPlaying) {
          console.log("[MobileSpectrum] context suspended mid-play — attempting resume");
          ctx.resume().catch(() => {});
        }
        if (ctx.state === "closed") {
          // Closed externally — drop our references so the next reconnect
          // loop tick creates a fresh context.
          if (audioCtx === ctx) {
            audioCtx = null;
            analyser = null;
            freqData = null;
            decayBuf = null;
          }
        }
      });

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

    // ── Background / foreground handling ──────────────────────────────────
    // On page hide: tear down the AudioContext so the media element is
    //   released back to native output.  Audio keeps playing in background.
    //   The analyser simply pauses — that's acceptable.
    // On page show: recreate the AudioContext and reconnect the analyser.
    //   The audio element may still be playing (never stopped), so we just
    //   reattach the visual layer on top of it.
    function handleVisibilityChange() {
      if (!alive) return;
      if (document.hidden) {
        console.log("[MobileSpectrum] page hidden — closing AudioContext");
        clearReconnect();
        tearDownAudio();
      } else {
        console.log("[MobileSpectrum] page visible — reconnecting analyser");
        startReconnectLoop();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

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

    // Initial connect (only while page is visible).
    if (!document.hidden) {
      startReconnectLoop();
    }

    return () => {
      alive = false;
      clearReconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      tearDownAudio();
      ro.disconnect();
    };
  }, [wsRef, liteMode]);

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
