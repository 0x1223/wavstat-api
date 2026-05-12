import { useState, useEffect } from 'react';

const LASTFM_KEY = 'lfm_api_key';
const LASTFM_USER_KEY = 'lfm_user';
const YT_KEY = 'yt_api_key';
const YT_CHANNEL_KEY = 'yt_channel';

function StatCard({ label, value, sub, color = 'var(--accent)' }) {
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color, letterSpacing: '-0.5px' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BarChart({ data = [], max }) {
  const m = max || Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 120, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.label}>{d.label}</div>
          <div style={{ flex: 1, height: 8, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / m) * 100}%`, background: 'linear-gradient(90deg, var(--primary), var(--accent))', borderRadius: 4, transition: 'width 0.6s ease' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', width: 60, textAlign: 'right' }}>{Number(d.value).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, icon, children, loading, error }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
        {loading && <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>Loading…</span>}
      </div>
      {error && <div style={{ fontSize: 13, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', padding: '8px 12px', borderRadius: 8 }}>{error}</div>}
      {children}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>{label}</label>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none' }}
      />
    </div>
  );
}

function useLastFM(apiKey, user) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!apiKey || !user) return;
    setLoading(true); setError(null); setData(null);
    const base = `https://ws.audioscrobbler.com/2.0/?api_key=${apiKey}&user=${user}&format=json`;
    Promise.all([
      fetch(`${base}&method=user.getinfo`).then(r => r.json()),
      fetch(`${base}&method=user.gettopartists&period=7day&limit=8`).then(r => r.json()),
      fetch(`${base}&method=user.gettoptracks&period=7day&limit=8`).then(r => r.json()),
      fetch(`${base}&method=user.getrecenttracks&limit=5`).then(r => r.json()),
    ]).then(([info, artists, tracks, recent]) => {
      if (info.error) throw new Error(info.message);
      setData({ info: info.user, artists: artists.topartists?.artist, tracks: tracks.toptracks?.track, recent: recent.recenttracks?.track });
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [apiKey, user]);

  return { data, loading, error };
}

function useYouTube(apiKey, channelHandle) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!apiKey || !channelHandle) return;
    setLoading(true); setError(null); setData(null);
    const handle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
    fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&forHandle=${handle}&key=${apiKey}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error.message);
        const ch = d.items?.[0];
        if (!ch) throw new Error('Channel not found');
        setData({ name: ch.snippet.title, stats: ch.statistics, thumb: ch.snippet.thumbnails?.default?.url });
      }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [apiKey, channelHandle]);

  return { data, loading, error };
}

export default function DashboardPage() {
  const [lfmKey, setLfmKey] = useState(() => localStorage.getItem(LASTFM_KEY) || '');
  const [lfmUser, setLfmUser] = useState(() => localStorage.getItem(LASTFM_USER_KEY) || '');
  const [ytKey, setYtKey] = useState(() => localStorage.getItem(YT_KEY) || '');
  const [ytChannel, setYtChannel] = useState(() => localStorage.getItem(YT_CHANNEL_KEY) || '');
  const [applied, setApplied] = useState({ lfmKey, lfmUser, ytKey, ytChannel });

  const save = () => {
    localStorage.setItem(LASTFM_KEY, lfmKey);
    localStorage.setItem(LASTFM_USER_KEY, lfmUser);
    localStorage.setItem(YT_KEY, ytKey);
    localStorage.setItem(YT_CHANNEL_KEY, ytChannel);
    setApplied({ lfmKey, lfmUser, ytKey, ytChannel });
  };

  const lfm = useLastFM(applied.lfmKey, applied.lfmUser);
  const yt = useYouTube(applied.ytKey, applied.ytChannel);

  const fmtNum = n => n ? Number(n).toLocaleString() : '—';

  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1100 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 4 }}>Music Intelligence</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>Last.fm · YouTube · SoundCloud stats in one view</p>

        {/* Settings */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>⚙️ API Settings</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <Input label="Last.fm API Key" value={lfmKey} onChange={setLfmKey} placeholder="Get free key at last.fm/api" />
            <Input label="Last.fm Username" value={lfmUser} onChange={setLfmUser} placeholder="your_username" />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Input label="YouTube API Key" value={ytKey} onChange={setYtKey} placeholder="AIza..." />
            <Input label="YouTube Channel Handle" value={ytChannel} onChange={setYtChannel} placeholder="@YourChannel" />
          </div>
          <button
            onClick={save}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', boxShadow: '0 0 14px rgba(124,58,237,0.3)' }}
          >
            Apply & Fetch
          </button>
        </div>

        {/* Last.fm */}
        <Section title="Last.fm" icon="🎵" loading={lfm.loading} error={lfm.error}>
          {!applied.lfmKey && <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>Enter a Last.fm API key and username above to load stats.</p>}
          {lfm.data && (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <StatCard label="Total Scrobbles" value={fmtNum(lfm.data.info?.playcount)} color="var(--primary-light)" />
                <StatCard label="Artists" value={fmtNum(lfm.data.info?.artist_count)} color="var(--accent)" />
                <StatCard label="Loved Tracks" value={fmtNum(lfm.data.info?.loved_track_count)} color="var(--success)" />
                <StatCard label="Country" value={lfm.data.info?.country || '—'} color="var(--text)" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>TOP ARTISTS (7 DAYS)</div>
                  <BarChart data={(lfm.data.artists || []).map(a => ({ label: a.name, value: Number(a.playcount) }))} />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>TOP TRACKS (7 DAYS)</div>
                  <BarChart data={(lfm.data.tracks || []).map(t => ({ label: `${t.name} — ${t.artist.name}`, value: Number(t.playcount) }))} />
                </div>
              </div>
              {lfm.data.recent && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>RECENTLY PLAYED</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {lfm.data.recent.filter(t => !t['@attr']?.nowplaying).slice(0, 5).map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                        {t.image?.[1]?.['#text'] && <img src={t.image[1]['#text']} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.artist['#text']}</div>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{t.date?.['#text']}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Section>

        <div style={{ marginTop: 20 }} />

        {/* YouTube */}
        <Section title="YouTube" icon="▶️" loading={yt.loading} error={yt.error}>
          {!applied.ytKey && <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>Enter a YouTube Data API v3 key and channel handle above.</p>}
          {yt.data && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
                {yt.data.thumb && <img src={yt.data.thumb} alt="" style={{ width: 48, height: 48, borderRadius: 24, border: '2px solid var(--border)' }} />}
                <div style={{ fontSize: 16, fontWeight: 700 }}>{yt.data.name}</div>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <StatCard label="Subscribers" value={fmtNum(yt.data.stats?.subscriberCount)} color="var(--error)" />
                <StatCard label="Total Views" value={fmtNum(yt.data.stats?.viewCount)} color="var(--accent)" />
                <StatCard label="Videos" value={fmtNum(yt.data.stats?.videoCount)} color="var(--primary-light)" />
              </div>
            </>
          )}
        </Section>

        <div style={{ marginTop: 20 }} />

        {/* SoundCloud placeholder */}
        <Section title="SoundCloud" icon="☁️">
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>SoundCloud API Unavailable</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 380, margin: '0 auto' }}>
              SoundCloud revoked public API access in 2019. Use the <a href="https://soundcloud.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>SoundCloud website</a> directly to view your stats.
            </div>
          </div>
        </Section>

        <div style={{ height: 32 }} />
      </div>
    </div>
  );
}
