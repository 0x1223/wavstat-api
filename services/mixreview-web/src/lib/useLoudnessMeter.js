import { useEffect, useRef, useState } from "react";
import { createAnalyserNode, getAudioTapVersion } from "./mobileAudioTap.js";

/**
 * Lightweight real-time loudness meter.
 *
 * Taps the shared mobile audio context registered by MobileSpectrumAnalyzer —
 * no second createMediaElementSource() call, no duplicate audio graph.
 *
 * @param {React.MutableRefObject<boolean>} isPlayingRef  — ref tracking play state
 * @param {boolean} enabled  — false on desktop / single-track (hook is a no-op)
 * @returns {{ lufs: string, lra: string, tp: string }}
 */
export function useLoudnessMeter(isPlayingRef, enabled) {
  const [meters, setMeters] = useState({ lufs: "---", lra: "---", tp: "---" });

  useEffect(() => {
    if (!enabled) return;

    let alive = true;
    let rafId = null;
    let analyser = null;
    let timeBuf = null;
    let knownVersion = -1;
    const history = []; // short-term loudness values for LRA estimate
    let decayPeak = -Infinity;
    let lastUpdate = 0;

    function tryConnect() {
      const v = getAudioTapVersion();
      if (v === knownVersion && analyser) return true; // still valid
      // Source changed or first attempt — get a fresh AnalyserNode
      try { analyser?.disconnect(); } catch (_) {}
      analyser = null;
      const a = createAnalyserNode(2048, 0.0); // no smoothing — raw samples
      if (!a) return false;
      analyser = a;
      timeBuf = new Float32Array(analyser.fftSize);
      knownVersion = v;
      history.length = 0;
      decayPeak = -Infinity;
      return true;
    }

    function tick(ts) {
      if (!alive) return;
      rafId = requestAnimationFrame(tick);

      // Throttle React state updates to ~10 fps
      if (ts - lastUpdate < 100) return;
      lastUpdate = ts;

      if (!tryConnect()) return;

      analyser.getFloatTimeDomainData(timeBuf);

      // RMS + sample peak
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < timeBuf.length; i++) {
        const s = timeBuf[i];
        sum += s * s;
        const abs = s < 0 ? -s : s;
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sum / timeBuf.length);

      // Approximate integrated LUFS from RMS (K-weighting offset ≈ −0.691 dB)
      const lufsNum = rms > 1e-6 ? 20 * Math.log10(rms) - 0.691 : null;

      // True peak (sample-domain peak in dBFS)
      const tpNum = peak > 1e-6 ? 20 * Math.log10(peak) : null;

      // Short-term loudness history for LRA (≈200 frames @ 10 fps = 20 s)
      if (lufsNum !== null) {
        history.push(lufsNum);
        if (history.length > 200) history.shift();
      }

      // LRA ≈ 95th−10th percentile of recent loudness history
      let lraNum = 0;
      if (history.length >= 20) {
        const sorted = [...history].sort((a, b) => a - b);
        const lo = sorted[Math.floor(sorted.length * 0.10)];
        const hi = sorted[Math.floor(sorted.length * 0.95)];
        lraNum = Math.max(0, hi - lo);
      }

      // Decay peak: hold and slowly decay (−0.3 dB per tick)
      if (tpNum !== null && tpNum > decayPeak) decayPeak = tpNum;
      else if (isFinite(decayPeak)) decayPeak -= 0.3;

      if (isPlayingRef.current) {
        setMeters({
          lufs: lufsNum !== null ? lufsNum.toFixed(1) : "---",
          lra: lraNum.toFixed(1),
          tp: isFinite(decayPeak) && decayPeak > -60 ? decayPeak.toFixed(1) : "---",
        });
      }
    }

    rafId = requestAnimationFrame(tick);

    return () => {
      alive = false;
      if (rafId != null) cancelAnimationFrame(rafId);
      try { analyser?.disconnect(); } catch (_) {}
    };
  }, [enabled, isPlayingRef]);

  return meters;
}
