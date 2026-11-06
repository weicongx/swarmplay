import { useEffect, useState } from 'react'
import DownloadsPage from './pages/DownloadsPage'
import SearchPage from './pages/SearchPage'
import SettingsPage from './pages/SettingsPage'

type Page = 'search' | 'downloads' | 'library' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' }
]

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('search')
  const [activeDownloads, setActiveDownloads] = useState(0)

  useEffect(
    () =>
      window.api.onTorrentsUpdate((list) =>
        setActiveDownloads(list.filter((t) => t.status === 'downloading' || t.status === 'starting').length)
      ),
    []
  )

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">Anime</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id ? 'active' : ''}`}
            onClick={() => setPage(n.id)}
          >
            {n.label}
            {n.id === 'downloads' && activeDownloads > 0 && <span className="badge">{activeDownloads}</span>}
          </button>
        ))}
      </nav>
      <main className="content">
        {/* Search stays mounted so results survive switching tabs. */}
        <div className="page-slot" hidden={page !== 'search'}>
          <SearchPage onOpenDownloads={() => setPage('downloads')} />
        </div>
        {page === 'downloads' && <DownloadsPage />}
        {page === 'library' && <Placeholder title="Library" note="Series folders arrive in phase 4." />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

function Placeholder({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <div className="page">
      <h1>{title}</h1>
      <p className="muted">{note}</p>
    </div>
  )
}
