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
import { endStream, preparePlayback, type PlaybackTarget } from './torrent'

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
}

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
    volume: 100,
    muted: false,
    audioTracks: [],
    subTracks: [],
    hasNext: false,
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

export async function play(torrentId: number, fileIndex: number): Promise<void> {
  const mpv = findMpv()
  if (!mpv) {
    throw new Error(
      app.isPackaged
        ? 'mpv was not found. Reinstall Swarmplay, or set the mpv path in Settings.'
        : 'mpv was not found. Install it (winget install shinchiro.mpv) or set its path in Settings.'
    )
  }

  const target = await preparePlayback(torrentId, fileIndex)
  const start = rememberEpisode(torrentId, fileIndex, target)

  saveCurrent()
  await ensureMpv(mpv)
  current = { torrentId, fileIndex, loaded: false, pos: start, duration: null, lastSaved: Date.now() }

  const ep = describeEpisode(torrentId, fileIndex)
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
    volume: state.volume,
    muted: state.muted,
    upscaler: state.upscaler,
    fullscreen: mainWin?.isFullScreen() ?? false,
    hasNext: nextEpisode(torrentId, fileIndex) != null
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
      return command('set_property', 'aid', cmd.id)
    case 'sub':
      return command('set_property', 'sid', cmd.id ?? 'no')
    case 'next':
      return playNext(false)
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
  const go =
    'releaseId' in next
      ? // A followed series' next episode that isn't in the library yet: add it to stream.
        (setState({ buffering: true }),
        addRelease(next.releaseId, false).then(({ torrentId, fileIndex }) => {
          if (fileIndex == null) throw new Error('that torrent has no video file')
          return play(torrentId, fileIndex)
        }))
      : play(next.torrentId, next.fileIndex)
  go.catch((err) => setState({ buffering: false, error: `Couldn't play the next episode: ${err.message}` }))
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

  const observed = ['time-pos', 'duration', 'pause', 'volume', 'mute', 'track-list', 'paused-for-cache', 'height']
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

function onMessage(msg: MpvMessage): void {
  if (!current) return

  if (msg.event === 'file-loaded') {
    current.loaded = true
    setState({ buffering: false, error: null })
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
        }
        break
      case 'pause':
        setState({ paused: msg.data === true })
        break
      case 'paused-for-cache':
        setState({ buffering: msg.data === true })
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
        const tracks = (Array.isArray(msg.data) ? msg.data : []) as MpvTrack[]
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
