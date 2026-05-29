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

const LANE_HEIGHT = 54; // px per stem waveform row

const LANE_COLOURS = [
  { wave: "#6d6457", progress: "#d6a354" }, // gold   — leader lane
  { wave: "#415869", progress: "#6ea8c8" }, // blue
  { wave: "#416348", progress: "#6eb87a" }, // green
  { wave: "#5e4569", progress: "#b06ec8" }, // purple
  { wave: "#634535", progress: "#c87a5a" }, // orange
  { wave: "#5e5630", progress: "#c8b550" }, // amber
  { wave: "#305f5f", progress: "#50a8a8" }, // teal
  { wave: "#5a3535", progress: "#a85050" }, // red
];
const col = (i) => LANE_COLOURS[i % LANE_COLOURS.length];

/** Max drift (seconds) before a follower is force-synced to the leader. */
const DRIFT_THRESHOLD = 0.08;

// ─────────────────────────────────────────────────────────────────────────────

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
    .map((s) => `${s.id}:${s.audioSource?.playbackUrl || s.audioSource?.url || ""}`)
    .join("|");

  // ── Main effect: create / destroy all WaveSurfer instances ─────────────────
  useEffect(() => {
    masterReadyFired.current = false;
    setLoadingStates(stems.map(() => true));
    setErrorStates(stems.map(() => ""));
    setIsMarkerToolActive(false);
    cbRef.current.onReady?.(null);
    cbRef.current.onTimeUpdate?.(0);
    cbRef.current.onDurationChange?.(0);
    cbRef.current.onPlaybackChange?.(false);

    const cleanups = [];

    stems.forEach((stem, i) => {
      const url       = stem.audioSource?.playbackUrl || stem.audioSource?.url;
      const container = containerRefs.current[i];

      if (!url || !container) {
        setLoadingStates((prev) => { const n = [...prev]; n[i] = false; return n; });
        return;
      }

      let ws       = null;
      let disposed = false;

      // Defer one rAF so the flex container finishes layout before WaveSurfer
      // reads container dimensions.
      const rafId = requestAnimationFrame(() => {
        if (disposed || !containerRefs.current[i]) return;

        ws = WaveSurfer.create({
          container:    containerRefs.current[i],
          url,
          waveColor:    col(i).wave,
          progressColor: col(i).progress,
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
        });

        wsRefs.current[i] = ws;

        // ── Ready ─────────────────────────────────────────────────────────
        ws.on("ready", () => {
          if (disposed) return;
          const mediaEl = ws.getMediaElement?.();
          if (mediaEl) { mediaEl.muted = false; mediaEl.volume = 1; }

          setLoadingStates((prev) => { const n = [...prev]; n[i] = false; return n; });

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
          setLoadingStates((prev) => { const n = [...prev]; n[i] = false; return n; });
          setErrorStates((prev)   => { const n = [...prev]; n[i] = "Could not decode"; return n; });
          if (i === 0 && !masterReadyFired.current) {
            masterReadyFired.current = true;
            cbRef.current.onReady?.(null);
          }
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
                if (Math.abs((w.getCurrentTime?.() ?? 0) - t) > DRIFT_THRESHOLD) w.setTime(t);
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
            if (w && idx !== i) w.setTime(newTime);
          });
          cbRef.current.onTimeUpdate?.(newTime);
        });
      });

      cleanups.push(() => {
        disposed = true;
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
        {stems.map((stem, i) => (
          <div
            key={stem.id}
            className={`mobile-stem-stack-lane${isMarkerToolActive ? " marker-mode" : ""}`}
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
        ))}
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
    play:      async () => { await Promise.allSettled(all().map((ws) => ws.play())); },
    pause:     ()       => { all().forEach((ws) => ws.pause()); },
    playPause: async () => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      if (leader.isPlaying?.()) {
        all().forEach((ws) => ws.pause());
      } else {
        await Promise.allSettled(all().map((ws) => ws.play()));
      }
    },
    skip: (seconds) => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      const next = Math.min(
        Math.max((leader.getCurrentTime?.() || 0) + seconds, 0),
        leader.getDuration?.() || 0,
      );
      all().forEach((ws) => ws.setTime(next));
    },
    seekToTime: (time) => {
      all().forEach((ws) => {
        const dur = ws.getDuration?.() || Infinity;
        ws.setTime(Math.min(Math.max(time, 0), dur));
      });
    },
  };
}
