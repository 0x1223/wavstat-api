import WaveSurfer from "wavesurfer.js";

const STATIC_WAVEFORM_CURVE = [0.15, 0.2, 0.35, 0.5, 0.65, 0.75, 0.8, 0.72, 0.6, 0.45, 0.35, 0.4, 0.55, 0.7, 0.85, 0.9, 0.82, 0.68, 0.5, 0.3, 0.2, 0.15];

function buildStaticPeaks(length = 240) {
  return [Array.from({ length }, (_, i) => STATIC_WAVEFORM_CURVE[i % STATIC_WAVEFORM_CURVE.length])];
}

function normalizePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) return null;
  return Array.isArray(peaks[0]) ? peaks : [peaks];
}

function fetchPeaks(peaksUrl, timeoutMs = 700) {
  if (!peaksUrl) return Promise.resolve(null);

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  return fetch(peaksUrl, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(normalizePeaks)
    .catch((error) => {
      if (error?.name !== "AbortError") {
        console.warn("[DesktopStemEngine] Peaks fetch failed; using static preview", error.message);
      }
      return null;
    })
    .finally(() => window.clearTimeout(timeoutId));
}

function getStemUrl(stem) {
  return stem?.audioSource?.playbackUrl || stem?.audioSource?.url || stem?.audioSource?.previewUrl || "";
}

function getStemDuration(stem, fallbackDuration) {
  const duration = Number(stem?.audioSource?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : fallbackDuration || undefined;
}

function releaseMediaElement(mediaEl) {
  if (!mediaEl) return;
  try {
    mediaEl.pause();
    mediaEl.removeAttribute("src");
    mediaEl.load();
  } catch {
    // Best-effort cleanup. WaveSurfer.destroy() still follows.
  }
}

export function createDesktopStemAudioEngine({
  stems,
  containers,
  laneColors,
  laneHeight,
  onLaneReady,
  onLaneError,
  onReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
}) {
  let disposed = false;
  let requestedPlaying = false;
  let masterReadyFired = false;
  let currentTime = 0;
  const wsRefs = [];
  const mediaRefs = [];
  const cleanupFns = [];
  const sharedDuration = Math.max(0, ...stems.map((stem) => Number(stem?.audioSource?.duration) || 0));

  const activeMedia = () => mediaRefs.filter(Boolean);
  const leaderMedia = () => mediaRefs[0] || null;
  const leaderWaveSurfer = () => wsRefs[0] || null;

  function clampTime(time, duration = sharedDuration) {
    return Math.min(Math.max(Number(time) || 0, 0), duration || Number.POSITIVE_INFINITY);
  }

  function setAllTimes(time) {
    const nextTime = clampTime(time);
    currentTime = nextTime;
    activeMedia().forEach((mediaEl) => {
      try { mediaEl.currentTime = clampTime(nextTime, mediaEl.duration); } catch {}
    });
    wsRefs.forEach((ws) => {
      try { ws?.setTime?.(nextTime); } catch {}
    });
    onTimeUpdate(nextTime);
  }

  function buildControls() {
    return {
      wavesurfer: leaderWaveSurfer(),
      mediaElement: leaderMedia(),
      play: async () => {
        requestedPlaying = true;
        const leader = leaderMedia();
        const leaderTime = leader?.currentTime ?? currentTime;
        activeMedia().forEach((mediaEl) => {
          if (Math.abs((mediaEl.currentTime || 0) - leaderTime) > 0.08) {
            try { mediaEl.currentTime = clampTime(leaderTime, mediaEl.duration); } catch {}
          }
        });
        await Promise.allSettled(activeMedia().map((mediaEl) => mediaEl.play()));
      },
      pause: () => {
        requestedPlaying = false;
        activeMedia().forEach((mediaEl) => mediaEl.pause());
      },
      playPause: async () => {
        const leader = leaderMedia();
        if (leader && !leader.paused && !leader.ended) {
          requestedPlaying = false;
          activeMedia().forEach((mediaEl) => mediaEl.pause());
          return;
        }
        requestedPlaying = true;
        await Promise.allSettled(activeMedia().map((mediaEl) => mediaEl.play()));
      },
      skip: (seconds) => {
        const leader = leaderMedia();
        setAllTimes((leader?.currentTime ?? currentTime) + seconds);
      },
      seekToTime: setAllTimes,
    };
  }

  function fireReady(index, ws, mediaEl) {
    onLaneReady(index);

    if (index !== 0 || masterReadyFired) {
      if (requestedPlaying && leaderMedia() && mediaEl) {
        try { mediaEl.currentTime = leaderMedia().currentTime || 0; } catch {}
        mediaEl.play().catch(() => {});
      }
      return;
    }

    masterReadyFired = true;
    const duration = Number.isFinite(mediaEl?.duration) && mediaEl.duration > 0
      ? mediaEl.duration
      : ws.getDuration?.() || sharedDuration || 0;
    onDurationChange(duration);
    onReady(buildControls());
  }

  stems.forEach((stem, index) => {
    const container = containers[index];
    const url = getStemUrl(stem);
    if (!container || !url) {
      onLaneReady(index);
      return;
    }

    let ws = null;
    let rafId = null;
    let laneDisposed = false;
    const color = laneColors[index % laneColors.length];
    const timerId = window.setTimeout(() => {
      rafId = requestAnimationFrame(() => {
        if (disposed || laneDisposed || !containers[index]) return;

        ws = WaveSurfer.create({
          container: containers[index],
          backend: "MediaElement",
          waveColor: color.wave,
          progressColor: color.progress,
          cursorColor: "#f5efe3",
          cursorWidth: 2,
          height: laneHeight,
          barWidth: 2,
          barGap: 2,
          barRadius: 2,
          autoScroll: false,
          autoCenter: false,
          normalize: true,
          dragToSeek: true,
          fillParent: true,
          pixelRatio: 1,
          minPxPerSec: 1,
        });

        wsRefs[index] = ws;

        ws.on("ready", () => {
          if (disposed || laneDisposed) return;
          const mediaEl = ws.getMediaElement?.();
          if (!mediaEl) {
            onLaneError(index, "Could not load");
            return;
          }
          mediaEl.muted = false;
          mediaEl.volume = 1;
          mediaEl.preload = "auto";
          mediaRefs[index] = mediaEl;

          const onPlaying = () => {
            if (index === 0 && !disposed) onPlaybackChange(true);
          };
          const onPause = () => {
            if (index === 0 && !disposed) onPlaybackChange(false);
          };
          const onNativeTimeUpdate = () => {
            if (index !== 0 || disposed) return;
            currentTime = mediaEl.currentTime || 0;
            onTimeUpdate(currentTime);
          };
          mediaEl.addEventListener("playing", onPlaying);
          mediaEl.addEventListener("pause", onPause);
          mediaEl.addEventListener("ended", onPause);
          mediaEl.addEventListener("waiting", onPause);
          mediaEl.addEventListener("timeupdate", onNativeTimeUpdate);
          cleanupFns.push(() => {
            mediaEl.removeEventListener("playing", onPlaying);
            mediaEl.removeEventListener("pause", onPause);
            mediaEl.removeEventListener("ended", onPause);
            mediaEl.removeEventListener("waiting", onPause);
            mediaEl.removeEventListener("timeupdate", onNativeTimeUpdate);
          });

          fireReady(index, ws, mediaEl);
        });

        ws.on("error", (error) => {
          if (disposed || laneDisposed) return;
          console.warn(`[DesktopStemEngine] Lane ${index} failed`, error?.message ?? error);
          onLaneError(index, "Could not decode");
          if (index === 0 && !masterReadyFired) {
            masterReadyFired = true;
            onReady(null);
          }
        });

        ws.on("interaction", (newTime) => {
          if (disposed || laneDisposed) return;
          setAllTimes(newTime);
        });

        fetchPeaks(stem.audioSource?.peaksUrl || "").then((peaks) => {
          if (disposed || laneDisposed || !ws) return;
          const resolvedPeaks = peaks || buildStaticPeaks();
          ws.load(url, resolvedPeaks, getStemDuration(stem, sharedDuration)).catch((error) => {
            if (disposed || laneDisposed) return;
            console.warn(`[DesktopStemEngine] Lane ${index} load failed`, error?.message ?? error);
            onLaneError(index, "Could not load");
            if (index === 0 && !masterReadyFired) {
              masterReadyFired = true;
              onReady(null);
            }
          });
        });
      });
    }, Math.floor(index / 2) * 50);

    cleanupFns.push(() => {
      laneDisposed = true;
      window.clearTimeout(timerId);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (ws) {
        if (wsRefs[index] === ws) wsRefs[index] = null;
        releaseMediaElement(ws.getMediaElement?.());
        ws.unAll?.();
        ws.destroy();
      }
    });
  });

  return {
    destroy() {
      disposed = true;
      requestedPlaying = false;
      onPlaybackChange(false);
      cleanupFns.forEach((fn) => fn());
      wsRefs.length = 0;
      mediaRefs.length = 0;
    },
  };
}
