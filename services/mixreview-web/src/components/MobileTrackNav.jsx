import { useState, useEffect, useRef } from "react";
import { getStemColor } from "../lib/stemColors.js";

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
  const trackColor = getStemColor(index);

  return (
    <button
      ref={isActive ? activeRef : null}
      type="button"
      className={`mobile-track-nav-item${isActive ? " active" : ""}`}
      style={{
        "--stem-wave-color": trackColor.wave,
        "--stem-progress-color": trackColor.progress,
      }}
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

// ── Type label helpers ────────────────────────────────────────────────────────
function albumTypeLabel(type) {
  return type === "stem_project" ? "Stems" : "Album";
}
function albumTypeModifier(type) {
  return type === "stem_project" ? "stems" : "album";
}

// ─────────────────────────────────────────────────────────────────────────────

export function MobileTrackNav({
  tracks,
  albums,
  activeTrackId,
  onTrackSelect,
  // Called whenever the reviewer changes the selected project via the dropdown
  // or when the auto-switch fires. App.jsx uses this to conditionally render
  // MobileStemStack vs WaveformReview.
  onAlbumChange,
}) {
  const [selectedAlbumId, setSelectedAlbumId] = useState(null);
  const [dropdownOpen,    setDropdownOpen]    = useState(false);

  const activeRef   = useRef(null);
  const selectorRef = useRef(null);

  const effectiveAlbums = Array.isArray(albums) && albums.length > 0 ? albums : null;
  const trackMap        = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const multiAlbum      = Boolean(effectiveAlbums && effectiveAlbums.length > 1);

  // Resolve selected album, falling back to the first one
  const selectedAlbum =
    (effectiveAlbums || []).find((a) => a.id === selectedAlbumId) ||
    (effectiveAlbums || [])[0];
  const hasProjectContext = Boolean(selectedAlbum);

  const isStemProject = selectedAlbum?.type === "stem_project";

  // Track list shown only for album-type projects.
  // Stem projects show MobileStemStack (rendered by App.jsx) instead.
  const displayTracks = multiAlbum
    ? (selectedAlbum?.trackIds || []).map((id) => trackMap[id]).filter(Boolean)
    : tracks;

  // ── Internal helpers ──────────────────────────────────────────────────────
  // Centralise album selection so both the dropdown click and the auto-switch
  // effect fire the same update + parent callback in one place.
  function applyAlbumSelection(albumId) {
    setSelectedAlbumId(albumId);
    onAlbumChange?.(albumId);
  }

  // Auto-switch to whichever album owns the newly-active track
  useEffect(() => {
    if (!multiAlbum || !effectiveAlbums || !activeTrackId) return;
    const owner = effectiveAlbums.find((a) =>
      (a.trackIds || []).includes(activeTrackId)
    );
    if (owner && owner.id !== selectedAlbumId) {
      applyAlbumSelection(owner.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrackId]);

  // Scroll the active track button into view (only relevant for album-type lists)
  useEffect(() => {
    if (!activeRef.current) return;
    const el  = activeRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTrackId, selectedAlbumId]);

  // X / Y counter — counts ALL projects regardless of type
  const currentAlbumIndex = (effectiveAlbums || []).findIndex(
    (a) => a.id === selectedAlbum?.id
  );
  const albumCount = (effectiveAlbums || []).length;
  const canOpenProjectDropdown = multiAlbum && albumCount > 1;

  useEffect(() => {
    if (!canOpenProjectDropdown && dropdownOpen) {
      setDropdownOpen(false);
    }
  }, [canOpenProjectDropdown, dropdownOpen]);

  // Close dropdown on outside tap
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <nav className="mobile-track-nav" aria-label="Track selector">

      {/* ── Project switcher ──────────────────────────────────────────────── */}
      {hasProjectContext && (
        <div className="mobile-project-selector" ref={selectorRef}>
          <button
            type="button"
            className="mobile-project-selector-btn"
            onClick={() => {
              if (canOpenProjectDropdown) {
                setDropdownOpen((v) => !v);
              }
            }}
            aria-haspopup={canOpenProjectDropdown ? "listbox" : undefined}
            aria-expanded={canOpenProjectDropdown ? dropdownOpen : undefined}
            aria-disabled={canOpenProjectDropdown ? undefined : "true"}
          >
            <span className="mobile-project-selector-eyebrow">Project</span>
            <span className="mobile-project-selector-name">
              {selectedAlbum?.title ?? "Select Project"}
            </span>
            {/* Type badge inside the selector button */}
            <span
              className={`mobile-project-type-tag mobile-project-type-tag--${albumTypeModifier(selectedAlbum?.type)}`}
              aria-hidden="true"
            >
              {albumTypeLabel(selectedAlbum?.type)}
            </span>
            {/* X / Y counter — total across all types */}
            {albumCount > 0 && (
              <span
                className="mobile-project-counter"
                aria-label={`${currentAlbumIndex + 1} of ${albumCount}`}
              >
                {currentAlbumIndex + 1}&thinsp;/&thinsp;{albumCount}
              </span>
            )}
            {canOpenProjectDropdown && (
              <span
                className={`mobile-project-chevron${dropdownOpen ? " open" : ""}`}
                aria-hidden="true"
              >
                ▾
              </span>
            )}
          </button>

          {canOpenProjectDropdown && dropdownOpen && (
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
                      applyAlbumSelection(album.id);
                      setDropdownOpen(false);
                    }}
                  >
                    {/* Project title */}
                    <span className="mobile-project-option-title">{album.title}</span>
                    {/* Type badge — visually distinguishes Album vs Stems */}
                    <span
                      className={`mobile-project-type-tag mobile-project-type-tag--${albumTypeModifier(album.type)}`}
                    >
                      {albumTypeLabel(album.type)}
                    </span>
                    {/* Active checkmark */}
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

      {/* ── Section label ─────────────────────────────────────────────────── */}
      <p className="mobile-track-nav-label">
        {isStemProject ? "Stems" : "Tracks"}
      </p>

      {/* ── Track list — hidden for stem projects (MobileStemStack takes over) */}
      {!isStemProject && (
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
      )}

    </nav>
  );
}
