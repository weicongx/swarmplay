import { readFile } from 'fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { isIP, type Socket } from 'net'
import { hostname } from 'os'
import { extname, join } from 'path'
import type {
  PhoneFolder,
  PhoneLibrary,
  PhonePlayResult,
  PhoneSearchPage,
  PhoneTorrent
} from '@shared/companion'
import { continueWatching } from '@shared/folders'
import { VIDEO_EXT, type NyaaResult } from '@shared/types'
import { getDb, getSettings } from '../db'
import { followSeries } from '../follows'
import { streamToLibrary } from '../batches'
import { addRelease, getLibrary, nextEpisode, suggestFolder } from '../library'
import { getTorrentInfo, searchNyaa } from '../nyaa'
import { setWatched } from '../player'
import { addStream } from '../torrent'
import { companionChanged } from './changed'
import { addDevice, checkVideoToken, deviceByToken, touchDevice, videoToken, type Device } from './devices'
import { isTailscaleIPv4, tailscaleIPv6, usePairingCode } from './pairing'
import {
  endDeviceSession,
  lastEpisodeOf,
  libraryEpisode,
  markedByHand,
  phoneNow,
  playOnPhone,
  serveVideo,
  type VideoLinks
} from './session'

// The phone companion's server: plain node:http, running only while the
// companion is on. It serves the phone page, a short allowlisted API (nothing
// for settings, files, updates or removing torrents), covers, and the video
// bytes for VLC.

const COOKIE = 'sp_device'
const COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60
const MAX_BODY_BYTES = 16 * 1024
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
/** Files from the renderer's public folder the page links to */
const PUBLIC_FILES = new Set(['companion.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'])
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}
const COVERS_KEPT = 50
const COVER_MAX_BYTES = 5 * 1048576
/** Search results the phone may play or follow by id, so it never hands the PC a torrent URL. */
const RESULTS_KEPT = 500

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

const NOT_PAIRED = (): HttpError => new HttpError(401, 'This phone was removed or never paired. Pair it again from Settings on the PC.', 'unpaired')

let server: Server | null = null
/** Listening on IPv6 as well as IPv4 */
let dualStack = false
const sockets = new Set<Socket>()

export function serverRunning(): boolean {
  return server?.listening === true
}

export async function startServer(port: number, host: string): Promise<void> {
  if (server) return
  const srv = createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, err))
  })
  srv.headersTimeout = 20_000
  srv.requestTimeout = 30_000
  srv.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const listen = (on: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, on, () => {
        srv.off('error', reject)
        resolve()
      })
    })
  if (host === '0.0.0.0') {
    // IPv6 as well (dual-stack), for the VLC link over Tailscale; see videoOrigin.
    try {
      await listen('::')
      dualStack = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw err
      await listen(host) // IPv6 is off on this PC
      dualStack = false
    }
  } else {
    await listen(host)
    dualStack = false
  }
  srv.on('error', (err) => console.error('Phone companion server error:', err))
  server = srv
}

export function stopServer(): Promise<void> {
  const srv = server
  server = null
  if (!srv) return Promise.resolve()
  return new Promise((resolve) => {
    srv.close(() => resolve())
    for (const s of sockets) s.destroy()
    sockets.clear()
  })
}

// --- Requests -----------------------------------------------------------------

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy()
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code })
  console.error('Phone companion request failed:', err)
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store'
  })
  res.end(data)
}

/**
 * Names a phone may reach the PC by. Anything else is refused, so a web page
 * whose own domain re-resolves to this PC (DNS rebinding) can't use the API.
 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i.exec(host)
  if (v6) return isIP(v6[1]) === 6
  const m = /^([^:]+)(?::\d{1,5})?$/.exec(host)
  if (!m) return false
  const name = m[1].toLowerCase().replace(/\.$/, '')
  if (isIP(name)) return true
  if (!/^[a-z0-9.-]+$/.test(name)) return false
  // The PC's own name (single label) and localhost; mDNS, home routers, Tailscale's MagicDNS.
  return !name.includes('.') || /\.(local|home\.arpa|ts\.net)$/.test(name)
}

/** A POST from the phone page itself: a cross-site page can't add the header without a preflight, which gets no CORS answer. */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['x-swarmplay'] !== '1') return false
  const origin = req.headers.origin
  if (origin == null) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function clientIp(req: IncomingMessage): string | null {
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? null
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

function authenticate(req: IncomingMessage): Device {
  const token = cookie(req, COOKIE)
  const device = token ? deviceByToken(token) : null
  if (!device) throw NOT_PAIRED()
  if (touchDevice(device.id, clientIp(req))) companionChanged()
  return device
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'That request is too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // falls through
  }
  throw new HttpError(400, 'That request could not be read.')
}

function index(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'That request is missing something.')
  return n
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Not allowed.')
  const method = req.method ?? 'GET'
  // No CORS anywhere: a preflight from another site gets nothing it can use.
  if (method === 'OPTIONS') throw new HttpError(403, 'Not allowed.')
  const url = new URL(req.url ?? '/', 'http://companion.invalid')
  const path = url.pathname

  if (path.startsWith('/v/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Not allowed.')
    // VLC sends no cookies: the token in the path is the credential.
    const ref = checkVideoToken(path.split('/')[2] ?? '')
    if (!ref) throw NOT_PAIRED()
    if (touchDevice(ref.device.id, clientIp(req))) companionChanged()
    return serveVideo(req, res, ref)
  }
  if (path.startsWith('/api/')) return api(req, res, method, path, url.searchParams)
  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Not allowed.')
  if (path.startsWith('/cover/')) {
    authenticate(req)
    return serveCover(res, index(path.slice('/cover/'.length)))
  }
  return serveStatic(res, path)
}

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  query: URLSearchParams
): Promise<void> {
  if (method === 'POST' && !sameOrigin(req)) throw new HttpError(403, 'Not allowed.')
  if (method === 'POST' && path === '/api/pair') return pair(req, res)

  const device = authenticate(req)
  const links = linksFor(req, device)
  const route = `${method} ${path}`
  switch (route) {
    case 'GET /api/library':
      return sendJson(res, 200, phoneLibrary(device))
    case 'GET /api/now':
      return sendJson(res, 200, phoneNow(device.id, links))
    case 'GET /api/search':
      return sendJson(res, 200, await search(query.get('q') ?? '', Number(query.get('page') ?? 1)))
    case 'GET /api/torrent':
      return sendJson(res, 200, await torrent(index(query.get('id'))))
  }
  if (method !== 'POST') throw new HttpError(404, 'Not found.')

  const body = await readJson(req)
  switch (path) {
    case '/api/play':
      return sendJson(res, 200, await play(device, body, links))
    case '/api/next': {
      const last = lastEpisodeOf(device.id)
      const next = last && nextEpisode(last.torrentId, last.fileIndex)
      if (!next) throw new HttpError(404, 'There is no next episode.')
      return sendJson(res, 200, await play(device, next, links))
    }
    case '/api/stop':
      endDeviceSession(device.id, 'stop')
      return sendJson(res, 200, {})
    case '/api/watched': {
      const torrentId = index(body.torrentId)
      const fileIndex = index(body.fileIndex)
      if (!libraryEpisode(torrentId, fileIndex)) throw new HttpError(404, 'That episode is no longer in the library.')
      setWatched(torrentId, fileIndex, body.watched === true)
      markedByHand(torrentId, fileIndex)
      return sendJson(res, 200, {})
    }
    case '/api/follow': {
      const r = cachedResult(index(body.nyaaId))
      const info = await getTorrentInfo(getSettings().nyaaBaseUrl, r.torrentUrl)
      return sendJson(res, 200, await followSeries(r, info.series ? { name: info.series } : undefined))
    }
  }
  throw new HttpError(404, 'Not found.')
}

async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req)
  const result = usePairingCode(typeof body.code === 'string' ? body.code : '')
  // Wrong tries can void the code: Settings stops showing it.
  if (result !== 'ok') companionChanged()
  if (result === 'limited') throw new HttpError(429, 'Too many tries. Wait a few minutes, then make a new code on the PC.', 'limited')
  if (result === 'wrong') throw new HttpError(403, "That code didn't work. Check it, or make a new one on the PC.", 'bad-code')
  const name =
    (typeof body.name === 'string' ? body.name : '')
      .replace(/[\p{C}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'Phone'
  const { device, token } = addDevice(name, clientIp(req))
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`)
  companionChanged()
  sendJson(res, 200, { device: device.name })
}

/** The video's address as the phone reaches the PC (the Host it used), and the VLC link that opens it. */
function linksFor(req: IncomingMessage, device: Device): VideoLinks {
  const origin = `http://${req.headers.host}`
  const video = videoOrigin(req.headers.host ?? '') ?? origin
  return (torrentId, fileIndex, title) => {
    const url = `${video}/v/${videoToken(device.id, torrentId, fileIndex)}/${encodeURIComponent(title)}`
    // The callbacks name Now playing, but VLC for iOS 3.x doesn't call them when an
    // episode ends (tried on an iPhone, 2026-11): you switch back to Safari by hand.
    const back = encodeURIComponent(`${origin}/#now`)
    return {
      url,
      vlcUrl: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}&x-success=${back}&x-error=${back}`
    }
  }
}

/**
 * Where VLC fetches the video when the page came over Tailscale's IPv4: the PC's
 * Tailscale IPv6 address instead. On an IPv6-only mobile network (T-Mobile's, for
 * one) iOS turns an IPv4 address that VLC looks up into a NAT64 address, so VLC's
 * connection goes out over the carrier rather than through Tailscale, and hangs
 * (tried on an iPhone, 2026-11). Safari isn't affected. An IPv6 address isn't
 * rewritten, so it always takes the tunnel.
 */
function videoOrigin(host: string): string | null {
  if (!dualStack) return null
  const m = /^(\d+\.\d+\.\d+\.\d+)(?::(\d{1,5}))?$/.exec(host)
  if (!m || !isTailscaleIPv4(m[1])) return null
  const v6 = tailscaleIPv6()
  return v6 ? `http://[${v6}]${m[2] ? `:${m[2]}` : ''}` : null
}

// --- API ----------------------------------------------------------------------

function phoneLibrary(device: Device): PhoneLibrary {
  const lib = getLibrary()
  const withCover = new Set(
    (getDb().prepare("SELECT id FROM folders WHERE cover_url LIKE 'https://%'").all() as { id: number }[]).map((r) => r.id)
  )
  const counts = new Map<number | null, { episodes: number; watched: number; available: number }>()
  const countOf = (id: number | null): { episodes: number; watched: number; available: number } => {
    let c = counts.get(id)
    if (!c) counts.set(id, (c = { episodes: 0, watched: 0, available: 0 }))
    return c
  }
  for (const e of lib.episodes) {
    const c = countOf(e.folderId)
    c.episodes++
    if (e.watched) c.watched++
  }
  for (const a of lib.available) countOf(a.folderId).available++

  // Folders with nothing to play aren't worth a tile on a phone.
  const folders: PhoneFolder[] = lib.folders
    .filter((f) => counts.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, hasCover: withCover.has(f.id), ...counts.get(f.id)! }))
  if (counts.has(null)) folders.push({ id: null, name: 'Unsorted', hasCover: false, ...counts.get(null)! })

  return {
    device: device.name,
    pc: hostname(),
    folders,
    episodes: lib.episodes.map((e) => ({
      torrentId: e.torrentId,
      fileIndex: e.fileIndex,
      folderId: e.folderId,
      title: e.title,
      episodeNum: e.episodeNum,
      watched: e.watched,
      positionSec: e.positionSec,
      durationSec: e.durationSec,
      downloaded: e.downloaded,
      lastPlayedAt: e.lastPlayedAt
    })),
    available: lib.available.map((a) => ({
      id: a.id,
      folderId: a.folderId,
      episodeNum: a.episodeNum,
      title: a.title,
      sizeBytes: a.sizeBytes,
      seeders: a.seeders
    })),
    continueWatching: continueWatching(lib.episodes).map(({ ep }) => ({ torrentId: ep.torrentId, fileIndex: ep.fileIndex }))
  }
}

const results = new Map<number, NyaaResult>()

function cachedResult(nyaaId: number): NyaaResult {
  const r = results.get(nyaaId)
  if (!r) throw new HttpError(400, 'Search again, then pick the release.')
  return r
}

/** Like the app's search, sorted by seeders. Phone searches stay out of recent searches. */
async function search(q: string, page: number): Promise<PhoneSearchPage> {
  const query = q.trim().slice(0, 200)
  const { nyaaBaseUrl, defaultCategory, defaultFilter } = getSettings()
  const p = await searchNyaa(nyaaBaseUrl, {
    query,
    category: defaultCategory,
    filter: defaultFilter,
    sort: 'seeders',
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 14) : 1
  })
  for (const r of p.results) {
    results.delete(r.id)
    results.set(r.id, r)
  }
  while (results.size > RESULTS_KEPT) results.delete(results.keys().next().value!)
  return {
    page: p.page,
    hasMore: p.hasMore,
    limited: p.limited,
    results: p.results.map((r) => ({
      id: r.id,
      title: r.title,
      size: r.size,
      sizeBytes: r.sizeBytes,
      seeders: r.seeders,
      leechers: r.leechers,
      pubDate: r.pubDate,
      trusted: r.trusted,
      remake: r.remake
    }))
  }
}

async function torrent(nyaaId: number): Promise<PhoneTorrent> {
  const r = cachedResult(nyaaId)
  const info = await getTorrentInfo(getSettings().nyaaBaseUrl, r.torrentUrl)
  const folderName = info.series ? await suggestFolder(info.series).then((s) => s.name, () => info.series) : 'Unsorted'
  return {
    name: info.name,
    series: info.series,
    folderName,
    files: info.files.map((f) => ({ index: f.index, path: f.path, length: f.length, isVideo: VIDEO_EXT.test(f.path) }))
  }
}

/**
 * Start playing on the phone: a library episode, a followed series' release, or
 * a search result's file (which goes in the library to stream, as Stream does on
 * the PC: every video in the torrent, in the series' folder).
 */
async function play(device: Device, body: Record<string, unknown>, links: VideoLinks): Promise<PhonePlayResult> {
  const resolve = async (): Promise<{ torrentId: number; fileIndex: number }> => {
    if (body.releaseId != null) {
      const { torrentId, fileIndex } = await addRelease(index(body.releaseId), false)
      if (fileIndex == null) throw new HttpError(400, 'That torrent has no video file to play.')
      return { torrentId, fileIndex }
    }
    if (body.nyaaId != null) {
      const r = cachedResult(index(body.nyaaId))
      const fileIndex = index(body.fileIndex)
      const info = await getTorrentInfo(getSettings().nyaaBaseUrl, r.torrentUrl)
      const videos = info.files
        .filter((f) => VIDEO_EXT.test(f.path))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      if (!videos.some((f) => f.index === fileIndex)) throw new HttpError(400, "That file isn't a video.")
      const req = { torrentUrl: r.torrentUrl, nyaaId: r.id, fileIndexes: videos.map((f) => f.index), folder: info.series ? { name: info.series } : undefined }
      const { id } = await streamToLibrary(req, (folder) => addStream(req, folder))
      return { torrentId: id, fileIndex }
    }
    const torrentId = index(body.torrentId)
    const fileIndex = index(body.fileIndex)
    if (!libraryEpisode(torrentId, fileIndex)) throw new HttpError(404, 'That episode is no longer in the library.')
    return { torrentId, fileIndex }
  }
  const started = await playOnPhone(device, resolve)
  const { url, vlcUrl } = links(started.torrentId, started.fileIndex, started.title)
  return { url, vlcUrl, title: started.title }
}

// --- Covers and the page ------------------------------------------------------

const covers = new Map<string, { type: string; body: Buffer }>()

/** The folder's AniList cover, fetched by the PC so the phone never contacts AniList. */
async function serveCover(res: ServerResponse, folderId: number): Promise<void> {
  const row = getDb().prepare('SELECT cover_url FROM folders WHERE id = ?').get(folderId) as
    | { cover_url: string | null }
    | undefined
  const url = row?.cover_url
  if (!url?.startsWith('https://')) throw new HttpError(404, 'No cover.')
  let hit = covers.get(url)
  if (hit) covers.delete(url)
  else {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    const type = r?.headers.get('content-type') ?? ''
    // Never SVG: served from this origin, it could run script.
    if (!r?.ok || !/^image\/(jpeg|png|webp|gif|avif)\b/.test(type)) throw new HttpError(502, "Couldn't fetch the cover.")
    const body = Buffer.from(await r.arrayBuffer())
    if (body.length > COVER_MAX_BYTES) throw new HttpError(502, 'The cover is too large.')
    hit = { type, body }
  }
  covers.set(url, hit)
  while (covers.size > COVERS_KEPT) covers.delete(covers.keys().next().value!)
  res.writeHead(200, {
    'Content-Type': hit.type,
    'Content-Length': String(hit.body.length),
    'Cache-Control': 'private, max-age=86400'
  })
  res.end(hit.body)
}

/** The built phone page (out/renderer), which is inside app.asar when packaged. */
async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const file =
    path === '/' || path === '/pair'
      ? 'companion.html'
      : /^\/assets\/[\w.-]+$/.test(path)
        ? path.slice(1)
        : PUBLIC_FILES.has(path.slice(1))
          ? path.slice(1)
          : null
  const body = file ? await readFile(join(__dirname, '../renderer', file)).catch(() => null) : null
  if (!file || !body) throw new HttpError(404, 'Not found.')
  const ext = extname(file)
  const headers: Record<string, string> = {
    'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': String(body.length),
    // Built assets have a hash in their name; the page itself must be fresh after an update.
    'Cache-Control': file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=86400'
  }
  if (ext === '.html') headers['Content-Security-Policy'] = CSP
  res.writeHead(200, headers)
  res.end(body)
}
