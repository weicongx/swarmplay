import { useEffect, useState } from 'react'
import DownloadsPage from './pages/DownloadsPage'
import LibraryPage from './pages/LibraryPage'
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
  // Bumping `n` remounts the library at the requested folder (e.g. from a notification click).
  const [libraryTarget, setLibraryTarget] = useState<{ folderId: number | null; n: number }>({ folderId: null, n: 0 })

  useEffect(
    () =>
      window.api.onNavigate((to) => {
        setLibraryTarget((t) => ({ folderId: to.folderId, n: t.n + 1 }))
        setPage(to.page)
      }),
    []
  )

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
        <div className="brand">Swarmplay</div>
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
        {page === 'library' && <LibraryPage key={libraryTarget.n} initialFolder={libraryTarget.folderId} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
