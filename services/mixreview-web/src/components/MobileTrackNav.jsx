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
  // Which album is currently displayed in the track list
  const [selectedAlbumId, setSelectedAlbumId] = useState(null);
  // Whether the project-switcher dropdown is open
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const activeRef = useRef(null);
  const selectorRef = useRef(null);

  const effectiveAlbums = Array.isArray(albums) && albums.length > 0 ? albums : null;
  const trackMap = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const multiAlbum = effectiveAlbums && effectiveAlbums.length > 1;

  // Resolve selected album, falling back to the first one
  const selectedAlbum =
    (effectiveAlbums || []).find((a) => a.id === selectedAlbumId) ||
    (effectiveAlbums || [])[0];

  // Build the flat track list to display
  const displayTracks = multiAlbum
    ? (selectedAlbum?.trackIds || []).map((id) => trackMap[id]).filter(Boolean)
    : tracks;

  // Auto-switch to whichever album owns the newly-active track
  useEffect(() => {
    if (!multiAlbum || !effectiveAlbums || !activeTrackId) return;
    const owner = effectiveAlbums.find((a) =>
      (a.trackIds || []).includes(activeTrackId)
    );
    if (owner && owner.id !== selectedAlbumId) {
      setSelectedAlbumId(owner.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackId]);

  // Scroll the active button into view after the list renders
  useEffect(() => {
    if (!activeRef.current) return;
    const el = activeRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTrackId, selectedAlbumId]);

  // Current 1-based position within the album list (for the "X / Y" counter)
  const currentAlbumIndex = (effectiveAlbums || []).findIndex(
    (a) => a.id === selectedAlbum?.id
  );
  const albumCount = (effectiveAlbums || []).length;

  // Close the dropdown when the user taps outside it
  useEffect(() => {
    if (!dropdownOpen) return;
    const onOutside = (e) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [dropdownOpen]);

  return (
    <nav className="mobile-track-nav" aria-label="Track selector">
      {/* Project switcher — only rendered when there are multiple albums */}
      {multiAlbum && (
        <div className="mobile-project-selector" ref={selectorRef}>
          <button
            type="button"
            className="mobile-project-selector-btn"
            onClick={() => setDropdownOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
          >
            <span className="mobile-project-selector-eyebrow">Project</span>
            <span className="mobile-project-selector-name">
              {selectedAlbum?.title ?? "Select Project"}
            </span>
            {albumCount > 0 && (
              <span className="mobile-project-counter" aria-label={`${currentAlbumIndex + 1} of ${albumCount}`}>
                {currentAlbumIndex + 1}&thinsp;/&thinsp;{albumCount}
              </span>
            )}
            <span
              className={`mobile-project-chevron${dropdownOpen ? " open" : ""}`}
              aria-hidden="true"
            >
              ▾
            </span>
          </button>

          {dropdownOpen && (
            <div className="mobile-project-dropdown" role="listbox">
              {effectiveAlbums.map((album) => {
                const isActive = album.id === selectedAlbum?.id;
                return (
                  <button
                    key={album.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`mobile-project-option${isActive ? " active" : ""}`}
                    onClick={() => {
                      setSelectedAlbumId(album.id);
                      setDropdownOpen(false);
                    }}
                  >
                    <span>{album.title}</span>
                    {isActive && (
                      <span className="mobile-project-check" aria-hidden="true">✓</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <p className="mobile-track-nav-label">Stems</p>

      {/* Single continuous track list — identical to the single-project layout */}
      <div className="mobile-track-nav-list">
        {displayTracks.map((track, index) => (
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
