import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionTitle, type CompanionSessionInfo } from '@shared/companion'
import type { PlayerState, UpdateStatus } from '@shared/types'
import DownloadsPage from './pages/DownloadsPage'
import LibraryPage from './pages/LibraryPage'
import PlayerView, { MiniPlayer } from './pages/PlayerView'
import SearchPage from './pages/SearchPage'
import SettingsPage from './pages/SettingsPage'
import { formatSpeed } from './format'

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
  /** The player is shrunk into a corner while the user browses */
  const [mini, setMini] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  /** What a paired phone is playing through this PC */
  const [phone, setPhone] = useState<CompanionSessionInfo | null>(null)
  const playingKey = useRef<string | null>(null)

  useEffect(
    () =>
      window.api.onNavigate((to) => {
        setLibraryTarget((t) => ({ folderId: to.folderId, n: t.n + 1 }))
        setPage(to.page)
      }),
    []
  )

  // Only downloads still fetching count; a stream, the next episode fetched ahead, or a finished one doesn't.
  useEffect(
    () =>
      window.api.onTorrentsUpdate((list) =>
        setActiveDownloads(list.filter((t) => t.status === 'downloading' && t.progress < 1).length)
      ),
    []
  )

  useEffect(() => {
    window.api.getUpdateStatus().then(setUpdate)
    return window.api.onUpdateStatus(setUpdate)
  }, [])

  useEffect(() => {
    window.api.getPlayerState().then(setPlayer)
    return window.api.onPlayerState(setPlayer)
  }, [])

  useEffect(() => {
    window.api.getCompanion().then((s) => setPhone(s.session))
    return window.api.onCompanionUpdate((s) => setPhone(s.session))
  }, [])

  // An episode the user starts opens the full player; autoplay and release switches keep the view.
  useEffect(() => {
    const key = player?.open ? `${player.torrentId}:${player.fileIndex}` : null
    if (key !== playingKey.current && (key == null || !player?.continued)) setMini(false)
    playingKey.current = key
  }, [player])

  const minimize = useCallback(() => setMini(true), [])
  const playing = player?.open === true

  return (
    <div className={`app ${playing && player.fullscreen ? 'fullscreen' : ''}`}>
      <nav className="sidebar">
        <div className="brand">Swarmplay</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${page === n.id && (!playing || mini) ? 'active' : ''}`}
            onClick={() => {
              // Browsing keeps the episode playing, in the mini player.
              if (playing) setMini(true)
              setPage(n.id)
            }}
          >
            {n.label}
            {n.id === 'downloads' && activeDownloads > 0 && <span className="badge">{activeDownloads}</span>}
          </button>
        ))}
        {update?.available && (
          <button
            className="update-chip"
            onClick={() => {
              if (playing) setMini(true)
              setPage('settings')
            }}
            title="See what's new and install it"
          >
            {update.phase === 'downloading'
              ? `Downloading update… ${Math.round(update.progress * 100)}%`
              : `Update to ${update.available.version}`}
          </button>
        )}
        {playing && <NowStreaming state={player} onOpen={mini ? () => setMini(false) : undefined} />}
        {!playing && phone && <PhoneStreaming session={phone} />}
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
        {playing &&
          (mini ? (
            <MiniPlayer state={player} onExpand={() => setMini(false)} />
          ) : (
            <PlayerView state={player} onMinimize={minimize} />
          ))}
      </main>
    </div>
  )
}

/** What's playing, and how its stream is doing, at the foot of the sidebar. */
function NowStreaming({ state, onOpen }: { state: PlayerState; onOpen?: () => void }): JSX.Element {
  const peers = `${state.numPeers} peer${state.numPeers === 1 ? '' : 's'}`
  return (
    <div
      className={`now-streaming ${state.slow ? 'slow' : ''} ${onOpen ? 'clickable' : ''}`}
      title={onOpen ? `${state.title}\nClick for the full player` : state.title}
      onClick={onOpen}
    >
      <div className="now-label">{state.local ? 'Now playing' : 'Now streaming'}</div>
      <div className="now-title">{state.series ?? 'Unsorted'}</div>
      {state.episodeLabel && <div className="now-episode">{state.episodeLabel}</div>}
      {!state.local && (
        <div className="now-stats">
          ↓ {formatSpeed(state.downloadSpeed)} · {peers}
          {state.buffering && ' · buffering'}
        </div>
      )}
    </div>
  )
}

/** A phone playing through this PC: the PC plays nothing meanwhile, and Stop ends it. */
function PhoneStreaming({ session }: { session: CompanionSessionInfo }): JSX.Element {
  return (
    <div className="now-streaming phone" title={`Playing on ${session.deviceName}: ${session.title}`}>
      <div className="now-label">Playing on {session.deviceName}</div>
      <div className="now-title">{session.series ?? session.title}</div>
      {session.episodeLabel && <div className="now-episode">{session.episodeLabel}</div>}
      {session.starting && <div className="now-stats">Getting it ready…</div>}
      <button
        className="now-stop"
        onClick={() => void window.api.stopPhone()}
        aria-label={`Stop playing ${sessionTitle(session)} on ${session.deviceName}`}
      >
        Stop
      </button>
    </div>
  )
}
