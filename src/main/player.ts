import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { connect, type Socket } from 'net'
import { join } from 'path'
import { app, BrowserWindow, screen } from 'electron'
import {
  RESUME_MIN_SEC,
  type PlayerCommand,
  type PlayerState,
  type PlayerTrack,
  type Upscaler,
  type VideoRect
} from '@shared/types'
import { getDb, getSettings, setSettings } from './db'
import { addRelease, describeEpisode, nextEpisode } from './library'
import { endStream, fetchedRanges, prefetch, preparePlayback, streamStats, type PlaybackTarget } from './torrent'

// One mpv instance is reused for every episode, driven over its JSON IPC pipe.
// It renders into a frameless child window ("host") kept on top of the video
// area of the page, so playback looks built into the app while mpv still
// handles every codec and subtitle format. The host ignores the mouse, so
// clicks and keys go to the page underneath, which sends commands here.
const PIPE = `\\\\.\\pipe\\swarmplay-mpv-${process.pid}`
const SAVE_EVERY_MS = 5_000
const BROADCAST_EVERY_MS = 250
/** Past this fraction of the runtime an episode counts as watched. */
const WATCHED_AT = 0.9
/** Past this fraction of the runtime, or once the ending starts, the next episode starts loading... */
const PREFETCH_AT = 0.85
/** ...as long as this much of the current one is buffered, so the two don't compete. */
const PREFETCH_BUFFERED_SEC = 30

// Chapter names releases use for the opening and the ending.
const OPENING_CHAPTER = /\b(op|opening|intro)\b/i
const ENDING_CHAPTER = /\b(ed|ending|credits|outro)\b/i

/** Longer than this, a chapter named like an opening is more likely a cold open or the episode itself. */
const SKIPPABLE_SEC = 200

// Anime4K's recommended high-quality preset ("Mode A") for 1080p and lower sources,
// in the order its authors specify. The shaders ship in resources/shaders/anime4k.
const ANIME4K_MODE_A = [
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_VL.glsl',
  'Anime4K_Upscale_CNN_x2_VL.glsl',
  'Anime4K_AutoDownscalePre_x2.glsl',
  'Anime4K_AutoDownscalePre_x4.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl'
]

interface NowPlaying {
  torrentId: number
  fileIndex: number
  /** False until mpv reports the file loaded, so events from the previous file are ignored. */
  loaded: boolean
  pos: number
  duration: number | null
  lastSaved: number
  /** Playing a complete file from disk, so there's nothing to buffer */
  local: boolean
  /** The next episode has started loading */
  aheadStarted: boolean
  /** The episode's series, whose track choices apply */
  folderId: number | null
  /** The series' track choices have been applied to this file */
  tracksApplied: boolean
}

/** A track as remembered for a series: matched by language, then by name, in its other episodes. */
interface TrackPick {
  lang: string | null
  title: string | null
}

interface TrackPrefs {
  audio?: TrackPick
  /** null: subtitles off */
  sub?: TrackPick | null
}

interface Chapter {
  title: string
  time: number
}

/** mpv's read-ahead for the current file: buffered up to `end` seconds, or to the end of the file. */
let cache = { end: 0, eof: false }
let chapters: Chapter[] = []
/** Chapters already offered for skipping (or skipped), so each is handled once per episode. */
let skipOffered = new Set<number>()
/** mpv isn't advancing playback: paused, seeking, or waiting for data. */
let coreIdle = true
/** mpv's track list for the current file */
let tracks: MpvTrack[] = []

/** Buffering this long, or this long without peers, suggests trying another release. */
const SLOW_AFTER_MS = 15_000
let statsTimer: NodeJS.Timeout | null = null
let bufferingSince: number | null = null
let noPeersSince: number | null = null

let proc: ChildProcess | null = null
let sock: Socket | null = null
let current: NowPlaying | null = null
let mainWin: BrowserWindow | null = null
let host: BrowserWindow | null = null
let videoRect: VideoRect | null = null
/** Height of the current video in pixels, once mpv reports it */
let videoHeight: number | null = null

const state: PlayerState = blankState()
let broadcastTimer: NodeJS.Timeout | null = null
/**
 * Bumped by every play and close. A start that waits (for a torrent's metadata,
 * or for a release to be added) gives up if another start or a close came meanwhile.
 */
let playSeq = 0

function blankState(): PlayerState {
  return {
    open: false,
    torrentId: null,
    fileIndex: null,
    title: '',
    series: null,
    episodeLabel: null,
    timePos: 0,
    duration: null,
    paused: false,
    buffering: false,
    downloadSpeed: 0,
    numPeers: 0,
    slow: false,
    skip: null,
    local: false,
    fetched: [],
    volume: 100,
    muted: false,
    audioTracks: [],
    subTracks: [],
    hasNext: false,
    continued: false,
    fullscreen: false,
    upscaler: 'off',
    error: null
  }
}

/** Call once the main window exists; the video host is attached to it. */
export function attachPlayerWindow(win: BrowserWindow): void {
  mainWin = win
  const reposition = (): void => placeHost()
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as 'move', reposition)
  }
  win.on('enter-full-screen', () => setState({ fullscreen: true }))
  win.on('leave-full-screen', () => setState({ fullscreen: false }))
  // Hidden to the tray: stop rather than keep playing invisibly.
  win.on('hide', () => state.open && closePlayer())
  win.on('closed', () => {
    host?.destroy()
    host = null
    mainWin = null
  })
}

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
    ...(env.PATH ?? '').split(';').filter(Boolean).map((dir) => join(dir, 'mpv.exe')),
    // The installer's own copy, used when there's no system mpv.
    ...(app.isPackaged ? [join(process.resourcesPath, 'mpv', 'mpv.exe')] : [])
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * `startAt` overrides where playback would resume, e.g. when switching releases
 * mid-episode. `continued` marks a start the user didn't ask for (autoplay, a
 * release switch), which keeps the player's view as it is.
 */
export async function play(torrentId: number, fileIndex: number, startAt?: number, continued = false): Promise<void> {
  const mpv = findMpv()
  if (!mpv) {
    throw new Error(
      app.isPackaged
        ? 'mpv was not found. Reinstall Swarmplay, or set the mpv path in Settings.'
        : 'mpv was not found. Install it (winget install shinchiro.mpv) or set its path in Settings.'
    )
  }

  const seq = ++playSeq
  const target = await preparePlayback(torrentId, fileIndex)
  if (seq !== playSeq) return
  const resumeAt = rememberEpisode(torrentId, fileIndex, target)
  const start = startAt != null ? Math.max(0, Math.floor(startAt)) : resumeAt

  saveCurrent()
  await ensureMpv(mpv)
  if (seq !== playSeq) return
  const ep = describeEpisode(torrentId, fileIndex)
  current = {
    torrentId,
    fileIndex,
    loaded: false,
    pos: start,
    duration: null,
    lastSaved: Date.now(),
    local: target.source === target.localPath,
    aheadStarted: false,
    folderId: ep.folderId,
    tracksApplied: false
  }
  tracks = []
  cache = { end: 0, eof: false }
  chapters = []
  coreIdle = true
  skipOffered = new Set()
  bufferingSince = null
  noPeersSince = null
  statsTimer ??= setInterval(pollStats, 1000)

  setState({
    ...blankState(),
    open: true,
    torrentId,
    fileIndex,
    title: target.title,
    series: ep.folderName,
    episodeLabel: ep.label,
    timePos: start,
    buffering: true,
    local: current.local,
    fetched: current.local ? [[0, 1]] : [],
    volume: state.volume,
    muted: state.muted,
    upscaler: state.upscaler,
    fullscreen: mainWin?.isFullScreen() ?? false,
    hasNext: nextEpisode(torrentId, fileIndex) != null,
    continued
  })
  videoHeight = null
  mainWin?.show()

  // `start` is a global option, so set it before every load.
  command('set_property', 'start', start > 0 ? String(start) : 'none')
  command('set_property', 'force-media-title', target.title)
  command('set_property', 'pause', false)
  command('loadfile', target.source, 'replace')
}

export function playerCommand(cmd: PlayerCommand): void {
  switch (cmd.type) {
    case 'toggle-pause':
      return command('cycle', 'pause')
    case 'seek':
      return command('seek', Math.max(0, cmd.seconds), 'absolute')
    case 'seek-by':
      return command('seek', cmd.seconds, 'relative')
    case 'volume':
      return command('set_property', 'volume', Math.min(130, Math.max(0, cmd.value)))
    case 'toggle-mute':
      return command('cycle', 'mute')
    case 'audio':
      rememberTrack('audio', cmd.id)
      return command('set_property', 'aid', cmd.id)
    case 'sub':
      rememberTrack('sub', cmd.id)
      return command('set_property', 'sid', cmd.id ?? 'no')
    case 'next':
      return playNext(false)
    case 'skip-chapter':
      return skipChapter()
    case 'close':
      return closePlayer()
    case 'fullscreen':
      return mainWin?.setFullScreen(cmd.on ?? !mainWin.isFullScreen())
    case 'upscaler':
      setSettings({ upscaler: cmd.mode })
      return applyUpscaler(cmd.mode)
  }
}

/** Whether RTX Video Super Resolution could be available (it needs an NVIDIA GPU). */
export async function hasNvidiaGpu(): Promise<boolean> {
  const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number }[] }
  return (info.gpuDevice ?? []).some((d) => d.vendorId === 0x10de)
}

export function getPlayerState(): PlayerState {
  return state
}

/** The page reports where the video goes; null when the player isn't on screen. */
export function setVideoBounds(rect: VideoRect | null): void {
  videoRect = rect
  placeHost()
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

/** Stop playback if it's from this torrent, e.g. before deleting its files. */
export function closeIfPlaying(torrentId: number): void {
  if (state.open && state.torrentId === torrentId) closePlayer()
}

// ---------------------------------------------------------------------------

function closePlayer(): void {
  playSeq++
  saveCurrent()
  current = null
  command('stop')
  // Streamed data is deleted once mpv lets go of it (the delete retries if it's still busy).
  endStream().catch((err) => console.error('Failed to clean up a stream:', err))
  if (mainWin?.isFullScreen()) mainWin.setFullScreen(false)
  setState({ ...blankState(), volume: state.volume, muted: state.muted, upscaler: state.upscaler })
  placeHost()
}

/**
 * Switch upscaling live, without restarting playback. Both methods are cleared
 * first so only one ever runs.
 */
function applyUpscaler(mode: Upscaler): void {
  command('change-list', 'glsl-shaders', 'clr', '')
  command('vf', 'remove', '@upscale') // harmless error reply if it isn't there

  if (mode === 'anime4k') {
    command('set_property', 'hwdec', 'auto-safe')
    command('change-list', 'glsl-shaders', 'set', ANIME4K_MODE_A.map((f) => join(shaderDir(), f)).join(';'))
  } else if (mode === 'rtx') {
    // RTX VSR runs in the driver's D3D11 video processor, so decoded frames must
    // stay on the GPU as D3D11 textures. Scale to the screen, not a fixed 4K.
    command('set_property', 'hwdec', 'd3d11va')
    const scale = rtxScale()
    if (scale) command('vf', 'add', `@upscale:d3d11vpp=scale=${scale}:scaling-mode=nvidia`)
  } else {
    command('set_property', 'hwdec', 'auto-safe')
  }
  setState({ upscaler: mode })
}

/** How much to enlarge the video to fill the screen it's on; null if it already does. */
function rtxScale(): number | null {
  if (!mainWin || !videoHeight) return null
  const display = screen.getDisplayMatching(mainWin.getBounds())
  const screenHeight = display.size.height * display.scaleFactor
  const scale = Math.min(4, Math.round((screenHeight / videoHeight) * 100) / 100)
  return scale > 1.05 ? scale : null
}

/** mpv is a separate program and can't read inside app.asar, so point it at the unpacked copy. */
function shaderDir(): string {
  return join(app.getAppPath(), 'resources', 'shaders', 'anime4k').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

function playNext(onlyIfFinished: boolean): void {
  const ended = current
  if (!ended) return
  const finished = ended.duration != null && ended.pos >= ended.duration * WATCHED_AT
  const next =
    (!onlyIfFinished || (finished && getSettings().autoplayNext)) && nextEpisode(ended.torrentId, ended.fileIndex)
  if (!next) {
    if (onlyIfFinished) closePlayer()
    return
  }
  // Stopping, or picking another episode, while this one is starting cancels it.
  const seq = ++playSeq
  const go =
    'releaseId' in next
      ? // A followed series' next episode that isn't in the library yet: add it to stream.
        (setState({ buffering: true }),
        addRelease(next.releaseId, false).then(({ torrentId, fileIndex }) => {
          if (seq !== playSeq) return
          if (fileIndex == null) throw new Error('that torrent has no video file')
          return play(torrentId, fileIndex, undefined, onlyIfFinished)
        }))
      : play(next.torrentId, next.fileIndex, undefined, onlyIfFinished)
  go.catch((err) => {
    if (seq + 1 >= playSeq) setState({ buffering: false, error: `Couldn't play the next episode: ${err.message}` })
  })
}

/** Once a second: the torrent's speed and peers, and whether the stream looks stuck. */
function pollStats(): void {
  const c = current
  if (!c || !state.open) return
  const now = Date.now()
  const s = c.local ? { downloadSpeed: 0, numPeers: 0, complete: true } : streamStats(c.torrentId, c.fileIndex)
  bufferingSince = state.buffering && !state.error ? (bufferingSince ?? now) : null
  noPeersSince = s.numPeers === 0 && !s.complete && !cache.eof ? (noPeersSince ?? now) : null
  const stuck = (since: number | null): boolean => since != null && now - since >= SLOW_AFTER_MS
  setState(
    {
      downloadSpeed: s.downloadSpeed,
      numPeers: s.numPeers,
      slow: !c.local && (stuck(bufferingSince) || stuck(noPeersSince)),
      fetched: c.local ? [[0, 1]] : fetchedRanges(c.torrentId, c.fileIndex)
    },
    false
  )
  // Fullscreen may have hidden the bars, so say it over the video too.
  if (state.fullscreen && !c.local && bufferingSince != null && now - bufferingSince >= 1000) {
    const peers = `${s.numPeers} peer${s.numPeers === 1 ? '' : 's'}`
    command('show-text', `Buffering… ↓ ${(s.downloadSpeed / 1048576).toFixed(1)} MiB/s · ${peers}`, 1500)
  }
}

/** Index of the chapter playing at `pos`, or -1 before the first one. */
/** The opening or ending chapter at index `i`, if it's short enough to be one. */
function skippable(i: number): PlayerState['skip'] {
  const c = chapters[i]
  if (!c) return null
  const kind = OPENING_CHAPTER.test(c.title) ? 'opening' : ENDING_CHAPTER.test(c.title) ? 'ending' : null
  const to = chapters[i + 1]?.time ?? null
  const end = to ?? current?.duration ?? null
  if (!kind || end == null || end - c.time > SKIPPABLE_SEC) return null
  return { kind, to }
}

/** Offer to skip the chapter playing now, or skip it right away if the settings say so. */
function updateSkip(pos: number): void {
  const i = chapterAt(pos)
  const skip = skippable(i)
  if (skip?.kind !== state.skip?.kind || skip?.to !== state.skip?.to) setState({ skip })
  if (!skip || skipOffered.has(i)) return
  skipOffered.add(i)
  const { autoSkip } = getSettings()
  if (autoSkip === 'both' || (autoSkip === 'openings' && skip.kind === 'opening')) {
    skipChapter()
    command('show-text', `Skipped the ${skip.kind}`, 2000)
  } else if (state.fullscreen) {
    command('show-text', `${skip.kind === 'opening' ? 'Opening' : 'Ending'} · press S to skip`, 4000)
  }
}

/** To the next chapter; an ending with nothing after it skips to the end, which plays the next episode. */
function skipChapter(): void {
  const skip = state.skip
  if (!skip) return
  if (skip.to != null) command('seek', skip.to, 'absolute')
  else command('seek', 100, 'absolute-percent')
}

function chapterAt(pos: number): number {
  let i = -1
  while (i + 1 < chapters.length && chapters[i + 1].time <= pos + 0.25) i++
  return i
}

/**
 * Near the end of an episode, start fetching the next one so autoplay (or
 * Next) starts at once. Waits until the current one is well buffered, so it
 * never takes bandwidth the playing episode still needs.
 */
function maybePrefetch(): void {
  const c = current
  if (!c?.loaded || c.aheadStarted || !c.duration) return
  const inEnding = ENDING_CHAPTER.test(chapters[chapterAt(c.pos)]?.title ?? '')
  if (c.pos < c.duration * PREFETCH_AT && !inEnding) return
  if (!c.local && !cache.eof && cache.end - c.pos < PREFETCH_BUFFERED_SEC) return
  c.aheadStarted = true

  const next = nextEpisode(c.torrentId, c.fileIndex)
  if (!next) return
  // A followed series' episode not in the library yet is added to stream first.
  const target = 'releaseId' in next ? addRelease(next.releaseId, false) : Promise.resolve(next)
  target
    .then(({ torrentId, fileIndex }) => {
      if (current === c && fileIndex != null) return prefetch(torrentId, fileIndex)
    })
    .catch((err) => console.error('Failed to load the next episode early:', err))
}

function setState(patch: Partial<PlayerState>, immediate = true): void {
  Object.assign(state, patch)
  if (immediate) {
    if (broadcastTimer) clearTimeout(broadcastTimer)
    broadcastTimer = null
    broadcast()
  } else if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      broadcast()
    }, BROADCAST_EVERY_MS)
  }
}

function broadcast(): void {
  mainWin?.webContents.send('player:state', state)
}

function ensureHost(): BrowserWindow | null {
  if (host && !host.isDestroyed()) return host
  if (!mainWin) return null
  host = new BrowserWindow({
    parent: mainWin,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    backgroundColor: '#000000'
  })
  // Mouse input would otherwise land on the host's empty page, never reaching mpv
  // or the app; let it fall through to the player page underneath.
  host.setIgnoreMouseEvents(true)
  host.on('closed', () => (host = null))
  return host
}

/** Keep the video window exactly over the page's video area. */
function placeHost(): void {
  const h = host && !host.isDestroyed() ? host : null
  if (!h) return
  if (!mainWin || !state.open || !videoRect || !mainWin.isVisible() || mainWin.isMinimized()) {
    if (h.isVisible()) h.hide()
    return
  }
  const cb = mainWin.getContentBounds()
  const zoom = mainWin.webContents.getZoomFactor()
  h.setBounds({
    x: Math.round(cb.x + videoRect.x * zoom),
    y: Math.round(cb.y + videoRect.y * zoom),
    width: Math.max(1, Math.round(videoRect.width * zoom)),
    height: Math.max(1, Math.round(videoRect.height * zoom))
  })
  if (!h.isVisible()) h.showInactive()
}

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
  if (proc && sock && !sock.destroyed && host && !host.isDestroyed()) return
  proc?.kill()

  const h = ensureHost()
  if (!h) throw new Error('The app window is not ready')
  const hwnd = h.getNativeWindowHandle().readBigUInt64LE(0).toString()

  const child = spawn(
    mpvPath,
    [
      `--wid=${hwnd}`,
      `--input-ipc-server=${PIPE}`,
      '--osc=no', // the app draws the controls
      '--input-default-bindings=no', // and handles all input
      '--input-vo-keyboard=no',
      '--idle=yes', // stay open between episodes so autoplay reuses it
      '--force-window=yes', // keep a black frame up while the stream buffers
      '--keep-open=no',
      '--hwdec=auto-safe',
      '--network-timeout=120' // torrents can take a while to find the first pieces
    ],
    { stdio: 'ignore' }
  )
  proc = child
  child.on('exit', () => {
    if (proc !== child) return
    saveCurrent()
    proc = null
    sock?.destroy()
    sock = null
    current = null
    if (state.open) setState({ ...blankState(), error: null })
    placeHost()
    endStream().catch(() => {})
  })

  sock = await connectWithRetry()
  let buffered = ''
  // Decode as a stream, so a character split across two chunks stays whole.
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buffered += chunk
    let nl: number
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim()) onMessage(JSON.parse(line))
    }
  })
  sock.on('error', () => {})

  const observed = [
    'time-pos',
    'duration',
    'pause',
    'volume',
    'mute',
    'track-list',
    'core-idle',
    'height',
    'demuxer-cache-state',
    'chapter-list'
  ]
  observed.forEach((name, i) => command('observe_property', i + 1, name))
  applyUpscaler(getSettings().upscaler)
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
  file_error?: string
}

interface MpvTrack {
  id: number
  type: 'video' | 'audio' | 'sub'
  title?: string
  lang?: string
  codec?: string
  selected?: boolean
}

/**
 * Waiting for data, once the file is open. paused-for-cache alone misses the wait
 * for the first frames (and after a seek), which is when a dead upload shows.
 */
function updateBuffering(): void {
  if (current?.loaded) setState({ buffering: coreIdle && !state.paused })
}

function onMessage(msg: MpvMessage): void {
  if (!current) return

  if (msg.event === 'file-loaded') {
    current.loaded = true
    setState({ error: null })
    updateBuffering()
    applyTrackPrefs()
  } else if (msg.event === 'property-change') {
    switch (msg.name) {
      // duration can be reported just before file-loaded, and only changes once per file.
      case 'duration':
        if (typeof msg.data === 'number') {
          current.duration = msg.data
          setState({ duration: msg.data })
        }
        break
      case 'time-pos':
        if (typeof msg.data === 'number' && current.loaded) {
          current.pos = msg.data
          setState({ timePos: msg.data }, false)
          if (Date.now() - current.lastSaved > SAVE_EVERY_MS) saveCurrent()
          maybePrefetch()
          updateSkip(msg.data)
        }
        break
      case 'demuxer-cache-state': {
        const s = (msg.data ?? {}) as { 'cache-end'?: number; 'eof-cached'?: boolean }
        cache = { end: typeof s['cache-end'] === 'number' ? s['cache-end'] : 0, eof: s['eof-cached'] === true }
        break
      }
      case 'chapter-list':
        chapters = (Array.isArray(msg.data) ? (msg.data as { title?: string; time?: number }[]) : [])
          .filter((c) => typeof c.time === 'number')
          .map((c) => ({ title: c.title ?? '', time: c.time! }))
        updateSkip(current.pos)
        break
      case 'pause':
        setState({ paused: msg.data === true })
        updateBuffering()
        break
      case 'core-idle':
        coreIdle = msg.data === true
        updateBuffering()
        break
      case 'volume':
        if (typeof msg.data === 'number') setState({ volume: msg.data })
        break
      case 'mute':
        setState({ muted: msg.data === true })
        break
      case 'height':
        // RTX scaling depends on the video's size, so redo it when a new one loads.
        if (typeof msg.data === 'number' && msg.data !== videoHeight) {
          videoHeight = msg.data
          if (state.upscaler === 'rtx') applyUpscaler('rtx')
        }
        break
      case 'track-list': {
        tracks = (Array.isArray(msg.data) ? msg.data : []) as MpvTrack[]
        applyTrackPrefs()
        const toTrack = (t: MpvTrack): PlayerTrack => ({
          id: t.id,
          title: t.title ?? null,
          lang: t.lang ?? null,
          codec: t.codec ?? null,
          selected: t.selected === true
        })
        setState({
          audioTracks: tracks.filter((t) => t.type === 'audio').map(toTrack),
          subTracks: tracks.filter((t) => t.type === 'sub').map(toTrack)
        })
        break
      }
    }
  } else if (msg.event === 'end-file') {
    if (msg.reason === 'eof' && current.loaded) {
      saveCurrent()
      playNext(true)
    } else if (msg.reason === 'error') {
      setState({ buffering: false, error: `Couldn't play this file${msg.file_error ? `: ${msg.file_error}` : ''}` })
    }
  }
}

function readTrackPrefs(folderId: number): TrackPrefs {
  const row = getDb().prepare('SELECT track_prefs FROM folders WHERE id = ?').get(folderId) as
    | { track_prefs: string | null }
    | undefined
  try {
    return row?.track_prefs ? (JSON.parse(row.track_prefs) as TrackPrefs) : {}
  } catch {
    return {}
  }
}

/** Save a track picked in the player as the series' choice for its other episodes. */
function rememberTrack(type: 'audio' | 'sub', id: number | null): void {
  if (current?.folderId == null) return
  const t = id == null ? null : tracks.find((x) => x.type === type && x.id === id)
  if (t === undefined) return
  const pick = t && { lang: t.lang?.toLowerCase() ?? null, title: t.title ?? null }
  const prefs = { ...readTrackPrefs(current.folderId), [type]: pick }
  getDb().prepare('UPDATE folders SET track_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), current.folderId)
}

/**
 * Once per file, when its tracks are known: select the series' remembered audio
 * and subtitles. A track counts as the same if its language matches (and, between
 * several, its name); without a language, only its name can match. Nothing
 * matching leaves mpv's own choice.
 */
function applyTrackPrefs(): void {
  if (!current?.loaded || current.tracksApplied || current.folderId == null || tracks.length === 0) return
  current.tracksApplied = true
  const prefs = readTrackPrefs(current.folderId)
  const pick = (type: 'audio' | 'sub', want: TrackPick): MpvTrack | undefined => {
    const name = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
    const score = (t: MpvTrack): number =>
      want.lang
        ? t.lang?.toLowerCase() === want.lang
          ? 2 + (name(t.title) === name(want.title) ? 1 : 0)
          : 0
        : want.title && name(t.title) === name(want.title)
          ? 1
          : 0
    return tracks
      .filter((t) => t.type === type && score(t) > 0)
      .sort((a, b) => score(b) - score(a) || Number(b.selected === true) - Number(a.selected === true))[0]
  }
  if (prefs.audio) {
    const t = pick('audio', prefs.audio)
    if (t && !t.selected) command('set_property', 'aid', t.id)
  }
  if (prefs.sub === null) {
    if (tracks.some((t) => t.type === 'sub' && t.selected)) command('set_property', 'sid', 'no')
  } else if (prefs.sub) {
    const t = pick('sub', prefs.sub)
    if (t && !t.selected) command('set_property', 'sid', t.id)
  }
}
