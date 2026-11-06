import { mkdir, rm, rmdir } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { EventEmitter } from 'events'
import { BrowserWindow, shell } from 'electron'
import {
  VIDEO_EXT,
  type AddTorrentRequest,
  type AddTorrentResult,
  type TorrentStatus,
  type TorrentStatusInfo
} from '@shared/types'
import { getDb, getSettings } from './db'
import { fetchTorrentFile } from './nyaa'
import { parseRelease } from './release'
import { parseTorrentFile, type ParsedTorrent } from './torrentFile'

// The webtorrent package ships no types; these cover the parts used here.
interface WtFile {
  length: number
  downloaded: number
  streamURL: string
  select(): void
}
interface WtTorrent extends EventEmitter {
  ready: boolean
  files: WtFile[]
  downloadSpeed: number
  uploadSpeed: number
  uploaded: number
  numPeers: number
}
interface WtServer {
  listen(port: number, host: string, cb: () => void): void
  address(): { port: number }
}
interface WtClient extends EventEmitter {
  add(input: Buffer, opts: { path: string; deselect: boolean }): WtTorrent
  remove(torrent: WtTorrent, opts: { destroyStore: boolean }, cb: (err?: Error) => void): Promise<void>
  createServer(opts: { hostname: string; origin: string }): WtServer
  throttleDownload(rate: number): boolean
  throttleUpload(rate: number): boolean
  destroy(cb?: () => void): void
}

type PersistedStatus = Exclude<TorrentStatus, 'starting'>

interface TorrentRow {
  id: number
  info_hash: string
  name: string
  torrent_file: Uint8Array
  save_path: string
  status: PersistedStatus
  progress: number
  added_at: number
  selected_files: string | null
  file_progress: string | null
  uploaded: number
}

interface Entry {
  row: TorrentRow
  meta: ParsedTorrent
  selected: Set<number>
  /** Last known per-file progress, kept so inactive torrents still show it. */
  fileProgress: number[]
  torrent: WtTorrent | null
  error: string | null
  /**
   * Files already seen complete. Filled on the first ready tick without notifying,
   * so files that were on disk before (startup re-check) don't count as new downloads.
   */
  seenComplete?: Set<number>
}

const entries = new Map<number, Entry>()
const fileCompleteListeners: ((torrentId: number, fileIndex: number) => void)[] = []

/** Called when a selected video finishes downloading while the app is running. */
export function onFileComplete(cb: (torrentId: number, fileIndex: number) => void): void {
  fileCompleteListeners.push(cb)
}
let client: WtClient | null = null
let clientPromise: Promise<WtClient> | null = null
let serverPort = 0
let ticks = 0

function getClient(): Promise<WtClient> {
  clientPromise ??= (async () => {
    // webtorrent is ESM with top-level await, so it can't be require()d from the CJS main bundle.
    const { default: WebTorrent } = await import('webtorrent')
    const c = new WebTorrent() as WtClient
    c.on('error', (err: Error) => console.error('[webtorrent]', err.message))

    // Streams any file of any active torrent; mpv plays from here in phase 3.
    // `origin: false` is turned into '*' by webtorrent, so pass an origin no web page can have:
    // that keeps sites in a browser from reading the stream while mpv (which sends no Origin) works.
    const server = c.createServer({ hostname: '127.0.0.1', origin: 'null-origin.invalid' })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    serverPort = server.address().port

    client = c
    applyLimits()
    return c
  })()
  return clientPromise
}

export async function initTorrents(): Promise<void> {
  const rows = getDb().prepare('SELECT * FROM torrents ORDER BY added_at').all() as unknown as TorrentRow[]
  const { seedAfterDownload } = getSettings()

  for (const row of rows) {
    const meta = parseTorrentFile(Buffer.from(row.torrent_file))
    const selected = new Set<number>(
      row.selected_files ? JSON.parse(row.selected_files) : meta.files.map((f) => f.index)
    )
    const fileProgress = row.file_progress
      ? JSON.parse(row.file_progress)
      : meta.files.map(() => 0)
    const entry: Entry = { row, meta, selected, fileProgress, torrent: null, error: null }
    entries.set(row.id, entry)
    syncEpisodes(entry) // torrents added before the library existed land in Unsorted

    if (row.status === 'seeding' && !seedAfterDownload) setStatus(entry, 'done')
    if (row.status === 'downloading' || row.status === 'seeding' || row.status === 'error') {
      start(entry)
    }
  }

  setInterval(tick, 1000)
}

/**
 * Download a torrent. With a folder, its episodes are filed there and a new
 * torrent is saved under <library>/<folder name>/ on disk.
 */
export async function addTorrent(
  req: AddTorrentRequest,
  folder: { id: number; name: string } | null = null
): Promise<AddTorrentResult> {
  const settings = getSettings()
  const buf = await fetchTorrentFile(settings.nyaaBaseUrl, req.torrentUrl)
  const meta = parseTorrentFile(buf)

  const wanted = req.fileIndexes ?? meta.files.map((f) => f.index)
  if (wanted.length === 0) throw new Error('Pick at least one file to download')
  if (wanted.some((i) => !Number.isInteger(i) || i < 0 || i >= meta.files.length)) {
    throw new Error('Invalid file selection')
  }

  const existing = [...entries.values()].find((e) => e.row.info_hash === meta.infoHash)
  if (existing) {
    // Adding more episodes from a batch that's already downloading.
    const added = wanted.filter((i) => !existing.selected.has(i))
    for (const i of added) existing.selected.add(i)
    saveSelection(existing)
    syncEpisodes(existing, folder ? folder.id : undefined)
    if (existing.torrent?.ready) for (const i of added) existing.torrent.files[i].select()
    if (added.length > 0 && existing.row.status !== 'downloading') {
      setStatus(existing, 'downloading')
      if (!existing.torrent) start(existing)
    }
    return { id: existing.row.id, existed: true }
  }

  const savePath = folder ? join(settings.libraryRoot, safeDirName(folder.name)) : settings.libraryRoot
  await mkdir(savePath, { recursive: true })
  const selectedJson = wanted.length === meta.files.length ? null : JSON.stringify(wanted)
  const now = Date.now()
  const result = getDb()
    .prepare(
      `INSERT INTO torrents (info_hash, name, torrent_file, nyaa_id, save_path, status, progress, added_at, selected_files)
       VALUES (?, ?, ?, ?, ?, 'downloading', 0, ?, ?)`
    )
    .run(meta.infoHash, meta.name, buf, req.nyaaId ?? null, savePath, now, selectedJson)

  const id = Number(result.lastInsertRowid)
  const row = getDb().prepare('SELECT * FROM torrents WHERE id = ?').get(id) as unknown as TorrentRow
  const entry: Entry = {
    row,
    meta,
    selected: new Set(wanted),
    fileProgress: meta.files.map(() => 0),
    torrent: null,
    error: null
  }
  entries.set(id, entry)
  syncEpisodes(entry, folder?.id ?? null)
  start(entry)
  return { id, existed: false }
}

export async function pauseTorrent(id: number): Promise<void> {
  const entry = mustGet(id)
  await stop(entry)
  setStatus(entry, 'paused')
}

/** Pause every torrent that is downloading (seeding ones keep seeding). */
export async function pauseAll(): Promise<void> {
  for (const e of entries.values()) if (e.row.status === 'downloading') await pauseTorrent(e.row.id)
}

export async function resumeAll(): Promise<void> {
  for (const e of entries.values()) if (e.row.status === 'paused') await resumeTorrent(e.row.id)
}

export async function resumeTorrent(id: number): Promise<void> {
  const entry = mustGet(id)
  if (entry.torrent) return
  // tick() moves it on to seeding/done if everything is already on disk.
  setStatus(entry, 'downloading')
  start(entry)
}

export async function removeTorrent(id: number, deleteFiles: boolean): Promise<void> {
  const entry = mustGet(id)
  await stop(entry)
  entries.delete(id)
  getDb().prepare('DELETE FROM torrents WHERE id = ?').run(id)
  if (deleteFiles) await deleteTorrentFiles(entry)
  broadcast()
}

export async function showTorrentInFolder(id: number): Promise<void> {
  const { row, meta } = mustGet(id)
  const isMultiFile = meta.files.length > 1 || meta.files[0].path !== meta.name
  const folder = join(row.save_path, meta.name)
  if (isMultiFile && existsSync(folder)) {
    await shell.openPath(folder)
  } else if (!isMultiFile && existsSync(join(row.save_path, meta.name))) {
    shell.showItemInFolder(join(row.save_path, meta.name))
  } else {
    await shell.openPath(row.save_path)
  }
}

export function listTorrents(): TorrentStatusInfo[] {
  return [...entries.values()].sort((a, b) => b.row.added_at - a.row.added_at).map(statusOf)
}

/** Re-read speed limits and seeding policy after settings change. */
export function applyLimits(): void {
  const { downloadLimitKiB, uploadLimitKiB, seedAfterDownload } = getSettings()
  client?.throttleDownload(downloadLimitKiB > 0 ? downloadLimitKiB * 1024 : -1)
  client?.throttleUpload(uploadLimitKiB > 0 ? uploadLimitKiB * 1024 : -1)

  if (!seedAfterDownload) {
    for (const entry of entries.values()) {
      if (entry.row.status === 'seeding') stop(entry).then(() => setStatus(entry, 'done'))
    }
  }
}

export interface PlaybackTarget {
  title: string
  localPath: string
  /** What mpv should open: the file on disk if complete, otherwise the local stream URL */
  source: string
  length: number
}

/**
 * Get a file ready to play. Complete files play from disk; anything else is
 * selected for download, its torrent started if needed, and streamed over HTTP.
 */
export async function preparePlayback(torrentId: number, fileIndex: number): Promise<PlaybackTarget> {
  const entry = mustGet(torrentId)
  const file = entry.meta.files[fileIndex]
  if (!file) throw new Error('That file is not in this torrent')

  const localPath = resolve(entry.row.save_path, file.path)
  const target = { title: basename(file.path), localPath, length: file.length }
  if ((entry.fileProgress[fileIndex] ?? 0) >= 1 && existsSync(localPath)) {
    return { ...target, source: localPath }
  }

  if (!entry.selected.has(fileIndex)) {
    entry.selected.add(fileIndex)
    saveSelection(entry)
    syncEpisodes(entry)
    if (entry.torrent?.ready) entry.torrent.files[fileIndex].select()
  }
  if (!entry.torrent) {
    setStatus(entry, 'downloading')
    start(entry)
  }

  const torrent = await waitForReady(entry)
  return { ...target, source: `http://127.0.0.1:${serverPort}${torrent.files[fileIndex].streamURL}` }
}

/** Selected video files of a torrent, in episode order. */
export function playableFiles(torrentId: number): number[] {
  const entry = mustGet(torrentId)
  return entry.meta.files
    .filter((f) => entry.selected.has(f.index) && VIDEO_EXT.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((f) => f.index)
}

function waitForReady(entry: Entry, timeoutMs = 60_000): Promise<WtTorrent> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveReady, reject) => {
    const check = (): void => {
      if (entry.torrent?.ready) return resolveReady(entry.torrent)
      if (entry.error) return reject(new Error(entry.error))
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for the torrent to start'))
      setTimeout(check, 200)
    }
    check()
  })
}

/** Save progress on quit. DB writes are synchronous, so this finishes before exit. */
export function shutdownTorrents(): void {
  for (const entry of entries.values()) persistProgress(entry)
  client?.destroy()
}

// ---------------------------------------------------------------------------

function mustGet(id: number): Entry {
  const entry = entries.get(id)
  if (!entry) throw new Error(`No torrent with id ${id}`)
  return entry
}

async function start(entry: Entry): Promise<void> {
  entry.error = null
  if (entry.row.status === 'error') setStatus(entry, 'downloading')
  const c = await getClient()
  if (entry.torrent || !entries.has(entry.row.id)) return

  const torrent = c.add(Buffer.from(entry.row.torrent_file), {
    path: entry.row.save_path,
    deselect: true
  })
  entry.torrent = torrent

  torrent.on('ready', () => {
    for (const i of entry.selected) torrent.files[i].select()
  })
  torrent.on('error', (err: Error) => {
    entry.error = err.message
    entry.torrent = null
    setStatus(entry, 'error')
  })
}

function stop(entry: Entry): Promise<void> {
  const torrent = entry.torrent
  if (!torrent || !client) return Promise.resolve()
  persistProgress(entry)
  entry.row.uploaded += torrent.uploaded
  entry.torrent = null
  return new Promise((r) => client!.remove(torrent, { destroyStore: false }, () => r()))
}

function setStatus(entry: Entry, status: PersistedStatus): void {
  entry.row.status = status
  getDb().prepare('UPDATE torrents SET status = ? WHERE id = ?').run(status, entry.row.id)
}

/**
 * Make sure every selected video has a library episode row. New rows go to
 * `folderId` if given, otherwise to whichever folder this torrent already uses.
 */
function syncEpisodes(entry: Entry, folderId?: number | null): void {
  const db = getDb()
  const folder =
    folderId !== undefined
      ? folderId
      : ((
          db
            .prepare('SELECT folder_id FROM episodes WHERE torrent_id = ? AND folder_id IS NOT NULL LIMIT 1')
            .get(entry.row.id) as { folder_id: number } | undefined
        )?.folder_id ?? null)

  // Rows made by phase 3 playback may lack a title or episode number; fill those in.
  const upsert = db.prepare(
    `INSERT INTO episodes (folder_id, torrent_id, file_index, title, episode_num, file_path, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(torrent_id, file_index) DO UPDATE SET
       title = CASE WHEN episodes.title = '' THEN excluded.title ELSE episodes.title END,
       episode_num = COALESCE(episodes.episode_num, excluded.episode_num),
       file_path = excluded.file_path,
       size_bytes = excluded.size_bytes`
  )
  for (const f of entry.meta.files) {
    if (!entry.selected.has(f.index) || !VIDEO_EXT.test(f.path)) continue
    const title = basename(f.path)
    upsert.run(folder, entry.row.id, f.index, title, parseRelease(title).episode, resolve(entry.row.save_path, f.path), f.length)
  }
}

/** A folder name that is safe on Windows. */
function safeDirName(name: string): string {
  let s = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += '_'
  return s || 'Untitled'
}

function saveSelection(entry: Entry): void {
  const all = entry.selected.size === entry.meta.files.length
  const json = all ? null : JSON.stringify([...entry.selected].sort((a, b) => a - b))
  entry.row.selected_files = json
  getDb().prepare('UPDATE torrents SET selected_files = ? WHERE id = ?').run(json, entry.row.id)
}

function persistProgress(entry: Entry): void {
  const s = statusOf(entry)
  const uploaded = entry.row.uploaded + (entry.torrent?.uploaded ?? 0)
  getDb()
    .prepare('UPDATE torrents SET progress = ?, file_progress = ?, uploaded = ? WHERE id = ?')
    .run(s.progress, JSON.stringify(entry.fileProgress), uploaded, entry.row.id)
}

function statusOf(entry: Entry): TorrentStatusInfo {
  const { row, meta, torrent } = entry
  const active = torrent?.ready ? torrent : null

  if (active) {
    entry.fileProgress = active.files.map((f) => (f.length ? f.downloaded / f.length : 1))
  }

  const playback = new Map(
    (
      getDb()
        .prepare('SELECT file_index, position_sec, duration_sec, watched FROM episodes WHERE torrent_id = ?')
        .all(row.id) as { file_index: number; position_sec: number; duration_sec: number | null; watched: number }[]
    ).map((e) => [e.file_index, e])
  )

  let length = 0
  let downloaded = 0
  const files = meta.files.map((f) => {
    const selected = entry.selected.has(f.index)
    const progress = Math.min(entry.fileProgress[f.index] ?? 0, 1)
    if (selected) {
      length += f.length
      downloaded += f.length * progress
    }
    const ep = playback.get(f.index)
    return {
      index: f.index,
      path: f.path,
      length: f.length,
      progress,
      selected,
      streamUrl: active ? `http://127.0.0.1:${serverPort}${active.files[f.index].streamURL}` : null,
      isVideo: VIDEO_EXT.test(f.path),
      positionSec: ep?.position_sec ?? 0,
      durationSec: ep?.duration_sec ?? null,
      watched: ep?.watched === 1
    }
  })

  const downloadSpeed = active?.downloadSpeed ?? 0
  const status: TorrentStatus = torrent && !torrent.ready ? 'starting' : row.status
  return {
    id: row.id,
    infoHash: row.info_hash,
    name: row.name,
    savePath: row.save_path,
    status,
    error: entry.error,
    progress: length ? downloaded / length : 0,
    downloaded,
    length,
    downloadSpeed,
    uploadSpeed: active?.uploadSpeed ?? 0,
    uploaded: row.uploaded + (torrent?.uploaded ?? 0),
    numPeers: active?.numPeers ?? 0,
    timeRemaining:
      status === 'downloading' && downloadSpeed > 0 ? (length - downloaded) / downloadSpeed : null,
    addedAt: row.added_at,
    files
  }
}

function tick(): void {
  ticks++
  const { seedAfterDownload } = getSettings()

  for (const entry of entries.values()) {
    const s = statusOf(entry)
    if (!entry.torrent?.ready) {
      entry.seenComplete = undefined
      continue
    }

    // Compare against our own record, not the last progress reading: other callers
    // (the tray, the Downloads page) refresh progress between ticks.
    const firstTick = !entry.seenComplete
    entry.seenComplete ??= new Set()
    for (const f of s.files) {
      if (!f.selected || !f.isVideo || f.progress < 1 || entry.seenComplete.has(f.index)) continue
      entry.seenComplete.add(f.index)
      if (!firstTick) for (const cb of fileCompleteListeners) cb(entry.row.id, f.index)
    }

    const complete = s.files.every((f) => !f.selected || f.progress >= 1)
    if (complete && entry.row.status === 'downloading') {
      getDb().prepare('UPDATE torrents SET completed_at = ? WHERE id = ?').run(Date.now(), entry.row.id)
      persistProgress(entry)
      if (seedAfterDownload) setStatus(entry, 'seeding')
      else stop(entry).then(() => setStatus(entry, 'done'))
    } else if (!complete && entry.row.status === 'seeding') {
      setStatus(entry, 'downloading')
    }

    if (ticks % 5 === 0) persistProgress(entry)
  }

  broadcast()
}

function broadcast(): void {
  const list = listTorrents()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('torrents:update', list)
}

async function deleteTorrentFiles({ row, meta }: Entry): Promise<void> {
  const root = resolve(row.save_path)
  const dirs = new Set<string>()
  for (const f of meta.files) {
    const p = resolve(root, f.path)
    if (!p.startsWith(root + sep)) continue // never delete outside the library folder
    await rm(p, { force: true })
    for (let d = dirname(p); d.startsWith(root + sep); d = dirname(d)) dirs.add(d)
  }
  // Remove now-empty folders, deepest first; rmdir fails harmlessly on non-empty ones.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(d).catch(() => {})
  }
}
