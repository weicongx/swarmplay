import { useState } from 'react'
import type { PhoneEpisode, PhoneFolder, PhoneLibrary, PhoneRelease } from '@shared/companion'
import { compareEpisodes } from '@shared/folders'
import { RESUME_MIN_SEC } from '@shared/types'
import { FEW_SEEDERS, formatBytes, formatClock, seedersLabel } from '../src/format'
import { post } from './api'
import type { PlayRequest } from './App'

interface Props {
  lib: PhoneLibrary | null
  error: string | null
  folder: number | 'unsorted' | null
  onPlay: (req: PlayRequest, title: string) => Promise<void>
  onError: (err: unknown) => string
  onChanged: () => Promise<void>
}

const folderHash = (id: number | null): string => `#folder/${id ?? 'unsorted'}`

export function episodeLabel(e: { episodeNum: number | null; title: string }): string {
  return e.episodeNum != null ? `Ep ${e.episodeNum}` : e.title
}

export default function Library({ lib, error, folder, onPlay, onError, onChanged }: Props): JSX.Element {
  if (!lib) {
    return (
      <div className="page">
        <h1>Library</h1>
        {error ? <p className="note error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    )
  }
  if (folder != null) {
    const id = folder === 'unsorted' ? null : folder
    const f = lib.folders.find((x) => x.id === id)
    return (
      <FolderView
        lib={lib}
        folder={f ?? null}
        folderId={id}
        error={error}
        onPlay={onPlay}
        onError={onError}
        onChanged={onChanged}
      />
    )
  }
  return <Home lib={lib} error={error} onPlay={onPlay} />
}

function Home({ lib, error, onPlay }: Pick<Props, 'error' | 'onPlay'> & { lib: PhoneLibrary }): JSX.Element {
  const byKey = new Map(lib.episodes.map((e) => [`${e.torrentId}:${e.fileIndex}`, e]))
  const folderName = new Map(lib.folders.map((f) => [f.id, f.name]))
  const resume = lib.continueWatching.map((c) => byKey.get(`${c.torrentId}:${c.fileIndex}`)).filter((e): e is PhoneEpisode => e != null)

  return (
    <div className="page">
      <header className="page-head">
        <h1>Library</h1>
        <span className="muted small">
          {lib.device} · on {lib.pc}
        </span>
      </header>
      {error && <p className="note error">{error}</p>}

      {resume.length > 0 && (
        <section>
          <h2>Continue watching</h2>
          <div className="resume-row">
            {resume.map((e) => (
              <button
                key={`${e.torrentId}:${e.fileIndex}`}
                className="resume-card"
                onClick={() => void onPlay({ torrentId: e.torrentId, fileIndex: e.fileIndex }, e.title)}
              >
                <span className="resume-series">{folderName.get(e.folderId) ?? 'Unsorted'}</span>
                <span className="resume-ep">{episodeLabel(e)}</span>
                <span className="muted small">{progressText(e) ?? 'Up next'}</span>
                <Progress e={e} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Series</h2>
        {lib.folders.length === 0 ? (
          <p className="muted">Nothing in the library yet. Find something in Search.</p>
        ) : (
          <div className="grid">
            {lib.folders.map((f) => (
              <a key={f.id ?? 'unsorted'} className="tile" href={folderHash(f.id)}>
                <Cover folder={f} />
                <span className="tile-name">{f.name}</span>
                <span className="muted small">
                  {f.watched} of {f.episodes} watched
                  {f.available > 0 && <span className="accent"> · {f.available} new</span>}
                </span>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Cover({ folder }: { folder: PhoneFolder }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (folder.hasCover && folder.id != null && !failed) {
    return <img className="cover" src={`/cover/${folder.id}`} alt="" loading="lazy" onError={() => setFailed(true)} />
  }
  const initials = folder.name
    .split(/[\s\-:]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
  return (
    <span className="cover cover-blank" aria-hidden="true">
      {initials || '?'}
    </span>
  )
}

type Row = { kind: 'episode'; e: PhoneEpisode } | { kind: 'release'; r: PhoneRelease }

function FolderView({
  lib,
  folder,
  folderId,
  error,
  onPlay,
  onError,
  onChanged
}: Omit<Props, 'folder' | 'lib'> & { lib: PhoneLibrary; folder: PhoneFolder | null; folderId: number | null }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const episodes = lib.episodes.filter((e) => e.folderId === folderId)
  const releases = lib.available.filter((r) => r.folderId === folderId)
  const rows: Row[] = [
    ...episodes.map((e) => ({ kind: 'episode' as const, e, num: e.episodeNum, title: e.title })),
    ...releases.map((r) => ({ kind: 'release' as const, r, num: r.episodeNum, title: r.title }))
  ]
    .sort((a, b) => compareEpisodes({ episodeNum: a.num, title: a.title }, { episodeNum: b.num, title: b.title }))
    .map(({ num: _n, title: _t, ...row }) => row as Row)

  const toggleWatched = async (e: PhoneEpisode): Promise<void> => {
    const key = `w${e.torrentId}:${e.fileIndex}`
    setBusy(key)
    setRowError(null)
    try {
      await post('/api/watched', { torrentId: e.torrentId, fileIndex: e.fileIndex, watched: !e.watched })
      await onChanged()
    } catch (err) {
      setRowError(onError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <a className="back" href="#library">
        ‹ Library
      </a>
      <h1>{folder?.name ?? 'Unsorted'}</h1>
      {error && <p className="note error">{error}</p>}
      {rowError && <p className="note error">{rowError}</p>}
      {rows.length === 0 && <p className="muted">Nothing here any more.</p>}
      <ul className="list">
        {rows.map((row) =>
          row.kind === 'episode' ? (
            <li key={`e${row.e.torrentId}:${row.e.fileIndex}`} className={`row${row.e.watched ? ' watched' : ''}`}>
              <button
                className={`check${row.e.watched ? ' on' : ''}`}
                aria-label={row.e.watched ? 'Mark as not watched' : 'Mark as watched'}
                aria-pressed={row.e.watched}
                disabled={busy === `w${row.e.torrentId}:${row.e.fileIndex}`}
                onClick={() => void toggleWatched(row.e)}
              >
                ✓
              </button>
              <div className="row-main">
                <span className="row-title">{episodeLabel(row.e)}</span>
                {row.e.episodeNum != null && <span className="row-file">{row.e.title}</span>}
                <span className="muted small">
                  {row.e.watched ? 'Watched' : (progressText(row.e) ?? 'Not played')} ·{' '}
                  {row.e.downloaded ? 'On the PC' : 'Streams'}
                </span>
                <Progress e={row.e} />
              </div>
              <button
                className="primary"
                onClick={() => void onPlay({ torrentId: row.e.torrentId, fileIndex: row.e.fileIndex }, row.e.title)}
              >
                Play
              </button>
            </li>
          ) : (
            <li key={`r${row.r.id}`} className="row release">
              <span className="check placeholder" aria-hidden="true" />
              <div className="row-main">
                <span className="row-title">Ep {row.r.episodeNum}</span>
                <span className="row-file">{row.r.title}</span>
                <span className={`small ${row.r.seeders != null && row.r.seeders <= FEW_SEEDERS ? 'amber' : 'muted'}`}>
                  New on nyaa · {formatBytes(row.r.sizeBytes)}
                  {row.r.seeders != null && ` · ${seedersLabel(row.r.seeders)}`}
                </span>
              </div>
              <button className="primary" onClick={() => void onPlay({ releaseId: row.r.id }, row.r.title)}>
                Play
              </button>
            </li>
          )
        )}
      </ul>
    </div>
  )
}

/** "Stopped at 12:30 of 24:10", or null if it's at the start. */
function progressText(e: PhoneEpisode): string | null {
  if (e.positionSec < RESUME_MIN_SEC) return null
  return `Stopped at ${formatClock(e.positionSec)}${e.durationSec ? ` of ${formatClock(e.durationSec)}` : ''}`
}

function Progress({ e }: { e: PhoneEpisode }): JSX.Element | null {
  if (e.watched || !e.durationSec || e.positionSec < RESUME_MIN_SEC) return null
  return (
    <span className="progress" aria-hidden="true">
      <span style={{ width: `${Math.min(100, (e.positionSec / e.durationSec) * 100)}%` }} />
    </span>
  )
}
