import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { formatTimecode } from "../lib/time.js";

export function WaveformReview({
  audioSource,
  comments,
  selectedCommentId,
  selectedTime,
  previewMarkerTime = null,
  trackTitle,
  onTimestampCreate,
  onMarkerSelect,
  onReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
  isReviewerMode = false,
  onMobileNoteRequest
}) {
  const containerRef = useRef(null);
  const wavesurferRef = useRef(null);
  const callbacksRef = useRef({
    onDurationChange,
    onPlaybackChange,
    onReady,
    onTimeUpdate,
    onTimestampCreate,
    onMobileNoteRequest
  });
  const [duration, setDuration] = useState(0);
  const [waveformWidth, setWaveformWidth] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isMarkerToolActive, setIsMarkerToolActive] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);

  useEffect(() => {
    callbacksRef.current = {
      onDurationChange,
      onPlaybackChange,
      onReady,
      onTimeUpdate,
      onTimestampCreate,
      onMobileNoteRequest
    };
  }, [onDurationChange, onMobileNoteRequest, onPlaybackChange, onReady, onTimeUpdate, onTimestampCreate]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    setIsLoading(true);
    setLoadError("");
    setDuration(0);
    setWaveformWidth(getWaveformMetrics(containerRef.current).width);
    callbacksRef.current.onReady(null);
    callbacksRef.current.onTimeUpdate(0);
    callbacksRef.current.onDurationChange(0);
    callbacksRef.current.onPlaybackChange(false);

    let isDisposed = false;
    let hasLoaded = false;
    const playbackUrl = audioSource?.playbackUrl || audioSource?.url;
    if (!playbackUrl) {
      setIsLoading(false);
      callbacksRef.current.onReady(null);
      return undefined;
    }

    console.log("WaveSurfer load start", { playbackUrl });
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      url: playbackUrl,
      waveColor: "#6d6457",
      progressColor: "#d6a354",
      cursorColor: "#f5efe3",
      cursorWidth: 2,
      height: 180,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      autoScroll: false,
      autoCenter: false,
      normalize: true,
      dragToSeek: true,
      fillParent: true
    });

    wavesurferRef.current = wavesurfer;
    const resizeObserver = new ResizeObserver(([entry]) => {
      setWaveformWidth(getWaveformMetrics(entry.target).width);
    });
    resizeObserver.observe(containerRef.current);

    wavesurfer.on("ready", () => {
      if (isDisposed) {
        return;
      }

      hasLoaded = true;
      const audioDuration = wavesurfer.getDuration();
      const mediaElement = wavesurfer.getMediaElement();
      if (mediaElement) {
        mediaElement.muted = false;
        mediaElement.volume = 1;
        mediaElement.preload = "auto";
      }
      console.log("WaveSurfer ready", {
        duration: audioDuration,
        muted: mediaElement?.muted,
        volume: mediaElement?.volume,
        readyState: mediaElement?.readyState
      });
      console.log("WaveSurfer decoded duration", audioDuration);
      setDuration(audioDuration);
      setIsLoading(false);
      callbacksRef.current.onDurationChange(audioDuration);
      callbacksRef.current.onReady({
        wavesurfer,
        mediaElement,
        play: async () => {
          await wavesurfer.play();
          console.log("WaveSurfer play state", { isPlaying: wavesurfer.isPlaying() });
        },
        pause: () => wavesurfer.pause(),
        playPause: async () => {
          await wavesurfer.playPause();
          console.log("WaveSurfer play state", { isPlaying: wavesurfer.isPlaying() });
        },
        skip: (seconds) => wavesurfer.skip(seconds),
        seekToTime: (time) => {
          const nextTime = Math.min(Math.max(time, 0), wavesurfer.getDuration());
          wavesurfer.setTime(nextTime);
          callbacksRef.current.onTimeUpdate(nextTime);
        }
      });
    });

    wavesurfer.on("error", (error) => {
      if (isDisposed || hasLoaded) {
        return;
      }

      console.error("WaveSurfer error", error);
      setIsLoading(false);
      setLoadError("This audio file could not be decoded. Try a WAV, MP3, M4A, or AAC file.");
      callbacksRef.current.onReady(null);
      callbacksRef.current.onDurationChange(0);
      callbacksRef.current.onPlaybackChange(false);
    });

    wavesurfer.on("timeupdate", (time) => {
      if (!isDisposed) {
        callbacksRef.current.onTimeUpdate(time);
      }
    });

    wavesurfer.on("play", () => {
      if (!isDisposed) {
        console.log("WaveSurfer play state", { isPlaying: true });
        callbacksRef.current.onPlaybackChange(true);
      }
    });
    wavesurfer.on("pause", () => {
      if (!isDisposed) {
        console.log("WaveSurfer play state", { isPlaying: false });
        callbacksRef.current.onPlaybackChange(false);
      }
    });
    wavesurfer.on("finish", () => {
      if (!isDisposed) {
        console.log("WaveSurfer play state", { isPlaying: false, finished: true });
        callbacksRef.current.onPlaybackChange(false);
      }
    });

    return () => {
      isDisposed = true;
      if (wavesurferRef.current === wavesurfer) {
        wavesurferRef.current = null;
      }
      wavesurfer.destroy();
      resizeObserver.disconnect();
    };
  }, [audioSource?.playbackUrl, audioSource?.url]);

  function seekToTime(time) {
    const wavesurfer = wavesurferRef.current;
    if (!wavesurfer || duration <= 0) {
      return;
    }

    const nextTime = Math.min(Math.max(time, 0), duration);
    wavesurfer.setTime(nextTime);
    callbacksRef.current.onTimeUpdate(nextTime);
  }

  function handleWaveformClick(event) {
    if (event.target.closest(".wave-marker") || isLoading || loadError || duration <= 0) {
      return;
    }

    const metrics = getWaveformMetrics(containerRef.current);
    if (!metrics.width) {
      return;
    }

    const clickRatio = Math.min(1, Math.max(0, (event.clientX - metrics.left) / metrics.width));
    const clickedTime = clickRatio * duration;
    seekToTime(clickedTime);

    if (isReviewerMode && isMobileViewport()) {
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onMobileNoteRequest?.(clickedTime);
      return;
    }

    if (isMarkerToolActive) {
      callbacksRef.current.onTimestampCreate(clickedTime);
    }
  }

  const hasAudio = Boolean(audioSource?.url);
  const markerItems = duration > 0
    ? [
        ...comments,
        ...(Number.isFinite(previewMarkerTime)
          ? [{
              id: "__mobile-note-preview",
              time: previewMarkerTime,
              resolved: false,
              isPreview: true
            }]
          : [])
      ].map((comment) => ({
        ...comment,
        left:
          duration > 0 && waveformWidth > 0
            ? `${Math.min(waveformWidth, Math.max(0, (comment.time / duration) * waveformWidth))}px`
            : "0px"
      }))
    : [];

  const timelineLabels = duration > 0 ? getTimelineLabels(duration) : [];

  return (
    <section className="waveform-panel" aria-label="Waveform review">
      {hasAudio && (
        <div className="mix-strip">
          <div>
            <p className="eyebrow">Stereo Mix</p>
            <h2>{trackTitle || "Uploaded audio review pass"}</h2>
          </div>
          <span className="selected-time">{formatTimecode(selectedTime)}</span>
        </div>
      )}

      {timelineLabels.length > 0 && (
        <div className="timeline">
          {timelineLabels.map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
      )}

        <div
  className="waveform-stage">
  {hasAudio && isLoading && <div className="loading-waveform">Preparing waveform</div>}
  {hasAudio && loadError && <div className="waveform-error">{loadError}</div>}

  <div
  ref={containerRef}
  className="waveform"
  onTouchMove={(event) => {
    const touch = event.changedTouches?.[0];
    if (!touch || !containerRef.current || !duration) return;

    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (touch.clientX - rect.left) / rect.width)
    );

    const nextTime = ratio * duration;

    seekToTime(nextTime);
  }}
/>
        {duration > 0 && (
          <div className="marker-layer">
            {markerItems.map((comment) => (
              <button
                type="button"
                className={`wave-marker${comment.resolved ? " resolved" : ""}${
                  comment.id === selectedCommentId ? " selected" : ""
                }${comment.isPreview ? " preview" : ""}`}
                key={comment.id}
                data-time={formatTimecode(comment.time)}
                style={{ left: comment.left }}
                aria-label={`Go to comment at ${formatTimecode(comment.time)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  seekToTime(comment.time);
                  if (!comment.isPreview) {
                    onMarkerSelect(comment, { autoplay: true });
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {duration > 0 && (
        <div className="review-console">
          <button
  type="button"
  className={`marker-tool-toggle${isMarkerToolActive ? " active" : ""}`}
  aria-pressed={isMarkerToolActive}
  aria-label="Add timestamp note mode"
  title="Add timestamp note mode"
  onClick={() => setIsMarkerToolActive((current) => !current)}
          >
            <span aria-hidden="true">✍️</span>
<span className="tool-label">Review</span>
          </button>
        </div>
      )}
    </section>
  );
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 768px)")?.matches || window.innerWidth <= 768;
}

function getWaveformMetrics(element) {
  if (!element) {
    return { left: 0, width: 0 };
  }

  const bounds = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const width = Math.max(0, bounds.width - paddingLeft - paddingRight);

  return {
    left: bounds.left + paddingLeft,
    width
  };
}

function getTimelineLabels(duration) {
  const safeDuration = duration > 0 ? duration : 45;
  return [0, 0.33, 0.66, 1].map((position) =>
    formatTimecode(safeDuration * position).replace(/\.\d$/, ""),
  );
}
