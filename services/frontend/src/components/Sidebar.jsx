const NAV = [
  {
    id: 'digitizer',
    label: 'Digitizer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
    ),
  },
  {
    id: 'viewer',
    label: 'Viewer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    ),
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 19V6l12-3v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
    ),
  },
];

export default function Sidebar({ current, onNav }) {
  return (
    <nav style={{
      width: 72,
      minWidth: 72,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '16px 0',
      gap: 4,
    }}>
      {/* Logo */}
      <div style={{
        width: 40, height: 40,
        borderRadius: 10,
        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 24,
        fontWeight: 700, fontSize: 18, color: '#fff', letterSpacing: '-0.5px',
        boxShadow: '0 0 24px rgba(124,58,237,0.4)',
      }}>W</div>

      {/* Nav items */}
      {NAV.map(({ id, label, icon }) => {
        const active = current === id;
        return (
          <div
            key={id}
            onClick={() => onNav(id)}
            title={label}
            style={{
              width: 44, height: 44,
              borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              color: active ? '#fff' : 'var(--text-muted)',
              background: active ? 'var(--primary)' : 'transparent',
              boxShadow: active ? '0 0 16px rgba(124,58,237,0.5)' : 'none',
              transition: 'all 0.18s ease',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <div style={{ width: 20, height: 20 }}>{icon}</div>
          </div>
        );
      })}
    </nav>
  );
}
