/**
 * MobileStemStack
 *
 * Mobile-optimised multi-lane waveform engine for stem_project albums.
 * Renders inside the existing .waveform-panel slot, replacing WaveformReview
 * when a reviewer selects a stem project from the dropdown.
 *
 * Architecture mirrors StemPlayer (desktop) but with:
 *  – Smaller per-lane height (54 px) so all stems fit on a phone screen
 *  – No mix-strip header (the topbar already shows the session title)
 *  – Inline REVIEW button that triggers the shared mobile note UI
 *  – Same master-controls interface → playerRef works unchanged
 */
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { apiUrl } from "../config/api.js";
import { disposeMobileEngine } from "../lib/mobileAudioEngine.js";
import { getStemColor } from "../lib/stemColors.js";

const LANE_HEIGHT = 54; // px per stem waveform row
const STEM_PEAKS_FETCH_TIMEOUT_MS = 5_000;
const stemPeaksCache = new Map();

/** Max drift (seconds) before a follower is force-synced to the leader. */
const DRIFT_THRESHOLD = 0.08;

// ─────────────────────────────────────────────────────────────────────────────

function getPlaybackUrl(audioSource) {
  return audioSource?.previewUrl || audioSource?.playbackUrl || audioSource?.audioUrl || audioSource?.url || "";
}

function normalizePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) return null;
  return Array.isArray(peaks[0]) ? peaks : [peaks];
}

function getStemPeakUrls(audioSource) {
  const urls = [];
  if (audioSource?.peaksUrl) urls.push(audioSource.peaksUrl);
  if (audioSource?.key) {
    urls.push(apiUrl(`/api/audio/playback/${encodeURIComponent(`${audioSource.key}.peaks.json`)}`));
  }
  return [...new Set(urls.filter(Boolean))];
}

function fetchStemPeaks(peaksUrl) {
  if (!peaksUrl) return Promise.resolve(null);
  if (stemPeaksCache.has(peaksUrl)) return Promise.resolve(stemPeaksCache.get(peaksUrl));

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), STEM_PEAKS_FETCH_TIMEOUT_MS);

  return fetch(peaksUrl, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(normalizePeaks)
    .then((peaks) => {
      if (peaks) stemPeaksCache.set(peaksUrl, peaks);
      return peaks;
    })
    .catch((error) => {
      if (error?.name !== "AbortError") {
        console.warn("[MobileStemStack] Peaks fetch failed:", error.message);
      }
      return null;
    })
    .finally(() => window.clearTimeout(timeoutId));
}

function resolveStemPeaks(audioSource) {
  const urls = getStemPeakUrls(audioSource);
  if (urls.length === 0) return Promise.resolve(null);

  return urls.reduce(
    (chain, peaksUrl) => chain.then((peaks) => peaks ?? fetchStemPeaks(peaksUrl)),
    Promise.resolve(null),
  );
}

function finiteDuration(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeSetTime(ws, time) {
  if (!ws) return;
  const duration = finiteDuration(ws.getDuration?.());
  if (!duration) return;
  const next = Math.min(Math.max(time, 0), duration);
  try {
    ws.setTime(next);
  } catch (_) {}
}

export function MobileStemStack({
  stems,               // Array<{ id, title, audioSource }>
  onReady,             // (controls | null) => void — same shape as WaveformReview
  onTimeUpdate,        // (time: number) => void
  onDurationChange,    // (duration: number) => void
  onPlaybackChange,    // (isPlaying: boolean) => void
  onMobileNoteRequest, // (time: number) => void — opens the mobile timestamp note UI
}) {
  const containerRefs      = useRef([]);
  const wsRefs             = useRef([]);
  const cbRef              = useRef({});
  const masterReadyFired   = useRef(false);

  const [isMarkerToolActive, setIsMarkerToolActive] = useState(false);
  const [loadingStates, setLoadingStates] = useState(() => stems.map(() => true));
  const [errorStates,   setErrorStates]   = useState(() => stems.map(() => ""));

  // Keep callback ref current on every render (no deps needed)
  useEffect(() => {
    cbRef.current = { onReady, onTimeUpdate, onDurationChange, onPlaybackChange, onMobileNoteRequest };
  });

  // Stable key derived from stem IDs + URLs so the effect re-runs only when
  // the actual audio files change, not on every parent re-render.
  const stemsKey = stems
    .map((s) => `${s.id}:${getPlaybackUrl(s.audioSource)}:${s.audioSource?.peaksUrl || ""}`)
    .join("|");

  // ── Main effect: create / destroy all WaveSurfer instances ─────────────────
  useEffect(() => {
    // The regular mobile mix player is a singleton. Tear it down before the
    // multi-stem player creates several lane renderers so stale media/canvas
    // state cannot leak from an album track into the stem project.
    disposeMobileEngine();
    masterReadyFired.current = false;
    wsRefs.current = [];
    setLoadingStates(stems.map(() => true));
    setErrorStates(stems.map(() => ""));
    setIsMarkerToolActive(false);
    cbRef.current.onReady?.(null);
    cbRef.current.onTimeUpdate?.(0);
    cbRef.current.onDurationChange?.(0);
    cbRef.current.onPlaybackChange?.(false);

    const cleanups = [];

    stems.forEach((stem, i) => {
      const url       = getPlaybackUrl(stem.audioSource);
      const container = containerRefs.current[i];

      if (!url || !container) {
        setLoadingStates((prev) => { const n = [...prev]; n[i] = false; return n; });
        return;
      }

      let ws              = null;
      let disposed        = false;
      let fallbackTimer   = null;
      let audioOnlyActive = false;
      let audioOnlyReady  = false;
      const peaksFetch    = resolveStemPeaks(stem.audioSource);

      const markLaneReady = () => {
        setLoadingStates((prev) => { const n = [...prev]; n[i] = false; return n; });
      };

      const markLaneAudioOnly = () => {
        markLaneReady();
        setErrorStates((prev) => {
          const n = [...prev];
          n[i] = "Audio only";
          return n;
        });
      };

      const activateAudioOnly = (reason) => {
        if (disposed || !ws || audioOnlyActive) return;
        audioOnlyActive = true;
        const mediaEl = ws.getMediaElement?.();
        if (!mediaEl) {
          markLaneReady();
          setErrorStates((prev) => { const n = [...prev]; n[i] = "Could not load"; return n; });
          if (i === 0 && !masterReadyFired.current) {
            masterReadyFired.current = true;
            cbRef.current.onReady?.(null);
          }
          return;
        }

        console.warn("[MobileStemStack] lane audio-only fallback", {
          lane: i,
          title: stem.title,
          reason,
        });

        mediaEl.crossOrigin = "anonymous";
        mediaEl.preload = "metadata";
        mediaEl.src = url;
        mediaEl.load();

        const finish = () => {
          if (disposed || audioOnlyReady) return;
          audioOnlyReady = true;
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
          markLaneAudioOnly();
          const duration = finiteDuration(mediaEl.duration || ws.getDuration?.());
          if (i === 0 && !masterReadyFired.current) {
            masterReadyFired.current = true;
            if (duration) cbRef.current.onDurationChange?.(duration);
            cbRef.current.onReady?.(buildMasterControls(wsRefs));
          }
        };

        if (mediaEl.readyState >= 1) {
          finish();
        } else {
          mediaEl.addEventListener("loadedmetadata", finish, { once: true });
          mediaEl.addEventListener("canplay", finish, { once: true });
          fallbackTimer = window.setTimeout(finish, 6_000);
        }
      };

      // Defer one rAF so the flex container finishes layout before WaveSurfer
      // reads container dimensions.
      const rafId = requestAnimationFrame(() => {
        if (disposed || !containerRefs.current[i]) return;
        const laneColor = getStemColor(i);

        ws = WaveSurfer.create({
          container:    containerRefs.current[i],
          backend:      "MediaElement",
          waveColor:    laneColor.wave,
          progressColor: laneColor.progress,
          cursorColor:  "#f5efe3",
          cursorWidth:  2,
          height:       LANE_HEIGHT,
          barWidth:     2,
          barGap:       2,
          barRadius:    2,
          autoScroll:   false,
          autoCenter:   false,
          normalize:    true,
          dragToSeek:   true,
          fillParent:   true,
          pixelRatio:   1,
          minPxPerSec:  1,
        });

        wsRefs.current[i] = ws;
        const mediaEl = ws.getMediaElement?.();
        if (mediaEl) {
          mediaEl.crossOrigin = "anonymous";
          mediaEl.preload = "metadata";
        }

        // ── Ready ─────────────────────────────────────────────────────────
        ws.on("ready", () => {
          if (disposed) return;
          const mediaEl = ws.getMediaElement?.();
          if (mediaEl) { mediaEl.muted = false; mediaEl.volume = 1; }

          markLaneReady();

          // Leader (index 0) surfaces the master transport via onReady.
          if (i === 0 && !masterReadyFired.current) {
            masterReadyFired.current = true;
            cbRef.current.onDurationChange?.(ws.getDuration());
            cbRef.current.onReady?.(buildMasterControls(wsRefs));
          }
        });

        // ── Error ─────────────────────────────────────────────────────────
        ws.on("error", (err) => {
          if (disposed) return;
          console.warn(`[MobileStemStack] lane ${i} ("${stem.title}") error:`, err?.message ?? err);
          activateAudioOnly("waveform-error");
        });

        // ── Leader: drives the shared clock and playback state ─────────────
        if (i === 0) {
          ws.on("timeupdate", (t) => {
            if (disposed) return;
            cbRef.current.onTimeUpdate?.(t);
            // Drift correction: snap followers that have wandered > 80 ms.
            if (ws.isPlaying?.()) {
              wsRefs.current.forEach((w, idx) => {
                if (!w || idx === 0) return;
                if (Math.abs((w.getCurrentTime?.() ?? 0) - t) > DRIFT_THRESHOLD) safeSetTime(w, t);
              });
            }
          });
          ws.on("play",   () => { if (!disposed) cbRef.current.onPlaybackChange?.(true); });
          ws.on("pause",  () => { if (!disposed) cbRef.current.onPlaybackChange?.(false); });
          ws.on("finish", () => { if (!disposed) cbRef.current.onPlaybackChange?.(false); });
        }

        // ── Any lane: user seek → broadcast to all other lanes ─────────────
        ws.on("interaction", (newTime) => {
          if (disposed) return;
          wsRefs.current.forEach((w, idx) => {
            if (w && idx !== i) safeSetTime(w, newTime);
          });
          cbRef.current.onTimeUpdate?.(newTime);
        });

        peaksFetch.then((peaks) => {
          if (disposed || wsRefs.current[i] !== ws) return;
          if (peaks) {
            ws.load(url, peaks).catch((error) => {
              if (disposed) return;
              if (error?.name === "AbortError") return;
              console.warn("[MobileStemStack] ws.load(peaks) failed:", error?.message ?? error);
              activateAudioOnly("peaks-load-error");
            });
            return;
          }

          // Avoid forcing iOS to decode several large stem WAVs at once. If a
          // stem has no prebuilt peaks, keep playback available and mark the lane
          // audio-only instead of risking a global canvas/decode failure.
          activateAudioOnly("missing-peaks");
        });
      });

      cleanups.push(() => {
        disposed = true;
        window.clearTimeout(fallbackTimer);
        cancelAnimationFrame(rafId);
        if (ws) {
          if (wsRefs.current[i] === ws) wsRefs.current[i] = null;
          ws.destroy();
        }
      });
    });

    return () => {
      cleanups.forEach((fn) => fn());
      wsRefs.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stemsKey]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <section className="waveform-panel mobile-stem-stack" aria-label="Stem player">

      {/* REVIEW button — reuses .review-console + .marker-tool-toggle styles.
          order:1 from the existing reviewer-mode CSS puts this above the lanes. */}
      <div className="review-console">
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
          <span className="marker-tool-hint">Tap a stem to place a marker</span>
        )}
      </div>

      {/* Scrollable vertical stack — one row per stem (order:2 from CSS) */}
      <div className="mobile-stem-stack-lanes">
        {stems.map((stem, i) => {
          const laneColor = getStemColor(i);
          return (
            <div
              key={stem.id}
              className={`mobile-stem-stack-lane${isMarkerToolActive ? " marker-mode" : ""}`}
              style={{
                "--stem-wave-color": laneColor.wave,
                "--stem-progress-color": laneColor.progress,
              }}
              onClick={(e) => {
                if (!isMarkerToolActive) return;
                const container = containerRefs.current[i];
                if (!container) return;
                const bounds = container.getBoundingClientRect();
                const ratio  = Math.min(1, Math.max(0, (e.clientX - bounds.left) / bounds.width));
                const dur    = wsRefs.current[0]?.getDuration?.() ?? 0;
                if (dur > 0) {
                  cbRef.current.onMobileNoteRequest?.(ratio * dur);
                  setIsMarkerToolActive(false);
                }
              }}
            >
              <div className="mobile-stem-stack-lane-header">
                <span className="mobile-stem-stack-lane-title">
                  {stem.title || `Stem ${i + 1}`}
                </span>
                {loadingStates[i] && (
                  <span className="mobile-stem-stack-lane-status">Loading…</span>
                )}
                {!loadingStates[i] && errorStates[i] && (
                  <span className="mobile-stem-stack-lane-error">{errorStates[i]}</span>
                )}
              </div>

              {/* WaveSurfer mounts here */}
              <div
                ref={(el) => { containerRefs.current[i] = el; }}
                className="mobile-stem-stack-lane-waveform"
              />
            </div>
          );
        })}
      </div>

    </section>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the master-controls object that is passed to playerRef via onReady.
 * wsRefs is always current (it's a ref), so stems that finish loading after
 * onReady is first called are automatically included in subsequent calls.
 */
function buildMasterControls(wsRefs) {
  const all = () => wsRefs.current.filter(Boolean);
  return {
    play:      async () => { await Promise.allSettled(all().map((ws) => ws.play?.())); },
    pause:     ()       => { all().forEach((ws) => { try { ws.pause?.(); } catch (_) {} }); },
    playPause: async () => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      if (leader.isPlaying?.()) {
        all().forEach((ws) => { try { ws.pause?.(); } catch (_) {} });
      } else {
        await Promise.allSettled(all().map((ws) => ws.play?.()));
      }
    },
    skip: (seconds) => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      const duration = finiteDuration(leader.getDuration?.());
      const next = Math.min(
        Math.max((leader.getCurrentTime?.() || 0) + seconds, 0),
        duration || Infinity,
      );
      all().forEach((ws) => safeSetTime(ws, next));
    },
    seekToTime: (time) => {
      all().forEach((ws) => safeSetTime(ws, time));
    },
  };
}
