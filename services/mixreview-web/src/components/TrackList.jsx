export function TrackList({
  tracks,
  activeTrackId,
  canEdit,
  onTrackSelect,
  onTrackUpload
}) {
  const importedTracks = tracks.filter((track) => track.versions.some((version) => version.audioSource));

  return (
    <section className="track-list-panel" aria-label="Project tracks">
      <div className="track-list-header">
        <div>
          <p className="eyebrow">Project Tracks</p>
          <h2>{importedTracks.length} imported</h2>
        </div>
        {canEdit && (
          <label className="upload-button compact">
            <input
              type="file"
              accept="audio/*"
              onChange={(event) => {
                onTrackUpload(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <span>Add Track</span>
          </label>
        )}
      </div>

      {tracks.length === 0 ? (
        <div className="empty-state compact">
          <strong>No tracks imported.</strong>
          <p>Choose audio to start this client review session.</p>
        </div>
      ) : (
        <div className="track-list">
          {tracks.map((track, index) => {
            const activeVersion = track.versions.find((version) => version.id === track.activeVersionId) || track.versions[0];
            return (
              <button
                type="button"
                className={track.id === activeTrackId ? "active" : ""}
                key={track.id}
                onClick={() => onTrackSelect(track.id)}
              >
                <span>{track.title || `Track ${index + 1}`}</span>
                <small>{activeVersion?.approvalStatus || "Pending Review"}</small>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
