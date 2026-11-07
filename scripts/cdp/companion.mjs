// Usage: start the app with the companion's test settings, then run this:
//   $env:SWARMPLAY_COMPANION_HOST = '127.0.0.1'
//   $env:SWARMPLAY_COMPANION_GRACE_MS = '6000'
//   $env:SWARMPLAY_COMPANION_IDLE_MS = '10000'
//   scripts\cdp\relaunch.ps1
//   node scripts\cdp\companion.mjs
//
// Checks the phone companion end to end. The PC side goes through window.api
// over the DevTools Protocol, as run.mjs does; the phone side is plain HTTP from
// here, as Safari and VLC would send it. Uses the test folder (see lib.js) and
// deletes it near the end, so run cleanup.js afterwards only if this one fails.
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { open } from 'fs/promises'
import http from 'http'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const CDP_PORT = process.env.SWARMPLAY_CDP_PORT ?? '9333'
const PORT = 47819
const BASE = `http://127.0.0.1:${PORT}`
const GRACE_MS = Number(process.env.SWARMPLAY_COMPANION_GRACE_MS ?? 6000)
const IDLE_MS = Number(process.env.SWARMPLAY_COMPANION_IDLE_MS ?? 10000)
const TEST_FOLDER = 'ZZ Stream Test'
const PHONE = 'ZZ Test Phone'
const MiB = 1048576

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
let failed = 0
// Printed as it goes, so a check that hangs shows where.
const note = (...a) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`)
const check = (name, ok, detail) => {
  if (!ok) failed++
  note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return ok
}
const waitFor = async (fn, ms, step = 500) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(step)
  }
}

// --- The PC, over CDP -----------------------------------------------------------

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('/renderer/index.html'))
if (!page) throw new Error(`No Swarmplay renderer on port ${CDP_PORT}; run relaunch.ps1 first`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  const r = msg.result
  if (msg.error) p.reject(new Error(msg.error.message))
  else if (r?.exceptionDetails) p.reject(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  else p.resolve(r?.result?.value)
}
/** Run an async function body in the renderer and return its value. */
const inApp = (body) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { resolve: res, reject: rej })
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true, timeout: 600000 }
      })
    )
  })
const api = (name, ...args) => inApp(`return window.api.${name}(...${JSON.stringify(args)})`)
const libJs = readFileSync(join(here, 'lib.js'), 'utf8')

// --- The phone, over HTTP -------------------------------------------------------

/** One request on its own connection, as VLC opens them. */
function request(method, path, { headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        agent: false,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers }
      },
      (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => {
          const buf = Buffer.concat(chunks)
          let json = null
          try {
            json = JSON.parse(buf.toString('utf8'))
          } catch {
            // not JSON
          }
          res({ status: r.statusCode, headers: r.headers, body: buf, json })
        })
        r.on('error', rej)
      }
    )
    req.on('error', rej)
    req.end(data)
  })
}

let cookie = ''
const phone = {
  get: (path, headers = {}) => request('GET', path, { headers: { Cookie: cookie, ...headers } }),
  post: (path, body = {}, headers = {}) =>
    request('POST', path, { body, headers: { Cookie: cookie, 'X-Swarmplay': '1', ...headers } })
}
const pathOf = (url) => new URL(url).pathname

/** Bytes of a URL (any host) for a Range, for comparing the companion's bytes with WebTorrent's. */
function rangeFrom(url, from, to) {
  return new Promise((res, rej) => {
    http
      .get(url, { agent: false, headers: { Range: `bytes=${from}-${to}` } }, (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }))
        r.on('error', rej)
      })
      .on('error', rej)
  })
}

/**
 * A connection VLC keeps open: reads `want` bytes from `from`, then stops
 * reading, so the server's buffers fill and it sends nothing more.
 */
function hold(path, from, want) {
  return new Promise((res, rej) => {
    let got = 0
    let closed = false
    const req = http.get({ host: '127.0.0.1', port: PORT, path, agent: false, headers: { Range: `bytes=${from}-` } }, (r) => {
      const h = {
        status: r.statusCode,
        get got() {
          return got
        },
        /**
         * Whether the server cut this response off. A paused socket doesn't see
         * the close, so read on: a cut response ends within moments, a live one
         * would run on to the end of the file.
         */
        cut: (ms = 8000) =>
          new Promise((done) => {
            if (closed) return done(true)
            const timer = setTimeout(() => done(false), ms)
            const fin = () => {
              clearTimeout(timer)
              done(true)
            }
            r.once('close', fin)
            r.once('end', fin)
            r.resume()
          }),
        close: () => req.destroy()
      }
      r.on('close', () => (closed = true))
      r.on('error', () => (closed = true))
      if (r.statusCode !== 206 && r.statusCode !== 200) return res(h)
      let resolved = false
      r.on('data', (c) => {
        got += c.length
        if (!resolved && got >= want) {
          resolved = true
          r.pause()
          res(h)
        }
      })
      r.on('end', () => !resolved && res(h))
    })
    req.on('error', (err) => (closed ? null : rej(err)))
    req.on('close', () => (closed = true))
  })
}

const torrentOf = async (torrentId) => (await api('listTorrents')).find((t) => t.id === torrentId)
/** Files left in a folder and its subfolders */
const filesIn = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile())
}
const now = async () => (await phone.get('/api/now')).json

// ================================================================================

const status0 = await api('getCompanion')
note('companion at start:', { enabled: status0.enabled, port: status0.port })
await api('setCompanionEnabled', false)
await api('setCompanionPort', PORT)
let status = await api('setCompanionEnabled', true)
if (!status.running) throw new Error(`The companion didn't start: ${status.error}`)
if (status.addresses[0]?.address !== '127.0.0.1') {
  throw new Error('Start the app with SWARMPLAY_COMPANION_HOST=127.0.0.1 (see the top of this file)')
}
await api('removeAllPhones')
note('companion on at', BASE)

// 1. Unpaired requests -----------------------------------------------------------
{
  const lib = await request('GET', '/api/library')
  check('1 unpaired /api/library is 401', lib.status === 401 && lib.json?.code === 'unpaired', lib.status)
  const nowR = await request('GET', '/api/now')
  check('1 unpaired /api/now is 401', nowR.status === 401, nowR.status)
  const stop = await request('POST', '/api/stop', { body: {}, headers: { 'X-Swarmplay': '1' } })
  check('1 unpaired POST /api/stop is 401', stop.status === 401, stop.status)
  const fake = await request('GET', `/v/1.1.0.${'A'.repeat(43)}/x.mkv`)
  check('1 made-up video token is 401', fake.status === 401, fake.status)
  const junk = await request('GET', '/v/nonsense/x.mkv')
  check('1 malformed video token is 401', junk.status === 401, junk.status)
  const cover = await request('GET', '/cover/1')
  check('1 unpaired cover is 401', cover.status === 401, cover.status)

  const html = await request('GET', '/')
  check(
    '1 page is served with its CSP',
    html.status === 200 &&
      /text\/html/.test(html.headers['content-type']) &&
      /frame-ancestors 'none'/.test(html.headers['content-security-policy'] ?? '') &&
      html.headers['x-content-type-options'] === 'nosniff',
    html.status
  )
  const script = /src="\.?(\/assets\/[^"]+\.js)"/.exec(html.body.toString())?.[1]
  const js = script ? await request('GET', script) : null
  check('1 page script is served', js?.status === 200 && /javascript/.test(js.headers['content-type']), script)
  const pairPage = await request('GET', '/pair')
  check('1 /pair is the page', pairPage.status === 200 && /text\/html/.test(pairPage.headers['content-type']))
  const manifest = await request('GET', '/companion.webmanifest')
  const icon = await request('GET', '/apple-touch-icon.png')
  check('1 manifest and icon are served', manifest.status === 200 && icon.status === 200 && icon.headers['content-type'] === 'image/png')
  const escapes = await Promise.all(
    ['/%2e%2e/main/index.js', '/assets/..%2f..%2fmain%2findex.js', '/index.html', '/assets/../companion.html.map'].map(
      (p) => request('GET', p).then((r) => r.status)
    )
  )
  check('1 nothing else of the app is served', escapes.every((s) => s === 404), escapes)
}

// 2. Host, origin, and the app's own page ---------------------------------------
{
  const evil = await request('GET', '/', { headers: { Host: 'evil.example' } })
  const rebind = await request('GET', '/', { headers: { Host: '127.0.0.1.nip.io' } })
  check('2 a bad Host is 403', evil.status === 403 && rebind.status === 403, [evil.status, rebind.status])
  const good = await Promise.all(
    [`mypc:${PORT}`, `mypc.tail1234.ts.net:${PORT}`, `[::1]:${PORT}`, `mypc.local:${PORT}`].map((h) =>
      request('GET', '/', { headers: { Host: h } }).then((r) => r.status)
    )
  )
  check('2 IPs, the PC name, .local and .ts.net are allowed', good.every((s) => s === 200), good)
  const noHeader = await request('POST', '/api/pair', { body: { code: 'AAAAAAAA' } })
  check('2 POST without X-Swarmplay is 403', noHeader.status === 403, noHeader.status)
  const cross = await request('POST', '/api/pair', {
    body: { code: 'AAAAAAAA' },
    headers: { 'X-Swarmplay': '1', Origin: 'http://evil.example' }
  })
  check('2 cross-origin POST is 403', cross.status === 403 && cross.json?.code !== 'bad-code', cross.status)
  const same = await request('POST', '/api/pair', { body: { code: 'AAAAAAAA' }, headers: { 'X-Swarmplay': '1', Origin: BASE } })
  check('2 same-origin POST gets through to the code check', same.status === 403 && same.json?.code === 'bad-code', same.json)
  const preflight = await request('OPTIONS', '/api/library', {
    headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' }
  })
  check('2 preflight is 403 with no CORS headers', preflight.status === 403 && !preflight.headers['access-control-allow-origin'])
  const fromApp = await inApp(
    `return fetch('${BASE}/api/library').then((r) => 'read ' + r.status, (e) => 'blocked: ' + e.message)`
  )
  check("2 the app's own page can't read the API", fromApp.startsWith('blocked'), fromApp)
}

// 3. Pairing ---------------------------------------------------------------------
let deviceId
{
  let p = await api('pairPhone')
  check(
    '3 pairing code and link',
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(p.code) && p.links[0]?.url === `${BASE}/pair#${p.code}` && p.links[0].qrSvg.startsWith('<svg'),
    p.links.map((l) => l.url)
  )
  const wrong = p.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
  const codes = []
  for (let i = 0; i < 4; i++) codes.push((await phone.post('/api/pair', { code: wrong, name: PHONE })).status)
  const stillThere = (await api('getCompanion')).pairing?.code === p.code
  codes.push((await phone.post('/api/pair', { code: wrong, name: PHONE })).status)
  const voided = (await api('getCompanion')).pairing == null
  check('3 four wrong codes leave the code, the fifth voids it', codes.every((s) => s === 403) && stillThere && voided, codes)
  const late = await phone.post('/api/pair', { code: p.code, name: PHONE })
  check('3 a voided code no longer pairs', late.status === 403, late.status)

  p = await api('pairPhone')
  const typed = `${p.code.slice(0, 4)}-${p.code.slice(4)}`.toLowerCase()
  const ok = await phone.post('/api/pair', { code: typed, name: `${PHONE}\u0000` })
  const setCookie = String(ok.headers['set-cookie'] ?? '')
  check(
    '3 a fresh code, typed with a dash in lower case, pairs and sets the cookie',
    ok.status === 200 && ok.json?.device === PHONE && /sp_device=[\w-]{43};/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=\d+/.test(setCookie),
    setCookie.replace(/sp_device=[\w-]+/, 'sp_device=…')
  )
  cookie = setCookie.split(';')[0]
  const again = await phone.post('/api/pair', { code: p.code, name: 'Second' })
  check('3 a used code fails the second time', again.status === 403, again.status)
  status = await api('getCompanion')
  deviceId = status.devices.find((d) => d.name === PHONE)?.id
  check('3 the PC lists the phone', deviceId != null && status.devices.length === 1 && status.pairing == null, status.devices)
}

// 4. The library -------------------------------------------------------------------
const folder = await inApp(`${libJs}\nreturn (await setup()).folder`)
let lib
{
  lib = (await phone.get('/api/library')).json
  const f = lib?.folders.find((x) => x.name === TEST_FOLDER)
  check('4 /api/library shows the test folder', f != null && lib.device === PHONE, f)
  if (f?.hasCover) {
    const c = await phone.get(`/cover/${f.id}`)
    check('4 its cover comes through the PC', c.status === 200 && /^image\/(jpeg|png|webp|gif|avif)/.test(c.headers['content-type']), c.status)
  }
  const pcLib = await api('getLibrary')
  check(
    '4 same episodes as the PC',
    lib.episodes.filter((e) => e.folderId === folder.id).length === pcLib.episodes.filter((e) => e.folderId === folder.id).length &&
      lib.available.filter((a) => a.folderId === folder.id).length === pcLib.available.filter((a) => a.folderId === folder.id).length
  )
}

// 5. Play, and the video's bytes -----------------------------------------------------
// An episode the PC hasn't played, so its duration has to come from the mkv.
const fresh = lib.episodes.find((e) => e.folderId === folder.id && e.durationSec == null && !e.downloaded)
const release = lib.available.filter((a) => a.folderId === folder.id).sort((a, b) => a.episodeNum - b.episodeNum)[0]
const playBody = fresh ? { torrentId: fresh.torrentId, fileIndex: fresh.fileIndex } : { releaseId: release.id }
note('playing', fresh ? `library episode ${fresh.episodeNum}` : `release of episode ${release.episodeNum}`)
let t = Date.now()
const played = await phone.post('/api/play', playBody)
check('5 /api/play answers once the episode is ready', played.status === 200 && played.json?.url?.startsWith(`${BASE}/v/`), [
  played.status,
  Date.now() - t,
  'ms',
  played.json?.error
])
const { url, vlcUrl } = played.json
check(
  '5 the VLC link streams the URL and names Now playing to come back to',
  vlcUrl ===
    `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}&x-success=${encodeURIComponent(`${BASE}/#now`)}&x-error=${encodeURIComponent(`${BASE}/#now`)}`
)
let n = await now()
const ep = { torrentId: n.session.torrentId, fileIndex: n.session.fileIndex }
const player = await api('getPlayerState')
status = await api('getCompanion')
check('5 the PC player stays closed and the phone owns playback', !player.open && status.session?.deviceName === PHONE && !status.session.starting, status.session)

const head = await request('HEAD', pathOf(url))
const L = Number(head.headers['content-length'])
check(
  '5 HEAD gives the length and ranges',
  head.status === 200 && L > 10 * MiB && head.headers['accept-ranges'] === 'bytes' && head.headers['content-type'] === 'video/x-matroska',
  [head.status, L, head.headers['content-type']]
)
const first = await request('GET', pathOf(url), { headers: { Range: 'bytes=0-65535' } })
check(
  '5 Range 0-65535 is a 206 with the right Content-Range',
  first.status === 206 && first.headers['content-range'] === `bytes 0-65535/${L}` && first.body.length === 65536,
  [first.status, first.headers['content-range'], first.body.length]
)
const mid = Math.floor(L / 2)
const middle = await request('GET', pathOf(url), { headers: { Range: `bytes=${mid}-${mid + 65535}` } })
check('5 a Range from the middle is a 206', middle.status === 206 && middle.body.length === 65536, [middle.status, middle.body.length])
const tor = await torrentOf(ep.torrentId)
const file = tor.files.find((f) => f.index === ep.fileIndex)
const { mkvDuration, mkvTracks } = await import(pathToFileURL(join(repo, 'src/main/companion/mkv.ts')).href)
const HEAD = 256 * 1024
let rawHead, rawMiddle
if (file.streamUrl) {
  rawHead = (await rangeFrom(file.streamUrl, 0, HEAD - 1)).body
  rawMiddle = (await rangeFrom(file.streamUrl, mid, mid + 65535)).body
} else {
  const fh = await open(join(tor.savePath, file.path))
  rawHead = Buffer.alloc(HEAD)
  rawMiddle = Buffer.alloc(65536)
  await fh.read(rawHead, 0, HEAD, 0)
  await fh.read(rawMiddle, 0, 65536, mid)
  await fh.close()
}
{
  // The phone gets the same bytes, but for the tracks' one-byte flags (and the CRC over them).
  const raw = mkvTracks(rawHead)
  const flags = new Set(raw ? raw.tracks.flatMap((t) => [t.defaultAt, t.forcedAt]).filter((at) => at != null) : [])
  if (raw?.crc) for (let i = 0; i < 4; i++) flags.add(raw.crc.at + i)
  const served = await request('GET', pathOf(url), { headers: { Range: `bytes=0-${HEAD - 1}` } })
  const changed = []
  for (let i = 0; i < HEAD; i++) if (served.body[i] !== rawHead[i]) changed.push(i)
  check(
    "5 the bytes match WebTorrent's own stream, but for the tracks' flags",
    first.body.equals(served.body.subarray(0, 65536)) && rawMiddle.equals(middle.body) && changed.every((i) => flags.has(i)),
    `${changed.length} byte(s) changed`
  )
  // A fresh test folder has no remembered tracks, so VLC should get full subtitles in the PC's language (English here).
  const subs = mkvTracks(served.body)?.tracks.filter((t) => t.type === 'sub') ?? []
  const on = subs.filter((t) => t.isDefault || t.forced)
  n = await now()
  check(
    '5 VLC gets the full English subtitles as the default, and the page names them',
    raw && raw.tracks.some((t) => t.type === 'sub') && on.length === 1 && on[0].lang.startsWith('en') && !/sign|song/i.test(on[0].name ?? '') && n.session.subtitles === (on[0].name ?? on[0].lang),
    { raw: raw?.tracks.filter((t) => t.type === 'sub').map((t) => `${t.name}${t.isDefault ? '*' : ''}`), on: on.map((t) => t.name), page: n.session.subtitles }
  )
}
const past = await request('GET', pathOf(url), { headers: { Range: `bytes=${L}-` } })
check('5 a Range past the end is 416', past.status === 416 && past.headers['content-range'] === `bytes */${L}`, past.status)
check('5 the video is no-store and nosniff', first.headers['cache-control'] === 'no-store' && first.headers['x-content-type-options'] === 'nosniff')

// 6. Duration from the mkv, and watched near the end -----------------------------------
n = await now()
const mkvDur = n.session.durationSec
check('6 the duration comes from the mkv', mkvDur > 60 && n.session.durationFrom === 'mkv', [mkvDur, n.session.durationFrom])
{
  // The same parser, run here on the start of the file the PC wrote to disk.
  const fh = await open(join(tor.savePath, file.path))
  const buf = Buffer.alloc(256 * 1024)
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
  await fh.close()
  const d = mkvDuration(buf.subarray(0, bytesRead))
  check('6 mkvDuration on the file agrees', d != null && Math.abs(d - mkvDur) < 0.01, d)
}
{
  const from = Math.floor(L * 0.92)
  t = Date.now()
  const c = await hold(pathOf(url), from, 1.5 * MiB)
  note('read 1.5 MiB at 92% in', Date.now() - t, 'ms')
  const at = await waitFor(async () => {
    const s = (await now()).session
    return s?.positionSec != null && s.positionSec >= mkvDur * 0.9 ? s : null
  }, 30000)
  check('6 the position estimate follows the read', at != null, at && { positionSec: Math.round(at.positionSec), readTo: at.readTo })
  const watched = await waitFor(async () => (await now()).session?.watched, 12000)
  const inLib = (await phone.get('/api/library')).json.episodes.find((e) => e.torrentId === ep.torrentId && e.fileIndex === ep.fileIndex)
  check('6 reading to 92% marks it watched', watched && inLib?.watched === true, inLib && { watched: inLib.watched, positionSec: inLib.positionSec })
  c.close()
}

// 8. Grace, then idle ------------------------------------------------------------------
{
  t = Date.now()
  const ended = await waitFor(async () => (await now()).ended, GRACE_MS + 6000)
  check('8 with no connection, the session ends after the grace', ended?.reason === 'grace', [ended?.reason, Date.now() - t, 'ms'])
  const tr = await waitFor(async () => {
    const x = await torrentOf(ep.torrentId)
    return x && !x.streaming ? x : null
  }, 10000)
  const left = await waitFor(async () => filesIn(tor.savePath).length === 0, 10000)
  check('8 the stream is released and its files deleted', tr != null && left, filesIn(tor.savePath))
  note('after the grace: watched', ended?.watched, '| next', ended?.next)

  // A request with no session starts one again, as VLC reconnecting would.
  t = Date.now()
  const c = await hold(pathOf(url), 0, 256 * 1024)
  check('8 VLC coming back restarts the session', c.status === 206 && (await now()).session != null, c.status)
  const idle = await waitFor(async () => (await now()).ended, IDLE_MS + 6000)
  const idleMs = Date.now() - t
  const cut = await c.cut()
  check('8 a connection left open with nothing read ends as idle', idle?.reason === 'idle' && cut, [idle?.reason, idleMs, 'ms', 'VLC cut off', cut])
  c.close()
}

// 9. The PC takes over -----------------------------------------------------------------
{
  const again = await phone.post('/api/play', ep)
  const c = await hold(pathOf(url), 0, 256 * 1024)
  check('9 the phone plays again', again.status === 200 && c.status === 206 && (await now()).session != null)
  await api('play', ep.torrentId, ep.fileIndex)
  const s = await waitFor(async () => {
    const p = await api('getPlayerState')
    return p.open && p.duration ? p : null
  }, 120000)
  n = await now()
  check(
    '9 Play on the PC ends the phone session',
    s != null && n.session == null && n.ended?.reason === 'takeover' && n.ended.by === 'pc' && n.busy === 'pc',
    n.ended && { reason: n.ended.reason, by: n.ended.by, busy: n.busy }
  )
  check("9 the phone's VLC is cut off", await c.cut())
  check("9 mpv's duration agrees with the mkv's", s && Math.abs(s.duration - mkvDur) < 1, s && [s.duration, mkvDur])
  const v = await request('GET', pathOf(url), { headers: { Range: 'bytes=0-1023' } })
  const still = await api('getPlayerState')
  check('9 a video request then gets 409 and does not take over', v.status === 409 && still.open, v.status)
  c.close()
  await api('playerCommand', { type: 'close' })
  await waitFor(async () => !(await api('getPlayerState')).open, 10000)
  const back = await request('GET', pathOf(url), { headers: { Range: 'bytes=0-1023' } })
  check('9 with the PC stopped, VLC reconnecting is refused', back.status === 410 && (await now()).session == null, back.status)
}

// 12. Stop, on the phone and on the PC: VLC reconnects by itself, and must not start it again
for (const [where, stop] of [
  ['phone', () => phone.post('/api/stop', {})],
  ['PC', () => api('stopPhone')]
]) {
  const again = await phone.post('/api/play', ep)
  const c = await hold(pathOf(url), 0, 256 * 1024)
  await stop()
  const cut = await c.cut()
  c.close()
  const back = await request('GET', pathOf(url), { headers: { Range: 'bytes=0-1023' } })
  n = await now()
  check(
    `12 Stop on the ${where} cuts VLC off, and its reconnect is refused`,
    again.status === 200 && cut && back.status === 410 && n.session == null && n.ended?.reason === 'stop',
    [again.status, cut, back.status, n.ended?.reason]
  )
}

// 7. Deleting the folder while the phone streams -----------------------------------------
{
  const again = await phone.post('/api/play', ep)
  const c = await hold(pathOf(url), 0, 256 * 1024)
  const save = (await torrentOf(ep.torrentId)).savePath
  check('7 the phone plays again', again.status === 200 && c.status === 206)
  let error = null
  await api('deleteFolder', folder.id, true).catch((err) => (error = err.message))
  check('7 deleting the folder works, with no EBUSY', error == null, error)
  n = await now()
  check('7 the session ended first, cutting VLC off', n.session == null && n.ended?.reason === 'removed' && (await c.cut()), n.ended?.reason)
  const gone = await waitFor(async () => filesIn(save).length === 0, 10000)
  const pcLib = await api('getLibrary')
  check('7 nothing is left on disk or in the library', gone && !pcLib.folders.some((f) => f.name === TEST_FOLDER), filesIn(save))
  const v = await request('GET', pathOf(url), { headers: { Range: 'bytes=0-1023' } })
  check("7 the deleted episode's URL is 404", v.status === 404, v.status)
  c.close()
}

// 10. Removing the phone -----------------------------------------------------------------
{
  await api('removePhone', deviceId)
  const l = await phone.get('/api/library')
  const v = await request('GET', pathOf(url))
  check('10 a removed phone gets 401 for its cookie and its URLs', l.status === 401 && v.status === 401, [l.status, v.status])
}

// The global limit on pairing tries ------------------------------------------------------
{
  const p = await api('pairPhone')
  const wrong = p.code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
  const seen = []
  for (let i = 0; i < 25 && seen.at(-1) !== 429; i++) {
    seen.push((await phone.post('/api/pair', { code: wrong })).status)
    if (seen.length % 4 === 0 && (await api('getCompanion')).pairing == null) await api('pairPhone')
  }
  const right = (await api('getCompanion')).pairing?.code ?? (await api('pairPhone')).code
  const blocked = await phone.post('/api/pair', { code: right, name: 'Late' })
  check('limit: past 20 tries in 10 minutes, even the right code is refused', seen.at(-1) === 429 && blocked.status === 429, [
    seen.length,
    'tries in all here',
    blocked.status
  ])
  await api('cancelPairing')
  check('limit: no phone paired along the way', (await api('getCompanion')).devices.length === 0)
}

// 11. Idle cost, and off means closed -------------------------------------------------------
{
  const electron = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe').replace(/'/g, "''")
  const cpu = () =>
    Number(
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq '${electron}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1; (Get-Process -Id $p.ProcessId).TotalProcessorTime.TotalSeconds`
      ])
        .toString()
        .trim()
    )
  const measure = async () => {
    const a = cpu()
    await sleep(10000)
    return cpu() - a
  }
  await sleep(2000)
  const on = await measure()
  await api('setCompanionEnabled', false)
  const off = await measure()
  check('11 the companion idles at about no CPU', on - off < 0.3, `main process over 10 s: ${on.toFixed(2)} s on, ${off.toFixed(2)} s off`)
  const refused = await request('GET', '/').then(
    (r) => `answered ${r.status}`,
    (err) => err.code
  )
  check('11 with it off, the port is closed', refused === 'ECONNREFUSED', refused)
}

// Put the port back as it was, so pairing a real phone on the test profile isn't left on the test port.
await api('setCompanionPort', status0.port)
ws.close()
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
