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
      {/* Wordmark */}
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
              color: active ? '#fff' : 'var(--dim)',
              background: active ? 'var(--primary)' : 'transparent',
              boxShadow: active ? '0 0 16px rgba(124,58,237,0.45)' : 'none',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => {
              if (!active) { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--muted)'; }
            }}
            onMouseLeave={e => {
              if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--dim)'; }
            }}
          >
            {icon}
            {active && (
              <div style={{
                position: 'absolute', left: -1, top: '50%', transform: 'translateY(-50%)',
                width: 3, height: 20, background: 'var(--accent)',
                borderRadius: '0 2px 2px 0',
              }} />
            )}
          </div>
        );
      })}
    </nav>
  );
}
