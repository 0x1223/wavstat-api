import { useState, useEffect, useCallback } from 'react';

const WAVSTAT_BASE = import.meta.env.VITE_WAVSTAT_API || 'https://wavstat-api-production.up.railway.app';
const SP = 'https://api.spotify.com/v1';

// ── Token helpers ──────────────────────────────────────────────────────────────
function getToken()    { return localStorage.getItem('sp_token'); }
function getRefresh()  { return localStorage.getItem('sp_refresh'); }
function getExpiry()   { return parseInt(localStorage.getItem('sp_expiry') || '0'); }
function isExpired()   { return Date.now() > getExpiry() - 30_000; }

function saveTokens({ access_token, refresh_token, expires_in }) {
  localStorage.setItem('sp_token', access_token);
  if (refresh_token) localStorage.setItem('sp_refresh', refresh_token);
  localStorage.setItem('sp_expiry', String(Date.now() + (expires_in || 3600) * 1000));
}

export function clearSpotifyTokens() {
  localStorage.removeItem('sp_token');
  localStorage.removeItem('sp_refresh');
  localStorage.removeItem('sp_expiry');
}

async function freshToken() {
  const token = getToken();
  if (!token) return null;
  if (!isExpired()) return token;
  const rt = getRefresh();
  if (!rt) return null;
  try {
    const r = await fetch(`${WAVSTAT_BASE}/spotify/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    const d = await r.json();
    if (d.access_token) { saveTokens(d); return d.access_token; }
  } catch {}
  return null;
}

async function spFetch(path) {
  const token = await freshToken();
  if (!token) throw new Error('Not authenticated');
  const r = await fetch(`${SP}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 204) return null;
  if (r.status === 401) throw new Error('Token expired — please reconnect');
  if (!r.ok) throw new Error(`Spotify ${r.status}`);
  return r.json();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const TIME_RANGES = [
  { id: 'short_term',  label: '4 Weeks' },
  { id: 'medium_term', label: '6 Months' },
  { id: 'long_term',   label: 'All Time' },
];

function msToMins(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000)  return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function fmtNum(n) {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function genreCounts(artists) {
  const counts = {};
  for (const a of artists) {
    for (const g of (a.genres || [])) {
      counts[g] = (counts[g] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
}

function featureColor(key) {
  return { energy: '#ef4444', danceability: '#22c55e', valence: '#f59e0b' }[key] || '#6b7280';
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function FeatureBar({ value, label, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
      <span style={{ width: 28, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 4, background: 'var(--surface-3)', borderRadius: 2 }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ width: 24, textAlign: 'right', color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
        {Math.round(value * 100)}
      </span>
    </div>
  );
}

function ArtistCard({ artist, rank }) {
  const img = artist.images?.[0]?.url;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--dim)', width: 18, textAlign: 'right', flexShrink: 0 }}>
        {rank}
      </span>
      <div style={{ width: 42, height: 42, borderRadius: 21, background: 'var(--surface-3)', flexShrink: 0, overflow: 'hidden' }}>
        {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {artist.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          {fmtNum(artist.followers?.total)} followers
        </div>
        {artist.genres?.[0] && (
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(124,58,237,0.2)', color: 'var(--primary-light)' }}>
              {artist.genres[0]}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TrackRow({ track, rank, feature }) {
  const img = track.album?.images?.[2]?.url || track.album?.images?.[0]?.url;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '22px 36px 1fr auto', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--dim)', textAlign: 'right' }}>{rank}</span>
      <div style={{ width: 36, height: 36, borderRadius: 5, background: 'var(--surface-3)', overflow: 'hidden', flexShrink: 0 }}>
        {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {track.artists?.map(a => a.name).join(', ')}
        </div>
        {feature && (
          <div style={{ display: 'flex', gap: 8, marginTop: 5 }}>
            {['energy', 'danceability', 'valence'].map(k => (
              <FeatureBar key={k} value={feature[k]} label={k.slice(0, 3)} color={featureColor(k)} />
            ))}
          </div>
        )}
      </div>
      <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
        {msToMins(track.duration_ms)}
      </span>
    </div>
  );
}

function GenreChart({ genres }) {
  if (!genres.length) return null;
  const max = genres[0][1];
  const colors = ['#7c3aed','#6d28d9','#5b21b6','#4c1d95','#3730a3','#1d4ed8','#1e40af','#0369a1','#0e7490','#0f766e','#047857','#065f46'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {genres.map(([genre, count], i) => (
        <div key={genre} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 130, fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={genre}>
            {genre}
          </div>
          <div style={{ flex: 1, height: 7, background: 'var(--surface-3)', borderRadius: 4 }}>
            <div style={{ height: '100%', width: `${(count / max) * 100}%`, background: colors[i % colors.length], borderRadius: 4, transition: 'width 0.5s ease' }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--mono)', width: 20, textAlign: 'right' }}>{count}</span>
        </div>
      ))}
    </div>
  );
}

function RecentRow({ item }) {
  const track = item.track;
  const img = track.album?.images?.[2]?.url || track.album?.images?.[0]?.url;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: 34, height: 34, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden', flexShrink: 0 }}>
        {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{track.artists?.map(a => a.name).join(', ')}</div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
        {timeAgo(item.played_at)}
      </span>
    </div>
  );
}

function Section({ title, icon, loading, error, children }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
        {loading && <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>Loading…</span>}
      </div>
      {error && (
        <div style={{ fontSize: 12, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', padding: '8px 12px', borderRadius: 8 }}>{error}</div>
      )}
      {children}
    </div>
  );
}

// ── Login screen ───────────────────────────────────────────────────────────────
function LoginScreen({ error }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 40 }}>
      <div style={{ width: 64, height: 64, borderRadius: 32, background: '#1DB954', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 32px rgba(29,185,84,0.35)' }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="white">
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207 12.27 12.27 0 0 0-6.13-1.631.622.622 0 0 1 0-1.244 13.515 13.515 0 0 1 6.778 1.81.627.627 0 0 1 .209.858zm1.224-2.722a.779.779 0 0 1-1.07.26 15.314 15.314 0 0 0-7.648-2.037.779.779 0 0 1 0-1.558 16.857 16.857 0 0 1 8.457 2.264.78.78 0 0 1 .261 1.071zm.105-2.828a.935.935 0 0 1-1.284.313 18.36 18.36 0 0 0-9.15-2.444.935.935 0 0 1 0-1.87 20.194 20.194 0 0 1 10.12 2.713.935.935 0 0 1 .314 1.288z"/>
        </svg>
      </div>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Spotify Analytics</h1>
        <p style={{ fontSize: 14, maxWidth: 340, lineHeight: 1.6 }}>
          Connect your Spotify account to see your top artists, tracks, genres, and listening patterns.
        </p>
      </div>
      {error && (
        <div style={{ fontSize: 13, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', padding: '10px 16px', borderRadius: 8, maxWidth: 400, textAlign: 'center' }}>
          Connection error: {error}
        </div>
      )}
      <a
        href={`${WAVSTAT_BASE}/spotify/login`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          padding: '13px 28px', borderRadius: 50, border: 'none',
          background: '#1DB954', color: '#000', fontWeight: 700, fontSize: 15,
          textDecoration: 'none', cursor: 'pointer',
          boxShadow: '0 0 20px rgba(29,185,84,0.4)',
          transition: 'transform 0.1s, box-shadow 0.1s',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = '0 0 30px rgba(29,185,84,0.55)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '0 0 20px rgba(29,185,84,0.4)'; }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="black">
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207 12.27 12.27 0 0 0-6.13-1.631.622.622 0 0 1 0-1.244 13.515 13.515 0 0 1 6.778 1.81.627.627 0 0 1 .209.858zm1.224-2.722a.779.779 0 0 1-1.07.26 15.314 15.314 0 0 0-7.648-2.037.779.779 0 0 1 0-1.558 16.857 16.857 0 0 1 8.457 2.264.78.78 0 0 1 .261 1.071zm.105-2.828a.935.935 0 0 1-1.284.313 18.36 18.36 0 0 0-9.15-2.444.935.935 0 0 1 0-1.87 20.194 20.194 0 0 1 10.12 2.713.935.935 0 0 1 .314 1.288z"/>
        </svg>
        Connect with Spotify
      </a>
      <p style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 320, textAlign: 'center' }}>
        Requires read-only access to your Spotify data. No modifications are made to your account.
      </p>
    </div>
  );
}

// ── Main dashboard ─────────────────────────────────────────────────────────────
export default function SpotifyPage() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [authError, setAuthError] = useState(null);
  const [timeRange, setTimeRange] = useState('short_term');
  const [user, setUser] = useState(null);
  const [data, setData] = useState({});   // keyed by time range
  const [recent, setRecent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Read auth error from URL (set by backend on OAuth failure)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const err = p.get('spotify_error');
    if (err) {
      setAuthError(decodeURIComponent(err));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Load user profile once authenticated
  useEffect(() => {
    if (!authenticated) return;
    spFetch('/me').then(setUser).catch(err => {
      if (err.message.includes('authenticated') || err.message.includes('expired')) {
        setAuthenticated(false);
      }
    });
    spFetch('/me/player/recently-played?limit=30').then(d => setRecent(d?.items || [])).catch(() => {});
  }, [authenticated]);

  // Load time-range data when range changes or authenticated
  useEffect(() => {
    if (!authenticated) return;
    if (data[timeRange]) return; // already loaded

    setLoading(true);
    setLoadError(null);

    Promise.all([
      spFetch(`/me/top/artists?time_range=${timeRange}&limit=20`),
      spFetch(`/me/top/tracks?time_range=${timeRange}&limit=20`),
    ])
      .then(async ([artists, tracks]) => {
        const artistItems = artists?.items || [];
        const trackItems  = tracks?.items  || [];

        // Batch fetch audio features
        let features = {};
        const ids = trackItems.map(t => t.id).filter(Boolean).join(',');
        if (ids) {
          try {
            const fd = await spFetch(`/audio-features?ids=${ids}`);
            for (const f of (fd?.audio_features || [])) {
              if (f) features[f.id] = f;
            }
          } catch {}
        }

        setData(prev => ({ ...prev, [timeRange]: { artists: artistItems, tracks: trackItems, features } }));
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [authenticated, timeRange]); // eslint-disable-line

  const logout = () => {
    clearSpotifyTokens();
    setAuthenticated(false);
    setUser(null);
    setData({});
    setRecent(null);
  };

  if (!authenticated) {
    return (
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        <LoginScreen error={authError} />
      </div>
    );
  }

  const d = data[timeRange] || {};
  const genres = genreCounts(d.artists || []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0,
      }}>
        {user?.images?.[0]?.url ? (
          <img src={user.images[0].url} alt="" style={{ width: 36, height: 36, borderRadius: 18, objectFit: 'cover', border: '2px solid #1DB954' }} />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: 18, background: '#1DB954', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#000' }}>
            {user?.display_name?.[0]?.toUpperCase() || '?'}
          </div>
        )}
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{user?.display_name || 'Spotify User'}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {fmtNum(user?.followers?.total)} followers · {user?.product === 'premium' ? '✦ Premium' : 'Free'}
          </div>
        </div>

        {/* Time range tabs */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {TIME_RANGES.map(r => (
            <button
              key={r.id}
              onClick={() => setTimeRange(r.id)}
              style={{
                padding: '6px 14px', borderRadius: 20, border: '1px solid var(--border)',
                background: timeRange === r.id ? 'var(--primary)' : 'var(--surface-2)',
                color: timeRange === r.id ? '#fff' : 'var(--muted)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                boxShadow: timeRange === r.id ? '0 0 12px rgba(124,58,237,0.4)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          onClick={logout}
          style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}
        >
          Disconnect
        </button>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {loadError && (
          <div style={{ fontSize: 13, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', padding: '10px 16px', borderRadius: 8, marginBottom: 16 }}>
            {loadError}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* Top Artists */}
          <Section title="Top Artists" icon="🎤" loading={loading && !d.artists}>
            {(d.artists || []).length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {d.artists.slice(0, 10).map((a, i) => (
                  <ArtistCard key={a.id} artist={a} rank={i + 1} />
                ))}
              </div>
            ) : !loading ? (
              <p style={{ textAlign: 'center', padding: '20px 0' }}>No data for this time range.</p>
            ) : null}
          </Section>

          {/* Top Tracks */}
          <Section title="Top Tracks" icon="🎵" loading={loading && !d.tracks}>
            {(d.tracks || []).length > 0 ? (
              <div>
                {d.tracks.slice(0, 15).map((t, i) => (
                  <TrackRow key={t.id} track={t} rank={i + 1} feature={d.features?.[t.id]} />
                ))}
              </div>
            ) : !loading ? (
              <p style={{ textAlign: 'center', padding: '20px 0' }}>No data for this time range.</p>
            ) : null}
          </Section>

          {/* Genre Breakdown */}
          <Section title="Genre Breakdown" icon="🎭">
            {genres.length > 0 ? (
              <GenreChart genres={genres} />
            ) : (
              <p style={{ textAlign: 'center', padding: '20px 0' }}>
                {loading ? 'Loading…' : 'No genre data available.'}
              </p>
            )}
          </Section>

          {/* Recently Played */}
          <Section title="Recently Played" icon="🕐">
            {recent === null ? (
              <p style={{ color: 'var(--dim)', fontSize: 13 }}>Loading…</p>
            ) : recent.length > 0 ? (
              <div>
                {recent.slice(0, 20).map((item, i) => (
                  <RecentRow key={`${item.track.id}-${i}`} item={item} />
                ))}
              </div>
            ) : (
              <p style={{ textAlign: 'center', padding: '20px 0' }}>No recent listening history.</p>
            )}
          </Section>

        </div>
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}
