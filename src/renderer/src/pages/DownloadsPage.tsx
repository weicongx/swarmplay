import { useEffect, useState } from 'react'
import { RESUME_MIN_SEC, type TorrentFileStatus, type TorrentStatus, type TorrentStatusInfo } from '@shared/types'
import { displayPath, errorMessage, formatBytes, formatClock, formatDuration, formatSpeed } from '../format'

const STATUS_LABEL: Record<TorrentStatus, string> = {
  starting: 'Checking',
  downloading: 'Downloading',
  seeding: 'Seeding',
  done: 'Done',
  paused: 'Paused',
  error: 'Error',
  streaming: 'Streaming',
  idle: 'Not downloaded'
}

export default function DownloadsPage(): JSX.Element {
  const [torrents, setTorrents] = useState<TorrentStatusInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.listTorrents().then(setTorrents)
    return window.api.onTorrentsUpdate(setTorrents)
  }, [])

  // Wraps an action so failures show at the top of the page.
  const run = (fn: () => Promise<void>) => () => {
    setError(null)
    fn().catch((err) => setError(errorMessage(err)))
  }

  if (!torrents) return <div className="page" />
  // Torrents with nothing kept are only here while they stream.
  const shown = torrents.filter((t) => t.streaming || t.files.some((f) => f.selected))

  return (
    <div className="page">
      <h1>Downloads</h1>
      {error && <div className="error">{error}</div>}
      {shown.length === 0 && (
        <p className="muted">
          Nothing downloaded. Streaming doesn't save anything; press Download on Search or on a library episode to keep
          it.
        </p>
      )}
      <div className="torrent-list">
        {shown.map((t) => (
          <TorrentCard key={t.id} t={t} run={run} />
        ))}
      </div>
    </div>
  )
}

function TorrentCard({
  t,
  run
}: {
  t: TorrentStatusInfo
  run: (fn: () => Promise<void>) => () => void
}): JSX.Element {
  const selectedFiles = t.files
    .filter((f) => f.selected)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const [expanded, setExpanded] = useState(selectedFiles.length > 1)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const active = t.status === 'downloading' || t.status === 'seeding' || t.status === 'starting'
  const streamOnly = !t.files.some((f) => f.selected)
  // The episode "Play" picks: first unwatched one, or the first if all are watched.
  const videos = selectedFiles.filter((f) => f.isVideo)
  const next = videos.find((f) => !f.watched) ?? videos[0]

  async function copyStream(index: number, url: string): Promise<void> {
    await navigator.clipboard.writeText(url)
    setCopiedIndex(index)
  }

  return (
    <div className={`torrent-card status-${t.status}`}>
      <div className="torrent-top">
        <button className="torrent-name" onClick={() => setExpanded(!expanded)} title={t.name}>
          <span className="caret">{expanded ? '▾' : '▸'}</span> {t.name}
        </button>
        <span className={`pill pill-${t.status}`}>{STATUS_LABEL[t.status]}</span>
      </div>

      {streamOnly ? (
        <div className="torrent-stats">
          <span>↓ {formatSpeed(t.downloadSpeed)}</span>
          <span>↑ {formatSpeed(t.uploadSpeed)}</span>
          <span>{t.numPeers} peers</span>
          <span className="muted">Nothing is saved; it's deleted when playback stops.</span>
        </div>
      ) : (
        <>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${(t.progress * 100).toFixed(1)}%` }} />
          </div>

          <div className="torrent-stats">
            <span>
              {formatBytes(t.downloaded)} of {formatBytes(t.length)} · {(t.progress * 100).toFixed(1)}%
            </span>
            {t.status === 'downloading' && (
              <>
                <span>↓ {formatSpeed(t.downloadSpeed)}</span>
                <span>↑ {formatSpeed(t.uploadSpeed)}</span>
                <span>{t.numPeers} peers</span>
                <span>{t.timeRemaining != null ? `${formatDuration(t.timeRemaining)} left` : 'Finding peers…'}</span>
              </>
            )}
            {t.status === 'seeding' && (
              <>
                <span>↑ {formatSpeed(t.uploadSpeed)}</span>
                <span>{t.numPeers} peers</span>
              </>
            )}
            <span className="muted">Uploaded {formatBytes(t.uploaded)}</span>
          </div>
        </>
      )}

      {t.error && <div className="error">{t.error}</div>}

      {!streamOnly && (
        <div className="torrent-actions">
          {next && (
            <button
              className="primary"
              title={displayPath(next.path, t.name)}
              onClick={run(() => window.api.play(t.id, next.index))}
            >
              {next.positionSec > RESUME_MIN_SEC ? `Continue at ${formatClock(next.positionSec)}` : 'Play'}
              {videos.length > 1 && ` · ${shortName(displayPath(next.path, t.name))}`}
            </button>
          )}
          {active ? (
            <button onClick={run(() => window.api.pauseTorrent(t.id))}>Pause</button>
          ) : (
            <button onClick={run(() => window.api.resumeTorrent(t.id))}>
              {t.status === 'done' ? 'Seed' : t.status === 'error' ? 'Retry' : 'Resume'}
            </button>
          )}
          <button onClick={run(() => window.api.showTorrentInFolder(t.id))}>Show in folder</button>
          {!confirmRemove ? (
            <button onClick={() => setConfirmRemove(true)}>Remove</button>
          ) : (
            <span className="confirm">
              <span className="muted">Its episodes stay in the library to stream.</span>
              <label>
                <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />{' '}
                Also delete the files
              </label>
              <button className="danger" onClick={run(() => window.api.removeTorrent(t.id, deleteFiles))}>
                Remove
              </button>
              <button onClick={() => setConfirmRemove(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}

      {expanded && (
        <ul className="files torrent-files">
          {selectedFiles.map((f) => (
            <li key={f.index} className={f.watched ? 'watched' : ''}>
              <span className="file-name">
                {f.isVideo && (
                  <button className="play-file" title="Play" onClick={run(() => window.api.play(t.id, f.index))}>
                    ▶
                  </button>
                )}
                {displayPath(f.path, t.name)}
              </span>
              <span className="file-progress">
                {f.isVideo && <WatchState f={f} />}
                <span className="muted">
                  {f.progress >= 1 ? formatBytes(f.length) : `${(f.progress * 100).toFixed(0)}% of ${formatBytes(f.length)}`}
                </span>
                {f.isVideo && (
                  <button className="link" onClick={run(() => window.api.setWatched(t.id, f.index, !f.watched))}>
                    {f.watched ? 'Mark unwatched' : 'Mark watched'}
                  </button>
                )}
                {f.streamUrl && (
                  <button
                    className="link"
                    title="Paste into mpv or VLC to watch while it downloads"
                    onClick={() => copyStream(f.index, f.streamUrl!)}
                  >
                    {copiedIndex === f.index ? 'Copied' : 'Copy link'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function WatchState({ f }: { f: TorrentFileStatus }): JSX.Element | null {
  if (f.watched) return <span className="watched-badge">Watched</span>
  if (f.positionSec > RESUME_MIN_SEC) {
    return (
      <span className="resume-at">
        {formatClock(f.positionSec)}
        {f.durationSec ? ` / ${formatClock(f.durationSec)}` : ''}
      </span>
    )
  }
  return null
}

/** "[Group] Show - 03 (1080p) [ABCD].mkv" → "Show - 03", for button labels. */
function shortName(name: string): string {
  const base = name.split('/').pop()!.replace(/\.[^.]+$/, '')
  const cleaned = base.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || base).slice(0, 40)
}
