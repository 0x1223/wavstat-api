import { useEffect, useState, useMemo, memo, useCallback } from "react";
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
}) {
  const activeVersion =
    track.versions.find((v) => v.id === track.activeVersionId) ||
    track.versions[0];

  return (
    <div
      className="track-row"
      draggable={canEdit}
      onDragStart={canEdit ? (e) => onDragStart(e, track.id) : undefined}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className={isActive ? "active" : ""}
        onClick={() => onTrackSelect(track.id)}
      >
        <span>{track.title || `Track ${index + 1}`}</span>
        <small>{activeVersion?.approvalStatus || "Pending Review"}</small>
      </button>
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
            aria-label="Delete stem"
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
    <span className={`project-type-tag project-type-tag--${isStem ? "stems" : "stereo"}`}>
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
  onTrackReplace,
  onTrackUpload,
  onCreateAlbum,
  onRenameAlbum,
  onUpdateAlbumType,
  onMoveTrack,
  onDeleteProject,
}) {
  const [collapsed,       setCollapsed]       = useState({});
  const [renamingAlbumId, setRenamingAlbumId] = useState(null);
  const [renameValue,     setRenameValue]     = useState("");
  const [dragOverAlbumId, setDragOverAlbumId] = useState(null);
  const [deletedTrackIds, setDeletedTrackIds] = useState(() => new Set());
  const [deletingTrackId, setDeletingTrackId] = useState(null);
  const [deleteError,     setDeleteError]     = useState("");
  const [showTypePicker,  setShowTypePicker]  = useState(false);

  const visibleTracks = useMemo(
    () => tracks.filter((track) => !deletedTrackIds.has(track.id)),
    [deletedTrackIds, tracks],
  );

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

  const renderResetKey = useMemo(
    () => [
      albumBuckets.map(({ album }) => `${album.id}:${(album.trackIds || []).join(",")}`).join("|"),
      unassignedTracks.map((track) => track.id).join(","),
    ].join("::"),
    [albumBuckets, unassignedTracks],
  );

  const totalTrackRows = useMemo(
    () => albumBuckets.reduce((sum, { albumTracks }) => sum + albumTracks.length, 0) + unassignedTracks.length,
    [albumBuckets, unassignedTracks.length],
  );

  const renderedTrackLimit = useDeferredTrackLimit(renderResetKey, totalTrackRows);

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

  const handleTrackDelete = useCallback(async (trackId) => {
    if (!canEdit || !trackId || deletingTrackId) return;
    const confirmed = window.confirm("Delete this track and its stored audio files? This cannot be undone.");
    if (!confirmed) return;

    setDeleteError("");
    setDeletingTrackId(trackId);
    try {
      const adminKey = import.meta.env.VITE_ADMIN_API_KEY;
      const response = await fetch(apiUrl(`/api/tracks/${encodeURIComponent(trackId)}`), {
        method: "DELETE",
        headers: adminKey ? { Authorization: `Bearer ${adminKey}` } : {},
      });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Track could not be deleted.");
      }

      setDeletedTrackIds((current) => {
        const next = new Set(current);
        next.add(trackId);
        return next;
      });

      if (trackId === activeTrackId) {
        const fallbackTrack = visibleTracks.find((track) => track.id !== trackId);
        if (fallbackTrack) onTrackSelect(fallbackTrack.id);
      }
    } catch (error) {
      setDeleteError(error.message || "Track could not be deleted.");
    } finally {
      setDeletingTrackId(null);
    }
  }, [activeTrackId, canEdit, deletingTrackId, onTrackSelect, visibleTracks]);

  const handleCreateProject = useCallback((title, type) => {
    onCreateAlbum?.(title, type);
    setShowTypePicker(false);
  }, [onCreateAlbum]);

  const isEmpty = visibleTracks.length === 0;

  return (
    <section className="track-list-panel" aria-label="Project tracks">
      <div className="track-list-header">
        <div>
          <p className="eyebrow">Project Tracks</p>
          <h2>{importedTracks.length} imported</h2>
          {deleteError && <p className="upload-error">{deleteError}</p>}
        </div>
      </div>

      {isEmpty ? (
        <div className="empty-state compact">
          <strong>No tracks imported.</strong>
          <p>Choose audio to start this client review session.</p>
        </div>
      ) : (
        <div className="track-list-albums">
          {albumBuckets.map(({ album, albumTracks, previousTrackCount }) => {
            const visibleAlbumTracks = albumTracks.slice(0, Math.max(0, renderedTrackLimit - previousTrackCount));
            const isCollapsed      = Boolean(collapsed[album.id]);
            const isDragTarget     = dragOverAlbumId === album.id;
            const showAlbumHeaders = effectiveAlbums.length > 1;
            const isStemProject    = album.type === "stem_project";
            const uploadLabel      = isStemProject ? "Upload Stems" : "Add Track";

            return (
              <div
                key={album.id}
                className={`track-list-album${isDragTarget ? " drag-over" : ""}`}
                onDragOver={(e) => handleDragOver(e, album.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, album.id)}
              >
                {showAlbumHeaders && (
                  <div className="track-list-album-header">
                    <button
                      type="button"
                      className="album-collapse-btn"
                      onClick={() => toggleCollapse(album.id)}
                      aria-expanded={!isCollapsed}
                      aria-label={
                        isCollapsed ? `Expand ${album.title}` : `Collapse ${album.title}`
                      }
                    >
                      <span className={`album-chevron${isCollapsed ? " collapsed" : ""}`}>
                        ▾
                      </span>
                    </button>

                    {renamingAlbumId === album.id ? (
                      <input
                        className="album-rename-input"
                        value={renameValue}
                        autoFocus
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
                        className={`album-title${isStemProject ? " album-title-preview" : ""}`}
                        title={
                          isStemProject
                            ? "Click to preview stem session"
                            : canEdit ? "Double-click to rename" : undefined
                        }
                        onClick={() => {
                          if (isStemProject && album.trackIds?.[0]) {
                            onTrackSelect(album.trackIds[0], { previewStemAlbumId: album.id });
                          }
                        }}
                        onDoubleClick={() => canEdit && startRename(album)}
                      >
                        {album.title}
                      </span>
                    )}

                    <TypeBadge type={album.type} />

                    <span className="album-track-count">{albumTracks.length}</span>

                    {canEdit && (
                      <label className="upload-button compact small">
                        <input
                          type="file"
                          accept={AUDIO_ACCEPT}
                          multiple
                          onChange={(event) => {
                            const files = Array.from(event.target.files || []);
                            if (files.length > 0) onTrackUpload(files, album.id);
                            event.target.value = "";
                          }}
                        />
                        <span>{uploadLabel}</span>
                      </label>
                    )}

                    {canEdit && (
                      <button
                        type="button"
                        className="album-delete-btn"
                        onClick={() => onDeleteProject?.(album.id)}
                        title="Delete project"
                        aria-label="Delete project"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}

                {!showAlbumHeaders && canEdit && (
                  <div className="track-list-single-album-actions">
                    <TypeBadge type={album.type} />
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
                      <span>{uploadLabel}</span>
                    </label>
                  </div>
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
                        isDeleting={deletingTrackId === track.id}
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

          {unassignedTracks.length > 0 && renderedTrackLimit > totalTrackRows - unassignedTracks.length && (
            <div className="track-list">
              {unassignedTracks.slice(0, renderedTrackLimit - (totalTrackRows - unassignedTracks.length)).map((track, index) => (
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
                />
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && (
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
