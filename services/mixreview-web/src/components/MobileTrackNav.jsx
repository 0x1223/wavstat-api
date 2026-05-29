import { useState } from "react";

const BAR_HEIGHTS = [4, 7, 11, 16, 19, 13, 17, 10, 8, 14, 18, 12, 6, 15, 5, 9, 20, 3, 16, 11, 7, 14, 18, 4, 10, 16, 6, 13, 19, 8, 11, 15, 5, 17, 9, 12, 7, 20, 4, 14];

function abbrev(str) {
  if (!str) return "Untitled";
  return str.length > 11 ? str.slice(0, 11) + "…" : str;
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

function TrackButton({ track, index, isActive, onTrackSelect }) {
  const title = abbrev(track.title || "Untitled Track");
  const activeVersion =
    track.versions.find((v) => v.id === track.activeVersionId) || track.versions[0];
  const commentCount = activeVersion?.comments?.length ?? 0;
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
      <span className="mobile-track-nav-count">{commentCount}</span>
    </button>
  );
}

export function MobileTrackNav({ tracks, albums, activeTrackId, onTrackSelect }) {
  const [collapsed, setCollapsed] = useState({});

  const toggleCollapse = (albumId) => {
    setCollapsed((prev) => ({ ...prev, [albumId]: !prev[albumId] }));
  };

  const effectiveAlbums = Array.isArray(albums) && albums.length > 0 ? albums : null;
  const trackMap = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const multiAlbum = effectiveAlbums && effectiveAlbums.length > 1;

  // Flat display: single album or no album data — matches the original reviewer UX.
  if (!multiAlbum) {
    return (
      <nav className="mobile-track-nav" aria-label="Track selector">
        <p className="mobile-track-nav-label">Stems</p>
        <div className="mobile-track-nav-list">
          {tracks.map((track, index) => (
            <TrackButton
              key={track.id}
              track={track}
              index={index}
              isActive={track.id === activeTrackId}
              onTrackSelect={onTrackSelect}
            />
          ))}
        </div>
      </nav>
    );
  }

  // Multi-album display: grouped with collapsible album headers.
  // Each album shows a collapsible row of track cards; the header is always visible.
  // A running global index is maintained so StemLane seeds remain unique.
  let globalIndex = 0;

  return (
    <nav className="mobile-track-nav mobile-track-nav--albums" aria-label="Track selector">
      {effectiveAlbums.map((album) => {
        const albumTracks = (album.trackIds || [])
          .map((id) => trackMap[id])
          .filter(Boolean);
        const isCollapsed = Boolean(collapsed[album.id]);
        const hasActive = albumTracks.some((t) => t.id === activeTrackId);

        return (
          <div key={album.id} className={`mobile-track-nav-album${hasActive ? " has-active" : ""}`}>
            <button
              type="button"
              className="mobile-track-nav-album-header"
              onClick={() => toggleCollapse(album.id)}
              aria-expanded={!isCollapsed}
            >
              <span className="mobile-track-nav-album-title">{album.title}</span>
              <span className="mobile-track-nav-album-meta">
                {albumTracks.length} track{albumTracks.length !== 1 ? "s" : ""}
              </span>
              <span className={`album-chevron${isCollapsed ? " collapsed" : ""}`} aria-hidden="true">
                ▾
              </span>
            </button>

            {!isCollapsed && (
              <div className="mobile-track-nav-list">
                {albumTracks.map((track) => {
                  const idx = globalIndex++;
                  return (
                    <TrackButton
                      key={track.id}
                      track={track}
                      index={idx}
                      isActive={track.id === activeTrackId}
                      onTrackSelect={onTrackSelect}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
