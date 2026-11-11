import { copyFile, mkdir, open, readdir, rename, rm, rmdir, stat, truncate, utimes } from 'fs/promises'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import crypto, { type DiffieHellman } from 'crypto'
import { basename, dirname, join, resolve, sep } from 'path'
import { EventEmitter } from 'events'
import { app, BrowserWindow, shell } from 'electron'
import {
  VIDEO_EXT,
  type AddTorrentRequest,
  type AddTorrentResult,
  type TorrentStatus,
  type TorrentStatusInfo
} from '@shared/types'
import { mkvCues, mkvCuesAt, mkvElementLength, type Cue, type MkvCuesAt } from './companion/mkv'
import { getDb, getSettings } from './db'
import { fetchTorrentFile } from './nyaa'
import { parseRelease } from './release'
import { parseTorrentFile, type ParsedTorrent } from './torrentFile'

// The webtorrent package ships no types; these cover the parts used here.
interface WtFile {
  length: number
  /** Byte offset of the file within the torrent */
  offset: number
  downloaded: number
  streamURL: string
  select(): void
  deselect(): void
}
interface WtTorrent extends EventEmitter {
  ready: boolean
  files: WtFile[]
  pieceLength: number
  bitfield: { get(index: number): boolean }
  downloadSpeed: number
  uploadSpeed: number
  uploaded: number
  numPeers: number
  select(start: number, end: number, priority?: number): void
  deselect(start: number, end: number): void
}
interface WtServer {
  listen(port: number, host: string, cb: () => void): void
  address(): { port: number }
}
interface WtDht {
  addNode(node: { host: string; port: number }): void
  toJSON(): { nodes: { host: string; port: number }[] }
}
interface WtClient extends EventEmitter {
  dht: WtDht | false
  add(input: Buffer, opts: { path: string; deselect: boolean; announce?: string[] }): WtTorrent
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
  /** 0: removed from Downloads, keeping its finished files */
  listed: number
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
  /** What the running torrent has been asked to fetch so far; see selectNextFiles() */
  fetching?: { files: Set<number>; stalledTicks: number; widened: number }
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
/**
 * The episode expected to play next, whose start is fetched ahead of time so
 * autoplay begins at once. It becomes the stream if playback continues into it;
 * otherwise its data is deleted like a stream's.
 */
let prefetching: { entry: Entry; fileIndex: number } | null = null
/** How much of the next episode to fetch ahead: its start, and its end (where mkv keeps its seek index). */
const PREFETCH_HEAD = 40 * 1024 * 1024
const PREFETCH_TAIL = 2 * 1024 * 1024
/** How much of a torrent's kept files to ask WebTorrent for at once. */
const FETCH_AT_ONCE_BYTES = 4 * 1024 ** 3
/** Slower than this for STALLED_TICKS seconds, a torrent also asks for the files after those. */
const STALLED_SPEED = 16 * 1024
const STALLED_TICKS = 20
/** Peer connections that share one set of encryption keys. */
const CONNECTIONS_PER_KEY = 32

/** Called when a selected video finishes downloading while the app is running. */
export function onFileComplete(cb: (torrentId: number, fileIndex: number) => void): void {
  fileCompleteListeners.push(cb)
}
let client: WtClient | null = null
let clientPromise: Promise<WtClient> | null = null
let serverPort = 0
let ticks = 0
let tickTimer: NodeJS.Timeout | null = null
/** Set on quit, once the torrents are destroyed: WebTorrent empties their files but leaves them ready. */
let shutDown = false

/**
 * Every encrypted peer connection makes a Diffie-Hellman object, and Node checks
 * the prime each time: about 30 ms, on the thread that also runs the window. The
 * protocol's prime is fixed and its encryption only disguises the traffic, so
 * connections share an object for a while. Each still gets its own shared secret.
 */
function shareEncryptionKeys(): void {
  type Create = (prime: string, encoding: 'hex', generator: number) => DiffieHellman
  const mod = crypto as unknown as { createDiffieHellman: Create }
  const create = mod.createDiffieHellman
  let shared: { prime: string; dh: DiffieHellman; uses: number } | null = null
  mod.createDiffieHellman = (prime, encoding, generator) => {
    // The protocol's prime is 768 bits; anything else isn't a peer connection's.
    if (typeof prime !== 'string' || prime.length !== 192 || encoding !== 'hex' || generator !== 2) {
      return create(prime, encoding, generator)
    }
    if (shared?.prime !== prime || shared.uses >= CONNECTIONS_PER_KEY) {
      shared = { prime, dh: create(prime, encoding, generator), uses: 0 }
    }
    shared.uses++
    return shared.dh
  }
}

function getClient(): Promise<WtClient> {
  clientPromise ??= (async () => {
    shareEncryptionKeys()
    // webtorrent is ESM with top-level await, so it can't be require()d from the CJS main bundle.
    const { default: WebTorrent } = await import('webtorrent')
    const c = new WebTorrent() as WtClient
    c.on('error', (err: Error) => console.error('[webtorrent]', err.message))
    restoreDhtNodes(c)
    // Also saved while running, as the app may not get to quit cleanly.
    setTimeout(saveDhtNodes, DHT_FIRST_SAVE_MS).unref()
    setInterval(saveDhtNodes, DHT_SAVE_EVERY_MS).unref()

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
  // Start the client, and with it the DHT, now rather than at the first Play,
  // so the DHT can find peers as soon as an episode starts.
  void getClient()
  const rows = getDb().prepare('SELECT * FROM torrents ORDER BY added_at').all() as unknown as TorrentRow[]
  const { seedAfterDownload } = getSettings()

  for (const row of rows) {
    let meta: ParsedTorrent
    try {
      meta = parseTorrentFile(Buffer.from(row.torrent_file))
    } catch (err) {
      // Added before unsafe file paths were refused: never start it.
      console.error(`Skipping torrent ${row.id} (${row.name}):`, err)
      continue
    }
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
    // Left over from a stream the app quit during: clear it (unless the stream cache keeps it), or move what was kept.
    if (isStreamDir(row.save_path)) {
      if (selected.size === 0) {
        if (cacheLimit() === 0) await clearStreamDir(entry)
      } else {
        await moveToLibrary(entry).catch((err) => console.error('Failed to move a download:', err))
      }
    } else if (selected.size < meta.files.length) {
      // A stream from a torrent with downloads writes next to them; if the app
      // quit mid-stream, what it streamed is still there.
      await clearUnkept(entry, []).catch((err) => console.error('Failed to clear a stream:', err))
    }
    syncEpisodes(entry) // torrents added before the library existed land in Unsorted

    if (row.status === 'seeding' && !seedAfterDownload) setStatus(entry, 'done')
    if (row.status === 'downloading' || row.status === 'seeding' || row.status === 'error') {
      start(entry)
    }
  }

  await removeOrphanStreamDirs()
  tickTimer = setInterval(tick, 1000)
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

/** Start keeping files that were only streamed (or download them again after deleting them). */
export async function downloadFiles(torrentId: number, fileIndexes: number[]): Promise<void> {
  await keepFiles(mustGet(torrentId), fileIndexes)
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

/**
 * Pause every torrent that is downloading (seeding ones keep seeding), except
 * `playing`, the one the player is streaming from.
 */
export async function pauseAll(playing: number | null = null): Promise<void> {
  for (const e of entries.values()) {
    if (e.row.status === 'downloading' && e.row.id !== playing) await pauseTorrent(e.row.id)
  }
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
  if (prefetching?.entry === entry) prefetching = null
  await withLock(entry, async () => {
    await stop(entry)
    entries.delete(id)
    getDb().prepare('DELETE FROM torrents WHERE id = ?').run(id)
    if (deleteFiles) await deleteTorrentFiles(entry)
  })
  broadcast()
}

/**
 * Remove a torrent from Downloads; a torrent with no episodes in the library
 * (no video files) goes completely. With deleteFiles its episodes stay in the
 * library to stream. Without, it stops: finished episodes stay downloaded and
 * play from disk, and unfinished ones go back to streaming.
 */
export async function removeDownload(id: number, deleteFiles: boolean): Promise<void> {
  const entry = mustGet(id)
  const { n } = getDb()
    .prepare("SELECT COUNT(*) AS n FROM episodes WHERE torrent_id = ? AND title != ''")
    .get(id) as { n: number }
  if (n === 0) return removeTorrent(id, deleteFiles)

  await withLock(entry, async () => {
    refreshProgress(entry)
    await stop(entry)
    // Full size on disk counts too: until a torrent has checked its files, their
    // progress isn't known. It checks them again whenever it next starts.
    const finished = (i: number): boolean => {
      if ((entry.fileProgress[i] ?? 0) >= 1) return true
      const f = entry.meta.files[i]
      if (statSync(resolve(entry.row.save_path, f.path), { throwIfNoEntry: false })?.size !== f.length) return false
      entry.fileProgress[i] = 1
      return true
    }
    for (const i of [...entry.selected]) {
      if (deleteFiles || !finished(i)) entry.selected.delete(i)
    }
    saveSelection(entry)
    entry.seenComplete = undefined
    if (entry.selected.size === 0) {
      await becomeStreamOnly(entry, true)
    } else {
      await clearUnkept(entry, [])
      setStatus(entry, 'done')
      setListed(entry, false)
    }
    persistProgress(entry)
  })
  broadcast()
}

/** Remove torrents that only existed to stream episodes no longer in the library. */
export async function pruneStreamTorrents(): Promise<void> {
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM episodes WHERE torrent_id = ? AND title != ''")
  for (const entry of [...entries.values()]) {
    if (entry.selected.size > 0 || streaming === entry || prefetching?.entry === entry) continue
    if ((count.get(entry.row.id) as { n: number }).n === 0) await removeTorrent(entry.row.id, true)
  }
}

/**
 * Open the torrent's folder in Explorer, or select its file. Only ever opens a
 * folder: opening a file would run it.
 */
export async function showTorrentInFolder(id: number): Promise<void> {
  const { row, meta } = mustGet(id)
  const root = resolve(row.save_path)
  const top = resolve(root, meta.files[0].path.split('/')[0])
  if (!top.startsWith(root + sep)) return void (await openFolder(root))
  const info = await stat(top).catch(() => null)
  if (info?.isDirectory()) await openFolder(top)
  else if (info?.isFile()) shell.showItemInFolder(top)
  else await openFolder(root)
}

async function openFolder(dir: string): Promise<void> {
  if ((await stat(dir).catch(() => null))?.isDirectory()) await shell.openPath(dir)
}

export function listTorrents(): TorrentStatusInfo[] {
  // One query for every torrent's watch progress, not one per torrent.
  const playback = new Map<number, Map<number, PlaybackRow>>()
  const rows = getDb()
    .prepare('SELECT torrent_id, file_index, position_sec, duration_sec, watched FROM episodes')
    .all() as unknown as (PlaybackRow & { torrent_id: number })[]
  for (const r of rows) {
    let m = playback.get(r.torrent_id)
    if (!m) playback.set(r.torrent_id, (m = new Map()))
    m.set(r.file_index, r)
  }
  return [...entries.values()]
    .sort((a, b) => b.row.added_at - a.row.added_at)
    .map((e) => statusOf(e, playback.get(e.row.id) ?? new Map()))
}

/** The list as last sent to the window (at most a second old), for callers that poll it. */
export function recentTorrents(): TorrentStatusInfo[] {
  return lastList ?? listTorrents()
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

  // Playing the episode fetched ahead takes over its torrent; anything else drops it.
  if (prefetching?.entry === entry && prefetching.fileIndex === fileIndex) prefetching = null
  else void cancelPrefetch()
  if (streaming && streaming !== entry) void endStream()
  await entry.lock

  const kept = entry.selected.has(fileIndex)
  const localPath = resolve(entry.row.save_path, file.path)
  if (!localPath.startsWith(resolve(entry.row.save_path) + sep)) throw new Error('That file path is not safe to open')
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
  streaming = null
  // Playback didn't continue into the episode fetched ahead, so it goes too
  // (with the stream itself when it's another file of the same torrent).
  let ahead = Promise.resolve()
  if (entry && prefetching?.entry === entry) prefetching = null
  else ahead = cancelPrefetch()
  if (!entry) return ahead
  return Promise.all([ahead, releaseStream(entry)]).then(() => {})
}

/**
 * Fetch the start of the episode expected to play next, behind the current
 * stream: with no stream selection of its own, it only gets what bandwidth
 * the playing file leaves. Replaces any earlier prefetch.
 */
export async function prefetch(torrentId: number, fileIndex: number): Promise<void> {
  const entry = mustGet(torrentId)
  if (!entry.meta.files[fileIndex]) throw new Error('That file is not in this torrent')
  if (prefetching?.entry === entry && prefetching.fileIndex === fileIndex) return
  await cancelPrefetch()
  const kept = entry.selected.has(fileIndex)
  if (kept && (entry.fileProgress[fileIndex] ?? 0) >= 1) return // it plays from disk
  await entry.lock

  prefetching = { entry, fileIndex }
  // Not kept: its data is deleted with the stream's, or when the prefetch is dropped.
  if (!kept) entry.streamed.add(fileIndex)
  if (entry.torrent?.ready) selectAhead(entry.torrent, fileIndex)
  else if (!entry.torrent) {
    await ensureDir(entry.row.save_path)
    start(entry) // its ready handler selects the pieces
  }
  broadcast()
}

/** Drop the episode fetched ahead: delete its data unless it's kept or still streaming. */
function cancelPrefetch(): Promise<void> {
  const p = prefetching
  if (!p) return Promise.resolve()
  prefetching = null
  const { entry, fileIndex } = p
  if (entry.selected.has(fileIndex)) return Promise.resolve() // downloading anyway
  if (streaming === entry) {
    // Another file of the torrent that's streaming: its data goes when the stream ends.
    if (entry.torrent?.ready && entry.streamFile !== fileIndex) deselectAhead(entry.torrent, fileIndex)
    return Promise.resolve()
  }
  return releaseStream(entry)
}

/** Piece ranges for the start and end of a file. */
function aheadRanges(torrent: WtTorrent, fileIndex: number): [number, number][] {
  const f = torrent.files[fileIndex]
  const pl = torrent.pieceLength
  const last = f.offset + f.length - 1
  const piece = (byte: number): number => Math.floor(byte / pl)
  return [
    [piece(f.offset), piece(Math.min(last, f.offset + PREFETCH_HEAD - 1))],
    [piece(Math.max(f.offset, last - PREFETCH_TAIL + 1)), piece(last)]
  ]
}

function selectAhead(torrent: WtTorrent, fileIndex: number): void {
  if (torrent.files[fileIndex].length === 0) return
  for (const [from, to] of aheadRanges(torrent, fileIndex)) torrent.select(from, to, 0)
}

function deselectAhead(torrent: WtTorrent, fileIndex: number): void {
  if (torrent.files[fileIndex].length === 0) return
  for (const [from, to] of aheadRanges(torrent, fileIndex)) torrent.deselect(from, to)
}

/**
 * Stop a torrent that was only running to stream (or fetch ahead) and delete
 * what it fetched that isn't kept. Kept files fetched in the stream folder move
 * to the library, and a torrent that was downloading or seeding starts again.
 */
function releaseStream(entry: Entry): Promise<void> {
  return withLock(entry, async () => {
    // Playing from it again already, or about to.
    if (streaming === entry || prefetching?.entry === entry || !entries.has(entry.row.id)) return
    const streamed = [...entry.streamed]
    entry.streamed.clear()
    entry.streamFile = null
    const resume = entry.row.status === 'downloading' || entry.row.status === 'seeding'
    await stop(entry)
    if (isStreamDir(entry.row.save_path)) {
      if (entry.selected.size > 0) await moveToLibrary(entry)
      else if (cacheLimit() > 0) await utimes(entry.row.save_path, new Date(), new Date()).catch(() => {})
      else await clearStreamDir(entry)
    } else {
      await clearUnkept(entry, streamed)
    }
    persistProgress(entry)
    if (resume) start(entry)
    broadcast()
  }).then(() => trimStreamCache())
}

/** How the torrent behind a playing file is doing, for the player. */
export function streamStats(torrentId: number, fileIndex: number): { downloadSpeed: number; numPeers: number; complete: boolean } {
  const entry = entries.get(torrentId)
  const t = entry?.torrent?.ready ? entry.torrent : null
  return {
    downloadSpeed: t?.downloadSpeed ?? 0,
    numPeers: t?.numPeers ?? 0,
    complete: (t ? t.files[fileIndex].downloaded / t.files[fileIndex].length : (entry?.fileProgress[fileIndex] ?? 0)) >= 1
  }
}

/** Ranges closer than this (a fraction of the file) are shown as one. */
const RANGE_GAP = 0.005

/** The parts of a file fetched so far, as [from, to] fractions of its length. */
export function fetchedRanges(torrentId: number, fileIndex: number): [number, number][] {
  const entry = entries.get(torrentId)
  const t = entry?.torrent?.ready ? entry.torrent : null
  const f = t?.files[fileIndex]
  if (!t || !f) return (entry?.fileProgress[fileIndex] ?? 0) >= 1 ? [[0, 1]] : []
  if (f.downloaded >= f.length) return [[0, 1]]
  const len = t.pieceLength
  const at = (piece: number): number => Math.min(1, Math.max(0, (piece * len - f.offset) / f.length))
  const ranges: [number, number][] = []
  for (let i = Math.floor(f.offset / len); i <= Math.floor((f.offset + f.length - 1) / len); i++) {
    if (!t.bitfield.get(i)) continue
    const last = ranges[ranges.length - 1]
    if (last && at(i) - last[1] < RANGE_GAP) last[1] = at(i + 1)
    else ranges.push([at(i), at(i + 1)])
  }
  return ranges
}

// ---------------------------------------------------------------------------
// Fetching a seek's target first.
//
// WebTorrent fetches a stream from wherever the player's range request starts,
// but mpv sends that request only once its read at the old spot returns, which
// at the edge of what's fetched waits for the next piece: often a second or
// more, while the old spot keeps the bandwidth. So on a seek the pieces at the
// target (from its keyframe's cluster, read from the mkv's Cues) are asked for
// at once, the old spot's stream waits, and faster peers may take blocks over
// from slow ones there. Hovering over the seek bar fetches the same window
// alongside playback, so the seek is ready by the time the bar is let go.
//
// WebTorrent takes turns between all selections with any priority, whatever
// its value, so what puts a seek first is the old spot's stream dropping to
// none, not the window's own priority.

/** Seconds of video a window holds after the target, within the byte bounds below. */
const WINDOW_SEC = 8
/**
 * mpv starts reading an mkv this far before a seek's target, from the keyframe
 * before that, for subtitles that started earlier (its demuxer-mkv-subtitle-preroll-secs-index).
 */
const PREROLL_SEC = 10
const WINDOW_MIN = 4 * 1024 * 1024
const WINDOW_MAX = 16 * 1024 * 1024
/** The longest the old spot's fetch stays behind a seek's; normally it ends at once, when mpv lets go of it. */
const DEMOTE_MS = 15_000
/** The mkv header bytes read for where the Cues are */
const HEAD_BYTES = 64 * 1024
/** Cues bigger than this aren't read (an episode's are some tens of KB) */
const CUES_MAX = 4 * 1024 * 1024

/**
 * WebTorrent's piece selections. Its public select() and deselect() merge with
 * and cut into the files' own selections, so the windows use the internal
 * stream selections its HTTP server uses, which stand alone.
 */
interface WtSelection {
  from: number
  to: number
  offset: number
  priority: number
  isStreamSelection?: boolean
}
interface WtInternals {
  _select(from: number, to: number, priority: number, notify: undefined, isStreamSelection: boolean): void
  _selections: { _items: WtSelection[]; sort(fn: (a: WtSelection, b: WtSelection) => number): void }
  _updateSelections(): void
  /** Pieces whose blocks faster peers may take over; WebTorrent itself never clears them. */
  _critical: (boolean | null | undefined)[]
  critical(from: number, to: number): void
  destroyed: boolean
}

/** The internals the windows use, or null if this WebTorrent lacks them (then seeks work as before). */
function internals(t: WtTorrent): WtInternals | null {
  const i = t as unknown as Partial<WtInternals>
  const ok =
    typeof i._select === 'function' &&
    typeof i._updateSelections === 'function' &&
    typeof i.critical === 'function' &&
    Array.isArray(i._critical) &&
    Array.isArray(i._selections?._items)
  return ok && !i.destroyed ? (i as WtInternals) : null
}

/** Mark pieces critical, returning those that weren't, so they can be unmarked once no longer needed. */
function markCritical(wi: WtInternals, from: number, to: number): number[] {
  const added: number[] = []
  for (let i = from; i <= to; i++) if (!wi._critical[i]) added.push(i)
  if (added.length) wi.critical(from, to)
  return added
}

/**
 * WebTorrent marks the pieces a stream's reader stalls on (and the next one or
 * two) critical itself, and only once, so those stay marked: a player may be
 * waiting on one of them right now.
 */
const READER_CRITICAL_PIECES = 3

function unmarkCritical(wi: WtInternals, pieces: number[]): void {
  if (pieces.length === 0) return
  const waited = new Set<number>()
  for (const sel of wi._selections._items) {
    if (!sel.isStreamSelection) continue
    const next = sel.from + sel.offset
    for (let i = next; i < next + READER_CRITICAL_PIECES && i <= sel.to; i++) waited.add(i)
  }
  for (const i of pieces) if (!waited.has(i)) wi._critical[i] = false
}

type WindowKind = 'seek' | 'hover'
interface PieceWindow {
  torrent: WtTorrent
  from: number
  to: number
  /** The window's selection, last, after any for the pieces mpv's reads at the old spot wait for */
  sels: WtSelection[]
  /** Pieces this window marked critical */
  marked: number[]
}
/** At most one window of each kind, across all torrents. */
const windows: Partial<Record<WindowKind, PieceWindow>> = {}
/** Bumped by each fetchAt of a kind, so one that finishes after a later one leaves it be. */
const windowCalls: Record<WindowKind, number> = { seek: 0, hover: 0 }

/** Seek indexes by "infoHash:fileIndex"; null when the file has none to read. */
const seekIndexes = new Map<string, Cue[] | null>()
const SEEK_INDEXES_KEPT = 20
/** Where a file's Cues are, once its header was read, while the Cues themselves are still being fetched */
const cuesAt = new Map<string, MkvCuesAt>()
/** Reads in progress, so overlapping seeks share one */
const seekIndexReads = new Map<string, Promise<Cue[] | null>>()

export interface FetchAtOptions {
  /**
   * mpv's read at the old spot is waiting for data (its cache isn't full), so
   * the piece that read waits for is fetched first: mpv asks for the target only
   * once that read returns. False when mpv isn't reading, and lets go at once.
   */
  readerWaiting?: boolean
}

/**
 * Fetch the part of a streaming file at `seconds` ahead of the rest, or stop
 * (`seconds` null). A 'seek' window puts the file's other streams (the spot
 * playback left) behind it; a 'hover' window shares the bandwidth with
 * playback. Each kind has one window at a time, which a new one replaces; a
 * seek replaces the hover too.
 */
export async function fetchAt(
  torrentId: number,
  fileIndex: number,
  seconds: number | null,
  duration: number | null,
  kind: WindowKind,
  opts: FetchAtOptions = {}
): Promise<void> {
  const call = ++windowCalls[kind]
  if (kind === 'seek') windowCalls.hover++
  const entry = entries.get(torrentId)
  const t = entry?.torrent?.ready ? entry.torrent : null
  const f = t?.files[fileIndex]
  if (seconds == null || !entry || !t || !f || f.length === 0 || f.downloaded >= f.length || !duration || duration <= 0) {
    if (kind === 'seek') dropWindow('hover')
    dropWindow(kind)
    return
  }
  const cues = await seekIndex(entry, fileIndex).catch(() => null)
  // A later call (or a seek, for a hover) took over meanwhile, or the torrent stopped.
  if (call !== windowCalls[kind] || entry.torrent !== t) return
  const at = Math.min(Math.max(0, seconds), duration)
  let start: number
  let span: number
  if (cues) {
    // From the keyframe mpv reads from, PREROLL_SEC before the target, to WINDOW_SEC after it.
    start = cues[lastCueAt(cues, at - PREROLL_SEC)].pos
    const after = cues.find((c) => c.time >= at + WINDOW_SEC)
    span = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, (after?.pos ?? f.length) - start))
  } else {
    // No index: a guess from the average bitrate, starting a little early, so less is fetched on it.
    span = WINDOW_MIN
    start = (at / duration) * f.length - span / 4
  }
  start = Math.min(Math.max(0, Math.floor(start)), f.length - 1)
  const pl = t.pieceLength
  const from = Math.floor((f.offset + start) / pl)
  const to = Math.floor((f.offset + Math.min(f.length - 1, start + span - 1)) / pl)

  const prev = windows[kind]
  const prevSel = prev?.sels[prev.sels.length - 1]
  if (prev && prevSel && prev.torrent === t && prev.from === from && prev.to === to && isLive(t, prevSel)) return
  if (kind === 'seek') dropWindow('hover')
  dropWindow(kind)
  const wi = internals(t)
  if (!wi || havePieces(t, from, to)) return

  const sels: WtSelection[] = []
  const marked: number[] = []
  const add = (a: number, b: number, priority: number): void => {
    const before = new Set(wi._selections._items)
    wi._select(a, b, priority, undefined, true)
    const sel = wi._selections._items.find((x) => !before.has(x))
    if (sel) sels.push(sel)
  }
  if (kind === 'seek') {
    // mpv asks for the target only once its read at the old spot returns, so
    // the piece that read waits for comes first; the rest of the old spot waits.
    const waiting = demoteOthers(t, wi, fileIndex, from, to)
    if (opts.readerWaiting) {
      for (const piece of waiting) {
        marked.push(...markCritical(wi, piece, piece))
        add(piece, piece, 2)
      }
    }
    marked.push(...markCritical(wi, from, to))
  }
  // Priority only orders selections that start at once; WebTorrent then takes turns between them.
  add(from, to, kind === 'seek' ? 2 : 1)
  windows[kind] = { torrent: t, from, to, sels, marked }
}

/** The pieces hurryFrom marked last, unmarked when it's called again. */
let hurried: { torrent: WtTorrent; marked: number[] } | null = null

/** Let faster peers take over a slow peer's blocks from `byte` on: a phone's player seeking, say. */
export function hurryFrom(torrentId: number, fileIndex: number, byte: number): void {
  const t = entries.get(torrentId)?.torrent
  const f = t?.ready ? t.files[fileIndex] : null
  const wi = t && internals(t)
  if (!t || !f || !wi || byte <= 0 || byte >= f.length) return
  if (hurried?.torrent === t) unmarkCritical(wi, hurried.marked)
  hurried = null
  const pl = t.pieceLength
  const from = Math.floor((f.offset + byte) / pl)
  const to = Math.floor((f.offset + Math.min(f.length - 1, byte + WINDOW_MIN - 1)) / pl)
  if (!havePieces(t, from, to)) hurried = { torrent: t, marked: markCritical(wi, from, to) }
}

function isLive(t: WtTorrent, sel: WtSelection): boolean {
  return internals(t)?._selections._items.includes(sel) ?? false
}

function dropWindow(kind: WindowKind): void {
  const w = windows[kind]
  delete windows[kind]
  const wi = w && internals(w.torrent)
  if (!w || !wi) return
  let changed = false
  for (const sel of w.sels) {
    // Already gone if it was fetched whole.
    const i = wi._selections._items.indexOf(sel)
    if (i < 0) continue
    wi._selections._items.splice(i, 1)
    changed = true
  }
  // After the window's own selections are gone, so only the players' streams count as waiting.
  unmarkCritical(wi, w.marked)
  if (changed) wi._updateSelections()
}

/** Playback ended or moved to another file: stop fetching ahead for seeks. */
export function dropWindows(): void {
  windowCalls.seek++
  windowCalls.hover++
  dropWindow('seek')
  dropWindow('hover')
}

/** The torrent is stopping: its selections go with it. */
function forgetWindows(t: WtTorrent): void {
  for (const kind of ['seek', 'hover'] as const) if (windows[kind]?.torrent === t) delete windows[kind]
  if (hurried?.torrent === t) hurried = null
}

/**
 * Put the file's other streams behind a seek: the spot playback left, which mpv
 * drops as soon as its read there returns. One already fetching inside the
 * window keeps its place. Any still there after DEMOTE_MS get their place back.
 * Returns the piece each demoted stream needs next, which its reader waits for.
 */
function demoteOthers(t: WtTorrent, wi: WtInternals, fileIndex: number, from: number, to: number): number[] {
  const f = t.files[fileIndex]
  const first = Math.floor(f.offset / t.pieceLength)
  const last = Math.floor((f.offset + f.length - 1) / t.pieceLength)
  const demoted: { sel: WtSelection; priority: number }[] = []
  const waiting = new Set<number>()
  for (const sel of wi._selections._items) {
    const next = sel.from + sel.offset
    if (!sel.isStreamSelection || sel.priority <= 0 || sel.to < first || sel.from > last) continue
    if (next >= from && next <= to) continue
    demoted.push({ sel, priority: sel.priority })
    sel.priority = 0
    if (!t.bitfield.get(next)) waiting.add(next)
  }
  if (demoted.length === 0) return []
  wi._selections.sort((a, b) => b.priority - a.priority)
  setTimeout(() => {
    const again = internals(t)
    if (!again) return
    let changed = false
    for (const d of demoted) {
      if (d.sel.priority === 0 && again._selections._items.includes(d.sel)) {
        d.sel.priority = d.priority
        changed = true
      }
    }
    if (!changed) return
    again._selections.sort((a, b) => b.priority - a.priority)
    again._updateSelections()
  }, DEMOTE_MS).unref()
  return [...waiting]
}

/** The index of the last cue at or before `seconds` (the first, if none is). */
function lastCueAt(cues: Cue[], seconds: number): number {
  let lo = 0
  let hi = cues.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cues[mid].time <= seconds + 0.001) lo = mid
    else hi = mid - 1
  }
  return lo
}

function havePieces(t: WtTorrent, from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (!t.bitfield.get(i)) return false
  return true
}

/**
 * The keyframes of an mkv being streamed, from its Cues, once the pieces holding
 * them are fetched (mpv reads them when it opens the file). Null until then, or
 * if the file has none. Overlapping calls share one read.
 */
function seekIndex(entry: Entry, fileIndex: number): Promise<Cue[] | null> {
  const key = `${entry.row.info_hash}:${fileIndex}`
  const known = seekIndexes.get(key)
  if (known !== undefined) return Promise.resolve(known)
  let read = seekIndexReads.get(key)
  if (!read) {
    read = readSeekIndex(entry, fileIndex, key).finally(() => seekIndexReads.delete(key))
    seekIndexReads.set(key, read)
  }
  return read
}

async function readSeekIndex(entry: Entry, fileIndex: number, key: string): Promise<Cue[] | null> {
  const t = entry.torrent
  const f = t?.ready ? t.files[fileIndex] : null
  const meta = entry.meta.files[fileIndex]
  if (!t || !f || !meta) return null
  const remember = (cues: Cue[] | null): Cue[] | null => {
    if (seekIndexes.size >= SEEK_INDEXES_KEPT) seekIndexes.delete(seekIndexes.keys().next().value!)
    seekIndexes.set(key, cues)
    cuesAt.delete(key)
    return cues
  }
  if (!/\.(mkv|webm)$/i.test(meta.path)) return remember(null)
  const root = resolve(entry.row.save_path)
  const path = resolve(root, meta.path)
  if (!path.startsWith(root + sep)) return null

  // Fetched pieces are on disk; a part not fetched yet is left for next time.
  const read = async (start: number, length: number): Promise<Buffer | null> => {
    const end = Math.min(f.length, start + length)
    if (end <= start) return null
    const pl = t.pieceLength
    if (!havePieces(t, Math.floor((f.offset + start) / pl), Math.floor((f.offset + end - 1) / pl))) return null
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(end - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
  let where = cuesAt.get(key)
  if (!where) {
    const head = await read(0, HEAD_BYTES)
    if (!head) return null
    const found = mkvCuesAt(head)
    if (!found) return remember(null)
    where = found
    if (cuesAt.size >= SEEK_INDEXES_KEPT) cuesAt.delete(cuesAt.keys().next().value!)
    cuesAt.set(key, where)
  }
  const top = await read(where.at, 16)
  if (!top) return null
  const length = mkvElementLength(top)
  if (length == null || length > CUES_MAX) return remember(null)
  const body = await read(where.at, length)
  if (!body) return null
  const cues = mkvCues(body, where)
  return remember(cues && cues.length > 1 ? cues : null)
}

// ---------------------------------------------------------------------------
// Finding peers. WebTorrent already asks the trackers and the DHT at once when
// a torrent starts, and swaps peer lists (PEX) with every peer it connects to.

/**
 * Well-known public trackers, added to every torrent that isn't private. Nyaa's
 * uploads mostly list nyaa's own tracker and a few of these; the more trackers,
 * the more of the swarm is found in the first seconds.
 */
const PUBLIC_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.dler.org:6969/announce'
]

/** DHT nodes saved at quit, so the next start asks them at once instead of building the table from scratch. */
const DHT_NODES_FILE = 'dht-nodes.json'
const DHT_NODES_KEPT = 300
const DHT_FIRST_SAVE_MS = 2 * 60_000
const DHT_SAVE_EVERY_MS = 15 * 60_000

interface DhtNode {
  host: string
  port: number
}
/** The nodes read at start: kept on the next save behind the live ones, so quitting soon after a start doesn't shrink the list. */
let savedDhtNodes: DhtNode[] = []

function restoreDhtNodes(c: WtClient): void {
  if (!c.dht) return
  try {
    const nodes = JSON.parse(readFileSync(join(app.getPath('userData'), DHT_NODES_FILE), 'utf8')) as unknown
    if (!Array.isArray(nodes)) return
    for (const n of nodes.slice(0, DHT_NODES_KEPT) as { host?: unknown; port?: unknown }[]) {
      // Each is pinged, and joins the table only if it answers.
      if (typeof n?.host === 'string' && Number.isInteger(n.port) && (n.port as number) > 0 && (n.port as number) < 65536) {
        const node = { host: n.host, port: n.port as number }
        savedDhtNodes.push(node)
        c.dht.addNode(node)
      }
    }
  } catch {
    // None saved yet, or unreadable: the DHT bootstraps as usual.
  }
}

function saveDhtNodes(): void {
  if (!client?.dht) return
  try {
    const nodes = new Map<string, DhtNode>()
    for (const n of [...client.dht.toJSON().nodes, ...savedDhtNodes]) {
      if (nodes.size >= DHT_NODES_KEPT) break
      nodes.set(`${n.host}:${n.port}`, { host: n.host, port: n.port })
    }
    if (nodes.size) writeFileSync(join(app.getPath('userData'), DHT_NODES_FILE), JSON.stringify([...nodes.values()]))
  } catch (err) {
    console.error('Failed to save DHT nodes:', err)
  }
}

/** The torrent's name and info-hash. */
export function torrentIdentity(torrentId: number): { name: string; infoHash: string } {
  const { row } = mustGet(torrentId)
  return { name: row.name, infoHash: row.info_hash }
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
  // No more ticks: they'd read the destroyed torrents' emptied file lists, and save their progress as nothing.
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  for (const entry of entries.values()) persistProgress(entry)
  saveDhtNodes()
  shutDown = true
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
  if (entry.torrent?.ready) {
    refreshProgress(entry)
    selectNextFiles(entry, entry.torrent)
  }
  if (entry.row.status !== 'downloading') {
    setStatus(entry, 'downloading')
    if (!entry.torrent) {
      await ensureDir(entry.row.save_path)
      start(entry)
    }
  }
}

/**
 * Ask WebTorrent for the next few GiB of a torrent's kept files, and more as they
 * finish. For every peer with nothing to offer yet, WebTorrent walks all the pieces
 * it was asked for, each time any peer reports a new piece, so asking for a whole
 * batch at once keeps the thread that runs the window busy.
 */
function selectNextFiles(entry: Entry, torrent: WtTorrent): void {
  const state = (entry.fetching ??= { files: new Set(), stalledTicks: 0, widened: 0 })
  const budget = FETCH_AT_ONCE_BYTES * (1 + state.widened)
  let bytes = 0
  for (const i of [...entry.selected].sort((a, b) => a - b)) {
    if (bytes >= budget) break
    const progress = Math.min(entry.fileProgress[i] ?? 0, 1)
    if (progress >= 1) continue
    bytes += entry.meta.files[i].length * (1 - progress)
    if (!state.files.has(i)) {
      state.files.add(i)
      torrent.files[i].select()
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
  // A season's files go under its series folder's name, so a batch of several seasons stays together.
  const folder = getDb()
    .prepare(
      `WITH RECURSIVE up(name, parent_id, franchise_id, depth) AS (
         SELECT f.name, f.parent_id, f.franchise_id, 0 FROM folders f
         WHERE f.id = (SELECT folder_id FROM episodes WHERE torrent_id = ? AND title != '' AND folder_id IS NOT NULL LIMIT 1)
         UNION ALL
         SELECT f.name, f.parent_id, f.franchise_id, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
         WHERE up.franchise_id IS NULL
       )
       SELECT name FROM up ORDER BY franchise_id IS NULL, depth LIMIT 1`
    )
    .get(entry.row.id) as { name: string } | undefined
  const root = getSettings().libraryRoot
  let target = folder ? join(root, safeDirName(folder.name)) : root
  const from = resolve(entry.row.save_path)
  const kept = entry.meta.files.filter((f) => entry.selected.has(f.index))
  // A file already there with this one's name and size is this one, downloaded
  // before and left behind by Remove (keeping the files): use it, as WebTorrent
  // checks its pieces on start. Never write over another release's file.
  const clash = (f: ParsedTorrent['files'][number]): boolean => {
    const size = statSync(resolve(target, f.path), { throwIfNoEntry: false })?.size
    return size != null && size !== f.length
  }
  if (kept.some(clash)) {
    target = join(target, `${safeDirName(entry.meta.name)} (${entry.row.info_hash.slice(0, 8)})`)
  }

  const into = resolve(target)
  for (const f of kept) {
    const src = resolve(from, f.path)
    const dst = resolve(target, f.path)
    // Never touch anything outside the two folders.
    if (!src.startsWith(from + sep) || !dst.startsWith(into + sep)) continue
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
    deselect: true,
    // More trackers than the uploader listed find more of the swarm sooner. A
    // private torrent may only use its own.
    announce: entry.meta.private ? undefined : PUBLIC_TRACKERS
  })
  entry.torrent = torrent
  torrent.on('ready', () => {
    entry.fetching = undefined
    refreshProgress(entry)
    selectNextFiles(entry, torrent)
    if (entry.streamFile != null) torrent.files[entry.streamFile].select()
    if (prefetching?.entry === entry) selectAhead(torrent, prefetching.fileIndex)
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
  forgetWindows(torrent)
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
  // Downloading again (more episodes, or one played that wasn't finished): back in Downloads.
  if (status === 'downloading') setListed(entry, true)
}

function setListed(entry: Entry, listed: boolean): void {
  if ((entry.row.listed === 1) === listed) return
  entry.row.listed = listed ? 1 : 0
  getDb().prepare('UPDATE torrents SET listed = ? WHERE id = ?').run(entry.row.listed, entry.row.id)
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
  const { length, downloaded } = refreshProgress(entry)
  const uploaded = entry.row.uploaded + (entry.torrent?.uploaded ?? 0)
  getDb()
    .prepare('UPDATE torrents SET progress = ?, file_progress = ?, uploaded = ? WHERE id = ?')
    .run(length ? downloaded / length : 0, JSON.stringify(entry.fileProgress), uploaded, entry.row.id)
}

interface PlaybackRow {
  file_index: number
  position_sec: number
  duration_sec: number | null
  watched: number
}

/** Read each file's progress from the running torrent; returns the selected files' totals. */
function refreshProgress(entry: Entry): { length: number; downloaded: number } {
  const active = entry.torrent?.ready && !shutDown ? entry.torrent : null
  if (active) entry.fileProgress = active.files.map((f) => (f.length ? f.downloaded / f.length : 1))
  let length = 0
  let downloaded = 0
  for (const f of entry.meta.files) {
    if (!entry.selected.has(f.index)) continue
    length += f.length
    downloaded += f.length * Math.min(entry.fileProgress[f.index] ?? 0, 1)
  }
  return { length, downloaded }
}

function statusOf(entry: Entry, playback: Map<number, PlaybackRow>): TorrentStatusInfo {
  const { row, meta, torrent } = entry
  const active = torrent?.ready && !shutDown ? torrent : null
  const { length, downloaded } = refreshProgress(entry)

  const files = meta.files.map((f) => {
    const selected = entry.selected.has(f.index)
    const progress = Math.min(entry.fileProgress[f.index] ?? 0, 1)
    const ep = playback.get(f.index)
    return {
      index: f.index,
      path: f.path,
      length: f.length,
      progress,
      selected,
      streamUrl: active?.files[f.index] ? `http://127.0.0.1:${serverPort}${active.files[f.index].streamURL}` : null,
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
    listed: row.listed === 1,
    streaming: isStreaming,
    aheadFile: prefetching?.entry === entry ? prefetching.fileIndex : null,
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
    if (!entry.torrent?.ready) {
      entry.seenComplete = undefined
      entry.fetching = undefined
      continue
    }
    refreshProgress(entry)
    const done = (i: number): boolean => (entry.fileProgress[i] ?? 0) >= 1

    if (entry.row.status === 'downloading') {
      // If the connected peers don't have the files asked for, they may have the ones after.
      if (entry.fetching) {
        const stalled = entry.torrent.numPeers > 0 && entry.torrent.downloadSpeed < STALLED_SPEED
        entry.fetching.stalledTicks = stalled ? entry.fetching.stalledTicks + 1 : 0
        if (entry.fetching.stalledTicks >= STALLED_TICKS) {
          entry.fetching.stalledTicks = 0
          entry.fetching.widened++
        }
      }
      selectNextFiles(entry, entry.torrent)
    }

    // Compare against our own record, not the last progress reading: other callers
    // (the Downloads page) refresh progress between ticks.
    const firstTick = !entry.seenComplete
    entry.seenComplete ??= new Set()
    for (const f of entry.meta.files) {
      const i = f.index
      if (!entry.selected.has(i) || !VIDEO_EXT.test(f.path) || !done(i) || entry.seenComplete.has(i)) continue
      entry.seenComplete.add(i)
      if (!firstTick) for (const cb of fileCompleteListeners) cb(entry.row.id, i)
    }

    const complete = entry.meta.files.every((f) => !entry.selected.has(f.index) || done(f.index))
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

let lastList: TorrentStatusInfo[] | null = null
let lastSent = ''

function broadcast(): void {
  const list = (lastList = listTorrents())
  // Nothing running means nothing changes; don't make the page redraw for it.
  const json = JSON.stringify(list)
  if (json === lastSent) return
  lastSent = json
  // Only the app window; the video host (a child window) shows no page.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.getParentWindow()) win.webContents.send('torrents:update', list)
  }
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
  // The save folder too (a series folder), and empty parents, but never the library folder itself.
  const library = resolve(getSettings().libraryRoot)
  for (let d = root; d.toLowerCase().startsWith(library.toLowerCase() + sep); d = dirname(d)) {
    if (basename(d) === STREAM_DIR || !(await rmdir(d).then(() => true, () => false))) break
  }
}

/**
 * Clear the files of a torrent with downloads that aren't kept: what was
 * streamed, and the pieces of neighbouring episodes that came with it (pieces
 * span file edges). A piece a kept file shares with a neighbour must stay
 * whole, or the kept file counts as incomplete and fetches it again: a
 * neighbour after a kept file is cut down to that piece; one before it is left
 * as is, unless it was streamed (`streamed`), when it goes and that piece is
 * fetched again.
 */
async function clearUnkept(entry: Entry, streamed: number[]): Promise<void> {
  const pl = entry.meta.pieceLength
  if (!pl || isStreamDir(entry.row.save_path)) return
  let offset = 0
  const spans = entry.meta.files.map((f) => {
    const s = { offset, first: Math.floor(offset / pl), last: Math.floor((offset + Math.max(f.length, 1) - 1) / pl) }
    offset += f.length
    return s
  })
  const keptEdges = new Set<number>()
  for (const i of entry.selected) keptEdges.add(spans[i].first).add(spans[i].last)

  const remove: number[] = []
  const cut = new Map<number, number>()
  for (const f of entry.meta.files) {
    if (entry.selected.has(f.index) || f.length === 0) continue
    const s = spans[f.index]
    const head = keptEdges.has(s.first)
    const tail = keptEdges.has(s.last)
    if (s.first === s.last && (head || tail)) continue // all of it is in a shared piece
    if (tail) {
      if (streamed.includes(f.index)) remove.push(f.index)
    } else if (head) {
      cut.set(f.index, (s.first + 1) * pl - s.offset)
    } else {
      remove.push(f.index)
    }
  }
  await deleteFilesOf(entry, remove)
  const root = resolve(entry.row.save_path)
  for (const [i, bytes] of cut) {
    const p = resolve(root, entry.meta.files[i].path)
    if (!p.startsWith(root + sep) || keptByOther(entry, p)) continue
    const size = (await stat(p).catch(() => null))?.size ?? 0
    if (size > bytes) await truncate(p, bytes).catch(() => {})
  }
}

function keptByOther(entry: Entry, path: string): boolean {
  const key = path.toLowerCase()
  for (const other of entries.values()) {
    if (other === entry) continue
    for (const i of other.selected) {
      if (resolve(other.row.save_path, other.meta.files[i].path).toLowerCase() === key) return true
    }
  }
  return false
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

/** Stream folders no torrent uses, e.g. after a torrent was removed mid-stream. The stream cache keeps them until they're the oldest. */
async function removeOrphanStreamDirs(): Promise<void> {
  if (cacheLimit() > 0) return trimStreamCache()
  const root = join(getSettings().libraryRoot, STREAM_DIR)
  const used = new Set([...entries.values()].map((e) => resolve(e.row.save_path).toLowerCase()))
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const p = join(root, name)
    if (/^[0-9a-f]{40}$/i.test(name) && !used.has(resolve(p).toLowerCase())) {
      await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// --- Stream cache -------------------------------------------------------------

/** How much recently streamed data to keep for replay, in bytes; 0 deletes each stream when it ends. */
function cacheLimit(): number {
  return Math.max(0, getSettings().streamCacheGB) * 1024 ** 3
}

let trimming: Promise<void> = Promise.resolve()

/**
 * Delete the least recently streamed folders until the stream folder fits the
 * cache limit. The folder playing or fetched ahead counts, but is never deleted.
 */
export function trimStreamCache(): Promise<void> {
  trimming = trimming.then(async () => {
    const limit = cacheLimit()
    const busy = new Set(
      [streaming, prefetching?.entry].flatMap((e) => (e ? [resolve(e.row.save_path).toLowerCase()] : []))
    )
    const folders = await streamFolders()
    let total = folders.reduce((n, f) => n + f.bytes, 0)
    for (const f of folders.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= limit) break
      const key = resolve(f.path).toLowerCase()
      if (busy.has(key)) continue
      const owner = [...entries.values()].find((e) => resolve(e.row.save_path).toLowerCase() === key)
      if (owner) {
        await withLock(owner, async () => {
          // Started again meanwhile, or kept files are still on their way to the library.
          if (owner.torrent || owner.selected.size > 0) return
          await clearStreamDir(owner)
          persistProgress(owner)
        })
      } else {
        await rm(f.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
      }
      total -= f.bytes
    }
    broadcast()
  }).catch((err) => console.error('Failed to trim the stream cache:', err))
  return trimming
}

/** Bytes in the stream folder: the cache, plus whatever is streaming now. */
export async function streamCacheSize(): Promise<number> {
  return (await streamFolders()).reduce((n, f) => n + f.bytes, 0)
}

async function streamFolders(): Promise<{ path: string; bytes: number; usedAt: number }[]> {
  const root = join(getSettings().libraryRoot, STREAM_DIR)
  const out: { path: string; bytes: number; usedAt: number }[] = []
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{40}$/i.test(name)) continue
    const path = join(root, name)
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory()) out.push({ path, bytes: await folderBytes(path), usedAt: info.mtimeMs })
  }
  return out
}

/** File sizes, not what's fetched: a streamed file takes its full size once its end is written. */
async function folderBytes(dir: string): Promise<number> {
  let n = 0
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name)
    if (d.isDirectory()) n += await folderBytes(p)
    else n += (await stat(p).catch(() => null))?.size ?? 0
  }
  return n
}
