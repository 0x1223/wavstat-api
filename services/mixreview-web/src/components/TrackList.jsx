import { useEffect, useLayoutEffect, useRef, useState, useMemo, memo, useCallback } from "react";
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

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    const channelData = audioBuffer.getChannelData(0);
    const normalized = normalizePreviewPeaks(channelData);
    if (normalized) previewPeaksCache.set(cacheKey, normalized);
    return normalized;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function hexToRgb(hex) {
  const h = (hex || "#d6a354").replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function drawWaveformOnCanvas(canvas, bars, progressColor) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bounds = canvas.getBoundingClientRect();
  const parentBounds = canvas.parentElement?.getBoundingClientRect();
  const W = Math.round(bounds.width || parentBounds?.width || canvas.offsetWidth || 0);
  const H = Math.round(bounds.height || parentBounds?.height || canvas.offsetHeight || 0);
  if (W <= 0 || H <= 0) return;

  const pW = Math.round(W * dpr);
  const pH = Math.round(H * dpr);
  if (canvas.width !== pW || canvas.height !== pH) {
    canvas.width  = pW;
    canvas.height = pH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!bars?.length) return;

  const [r, g, b] = hexToRgb(progressColor);
  const cy = H / 2;
  const maxHalf = (H * 0.70) / 2;
  const columnStep = W < 700 ? 1 : 2;
  const sourceStep = bars.length / Math.max(1, Math.ceil(W / columnStep));

  // Faint DAW centerline: perfectly horizontal, no blur or glow.
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.26)`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Professional DAW peak rendering: one min/max vertical stroke per pixel
  // column (or every 2 px on wide lanes). No curves, no smoothing, no glow.
  ctx.beginPath();
  for (let x = 0, column = 0; x < W; x += columnStep, column += 1) {
    const start = Math.floor(column * sourceStep);
    const end = Math.max(start + 1, Math.min(Math.ceil((column + 1) * sourceStep), bars.length));
    let minPeak = 0;
    let maxPeak = 0;

    for (let i = start; i < end; i += 1) {
      const value = Number.isFinite(bars[i]) ? Math.max(-1, Math.min(1, bars[i])) : 0;
      if (value < 0) {
        minPeak = Math.min(minPeak, value);
      } else {
        maxPeak = Math.max(maxPeak, value);
        minPeak = Math.min(minPeak, -value);
      }
    }

    const top = Math.max(cy - maxHalf, cy + minPeak * maxHalf);
    const bottom = Math.min(cy + maxHalf, cy + maxPeak * maxHalf);
    const crispX = Math.round(x) + 0.5;

    ctx.moveTo(crispX, top);
    ctx.lineTo(crispX, bottom);
  }

  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.94)`;
  ctx.stroke();
}

async function loadPreviewPeaksForAudio(audioSource) {
  for (const peaksUrl of getPreviewPeakUrls(audioSource)) {
    const peaks = await loadPreviewPeaks(peaksUrl);
    if (peaks) return peaks;
  }
  return decodePreviewPeaks(getPreviewPlaybackUrl(audioSource));
}

// ── StemLane ─────────────────────────────────────────────────────────────────
// Renders the canvas waveform preview inside each desktop track row.
// Uses server peaks when available, derives the peaks URL from the stored audio
// key while metadata is catching up, then falls back to browser audio decoding.
// While real peaks are loading, a deterministic synthetic waveform is drawn
// instantly from the track title so the lane is never blank.
function StemLane({ label, audioSource, trackColor }) {
  const canvasRef = useRef(null);

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
    const retryDelays = [0, 2500, 5000, 10000, 15000];
    const timers = [];

    retryDelays.forEach((delay) => {
      const timer = window.setTimeout(() => {
        loadPreviewPeaksForAudio(audioSource).then((data) => {
          if (!cancelled && data) setPeakBars(data);
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

  // Deterministic synthetic waveform shown while real peaks are in flight.
  // Always generated when there's an audioSource so the lane is never blank.
  const fallbackBars = useMemo(() => {
    if (peakBars?.length) return [];
    let seed = 0;
    for (let i = 0; i < (label || "").length; i += 1) {
      seed = (seed * 31 + label.charCodeAt(i)) % 9973;
    }
    return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => {
      const a = Math.sin((i + seed) * 0.115);
      const b = Math.sin((i + seed) * 0.031);
      const c = Math.sin((i + seed) * 0.007);
      return Math.max(0.04, Math.abs(a * 0.46 + b * 0.34 + c * 0.20));
    });
  }, [audioSource, label, peakBars?.length]);

  const bars          = peakBars?.length ? peakBars : fallbackBars;
  const progressColor = trackColor?.progress || "#d6a354";
  const isLoading     = !peakBars?.length;
  const visibleBars   = useMemo(() => {
    if (!bars.length) return [];

    const targetCount = Math.min(WAVEFORM_BAR_COUNT, Math.max(180, bars.length));
    const step = bars.length / targetCount;

    return Array.from({ length: targetCount }, (_, index) => {
      const start = Math.floor(index * step);
      const end = Math.max(start + 1, Math.min(bars.length, Math.ceil((index + 1) * step)));
      let peak = 0;

      for (let i = start; i < end; i += 1) {
        const value = Number.isFinite(bars[i]) ? Math.abs(bars[i]) : 0;
        peak = Math.max(peak, Math.min(1, value));
      }

      return Math.max(0.035, peak);
    });
  }, [bars]);

  // Draw (or redraw on resize) synchronously before browser paint so there's
  // no blank flash on mount. ResizeObserver keeps canvas crisp after layout shifts.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let rafId = 0;
    const draw = () => drawWaveformOnCanvas(canvas, bars, progressColor);
    const scheduleDraw = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        draw();
      });
    };
    scheduleDraw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas.parentElement || canvas);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [bars, progressColor]);

  return (
    <span
      className={[
        "desktop-track-lane",
        bars.length ? "has-bars" : "",
        isLoading && audioSource ? "is-loading-preview" : "",
      ].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <span className="desktop-track-lane-label">{label}</span>
      <canvas ref={canvasRef} className="desktop-track-lane-canvas" />
      {visibleBars.length > 0 ? (
        <span className="desktop-track-lane-bars">
          {visibleBars.map((height, index) => (
            <i key={index} style={{ height: `${Math.round(8 + height * 42)}px` }} />
          ))}
        </span>
      ) : null}
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
  isDeleting,
  trackColor,
  isStemTrack,
  isSoloed,
  isMuted,
  onToggleSolo,
  onToggleMute,
}) {
  const title      = track.title || `Track ${index + 1}`;
  const activeVersion  = track.versions.find((v) => v.id === track.activeVersionId) || track.versions[0];
  const commentCount   = activeVersion?.comments?.length ?? 0;
  const audioSource    = activeVersion?.audioSource || null;

  return (
    <div
      className={`track-row${trackColor ? " colored-track-row" : ""}`}
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
    >
      {/* ── Main selectable row ─────────────────────────────────────────── */}
      <button
        type="button"
        className={`desktop-track-item${isActive ? " active" : ""}`}
        onClick={() => onTrackSelect(track.id)}
        aria-label={`Track ${index + 1}: ${title}. ${commentCount} comment${commentCount === 1 ? "" : "s"}.`}
      >
        <span className="desktop-track-header" aria-hidden="true">
          <span className="desktop-track-color-rail" />
          <span className="desktop-track-meta">
            <span className="desktop-track-title-row">
              <span className="desktop-track-badge">{index + 1}</span>
              <span className="desktop-track-name">{title}</span>
            </span>
            <span className="desktop-track-comments">
              <span>Comments</span>
              <strong>{commentCount}</strong>
            </span>
          </span>
        </span>
        <StemLane label={title} audioSource={audioSource} trackColor={trackColor} />
      </button>

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
          {isStemTrack && (
            <>
              <button
                type="button"
                className={`track-row-solo${isSoloed ? " active" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggleSolo?.(track.id); }}
                aria-label={isSoloed ? "Unsolo" : "Solo"}
                tabIndex={-1}
              >
                S
              </button>
              <button
                type="button"
                className={`track-row-mute${isMuted ? " active" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggleMute?.(track.id); }}
                aria-label={isMuted ? "Unmute" : "Mute"}
                tabIndex={-1}
              >
                M
              </button>
            </>
          )}
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
}) {
  const [collapsed,            setCollapsed]            = useState({});
  const [renamingAlbumId,      setRenamingAlbumId]      = useState(null);
  const [renameValue,          setRenameValue]          = useState("");
  const [dragOverAlbumId,      setDragOverAlbumId]      = useState(null);
  const [deletingTrackId,      setDeletingTrackId]      = useState(null);
  const [deleteError,          setDeleteError]          = useState("");
  const [showTypePicker,       setShowTypePicker]       = useState(false);
  const [soloedTracks,         setSoloedTracks]         = useState(() => new Set());
  const [mutedTracks,          setMutedTracks]          = useState(() => new Set());

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
  // Single-album: claim all session tracks regardless of album.trackIds linkage so
  // flat-stored tracks (album.trackIds=[]) appear under the project bar identically
  // to sessions where tracks are properly linked.
  const displayBuckets = useMemo(() => {
    if (effectiveAlbums.length === 1) {
      return [{ album: effectiveAlbums[0], albumTracks: visibleTracks, previousTrackCount: 0 }];
    }
    if (!multiAlbum) return albumBuckets;
    return albumBuckets
      .filter((b) => b.album.id === desktopSelectedAlbum?.id)
      .map((b) => ({ ...b, previousTrackCount: 0 }));
  }, [albumBuckets, effectiveAlbums, multiAlbum, visibleTracks, desktopSelectedAlbum]);

  // X / Y counter shown inside the selector button
  const currentDesktopAlbumIndex = effectiveAlbums.findIndex(
    (a) => a.id === desktopSelectedAlbum?.id,
  );
  const albumCount = effectiveAlbums.length;
  const selectedAlbumTrackCount = useMemo(() => {
    if (!desktopSelectedAlbum) return 0;
    if (effectiveAlbums.length === 1) return visibleTracks.length;
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

  const handleDrop = useCallback((e, albumId) => {
    e.preventDefault();
    const trackId = e.dataTransfer.getData("text/plain");
    if (trackId) onMoveTrack?.(trackId, albumId);
    setDragOverAlbumId(null);
  }, [onMoveTrack]);

  const handleDragEnd = useCallback(() => setDragOverAlbumId(null), []);

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
                        isDeleting={deletingTrackId === track.id}
                        trackColor={getStemColor(index)}
                        isStemTrack={isStemProject}
                        isSoloed={soloedTracks.has(track.id)}
                        isMuted={mutedTracks.has(track.id)}
                        onToggleSolo={handleToggleSolo}
                        onToggleMute={handleToggleMute}
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
