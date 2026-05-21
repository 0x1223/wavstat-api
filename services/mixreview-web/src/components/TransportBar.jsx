import { formatTimecode } from "../lib/time.js";

// Map a dB value to a 0–100 fill percentage over a given range.
function dbToFill(str, lo, hi) {
  const n = parseFloat(str);
  if (!isFinite(n)) return 0;
  return Math.min(100, Math.max(0, ((n - lo) / (hi - lo)) * 100));
}

export function TransportBar({
  currentTime,
  duration,
  isPlaying,
  isDisabled,
  onPlayPause,
  onSkipBackward,
  onSkipForward,
  loudnessMeta = null
}) {
  return (
    <footer className="transport" aria-label="Playback controls">
      <div className="transport-time">
        <span>{formatTimecode(currentTime)}</span>
        <span>{formatTimecode(duration)}</span>
      </div>

      <div className="transport-controls">
        <button
          type="button"
          className="skip-button"
          disabled={isDisabled}
          onClick={onSkipBackward}
          aria-label="Back 5 seconds"
        >
          -5
        </button>
        <button
          type="button"
          className="play-button"
          disabled={isDisabled}
          onClick={onPlayPause}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          <span className={isPlaying ? "pause-icon" : "play-icon"} />
          <span>{isPlaying ? "Pause" : "Play"}</span>
        </button>
        <button
          type="button"
          className="skip-button"
          disabled={isDisabled}
          onClick={onSkipForward}
          aria-label="Forward 5 seconds"
        >
          +5
        </button>
      </div>

      <div className="transport-meta">
        <span>44.1 kHz</span>
        <span>24-bit</span>
        <span>Local audio</span>
      </div>

      {loudnessMeta && (
        <div className="transport-loudness-meters" aria-label="Loudness metrics">
          {/* LUFS — bar + value */}
          <div className="transport-loudness-row">
            <span className="transport-loudness-label">LUFS</span>
            <span className="transport-loudness-bar">
              <span
                className="transport-loudness-fill"
                style={{ "--meter-fill": `${dbToFill(loudnessMeta.lufs, -40, 0).toFixed(1)}%` }}
              />
            </span>
            <span className="transport-loudness-value">{loudnessMeta.lufs}</span>
          </div>
          {/* LRA — value only */}
          <div className="transport-loudness-row lra">
            <span className="transport-loudness-label">LRA</span>
            <span className="transport-loudness-bar" />
            <span className="transport-loudness-value">{loudnessMeta.lra}</span>
          </div>
          {/* TP — bar + value */}
          <div className="transport-loudness-row">
            <span className="transport-loudness-label">TP</span>
            <span className="transport-loudness-bar">
              <span
                className="transport-loudness-fill"
                style={{ "--meter-fill": `${dbToFill(loudnessMeta.tp, -40, 0).toFixed(1)}%` }}
              />
            </span>
            <span className="transport-loudness-value">{loudnessMeta.tp}</span>
          </div>
        </div>
      )}
    </footer>
  );
}
