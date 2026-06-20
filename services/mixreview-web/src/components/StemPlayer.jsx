import { memo, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { apiUrl } from "../config/api.js";
import { getStemColor } from "../lib/stemColors.js";
import { formatTimecode } from "../lib/time.js";

// ── Visual constants ──────────────────────────────────────────────────────────
const LANE_HEIGHT = 72; // px — each stem waveform row

// Drift threshold for follower re-sync during playback (seconds).
// Below this, normal clock variance; above it, we force a setTime() correction.
const DRIFT_THRESHOLD = 0.08;
const STEM_PEAKS_FETCH_TIMEOUT_MS = 5_000;
const STEM_PEAKS_RETRY_MS = 12_000;
const STEM_PEAKS_RETRY_LIMIT_MS = 90_000;
const stemPeaksCache = new Map();

function normalizePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) {
    return null;
  }
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

function fetchPeaks(peaksUrl, timeoutMs = STEM_PEAKS_FETCH_TIMEOUT_MS) {
  if (!peaksUrl) {
    return Promise.resolve(null);
  }
  if (stemPeaksCache.has(peaksUrl)) {
    return Promise.resolve(stemPeaksCache.get(peaksUrl));
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

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
        console.warn("[StemPlayer] Peaks fetch failed", error.message);
      }
      return null;
    })
    .finally(() => window.clearTimeout(timeoutId));
}

function resolveStemPeaks(audioSource) {
  const urls = getStemPeakUrls(audioSource);
  if (urls.length === 0) return Promise.resolve(null);
  return urls.reduce(
    (chain, peaksUrl) => chain.then((peaks) => peaks ?? fetchPeaks(peaksUrl)),
    Promise.resolve(null),
  );
}

function finiteDuration(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

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
  const requestedPlayingRef = useRef(false);
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
      .map((s) => `${s.id}:${getPlaybackUrl(s.audioSource)}:${s.audioSource?.peaksUrl || ""}:${s.audioSource?.key || ""}`)
      .join("|"),
    [stems],
  );

  useEffect(() => {
    // Reset all state for the new stems set
    masterReadyFiredRef.current = false;
    requestedPlayingRef.current = false;
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
      let loadStarted = false;
      let fallbackTimer = null;
      let latePeaksTimer = null;
      let audioOnlyActive = false;
      let audioOnlyReady = false;
      const peaksFetch = resolveStemPeaks(stem.audioSource);

      const markLaneReady = () => {
        setLoadingStates((prev) => {
          const next = [...prev];
          next[i] = false;
          return next;
        });
      };

      const setLaneStatus = (status) => {
        setErrorStates((prev) => {
          const next = [...prev];
          next[i] = status;
          return next;
        });
      };

      const syncAndMaybeStartFollower = () => {
        if (!requestedPlayingRef.current || i === 0 || !wsRefs.current[0]?.isPlaying?.()) return;
        const leaderTime = wsRefs.current[0].getCurrentTime?.() || 0;
        ws?.setTime?.(leaderTime);
        ws?.play?.().catch((error) => {
          if (!disposed) console.warn(`[StemPlayer] Lane ${i} late-start failed:`, error?.message ?? error);
        });
      };

      const activateAudioOnly = (reason) => {
        if (disposed || !ws || audioOnlyActive) return;
        audioOnlyActive = true;
        const mediaEl = ws.getMediaElement?.();
        if (!mediaEl) {
          markLaneReady();
          setLaneStatus("Could not load");
          if (i === 0 && !masterReadyFiredRef.current) {
            masterReadyFiredRef.current = true;
            cbRef.current.onReady(null);
          }
          return;
        }

        console.warn("[StemPlayer] Lane audio-only fallback", {
          lane: i,
          title: stem.title,
          reason,
        });

        mediaEl.crossOrigin = "anonymous";
        mediaEl.preload = "metadata";
        if (mediaEl.src !== url) {
          mediaEl.src = url;
        }
        mediaEl.load();

        const finish = () => {
          if (disposed || audioOnlyReady) return;
          audioOnlyReady = true;
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
          markLaneReady();
          setLaneStatus("Wave pending");
          syncAndMaybeStartFollower();

          const dur = finiteDuration(mediaEl.duration || ws.getDuration?.());
          if (i === 0 && !masterReadyFiredRef.current) {
            masterReadyFiredRef.current = true;
            if (dur) {
              setDuration(dur);
              cbRef.current.onDurationChange(dur);
            }
            cbRef.current.onReady(buildMasterControls(wsRefs, requestedPlayingRef));
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

      const scheduleLatePeaksRetry = () => {
        if (latePeaksTimer !== null) return;
        const deadline = Date.now() + STEM_PEAKS_RETRY_LIMIT_MS;
        const retry = () => {
          latePeaksTimer = null;
          if (disposed || !ws || Date.now() > deadline) return;
          resolveStemPeaks(stem.audioSource).then((peaks) => {
            if (disposed || !ws || wsRefs.current[i] !== ws) return;
            if (!peaks) {
              latePeaksTimer = window.setTimeout(retry, STEM_PEAKS_RETRY_MS);
              return;
            }

            const mediaEl = ws.getMediaElement?.();
            const restoreTime = ws.getCurrentTime?.() || mediaEl?.currentTime || 0;
            const shouldResume = requestedPlayingRef.current && (i === 0 || wsRefs.current[0]?.isPlaying?.());
            loadStarted = true;
            ws.load(url, peaks)
              .then(() => {
                if (disposed) return;
                audioOnlyActive = false;
                audioOnlyReady = false;
                if (restoreTime > 0) ws.setTime(restoreTime);
                setLaneStatus("");
                if (shouldResume) {
                  ws.play().catch((error) => {
                    if (!disposed) console.warn(`[StemPlayer] Lane ${i} resume after peaks failed:`, error?.message ?? error);
                  });
                }
              })
              .catch((error) => {
                if (disposed || error?.name === "AbortError") return;
                console.warn(`[StemPlayer] Lane ${i} late peaks load failed:`, error?.message ?? error);
              });
          });
        };
        latePeaksTimer = window.setTimeout(retry, STEM_PEAKS_RETRY_MS);
      };

      // Stagger creation so large stem sets do not lock the desktop UI.
      let rafId = null;
      const timerId = window.setTimeout(() => {
        rafId = requestAnimationFrame(() => {
          if (disposed || !containerRefs.current[i]) return;
          const laneColor = getStemColor(i);

          ws = WaveSurfer.create({
            container: containerRefs.current[i],
            backend: "MediaElement",
            waveColor: laneColor.wave,
            progressColor: laneColor.progress,
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
            pixelRatio: 1,
            minPxPerSec: 1,
          });

          wsRefs.current[i] = ws;

          // ── Ready ────────────────────────────────────────────────────────
          ws.on("ready", () => {
            if (disposed) return;

            const mediaEl = ws.getMediaElement?.();
            if (mediaEl) { mediaEl.muted = false; mediaEl.volume = 1; mediaEl.preload = "metadata"; }

            window.clearTimeout(latePeaksTimer);
            latePeaksTimer = null;
            audioOnlyActive = false;
            audioOnlyReady = false;
            markLaneReady();
            setLaneStatus("");

            // The leader (index 0) determines the shared duration and fires
            // the master onReady so the Transport Bar becomes active.
            if (i === 0 && !masterReadyFiredRef.current) {
              masterReadyFiredRef.current = true;
              const dur = ws.getDuration();
              setDuration(dur);
              cbRef.current.onDurationChange(dur);
              cbRef.current.onReady(buildMasterControls(wsRefs, requestedPlayingRef));
            } else if (requestedPlayingRef.current && wsRefs.current[0]?.isPlaying?.()) {
              const leaderTime = wsRefs.current[0].getCurrentTime?.() || 0;
              ws.setTime(leaderTime);
              ws.play().catch((error) => {
                if (!disposed) console.warn(`[StemPlayer] Lane ${i} late-start failed:`, error?.message ?? error);
              });
            }
          });

          // ── Error ────────────────────────────────────────────────────────
          ws.on("error", (err) => {
            if (disposed) return;
            console.warn(`[StemPlayer] Lane ${i} ("${stem.title}") error:`, err?.message ?? err);
            activateAudioOnly("waveform-error");
            scheduleLatePeaksRetry();
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

            ws.on("play",   () => { if (!disposed) { requestedPlayingRef.current = true; cbRef.current.onPlaybackChange(true); } });
            ws.on("pause",  () => { if (!disposed) { requestedPlayingRef.current = false; cbRef.current.onPlaybackChange(false); } });
            ws.on("finish", () => { if (!disposed) { requestedPlayingRef.current = false; cbRef.current.onPlaybackChange(false); } });
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

          peaksFetch.then((peaks) => {
            if (disposed || !ws || loadStarted) return;
            loadStarted = true;
            if (!peaks) {
              activateAudioOnly("missing-peaks");
              scheduleLatePeaksRetry();
              return;
            }

            ws.load(url, peaks).catch((error) => {
              if (disposed || error?.name === "AbortError") return;
              console.warn(`[StemPlayer] Lane ${i} ("${stem.title}") load failed:`, error?.message ?? error);
              activateAudioOnly("peaks-load-error");
              scheduleLatePeaksRetry();
            });
          });
        });
      }, Math.floor(i / 2) * 50);

      cleanups.push(() => {
        disposed = true;
        window.clearTimeout(timerId);
        window.clearTimeout(fallbackTimer);
        window.clearTimeout(latePeaksTimer);
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (ws) {
          if (wsRefs.current[i] === ws) wsRefs.current[i] = null;
          ws.pause?.();
          ws.unAll?.();
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
        {stems.map((stem, i) => {
          const laneColor = getStemColor(i);
          return (
            <div
              key={stem.id}
              className="stem-player-lane"
              style={{
                "--stem-wave-color": laneColor.wave,
                "--stem-progress-color": laneColor.progress,
              }}
            >

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
          );
        })}
      </div>

    </section>
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlaybackUrl(audioSource) {
  return audioSource?.previewUrl || audioSource?.playbackUrl || audioSource?.audioUrl || audioSource?.url || "";
}

// Build the master controls object. wsRefs is always current (it's a ref) so
// all methods automatically include stems that finished loading after onReady.
function buildMasterControls(wsRefs, requestedPlayingRef) {
  const all = () => wsRefs.current.filter(Boolean);

  return {
    // play / pause / playPause broadcast to every loaded instance
    play: async () => {
      requestedPlayingRef.current = true;
      await Promise.allSettled(all().map((ws) => ws.play()));
    },
    pause: () => {
      requestedPlayingRef.current = false;
      all().forEach((ws) => ws.pause());
    },
    playPause: async () => {
      const leader = wsRefs.current[0];
      if (!leader) return;
      if (leader.isPlaying?.()) {
        requestedPlayingRef.current = false;
        all().forEach((ws) => ws.pause());
      } else {
        requestedPlayingRef.current = true;
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
