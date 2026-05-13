import { useState, useEffect } from 'react';
import { Music2, ExternalLink, RefreshCw, TrendingUp } from 'lucide-react';

const API = 'https://wavstat-api-production.up.railway.app/api/charts/spotify';

const CHARTS = [
  { id: 'global', label: 'Global Top 50' },
  { id: 'us',     label: 'US Top 50'     },
  { id: 'viral',  label: 'Viral 50'      },
];

function msToMin(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function PopBar({ value }) {
  return (
    <div title={`Popularity: ${value}/100`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${value}%`, background: value > 79 ? '#1DB954' : value > 59 ? '#a78bfa' : 'rgba(255,255,255,0.3)', borderRadius: 2, transition: 'width 0.6s ease' }} />
      </div>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', width: 20 }}>{value}</span>
    </div>
  );
}

function TrackRow({ track, view }) {
  const [imgErr, setImgErr] = useState(false);
  const isHot = track.rank <= 3;

  if (view === 'grid') {
    return (
      <a
        href={track.url || '#'}
        target="_blank"
        rel="noreferrer"
        style={{ display: 'flex', flexDirection: 'column', gap: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden', textDecoration: 'none', color: 'inherit', transition: 'transform 0.15s, border-color 0.15s' }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'rgba(29,185,84,0.35)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
      >
        <div style={{ position: 'relative', aspectRatio: '1', background: 'rgba(255,255,255,0.06)' }}>
          {track.cover && !imgErr
            ? <img src={track.cover} alt="" onError={() => setImgErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Music2 size={32} color="rgba(255,255,255,0.15)" /></div>
          }
          <div style={{ position: 'absolute', top: 8, left: 8, width: 26, height: 26, borderRadius: 13, background: isHot ? '#1DB954' : 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: isHot ? '#000' : 'rgba(255,255,255,0.7)' }}>
            {track.rank}
          </div>
        </div>
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e4e4f2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.artist}</div>
          <div style={{ marginTop: 8 }}><PopBar value={track.popularity} /></div>
        </div>
      </a>
    );
  }

  // List view
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '36px 44px 1fr auto auto auto', alignItems: 'center', gap: 12, padding: '7px 14px', borderRadius: 8, transition: 'background 0.12s' }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Rank */}
      <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 800, color: isHot ? '#1DB954' : 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums' }}>
        {track.rank}
      </div>

      {/* Cover */}
      <div style={{ width: 44, height: 44, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', flexShrink: 0 }}>
        {track.cover && !imgErr
          ? <img src={track.cover} alt="" onError={() => setImgErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Music2 size={18} color="rgba(255,255,255,0.15)" /></div>
        }
      </div>

      {/* Title + artist */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e4e4f2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.artist}</div>
      </div>

      {/* Popularity bar */}
      <PopBar value={track.popularity} />

      {/* Duration */}
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {msToMin(track.duration_ms)}
      </span>

      {/* Spotify link */}
      {track.url
        ? <a href={track.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'rgba(255,255,255,0.25)', display: 'flex', transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = '#1DB954'}
            onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.25)'}
          >
            <ExternalLink size={13} />
          </a>
        : <span style={{ width: 13 }} />
      }
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 0 8px' }}>
      {Array.from({ length: 20 }).map((_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '36px 44px 1fr auto auto auto', gap: 12, padding: '7px 14px', alignItems: 'center' }}>
          <div style={{ height: 14, borderRadius: 4, background: 'rgba(255,255,255,0.06)', width: 20, marginLeft: 'auto' }} />
          <div style={{ width: 44, height: 44, borderRadius: 6, background: 'rgba(255,255,255,0.06)', animation: 'shimmer 1.5s infinite', backgroundSize: '200% 100%' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ height: 13, borderRadius: 4, background: 'rgba(255,255,255,0.07)', width: `${50 + Math.random() * 40}%`, animation: 'shimmer 1.5s infinite' }} />
            <div style={{ height: 11, borderRadius: 4, background: 'rgba(255,255,255,0.05)', width: `${30 + Math.random() * 30}%`, animation: 'shimmer 1.5s infinite' }} />
          </div>
          <div style={{ width: 74, height: 11, borderRadius: 4, background: 'rgba(255,255,255,0.05)' }} />
          <div style={{ width: 28, height: 11, borderRadius: 4, background: 'rgba(255,255,255,0.05)' }} />
          <div style={{ width: 13, height: 13, borderRadius: 3, background: 'rgba(255,255,255,0.04)' }} />
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [chart, setChart]   = useState('global');
  const [view, setView]     = useState('list');   // 'list' | 'grid'
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [cache, setCache]   = useState({});       // chart id → data

  const load = async (chartId, force = false) => {
    if (!force && cache[chartId]) { setData(cache[chartId]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}?chart=${chartId}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setCache(p => ({ ...p, [chartId]: d }));
      setData(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(chart); }, [chart]); // eslint-disable-line

  const tracks = data?.tracks || [];

  return (
    <>
      <style>{`
        @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
        @keyframes spin    { to{transform:rotate(360deg)} }
      `}</style>

      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 14, background: '#1DB954', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TrendingUp size={14} color="#000" />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#e4e4f2', letterSpacing: '-0.3px' }}>
                {data?.playlist_name || 'Spotify Charts'}
              </div>
              {data && (
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                  {tracks.length} tracks · updated {new Date(data.updated_at).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>

          {/* Chart selector */}
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            {CHARTS.map(c => (
              <button
                key={c.id}
                onClick={() => setChart(c.id)}
                style={{ padding: '5px 12px', borderRadius: 20, border: '1px solid', fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                  borderColor: chart === c.id ? '#1DB954' : 'rgba(255,255,255,0.12)',
                  background:  chart === c.id ? 'rgba(29,185,84,0.15)' : 'transparent',
                  color:       chart === c.id ? '#1DB954' : 'rgba(255,255,255,0.5)',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* View toggle + refresh */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: 2 }}>
              {['list', 'grid'].map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  style={{ padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.12s',
                    background: view === v ? 'rgba(255,255,255,0.12)' : 'transparent',
                    color: view === v ? '#e4e4f2' : 'rgba(255,255,255,0.35)',
                  }}
                >
                  {v === 'list' ? '≡ List' : '⊞ Grid'}
                </button>
              ))}
            </div>
            <button
              onClick={() => load(chart, true)}
              disabled={loading}
              style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', cursor: loading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <RefreshCw size={12} style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ margin: '12px 20px 0', padding: '10px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Track list / grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: view === 'grid' ? '16px 16px 24px' : '8px 0 24px' }}>
          {loading ? (
            <Skeleton />
          ) : view === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
              {tracks.map(t => <TrackRow key={t.id} track={t} view="grid" />)}
            </div>
          ) : (
            <div>
              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '36px 44px 1fr auto auto auto', gap: 12, padding: '4px 14px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 4 }}>
                <div style={{ textAlign: 'right', fontSize: 9, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>#</div>
                <div />
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Title</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Popularity</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Time</div>
                <div />
              </div>
              {tracks.map(t => <TrackRow key={t.id} track={t} view="list" />)}
            </div>
          )}
        </div>

      </div>
    </>
  );
}
