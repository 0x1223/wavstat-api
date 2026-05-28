import { formatTimecode } from "../lib/time.js";

export function TransportBar({
  currentTime,
  duration,
  isPlaying,
  isDisabled,
  onPlayPause,
  onSkipBackward,
  onSkipForward,
  repeatMode = "off",
  hasPrev = false,
  hasNext = false,
  onPrev,
  onNext,
  onRepeatChange,
}) {
  const repeatSymbol = repeatMode === "one" ? "↺¹" : "↺";
  const repeatTitle =
    repeatMode === "off" ? "Repeat off — click to enable Repeat One" :
    repeatMode === "one" ? "Repeat one — click to enable Repeat All" :
    "Repeat all — click to disable repeat";

  return (
    <footer className="transport" aria-label="Playback controls">
      <div className="transport-time">
        <span>{formatTimecode(currentTime)}</span>
        <span>{formatTimecode(duration)}</span>
      </div>

      <div className="transport-controls">
        <button
          type="button"
          className="transport-nav-btn"
          disabled={isDisabled || !hasPrev}
          onClick={onPrev}
          aria-label="Previous track"
          title="Previous track"
        >
          ⏮
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
          className="transport-nav-btn"
          disabled={isDisabled || !hasNext}
          onClick={onNext}
          aria-label="Next track"
          title="Next track"
        >
          ⏭
        </button>
      </div>

      <div className="transport-nav">
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
          className="skip-button"
          disabled={isDisabled}
          onClick={onSkipForward}
          aria-label="Forward 5 seconds"
        >
          +5
        </button>
        <button
          type="button"
          className={`transport-nav-btn repeat-btn repeat-${repeatMode}`}
          onClick={onRepeatChange}
          aria-label={repeatTitle}
          title={repeatTitle}
        >
          {repeatSymbol}
        </button>
      </div>
    </footer>
  );
}
