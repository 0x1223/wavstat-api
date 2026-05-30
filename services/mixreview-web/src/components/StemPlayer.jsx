import { memo, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";

// ── Visual constants ──────────────────────────────────────────────────────────
const LANE_HEIGHT = 72; // px — each stem waveform row

// Distinct wave/progress colour pairs per lane so stems are visually separable
const LANE_COLOURS = [
  { wave: "#6d6457", progress: "#d6a354" }, // gold    — matches the main player
  { wave: "#415869", progress: "#6ea8c8" }, // blue
  { wave: "#416348", progress: "#6eb87a" }, // green
  { wave: "#5e4569", progress: "#b06ec8" }, // purple
  { wave: "#634535", progress: "#c87a5a" }, // orange
  { wave: "#5e5630", progress: "#c8b550" }, // amber
  { wave: "#305f5f", progress: "#50a8a8" }, // teal
  { wave: "#5a3535", progress: "#a85050" }, // red
];
const col = (i) => LANE_COLOURS[i % LANE_COLOURS.length];

// Drift threshold for follower re-sync during playback (seconds).
// Below this, normal clock variance; above it, we force a setTime() correction.
const DRIFT_THRESHOLD = 0.08;

// ── StemPlayer ────────────────────────────────────────────────────────────────
//
// Renders a vertical stack of waveforms, one per stem, all tied to a single
// master timeline. The master transport interface (play / pause / seek / skip)
// is returned via onReady so the existing TransportBar works without changes.
//
// Props
//   stems            – Array<{ id, title, audioSource }>
//   trackTitle       – Display name shown in the mix-strip header
//   selectedTime     – External selected-time value (shown in the gold badge)
//   onReady          – (controls | null) => void  — same interface as WaveformReview
//   onTimeUpdate     – (time: number) => void
//   onDurationChange – (duration: number) => void
//   onPlaybackChange – (isPlaying: boolean) => void

export const StemPlayer = memo(function StemPlayer({
  stems,
  trackTitle,
  selectedTime,
  onReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
}) {
  // One DOM container ref per stem lane — populated by the ref callbacks below
  const containerRefs = useRef([]);
  // WaveSurfer instances indexed by stem position
  const wsRefs = useRef([]);
  // Stable ref for callbacks so effects never need to re-run on callback identity changes
  const cbRef = useRef({ onReady, onTimeUpdate, onDurationChange, onPlaybackChange });
  // Ensures onReady is only fired once per stems set
  const masterReadyFiredRef = useRef(false);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loadingStates, setLoadingStates] = useState(() => stems.map(() => true));
  const [errorStates, setErrorStates] = useState(() => stems.map(() => ""));

  // Keep callback ref current on every render (no-dep effect)
  useEffect(() => {
    cbRef.current = { onReady, onTimeUpdate, onDurationChange, onPlaybackChange };
  });

  // ── Main effect: create / destroy all WaveSurfer instances ─────────────────
  // Re-runs whenever the stems set changes identity (different stem project).
  // Using a stable string key so the effect is immune to object-reference churn.
  const stemsKey = useMemo(
    () => stems
      .map((s) => `${s.id}:${getPlaybackUrl(s.audioSource)}`)
      .join("|"),
    [stems],
  );

  useEffect(() => {
    // Reset all state for the new stems set
    masterReadyFiredRef.current = false;
    setLoadingStates(stems.map(() => true));
    setErrorStates(stems.map(() => ""));
    setDuration(0);
    setCurrentTime(0);
    cbRef.current.onReady(null);
    cbRef.current.onTimeUpdate(0);
    cbRef.current.onDurationChange(0);
    cbRef.current.onPlaybackChange(false);

    const cleanups = [];

    stems.forEach((stem, i) => {
      const url = getPlaybackUrl(stem.audioSource);
      const container = containerRefs.current[i];

      if (!url || !container) {
        // Stem has no audio yet — mark lane as not-loading so it renders idle
        setLoadingStates((prev) => {
          const next = [...prev];
          next[i] = false;
          return next;
        });
        return;
      }

      let ws = null;
      let disposed = false;

      // Stagger creation so large stem sets do not lock the desktop UI.
      let rafId = null;
      const timerId = window.setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          if (disposed || !containerRefs.current[i]) return;

          ws = WaveSurfer.create({
            container: containerRefs.current[i],
            url,
            waveColor: col(i).wave,
            progressColor: col(i).progress,
            cursorColor: "#f5efe3",
            cursorWidth: 2,
            height: LANE_HEIGHT,
            barWidth: 2,
            barGap: 2,
            barRadius: 2,
            autoScroll: false,
            autoCenter: false,
            normalize: true,
            dragToSeek: true,  // native click/drag seek within a lane
            fillParent: true,
          });

          wsRefs.current[i] = ws;

          // ── Ready ────────────────────────────────────────────────────────
          ws.on("ready", () => {
            if (disposed) return;

            const mediaEl = ws.getMediaElement?.();
            if (mediaEl) { mediaEl.muted = false; mediaEl.volume = 1; }

            setLoadingStates((prev) => {
              const next = [...prev];
              next[i] = false;
              return next;
            });

            // The leader (index 0) determines the shared duration and fires
            // the master onReady so the Transport Bar becomes active.
            if (i === 0 && !masterReadyFiredRef.current) {
              masterReadyFiredRef.current = true;
              const dur = ws.getDuration();
              setDuration(dur);
              cbRef.current.onDurationChange(dur);
              cbRef.current.onReady(buildMasterControls(wsRefs));
            }
          });

          // ── Error ────────────────────────────────────────────────────────
          ws.on("error", (err) => {
            if (disposed) return;
            console.warn(`[StemPlayer] Lane ${i} ("${stem.title}") error:`, err?.message ?? err);
            setLoadingStates((prev) => {
              const next = [...prev];
              next[i] = false;
              return next;
            });
            setErrorStates((prev) => {
              const next = [...prev];
              next[i] = "Could not decode";
              return next;
            });
            // Prevent the app from hanging if the leader fails to decode
            if (i === 0 && !masterReadyFiredRef.current) {
              masterReadyFiredRef.current = true;
              cbRef.current.onReady(null);
            }
          });

          // ── Leader-only: clock + playback state ──────────────────────────
          if (i === 0) {
            ws.on("timeupdate", (t) => {
              if (disposed) return;
              setCurrentTime(t);
              cbRef.current.onTimeUpdate(t);
              // Periodic drift correction — snap any follower that has wandered
              // more than DRIFT_THRESHOLD seconds back to the leader's position
              if (ws.isPlaying?.()) {
                wsRefs.current.forEach((w, idx) => {
                  if (!w || idx === 0) return;
                  const ft = w.getCurrentTime?.() ?? 0;
                  if (Math.abs(ft - t) > DRIFT_THRESHOLD) w.setTime(t);
                });
              }
            });

            ws.on("play",   () => { if (!disposed) cbRef.current.onPlaybackChange(true); });
            ws.on("pause",  () => { if (!disposed) cbRef.current.onPlaybackChange(false); });
            ws.on("finish", () => { if (!disposed) cbRef.current.onPlaybackChange(false); });
          }

          // ── Any lane: user seek → broadcast to all other lanes ──────────
          // WaveSurfer fires "interaction" when the user clicks or drags the
          // waveform. We catch it here and seek every other instance to the
          // same position so the playhead stays unified across all stems.
          ws.on("interaction", (newTime) => {
            if (disposed) return;
            wsRefs.current.forEach((w, idx) => {
              if (w && idx !== i) w.setTime(newTime);
            });
            // Drive the shared time display even if this isn't the leader
            setCurrentTime(newTime);
            cbRef.current.onTimeUpdate(newTime);
          });
        });
      }, Math.floor(i / 2) * 50);

      cleanups.push(() => {
        disposed = true;
        window.clearTimeout(timerId);
        if (rafId !== null) cancelAnimationFrame(rafId);
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
    <section className="waveform-panel stem-player" aria-label="Stem player">

      {/* Re-uses the existing .mix-strip + .selected-time styles */}
      <div className="mix-strip">
        <div>
          <p className="eyebrow">Stem Project</p>
          <h2>{trackTitle || "Stems"}</h2>
        </div>
        <span className="selected-time">
          {formatTimecode(selectedTime ?? currentTime)}
        </span>
      </div>

      {/* Vertical stack — one row per stem */}
      <div className="stem-player-lanes">
        {stems.map((stem, i) => (
          <div key={stem.id} className="stem-player-lane">

            <div className="stem-player-lane-header">
              <span className="stem-player-lane-title">
                {stem.title || `Stem ${i + 1}`}
              </span>

              {loadingStates[i] && (
                <span className="stem-player-lane-status">Loading…</span>
              )}
              {!loadingStates[i] && errorStates[i] && (
                <span className="stem-player-lane-error">{errorStates[i]}</span>
              )}
            </div>

            {/* WaveSurfer mounts into this div */}
            <div
              ref={(el) => { containerRefs.current[i] = el; }}
              className="stem-player-lane-waveform"
            />

          </div>
        ))}
      </div>

    </section>
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlaybackUrl(audioSource) {
  return audioSource?.previewUrl || audioSource?.playbackUrl || audioSource?.url || "";
}

// Build the master controls object. wsRefs is always current (it's a ref) so
// all methods automatically include stems that finished loading after onReady.
function buildMasterControls(wsRefs) {
  const all = () => wsRefs.current.filter(Boolean);

  return {
    // play / pause / playPause broadcast to every loaded instance
    play: async () => {
      await Promise.allSettled(all().map((ws) => ws.play()));
    },
    pause: () => {
      all().forEach((ws) => ws.pause());
    },
    playPause: async () => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      if (leader.isPlaying?.()) {
        all().forEach((ws) => ws.pause());
      } else {
        await Promise.allSettled(all().map((ws) => ws.play()));
      }
    },
    // skip advances by ±N seconds from the leader's current position
    skip: (seconds) => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      const next = Math.min(
        Math.max((leader.getCurrentTime?.() || 0) + seconds, 0),
        leader.getDuration?.() || 0,
      );
      all().forEach((ws) => ws.setTime(next));
    },
    // seekToTime is the same seek used by TransportBar prev/next and comment clicks
    seekToTime: (time) => {
      all().forEach((ws) => {
        const dur = ws.getDuration?.() || Infinity;
        ws.setTime(Math.min(Math.max(time, 0), dur));
      });
    },
  };
}
