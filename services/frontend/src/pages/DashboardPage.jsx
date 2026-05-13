import { useState, useCallback, useRef } from 'react';
import {
  Search, X, Music2, Users, Play, Eye,
  Headphones, Zap, BarChart2, Disc3, Star,
} from 'lucide-react';

const API = 'https://wavstat-api-production.up.railway.app/api';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n) {
  const x = Number(n);
  if (!n && n !== 0) return '—';
  if (isNaN(x)) return '—';
  if (x >= 1e9) return (x / 1e9).toFixed(1) + 'B';
  if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(0) + 'K';
  return x.toLocaleString();
}

// ── Platform config ───────────────────────────────────────────────────────────

const P = {
  spotify:    { label: 'Spotify',    color: '#1DB954', bg: 'rgba(29,185,84,0.12)',   border: 'rgba(29,185,84,0.3)'  },
  lastfm:     { label: 'Last.fm',    color: '#d51007', bg: 'rgba(213,16,7,0.12)',    border: 'rgba(213,16,7,0.3)'   },
  youtube:    { label: 'YouTube',    color: '#ff3b30', bg: 'rgba(255,59,48,0.12)',   border: 'rgba(255,59,48,0.3)'  },
  soundcloud: { label: 'SoundCloud', color: '#ff5500', bg: 'rgba(255,85,0,0.12)',    border: 'rgba(255,85,0,0.3)'   },
};

// ── Small reusables ───────────────────────────────────────────────────────────

function PlatformBadge({ platform }) {
  const { label, color, bg, border } = P[platform];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', background: bg, border: `1px solid ${border}`, color }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 4px ${color}` }} />
      {label.toUpperCase()}
    </span>
  );
}

function StatPill({ icon: Icon, label, value, color = '#a78bfa' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', flex: 1, minWidth: 90 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {Icon && <Icon size={10} color={color} />}
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color, letterSpacing: '-0.5px', lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function Bar({ value = 0, max = 100, color = '#7c3aed', label, display }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', width: 76, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg,${color}88,${color})`, borderRadius: 2, transition: 'width 0.8s cubic-bezier(.4,0,.2,1)', boxShadow: `0 0 5px ${color}55` }} />
      </div>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', width: 30, textAlign: 'right' }}>{display ?? Math.round(pct)}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '12px 0' }} />;
}

function GenreTag({ tag }) {
  return (
    <span style={{ padding: '3px 9px', borderRadius: 20, fontSize: 10, background: 'rgba(124,58,237,0.18)', border: '1px solid rgba(124,58,237,0.3)', color: '#c4b5fd' }}>
      {tag}
    </span>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skel({ w = '100%', h = 16, r = 6 }) {
  return <div style={{ width: w, height: h, borderRadius: r, background: 'linear-gradient(90deg,rgba(255,255,255,0.06) 25%,rgba(255,255,255,0.1) 50%,rgba(255,255,255,0.06) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s infinite' }} />;
}

// ── Artist card ───────────────────────────────────────────────────────────────

function ArtistCard({ data, onRemove }) {
  const { artist, image, aggregated: agg, spotify, lastfm, youtube, soundcloud } = data;
  const genres = [
    ...(spotify?.genres  || []),
    ...(lastfm?.tags     || []).filter(t => !(spotify?.genres || []).includes(t)),
  ].slice(0, 5);

  return (
    <div
      style={{ background: 'linear-gradient(160deg,rgba(17,17,40,0.98) 0%,rgba(12,12,28,0.98) 100%)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, overflow: 'hidden', position: 'relative', boxShadow: '0 4px 40px rgba(0,0,0,0.5)', transition: 'transform 0.2s,box-shadow 0.2s' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 50px rgba(0,0,0,0.65)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '0 4px 40px rgba(0,0,0,0.5)'; }}
    >
      {/* Header */}
      <div style={{ display: 'flex', gap: 14, padding: '18px 18px 0', alignItems: 'flex-start' }}>
        <div style={{ width: 68, height: 68, borderRadius: 12, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', flexShrink: 0, border: '2px solid rgba(255,255,255,0.1)', boxShadow: '0 0 20px rgba(0,0,0,0.4)' }}>
          {image
            ? <img src={image} alt={artist} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Music2 size={26} color="rgba(255,255,255,0.2)" /></div>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.5px', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{artist}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
            {spotify    && <PlatformBadge platform="spotify" />}
            {lastfm     && <PlatformBadge platform="lastfm" />}
            {youtube    && <PlatformBadge platform="youtube" />}
            {soundcloud && <PlatformBadge platform="soundcloud" />}
          </div>
          {genres.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 7 }}>
              {genres.map(g => <GenreTag key={g} tag={g} />)}
            </div>
          )}
        </div>
        <button
          onClick={onRemove}
          style={{ width: 28, height: 28, borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.2)'; e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.4)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
        >
          <X size={12} />
        </button>
      </div>

      <div style={{ padding: '14px 18px 18px' }}>

        {/* Aggregated reach banner */}
        <div style={{ padding: '11px 14px', borderRadius: 12, background: 'linear-gradient(135deg,rgba(124,58,237,0.12),rgba(6,182,212,0.08))', border: '1px solid rgba(124,58,237,0.2)', marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>Total Reach</div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {agg.total_followers > 0 && (
              <div>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#e0d7ff', letterSpacing: '-1px', lineHeight: 1 }}>{fmt(agg.total_followers)}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Combined Followers</div>
              </div>
            )}
            {agg.lastfm_listeners > 0 && (
              <div>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#fca5a5', letterSpacing: '-1px', lineHeight: 1 }}>{fmt(agg.lastfm_listeners)}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Monthly Listeners</div>
              </div>
            )}
            {(agg.youtube_views + agg.soundcloud_plays + agg.lastfm_playcount) > 0 && (
              <div>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#6ee7b7', letterSpacing: '-1px', lineHeight: 1 }}>{fmt(agg.youtube_views + agg.soundcloud_plays + agg.lastfm_playcount)}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Total Plays / Views</div>
              </div>
            )}
          </div>
        </div>

        {/* Platform sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

          {spotify && (
            <div style={{ padding: '11px 13px', borderRadius: 12, background: P.spotify.bg, border: `1px solid ${P.spotify.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: P.spotify.color }}>Spotify</span>
                {spotify.url && <a href={spotify.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: P.spotify.color, opacity: 0.65, textDecoration: 'none' }}>Open ↗</a>}
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
                <StatPill icon={Users} label="Followers"   value={fmt(spotify.followers)} color={P.spotify.color} />
                <StatPill icon={Star}  label="Popularity"  value={`${spotify.popularity}/100`} color={P.spotify.color} />
              </div>
              <Bar label="Popularity" value={spotify.popularity} max={100} color={P.spotify.color} display={spotify.popularity} />
            </div>
          )}

          {lastfm && (
            <div style={{ padding: '11px 13px', borderRadius: 12, background: P.lastfm.bg, border: `1px solid ${P.lastfm.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: P.lastfm.color, marginBottom: 9 }}>Last.fm</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
                <StatPill icon={Headphones} label="Listeners" value={fmt(lastfm.listeners)} color={P.lastfm.color} />
                <StatPill icon={Play}       label="Scrobbles" value={fmt(lastfm.playcount)} color={P.lastfm.color} />
              </div>
              {lastfm.listeners > 0 && <Bar label="Listeners" value={Math.min(lastfm.listeners, 10_000_000)} max={10_000_000} color={P.lastfm.color} display={fmt(lastfm.listeners)} />}
              {lastfm.bio && (
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', marginTop: 8, lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{lastfm.bio}</p>
              )}
            </div>
          )}

          {youtube && (
            <div style={{ padding: '11px 13px', borderRadius: 12, background: P.youtube.bg, border: `1px solid ${P.youtube.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: P.youtube.color }}>YouTube</span>
                <a href={youtube.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: P.youtube.color, opacity: 0.65, textDecoration: 'none' }}>Channel ↗</a>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
                <StatPill icon={Users} label="Subscribers" value={fmt(youtube.subscribers)} color={P.youtube.color} />
                <StatPill icon={Eye}   label="Total Views"  value={fmt(youtube.total_views)} color={P.youtube.color} />
                <StatPill icon={Play}  label="Videos"       value={fmt(youtube.video_count)} color={P.youtube.color} />
              </div>
              <Bar label="Subscribers" value={Math.min(youtube.subscribers, 50_000_000)} max={50_000_000} color={P.youtube.color} display={fmt(youtube.subscribers)} />
            </div>
          )}

          {soundcloud && (
            <div style={{ padding: '11px 13px', borderRadius: 12, background: P.soundcloud.bg, border: `1px solid ${P.soundcloud.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: P.soundcloud.color }}>SoundCloud</span>
                {soundcloud.url && <a href={soundcloud.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: P.soundcloud.color, opacity: 0.65, textDecoration: 'none' }}>Profile ↗</a>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <StatPill icon={Users}  label="Followers"   value={fmt(soundcloud.followers)}      color={P.soundcloud.color} />
                <StatPill icon={Play}   label="Total Plays" value={fmt(soundcloud.playback_count)} color={P.soundcloud.color} />
                <StatPill icon={Music2} label="Tracks"      value={fmt(soundcloud.track_count)}    color={P.soundcloud.color} />
              </div>
            </div>
          )}

          {/* Cross-platform comparison bars */}
          {[spotify, lastfm, youtube, soundcloud].filter(Boolean).length > 1 && (
            <>
              <Divider />
              <div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 9, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <BarChart2 size={9} /> Reach Comparison
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {spotify    && <Bar label="Spotify"    value={Math.min(agg.spotify_followers,    50e6)} max={50e6} color={P.spotify.color}    display={fmt(agg.spotify_followers)} />}
                  {youtube    && <Bar label="YouTube"    value={Math.min(agg.youtube_subscribers,  50e6)} max={50e6} color={P.youtube.color}    display={fmt(agg.youtube_subscribers)} />}
                  {soundcloud && <Bar label="SoundCloud" value={Math.min(agg.soundcloud_followers, 50e6)} max={50e6} color={P.soundcloud.color} display={fmt(agg.soundcloud_followers)} />}
                  {lastfm     && <Bar label="Last.fm"    value={Math.min(agg.lastfm_listeners,     50e6)} max={50e6} color={P.lastfm.color}     display={fmt(agg.lastfm_listeners)} />}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Loading skeleton card ─────────────────────────────────────────────────────

function LoadingCard({ name }) {
  return (
    <div style={{ background: 'linear-gradient(160deg,rgba(17,17,40,0.98),rgba(12,12,28,0.98))', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, padding: 18, boxShadow: '0 4px 40px rgba(0,0,0,0.5)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 14 }}>
        <Skel w={68} h={68} r={12} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,0.55)' }}>{name}</div>
          <Skel w={150} h={20} r={10} />
          <Skel w={110} h={15} r={10} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <Skel h={58} r={12} />
        <Skel h={74} r={12} />
        <Skel h={74} r={12} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
        <div style={{ width: 14, height: 14, border: '2px solid rgba(124,58,237,0.4)', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        Fetching data…
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

const EXAMPLES = ['Drake', 'Taylor Swift', 'Kendrick Lamar', 'Billie Eilish', 'The Weeknd'];

function EmptyState({ onExample }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 22, textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 90, height: 90 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle,rgba(124,58,237,0.2) 0%,transparent 70%)', animation: 'pulse 2.2s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', inset: 12, borderRadius: '50%', background: 'rgba(124,58,237,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Disc3 size={34} color="#7c3aed" />
        </div>
      </div>
      <div>
        <h2 style={{ fontSize: 21, fontWeight: 800, color: '#e4e4f2', letterSpacing: '-0.5px', marginBottom: 8 }}>Search Any Artist</h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.38)', maxWidth: 380, lineHeight: 1.7 }}>
          Aggregated intelligence from Spotify, Last.fm, YouTube, and SoundCloud in one view. Add multiple artists to compare.
        </p>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, justifyContent: 'center' }}>
        {EXAMPLES.map(name => (
          <button
            key={name}
            onClick={() => onExample(name)}
            style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.25)', color: '#c4b5fd', cursor: 'pointer', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; e.currentTarget.style.borderColor = 'rgba(124,58,237,0.5)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; e.currentTarget.style.borderColor = 'rgba(124,58,237,0.25)'; }}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Ambient orbs ──────────────────────────────────────────────────────────────

function Orbs() {
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 0 }}>
      <div style={{ position: 'absolute', top: '-15%', left: '-10%', width: 560, height: 560, borderRadius: '50%', background: 'radial-gradient(circle,rgba(124,58,237,0.07) 0%,transparent 70%)', animation: 'float 22s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', top: '35%', right: '-15%', width: 480, height: 480, borderRadius: '50%', background: 'radial-gradient(circle,rgba(6,182,212,0.06) 0%,transparent 70%)', animation: 'float 28s ease-in-out infinite reverse' }} />
      <div style={{ position: 'absolute', bottom: '-10%', left: '30%', width: 380, height: 380, borderRadius: '50%', background: 'radial-gradient(circle,rgba(29,185,84,0.05) 0%,transparent 70%)', animation: 'float 19s ease-in-out infinite 4s' }} />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [query, setQuery]     = useState('');
  const [artists, setArtists] = useState([]);   // [{ key, data | null }]
  const [loading, setLoading] = useState({});   // key → bool
  const [errors, setErrors]   = useState({});   // key → string
  const inputRef = useRef(null);

  const addArtist = useCallback(async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (artists.some(a => a.key === key)) { setQuery(''); return; }

    setQuery('');
    setLoading(p => ({ ...p, [key]: true }));
    setErrors(p => { const n = { ...p }; delete n[key]; return n; });
    setArtists(p => [...p, { key, data: null }]);

    try {
      const res = await fetch(`${API}/artist/${encodeURIComponent(trimmed)}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      setArtists(p => p.map(a => a.key === key ? { key, data } : a));
    } catch (err) {
      setErrors(p => ({ ...p, [key]: err.message }));
      setArtists(p => p.filter(a => a.key !== key));
    } finally {
      setLoading(p => { const n = { ...p }; delete n[key]; return n; });
    }
  }, [artists]);

  const remove = useCallback((key) => {
    setArtists(p => p.filter(a => a.key !== key));
    setErrors(p => { const n = { ...p }; delete n[key]; return n; });
  }, []);

  const loadedArtists = artists.filter(a => a.data !== null);
  const pendingKeys   = artists.filter(a => a.data === null).map(a => a.key);
  const isEmpty       = loadedArtists.length === 0 && pendingKeys.length === 0;

  return (
    <>
      <style>{`
        @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes float   { 0%,100%{transform:translate(0,0)} 50%{transform:translate(18px,-28px)} }
        @keyframes pulse   { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.18);opacity:0.55} }
        @keyframes fadeUp  { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      <Orbs />

      <div style={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '16px 24px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, background: 'rgba(5,5,18,0.88)', backdropFilter: 'blur(14px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
            <div style={{ flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Zap size={16} color="#7c3aed" />
                <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.4px', color: '#e4e4f2' }}>Intelligence</span>
                {loadedArtists.length > 0 && (
                  <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.3)', color: '#c4b5fd', fontWeight: 600 }}>
                    {loadedArtists.length} artist{loadedArtists.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>Spotify · Last.fm · YouTube · SoundCloud</div>
            </div>

            {/* Search bar */}
            <div style={{ flex: 1, maxWidth: 460, position: 'relative' }}>
              <Search size={14} color="rgba(255,255,255,0.28)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && query.trim() && addArtist(query)}
                placeholder="Search artist… press Enter to add"
                style={{ width: '100%', padding: '9px 12px 9px 34px', borderRadius: 11, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.06)', color: '#e4e4f2', fontSize: 13, outline: 'none', transition: 'border-color 0.15s,box-shadow 0.15s' }}
                onFocus={e => { e.target.style.borderColor = 'rgba(124,58,237,0.6)'; e.target.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.12)'; }}
                onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)';  e.target.style.boxShadow = 'none'; }}
              />
              {query.trim() && (
                <button
                  onClick={() => addArtist(query)}
                  style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', padding: '4px 11px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >
                  Add
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Error toasts */}
        {Object.keys(errors).length > 0 && (
          <div style={{ padding: '8px 24px 0', flexShrink: 0 }}>
            <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {Object.entries(errors).map(([key, msg]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 13px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', fontSize: 12 }}>
                  <span style={{ flex: 1 }}>Could not find <strong>"{key}"</strong>: {msg}</span>
                  <button onClick={() => setErrors(p => { const n = {...p}; delete n[key]; return n; })} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', padding: 2 }}><X size={11} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 32px' }}>
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            {isEmpty ? (
              <EmptyState onExample={addArtist} />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 16 }}>
                {pendingKeys.map(key  => <LoadingCard key={key} name={key} />)}
                {loadedArtists.map(({ key, data }) => (
                  <div key={key} style={{ animation: 'fadeUp 0.32s ease forwards' }}>
                    <ArtistCard data={data} onRemove={() => remove(key)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
