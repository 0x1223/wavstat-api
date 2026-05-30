import { useState, useMemo, memo, useCallback } from "react";
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

// ── TrackRow ──────────────────────────────────────────────────────────────────
// Memoized individual track button. Skips reconciliation unless its specific
// track reference, active state, or edit permission changes.
// Key benefit: when 5 tracks are appended to a 33-track list, the 33 existing
// rows never re-render — only the 5 new ones are mounted.
const TrackRow = memo(function TrackRow({
  track,
  index,
  isActive,
  canEdit,
  onTrackSelect,
  onTrackDelete,
  onDragStart,  // (e, trackId) — stable useCallback from parent
  onDragEnd,    // ()           — stable useCallback from parent
  isDeleting,
}) {
  const activeVersion =
    track.versions.find((v) => v.id === track.activeVersionId) ||
    track.versions[0];

  return (
    <div
      style={{ display: "grid", gap: "6px", minWidth: "180px" }}
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
        <button
          type="button"
          disabled={isDeleting}
          onClick={(event) => {
            event.stopPropagation();
            onTrackDelete(track.id);
          }}
          style={{
            minWidth: "auto",
            minHeight: "30px",
            padding: "6px 10px",
            color: "#ffb5a8",
            justifyItems: "center",
          }}
        >
          {isDeleting ? "Deleting" : "Delete"}
        </button>
      )}
    </div>
  );
});

// ── TrackList ─────────────────────────────────────────────────────────────────
// Wrapped in memo so App.jsx re-renders (e.g. playback time ticks) don't
// propagate into this tree when tracks/albums/canEdit are unchanged.
export const TrackList = memo(function TrackList({
  tracks,
  albums,
  activeTrackId,
  canEdit,
  onTrackSelect,
  onTrackUpload,
  onCreateAlbum,
  onRenameAlbum,
  onUpdateAlbumType,
  onMoveTrack,
}) {
  const [collapsed,       setCollapsed]       = useState({});
  const [renamingAlbumId, setRenamingAlbumId] = useState(null);
  const [renameValue,     setRenameValue]     = useState("");
  const [dragOverAlbumId, setDragOverAlbumId] = useState(null);
  const [deletedTrackIds, setDeletedTrackIds] = useState(() => new Set());
  const [deletingTrackId, setDeletingTrackId] = useState(null);
  const [deleteError, setDeleteError] = useState("");

  // ── Memoized derived data ─────────────────────────────────────────────────
  // Prevents O(n) recomputation on every render caused by unrelated state
  // changes (collapse toggle, rename input, drag state, etc.).

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

  // O(1) track lookup by id — rebuilt only when the tracks array identity changes.
  const trackMap = useMemo(
    () => Object.fromEntries(visibleTracks.map((t) => [t.id, t])),
    [visibleTracks],
  );

  const assignedIds = useMemo(
    () => new Set(effectiveAlbums.flatMap((a) => a.trackIds || [])),
    [effectiveAlbums],
  );

  // Safety net: tracks that somehow slipped through without an album assignment.
  const unassignedTracks = useMemo(
    () => visibleTracks.filter((t) => !assignedIds.has(t.id)),
    [visibleTracks, assignedIds],
  );

  // ── Stable event handlers (stable refs → TrackRow memo holds) ─────────────
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
  // renameValue intentionally in deps — commitRename must close over current text
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
    const confirmed = window.confirm("Delete this track and its stored audio files?");
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

  // ── Render ────────────────────────────────────────────────────────────────
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
          {effectiveAlbums.map((album) => {
            const albumTracks = (album.trackIds || [])
              .map((id) => trackMap[id])
              .filter(Boolean);
            const isCollapsed      = Boolean(collapsed[album.id]);
            const isDragTarget     = dragOverAlbumId === album.id;
            const showAlbumHeaders = effectiveAlbums.length > 1;

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
                        className="album-title"
                        title={canEdit ? "Double-click to rename" : undefined}
                        onDoubleClick={() => canEdit && startRename(album)}
                      >
                        {album.title}
                      </span>
                    )}

                    {canEdit && (
                      <button
                        type="button"
                        className={`album-type-badge album-type-badge--${
                          album.type === "stem_project" ? "stems" : "album"
                        }`}
                        title="Click to toggle container type"
                        onClick={() =>
                          onUpdateAlbumType?.(
                            album.id,
                            album.type === "stem_project" ? "album" : "stem_project",
                          )
                        }
                      >
                        {album.type === "stem_project" ? "Stems" : "Album"}
                      </button>
                    )}

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
                        <span>Add Track</span>
                      </label>
                    )}
                  </div>
                )}

                {!showAlbumHeaders && canEdit && (
                  <div className="track-list-single-album-actions">
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
                      <span>Add Track</span>
                    </label>
                  </div>
                )}

                {!isCollapsed && (
                  <div className="track-list">
                    {albumTracks.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isActive={track.id === activeTrackId}
                        canEdit={canEdit}
                        onTrackSelect={onTrackSelect}
                        onTrackDelete={handleTrackDelete}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        isDeleting={deletingTrackId === track.id}
                      />
                    ))}
                    {albumTracks.length === 0 && isDragTarget && (
                      <div className="track-list-album-drop-hint">Drop track here</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {unassignedTracks.length > 0 && (
            <div className="track-list">
              {unassignedTracks.map((track, index) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  isActive={track.id === activeTrackId}
                  canEdit={false}
                  onTrackSelect={onTrackSelect}
                  onTrackDelete={handleTrackDelete}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  isDeleting={false}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && effectiveAlbums.length > 0 && (
        <div className="add-album-actions">
          <button
            type="button"
            className="add-album-btn"
            onClick={() => onCreateAlbum?.("New Album", "album")}
          >
            + Add Album
          </button>
          <button
            type="button"
            className="add-album-btn add-album-btn--stems"
            onClick={() => onCreateAlbum?.("New Stem Project", "stem_project")}
          >
            + Add Stems
          </button>
        </div>
      )}
    </section>
  );
});
