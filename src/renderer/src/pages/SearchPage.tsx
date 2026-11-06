import { useEffect, useMemo, useState } from 'react'
import { NYAA_CATEGORIES, NYAA_FILTERS, type NyaaResult, type TorrentInfo } from '@shared/types'
import { displayPath, errorMessage, formatAge, formatBytes, magnetFor } from '../format'

type SortKey = 'date' | 'seeders' | 'size' | 'downloads'

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'date', label: 'Newest' },
  { id: 'seeders', label: 'Most seeders' },
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'size', label: 'Largest' }
]

const VIDEO_EXT = /\.(mkv|mp4|avi|webm|m4v)$/i

export default function SearchPage({ onOpenDownloads }: { onOpenDownloads: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('1_2')
  const [filter, setFilter] = useState(0)
  const [sort, setSort] = useState<SortKey>('date')
  const [results, setResults] = useState<NyaaResult[] | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<NyaaResult | null>(null)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setCategory(s.defaultCategory)
      setFilter(s.defaultFilter)
    })
    window.api.getRecentSearches().then(setRecent)
  }, [])

  async function runSearch(q = query): Promise<void> {
    setQuery(q)
    setLoading(true)
    setError(null)
    setSelected(null)
    try {
      setResults(await window.api.searchNyaa({ query: q, category, filter }))
      setRecent(await window.api.getRecentSearches())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const sorted = useMemo(() => {
    if (!results) return null
    const by: Record<SortKey, (r: NyaaResult) => number> = {
      date: (r) => new Date(r.pubDate).getTime(),
      seeders: (r) => r.seeders,
      downloads: (r) => r.downloads,
      size: (r) => r.sizeBytes
    }
    return [...results].sort((a, b) => by[sort](b) - by[sort](a))
  }, [results, sort])

  return (
    <div className="search-layout">
      <div className="page search-main">
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault()
            runSearch()
          }}
        >
          <input
            autoFocus
            placeholder="Search nyaa.si, e.g. frieren 1080p"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {NYAA_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={filter} onChange={(e) => setFilter(Number(e.target.value))}>
            {NYAA_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {recent.length > 0 && (
          <div className="chips">
            {recent.map((r) => (
              <button key={r} className="chip" onClick={() => runSearch(r)}>
                {r}
              </button>
            ))}
          </div>
        )}

        {error && <div className="error">Search failed: {error}</div>}

        {sorted && (
          <>
            <div className="results-header">
              <span className="muted">
                {sorted.length} result{sorted.length === 1 ? '' : 's'}
                {sorted.length >= 75 && ' (newest 75; refine your search for more)'}
              </span>
              <label className="muted">
                Sort{' '}
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <table className="results">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Size</th>
                  <th className="num">Age</th>
                  <th className="num" title="Seeders">S</th>
                  <th className="num" title="Leechers">L</th>
                  <th className="num" title="Completed downloads">DL</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.id}
                    className={`${selected?.id === r.id ? 'selected' : ''} ${r.trusted ? 'trusted' : ''} ${r.remake ? 'remake' : ''}`}
                    onClick={() => setSelected(r)}
                  >
                    <td className="title">{r.title}</td>
                    <td className="num">{r.size}</td>
                    <td className="num">{formatAge(r.pubDate)}</td>
                    <td className="num seeders">{r.seeders}</td>
                    <td className="num leechers">{r.leechers}</td>
                    <td className="num">{r.downloads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sorted.length === 0 && <p className="muted">No torrents matched.</p>}
          </>
        )}
      </div>

      {selected && (
        <DetailPanel
          result={selected}
          onClose={() => setSelected(null)}
          onOpenDownloads={onOpenDownloads}
        />
      )}
    </div>
  )
}

function DetailPanel({
  result,
  onClose,
  onOpenDownloads
}: {
  result: NyaaResult
  onClose: () => void
  onOpenDownloads: () => void
}): JSX.Element {
  const [info, setInfo] = useState<TorrentInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setInfo(null)
    setError(null)
    setCopied(false)
    setAdded(null)
    window.api
      .getTorrentInfo(result.torrentUrl)
      .then((i) => {
        if (cancelled) return
        setInfo(i)
        // Default to every video file; fall back to everything if there are none.
        const videos = i.files.filter((f) => VIDEO_EXT.test(f.path))
        setChecked(new Set((videos.length ? videos : i.files).map((f) => f.index)))
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [result.torrentUrl])

  async function copyMagnet(): Promise<void> {
    await navigator.clipboard.writeText(magnetFor(result.infoHash, result.title))
    setCopied(true)
  }

  async function download(): Promise<void> {
    setAdding(true)
    setError(null)
    try {
      const res = await window.api.addTorrent({
        torrentUrl: result.torrentUrl,
        nyaaId: result.id,
        fileIndexes: [...checked]
      })
      setAdded(res.existed ? 'Already in Downloads; any new files were added to it.' : 'Downloading.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  function toggle(index: number): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const videoCount = info?.files.filter((f) => VIDEO_EXT.test(f.path)).length ?? 0
  // Torrents list files in arbitrary order; show episodes as 01, 02, ... 10.
  const files = useMemo(
    () => info?.files.slice().sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    [info]
  )

  return (
    <aside className="detail">
      <div className="detail-head">
        <h2>{result.title}</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <dl className="facts">
        <dt>Size</dt>
        <dd>{result.size}</dd>
        <dt>Seeders</dt>
        <dd className="seeders">{result.seeders}</dd>
        <dt>Leechers</dt>
        <dd>{result.leechers}</dd>
        <dt>Uploaded</dt>
        <dd>{new Date(result.pubDate).toLocaleString()}</dd>
        <dt>Category</dt>
        <dd>{result.category}</dd>
        {result.trusted && (
          <>
            <dt>Status</dt>
            <dd className="badge-trusted">Trusted</dd>
          </>
        )}
      </dl>

      <div className="actions">
        <button className="primary" disabled={!info || checked.size === 0 || adding} onClick={download}>
          {adding
            ? 'Adding…'
            : info && info.files.length > 1
              ? `Download ${checked.size} file${checked.size === 1 ? '' : 's'}`
              : 'Download'}
        </button>
        <button disabled title="Playback arrives in phase 3">
          Stream now
        </button>
      </div>
      {added && (
        <div className="notice">
          {added}{' '}
          <button className="link" onClick={onOpenDownloads}>
            View downloads
          </button>
        </div>
      )}
      <div className="actions">
        <button onClick={copyMagnet}>{copied ? 'Copied' : 'Copy magnet'}</button>
        <button onClick={() => window.api.openExternal(result.viewUrl)}>Open on nyaa</button>
      </div>

      <h3>
        Files
        {info && (
          <span className="muted">
            {' '}
            · {info.files.length} total, {videoCount} video
          </span>
        )}
      </h3>
      {error && <div className="error">{error}</div>}
      {!info && !error && <p className="muted">Loading file list…</p>}
      {info && files && (
        <ul className="files">
          {files.map((f) => (
            <li key={f.index} className={VIDEO_EXT.test(f.path) ? 'video' : ''}>
              <label className="file-check">
                {info.files.length > 1 && (
                  <input type="checkbox" checked={checked.has(f.index)} onChange={() => toggle(f.index)} />
                )}
                <span className="file-name">{displayPath(f.path, info.name)}</span>
              </label>
              <span className="muted">{formatBytes(f.length)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

