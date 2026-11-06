import { useEffect, useState } from 'react'
import type { PlayerState } from '@shared/types'
import DownloadsPage from './pages/DownloadsPage'
import LibraryPage from './pages/LibraryPage'
import PlayerView from './pages/PlayerView'
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
  const [player, setPlayer] = useState<PlayerState | null>(null)

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

  useEffect(() => {
    window.api.getPlayerState().then(setPlayer)
    return window.api.onPlayerState(setPlayer)
  }, [])

  const playing = player?.open === true

  return (
    <div className={`app ${playing && player.fullscreen ? 'fullscreen' : ''}`}>
      <nav className="sidebar">
        <div className="brand">Swarmplay</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id && !playing ? 'active' : ''}`}
            onClick={() => {
              if (playing) void window.api.playerCommand({ type: 'close' })
              setPage(n.id)
            }}
          >
            {n.label}
            {n.id === 'downloads' && activeDownloads > 0 && <span className="badge">{activeDownloads}</span>}
          </button>
        ))}
      </nav>
      <main className="content">
        {/* Search stays mounted so results survive switching tabs. */}
        <div className="page-slot" hidden={page !== 'search'}>
          <SearchPage
            onOpenDownloads={() => setPage('downloads')}
            onOpenFolder={(folderId) => {
              setLibraryTarget((t) => ({ folderId, n: t.n + 1 }))
              setPage('library')
            }}
          />
        </div>
        {page === 'downloads' && <DownloadsPage />}
        {page === 'library' && <LibraryPage key={libraryTarget.n} initialFolder={libraryTarget.folderId} />}
        {page === 'settings' && <SettingsPage />}
        {/* The player covers the current page, which stays mounted underneath. */}
        {playing && <PlayerView state={player} />}
      </main>
    </div>
  )
}
