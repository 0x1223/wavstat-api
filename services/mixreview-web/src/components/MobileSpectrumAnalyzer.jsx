import { useEffect, useRef } from "react";

// DIAG: module-level state exposed via window.__mixreviewDiag.analyzer()
// so the full audio state can be read from the browser console at any moment.
const _msDiag = { audioCtxState: "none", analyserConnected: false, tryConnectAttempts: 0, lastError: null };
if (typeof window !== "undefined") {
  window.__mixreviewDiag = window.__mixreviewDiag || {};
  window.__mixreviewDiag.analyzer = () => ({ ..._msDiag });
}
// END DIAG

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
    let detachWs = null;   // WaveSurfer event unsubscribe fn — outlives AudioContext reconnects
    let reconnectIv = null;
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
        try { if (onFrameRef.current && analyser) onFrameRef.current(analyser); } catch (_) {}
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
      // If there is no AudioContext yet, try to connect now.
      // When startAnim() is called from the WaveSurfer "play" event (which
      // fires within the user gesture call stack), ctx.resume() will succeed
      // on iOS — this is the primary path for analyzer reconnect after
      // a background/restore cycle.
      if (!audioCtx && !document.hidden) tryConnect();
      if (rafId == null) tick();
    }

    function stopAnim() {
      isPlaying = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      decayTick();
    }

    // ── AudioContext teardown ─────────────────────────────────────────────
    // Closes the AudioContext, which releases the HTMLMediaElement from the
    // Web Audio graph so it reverts to native audio output.
    //
    // Deliberately does NOT remove WaveSurfer event listeners (detachWs).
    // Those listeners stay alive across reconnects so that the next play
    // gesture can trigger tryConnect() in the right call-stack context.
    function tearDownAudioCtx() {
      // DIAG: capture state before teardown so we can see what was connected
      const _mediaEl = wsRef.current?.getMediaElement?.();
      console.log("[MobileSpectrum] DIAG tearDownAudioCtx", {
        ctxState: audioCtx?.state ?? "null",
        analyserConnected: Boolean(analyser),
        mediaElPaused: _mediaEl?.paused ?? null,
        mediaElMuted: _mediaEl?.muted ?? null,
        mediaElSrc: (_mediaEl?.currentSrc || _mediaEl?.src || "").slice(0, 80),
      });
      _msDiag.audioCtxState = "tearing-down";
      _msDiag.analyserConnected = false;
      // END DIAG

      stopAnim();
      try { analyser?.disconnect(); } catch (_) {}
      if (audioCtx && audioCtx.state !== "closed") {
        // DIAG: track when the async close actually resolves
        const _ctxRef = audioCtx;
        const _ctxStateAtClose = audioCtx.state;
        _ctxRef.close().then(() => {
          const _el = wsRef.current?.getMediaElement?.();
          console.log("[MobileSpectrum] DIAG AudioContext.close() resolved", {
            stateAtCloseCall: _ctxStateAtClose,
            finalCtxState: _ctxRef.state,
            mediaElPaused: _el?.paused ?? null,
            mediaElMuted: _el?.muted ?? null,
            mediaElSrc: (_el?.currentSrc || _el?.src || "").slice(0, 80),
          });
          _msDiag.audioCtxState = "closed";
        }).catch(() => {});
        // END DIAG
      }
      audioCtx = null;
      analyser = null;
      freqData = null;
      decayBuf = null;
    }

    // Full teardown including WaveSurfer listeners.
    // Used only on component unmount or full audio engine reset.
    function tearDownAll() {
      tearDownAudioCtx();
      detachWs?.();
      detachWs = null;
    }

    // ── Reconnect management ──────────────────────────────────────────────
    function clearReconnect() {
      if (reconnectIv != null) { clearInterval(reconnectIv); reconnectIv = null; }
    }

    function startReconnectLoop() {
      clearReconnect();
      // Ensure WaveSurfer listeners are attached first — they survive
      // AudioContext restarts and give us a gesture entry point.
      if (!detachWs) attachWsListeners();
      if (tryConnect()) return;
      // Poll until tryConnect() succeeds.  It will succeed the first time
      // it runs from inside a user gesture (play button tap).
      reconnectIv = setInterval(() => {
        if (!alive) { clearReconnect(); return; }
        if (!detachWs) attachWsListeners();
        if (tryConnect()) clearReconnect();
      }, 500);
    }

    // ── WaveSurfer event subscription ─────────────────────────────────────
    // Kept separate from AudioContext wiring so listeners survive reconnects.
    //
    // The onPlay handler runs inside the WaveSurfer play event, which fires
    // synchronously from the play-button click handler — i.e., within the
    // user gesture call stack.  This is the only context in which iOS allows
    // AudioContext.resume() to actually change state to "running".
    function attachWsListeners() {
      const ws = wsRef.current;
      if (!ws || detachWs) return; // already attached or WaveSurfer not ready

      // DIAG: log when listeners are actually attached so we can see timing relative to mount
      const _mediaEl = ws.getMediaElement?.();
      console.log("[MobileSpectrum] DIAG attachWsListeners", {
        wsIsPlaying: ws.isPlaying?.() ?? null,
        mediaElSrc: (_mediaEl?.currentSrc || _mediaEl?.src || "").slice(0, 80),
        mediaElPaused: _mediaEl?.paused ?? null,
        audioCtxState: audioCtx?.state ?? "none",
      });
      // END DIAG

      function onPlay() {
        if (!alive) return;
        // Gesture-driven connect: if no context, try now while inside gesture.
        if (!audioCtx && !document.hidden) tryConnect();
        startAnim();
      }
      function onStop() { stopAnim(); }

      ws.on("play", onPlay);
      ws.on("pause", onStop);
      ws.on("finish", onStop);
      detachWs = () => {
        try { ws.un("play", onPlay); ws.un("pause", onStop); ws.un("finish", onStop); }
        catch (_) {}
      };

      // If already playing when we attach, kick off animation immediately.
      if (ws.isPlaying?.()) onPlay();
    }

    // ── AudioContext + graph setup ────────────────────────────────────────
    // Creates a new AudioContext and wires the WaveSurfer media element
    // through it for spectrum analysis.
    //
    // Critical invariant: the media element must NEVER be left connected to
    // a suspended AudioContext — that routes all audio to a silent output.
    //
    // Enforcement:
    //   1. After creating the context, resume() is called immediately.
    //      On iOS this only changes state if we are inside a user gesture.
    //   2. If the state is not "running" after the resume() call, we close
    //      the context WITHOUT touching the media element and return false.
    //      Audio continues playing natively.  The reconnect loop retries.
    //   3. Once connected, a statechange listener monitors the context.
    //      If it is ever suspended (incoming call, OS enforcement), the
    //      context is closed immediately so the media element reverts to
    //      native output at once.
    function tryConnect() {
      const ws = wsRef.current;
      if (!ws) return false;
      if (audioCtx) return true; // already connected
      const mediaEl = ws.getMediaElement?.();
      if (!mediaEl) return false;

      // DIAG: log each attempt so we can count failures and see media element state
      _msDiag.tryConnectAttempts += 1;
      console.log("[MobileSpectrum] DIAG tryConnect attempt #" + _msDiag.tryConnectAttempts, {
        mediaElSrc: (mediaEl.currentSrc || mediaEl.src || "").slice(0, 80),
        mediaElPaused: mediaEl.paused,
        mediaElMuted: mediaEl.muted,
        hidden: document.hidden,
      });
      // END DIAG

      let ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn("[MobileSpectrum] AudioContext creation failed:", e.message);
        return false;
      }

      // On iOS: resume() changes ctx.state synchronously when called within
      // a user gesture.  Outside a gesture the state stays "suspended" and
      // we bail out without connecting the media element.
      if (ctx.state !== "running") {
        ctx.resume().catch(() => {});
      }

      if (ctx.state !== "running") {
        // Not running — connecting would silence the media element.
        // Close and let the reconnect loop retry on the next gesture.
        console.log("[MobileSpectrum] AudioContext not running — deferring connect, state:", ctx.state);
        ctx.close().catch(() => {});
        return false;
      }

      // Context confirmed running — safe to wire the media element.
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
        // DIAG
        _msDiag.audioCtxState = ctx.state;
        _msDiag.analyserConnected = true;
        _msDiag.lastError = null;
        // END DIAG
      } catch (e) {
        // DIAG: InvalidStateError here means the media element is already owned
        // by another AudioContext (most likely SpectrumAnalyzer on mobile)
        console.warn("[MobileSpectrum] DIAG audio graph wiring FAILED —", e.name + ":", e.message, {
          ctxState: ctx.state,
          mediaElSrc: (mediaEl.currentSrc || mediaEl.src || "").slice(0, 80),
          mediaElPaused: mediaEl.paused,
          mediaElMuted: mediaEl.muted,
          hint: e.name === "InvalidStateError"
            ? "Media element already owned by another AudioContext — check [SpectrumAnalyzer] DIAG logs"
            : "",
        });
        _msDiag.lastError = e.name + ": " + e.message;
        _msDiag.audioCtxState = "wiring-failed";
        // END DIAG
        ctx.close().catch(() => {});
        analyser = null;
        freqData = null;
        decayBuf = null;
        return false;
      }

      // Monitor for unexpected suspensions after wiring.
      // Close the context immediately so the media element reverts to native
      // output before iOS silences audio through the suspended graph.
      ctx.addEventListener("statechange", () => {
        if (!alive || audioCtx !== ctx) return;
        // DIAG: log full media element state at suspension time
        const _el = wsRef.current?.getMediaElement?.();
        console.log("[MobileSpectrum] DIAG AudioContext statechange →", ctx.state, {
          mediaElPaused: _el?.paused ?? null,
          mediaElMuted: _el?.muted ?? null,
          mediaElCurrentTime: _el?.currentTime != null ? _el.currentTime.toFixed(2) : null,
          hidden: document.hidden,
        });
        _msDiag.audioCtxState = ctx.state;
        // END DIAG
        if (ctx.state === "suspended") {
          tearDownAudioCtx(); // release media element to native output
          // Restart reconnect loop; reattaches after next user gesture.
          if (!document.hidden) startReconnectLoop();
        }
      });

      return true;
    }

    // ── Background / foreground handling ──────────────────────────────────
    // On page hide: close the AudioContext so the media element is released
    //   to native output before iOS suspends the AudioContext and would
    //   otherwise silence audio routed through it.
    //   WaveSurfer listeners stay attached — they fire on restore so that
    //   the first play gesture reconnects the analyzer automatically.
    // On page show: start the reconnect loop.  The AudioContext wiring
    //   will succeed on the first user gesture; until then audio plays
    //   natively without the analyzer.
    function handleVisibilityChange() {
      if (!alive) return;
      if (document.hidden) {
        // DIAG: snapshot full state at the moment we go hidden
        const _el = wsRef.current?.getMediaElement?.();
        console.log("[MobileSpectrum] DIAG page hidden — pre-teardown state", {
          ctxState: audioCtx?.state ?? "none (not connected)",
          analyserConnected: Boolean(analyser),
          mediaElPaused: _el?.paused ?? null,
          mediaElMuted: _el?.muted ?? null,
          mediaElCurrentTime: _el?.currentTime != null ? _el.currentTime.toFixed(2) : null,
          lastError: _msDiag.lastError,
        });
        // END DIAG
        console.log("[MobileSpectrum] page hidden — releasing AudioContext");
        clearReconnect();
        tearDownAudioCtx(); // WaveSurfer listeners (detachWs) kept alive
      } else {
        // DIAG: snapshot state on restore — is the AudioContext already gone?
        const _el = wsRef.current?.getMediaElement?.();
        console.log("[MobileSpectrum] DIAG page visible — restore state", {
          ctxState: audioCtx?.state ?? "none (torn down)",
          analyserConnected: Boolean(analyser),
          mediaElPaused: _el?.paused ?? null,
          mediaElMuted: _el?.muted ?? null,
          mediaElCurrentTime: _el?.currentTime != null ? _el.currentTime.toFixed(2) : null,
          lastError: _msDiag.lastError,
          tryConnectAttempts: _msDiag.tryConnectAttempts,
        });
        // END DIAG
        console.log("[MobileSpectrum] page visible — starting analyser reconnect loop");
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
      tearDownAll();
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
