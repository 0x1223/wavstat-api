import { formatTimecode } from "../lib/time.js";

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
        <div className="transport-loudness" aria-label="Loudness metrics">
          <div className="transport-loudness-row">
            <span className="transport-loudness-label">LUFS</span>
            <span className="transport-loudness-value">{loudnessMeta.lufs}</span>
          </div>
          <div className="transport-loudness-row">
            <span className="transport-loudness-label">LRA</span>
            <span className="transport-loudness-value">{loudnessMeta.lra}</span>
          </div>
          <div className="transport-loudness-row">
            <span className="transport-loudness-label">TP</span>
            <span className="transport-loudness-value">{loudnessMeta.tp}</span>
          </div>
        </div>
      )}
    </footer>
  );
}
