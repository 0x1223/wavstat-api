import { useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import DigitizerPage from './pages/DigitizerPage.jsx';
import ViewerPage from './pages/ViewerPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';

export default function App() {
  const [page, setPage] = useState('digitizer');

  const pages = {
    digitizer: <DigitizerPage />,
    viewer: <ViewerPage />,
    dashboard: <DashboardPage />,
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
