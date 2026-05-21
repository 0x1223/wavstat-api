const BAR_HEIGHTS = [4, 7, 11, 16, 19, 13, 17, 10, 8, 14, 18, 12, 6, 15, 5, 9, 20, 3, 16, 11, 7, 14, 18, 4, 10, 16, 6, 13, 19, 8, 11, 15, 5, 17, 9, 12, 7, 20, 4, 14];

function abbrev(str) {
  if (!str) return "Untitled";
  return str.length > 10 ? str.slice(0, 9) + "…" : str;
}

function StemLane({ seed, label }) {
  return (
    <span className="mobile-track-nav-lane" aria-hidden="true">
      <span className="mobile-track-nav-lane-label">{label}</span>
      <span className="mobile-track-nav-bars">
        {BAR_HEIGHTS.map((_, i) => (
          <i key={i} style={{ height: `${BAR_HEIGHTS[(i + seed * 7) % BAR_HEIGHTS.length]}px` }} />
        ))}
      </span>
    </span>
  );
}

export function MobileTrackNav({ tracks, activeTrackId, onTrackSelect }) {
  return (
    <nav className="mobile-track-nav" aria-label="Track selector">
      <p className="mobile-track-nav-label">Stems</p>
      <div className="mobile-track-nav-list">
        {tracks.map((track, index) => {
          const isActive = track.id === activeTrackId;
          const title = abbrev(track.title || "Untitled Track");
          return (
            <button
              key={track.id}
              type="button"
              className={`mobile-track-nav-item${isActive ? " active" : ""}`}
              onClick={() => onTrackSelect(track.id)}
              aria-pressed={isActive}
            >
              <span className="mobile-track-nav-badge">{index + 1}</span>
              <span className="mobile-track-nav-name">{title}</span>
              <StemLane seed={index} label={title} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
