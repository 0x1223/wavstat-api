export function MobileTrackNav({ tracks, activeTrackId, onTrackSelect }) {
  return (
    <nav className="mobile-track-nav" aria-label="Track selector">
      <div className="mobile-track-nav-list">
        {tracks.map((track) => {
          const activeVersion =
            track.versions.find((v) => v.id === track.activeVersionId) ||
            track.versions[0];
          const status = activeVersion?.approvalStatus || "Pending Review";
          const isActive = track.id === activeTrackId;
          const statusClass = status.toLowerCase().replace(/\s+/g, "-");
          return (
            <button
              key={track.id}
              type="button"
              className={`mobile-track-nav-item${isActive ? " active" : ""}`}
              onClick={() => onTrackSelect(track.id)}
              aria-pressed={isActive}
            >
              <span className="mobile-track-nav-title">
                {track.title || "Untitled Track"}
              </span>
              <span className={`mobile-track-nav-status status-${statusClass}`}>
                {status}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
