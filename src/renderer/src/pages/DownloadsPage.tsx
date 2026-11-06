import { useEffect, useState } from 'react'
import type { TorrentStatus, TorrentStatusInfo } from '@shared/types'
import { displayPath, errorMessage, formatBytes, formatDuration, formatSpeed } from '../format'

const STATUS_LABEL: Record<TorrentStatus, string> = {
  starting: 'Checking',
  downloading: 'Downloading',
  seeding: 'Seeding',
  done: 'Done',
  paused: 'Paused',
  error: 'Error'
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

  return (
    <div className="page">
      <h1>Downloads</h1>
      {error && <div className="error">{error}</div>}
      {torrents.length === 0 && (
        <p className="muted">Nothing yet. Pick a result on the Search page and press Download.</p>
      )}
      <div className="torrent-list">
        {torrents.map((t) => (
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
  const [expanded, setExpanded] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const active = t.status === 'downloading' || t.status === 'seeding' || t.status === 'starting'
  const selectedFiles = t.files
    .filter((f) => f.selected)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))

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

      {t.error && <div className="error">{t.error}</div>}

      <div className="torrent-actions">
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
            <label>
              <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />{' '}
              Also delete files
            </label>
            <button className="danger" onClick={run(() => window.api.removeTorrent(t.id, deleteFiles))}>
              Remove
            </button>
            <button onClick={() => setConfirmRemove(false)}>Cancel</button>
          </span>
        )}
      </div>

      {expanded && (
        <ul className="files torrent-files">
          {selectedFiles.map((f) => (
            <li key={f.index}>
              <span className="file-name">{displayPath(f.path, t.name)}</span>
              <span className="file-progress">
                <span className="muted">
                  {(f.progress * 100).toFixed(0)}% of {formatBytes(f.length)}
                </span>
                {f.streamUrl && (
                  <button
                    className="link"
                    title="Paste into mpv or VLC to watch while it downloads"
                    onClick={() => copyStream(f.index, f.streamUrl!)}
                  >
                    {copiedIndex === f.index ? 'Copied' : 'Copy stream link'}
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
