import { createReadStream } from 'fs'
import { open } from 'fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import { extname } from 'path'
import { Transform, pipeline, type Readable } from 'stream'
import { app, powerSaveBlocker } from 'electron'
import type { CompanionSessionInfo, PhoneEndReason, PhoneNow, PhoneSession } from '@shared/companion'
import { getDb } from '../db'
import { addRelease, describeEpisode, nextEpisode } from '../library'
import { activePlayback, registerPlayer, takeOver } from '../playback'
import {
  PREFETCH_AT,
  SAVE_EVERY_MS,
  WATCHED_AT,
  readTrackPrefs,
  rememberEpisode,
  savePosition,
  type TrackPick,
  type TrackPrefs
} from '../player'
import { endStream, fetchedRanges, hurryFrom, prefetch, preparePlayback, streamStats, type PlaybackTarget } from '../torrent'
import { companionChanged } from './changed'
import type { Device } from './devices'
import { defaultTrackPatches, mkvDuration, mkvTracks, type MkvTrack, type Patch } from './mkv'

// A phone's playback. VLC on the phone fetches the episode over HTTP; this is the
// PC's side of it: getting the episode ready, serving its bytes, guessing where
// VLC is from what it reads, and ending once VLC has gone. At most one session,
// and only while nothing else plays (see playback.ts).

/** No open connection this long: VLC was closed. Covers the gap a seek leaves between connections. */
const GRACE_MS = devMs('SWARMPLAY_COMPANION_GRACE_MS', 3 * 60_000)
/** Connections open but nothing read this long: VLC paused and the phone put away. */
const IDLE_MS = devMs('SWARMPLAY_COMPANION_IDLE_MS', 30 * 60_000)
/** A read starting this far into the file that stays short is VLC reading the mkv index (Cues), not playing. */
const TAIL_FROM = 0.97
const TAIL_MAX_BYTES = 16 * 1048576
/** Until VLC has read this much in one go, the saved position stands (it may only be probing the file). */
const STEADY_BYTES = 1048576
/** The mkv header (duration, tracks) is in the first few tens of KB; this leaves room for many subtitle tracks. */
const HEAD_BYTES = 256 * 1024
const HEAD_TIMEOUT_MS = 120_000

function devMs(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return !app.isPackaged && Number.isFinite(v) && v > 0 ? v : fallback
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** One response to VLC */
interface Conn {
  /** Byte offset it started at */
  start: number
  sent: number
  openedAt: number
  destroy: () => void
}

interface Session {
  device: Device
  torrentId: number
  fileIndex: number
  title: string
  /** Settles once the episode can be served */
  ready: Promise<void>
  /** null while still getting ready */
  target: PlaybackTarget | null
  local: boolean
  lastOpenAt: number
  lastByteAt: number
  /** Open responses */
  conns: Set<Conn>
  /** How far VLC has read where it's playing, in bytes */
  playhead: number
  /** VLC has read enough in one go for the playhead to mean something */
  steady: boolean
  duration: number | null
  durationFrom: 'library' | 'mkv' | null
  /** Where the episode was saved at before this play */
  resumeSec: number
  lastSaved: number
  /** Marked watched or unwatched by hand: the estimate stops saving */
  manual: boolean
  aheadStarted: boolean
  probe: AbortController | null
  /** Settles once the header has been read and `patches` set; never rejects */
  header: Promise<void>
  /** Changes to the header's bytes, so VLC starts with the series' tracks */
  patches: Patch[]
  /** The subtitles VLC starts with, when Swarmplay set them */
  subtitles: string | null
  blocker: number | null
}

type Ended = Omit<NonNullable<PhoneNow['ended']>, 'watched' | 'next'>

let session: Session | null = null
/** Bumped by every start, so one still resolving its episode gives way to a newer one. */
let startSeq = 0
/** How each phone's last playback ended, until it plays again */
const ended = new Map<number, Ended>()
let timer: NodeJS.Timeout | null = null

registerPlayer({
  kind: 'phone',
  current: () =>
    session && {
      owner: { kind: 'phone', deviceId: session.device.id },
      torrentId: session.torrentId,
      fileIndex: session.fileIndex,
      local: session.local
    },
  // Only the PC takes over from a phone this way; another phone ends it itself.
  stop: (reason) => endSession(reason, reason === 'takeover' ? 'pc' : null)
})

export function libraryEpisode(torrentId: number, fileIndex: number): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM episodes WHERE torrent_id = ? AND file_index = ? AND title != ''")
    .get(torrentId, fileIndex)
}

/**
 * Play on a phone: the explicit Play, so it takes over from the PC or another
 * phone. `resolve` finds the episode, adding it to the library first if need be.
 */
export async function playOnPhone(
  device: Device,
  resolve: () => Promise<{ torrentId: number; fileIndex: number }>
): Promise<{ torrentId: number; fileIndex: number; title: string }> {
  const seq = ++startSeq
  const ep = await resolve()
  if (seq !== startSeq) throw new Error('Another episode was started meanwhile.')
  const s = begin(device, ep.torrentId, ep.fileIndex)
  await s.ready
  return { torrentId: s.torrentId, fileIndex: s.fileIndex, title: s.title }
}

function begin(device: Device, torrentId: number, fileIndex: number): Session {
  startSeq++
  takeOver('phone')
  // Another phone, or this one on another episode. Its stream is left to this start.
  if (session) endSession('takeover', 'phone')
  const row = getDb().prepare('SELECT title FROM episodes WHERE torrent_id = ? AND file_index = ?').get(torrentId, fileIndex) as
    | { title: string }
    | undefined
  const now = Date.now()
  const s: Session = {
    device,
    torrentId,
    fileIndex,
    title: row?.title ?? '',
    ready: Promise.resolve(),
    target: null,
    local: false,
    lastOpenAt: now,
    lastByteAt: now,
    conns: new Set(),
    playhead: 0,
    steady: false,
    duration: null,
    durationFrom: null,
    resumeSec: 0,
    lastSaved: now,
    manual: false,
    aheadStarted: false,
    probe: null,
    header: Promise.resolve(),
    patches: [],
    subtitles: null,
    blocker: null
  }
  session = s
  ended.delete(device.id)
  timer ??= setInterval(tick, 1000)
  s.ready = prepare(s)
  s.ready.catch(() => {}) // whoever started it reports the error
  companionChanged()
  return s
}

async function prepare(s: Session): Promise<void> {
  try {
    const target = await preparePlayback(s.torrentId, s.fileIndex)
    if (session !== s) {
      // Stopped or taken over while getting ready. A takeover's own start deals
      // with the stream; with nothing playing, nobody else will.
      if (!activePlayback()) void endStream().catch(() => {})
      throw new Error('Playback was stopped before it started.')
    }
    s.resumeSec = rememberEpisode(s.torrentId, s.fileIndex, target)
    s.target = target
    s.title = target.title
    s.local = target.source === target.localPath
    s.lastOpenAt = s.lastByteAt = s.lastSaved = Date.now()
    // Nothing on the PC looks busy while a phone watches, so keep it from sleeping.
    s.blocker = powerSaveBlocker.start('prevent-app-suspension')
    readHeader(s)
    companionChanged()
  } catch (err) {
    if (session === s) endSession('error', null, message(err))
    throw err
  }
}

/**
 * End the session: save where it got to, cut VLC off (so the files can be
 * deleted), and drop the stream as stopping on the PC would. A takeover's own
 * start deals with the stream, and on quit index.ts does.
 */
function endSession(reason: PhoneEndReason, by: 'pc' | 'phone' | null = null, error: string | null = null): void {
  const s = session
  if (!s) return
  session = null
  if (s.target) {
    estimate(s)
    save(s)
  }
  for (const c of s.conns) c.destroy()
  s.conns.clear()
  s.probe?.abort()
  if (s.blocker != null) powerSaveBlocker.stop(s.blocker)
  if (timer) clearInterval(timer)
  timer = null
  ended.set(s.device.id, { reason, by, error, torrentId: s.torrentId, fileIndex: s.fileIndex, title: s.title })
  if (reason !== 'takeover' && reason !== 'quit') {
    endStream().catch((err) => console.error('Failed to clean up a stream:', err))
  }
  companionChanged()
}

/** End whatever a phone is playing: Stop on the PC, turning the companion off, quitting. */
export function endPhoneSession(reason: 'stop' | 'quit'): void {
  endSession(reason)
}

/** End a device's session, if it has one: its Stop, or its removal. */
export function endDeviceSession(deviceId: number, reason: 'stop' | 'removed'): void {
  if (session?.device.id === deviceId) endSession(reason)
}

export function forgetDevice(deviceId: number): void {
  ended.delete(deviceId)
}

/** The episode a device played last: the one playing, or the one that ended. */
export function lastEpisodeOf(deviceId: number): { torrentId: number; fileIndex: number } | null {
  if (session?.device.id === deviceId) return { torrentId: session.torrentId, fileIndex: session.fileIndex }
  const e = ended.get(deviceId)
  return e ? { torrentId: e.torrentId, fileIndex: e.fileIndex } : null
}

/** Marked watched or unwatched by hand: if it's the session's episode, stop overwriting that with the estimate. */
export function markedByHand(torrentId: number, fileIndex: number): void {
  if (session?.torrentId === torrentId && session.fileIndex === fileIndex) session.manual = true
}

// --- Duration, position, watched --------------------------------------------

/**
 * Read the mkv header in the background: the duration, unless the PC's earlier
 * play knows it, and the tracks. VLC's first request waits for this (see
 * serveVideo), so the header it gets already has the tracks set.
 */
function readHeader(s: Session): void {
  const target = s.target
  if (!target) return
  const row = getDb()
    .prepare('SELECT duration_sec FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(s.torrentId, s.fileIndex) as { duration_sec: number | null } | undefined
  if (row?.duration_sec) {
    s.duration = row.duration_sec
    s.durationFrom = 'library'
  }
  if (!/\.(mkv|webm)$/i.test(target.localPath)) return
  const ctrl = new AbortController()
  s.probe = ctrl
  s.header = readHead(target, AbortSignal.any([ctrl.signal, AbortSignal.timeout(HEAD_TIMEOUT_MS)]))
    .then((buf) => {
      if (session !== s) return
      const d = s.duration == null ? mkvDuration(buf) : null
      if (d) {
        s.duration = d
        s.durationFrom = 'mkv'
      }
      setTracks(s, buf)
    })
    .catch(() => {})
    .finally(() => {
      if (s.probe === ctrl) s.probe = null
    })
}

// --- Tracks -------------------------------------------------------------------
// VLC starts with the tracks a file marks as default, and many releases mark no
// subtitles. The PC player remembers each series' audio and subtitles; for the
// phone, the header VLC gets marks those as the defaults instead.

/** Start VLC with the tracks the PC player would pick: the series' choices, else subtitles in the PC's language. */
function setTracks(s: Session, head: Buffer): void {
  const info = mkvTracks(head)
  if (!info) return
  const row = getDb()
    .prepare('SELECT folder_id FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(s.torrentId, s.fileIndex) as { folder_id: number | null } | undefined
  const prefs = row?.folder_id != null ? readTrackPrefs(row.folder_id) : {}
  const want = chooseTracks(info.tracks, prefs, app.getPreferredSystemLanguages()[0] ?? app.getLocale())
  const result = defaultTrackPatches(head, info, want)
  s.patches = result.patches
  const sub = result.sub && want.sub != null ? info.tracks.find((t) => t.number === want.sub) : undefined
  s.subtitles = sub ? (sub.name ?? sub.lang) : null
}

function canonicalLang(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0].toLowerCase() // "jpn" and "ja" alike
  } catch {
    return tag.toLowerCase()
  }
}

const baseLang = (tag: string): string => canonicalLang(tag).split('-')[0]

/** A remembered track, matched as the PC player does (player.ts): by language, then name; or by name alone. */
function matchTrack(tracks: MkvTrack[], want: TrackPick): MkvTrack | undefined {
  const name = (s: string | null): string => (s ?? '').trim().toLowerCase()
  const score = (t: MkvTrack): number =>
    want.lang
      ? canonicalLang(t.lang) === canonicalLang(want.lang)
        ? 2 + (name(t.name) === name(want.title) ? 1 : 0)
        : 0
      : want.title && name(t.name) === name(want.title)
        ? 1
        : 0
  return tracks
    .filter((t) => score(t) > 0)
    .sort((a, b) => score(b) - score(a) || Number(b.isDefault) - Number(a.isDefault))[0]
}

function chooseTracks(tracks: MkvTrack[], prefs: TrackPrefs, ownLang: string): { audio?: number; sub?: number | null } {
  const audio = tracks.filter((t) => t.type === 'audio')
  const subs = tracks.filter((t) => t.type === 'sub')
  const want: { audio?: number; sub?: number | null } = {}
  if (prefs.audio) want.audio = matchTrack(audio, prefs.audio)?.number
  if (prefs.sub === null) want.sub = null
  else if (prefs.sub) want.sub = matchTrack(subs, prefs.sub)?.number
  else {
    // Never picked for this series: full subtitles in the PC's language, unless the audio is in it already.
    const heard = audio.find((t) => t.number === want.audio) ?? audio.find((t) => t.isDefault) ?? audio[0]
    if (!heard || baseLang(heard.lang) !== baseLang(ownLang)) {
      const full = subs.filter(
        (t) => baseLang(t.lang) === baseLang(ownLang) && !t.forced && !/sign|song|forced|commentary/i.test(t.name ?? '')
      )
      want.sub = (full.find((t) => !/\bcc\b|sdh|hearing/i.test(t.name ?? '')) ?? full[0])?.number
    }
  }
  return want
}

async function readHead(target: PlaybackTarget, signal: AbortSignal): Promise<Buffer> {
  const n = Math.min(HEAD_BYTES, target.length)
  if (n <= 0) return Buffer.alloc(0)
  if (target.source === target.localPath) {
    const fh = await open(target.localPath, 'r')
    try {
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
  return new Promise((resolve, reject) => {
    const req = http.get(target.source, { headers: { Range: `bytes=0-${n - 1}` }, signal }, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`The stream answered ${res.statusCode}`))
      }
      const chunks: Buffer[] = []
      let got = 0
      const done = (): void => resolve(Buffer.concat(chunks).subarray(0, n))
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        got += c.length
        if (got >= n) res.destroy()
      })
      res.on('end', done)
      res.on('close', done)
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

/** The response VLC is playing from: the one open longest, leaving out short reads near the end. */
function mainConn(s: Session): Conn | null {
  const length = s.target?.length ?? 0
  let best: Conn | null = null
  for (const c of s.conns) {
    if (c.start >= length * TAIL_FROM && c.sent < TAIL_MAX_BYTES) continue
    if (!best || c.openedAt < best.openedAt) best = c
  }
  return best
}

function estimate(s: Session, c = mainConn(s)): void {
  if (!c || !s.target) return
  s.playhead = Math.min(s.target.length, c.start + c.sent)
  if (c.sent >= STEADY_BYTES) s.steady = true
}

/** Save the estimate as the PC saves mpv's position. With no duration, only watched can be told. */
function save(s: Session): void {
  s.lastSaved = Date.now()
  if (s.manual || !s.steady || !s.target?.length) return
  const fraction = Math.min(1, s.playhead / s.target.length)
  if (s.duration) savePosition(s.torrentId, s.fileIndex, fraction * s.duration, s.duration)
  else if (fraction >= WATCHED_AT) {
    getDb()
      .prepare('UPDATE episodes SET watched = 1, position_sec = 0 WHERE torrent_id = ? AND file_index = ?')
      .run(s.torrentId, s.fileIndex)
  }
}

/** Near the end, start fetching the next episode, as the PC does. */
function maybePrefetch(s: Session): void {
  if (s.aheadStarted || !s.target || s.playhead < s.target.length * PREFETCH_AT) return
  s.aheadStarted = true
  const next = nextEpisode(s.torrentId, s.fileIndex)
  if (!next) return
  const target = 'releaseId' in next ? addRelease(next.releaseId, false) : Promise.resolve(next)
  target
    .then(({ torrentId, fileIndex }) => {
      if (session === s && fileIndex != null) return prefetch(torrentId, fileIndex)
    })
    .catch((err) => console.error('Failed to load the next episode early:', err))
}

/** Once a second, only while there's a session. */
function tick(): void {
  const s = session
  if (!s?.target) return
  const now = Date.now()
  estimate(s)
  if (s.conns.size > 0) s.lastOpenAt = now
  else if (now - s.lastOpenAt >= GRACE_MS) return endSession('grace')
  if (s.conns.size > 0 && now - s.lastByteAt >= IDLE_MS) return endSession('idle')
  if (now - s.lastSaved >= SAVE_EVERY_MS) save(s)
  maybePrefetch(s)
}

// --- Serving the video -------------------------------------------------------

const VIDEO_TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv'
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return void res.destroy()
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** A single `bytes=` range; null to send the whole file, 'invalid' for a 416. */
function parseRange(header: string | undefined, length: number): { start: number; end: number } | null | 'invalid' {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    return n > 0 && length > 0 ? { start: Math.max(0, length - n), end: length - 1 } : 'invalid'
  }
  const start = Number(m[1])
  const end = m[2] === '' ? length - 1 : Math.min(Number(m[2]), length - 1)
  return start < length && start <= end ? { start, end } : 'invalid'
}

/** A range of the stream, from WebTorrent's own server on 127.0.0.1. */
function openUpstream(url: string, start: number, end: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Range: `bytes=${start}-${end}` } }, (up) => {
      if (up.statusCode !== 206) {
        up.resume()
        return reject(new Error(`The stream answered ${up.statusCode}`))
      }
      resolve(up)
    })
    req.on('error', reject)
  })
}

/**
 * Bytes of a device's episode for VLC. A request for the session's episode is
 * served; with no session (it ended after a grace or idle), it starts one again,
 * but only if nothing else is playing: a phone left running never takes playback
 * from the PC. Taking over always needs Play on the page.
 *
 * VLC reconnects by itself when it's cut off, so an episode that was stopped (or
 * taken over, or failed) is refused until Play on the page starts it again.
 */
export async function serveVideo(
  req: IncomingMessage,
  res: ServerResponse,
  ref: { device: Device; torrentId: number; fileIndex: number }
): Promise<void> {
  let s = session
  const mine = s?.device.id === ref.device.id && s.torrentId === ref.torrentId && s.fileIndex === ref.fileIndex
  if (!mine) {
    if (s || activePlayback()) return sendText(res, 409, 'Something else is playing. Tap Play on the Swarmplay page to take over.')
    if (!libraryEpisode(ref.torrentId, ref.fileIndex)) return sendText(res, 404, 'That episode is no longer in the library.')
    const last = ended.get(ref.device.id)
    if (
      last &&
      last.torrentId === ref.torrentId &&
      last.fileIndex === ref.fileIndex &&
      last.reason !== 'grace' &&
      last.reason !== 'idle'
    ) {
      return sendText(res, 410, 'Stopped. Tap Play on the Swarmplay page to watch it again.')
    }
    s = begin(ref.device, ref.torrentId, ref.fileIndex)
  }
  const live = s!
  try {
    await live.ready
  } catch (err) {
    return sendText(res, 503, message(err))
  }
  if (session !== live || !live.target) return sendText(res, 409, 'Playback moved on.')
  const target = live.target

  const range = parseRange(req.headers.range, target.length)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${target.length}` })
    return void res.end()
  }
  const start = range?.start ?? 0
  const end = range?.end ?? target.length - 1
  const headers: Record<string, string> = {
    'Content-Type': VIDEO_TYPES[extname(target.title).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(target.title)}`,
    'Cache-Control': 'no-store'
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${target.length}`
  const status = range ? 206 : 200
  if (req.method === 'HEAD' || target.length === 0) {
    res.writeHead(status, headers)
    return void res.end()
  }
  // The header goes out with the tracks set.
  if (start < HEAD_BYTES) {
    await live.header
    if (session !== live) return sendText(res, 409, 'Playback moved on.')
  }
  const patches = live.patches.filter((p) => p.at >= start && p.at <= end)

  // A read from further in is VLC seeking: faster peers may take the first pieces over from slow ones.
  if (!live.local && start > 0) hurryFrom(live.torrentId, live.fileIndex, start)
  let source: Readable
  try {
    source = live.local ? createReadStream(target.localPath, { start, end }) : await openUpstream(target.source, start, end)
  } catch (err) {
    return sendText(res, 502, message(err))
  }
  if (session !== live || res.destroyed) return void source.destroy()

  const c: Conn = { start, sent: 0, openedAt: Date.now(), destroy: () => res.destroy() }
  live.conns.add(c)
  live.lastOpenAt = live.lastByteAt = Date.now()
  res.on('close', () => {
    source.destroy()
    if (!live.conns.has(c)) return
    if (session === live && mainConn(live) === c) estimate(live, c)
    live.conns.delete(c)
    live.lastOpenAt = Date.now()
  })
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const from = start + c.sent
      let out = chunk
      for (const p of patches) {
        const i = p.at - from
        if (i < 0 || i >= chunk.length) continue
        if (out === chunk) out = Buffer.from(chunk)
        out[i] = p.byte
      }
      c.sent += chunk.length
      live.lastByteAt = Date.now()
      cb(null, out)
    }
  })
  res.writeHead(status, headers)
  pipeline(source, count, res, () => {})
}

// --- What the phone and the PC show ------------------------------------------

function nextLabel(torrentId: number, fileIndex: number): { label: string } | null {
  const next = nextEpisode(torrentId, fileIndex)
  if (!next) return null
  if ('releaseId' in next) {
    const r = getDb().prepare('SELECT episode_num FROM releases WHERE id = ?').get(next.releaseId) as
      | { episode_num: number }
      | undefined
    return { label: r ? `Episode ${r.episode_num}` : 'Next episode' }
  }
  return { label: describeEpisode(next.torrentId, next.fileIndex).label }
}

/** "Episode 3"; a file name says nothing the title doesn't. */
const numbered = (label: string): string | null => (/^Episode /.test(label) ? label : null)

export type VideoLinks = (torrentId: number, fileIndex: number, title: string) => { url: string; vlcUrl: string }

function describe(s: Session, links: VideoLinks): PhoneSession {
  const t = s.target
  const ep = describeEpisode(s.torrentId, s.fileIndex)
  const readTo = t?.length ? Math.min(1, s.playhead / t.length) : 0
  const fetched: [number, number][] = !t ? [] : s.local ? [[0, 1]] : fetchedRanges(s.torrentId, s.fileIndex)
  const around = fetched.find(([from, to]) => from <= readTo + 0.001 && to >= readTo)
  const stats = t && !s.local ? streamStats(s.torrentId, s.fileIndex) : { downloadSpeed: 0, numPeers: 0 }
  const link = t ? links(s.torrentId, s.fileIndex, s.title) : null
  return {
    torrentId: s.torrentId,
    fileIndex: s.fileIndex,
    title: s.title,
    series: ep.folderName,
    episodeLabel: numbered(ep.label),
    starting: !t,
    local: s.local,
    url: link?.url ?? null,
    vlcUrl: link?.vlcUrl ?? null,
    numPeers: stats.numPeers,
    downloadSpeed: stats.downloadSpeed,
    fetched,
    readTo,
    ahead: around ? Math.max(0, around[1] - readTo) : 0,
    positionSec: s.duration && s.steady ? readTo * s.duration : null,
    durationSec: s.duration,
    durationFrom: s.durationFrom,
    resumeSec: s.resumeSec,
    subtitles: s.subtitles,
    connections: s.conns.size,
    watched: isWatched(s.torrentId, s.fileIndex),
    next: nextLabel(s.torrentId, s.fileIndex)
  }
}

function isWatched(torrentId: number, fileIndex: number): boolean {
  const row = getDb()
    .prepare('SELECT watched FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(torrentId, fileIndex) as { watched: number } | undefined
  return row?.watched === 1
}

/** /api/now for a device */
export function phoneNow(deviceId: number, links: VideoLinks): PhoneNow {
  const s = session?.device.id === deviceId ? session : null
  const active = activePlayback()
  const e = s ? undefined : ended.get(deviceId)
  return {
    session: s && describe(s, links),
    ended: e ? { ...e, watched: isWatched(e.torrentId, e.fileIndex), next: nextLabel(e.torrentId, e.fileIndex) } : null,
    busy: active && !s ? active.owner.kind : null
  }
}

/** The phone's playback, for the PC's tray, banner and Settings */
export function phoneSessionInfo(): CompanionSessionInfo | null {
  const s = session
  if (!s) return null
  const ep = describeEpisode(s.torrentId, s.fileIndex)
  return {
    deviceId: s.device.id,
    deviceName: s.device.name,
    title: s.title,
    series: ep.folderName,
    episodeLabel: numbered(ep.label),
    starting: !s.target
  }
}
