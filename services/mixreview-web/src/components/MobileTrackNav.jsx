const BAR_HEIGHTS = [4, 7, 11, 16, 19, 13, 17, 10, 8, 14, 18, 12, 6, 15, 5];

function MiniWave({ seed }) {
  return (
    <span className="mobile-track-nav-bars" aria-hidden="true">
      {BAR_HEIGHTS.map((_, i) => (
        <i key={i} style={{ height: `${BAR_HEIGHTS[(i + seed * 5) % BAR_HEIGHTS.length]}px` }} />
      ))}
    </span>
  );
}

export function MobileTrackNav({ tracks, activeTrackId, onTrackSelect }) {
  return (
    <nav className="mobile-track-nav" aria-label="Track selector">
      <p className="mobile-track-nav-label">Stems</p>
      <div className="mobile-track-nav-list">
        {tracks.map((track, index) => {
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
              <span className="mobile-track-nav-badge">{index + 1}</span>
              <span className="mobile-track-nav-info">
                <span className="mobile-track-nav-title">
                  {track.title || "Untitled Track"}
                </span>
                <span className={`mobile-track-nav-status status-${statusClass}`}>
                  {status}
                </span>
              </span>
              <MiniWave seed={index} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
