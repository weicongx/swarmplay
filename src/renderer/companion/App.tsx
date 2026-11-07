import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhoneLibrary, PhonePlayResult } from '@shared/companion'
import { ApiError, errorText, get, post, recall, remember } from './api'
import Library from './Library'
import Now from './Now'
import Pair from './Pair'
import Search from './Search'

// The phone page: Library, Search and Now playing, with hash routes (#library,
// #folder/3, #search, #now), so a link can open Now playing directly.
// /pair#CODE is where the PC's QR code points.

export type Tab = 'library' | 'search' | 'now'
export type Route = { tab: Tab; folder: number | 'unsorted' | null }

/** What Play sends: a library episode, a followed series' release, or a search result's file. */
export type PlayRequest = { torrentId: number; fileIndex: number } | { releaseId: number } | { nyaaId: number; fileIndex: number }

/** A Play on its way: shown on Now playing until the PC answers. */
export interface Pending {
  title: string
  error: string | null
  result: PhonePlayResult | null
}

function parseRoute(): Route {
  const h = location.hash.replace(/^#/, '')
  const folder = /^folder\/(\d+|unsorted)$/.exec(h)
  if (folder) return { tab: 'library', folder: folder[1] === 'unsorted' ? 'unsorted' : Number(folder[1]) }
  if (h === 'search' || h === 'now') return { tab: h, folder: null }
  return { tab: 'library', folder: null }
}

export function go(hash: string): void {
  if (location.hash !== `#${hash}`) location.hash = hash
}

export default function App(): JSX.Element {
  const [pairing, setPairing] = useState(location.pathname === '/pair' || location.hash === '#pair')
  const [route, setRoute] = useState<Route>(parseRoute)
  const [lib, setLib] = useState<PhoneLibrary | null>(null)
  const [libError, setLibError] = useState<string | null>(null)
  /** Paired before, now refused: removed on the PC */
  const [removed, setRemoved] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  /** Only the latest Play's answer counts */
  const playSeq = useRef(0)

  useEffect(() => {
    const onHash = (): void => {
      if (location.hash === '#pair') setPairing(true)
      else setRoute(parseRoute())
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /** Any refusal of the cookie means this phone has to pair (again). */
  const onError = useCallback((err: unknown): string => {
    if (err instanceof ApiError && err.status === 401) {
      setRemoved(recall('paired') === '1')
      setPairing(true)
    }
    return errorText(err)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setLib(await get<PhoneLibrary>('/api/library'))
      setLibError(null)
    } catch (err) {
      setLibError(onError(err))
    }
  }, [onError])

  useEffect(() => {
    if (!pairing) void refresh()
  }, [pairing, refresh])

  // Back on the library tab, or back in the browser after a while: fresh data.
  useEffect(() => {
    if (route.tab === 'library' && !pairing) void refresh()
  }, [route.tab, pairing, refresh])
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && !pairing) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [pairing, refresh])

  const start = useCallback(
    async (path: string, body: unknown, title: string): Promise<void> => {
      const seq = ++playSeq.current
      setPending({ title, error: null, result: null })
      go('now')
      try {
        const result = await post<PhonePlayResult>(path, body)
        if (seq === playSeq.current) setPending({ title: result.title, error: null, result })
      } catch (err) {
        const error = onError(err)
        if (seq === playSeq.current) setPending({ title, error, result: null })
      }
    },
    [onError]
  )
  const play = useCallback((req: PlayRequest, title: string) => start('/api/play', req, title), [start])
  const playNext = useCallback(() => start('/api/next', {}, 'the next episode'), [start])

  /** Once the PC has answered, Now playing shows the session itself. */
  const clearPending = useCallback(() => setPending((p) => (p && (p.result || p.error) ? null : p)), [])

  if (pairing) {
    return (
      <Pair
        removed={removed}
        onPaired={() => {
          remember('paired', '1')
          setRemoved(false)
          history.replaceState(null, '', '/#library')
          setRoute(parseRoute())
          setPairing(false)
        }}
      />
    )
  }

  return (
    <div className="app">
      <main className="screen">
        <div hidden={route.tab !== 'library'}>
          <Library lib={lib} error={libError} folder={route.folder} onPlay={play} onError={onError} onChanged={refresh} />
        </div>
        <div hidden={route.tab !== 'search'}>
          <Search onPlay={play} onError={onError} onChanged={refresh} />
        </div>
        <div hidden={route.tab !== 'now'}>
          <Now
            active={route.tab === 'now'}
            pending={pending}
            onClearPending={clearPending}
            onPlay={play}
            onNext={playNext}
            onError={onError}
          />
        </div>
      </main>
      <nav className="tabs">
        <TabButton tab="library" route={route} label="Library" icon="▦" />
        <TabButton tab="search" route={route} label="Search" icon="⌕" />
        <TabButton tab="now" route={route} label="Now playing" icon="▶" />
      </nav>
    </div>
  )
}

function TabButton({ tab, route, label, icon }: { tab: Tab; route: Route; label: string; icon: string }): JSX.Element {
  const current = route.tab === tab
  return (
    <a className={`tab${current ? ' current' : ''}`} href={`#${tab}`} aria-current={current ? 'page' : undefined}>
      <span className="tab-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </a>
  )
}
