import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createDesktopStemAudioEngine } from "../lib/desktopStemAudioEngine.js";
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
  // Stable ref for callbacks so effects never need to re-run on callback identity changes
  const cbRef = useRef({ onReady, onTimeUpdate, onDurationChange, onPlaybackChange });

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
  // Anchor the key to playbackUrl (same as MobileStemStack) so a later
  // previewUrl update after background processing does not cause the entire
  // effect to re-run and destroy already-playing WaveSurfer instances.
  const stemsKey = useMemo(
    () => stems
      .map((s) => `${s.id}:${s.audioSource?.playbackUrl || s.audioSource?.url || ""}`)
      .join("|"),
    [stems],
  );

  useEffect(() => {
    // Reset all state for the new stems set
    setLoadingStates(stems.map(() => true));
    setErrorStates(stems.map(() => ""));
    setDuration(0);
    setCurrentTime(0);
    cbRef.current.onReady(null);
    cbRef.current.onTimeUpdate(0);
    cbRef.current.onDurationChange(0);
    cbRef.current.onPlaybackChange(false);

    const engine = createDesktopStemAudioEngine({
      stems,
      containers: containerRefs.current,
      laneColors: LANE_COLOURS,
      laneHeight: LANE_HEIGHT,
      onLaneReady: (i) => {
        setLoadingStates((prev) => {
          const next = [...prev];
          next[i] = false;
          return next;
        });
      },
      onLaneError: (i, message) => {
        setLoadingStates((prev) => {
          const next = [...prev];
          next[i] = false;
          return next;
        });
        setErrorStates((prev) => {
          const next = [...prev];
          next[i] = message;
          return next;
        });
      },
      onReady: (controls) => cbRef.current.onReady(controls),
      onTimeUpdate: (time) => {
        setCurrentTime(time);
        cbRef.current.onTimeUpdate(time);
      },
      onDurationChange: (nextDuration) => {
        setDuration(nextDuration);
        cbRef.current.onDurationChange(nextDuration);
      },
      onPlaybackChange: (playing) => cbRef.current.onPlaybackChange(playing),
    });

    return () => engine.destroy();
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
