import { useState } from "react";

export function TrackList({
  tracks,
  albums,
  activeTrackId,
  canEdit,
  onTrackSelect,
  onTrackUpload,
  onCreateAlbum,
  onRenameAlbum,
  onMoveTrack
}) {
  const [collapsed, setCollapsed] = useState({});
  const [renamingAlbumId, setRenamingAlbumId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  // dragOverAlbumId: which album is the current drop target (for visual feedback)
  const [dragOverAlbumId, setDragOverAlbumId] = useState(null);

  const importedTracks = tracks.filter((track) =>
    track.versions.some((version) => version.audioSource)
  );
  const trackMap = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const effectiveAlbums = Array.isArray(albums) && albums.length > 0 ? albums : [];

  // Safety net: tracks not assigned to any album (should not happen after backend normalisation)
  const assignedIds = new Set(effectiveAlbums.flatMap((a) => a.trackIds || []));
  const unassignedTracks = tracks.filter((t) => !assignedIds.has(t.id));

  // ── collapse helpers ──────────────────────────────────────────────────────
  const toggleCollapse = (albumId) => {
    setCollapsed((prev) => ({ ...prev, [albumId]: !prev[albumId] }));
  };

  // ── inline rename helpers ────────────────────────────────────────────────
  const startRename = (album) => {
    setRenamingAlbumId(album.id);
    setRenameValue(album.title);
  };

  const commitRename = () => {
    if (renamingAlbumId && renameValue.trim()) {
      onRenameAlbum?.(renamingAlbumId, renameValue.trim());
    }
    setRenamingAlbumId(null);
    setRenameValue("");
  };

  // ── drag-and-drop handlers ───────────────────────────────────────────────
  const handleDragStart = (e, trackId) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", trackId);
  };

  const handleDragOver = (e, albumId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverAlbumId(albumId);
  };

  const handleDragLeave = (e) => {
    // Only clear when leaving the album container itself, not a child element
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverAlbumId(null);
    }
  };

  const handleDrop = (e, albumId) => {
    e.preventDefault();
    const trackId = e.dataTransfer.getData("text/plain");
    if (trackId) {
      onMoveTrack?.(trackId, albumId);
    }
    setDragOverAlbumId(null);
  };

  const handleDragEnd = () => setDragOverAlbumId(null);

  const isEmpty = tracks.length === 0 && effectiveAlbums.every((a) => (a.trackIds || []).length === 0);

  return (
    <section className="track-list-panel" aria-label="Project tracks">
      <div className="track-list-header">
        <div>
          <p className="eyebrow">Project Tracks</p>
          <h2>{importedTracks.length} imported</h2>
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
            const isCollapsed = Boolean(collapsed[album.id]);
            const isDragTarget = dragOverAlbumId === album.id;
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
                      aria-label={isCollapsed ? `Expand ${album.title}` : `Collapse ${album.title}`}
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

                    <span className="album-track-count">{albumTracks.length}</span>

                    {canEdit && (
                      <label className="upload-button compact small">
                        <input
                          type="file"
                          accept="audio/*"
                          multiple
                          onChange={(event) => {
                            const files = Array.from(event.target.files || []);
                            if (files.length > 0) onTrackUpload(files);
                            event.target.value = "";
                          }}
                        />
                        <span>Add Track</span>
                      </label>
                    )}
                  </div>
                )}

                {/* Single-album mode: show the Add Track button in the main header area */}
                {!showAlbumHeaders && canEdit && (
                  <div className="track-list-single-album-actions">
                    <label className="upload-button compact">
                      <input
                        type="file"
                        accept="audio/*"
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
                    {albumTracks.map((track, index) => {
                      const activeVersion =
                        track.versions.find((v) => v.id === track.activeVersionId) ||
                        track.versions[0];
                      return (
                        <button
                          type="button"
                          key={track.id}
                          className={track.id === activeTrackId ? "active" : ""}
                          draggable={canEdit}
                          onDragStart={canEdit ? (e) => handleDragStart(e, track.id) : undefined}
                          onDragEnd={handleDragEnd}
                          onClick={() => onTrackSelect(track.id)}
                        >
                          <span>{track.title || `Track ${index + 1}`}</span>
                          <small>{activeVersion?.approvalStatus || "Pending Review"}</small>
                        </button>
                      );
                    })}
                    {albumTracks.length === 0 && isDragTarget && (
                      <div className="track-list-album-drop-hint">Drop track here</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Safety-net: render unassigned tracks so nothing is ever hidden */}
          {unassignedTracks.length > 0 && (
            <div className="track-list">
              {unassignedTracks.map((track, index) => {
                const activeVersion =
                  track.versions.find((v) => v.id === track.activeVersionId) ||
                  track.versions[0];
                return (
                  <button
                    type="button"
                    key={track.id}
                    className={track.id === activeTrackId ? "active" : ""}
                    onClick={() => onTrackSelect(track.id)}
                  >
                    <span>{track.title || `Track ${index + 1}`}</span>
                    <small>{activeVersion?.approvalStatus || "Pending Review"}</small>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {canEdit && effectiveAlbums.length > 0 && (
        <button
          type="button"
          className="add-album-btn"
          onClick={() => onCreateAlbum?.()}
        >
          + Add Album
        </button>
      )}
    </section>
  );
}
