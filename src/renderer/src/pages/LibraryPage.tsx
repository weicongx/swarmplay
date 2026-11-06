import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react'
import { compareEpisodes, flattenFolders, splitSeason } from '@shared/folders'
import {
  RESUME_MIN_SEC,
  type AniListMedia,
  type AvailableEpisode,
  type EpisodeInfo,
  type FolderInfo,
  type FollowInfo,
  type LibraryData,
  type TorrentStatusInfo
} from '@shared/types'
import { errorMessage, formatAge, formatBytes, formatClock } from '../format'

/** null = the library root; 'unsorted' = episodes without a folder */
type Location = number | null | 'unsorted'

type DragItem = { type: 'episode'; id: number } | { type: 'folder'; id: number }
const DRAG_MIME = 'application/x-swarmplay'

export default function LibraryPage({ initialFolder = null }: { initialFolder?: number | null }): JSX.Element {
  const [lib, setLib] = useState<LibraryData | null>(null)
  const [torrents, setTorrents] = useState<Map<number, TorrentStatusInfo>>(new Map())
  const [at, setAt] = useState<Location>(initialFolder)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => window.api.getLibrary().then(setLib), [])

  useEffect(() => {
    refresh()
    const apply = (list: TorrentStatusInfo[]): void => setTorrents(new Map(list.map((t) => [t.id, t])))
    window.api.listTorrents().then(apply)
    // Torrent updates arrive every second; re-read the library with them so
    // download progress and resume positions stay current.
    return window.api.onTorrentsUpdate((list) => {
      apply(list)
      refresh()
    })
  }, [refresh])

  const run = (fn: () => Promise<unknown>): void => {
    setError(null)
    fn()
      .then(refresh)
      .catch((err) => setError(errorMessage(err)))
  }

  // Drops move episodes into a folder (or Unsorted) and folders under another folder (or the root).
  const dropInto = (target: Location) => (item: DragItem) => {
    if (item.type === 'episode') {
      run(() => window.api.moveEpisodes([item.id], target === 'unsorted' ? null : target))
    } else if (target !== 'unsorted' && target !== item.id) {
      run(() => window.api.moveFolder(item.id, target))
    }
  }

  if (!lib) return <div className="page" />

  const folder = typeof at === 'number' ? lib.folders.find((f) => f.id === at) : undefined
  if (typeof at === 'number' && !folder) {
    setAt(null) // it was deleted
    return <div className="page" />
  }

  const childFolders = lib.folders.filter((f) => f.parentId === (typeof at === 'number' ? at : null))
  const episodes = lib.episodes
    .filter((e) => (at === 'unsorted' ? e.folderId === null : typeof at === 'number' && e.folderId === at))
    .sort(compareEpisodes)
  const available = lib.available.filter((a) => a.folderId === at)
  const unsortedCount = lib.episodes.filter((e) => e.folderId === null).length

  return (
    <div className="page library">
      <Breadcrumbs lib={lib} at={at} onGo={setAt} dropInto={dropInto} />
      {error && <div className="error">{error}</div>}

      {folder ? (
        <FolderHeader
          key={folder.id}
          folder={folder}
          episodes={episodes}
          available={available}
          lib={lib}
          onPlay={(e) => run(() => window.api.play(e.torrentId, e.fileIndex))}
          run={run}
        />
      ) : (
        <div className="library-head">
          <h1>{at === 'unsorted' ? 'Unsorted' : 'Library'}</h1>
        </div>
      )}

      {at === null && <ContinueWatching lib={lib} onPlay={(e) => run(() => window.api.play(e.torrentId, e.fileIndex))} />}

      {at === null && (lib.folders.length > 0 || unsortedCount > 0) && <h2 className="section-title">Series</h2>}

      {at !== 'unsorted' && (
        <FolderGrid
          lib={lib}
          folders={childFolders}
          showUnsorted={at === null && unsortedCount > 0}
          unsortedCount={unsortedCount}
          parentId={typeof at === 'number' ? at : null}
          onOpen={setAt}
          dropInto={dropInto}
          run={run}
        />
      )}

      {at === null && lib.folders.length === 0 && unsortedCount === 0 && (
        <p className="muted">
          Your library is empty. Download something from Search and it's filed into a folder for that series.
        </p>
      )}

      {(at === 'unsorted' || typeof at === 'number') && (
        <EpisodeList episodes={episodes} available={available} lib={lib} torrents={torrents} run={run} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Breadcrumbs({
  lib,
  at,
  onGo,
  dropInto
}: {
  lib: LibraryData
  at: Location
  onGo: (l: Location) => void
  dropInto: (l: Location) => (item: DragItem) => void
}): JSX.Element | null {
  if (at === null) return null
  const trail: FolderInfo[] = []
  for (let f = lib.folders.find((x) => x.id === at); f; f = lib.folders.find((x) => x.id === f!.parentId)) {
    trail.unshift(f)
  }
  return (
    <nav className="crumbs">
      <DropTarget onDrop={dropInto(null)} as="button" className="crumb" onClick={() => onGo(null)}>
        Library
      </DropTarget>
      {at === 'unsorted' && (
        <>
          <span className="crumb-sep">›</span>
          <span className="crumb current">Unsorted</span>
        </>
      )}
      {trail.map((f, i) => (
        <span key={f.id} className="crumb-wrap">
          <span className="crumb-sep">›</span>
          {i === trail.length - 1 ? (
            <span className="crumb current">{f.name}</span>
          ) : (
            <DropTarget onDrop={dropInto(f.id)} as="button" className="crumb" onClick={() => onGo(f.id)}>
              {f.name}
            </DropTarget>
          )}
        </span>
      ))}
    </nav>
  )
}

function FolderHeader({
  folder,
  episodes,
  available,
  lib,
  onPlay,
  run
}: {
  folder: FolderInfo
  episodes: EpisodeInfo[]
  available: AvailableEpisode[]
  lib: LibraryData
  onPlay: (e: EpisodeInfo) => void
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(folder.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteDownloads, setDeleteDownloads] = useState(false)
  const [picking, setPicking] = useState(false)

  const watched = episodes.filter((e) => e.watched).length
  const downloaded = episodes.filter((e) => e.downloaded).length
  const total = episodes.length + available.length
  const nested = subtreeEpisodes(lib, folder.id).filter((e) => e.downloaded).length
  const a = folder.anilist
  const follows = lib.follows.filter((f) => f.folderId === folder.id)
  // Up next: the first unwatched episode, which may be a followed series' episode not played yet.
  const lastWatched = Math.max(-Infinity, ...episodes.filter((e) => e.watched && e.episodeNum != null).map((e) => e.episodeNum!))
  const nextEp = episodes.find((e) => !e.watched)
  const nextRelease = available.find((r) => r.episodeNum > lastWatched)
  const streamFirst =
    nextRelease && (nextEp?.episodeNum == null || nextRelease.episodeNum < nextEp.episodeNum) ? nextRelease : undefined
  const next = streamFirst ? undefined : (nextEp ?? (available.length ? undefined : episodes[0]))

  return (
    <div className="library-head folder-head">
      <div className="folder-head-art">
        <FolderArt folder={folder} />
      </div>
      <div className="folder-head-body">
      {renaming ? (
        <form
          className="rename"
          onSubmit={(e) => {
            e.preventDefault()
            run(() => window.api.renameFolder(folder.id, name))
            setRenaming(false)
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)} />
          <button type="submit" className="primary">
            Save
          </button>
          <button type="button" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <h1>{folder.name}</h1>
      )}
      {a && (
        <p className="anilist-line">
          <button className="link" onClick={() => window.api.openExternal(`https://anilist.co/anime/${a.id}`)}>
            {a.title}
          </button>
          {a.english && a.english !== a.title && <span className="muted"> · {a.english}</span>}
          <span className="muted">
            {[a.format?.replace('_', ' '), a.year].filter(Boolean).length > 0 &&
              ` · ${[a.format?.replace('_', ' '), a.year].filter(Boolean).join(' ')}`}
          </span>
        </p>
      )}
      <p className="muted">
        {total} episode{total === 1 ? '' : 's'}
        {a?.episodes ? ` of ${a.episodes}` : ''}
        {total > 0 && ` · ${watched} watched`}
        {downloaded > 0 && ` · ${downloaded} downloaded`}
      </p>
      {follows.map((f) => (
        <FollowLine key={f.id} follow={f} run={run} />
      ))}
      {a?.description && <Description text={a.description} />}

      <div className="torrent-actions">
        {next && (
          <button className="primary" onClick={() => onPlay(next)}>
            {next.positionSec > RESUME_MIN_SEC
              ? `Continue ${epLabel(next)} at ${formatClock(next.positionSec)}`
              : `Play ${epLabel(next)}`}
          </button>
        )}
        {streamFirst && (
          <button className="primary" onClick={() => run(() => window.api.streamRelease(streamFirst.id))}>
            Play Ep {streamFirst.episodeNum}
          </button>
        )}
        <NewFolderButton parentId={folder.id} label="New subfolder" run={run} />
        <button
          onClick={() => {
            setName(folder.name)
            setRenaming(true)
          }}
        >
          Rename
        </button>
        <button onClick={() => setPicking(!picking)}>{a ? 'Change AniList match' : 'Find on AniList'}</button>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)}>Delete folder</button>
        ) : (
          <span className="confirm">
            <span className="muted">
              {nested > 0
                ? `Its ${nested} downloaded episode${nested === 1 ? '' : 's'} move to Unsorted.`
                : 'Nothing in it is downloaded.'}
            </span>
            {nested > 0 && (
              <label>
                <input type="checkbox" checked={deleteDownloads} onChange={(e) => setDeleteDownloads(e.target.checked)} />{' '}
                Also delete their downloaded files
              </label>
            )}
            <button className="danger" onClick={() => run(() => window.api.deleteFolder(folder.id, deleteDownloads))}>
              Delete
            </button>
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        )}
      </div>
      {picking && (
        <AniListPicker
          folder={folder}
          onDone={() => setPicking(false)}
          run={run}
        />
      )}
      </div>
    </div>
  )
}

/** "Following Judas 1080p uploads · checked 5 min ago · Check now · Unfollow" */
function FollowLine({ follow, run }: { follow: FollowInfo; run: (fn: () => Promise<unknown>) => void }): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState(false)
  return (
    <p className="follow-line muted">
      Following <strong>{follow.group}</strong>
      {follow.resolution && ` ${follow.resolution}`} uploads
      {follow.error ? (
        <span className="error-text"> · last check failed: {follow.error}</span>
      ) : (
        follow.checkedAt && ` · checked ${formatAge(new Date(follow.checkedAt).toISOString())}`
      )}
      {' · '}
      <button
        className="link"
        disabled={checking}
        onClick={() => {
          setChecking(true)
          run(() => window.api.checkFollow(follow.id).finally(() => setChecking(false)))
        }}
      >
        {checking ? 'Checking…' : 'Check now'}
      </button>
      {' · '}
      {confirm ? (
        <>
          <span>Remove its episodes that aren't downloaded? </span>
          <button className="link" onClick={() => run(() => window.api.unfollow(follow.id))}>
            Unfollow
          </button>{' '}
          <button className="link" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="link" onClick={() => setConfirm(true)}>
          Unfollow
        </button>
      )}
    </p>
  )
}

/** The series synopsis, clamped to a few lines until expanded. */
function Description({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])

  return (
    <div className="series-description">
      <p ref={ref} className={expanded ? '' : 'clamped'}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

/** Search AniList and link the folder to the chosen entry (for covers and cross-language matching). */
function AniListPicker({
  folder,
  onDone,
  run
}: {
  folder: FolderInfo
  onDone: () => void
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element {
  const [query, setQuery] = useState(() => splitSeason(folder.name).base)
  const [results, setResults] = useState<AniListMedia[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(async (q: string) => {
    setBusy(true)
    setError(null)
    try {
      setResults(await window.api.searchAniList(q))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    search(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="anilist-picker">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          search(query)
        }}
      >
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search AniList" />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        {folder.anilist && (
          <button type="button" onClick={() => (run(() => window.api.linkFolder(folder.id, null)), onDone())}>
            Unlink
          </button>
        )}
        <button type="button" onClick={onDone}>
          Close
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {results && results.length === 0 && <p className="muted">No matches.</p>}
      {results && results.length > 0 && (
        <div className="anilist-results">
          {results.map((m) => (
            <button
              key={m.id}
              className={`anilist-result ${folder.anilist?.id === m.id ? 'current' : ''}`}
              onClick={() => (run(() => window.api.linkFolder(folder.id, m.id)), onDone())}
            >
              {m.coverUrl ? <img src={m.coverUrl} alt="" loading="lazy" /> : <div className="no-cover" />}
              <span className="anilist-result-title">{m.title}</span>
              {m.english && m.english !== m.title && <span className="muted">{m.english}</span>}
              <span className="muted">
                {[m.format?.replace('_', ' '), m.year, m.episodes ? `${m.episodes} eps` : null].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Episodes to pick up again: the latest played per folder, or the next one after it. */
function ContinueWatching({ lib, onPlay }: { lib: LibraryData; onPlay: (e: EpisodeInfo) => void }): JSX.Element | null {
  const items = useMemo(() => {
    const latest = new Map<number | null, EpisodeInfo>()
    for (const e of lib.episodes) {
      if (e.lastPlayedAt == null) continue
      const cur = latest.get(e.folderId)
      if (!cur || e.lastPlayedAt > cur.lastPlayedAt!) latest.set(e.folderId, e)
    }
    const out: { ep: EpisodeInfo; folder: FolderInfo | null; playedAt: number }[] = []
    for (const [folderId, last] of latest) {
      let ep: EpisodeInfo | undefined = last
      if (last.watched) {
        // Finished it: offer the next unwatched episode in the folder instead.
        const eps = lib.episodes.filter((e) => e.folderId === folderId).sort(compareEpisodes)
        ep = eps.slice(eps.indexOf(last) + 1).find((e) => !e.watched)
      }
      if (ep) out.push({ ep, folder: lib.folders.find((f) => f.id === folderId) ?? null, playedAt: last.lastPlayedAt! })
    }
    return out.sort((a, b) => b.playedAt - a.playedAt).slice(0, 8)
  }, [lib])

  if (items.length === 0) return null
  return (
    <>
      <h2 className="section-title">Continue watching</h2>
      <div className="continue-row">
        {items.map(({ ep, folder }) => (
          <button key={ep.id} className="continue-card" onClick={() => onPlay(ep)} title={ep.title}>
            <div className="continue-art">
              {folder ? <FolderArt folder={folder} /> : <div className="folder-tile">?</div>}
              <span className="continue-play">▶</span>
            </div>
            <div className="continue-body">
              <div className="folder-name">{folder?.name ?? 'Unsorted'}</div>
              <div className="muted folder-meta">
                {epLabel(ep, true)}
                {ep.positionSec > RESUME_MIN_SEC && ` · ${formatClock(ep.positionSec)}`}
                {ep.positionSec > RESUME_MIN_SEC && ep.durationSec ? ` / ${formatClock(ep.durationSec)}` : ''}
              </div>
              <div className="progress thin">
                <div
                  className="progress-fill"
                  style={{ width: ep.durationSec ? `${Math.min(ep.positionSec / ep.durationSec, 1) * 100}%` : 0 }}
                />
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

/** The folder's AniList cover, or a colored tile with its initials. */
function FolderArt({ folder }: { folder: FolderInfo }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const cover = folder.anilist?.coverUrl
  if (cover && !failed) {
    return (
      <div className="folder-tile cover" style={{ background: folder.anilist?.color ?? undefined }}>
        <img src={cover} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      </div>
    )
  }
  return (
    <div className="folder-tile" style={{ background: tileColor(folder.name) }}>
      {initials(folder.name)}
    </div>
  )
}

function FolderGrid({
  lib,
  folders,
  showUnsorted,
  unsortedCount,
  parentId,
  onOpen,
  dropInto,
  run
}: {
  lib: LibraryData
  folders: FolderInfo[]
  showUnsorted: boolean
  unsortedCount: number
  parentId: number | null
  onOpen: (l: Location) => void
  dropInto: (l: Location) => (item: DragItem) => void
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element | null {
  if (folders.length === 0 && !showUnsorted && parentId !== null) return null
  return (
    <div className="folder-grid">
      {folders.map((f) => {
        const eps = subtreeEpisodes(lib, f.id)
        const watched = eps.filter((e) => e.watched).length
        const total = eps.length + lib.available.filter((a) => a.folderId === f.id).length
        return (
          <DropTarget
            key={f.id}
            as="div"
            className="folder-card"
            onDrop={dropInto(f.id)}
            onClick={() => onOpen(f.id)}
            drag={{ type: 'folder', id: f.id }}
          >
            <FolderArt folder={f} />
            <div className="folder-name" title={f.name}>
              {f.name}
            </div>
            <div className="muted folder-meta">
              {total} ep{total === 1 ? '' : 's'}
              {total > 0 && ` · ${watched} watched`}
            </div>
            <div className="progress thin">
              <div className="progress-fill" style={{ width: total ? `${(watched / total) * 100}%` : 0 }} />
            </div>
          </DropTarget>
        )
      })}
      {showUnsorted && (
        <DropTarget as="div" className="folder-card unsorted" onDrop={dropInto('unsorted')} onClick={() => onOpen('unsorted')}>
          <div className="folder-tile">?</div>
          <div className="folder-name">Unsorted</div>
          <div className="muted folder-meta">
            {unsortedCount} ep{unsortedCount === 1 ? '' : 's'}
          </div>
        </DropTarget>
      )}
      {parentId === null && <NewFolderCard run={run} />}
    </div>
  )
}

function NewFolderCard({ run }: { run: (fn: () => Promise<unknown>) => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  if (!editing) {
    return (
      <button className="folder-card new-folder" onClick={() => setEditing(true)}>
        <div className="folder-tile">+</div>
        <div className="folder-name">New folder</div>
      </button>
    )
  }
  return (
    <form
      className="folder-card new-folder editing"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) run(() => window.api.createFolder(name, null))
        setEditing(false)
        setName('')
      }}
    >
      <input autoFocus placeholder="Series name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
      <div className="row">
        <button type="submit" className="primary">
          Create
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function NewFolderButton({
  parentId,
  label,
  run
}: {
  parentId: number
  label: string
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  if (!editing) return <button onClick={() => setEditing(true)}>{label}</button>
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) run(() => window.api.createFolder(name, parentId))
        setEditing(false)
        setName('')
      }}
    >
      <input autoFocus placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
      <button type="submit" className="primary">
        Create
      </button>
    </form>
  )
}

function EpisodeList({
  episodes,
  available,
  lib,
  torrents,
  run
}: {
  episodes: EpisodeInfo[]
  available: AvailableEpisode[]
  lib: LibraryData
  torrents: Map<number, TorrentStatusInfo>
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element {
  const options = useMemo(() => flattenFolders(lib.folders), [lib.folders])
  // Downloaded and not-yet-downloaded episodes in one list, by episode number.
  const rows = useMemo(
    () =>
      [
        ...episodes.map((e) => ({ kind: 'episode' as const, num: e.episodeNum, title: e.title, e })),
        ...available.map((a) => ({ kind: 'available' as const, num: a.episodeNum, title: a.title, a }))
      ].sort(
        (x, y) => (x.num ?? Infinity) - (y.num ?? Infinity) || x.title.localeCompare(y.title, undefined, { numeric: true })
      ),
    [episodes, available]
  )
  if (rows.length === 0) {
    return <p className="muted">No episodes here yet. Drag episodes onto this folder, or pick it when downloading.</p>
  }
  return (
    <ul className="episode-list">
      {rows.map((row) =>
        row.kind === 'available' ? (
          <ReleaseRow key={`r${row.a.id}`} a={row.a} run={run} />
        ) : (
          <EpisodeRow key={row.e.id} e={row.e} t={torrents.get(row.e.torrentId)} options={options} run={run} />
        )
      )}
    </ul>
  )
}

/** A library episode: downloaded, downloading, or only streamed. */
function EpisodeRow({
  e,
  t,
  options,
  run
}: {
  e: EpisodeInfo
  t: TorrentStatusInfo | undefined
  options: ReturnType<typeof flattenFolders>
  run: (fn: () => Promise<unknown>) => void
}): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const progress = t?.files[e.fileIndex]?.progress ?? 0
  const label = e.episodeNum != null ? `Ep ${e.episodeNum}` : 'This episode'
  return (
    <li
      className={`episode ${e.watched ? 'watched' : ''}`}
      draggable
      onDragStart={(ev) => startDrag(ev, { type: 'episode', id: e.id })}
    >
      <button className="play-file" title="Play" onClick={() => run(() => window.api.play(e.torrentId, e.fileIndex))}>
        ▶
      </button>
      <span className="ep-num">{e.episodeNum != null ? `Ep ${e.episodeNum}` : '—'}</span>
      <span className="ep-title" title={e.title}>
        {e.title}
      </span>
      {confirm ? (
        <span className="ep-state confirm">
          {e.downloaded ? (
            <>
              <span className="muted">
                Delete the {progress < 1 ? 'partly ' : ''}downloaded file? {label} stays in the library to stream.
              </span>
              <button className="danger" onClick={() => run(() => window.api.deleteEpisode(e.id, false))}>
                Delete file
              </button>
              <button onClick={() => run(() => window.api.deleteEpisode(e.id, true))}>Remove from library</button>
            </>
          ) : (
            <>
              <span className="muted">Remove {label} from the library?</span>
              <button className="danger" onClick={() => run(() => window.api.deleteEpisode(e.id, true))}>
                Remove
              </button>
            </>
          )}
          <button onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : (
        <span className="ep-state">
          {e.downloaded && progress < 1 && (
            <span className="ep-download" title={t ? `Torrent ${t.status}` : undefined}>
              {t?.status === 'paused' ? 'Paused' : 'Downloading'} {(progress * 100).toFixed(0)}%
            </span>
          )}
          {e.watched ? (
            <span className="watched-badge">Watched</span>
          ) : e.positionSec > RESUME_MIN_SEC ? (
            <span className="resume-at">
              {formatClock(e.positionSec)}
              {e.durationSec ? ` / ${formatClock(e.durationSec)}` : ''}
            </span>
          ) : null}
          <span className="muted">{formatBytes(e.sizeBytes)}</span>
          {e.downloaded ? (
            progress >= 1 && <span className="downloaded-badge">Downloaded</span>
          ) : (
            <button className="link" onClick={() => run(() => window.api.downloadEpisode(e.id))}>
              Download
            </button>
          )}
          <button className="link" onClick={() => run(() => window.api.setWatched(e.torrentId, e.fileIndex, !e.watched))}>
            {e.watched ? 'Mark unwatched' : 'Mark watched'}
          </button>
          <select
            className="move-to"
            value=""
            title="Move to folder"
            onChange={(ev) => {
              const v = ev.target.value
              run(() => window.api.moveEpisodes([e.id], v === 'unsorted' ? null : Number(v)))
            }}
          >
            <option value="" disabled>
              Move to…
            </option>
            {options
              .filter(({ folder }) => folder.id !== e.folderId)
              .map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {' '.repeat(depth)}
                  {folder.name}
                </option>
              ))}
            {e.folderId !== null && <option value="unsorted">Unsorted</option>}
          </select>
          <button className="link" onClick={() => setConfirm(true)}>
            {e.downloaded ? 'Delete' : 'Remove'}
          </button>
        </span>
      )}
    </li>
  )
}

/** A followed series' episode on nyaa that hasn't been played or downloaded yet. */
function ReleaseRow({ a, run }: { a: AvailableEpisode; run: (fn: () => Promise<unknown>) => void }): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <li className="episode">
      <button className="play-file" title="Play" onClick={() => run(() => window.api.streamRelease(a.id))}>
        ▶
      </button>
      <span className="ep-num">Ep {a.episodeNum}</span>
      <span className="ep-title" title={a.title}>
        {a.title}
      </span>
      {confirm ? (
        <span className="ep-state confirm">
          <span className="muted">Remove Ep {a.episodeNum} from the library?</span>
          <button className="danger" onClick={() => run(() => window.api.dismissRelease(a.id))}>
            Remove
          </button>
          <button onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : (
        <span className="ep-state">
          <span className="muted">New · {formatAge(new Date(a.publishedAt).toISOString())}</span>
          <span className="muted">{formatBytes(a.sizeBytes)}</span>
          <button className="link" onClick={() => run(() => window.api.downloadRelease(a.id))}>
            Download
          </button>
          <button className="link" onClick={() => setConfirm(true)}>
            Remove
          </button>
        </span>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------

/** A card, crumb, etc. that accepts dropped episodes/folders and may itself be draggable. */
function DropTarget({
  as,
  className,
  onDrop,
  onClick,
  drag,
  children
}: {
  as: 'div' | 'button'
  className: string
  onDrop: (item: DragItem) => void
  onClick?: () => void
  drag?: DragItem
  children: ReactNode
}): JSX.Element {
  const [over, setOver] = useState(false)
  const Tag = as
  return (
    <Tag
      className={`${className} ${over ? 'drop-over' : ''}`}
      onClick={onClick}
      draggable={drag ? true : undefined}
      onDragStart={drag ? (ev: DragEvent) => startDrag(ev, drag) : undefined}
      onDragOver={(ev: DragEvent) => {
        if (!ev.dataTransfer.types.includes(DRAG_MIME)) return
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev: DragEvent) => {
        ev.preventDefault()
        setOver(false)
        const raw = ev.dataTransfer.getData(DRAG_MIME)
        if (raw) onDrop(JSON.parse(raw) as DragItem)
      }}
    >
      {children}
    </Tag>
  )
}

function startDrag(ev: DragEvent, item: DragItem): void {
  ev.stopPropagation()
  ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(item))
  ev.dataTransfer.effectAllowed = 'move'
}

function subtreeEpisodes(lib: LibraryData, folderId: number): EpisodeInfo[] {
  const ids = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of lib.folders) {
      if (f.parentId != null && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id)
        grew = true
      }
    }
  }
  return lib.episodes.filter((e) => e.folderId != null && ids.has(e.folderId))
}

/** "Ep 5"; for unnumbered episodes "next" in buttons, or the file name in cards. */
function epLabel(e: EpisodeInfo, preferTitle = false): string {
  if (e.episodeNum != null) return `Ep ${e.episodeNum}`
  return preferTitle ? e.title.replace(/\.[^.]+$/, '') : 'next'
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

/** A stable, muted color per folder name, so each series has its own tile. */
function tileColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return `linear-gradient(135deg, hsl(${h} 18% 30%), hsl(${(h + 30) % 360} 18% 20%))`
}
