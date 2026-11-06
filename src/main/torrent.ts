import { copyFile, mkdir, readdir, rename, rm, rmdir } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
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
  deselect(): void
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

type PersistedStatus = Exclude<TorrentStatus, 'starting' | 'streaming'>

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
  /** Files being downloaded to keep. Streamed files aren't in here. */
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
  /** The file the player is streaming from this torrent, if it isn't a kept download */
  streamFile: number | null
  /** Every file streamed since the stream started; their data is deleted when it ends */
  streamed: Set<number>
  /** Stopping, moving and deleting files run one at a time per torrent. */
  lock: Promise<void>
}

/**
 * Streams of episodes that aren't kept write into a hidden folder in the
 * library root (one per torrent), deleted when playback ends. Same drive as the
 * library, so keeping an episode mid-stream is a rename, not a copy.
 */
const STREAM_DIR = '.swarmplay-streaming'

const entries = new Map<number, Entry>()
const fileCompleteListeners: ((torrentId: number, fileIndex: number) => void)[] = []
/** The torrent the player is streaming a not-kept file from */
let streaming: Entry | null = null

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

    // Streams any file of any active torrent; mpv plays from here.
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
    const entry: Entry = {
      row,
      meta,
      selected,
      fileProgress,
      torrent: null,
      error: null,
      streamFile: null,
      streamed: new Set(),
      lock: Promise.resolve()
    }
    entries.set(row.id, entry)

    if (selected.size === 0 && row.status !== 'idle') setStatus(entry, 'idle')
    // Left over from a stream the app quit during: clear it, or move what was kept.
    if (isStreamDir(row.save_path)) {
      if (selected.size === 0) {
        await clearStreamDir(entry)
      } else {
        await moveToLibrary(entry).catch((err) => console.error('Failed to move a download:', err))
      }
    }
    syncEpisodes(entry) // torrents added before the library existed land in Unsorted

    if (row.status === 'seeding' && !seedAfterDownload) setStatus(entry, 'done')
    if (row.status === 'downloading' || row.status === 'seeding' || row.status === 'error') {
      start(entry)
    }
  }

  await removeOrphanStreamDirs()
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
  checkIndexes(meta, wanted)

  const existing = [...entries.values()].find((e) => e.row.info_hash === meta.infoHash)
  if (existing) {
    // More episodes from a batch that's already here, or keeping one that was only streamed.
    await keepFiles(existing, wanted, folder ? folder.id : undefined)
    return { id: existing.row.id, existed: true }
  }

  const savePath = folder ? join(settings.libraryRoot, safeDirName(folder.name)) : settings.libraryRoot
  await mkdir(savePath, { recursive: true })
  const selectedJson = wanted.length === meta.files.length ? null : JSON.stringify(wanted)
  const entry = insertTorrent(meta, buf, req.nyaaId, savePath, 'downloading', selectedJson)
  syncEpisodes(entry, folder?.id ?? null)
  start(entry)
  return { id: entry.row.id, existed: false }
}

/**
 * Add a torrent's episodes to the library without downloading anything. They
 * play by streaming, and nothing stays on disk afterwards unless they're downloaded.
 */
export async function addStream(
  req: AddTorrentRequest,
  folder: { id: number; name: string } | null = null
): Promise<AddTorrentResult> {
  const buf = await fetchTorrentFile(getSettings().nyaaBaseUrl, req.torrentUrl)
  const meta = parseTorrentFile(buf)
  const wanted = req.fileIndexes ?? meta.files.map((f) => f.index)
  checkIndexes(meta, wanted)
  const videos = wanted.filter((i) => VIDEO_EXT.test(meta.files[i].path))
  if (videos.length === 0) throw new Error('Pick at least one video to stream')

  const existing = [...entries.values()].find((e) => e.row.info_hash === meta.infoHash)
  if (existing) {
    syncEpisodes(existing, folder ? folder.id : undefined, videos)
    return { id: existing.row.id, existed: true }
  }

  const entry = insertTorrent(meta, buf, req.nyaaId, streamDirFor(meta.infoHash), 'idle', '[]')
  syncEpisodes(entry, folder?.id ?? null, videos)
  return { id: entry.row.id, existed: false }
}

/** Start keeping a file that was only streamed (or download it again after deleting it). */
export async function downloadFile(torrentId: number, fileIndex: number): Promise<void> {
  await keepFiles(mustGet(torrentId), [fileIndex])
}

/**
 * Delete a kept file from disk. Its library episode stays, to stream later.
 * Close the player first if it's playing from this torrent.
 */
export function deleteDownload(torrentId: number, fileIndex: number): Promise<void> {
  const entry = mustGet(torrentId)
  return withLock(entry, async () => {
    if (entry.selected.delete(fileIndex)) saveSelection(entry)
    entry.seenComplete?.delete(fileIndex)
    const wasRunning = entry.row.status === 'downloading' || entry.row.status === 'seeding'
    await stop(entry)
    if (!isStreamDir(entry.row.save_path)) await deleteFilesOf(entry, [fileIndex])
    if (entry.selected.size === 0) await becomeStreamOnly(entry, true)
    else if (wasRunning) start(entry)
    persistProgress(entry)
    broadcast()
  })
}

export function isKept(torrentId: number, fileIndex: number): boolean {
  return entries.get(torrentId)?.selected.has(fileIndex) ?? false
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

/** Remove a torrent and its library episodes entirely. */
export async function removeTorrent(id: number, deleteFiles: boolean): Promise<void> {
  const entry = mustGet(id)
  if (streaming === entry) streaming = null
  await withLock(entry, async () => {
    await stop(entry)
    entries.delete(id)
    getDb().prepare('DELETE FROM torrents WHERE id = ?').run(id)
    if (deleteFiles) await deleteTorrentFiles(entry)
  })
  broadcast()
}

/**
 * Remove a torrent from Downloads. Its episodes stay in the library to stream;
 * a torrent with no episodes there (no video files) goes completely.
 */
export async function removeDownload(id: number, deleteFiles: boolean): Promise<void> {
  const entry = mustGet(id)
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM episodes WHERE torrent_id = ? AND title != ''")
    .get(id) as { n: number }
  if (n === 0) return removeTorrent(id, deleteFiles)

  await withLock(entry, async () => {
    await stop(entry)
    if (deleteFiles && !isStreamDir(entry.row.save_path)) {
      await deleteFilesOf(entry, entry.meta.files.map((f) => f.index))
    }
    entry.selected.clear()
    saveSelection(entry)
    entry.seenComplete = undefined
    // Without deleteFiles the files stay where they are, no longer managed by the app.
    await becomeStreamOnly(entry, false)
    persistProgress(entry)
  })
  broadcast()
}

/** Remove torrents that only existed to stream episodes no longer in the library. */
export async function pruneStreamTorrents(): Promise<void> {
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM episodes WHERE torrent_id = ? AND title != ''")
  for (const entry of [...entries.values()]) {
    if (entry.selected.size > 0 || streaming === entry) continue
    if ((count.get(entry.row.id) as { n: number }).n === 0) await removeTorrent(entry.row.id, true)
  }
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
      if (entry.row.status !== 'seeding') continue
      if (streaming === entry) setStatus(entry, 'done')
      else stop(entry).then(() => setStatus(entry, 'done'))
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
 * Get a file ready to play. Kept files that are complete play from disk. Kept
 * files still downloading stream from their download; any other file streams
 * into the stream folder and is deleted when playback ends.
 */
export async function preparePlayback(torrentId: number, fileIndex: number): Promise<PlaybackTarget> {
  const entry = mustGet(torrentId)
  const file = entry.meta.files[fileIndex]
  if (!file) throw new Error('That file is not in this torrent')

  if (streaming && streaming !== entry) void endStream()
  await entry.lock

  const kept = entry.selected.has(fileIndex)
  const localPath = resolve(entry.row.save_path, file.path)
  const target = { title: basename(file.path), localPath, length: file.length }
  if (kept && (entry.fileProgress[fileIndex] ?? 0) >= 1 && existsSync(localPath)) {
    return { ...target, source: localPath }
  }

  if (!kept) {
    streaming = entry
    const prev = entry.streamFile
    if (prev != null && prev !== fileIndex && !entry.selected.has(prev) && entry.torrent?.ready) {
      entry.torrent.files[prev].deselect()
    }
    entry.streamFile = fileIndex
    entry.streamed.add(fileIndex)
    syncEpisodes(entry, undefined, [fileIndex])
    if (entry.torrent?.ready) entry.torrent.files[fileIndex].select()
  } else if (!entry.torrent) {
    setStatus(entry, 'downloading')
  }
  if (!entry.torrent) {
    await ensureDir(entry.row.save_path)
    start(entry)
  }

  const torrent = await waitForReady(entry)
  return { ...target, source: `http://127.0.0.1:${serverPort}${torrent.files[fileIndex].streamURL}` }
}

/**
 * Playback stopped: drop what was streamed. The torrent stops unless it has
 * kept files still downloading or seeding, and a file kept mid-stream moves
 * into its library folder.
 */
export function endStream(): Promise<void> {
  const entry = streaming
  if (!entry) return Promise.resolve()
  streaming = null
  return withLock(entry, async () => {
    if (streaming === entry || !entries.has(entry.row.id)) return // playing from it again already
    const streamed = [...entry.streamed]
    entry.streamed.clear()
    entry.streamFile = null
    const resume = entry.row.status === 'downloading' || entry.row.status === 'seeding'
    await stop(entry)
    if (isStreamDir(entry.row.save_path)) {
      if (entry.selected.size === 0) await clearStreamDir(entry)
      else await moveToLibrary(entry)
    } else {
      await deleteFilesOf(entry, streamed.filter((i) => !entry.selected.has(i)))
    }
    persistProgress(entry)
    if (resume) start(entry)
    broadcast()
  })
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

function checkIndexes(meta: ParsedTorrent, indexes: number[]): void {
  if (indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= meta.files.length)) {
    throw new Error('Invalid file selection')
  }
}

function insertTorrent(
  meta: ParsedTorrent,
  buf: Buffer,
  nyaaId: number | undefined,
  savePath: string,
  status: PersistedStatus,
  selectedJson: string | null
): Entry {
  const result = getDb()
    .prepare(
      `INSERT INTO torrents (info_hash, name, torrent_file, nyaa_id, save_path, status, progress, added_at, selected_files)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(meta.infoHash, meta.name, buf, nyaaId ?? null, savePath, status, Date.now(), selectedJson)
  const id = Number(result.lastInsertRowid)
  const row = getDb().prepare('SELECT * FROM torrents WHERE id = ?').get(id) as unknown as TorrentRow
  const entry: Entry = {
    row,
    meta,
    selected: new Set(selectedJson ? (JSON.parse(selectedJson) as number[]) : meta.files.map((f) => f.index)),
    fileProgress: meta.files.map(() => 0),
    torrent: null,
    error: null,
    streamFile: null,
    streamed: new Set(),
    lock: Promise.resolve()
  }
  entries.set(id, entry)
  return entry
}

/** Mark files to keep and download them, moving a streamed torrent into the library. */
async function keepFiles(entry: Entry, indexes: number[], folderId?: number | null): Promise<void> {
  const added = indexes.filter((i) => !entry.selected.has(i))
  for (const i of added) entry.selected.add(i)
  saveSelection(entry)
  syncEpisodes(entry, folderId)
  if (added.length === 0) return

  // While it's streaming the data stays put; endStream() moves it afterwards.
  if (isStreamDir(entry.row.save_path) && streaming !== entry) {
    await withLock(entry, async () => {
      await stop(entry)
      await moveToLibrary(entry)
    })
  }
  if (entry.torrent?.ready) for (const i of added) entry.torrent.files[i].select()
  if (entry.row.status !== 'downloading') {
    setStatus(entry, 'downloading')
    if (!entry.torrent) {
      await ensureDir(entry.row.save_path)
      start(entry)
    }
  }
}

/** Nothing of this torrent is kept any more: it's only a source to stream from. */
async function becomeStreamOnly(entry: Entry, deleteLeftovers: boolean): Promise<void> {
  if (!isStreamDir(entry.row.save_path)) {
    // Pieces at file boundaries leave fragments of neighbouring files behind.
    if (deleteLeftovers) await deleteFilesOf(entry, entry.meta.files.map((f) => f.index))
    setSavePath(entry, streamDirFor(entry.row.info_hash))
  } else {
    await clearStreamDir(entry)
  }
  entry.fileProgress = entry.meta.files.map(() => 0)
  setStatus(entry, 'idle')
}

/**
 * Move a torrent's kept files out of its stream folder into the library
 * folder of its episodes. The torrent must be stopped.
 */
async function moveToLibrary(entry: Entry): Promise<void> {
  const folder = getDb()
    .prepare(
      `SELECT f.name FROM episodes e JOIN folders f ON f.id = e.folder_id
       WHERE e.torrent_id = ? AND e.title != '' LIMIT 1`
    )
    .get(entry.row.id) as { name: string } | undefined
  const root = getSettings().libraryRoot
  let target = folder ? join(root, safeDirName(folder.name)) : root
  const from = resolve(entry.row.save_path)
  const kept = entry.meta.files.filter((f) => entry.selected.has(f.index))
  // Never write over another release's file with the same name.
  if (kept.some((f) => existsSync(resolve(target, f.path)))) {
    target = join(target, `${safeDirName(entry.meta.name)} (${entry.row.info_hash.slice(0, 8)})`)
  }

  for (const f of kept) {
    const src = resolve(from, f.path)
    const dst = resolve(target, f.path)
    if (!existsSync(src) || existsSync(dst)) continue
    await mkdir(dirname(dst), { recursive: true })
    await rename(src, dst).catch(async () => {
      await copyFile(src, dst)
      await rm(src, { force: true })
    })
  }
  await rm(from, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  await mkdir(target, { recursive: true })
  setSavePath(entry, target)
}

function setSavePath(entry: Entry, path: string): void {
  const db = getDb()
  entry.row.save_path = path
  db.prepare('UPDATE torrents SET save_path = ? WHERE id = ?').run(path, entry.row.id)
  const update = db.prepare('UPDATE episodes SET file_path = ? WHERE torrent_id = ? AND file_index = ?')
  for (const f of entry.meta.files) update.run(resolve(path, f.path), entry.row.id, f.index)
}

async function start(entry: Entry): Promise<void> {
  entry.error = null
  if (entry.row.status === 'error') setStatus(entry, entry.selected.size > 0 ? 'downloading' : 'idle')
  const c = await getClient()
  if (entry.torrent || !entries.has(entry.row.id)) return

  const torrent = c.add(Buffer.from(entry.row.torrent_file), {
    path: entry.row.save_path,
    deselect: true
  })
  entry.torrent = torrent

  torrent.on('ready', () => {
    for (const i of entry.selected) torrent.files[i].select()
    if (entry.streamFile != null) torrent.files[entry.streamFile].select()
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

function withLock(entry: Entry, fn: () => Promise<void>): Promise<void> {
  const run = entry.lock.then(fn)
  entry.lock = run.catch(() => {})
  return run
}

function setStatus(entry: Entry, status: PersistedStatus): void {
  entry.row.status = status
  getDb().prepare('UPDATE torrents SET status = ? WHERE id = ?').run(status, entry.row.id)
}

/**
 * Make sure every selected video (and any in `extra`) has a library episode row.
 * New rows go to `folderId` if given, otherwise to whichever folder this torrent already uses.
 */
function syncEpisodes(entry: Entry, folderId?: number | null, extra: number[] = []): void {
  const db = getDb()
  const folder =
    folderId !== undefined
      ? folderId
      : ((
          db
            .prepare('SELECT folder_id FROM episodes WHERE torrent_id = ? AND folder_id IS NOT NULL LIMIT 1')
            .get(entry.row.id) as { folder_id: number } | undefined
        )?.folder_id ?? null)

  // Rows made by marking a file watched lack a title or episode number; fill those in.
  const upsert = db.prepare(
    `INSERT INTO episodes (folder_id, torrent_id, file_index, title, episode_num, file_path, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(torrent_id, file_index) DO UPDATE SET
       title = CASE WHEN episodes.title = '' THEN excluded.title ELSE episodes.title END,
       folder_id = CASE WHEN episodes.title = '' THEN excluded.folder_id ELSE episodes.folder_id END,
       episode_num = COALESCE(episodes.episode_num, excluded.episode_num),
       file_path = excluded.file_path,
       size_bytes = excluded.size_bytes`
  )
  for (const f of entry.meta.files) {
    if ((!entry.selected.has(f.index) && !extra.includes(f.index)) || !VIDEO_EXT.test(f.path)) continue
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
  const isStreaming = streaming === entry
  const status: TorrentStatus =
    isStreaming && entry.selected.size === 0 ? 'streaming' : torrent && !torrent.ready ? 'starting' : row.status
  return {
    id: row.id,
    infoHash: row.info_hash,
    name: row.name,
    savePath: row.save_path,
    status,
    streaming: isStreaming,
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
      // A stream from it keeps it running; endStream() stops it.
      else if (streaming === entry) setStatus(entry, 'done')
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

async function deleteTorrentFiles(entry: Entry): Promise<void> {
  if (isStreamDir(entry.row.save_path)) await clearStreamDir(entry)
  else await deleteFilesOf(entry, entry.meta.files.map((f) => f.index))
}

/**
 * Delete some of a torrent's files from its save folder, then any folders that
 * leaves empty. Skips files another torrent keeps at the same path.
 */
async function deleteFilesOf(entry: Entry, indexes: number[]): Promise<void> {
  if (indexes.length === 0) return
  const root = resolve(entry.row.save_path)
  const keptElsewhere = new Set<string>()
  for (const other of entries.values()) {
    if (other === entry) continue
    for (const i of other.selected) {
      keptElsewhere.add(resolve(other.row.save_path, other.meta.files[i].path).toLowerCase())
    }
  }
  const dirs = new Set<string>()
  for (const i of indexes) {
    const p = resolve(root, entry.meta.files[i].path)
    if (!p.startsWith(root + sep) || keptElsewhere.has(p.toLowerCase())) continue // never outside the folder
    // mpv may still be letting go of the file.
    await rm(p, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    entry.fileProgress[i] = 0
    for (let d = dirname(p); d.startsWith(root + sep); d = dirname(d)) dirs.add(d)
  }
  // Remove now-empty folders, deepest first; rmdir fails harmlessly on non-empty ones.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(d).catch(() => {})
  }
}

// --- Stream folders ---------------------------------------------------------

function streamDirFor(infoHash: string): string {
  return join(getSettings().libraryRoot, STREAM_DIR, infoHash)
}

function isStreamDir(path: string): boolean {
  return basename(dirname(resolve(path))) === STREAM_DIR
}

async function clearStreamDir(entry: Entry): Promise<void> {
  if (isStreamDir(entry.row.save_path)) {
    await rm(entry.row.save_path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
  for (const f of entry.meta.files) if (!entry.selected.has(f.index)) entry.fileProgress[f.index] = 0
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  // Keep the stream folder out of sight in Explorer.
  if (isStreamDir(path)) execFile('attrib', ['+h', dirname(path)], () => {})
}

/** Stream folders no torrent uses, e.g. after a torrent was removed mid-stream. */
async function removeOrphanStreamDirs(): Promise<void> {
  const root = join(getSettings().libraryRoot, STREAM_DIR)
  const used = new Set([...entries.values()].map((e) => resolve(e.row.save_path).toLowerCase()))
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const p = join(root, name)
    if (/^[0-9a-f]{40}$/i.test(name) && !used.has(resolve(p).toLowerCase())) {
      await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  }
}
