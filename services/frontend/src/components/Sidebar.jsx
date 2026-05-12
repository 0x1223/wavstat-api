const NAV = [
  {
    id: 'digitizer',
    label: 'Digitizer',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10"/><path d="m15 9-3 3-3-3"/><path d="M12 12v8"/><path d="m19 19 3 3"/><path d="M22 22h-3v-3"/>
      </svg>
    ),
  },
  {
    id: 'viewer',
    label: 'Viewer',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    ),
  },
  {
    id: 'spotify',
    label: 'Spotify',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207 12.27 12.27 0 0 0-6.13-1.631.622.622 0 0 1 0-1.244 13.515 13.515 0 0 1 6.778 1.81.627.627 0 0 1 .209.858zm1.224-2.722a.779.779 0 0 1-1.07.26 15.314 15.314 0 0 0-7.648-2.037.779.779 0 0 1 0-1.558 16.857 16.857 0 0 1 8.457 2.264.78.78 0 0 1 .261 1.071zm.105-2.828a.935.935 0 0 1-1.284.313 18.36 18.36 0 0 0-9.15-2.444.935.935 0 0 1 0-1.87 20.194 20.194 0 0 1 10.12 2.713.935.935 0 0 1 .314 1.288z"/>
      </svg>
    ),
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 19V6l12-3v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
      </svg>
    ),
  },
];

export default function Sidebar({ current, onNav }) {
  return (
    <nav style={{
      width: 64,
      minWidth: 64,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 20,
      paddingBottom: 20,
      gap: 6,
    }}>
      {/* Logo mark */}
      <div style={{
        width: 36, height: 36,
        borderRadius: 9,
        background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 15, color: '#fff', letterSpacing: '-1px',
        marginBottom: 22,
        flexShrink: 0,
        boxShadow: '0 0 20px rgba(124,58,237,0.45)',
      }}>W</div>

      {NAV.map(({ id, label, icon }) => {
        const active = current === id;
        const isSpotify = id === 'spotify';
        return (
          <div
            key={id}
            onClick={() => onNav(id)}
            title={label}
            style={{
              position: 'relative',
              width: 40, height: 40,
              borderRadius: 9,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              color: active ? (isSpotify ? '#000' : '#fff') : (isSpotify ? '#1DB954' : 'var(--dim)'),
              background: active ? (isSpotify ? '#1DB954' : 'var(--primary)') : 'transparent',
              boxShadow: active ? (isSpotify ? '0 0 16px rgba(29,185,84,0.5)' : '0 0 16px rgba(124,58,237,0.45)') : 'none',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => {
              if (!active) {
                e.currentTarget.style.background = 'var(--surface-2)';
                e.currentTarget.style.color = isSpotify ? '#1DB954' : 'var(--muted)';
              }
            }}
            onMouseLeave={e => {
              if (!active) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = isSpotify ? '#1DB954' : 'var(--dim)';
              }
            }}
          >
            {icon}
            {active && (
              <div style={{
                position: 'absolute', left: -1, top: '50%', transform: 'translateY(-50%)',
                width: 3, height: 20,
                background: isSpotify ? '#1DB954' : 'var(--accent)',
                borderRadius: '0 2px 2px 0',
              }} />
            )}
          </div>
        );
      })}
    </nav>
  );
}
