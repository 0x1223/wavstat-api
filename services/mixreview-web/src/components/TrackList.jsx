import { useEffect, useRef, useState, useMemo, memo, useCallback } from "react";
import { getStemColor } from "../lib/stemColors.js";
import { apiUrl } from "../config/api.js";

const AUDIO_ACCEPT = [
  ".flac",
  ".aiff",
  ".aif",
  ".alac",
  ".wav",
  ".w64",
  ".mp3",
  ".aac",
  ".m4a",
  ".ogg",
  ".opus",
  ".wma",
  "audio/*",
].join(",");

const INITIAL_RENDERED_TRACKS = 14;
const RENDERED_TRACK_BATCH = 12;

// 500 bars so the waveform fills the lane at any column width; overflow:hidden clips the rest.
const WAVEFORM_BAR_COUNT = 500;
// ── Real peak preview cache ───────────────────────────────────────────────────
// Module-level so cached data survives re-renders and session switches without
// re-fetching. Keyed by peaksUrl. Value is normalized float[] (0-1) or null.
const previewPeaksCache = new Map();
let previewDecodeAudioContext = null;

function getPreviewPlaybackUrl(audioSource) {
  return audioSource?.previewUrl || audioSource?.playbackUrl || audioSource?.audioUrl || audioSource?.url || "";
}

function getPreviewPeakUrls(audioSource) {
  const urls = [];
  if (audioSource?.peaksUrl) urls.push(audioSource.peaksUrl);
  if (audioSource?.key) urls.push(apiUrl(`/api/audio/playback/${encodeURIComponent(`${audioSource.key}.peaks.json`)}`));
  return [...new Set(urls)];
}

function normalizePreviewPeaks(raw) {
  const channel = Array.isArray(raw?.[0]) ? raw[0] : raw;
  if ((!Array.isArray(channel) && !ArrayBuffer.isView(channel)) || channel.length === 0) return null;

  const step = Math.max(1, channel.length / WAVEFORM_BAR_COUNT);
  const heights = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => {
    const start = Math.floor(i * step);
    const end   = Math.max(start + 1, Math.min(Math.ceil((i + 1) * step), channel.length));
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(channel[j] || 0));
    return peak;
  });

  const maxH = Math.max(...heights, 0.001);
  return heights.map((h) => h / maxH);
}

function getPreviewAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!previewDecodeAudioContext) previewDecodeAudioContext = new AudioCtx();
  return previewDecodeAudioContext;
}

function loadPreviewPeaks(peaksUrl) {
  if (!peaksUrl) return Promise.resolve(null);
  if (previewPeaksCache.has(peaksUrl)) return Promise.resolve(previewPeaksCache.get(peaksUrl));

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 3000);

  return fetch(peaksUrl, { signal: controller.signal })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((raw) => {
      const normalized = normalizePreviewPeaks(raw);
      if (!normalized) return null;
      previewPeaksCache.set(peaksUrl, normalized);
      return normalized;
    })
    .catch(() => {
      return null;
    })
    .finally(() => window.clearTimeout(timeoutId));
}

async function decodePreviewPeaks(audioUrl) {
  if (!audioUrl) return null;
  const cacheKey = `decode:${audioUrl}`;
  if (previewPeaksCache.has(cacheKey)) return previewPeaksCache.get(cacheKey);

  const audioContext = getPreviewAudioContext();
  if (!audioContext) return null;

  // 30 s gives large stems (100 MB+ WAV) enough headroom to download and decode.
  // Previously 15 s — too short for slow connections or high-CPU decodes.
  const DECODE_TIMEOUT_MS = 30_000;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
    console.warn("[TrackList] Preview decode timed out — keeping synthetic waveform", {
      url: audioUrl.slice(0, 120),
      timeout: `${DECODE_TIMEOUT_MS / 1000}s`,
    });
  }, DECODE_TIMEOUT_MS);

  console.log("[TrackList] Preview decode start (no peaks JSON found)", {
    url: audioUrl.slice(0, 120),
  });

  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    const channelData = audioBuffer.getChannelData(0);
    const normalized = normalizePreviewPeaks(channelData);
    if (normalized) previewPeaksCache.set(cacheKey, normalized);
    console.log("[TrackList] Preview decode success", { url: audioUrl.slice(0, 80) });
    return normalized;
  } catch (err) {
    if (!timedOut) {
      console.warn("[TrackList] Preview decode failed — keeping synthetic waveform", {
        url: audioUrl.slice(0, 120),
        error: err?.message,
      });
    }
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function hexToRgb(hex) {
  const h = (hex || "#d6a354").replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// ── Peak column cache ─────────────────────────────────────────────────────────
// Keyed by bars array identity (WeakMap) so entries are GC'd automatically when
// a track's bars array is released. The inner Map stores per-width Float32Arrays
// so the expensive bars→columns reduction runs exactly once per (bars, width)
// pair regardless of how many RAF or ResizeObserver callbacks fire.
const columnCache = new WeakMap();

function getOrComputePeakColumns(bars, W) {
  const wKey = Math.round(W);
  let widthMap = columnCache.get(bars);
  if (!widthMap) {
    widthMap = new Map();
    columnCache.set(bars, widthMap);
  }
  if (widthMap.has(wKey)) return widthMap.get(wKey);

  const colPx    = 2;
  const colCount = Math.ceil(W / colPx);
  const srcStep  = bars.length / colCount;
  const cols     = new Float32Array(colCount);

  for (let col = 0; col < colCount; col += 1) {
    const s = Math.floor(col * srcStep);
    const e = Math.min(bars.length, Math.ceil((col + 1) * srcStep));
    let peak = 0;
    for (let i = s; i < e; i += 1) {
      const v = Number.isFinite(bars[i]) ? Math.abs(bars[i]) : 0;
      if (v > peak) peak = v;
    }
    cols[col] = peak;
  }

  // Cap to 8 widths per bars array — a lane rarely resizes to more than a few
  // distinct pixel widths, so this bounds memory without any real eviction cost.
  if (widthMap.size >= 8) widthMap.delete(widthMap.keys().next().value);
  widthMap.set(wKey, cols);
  return cols;
}

function drawWaveformOnCanvas(canvas, bars, color) {
  // Strict DOM guard — canvas may be mid-unmount during a rapid track reorder.
  // canvas.getContext check confirms the element is still a live canvas node;
  // parentElement check confirms it is still attached to the layout tree.
  if (!canvas || !canvas.getContext || !canvas.parentElement) return;
  if (!bars?.length) return;

  const parent = canvas.parentElement;
  let W = (parent ? parent.clientWidth  : canvas.clientWidth)  || 0;
  let H = (parent ? parent.clientHeight : canvas.clientHeight) || 0;

  // Safari: clientWidth/Height can return 0 for newly-mounted absolutely-
  // positioned elements before the first composited paint. Fall back to
  // getBoundingClientRect which reads the actual rendered geometry.
  if (W === 0 || H === 0) {
    const rect = (parent || canvas).getBoundingClientRect();
    W = rect.width  || 0;
    H = rect.height || 0;
  }

  // Still zero — layout isn't committed yet. Schedule one retry on the next
  // animation frame. Re-check the DOM guard first so a detached canvas from
  // a concurrent reorder does not start an infinite retry loop.
  if (W <= 0 || H <= 0) {
    requestAnimationFrame(() => {
      if (canvas.parentElement) drawWaveformOnCanvas(canvas, bars, color);
    });
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw  = Math.round(W * dpr);
  const ph  = Math.round(H * dpr);

  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width  = pw;
    canvas.height = ph;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // ctx.save/scale/restore is more reliable than setTransform in Safari
  // when the canvas backing buffer has just been resized — setTransform can
  // silently no-op in some Safari versions immediately after a resize.
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const [r, g, b] = hexToRgb(color);
  const cy      = H / 2;
  const maxHalf = H * 0.34; // ±34 % → 68 % total waveform height

  // Soft elliptical halo — track color radiates outward from lane center.
  // We translate+scale to turn a circular radialGradient into a lane-shaped
  // ellipse that fills the full width without any horizontal clipping.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(W / H, 1);
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, H * 0.6);
  halo.addColorStop(0,   `rgba(${r},${g},${b},0.06)`);
  halo.addColorStop(0.5, `rgba(${r},${g},${b},0.04)`);
  halo.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(-(H / 2), -(H / 2), H, H);
  ctx.restore();

  // Faint centerlane baseline
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.22)`;
  ctx.lineWidth   = 0.5;
  ctx.stroke();

  // High-density vertical peak bars — columns are precomputed once per
  // (bars, W) pair by getOrComputePeakColumns and read here in O(colCount).
  const cols  = getOrComputePeakColumns(bars, W);
  const colPx = 2;

  ctx.beginPath();
  for (let col = 0; col < cols.length; col += 1) {
    const barH = Math.max(0.5, Math.min(1, cols[col]) * maxHalf);
    const x    = col * colPx + 0.5;
    ctx.moveTo(x, cy - barH);
    ctx.lineTo(x, cy + barH);
  }
  ctx.lineWidth   = 1;
  ctx.lineCap     = "butt";
  ctx.strokeStyle = `rgba(${r},${g},${b},0.90)`;
  ctx.stroke();

  ctx.restore();
}

async function loadPreviewPeaksForAudio(audioSource) {
  for (const peaksUrl of getPreviewPeakUrls(audioSource)) {
    const peaks = await loadPreviewPeaks(peaksUrl);
    if (peaks) return peaks;
  }
  return decodePreviewPeaks(getPreviewPlaybackUrl(audioSource));
}

// ── StemLane ─────────────────────────────────────────────────────────────────
// Renders the desktop project-row waveform preview.
// Uses server peaks when available, derives the peaks URL from the stored audio
// key while metadata is catching up, then falls back to browser audio decoding.
// While real peaks are loading, deterministic synthetic bars are rendered
// instantly from the track title so the lane is never blank.
function StemLane({ label, audioSource, trackColor, renderIndex = 0, isStemTrack = false, onAudioMount, onAudioUnmount }) {
  const canvasRef = useRef(null);

  // Stable refs so the audio ref callback never changes identity (avoids
  // React re-calling it with null then the element on every parent re-render).
  const onAudioMountRef   = useRef(onAudioMount);
  const onAudioUnmountRef = useRef(onAudioUnmount);
  useEffect(() => {
    onAudioMountRef.current   = onAudioMount;
    onAudioUnmountRef.current = onAudioUnmount;
  });

  const audioRefCallback = useCallback((el) => {
    if (el) onAudioMountRef.current?.(el);
    else    onAudioUnmountRef.current?.();
  }, []);
  // Capture renderIndex once at mount — used to stagger the first network fetch
  // so all tracks in a large session don't race to the server simultaneously.
  // Not updated on reorder: we don't want a re-fetch just because a track moved.
  const staggerIndexRef = useRef(renderIndex);

  const [peakBars, setPeakBars] = useState(() => {
    // Sync init from cache so cached tracks render immediately on first paint.
    const cacheKey = getPreviewPeakUrls(audioSource).find((url) => previewPeaksCache.has(url));
    if (cacheKey) return previewPeaksCache.get(cacheKey);
    const audioUrl = getPreviewPlaybackUrl(audioSource);
    if (audioUrl && previewPeaksCache.has(`decode:${audioUrl}`)) return previewPeaksCache.get(`decode:${audioUrl}`);
    return undefined;
  });

  useEffect(() => {
    if (!audioSource) {
      setPeakBars(undefined);
      return;
    }

    let cancelled = false;
    const cachedKey = getPreviewPeakUrls(audioSource).find((url) => previewPeaksCache.has(url));
    const audioUrl = getPreviewPlaybackUrl(audioSource);
    setPeakBars(
      cachedKey
        ? previewPeaksCache.get(cachedKey)
        : audioUrl && previewPeaksCache.has(`decode:${audioUrl}`)
          ? previewPeaksCache.get(`decode:${audioUrl}`)
          : undefined,
    );

    // Stagger the first fetch by 80 ms × track index so a 30-track session
    // doesn't fire 30 simultaneous requests at mount or after a reorder.
    const firstDelay = staggerIndexRef.current * 80;
    const retryDelays = [firstDelay, 2500, 5000, 10000, 15000];
    const timers = [];

    retryDelays.forEach((delay) => {
      const timer = window.setTimeout(() => {
        loadPreviewPeaksForAudio(audioSource)
          .then((data) => { if (!cancelled && data) setPeakBars(data); })
          .catch(() => {
            // Fetch/decode error — keep the synthetic waveform. Do NOT surface
            // this as a "Load failed" banner or modify global application state.
          });
      }, delay);
      timers.push(timer);
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    audioSource?.peaksUrl,
    audioSource?.key,
    audioSource?.previewUrl,
    audioSource?.playbackUrl,
    audioSource?.audioUrl,
    audioSource?.url,
  ]);

  // Deterministic synthetic waveform drawn instantly while real peaks load.
  // Uses a seeded LCG so each track gets a unique but stable pattern.
  const fallbackBars = useMemo(() => {
    if (peakBars?.length) return [];

    let s = 0;
    for (let i = 0; i < (label || "").length; i += 1) {
      s = (((s << 5) - s) + label.charCodeAt(i)) | 0;
    }
    s = (Math.abs(s) || 0xdeadbe) & 0x7fffffff;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    // Two envelope frequencies give each track a distinct "song shape"
    const env1Cycles = 2 + (s & 3);       // 2–5 slow arcs across the lane
    const env2Cycles = 7 + ((s >> 4) & 5); // 7–11 faster modulation
    const phase1 = rand() * Math.PI * 2;
    const phase2 = rand() * Math.PI * 2;

    return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => {
      const t = i / WAVEFORM_BAR_COUNT;
      const envelope =
        (0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * env1Cycles + phase1))) *
        (0.50 + 0.50 * Math.abs(Math.sin(t * Math.PI * env2Cycles + phase2)));
      const noise = 0.30 + 0.70 * rand();
      return Math.max(0.04, Math.min(1, noise * envelope));
    });
  }, [label, peakBars?.length]);

  const bars          = peakBars?.length ? peakBars : fallbackBars;
  const progressColor = trackColor?.progress || "#d6a354";
  const isLoading     = !peakBars?.length;

  // Redraw whenever peaks, color, or render position changes.
  // useEffect (post-paint) avoids Safari issues with useLayoutEffect + canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId     = 0;
    let staggerId = 0;
    // destroyed gate — prevents any queued RO callback or RAF from running after
    // this effect's cleanup fires (e.g. mid-flight during a track reorder).
    let destroyed = false;

    const draw = () => {
      if (destroyed) return;
      // Re-read the live ref — the closed-over value may be a stale unmounted canvas.
      const c = canvasRef.current;
      if (!c || !c.parentElement) return;
      drawWaveformOnCanvas(c, bars, progressColor);
    };

    const schedule = () => {
      if (destroyed) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(draw);
    };

    // Stagger the initial draw by one frame-width (16 ms) per track index so
    // mounting or reordering 30 tracks doesn't flush all canvases in one frame.
    staggerId = window.setTimeout(schedule, renderIndex * 16);

    const ro = new ResizeObserver(schedule);
    ro.observe(canvas.parentElement ?? canvas);

    return () => {
      destroyed = true;
      window.clearTimeout(staggerId);
      cancelAnimationFrame(rafId);
      // Explicit disconnect stops any queued ResizeObserver callbacks from
      // firing on a detached element after the effect re-runs during reorder.
      ro.disconnect();
    };
  }, [bars, progressColor, renderIndex]);

  const playbackUrl = getPreviewPlaybackUrl(audioSource);

  return (
    <span
      className={[
        "desktop-track-lane",
        bars.length ? "has-bars" : "",
        isLoading && audioSource ? "is-loading-preview" : "",
      ].filter(Boolean).join(" ")}
      aria-hidden="true"
      style={{ position: "relative" }}
    >
      {isStemTrack && playbackUrl && (
        <audio ref={audioRefCallback} src={playbackUrl} preload="auto" style={{ display: "none" }} />
      )}
      <canvas ref={canvasRef} className="desktop-track-lane-canvas" />
      <span className="desktop-track-lane-label" style={{ position: "absolute", zIndex: 10 }}>{label}</span>
    </span>
  );
}

function useDeferredTrackLimit(resetKey, total) {
  const [limit, setLimit] = useState(() => Math.min(total, INITIAL_RENDERED_TRACKS));

  useEffect(() => {
    setLimit(Math.min(total, INITIAL_RENDERED_TRACKS));
  }, [resetKey, total]);

  useEffect(() => {
    if (limit >= total) return undefined;

    const timerId = window.setTimeout(() => {
      setLimit((current) => Math.min(total, current + RENDERED_TRACK_BATCH));
    }, 50);

    return () => window.clearTimeout(timerId);
  }, [limit, total]);

  return limit;
}

// ── TrackRow ──────────────────────────────────────────────────────────────────
// Desktop layout: DAW-style [track header] [timeline clip lane].
// Edit actions (Replace / S / M / Delete) overlay on hover.
const TrackRow = memo(function TrackRow({
  track,
  index,
  isActive,
  canEdit,
  onTrackSelect,
  onTrackDelete,
  onTrackReplace,
  onDragStart,
  onDragEnd,
  onTrackDragOver,
  isDeleting,
  trackColor,
  isStemTrack,
  isSoloed,
  isMuted,
  onToggleSolo,
  onToggleMute,
  isDimmedBySolo,
  isDragTarget,
  dragInsertAbove,
  onAudioMount,
  onAudioUnmount,
}) {
  const title         = track.title || `Track ${index + 1}`;
  const activeVersion = track.versions.find((v) => v.id === track.activeVersionId) || track.versions[0];
  const commentCount  = activeVersion?.comments?.length ?? 0;
  const audioSource   = activeVersion?.audioSource || null;

  const dragClass = isDragTarget ? (dragInsertAbove ? " drag-insert-above" : " drag-insert-below") : "";

  return (
    <div
      className={`track-row${trackColor ? " colored-track-row" : ""}${dragClass}`}
      style={
        trackColor
          ? {
              "--stem-wave-color":     trackColor.wave,
              "--stem-progress-color": trackColor.progress,
            }
          : undefined
      }
      draggable={canEdit}
      onDragStart={canEdit ? (e) => onDragStart(e, track.id) : undefined}
      onDragEnd={onDragEnd}
      onDragOver={canEdit ? (e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onTrackDragOver?.(track.id, e.clientY < rect.top + rect.height / 2);
      } : undefined}
    >
      {/* ── Main selectable row ─────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        className={`desktop-track-item${isActive ? " active" : ""}`}
        data-muted={isMuted || undefined}
        data-dimmed={isDimmedBySolo || undefined}
        onClick={() => onTrackSelect(track.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTrackSelect(track.id);
          }
        }}
        aria-label={`Track ${index + 1}: ${title}. ${commentCount} comment${commentCount === 1 ? "" : "s"}.`}
      >
        <span className="desktop-track-header">
          <span className="desktop-track-color-rail" />
          <span className="desktop-track-meta">
            <span className="desktop-track-title-row">
              <span className="desktop-track-badge">{index + 1}</span>
              <span className="desktop-track-name">{title}</span>
            </span>
            <span className="desktop-track-comments">
              <span className="desktop-track-comments-label">Comments</span>
              {isStemTrack && (
                <>
                  <button
                    type="button"
                    className={`stem-toggle-action mute-btn${isMuted ? " active" : ""}`}
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleMute?.(track.id); }}
                    aria-label={isMuted ? "Unmute track" : "Mute track"}
                    aria-pressed={isMuted}
                    title={isMuted ? "Unmute" : "Mute"}
                  >M</button>
                  <button
                    type="button"
                    className={`stem-toggle-action solo-btn${isSoloed ? " active" : ""}`}
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleSolo?.(track.id); }}
                    aria-label={isSoloed ? "Unsolo track" : "Solo track"}
                    aria-pressed={isSoloed}
                    title={isSoloed ? "Unsolo" : "Solo"}
                  >S</button>
                </>
              )}
              <span className="desktop-track-count">{commentCount}</span>
            </span>
          </span>
        </span>
        <StemLane
          label={title}
          audioSource={audioSource}
          trackColor={trackColor}
          renderIndex={index}
          isStemTrack={isStemTrack}
          onAudioMount={onAudioMount ? (el) => onAudioMount(track.id, index, el) : undefined}
          onAudioUnmount={onAudioUnmount ? () => onAudioUnmount(track.id) : undefined}
        />
      </div>

      {/* ── Edit actions — overlay on hover ─────────────────────────────── */}
      {canEdit && (
        <div className="track-row-actions" aria-label="Track actions">
          <label className="track-row-replace">
            <input
              type="file"
              accept={AUDIO_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onTrackReplace(track.id, file);
                event.target.value = "";
              }}
              tabIndex={-1}
            />
            <span>Replace</span>
          </label>
          <button
            type="button"
            className={`track-row-delete${isDeleting ? " is-deleting" : ""}`}
            disabled={isDeleting}
            onClick={(e) => {
              e.stopPropagation();
              onTrackDelete(track.id);
            }}
            aria-label="Delete track"
            tabIndex={-1}
          >
            {isDeleting ? "…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
});

// ── StemTimeline ──────────────────────────────────────────────────────────────
// Clickable/draggable horizontal progress bar that spans the waveform lane area.
// Uses RAF to poll the leader audio element directly, giving smooth 60fps movement
// without threading currentTime through React state on every animation frame.
function StemTimeline({ audioElsRef, duration, onSeek }) {
  const railRef     = useRef(null);
  const playheadRef = useRef(null);
  const rafRef      = useRef(null);

  useEffect(() => {
    const tick = () => {
      const leader = [...audioElsRef.current.values()].sort((a, b) => a.index - b.index)[0]?.el;
      if (leader && playheadRef.current) {
        const dur = leader.duration || duration || 0;
        const pct = dur > 0 ? Math.min(Math.max(leader.currentTime / dur, 0), 1) : 0;
        playheadRef.current.style.left = `${pct * 100}%`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [audioElsRef, duration]);

  const handlePointerDown = useCallback((e) => {
    const rail = railRef.current;
    if (!rail) return;
    e.preventDefault();
    const seek = (clientX) => {
      const rect = rail.getBoundingClientRect();
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      const dur = duration || [...audioElsRef.current.values()].sort((a, b) => a.index - b.index)[0]?.el?.duration || 0;
      if (dur > 0) onSeek?.(ratio * dur);
    };
    seek(e.clientX);
    const onMove = (ev) => seek(ev.clientX);
    const onUp   = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
  }, [audioElsRef, duration, onSeek]);

  return (
    <div className="stem-timeline-row" aria-hidden="true">
      <div className="stem-timeline-spacer" />
      <div
        className="stem-timeline"
        ref={railRef}
        onPointerDown={handlePointerDown}
      >
        <div className="stem-timeline-playhead" ref={playheadRef} />
      </div>
    </div>
  );
}

// ── TypeBadge ─────────────────────────────────────────────────────────────────
function TypeBadge({ type }) {
  const isStem = type === "stem_project";
  return (
    <span className={`desktop-project-type-tag desktop-project-type-tag--${isStem ? "stems" : "album"}`}>
      {isStem ? "Stems" : "Stereo"}
    </span>
  );
}

// ── TrackList ─────────────────────────────────────────────────────────────────
export const TrackList = memo(function TrackList({
  tracks,
  albums,
  activeTrackId,
  canEdit,
  onTrackSelect,
  onTrackDelete,
  onTrackReplace,
  onTrackUpload,
  onCreateAlbum,
  onRenameAlbum,
  onUpdateAlbumType,
  onMoveTrack,
  onDeleteProject,
  onStemControlsReady,
  onTimeUpdate,
  onDurationChange,
  onPlaybackChange,
  stemDuration,
  stemCurrentTime,
  stemIsPlaying,
  onSeek,
}) {
  const [collapsed,            setCollapsed]            = useState({});
  const [renamingAlbumId,      setRenamingAlbumId]      = useState(null);
  const [renameValue,          setRenameValue]          = useState("");
  const [dragOverAlbumId,      setDragOverAlbumId]      = useState(null);
  const [dragOverTrackId,      setDragOverTrackId]      = useState(null);
  const [dragAbove,            setDragAbove]            = useState(false);
  const [deletingTrackId,      setDeletingTrackId]      = useState(null);
  const [deleteError,          setDeleteError]          = useState("");
  const [showTypePicker,       setShowTypePicker]       = useState(false);
  const [soloedTracks,         setSoloedTracks]         = useState(() => new Set());
  const [mutedTracks,          setMutedTracks]          = useState(() => new Set());

  // ── Stem audio element registry ──────────────────────────────────────────────
  // Maps trackId → { el: HTMLAudioElement, index: number }
  // Ref (not state) so mutations don't cause renders — only updated via callbacks.
  const audioElsRef       = useRef(new Map());
  const leaderCleanupRef  = useRef(null);

  // Stable refs for stem transport callbacks — updated every render so handlers
  // always call the latest prop value without needing to be in dep arrays.
  const stemCbRef = useRef({ onStemControlsReady, onTimeUpdate, onDurationChange, onPlaybackChange });
  useEffect(() => {
    stemCbRef.current = { onStemControlsReady, onTimeUpdate, onDurationChange, onPlaybackChange };
  });

  // Stable refs for current mute/solo sets — read inside callbacks that have
  // empty dep arrays (cannot close over state without stale value problems).
  const soloedTracksRef = useRef(soloedTracks);
  const mutedTracksRef  = useRef(mutedTracks);
  useEffect(() => {
    soloedTracksRef.current = soloedTracks;
    mutedTracksRef.current  = mutedTracks;
  });

  // Emit transport controls whenever the audio element map changes.
  const emitStemControls = useCallback(() => {
    const { onStemControlsReady: ready } = stemCbRef.current;
    if (!ready) return;
    const sorted = [...audioElsRef.current.values()].sort((a, b) => a.index - b.index);
    if (!sorted.length) { ready(null); return; }

    const allEls   = () => [...audioElsRef.current.values()].sort((a, b) => a.index - b.index).map((e) => e.el);
    const leaderEl = () => allEls()[0];

    ready({
      play:       () => Promise.allSettled(allEls().map((el) => el.play())),
      pause:      () => allEls().forEach((el) => el.pause()),
      playPause:  () => {
        const l = leaderEl();
        if (!l) return;
        if (l.paused) return Promise.allSettled(allEls().map((el) => el.play()));
        allEls().forEach((el) => el.pause());
      },
      seekToTime: (t) => allEls().forEach((el) => { el.currentTime = Math.min(Math.max(t, 0), el.duration || 0); }),
      skip:       (s) => {
        const l = leaderEl();
        if (!l) return;
        const next = Math.min(Math.max((l.currentTime || 0) + s, 0), l.duration || 0);
        allEls().forEach((el) => { el.currentTime = next; });
      },
    });
  }, []);

  // Attach timeupdate / durationchange / play / pause listeners to the leader
  // (lowest-index) audio element. Re-runs whenever the map changes.
  const reattachLeaderListeners = useCallback(() => {
    leaderCleanupRef.current?.();
    leaderCleanupRef.current = null;
    const sorted = [...audioElsRef.current.values()].sort((a, b) => a.index - b.index);
    const leader = sorted[0]?.el;
    if (!leader) return;

    const onTime  = () => stemCbRef.current.onTimeUpdate?.(leader.currentTime);
    const onDur   = () => stemCbRef.current.onDurationChange?.(leader.duration);
    const onPlay  = () => stemCbRef.current.onPlaybackChange?.(true);
    const onPause = () => stemCbRef.current.onPlaybackChange?.(false);
    const onEnd   = () => stemCbRef.current.onPlaybackChange?.(false);

    leader.addEventListener("timeupdate",    onTime);
    leader.addEventListener("durationchange", onDur);
    leader.addEventListener("play",           onPlay);
    leader.addEventListener("pause",          onPause);
    leader.addEventListener("ended",          onEnd);

    leaderCleanupRef.current = () => {
      leader.removeEventListener("timeupdate",    onTime);
      leader.removeEventListener("durationchange", onDur);
      leader.removeEventListener("play",           onPlay);
      leader.removeEventListener("pause",          onPause);
      leader.removeEventListener("ended",          onEnd);
    };
  }, []);

  const handleStemAudioMount = useCallback((trackId, index, audioEl) => {
    audioElsRef.current.set(trackId, { el: audioEl, index });
    // Apply the current mute/solo state immediately so the new element starts
    // in the right state without waiting for the next soloedTracks/mutedTracks effect.
    const soloSet = soloedTracksRef.current;
    const muteSet = mutedTracksRef.current;
    audioEl.muted = soloSet.size > 0 ? !soloSet.has(trackId) : muteSet.has(trackId);
    reattachLeaderListeners();
    emitStemControls();
  }, [reattachLeaderListeners, emitStemControls]);

  const handleStemAudioUnmount = useCallback((trackId) => {
    audioElsRef.current.delete(trackId);
    reattachLeaderListeners();
    emitStemControls();
  }, [reattachLeaderListeners, emitStemControls]);

  // Sync audio element muted states whenever solo/mute sets change.
  useEffect(() => {
    audioElsRef.current.forEach(({ el }, trackId) => {
      el.muted = soloedTracks.size > 0 ? !soloedTracks.has(trackId) : mutedTracks.has(trackId);
    });
  }, [soloedTracks, mutedTracks]);

  // Clean up leader listeners when TrackList unmounts.
  useEffect(() => () => leaderCleanupRef.current?.(), []);

  // ── Desktop project selector state ──────────────────────────────────────────
  const [desktopSelectedAlbumId, setDesktopSelectedAlbumId] = useState(null);
  const [desktopDropdownOpen,    setDesktopDropdownOpen]    = useState(false);
  const desktopSelectorRef = useRef(null);

  // ── Derived data ─────────────────────────────────────────────────────────────
  const visibleTracks = useMemo(() => tracks, [tracks]);

  const effectiveAlbums = useMemo(
    () => (Array.isArray(albums) && albums.length > 0 ? albums : []),
    [albums],
  );

  const trackMap = useMemo(
    () => Object.fromEntries(visibleTracks.map((t) => [t.id, t])),
    [visibleTracks],
  );

  const assignedIds = useMemo(
    () => new Set(effectiveAlbums.flatMap((a) => a.trackIds || [])),
    [effectiveAlbums],
  );

  const unassignedTracks = useMemo(
    () => visibleTracks.filter((t) => !assignedIds.has(t.id)),
    [visibleTracks, assignedIds],
  );

  const albumBuckets = useMemo(() => {
    let previousTrackCount = 0;
    return effectiveAlbums.map((album) => {
      const albumTracks = (album.trackIds || [])
        .map((id) => trackMap[id])
        .filter(Boolean);
      const bucket = { album, albumTracks, previousTrackCount };
      previousTrackCount += albumTracks.length;
      return bucket;
    });
  }, [effectiveAlbums, trackMap]);

  // Multi-album: true when the session has more than one project
  const multiAlbum = effectiveAlbums.length > 1;
  const hasProjectSelector = effectiveAlbums.length > 0;

  // Resolve which album is "selected" in the desktop dropdown
  const desktopSelectedAlbum =
    effectiveAlbums.find((a) => a.id === desktopSelectedAlbumId) ||
    effectiveAlbums[0] ||
    null;

  // When showing the desktop selector, display ONLY the selected album's bucket
  // (reset previousTrackCount to 0 so the deferred render limit works correctly).
  // Single-album fallback: use visibleTracks ONLY when trackIds are empty/missing
  // (backward-compat for legacy flat-stored sessions). If trackIds are populated,
  // always respect them so tracks are never leaked across projects.
  const displayBuckets = useMemo(() => {
    if (effectiveAlbums.length === 1) {
      const soleAlbum = effectiveAlbums[0];
      const albumTracks =
        soleAlbum.trackIds?.length > 0
          ? soleAlbum.trackIds.map((id) => trackMap[id]).filter(Boolean)
          : visibleTracks;
      return [{ album: soleAlbum, albumTracks, previousTrackCount: 0 }];
    }
    if (!multiAlbum) return albumBuckets;
    return albumBuckets
      .filter((b) => b.album.id === desktopSelectedAlbum?.id)
      .map((b) => ({ ...b, previousTrackCount: 0 }));
  }, [albumBuckets, effectiveAlbums, multiAlbum, visibleTracks, desktopSelectedAlbum, trackMap]);

  // X / Y counter shown inside the selector button
  const currentDesktopAlbumIndex = effectiveAlbums.findIndex(
    (a) => a.id === desktopSelectedAlbum?.id,
  );
  const albumCount = effectiveAlbums.length;
  const selectedAlbumTrackCount = useMemo(() => {
    if (!desktopSelectedAlbum) return 0;
    if (effectiveAlbums.length === 1) {
      // Mirror displayBuckets logic: respect trackIds when present, else fall
      // back to all visible tracks for legacy flat-stored sessions.
      return desktopSelectedAlbum.trackIds?.length > 0
        ? (desktopSelectedAlbum.trackIds || []).filter((id) => trackMap[id]).length
        : visibleTracks.length;
    }
    return (desktopSelectedAlbum.trackIds || []).filter((id) => trackMap[id]).length;
  }, [desktopSelectedAlbum, effectiveAlbums.length, trackMap, visibleTracks.length]);

  const renderResetKey = useMemo(
    () => visibleTracks.map((t) => t.id).join(","),
    [visibleTracks],
  );

  const totalTrackRows = useMemo(
    () =>
      displayBuckets.reduce((sum, { albumTracks }) => sum + albumTracks.length, 0) +
      (multiAlbum ? unassignedTracks.length : 0),
    [displayBuckets, multiAlbum, unassignedTracks.length],
  );

  const renderedTrackLimit = useDeferredTrackLimit(renderResetKey, totalTrackRows);

  const isEmpty = visibleTracks.length === 0;

  // ── Auto-switch desktop selector to the album that owns the active track ────
  // Mirrors MobileTrackNav's auto-switch behaviour.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hasProjectSelector) {
      if (desktopSelectedAlbumId !== null) setDesktopSelectedAlbumId(null);
      return;
    }

    const owner = activeTrackId
      ? effectiveAlbums.find((a) => (a.trackIds || []).includes(activeTrackId))
      : null;
    const selectedStillExists = effectiveAlbums.some((a) => a.id === desktopSelectedAlbumId);
    const nextAlbumId = owner?.id || (selectedStillExists ? desktopSelectedAlbumId : effectiveAlbums[0]?.id || null);
    if (nextAlbumId !== desktopSelectedAlbumId) {
      setDesktopSelectedAlbumId(nextAlbumId);
    }
  }, [activeTrackId, desktopSelectedAlbumId, effectiveAlbums, hasProjectSelector]);

  // ── Close dropdown on outside click ─────────────────────────────────────────
  useEffect(() => {
    if (!desktopDropdownOpen) return;
    const handleOutside = (e) => {
      if (
        desktopSelectorRef.current &&
        !desktopSelectorRef.current.contains(e.target)
      ) {
        setDesktopDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [desktopDropdownOpen]);

  // ── Callbacks ────────────────────────────────────────────────────────────────
  const toggleCollapse = useCallback((albumId) => {
    setCollapsed((prev) => ({ ...prev, [albumId]: !prev[albumId] }));
  }, []);

  const startRename = useCallback((album) => {
    setRenamingAlbumId(album.id);
    setRenameValue(album.title);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingAlbumId && renameValue.trim()) {
      onRenameAlbum?.(renamingAlbumId, renameValue.trim());
    }
    setRenamingAlbumId(null);
    setRenameValue("");
  }, [onRenameAlbum, renamingAlbumId, renameValue]);

  const handleDragStart = useCallback((e, trackId) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", trackId);
  }, []);

  const handleDragOver = useCallback((e, albumId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverAlbumId(albumId);
  }, []);

  const handleDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverAlbumId(null);
    }
  }, []);

  const handleTrackDragOver = useCallback((trackId, isAbove) => {
    setDragOverTrackId(trackId);
    setDragAbove(isAbove);
  }, []);

  const handleDrop = useCallback((e, albumId) => {
    e.preventDefault();
    const trackId = e.dataTransfer.getData("text/plain");
    if (!trackId) { setDragOverAlbumId(null); setDragOverTrackId(null); return; }

    if (dragOverTrackId && dragOverTrackId !== trackId) {
      // Find the album that owns the hovered track so cross-album drops work too
      const ownerAlbum = effectiveAlbums.find((a) => (a.trackIds || []).includes(dragOverTrackId));
      const resolvedAlbumId = ownerAlbum?.id || albumId;
      // Compute insertion index relative to the album's current order (sans the dragged track)
      const currentIds = (ownerAlbum?.trackIds || []).filter((id) => id !== trackId);
      const targetIdx  = currentIds.indexOf(dragOverTrackId);
      const insertIdx  = targetIdx >= 0 ? (dragAbove ? targetIdx : targetIdx + 1) : currentIds.length;
      onMoveTrack?.(trackId, resolvedAlbumId, insertIdx);
    } else {
      onMoveTrack?.(trackId, albumId);
    }

    setDragOverAlbumId(null);
    setDragOverTrackId(null);
  }, [onMoveTrack, effectiveAlbums, dragOverTrackId, dragAbove]);

  const handleDragEnd = useCallback(() => {
    setDragOverAlbumId(null);
    setDragOverTrackId(null);
  }, []);

  const handleToggleSolo = useCallback((trackId) => {
    setSoloedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId);
      return next;
    });
  }, []);

  const handleToggleMute = useCallback((trackId) => {
    setMutedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId);
      return next;
    });
  }, []);

  const handleTrackDelete = useCallback(async (trackId) => {
    if (!canEdit || !trackId || deletingTrackId) return;
    const confirmed = window.confirm(
      "Delete this track and its stored audio files? This cannot be undone.",
    );
    if (!confirmed) return;

    setDeleteError("");
    setDeletingTrackId(trackId);
    try {
      await onTrackDelete?.(trackId);
    } catch (error) {
      setDeleteError(error.message || "Track could not be deleted.");
    } finally {
      setDeletingTrackId(null);
    }
  }, [canEdit, deletingTrackId, onTrackDelete]);

  const handleCreateProject = useCallback((title, type) => {
    const albumId = onCreateAlbum?.(title, type);
    if (albumId) setDesktopSelectedAlbumId(albumId);
    setShowTypePicker(false);
    setDesktopDropdownOpen(false);
  }, [onCreateAlbum]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <section
      className={`track-list-panel${deleteError ? " has-track-list-error" : ""}`}
      aria-label="Project tracks"
    >
      {deleteError && (
        <div className="track-list-header">
          <div className="track-list-header-content">
            <p className="upload-error">{deleteError}</p>
          </div>
        </div>
      )}

      {effectiveAlbums.length > 0 ? (
        <div className="track-list-albums">

          {/* ── Project selector bar — sticky dropdown for every session that has a project. */}
          {desktopSelectedAlbum ? (
            <div className="desktop-project-selector" ref={desktopSelectorRef}>
              <p className="track-list-header-subtitle desktop-selected-project-summary">
                <span className="track-list-header-subtitle-name">
                  {desktopSelectedAlbum.title}
                </span>
                <span className="track-list-header-subtitle-count">
                  {selectedAlbumTrackCount} track{selectedAlbumTrackCount === 1 ? "" : "s"}
                </span>
              </p>

              {/* Top row: dropdown trigger + inline edit actions */}
              <div className="desktop-project-selector-row">
                <button
                  type="button"
                  className="desktop-project-selector-btn"
                  onClick={() => setDesktopDropdownOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={desktopDropdownOpen}
                >
                  <span className="desktop-project-selector-eyebrow">Project</span>

                  {renamingAlbumId === desktopSelectedAlbum?.id ? (
                    <input
                      className="album-rename-input desktop-project-rename-input"
                      value={renameValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") {
                          setRenamingAlbumId(null);
                          setRenameValue("");
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="desktop-project-selector-name"
                      title={canEdit ? "Double-click to rename" : undefined}
                      onDoubleClick={() =>
                        canEdit && desktopSelectedAlbum && startRename(desktopSelectedAlbum)
                      }
                    >
                      {desktopSelectedAlbum?.title ?? "Select Project"}
                    </span>
                  )}

                  <TypeBadge type={desktopSelectedAlbum?.type} />

                  {albumCount > 0 && (
                    <span
                      className="desktop-project-counter"
                      aria-label={`${currentDesktopAlbumIndex + 1} of ${albumCount}`}
                    >
                      {currentDesktopAlbumIndex + 1}&thinsp;/&thinsp;{albumCount}
                    </span>
                  )}

                  <span
                    className={`desktop-project-chevron${desktopDropdownOpen ? " open" : ""}`}
                    aria-hidden="true"
                  >
                    ▾
                  </span>
                </button>

                {/* Upload + Delete for the selected project */}
                {canEdit && desktopSelectedAlbum && (
                  <div className="desktop-project-edit-actions">
                    <label className="upload-button compact small">
                      <input
                        type="file"
                        accept={AUDIO_ACCEPT}
                        multiple
                        onChange={(event) => {
                          const files = Array.from(event.target.files || []);
                          if (files.length > 0)
                            onTrackUpload(files, desktopSelectedAlbum.id);
                          event.target.value = "";
                        }}
                      />
                      <span>
                        {desktopSelectedAlbum.type === "stem_project"
                          ? "Upload Stems"
                          : "Add Track"}
                      </span>
                    </label>
                    <button
                      type="button"
                      className="album-delete-btn desktop-album-delete-btn"
                      onClick={() => onDeleteProject?.(desktopSelectedAlbum.id)}
                      title="Delete project"
                      aria-label="Delete project"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>

              {/* Dropdown project list */}
              {desktopDropdownOpen && (
                <div className="desktop-project-dropdown" role="listbox">
                  {effectiveAlbums.map((album) => {
                    const isActive = album.id === desktopSelectedAlbum?.id;
                    const firstTrackId = (album.trackIds || []).find((id) => trackMap[id]);
                    return (
                      <button
                        key={album.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={`desktop-project-option${isActive ? " active" : ""}`}
                        onClick={() => {
                          setDesktopSelectedAlbumId(album.id);
                          if (firstTrackId) onTrackSelect(firstTrackId);
                          setDesktopDropdownOpen(false);
                        }}
                      >
                        <span className="desktop-project-option-title">{album.title}</span>
                        <TypeBadge type={album.type} />
                        {isActive && (
                          <span className="desktop-project-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {/* Create project shortcut inside dropdown */}
                  {canEdit && (
                    <div className="desktop-project-dropdown-footer">
                      {showTypePicker ? (
                        <div className="project-type-picker desktop-type-picker-inline">
                          <button
                            type="button"
                            className="project-type-picker-card"
                            onClick={() => handleCreateProject("New Project", "album")}
                          >
                            <strong>Project</strong>
                            <span>Final stereo tracks</span>
                          </button>
                          <button
                            type="button"
                            className="project-type-picker-card project-type-picker-card--stems"
                            onClick={() => handleCreateProject("New Stem Project", "stem_project")}
                          >
                            <strong>Stem Project</strong>
                            <span>Multitrack stems</span>
                          </button>
                          <button
                            type="button"
                            className="project-type-picker-cancel"
                            onClick={() => setShowTypePicker(false)}
                            aria-label="Cancel"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="add-album-btn desktop-dropdown-add-btn"
                          onClick={() => setShowTypePicker(true)}
                        >
                          + Create Project
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}

          {/* ── Track buckets OR empty-project state ──────────────────────────
              In multi-album mode: displayBuckets contains only the selected
              album (previousTrackCount reset to 0).
              In single-album mode: displayBuckets === albumBuckets.            */}
          {!isEmpty ? (
            <>
          {displayBuckets.map(({ album, albumTracks, previousTrackCount }) => {
            const visibleAlbumTracks = albumTracks.slice(
              0,
              Math.max(0, renderedTrackLimit - previousTrackCount),
            );
            const isCollapsed   = Boolean(collapsed[album.id]);
            const isDragTarget  = dragOverAlbumId === album.id;
            const isStemProject = album.type === "stem_project";

            return (
              <div
                key={album.id}
                className={`track-list-album${isDragTarget ? " drag-over" : ""}`}
                onDragOver={(e) => handleDragOver(e, album.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, album.id)}
              >
                {/* Section label (Tracks / Stems) */}
                <p className="desktop-track-section-label">
                  {isStemProject ? "Stems" : "Tracks"}
                </p>

                {/* Global playhead timeline — stem projects only */}
                {isStemProject && !isCollapsed && albumTracks.length > 0 && (
                  <StemTimeline
                    audioElsRef={audioElsRef}
                    duration={stemDuration}
                    onSeek={onSeek}
                  />
                )}

                {!isCollapsed && (
                  <div className="track-list">
                    {visibleAlbumTracks.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isActive={track.id === activeTrackId}
                        canEdit={canEdit}
                        onTrackSelect={onTrackSelect}
                        onTrackDelete={handleTrackDelete}
                        onTrackReplace={onTrackReplace}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onTrackDragOver={handleTrackDragOver}
                        isDeleting={deletingTrackId === track.id}
                        trackColor={getStemColor(index)}
                        isStemTrack={isStemProject}
                        isSoloed={soloedTracks.has(track.id)}
                        isMuted={mutedTracks.has(track.id)}
                        onToggleSolo={handleToggleSolo}
                        onToggleMute={handleToggleMute}
                        isDimmedBySolo={soloedTracks.size > 0 && !soloedTracks.has(track.id)}
                        isDragTarget={dragOverTrackId === track.id}
                        dragInsertAbove={dragAbove}
                        onAudioMount={isStemProject ? handleStemAudioMount : undefined}
                        onAudioUnmount={isStemProject ? handleStemAudioUnmount : undefined}
                      />
                    ))}
                    {visibleAlbumTracks.length < albumTracks.length && (
                      <div className="track-list-album-drop-hint">Loading tracks…</div>
                    )}
                    {albumTracks.length === 0 && isDragTarget && (
                      <div className="track-list-album-drop-hint">Drop track here</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Unassigned tracks (multi-album only) ─────────────────────── */}
          {multiAlbum && unassignedTracks.length > 0 &&
            renderedTrackLimit > totalTrackRows - unassignedTracks.length && (
              <div className="track-list">
                {unassignedTracks
                  .slice(
                    0,
                    renderedTrackLimit - (totalTrackRows - unassignedTracks.length),
                  )
                  .map((track, index) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      isActive={track.id === activeTrackId}
                      canEdit={false}
                      onTrackSelect={onTrackSelect}
                      onTrackDelete={handleTrackDelete}
                      onTrackReplace={onTrackReplace}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      isDeleting={false}
                      trackColor={getStemColor(index)}
                    />
                  ))}
              </div>
            )}
            </>
          ) : (
            <div className="empty-state compact">
              <strong>No tracks imported.</strong>
              <p>Add a track to start this client review session.</p>
            </div>
          )}
        </div>
      ) : null}

      {/* ── Create project — blank session only ──────────────────────────── */}
      {canEdit && effectiveAlbums.length === 0 && (
        <div className="add-album-actions">
          {showTypePicker ? (
            <div className="project-type-picker">
              <button
                type="button"
                className="project-type-picker-card"
                onClick={() => handleCreateProject("New Project", "album")}
              >
                <strong>Project</strong>
                <span>Final stereo tracks for client review</span>
              </button>
              <button
                type="button"
                className="project-type-picker-card project-type-picker-card--stems"
                onClick={() => handleCreateProject("New Stem Project", "stem_project")}
              >
                <strong>Stem Project</strong>
                <span>Multitrack stems for DAW-style review</span>
              </button>
              <button
                type="button"
                className="project-type-picker-cancel"
                onClick={() => setShowTypePicker(false)}
                aria-label="Cancel"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="add-album-btn"
              onClick={() => setShowTypePicker(true)}
            >
              + Create Project
            </button>
          )}
        </div>
      )}
    </section>
  );
});
