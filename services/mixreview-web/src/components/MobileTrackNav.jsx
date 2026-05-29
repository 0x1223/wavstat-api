import { useState, useEffect, useRef } from "react";

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

function TrackButton({ track, index, isActive, onTrackSelect, activeRef }) {
  const title = abbrev(track.title || "Untitled Track");
  const activeVersion =
    track.versions.find((v) => v.id === track.activeVersionId) || track.versions[0];
  const commentCount = activeVersion?.comments?.length ?? 0;
  return (
    <button
      ref={isActive ? activeRef : null}
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
  // Ref to the currently active track button — used for scrollIntoView.
  const activeRef = useRef(null);
  // Ref to the scrollable album container — needed to host sticky headers.
  const scrollerRef = useRef(null);

  const effectiveAlbums = Array.isArray(albums) && albums.length > 0 ? albums : null;
  const trackMap = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const multiAlbum = effectiveAlbums && effectiveAlbums.length > 1;

  const toggleCollapse = (albumId) => {
    setCollapsed((prev) => ({ ...prev, [albumId]: !prev[albumId] }));
  };

  // Auto-expand whichever album contains the active track.
  // If the active track's album is currently collapsed, open it.
  useEffect(() => {
    if (!multiAlbum || !effectiveAlbums || !activeTrackId) return;
    const ownerAlbum = effectiveAlbums.find((a) =>
      (a.trackIds || []).includes(activeTrackId)
    );
    if (ownerAlbum && collapsed[ownerAlbum.id]) {
      setCollapsed((prev) => ({ ...prev, [ownerAlbum.id]: false }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackId]);

  // Scroll the active track button into view whenever it changes.
  // Uses a short rAF delay so the DOM has time to expand a newly-opened album.
  useEffect(() => {
    if (!activeRef.current) return;
    const el = activeRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTrackId]);

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
              activeRef={activeRef}
            />
          ))}
        </div>
      </nav>
    );
  }

  // Multi-album display: grouped with collapsible album headers.
  // The outer nav IS the single scroll container; each album header sticks
  // to the top of that scroller as the user scrolls through a long track list.
  // A running global index is maintained so StemLane seeds remain unique.
  let globalIndex = 0;

  return (
    <nav
      ref={scrollerRef}
      className="mobile-track-nav mobile-track-nav--albums"
      aria-label="Track selector"
    >
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
                      activeRef={activeRef}
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
