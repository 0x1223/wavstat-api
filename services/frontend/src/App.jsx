import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar.jsx';
import DigitizerPage from './pages/DigitizerPage.jsx';
import ViewerPage from './pages/ViewerPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import SpotifyPage from './pages/SpotifyPage.jsx';

function detectInitialPage() {
  const p = new URLSearchParams(window.location.search);
  if (p.has('access_token') || p.has('spotify_error')) return 'spotify';
  return 'digitizer';
}

export default function App() {
  const [page, setPage] = useState(detectInitialPage);

  // Handle Spotify OAuth callback — tokens arrive as query params
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const accessToken  = p.get('access_token');
    const refreshToken = p.get('refresh_token');
    const expiresIn    = p.get('expires_in');

    if (accessToken) {
      localStorage.setItem('sp_token', accessToken);
      if (refreshToken) localStorage.setItem('sp_refresh', refreshToken);
      if (expiresIn)    localStorage.setItem('sp_expiry', String(Date.now() + parseInt(expiresIn) * 1000));
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      const err = p.get('spotify_error');
      if (err) window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const pages = {
    digitizer: <DigitizerPage />,
    viewer:    <ViewerPage />,
    dashboard: <DashboardPage />,
    spotify:   <SpotifyPage />,
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={page} onNav={setPage} />
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        {pages[page]}
      </main>
    </div>
  );
}
