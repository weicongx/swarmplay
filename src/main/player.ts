import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { connect, type Socket } from 'net'
import { join } from 'path'
import { RESUME_MIN_SEC } from '@shared/types'
import { getDb, getSettings } from './db'
import { nextEpisode } from './library'
import { preparePlayback, type PlaybackTarget } from './torrent'

// One mpv instance is reused for every episode and driven over its JSON IPC pipe.
const PIPE = `\\\\.\\pipe\\swarmplay-mpv-${process.pid}`
const SAVE_EVERY_MS = 5_000
/** Past this fraction of the runtime an episode counts as watched. */
const WATCHED_AT = 0.9

interface NowPlaying {
  torrentId: number
  fileIndex: number
  /** False until mpv reports the file loaded, so events from the previous file are ignored. */
  loaded: boolean
  pos: number
  duration: number | null
  lastSaved: number
}

let proc: ChildProcess | null = null
let sock: Socket | null = null
let current: NowPlaying | null = null

export function findMpv(): string | null {
  const { mpvPath } = getSettings()
  if (mpvPath) return existsSync(mpvPath) ? mpvPath : null

  const env = process.env
  const candidates = [
    join(env.ProgramFiles ?? 'C:\\Program Files', 'MPV Player', 'mpv.exe'), // winget shinchiro.mpv
    join(env.ProgramFiles ?? 'C:\\Program Files', 'mpv', 'mpv.exe'),
    join(env.LOCALAPPDATA ?? '', 'Programs', 'mpv', 'mpv.exe'),
    join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
    join(env.USERPROFILE ?? '', 'scoop', 'shims', 'mpv.exe'),
    join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'mpv.exe'),
    ...(env.PATH ?? '').split(';').filter(Boolean).map((dir) => join(dir, 'mpv.exe'))
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export async function play(torrentId: number, fileIndex: number): Promise<void> {
  const mpv = findMpv()
  if (!mpv) {
    throw new Error('mpv was not found. Install it (winget install shinchiro.mpv) or set its path in Settings.')
  }

  const target = await preparePlayback(torrentId, fileIndex)
  const start = rememberEpisode(torrentId, fileIndex, target)

  saveCurrent()
  await ensureMpv(mpv)
  current = { torrentId, fileIndex, loaded: false, pos: start, duration: null, lastSaved: Date.now() }

  // `start` is a global option, so set it before every load.
  command('set_property', 'start', start > 0 ? String(start) : 'none')
  command('set_property', 'force-media-title', target.title)
  command('loadfile', target.source, 'replace')
}

export function setWatched(torrentId: number, fileIndex: number, watched: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO episodes (torrent_id, file_index, title, file_path, size_bytes, watched, position_sec)
       VALUES (?, ?, '', '', 0, ?, 0)
       ON CONFLICT(torrent_id, file_index) DO UPDATE SET watched = excluded.watched, position_sec = 0`
    )
    .run(torrentId, fileIndex, watched ? 1 : 0)
}

export function stopPlayer(): void {
  saveCurrent()
  proc?.kill()
}

// ---------------------------------------------------------------------------

/** Create or update the episode row and return where playback should start. */
function rememberEpisode(torrentId: number, fileIndex: number, target: PlaybackTarget): number {
  getDb()
    .prepare(
      `INSERT INTO episodes (torrent_id, file_index, title, file_path, size_bytes, last_played_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(torrent_id, file_index) DO UPDATE SET
         title = excluded.title, file_path = excluded.file_path, size_bytes = excluded.size_bytes,
         last_played_at = excluded.last_played_at`
    )
    .run(torrentId, fileIndex, target.title, target.localPath, target.length, Date.now())

  const ep = getDb()
    .prepare('SELECT position_sec, duration_sec, watched FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(torrentId, fileIndex) as { position_sec: number; duration_sec: number | null; watched: number }

  // Rewatching starts over; otherwise resume unless it's barely started or nearly over.
  if (ep.watched) return 0
  const nearEnd = ep.duration_sec != null && ep.position_sec > ep.duration_sec - 30
  return ep.position_sec > RESUME_MIN_SEC && !nearEnd ? Math.floor(ep.position_sec) : 0
}

function saveCurrent(): void {
  if (!current?.loaded) return
  const { torrentId, fileIndex, pos, duration } = current
  const watched = duration != null && duration > 0 && pos >= duration * WATCHED_AT
  getDb()
    .prepare(
      `UPDATE episodes SET position_sec = ?, duration_sec = ?, watched = CASE WHEN ? THEN 1 ELSE watched END
       WHERE torrent_id = ? AND file_index = ?`
    )
    .run(watched ? 0 : pos, duration, watched ? 1 : 0, torrentId, fileIndex)
  current.lastSaved = Date.now()
}

async function ensureMpv(mpvPath: string): Promise<void> {
  if (proc && sock && !sock.destroyed) return

  const child = spawn(
    mpvPath,
    [
      `--input-ipc-server=${PIPE}`,
      '--idle=yes', // stay open between episodes so autoplay reuses the window
      '--force-window=yes', // show the window while the stream buffers
      '--keep-open=no',
      '--network-timeout=120' // torrents can take a while to find the first pieces
    ],
    { stdio: 'ignore', windowsHide: false }
  )
  proc = child
  child.on('exit', () => {
    if (proc !== child) return
    saveCurrent()
    proc = null
    sock?.destroy()
    sock = null
    current = null
  })

  sock = await connectWithRetry()
  let buffered = ''
  sock.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    let nl: number
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim()) onMessage(JSON.parse(line))
    }
  })
  sock.on('error', () => {})

  command('observe_property', 1, 'time-pos')
  command('observe_property', 2, 'duration')
}

async function connectWithRetry(): Promise<Socket> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await new Promise<Socket>((resolveSock, reject) => {
        const s = connect(PIPE)
        s.once('connect', () => resolveSock(s))
        s.once('error', reject)
      })
    } catch {
      if (!proc) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('Could not connect to mpv')
}

function command(...args: unknown[]): void {
  sock?.write(JSON.stringify({ command: args }) + '\n')
}

interface MpvMessage {
  event?: string
  name?: string
  data?: unknown
  reason?: string
}

function onMessage(msg: MpvMessage): void {
  if (!current) return

  if (msg.event === 'file-loaded') {
    current.loaded = true
  } else if (msg.event === 'property-change') {
    // duration can be reported just before file-loaded, and only changes once per file.
    if (msg.name === 'duration' && typeof msg.data === 'number') {
      current.duration = msg.data
    } else if (msg.name === 'time-pos' && typeof msg.data === 'number' && current.loaded) {
      current.pos = msg.data
      if (Date.now() - current.lastSaved > SAVE_EVERY_MS) saveCurrent()
    }
  } else if (msg.event === 'end-file' && msg.reason === 'eof' && current.loaded) {
    onEpisodeEnd(current)
  }
}

function onEpisodeEnd(ended: NowPlaying): void {
  saveCurrent()
  current = null

  // A stream that drops out early also reports eof, so only move on if it really finished.
  const finished = ended.duration != null && ended.pos >= ended.duration * WATCHED_AT
  const next = finished && getSettings().autoplayNext ? nextEpisode(ended.torrentId, ended.fileIndex) : null

  if (next) {
    play(next.torrentId, next.fileIndex).catch((err) => {
      console.error('Autoplay failed:', err)
      command('quit')
    })
  } else {
    command('quit')
  }
}
