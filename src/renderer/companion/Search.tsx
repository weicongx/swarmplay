import { useEffect, useState } from 'react'
import type { PhoneResult, PhoneSearchPage, PhoneTorrent } from '@shared/companion'
import type { FollowResult } from '@shared/types'
import { FEW_SEEDERS, formatAge, formatBytes, seedersLabel } from '../src/format'
import { get, post, recall, remember } from './api'
import type { PlayRequest } from './App'

// Search nyaa through the PC. Picking a result lists its videos to play, and
// can follow the series. The phone only ever sends nyaa ids: the PC looks the
// torrent up in the results it fetched itself.

interface Props {
  onPlay: (req: PlayRequest, title: string) => Promise<void>
  onError: (err: unknown) => string
  onChanged: () => Promise<void>
}

export default function Search({ onPlay, onError, onChanged }: Props): JSX.Element {
  const [query, setQuery] = useState(() => recall('search') ?? '')
  const [page, setPage] = useState<PhoneSearchPage | null>(null)
  const [results, setResults] = useState<PhoneResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<PhoneResult | null>(null)

  const run = async (p: number): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const q = query.trim()
      remember('search', q || null)
      const res = await get<PhoneSearchPage>(`/api/search?q=${encodeURIComponent(q)}&page=${p}`)
      setPage(res)
      setResults((prev) => (p === 1 ? res.results : [...prev, ...res.results.filter((r) => !prev.some((x) => x.id === r.id))]))
    } catch (err) {
      setError(onError(err))
    } finally {
      setLoading(false)
    }
  }

  if (picked) {
    return <Release result={picked} onBack={() => setPicked(null)} onPlay={onPlay} onError={onError} onChanged={onChanged} />
  }

  return (
    <div className="page">
      <h1>Search</h1>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run(1)
        }}
      >
        <input
          type="search"
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nyaa"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button className="primary" type="submit" disabled={loading}>
          Search
        </button>
      </form>
      {error && <p className="note error">{error}</p>}
      {page && results.length === 0 && !loading && <p className="muted">Nothing found.</p>}
      <ul className="list">
        {results.map((r) => (
          <li key={r.id}>
            <button className="result" onClick={() => setPicked(r)}>
              <span className={`result-title${r.trusted ? ' trusted' : r.remake ? ' remake' : ''}`}>{r.title}</span>
              <span className="small">
                <span className={r.seeders <= FEW_SEEDERS ? 'amber' : 'green'}>{seedersLabel(r.seeders)}</span>
                <span className="muted">
                  {' '}
                  · {r.size} · {formatAge(r.pubDate)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loading && <p className="muted">Searching…</p>}
      {page?.hasMore && !loading && (
        <button className="secondary wide" onClick={() => void run(page.page + 1)}>
          Load more
        </button>
      )}
      {page?.limited && <p className="muted small">nyaa's feed only lists the newest 75 results.</p>}
    </div>
  )
}

function Release({
  result,
  onBack,
  onPlay,
  onError,
  onChanged
}: Props & { result: PhoneResult; onBack: () => void }): JSX.Element {
  const [info, setInfo] = useState<PhoneTorrent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState<{ busy: boolean; done: FollowResult | null; error: string | null }>({
    busy: false,
    done: null,
    error: null
  })

  useEffect(() => {
    let live = true
    get<PhoneTorrent>(`/api/torrent?id=${result.id}`).then(
      (t) => live && setInfo(t),
      (err) => live && setError(onError(err))
    )
    return () => {
      live = false
    }
  }, [result.id, onError])

  const videos = info?.files
    .filter((f) => f.isVideo)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const others = info ? info.files.length - (videos?.length ?? 0) : 0

  const doFollow = async (): Promise<void> => {
    setFollow({ busy: true, done: null, error: null })
    try {
      const done = await post<FollowResult>('/api/follow', { nyaaId: result.id })
      setFollow({ busy: false, done, error: null })
      void onChanged()
    } catch (err) {
      setFollow({ busy: false, done: null, error: onError(err) })
    }
  }

  return (
    <div className="page">
      <button className="back" onClick={onBack}>
        ‹ Results
      </button>
      <h1 className="release-title">{result.title}</h1>
      <p className="small muted">
        {result.size} · {seedersLabel(result.seeders)} · {formatAge(result.pubDate)}
      </p>
      {error && <p className="note error">{error}</p>}
      {!info && !error && <p className="muted">Getting the file list…</p>}
      {info && (
        <>
          <p className="small muted">
            Plays by streaming, and goes in <strong>{info.folderName}</strong> in the library.
          </p>
          {videos!.length === 0 && <p className="note warn">There's no video file in this torrent.</p>}
          <ul className="list">
            {videos!.map((f) => {
              const name = f.path.split('/').pop()!
              return (
                <li key={f.index} className="row">
                  <div className="row-main">
                    <span className="row-file wrap">{name}</span>
                    <span className="muted small">{formatBytes(f.length)}</span>
                  </div>
                  <button className="primary" onClick={() => void onPlay({ nyaaId: result.id, fileIndex: f.index }, name)}>
                    Play
                  </button>
                </li>
              )
            })}
          </ul>
          {others > 0 && (
            <p className="muted small">
              {others} other file{others === 1 ? '' : 's'} (subtitles, extras) not shown.
            </p>
          )}
          <section>
            <h2>Follow the series</h2>
            <p className="small muted">New episodes from this group show up in the library as they're uploaded.</p>
            {follow.done ? (
              <p className="note">
                Following in <strong>{follow.done.folderName}</strong>
                {follow.done.available > 0 && ` · ${follow.done.available} episode${follow.done.available === 1 ? '' : 's'} to play`}.
              </p>
            ) : (
              <button className="secondary wide" disabled={follow.busy} onClick={() => void doFollow()}>
                {follow.busy ? 'Following…' : 'Follow series'}
              </button>
            )}
            {follow.error && <p className="note error">{follow.error}</p>}
          </section>
        </>
      )}
    </div>
  )
}
