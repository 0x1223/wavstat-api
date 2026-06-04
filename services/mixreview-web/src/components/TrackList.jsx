import { useEffect, useRef, useState, useMemo, memo, useCallback } from "react";
import { getStemColor } from "../lib/stemColors.js";

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

// Deterministic bar heights — same palette as MobileTrackNav
const BAR_HEIGHTS = [4, 7, 11, 16, 19, 13, 17, 10, 8, 14, 18, 12, 6, 15, 5, 9, 20, 3, 16, 11, 7, 14, 18, 4, 10, 16, 6, 13, 19, 8, 11, 15, 5, 17, 9, 12, 7, 20, 4, 14];

function abbrev(str, len = 11) {
  if (!str) return "Untitled";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

// Horizontal waveform preview bar visualisation — mirrors StemLane in MobileTrackNav.
// Stretches to fill whatever flex space the row gives it.
function StemLane({ seed, label }) {
  return (
    <span className="desktop-track-lane" aria-hidden="true">
      <span className="desktop-track-lane-label">{label}</span>
      <span className="desktop-track-lane-bars">
        {BAR_HEIGHTS.map((_, i) => (
          <i key={i} style={{ height: `${BAR_HEIGHTS[(i + seed * 7) % BAR_HEIGHTS.length]}px` }} />
        ))}
      </span>
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
// Desktop layout: [badge] [name] [waveform lane ···] [comment count]
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
  const shortTitle = abbrev(title);
  const activeVersion  = track.versions.find((v) => v.id === track.activeVersionId) || track.versions[0];
  const commentCount   = activeVersion?.comments?.length ?? 0;

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
      >
        <span className="desktop-track-badge">{index + 1}</span>
        <span className="desktop-track-name">{title}</span>
        <StemLane seed={index} label={shortTitle} />
        <span className="desktop-track-count">{commentCount}</span>
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

  const importedTracks = useMemo(
    () => visibleTracks.filter((t) => t.versions.some((v) => v.audioSource)),
    [visibleTracks],
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

  // Resolve which album is "selected" in the desktop dropdown
  const desktopSelectedAlbum =
    effectiveAlbums.find((a) => a.id === desktopSelectedAlbumId) ||
    effectiveAlbums[0] ||
    null;

  // When showing the desktop selector, display ONLY the selected album's bucket
  // (reset previousTrackCount to 0 so the deferred render limit works correctly).
  const displayBuckets = useMemo(() => {
    if (!multiAlbum) return albumBuckets;
    return albumBuckets
      .filter((b) => b.album.id === desktopSelectedAlbum?.id)
      .map((b) => ({ ...b, previousTrackCount: 0 }));
  }, [albumBuckets, multiAlbum, desktopSelectedAlbum]);

  // X / Y counter shown inside the selector button
  const currentDesktopAlbumIndex = effectiveAlbums.findIndex(
    (a) => a.id === desktopSelectedAlbum?.id,
  );
  const albumCount = effectiveAlbums.length;

  const renderResetKey = useMemo(
    () => visibleTracks.map((t) => t.id).join(","),
    [visibleTracks],
  );

  const totalTrackRows = useMemo(
    () =>
      displayBuckets.reduce((sum, { albumTracks }) => sum + albumTracks.length, 0) +
      unassignedTracks.length,
    [displayBuckets, unassignedTracks.length],
  );

  const renderedTrackLimit = useDeferredTrackLimit(renderResetKey, totalTrackRows);

  const isEmpty = visibleTracks.length === 0;

  // ── Auto-switch desktop selector to the album that owns the active track ────
  // Mirrors MobileTrackNav's auto-switch behaviour.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!multiAlbum || !activeTrackId) return;
    const owner = effectiveAlbums.find((a) =>
      (a.trackIds || []).includes(activeTrackId),
    );
    if (owner && owner.id !== desktopSelectedAlbumId) {
      setDesktopSelectedAlbumId(owner.id);
    }
  }, [activeTrackId]); // intentionally narrow — only re-run when active track changes

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
    onCreateAlbum?.(title, type);
    setShowTypePicker(false);
    setDesktopDropdownOpen(false);
  }, [onCreateAlbum]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <section className="track-list-panel" aria-label="Project tracks">
      <div className="track-list-header">
        {/* ── Left: eyebrow + count on one line, project subtitle below ─────── */}
        <div className="track-list-header-content">
          <div className="track-list-header-top">
            <p className="eyebrow">Project Tracks</p>
            <span className="track-list-imported-count">
              {importedTracks.length} imported
            </span>
          </div>
          {desktopSelectedAlbum && !isEmpty && (
            <p className="track-list-header-subtitle">
              <span className="track-list-header-subtitle-name">
                {desktopSelectedAlbum.title}
              </span>
              {" · "}
              <span className="track-list-header-subtitle-count">
                {displayBuckets[0]?.albumTracks.length ?? 0}
                {" track"}{(displayBuckets[0]?.albumTracks.length ?? 0) !== 1 ? "s" : ""}
              </span>
            </p>
          )}
          {deleteError && <p className="upload-error">{deleteError}</p>}
        </div>

        {/* ── Desktop "Add Track" — aligned with top border of Review Dashboard ─
            Visible only on desktop (≥981 px). Mobile retains the button below.  */}
        {!multiAlbum && canEdit && effectiveAlbums.length > 0 && (() => {
          const singleAlbum    = effectiveAlbums[0];
          const isStemProject  = singleAlbum?.type === "stem_project";
          return (
            <label className="upload-button compact desktop-add-track-btn">
              <input
                type="file"
                accept={AUDIO_ACCEPT}
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  if (files.length > 0) onTrackUpload(files);
                  event.target.value = "";
                }}
              />
              <span>{isStemProject ? "Upload Stems" : "Add Track"}</span>
            </label>
          );
        })()}
      </div>

      {isEmpty ? (
        <div className="empty-state compact">
          <strong>No tracks imported.</strong>
          <p>Choose audio to start this client review session.</p>
        </div>
      ) : (
        <div className="track-list-albums">

          {/* ── Desktop project selector ──────────────────────────────────────
              Shown when the session has more than one album/project.
              Replaces the accordion-style album headers with a single dropdown
              so the user can switch projects without leaving the track list.   */}
          {multiAlbum && (
            <div className="desktop-project-selector" ref={desktopSelectorRef}>

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
                    return (
                      <button
                        key={album.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={`desktop-project-option${isActive ? " active" : ""}`}
                        onClick={() => {
                          setDesktopSelectedAlbumId(album.id);
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
          )}

          {/* ── Section label (single-album edit controls) ─────────────────── */}
          {!multiAlbum && canEdit && effectiveAlbums.length > 0 && (() => {
            const singleAlbum  = effectiveAlbums[0];
            const isStemProject = singleAlbum?.type === "stem_project";
            return (
              <div className="track-list-single-album-actions">
                <TypeBadge type={singleAlbum?.type} />
                <label className="upload-button compact">
                  <input
                    type="file"
                    accept={AUDIO_ACCEPT}
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.length > 0) onTrackUpload(files);
                      event.target.value = "";
                    }}
                  />
                  <span>{isStemProject ? "Upload Stems" : "Add Track"}</span>
                </label>
              </div>
            );
          })()}

          {/* ── Track buckets ─────────────────────────────────────────────────
              In multi-album mode: displayBuckets contains only the selected
              album (previousTrackCount reset to 0).
              In single-album mode: displayBuckets === albumBuckets.            */}
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

          {/* ── Unassigned tracks ─────────────────────────────────────────── */}
          {unassignedTracks.length > 0 &&
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
        </div>
      )}

      {/* ── Create project (single-album or no-selector mode) ──────────────── */}
      {canEdit && !multiAlbum && (
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
