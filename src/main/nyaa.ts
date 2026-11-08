import { XMLParser } from 'fast-xml-parser'
import { VIDEO_EXT, type NyaaResult, type NyaaSearchPage, type NyaaSearchParams, type NyaaSort, type TorrentInfo } from '@shared/types'
import { parseRelease } from './release'
import { parseTorrentFile } from './torrentFile'

const USER_AGENT = 'swarmplay/1.7 (+desktop)'
const TIMEOUT_MS = 15_000

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true
})

/** nyaa's page size, and the most results it will page through. */
export const PAGE_SIZE = 75
const MAX_RESULTS = 1000

const SORT_PARAM: Record<NyaaSort, string> = { date: 'id', seeders: 'seeders', downloads: 'downloads', size: 'size' }

/**
 * Search nyaa. Its search page sorts on the server and pages through up to 1000
 * matches; if that page can't be read (a mirror, or a layout change), fall back
 * to the RSS feed, which ignores sort and page and returns only the newest 75.
 */
export async function searchNyaa(baseUrl: string, params: NyaaSearchParams): Promise<NyaaSearchPage> {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  try {
    const html = await fetchText(searchUrl(baseUrl, params, page))
    const parsed = parseSearchPage(html, baseUrl)
    if (parsed) {
      const { results, total } = parsed
      return { results, page, total, hasMore: page * PAGE_SIZE < Math.min(total, MAX_RESULTS), limited: false }
    }
    console.warn('[nyaa] search page not recognized; using RSS')
  } catch (err) {
    console.warn('[nyaa] search page failed; using RSS:', err instanceof Error ? err.message : err)
  }
  // RSS has one page only, so a later page is empty rather than a repeat.
  const results = page === 1 ? await searchRss(baseUrl, params) : []
  return { results, page, total: results.length, hasMore: false, limited: true }
}

/** Up to `maxPages` pages of a search, one after another, spaced out to go easy on nyaa. */
export async function searchNyaaPages(baseUrl: string, params: NyaaSearchParams, maxPages: number): Promise<NyaaResult[]> {
  const all: NyaaResult[] = []
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, PAGE_GAP_MS))
    const res = await searchNyaa(baseUrl, { ...params, page })
    all.push(...res.results)
    if (!res.hasMore) break
  }
  return all
}

const PAGE_GAP_MS = 1000

function searchUrl(baseUrl: string, params: NyaaSearchParams, page: number): URL {
  const url = new URL('/', baseUrl)
  url.searchParams.set('q', params.query.trim())
  url.searchParams.set('c', params.category)
  url.searchParams.set('f', String(params.filter))
  url.searchParams.set('s', SORT_PARAM[params.sort ?? 'date'])
  url.searchParams.set('o', 'desc')
  if (page > 1) url.searchParams.set('p', String(page))
  return url
}

async function fetchText(url: URL): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`nyaa returned HTTP ${res.status}`)
  return res.text()
}

/**
 * The results table of a search page, or null if the page doesn't look like one,
 * so a changed layout falls back to RSS instead of showing nothing.
 */
export function parseSearchPage(html: string, baseUrl: string): { results: NyaaResult[]; total: number } | null {
  if (/No results found/.test(html) && !/<tbody>/.test(html)) return { results: [], total: 0 }
  const total = Number(html.match(/Displaying results \d+-\d+ out of (\d+) results/)?.[1] ?? NaN)
  const rows = [...html.matchAll(/<tr class="(default|success|danger)">([\s\S]*?)<\/tr>/g)]
  if (!Number.isFinite(total) || (rows.length === 0 && total > 0)) return null
  const results: NyaaResult[] = []
  for (const [, kind, row] of rows) {
    const r = parseRow(kind, row, baseUrl)
    if (!r) return null
    results.push(r)
  }
  return { results, total }
}

function parseRow(kind: string, row: string, baseUrl: string): NyaaResult | null {
  const view = row.match(/<a href="\/view\/(\d+)" title="([^"]*)"/)
  const torrent = row.match(/href="(\/download\/\d+\.torrent)"/)
  const infoHash = row.match(/urn:btih:([0-9a-f]{40})/i)?.[1]
  const time = row.match(/data-timestamp="(\d+)"/)?.[1]
  const size = row.match(/<td class="text-center">([\d.]+ (?:Bytes|[KMGT]iB))<\/td>/)?.[1]
  // Seeders, leechers and completed downloads are the row's last three cells.
  const counts = [...row.matchAll(/<td class="text-center">(\d+)<\/td>/g)].map((m) => Number(m[1])).slice(-3)
  if (!view || !torrent || !infoHash || !time || !size || counts.length !== 3) return null
  const category = row.match(/href="\/\?c=(\d+_\d+)" title="([^"]*)"/)
  const base = new URL('/', baseUrl)
  return {
    id: Number(view[1]),
    title: decodeHtml(view[2]),
    torrentUrl: new URL(torrent[1], base).toString(),
    viewUrl: new URL(`/view/${view[1]}`, base).toString(),
    pubDate: new Date(Number(time) * 1000).toISOString(),
    seeders: counts[0],
    leechers: counts[1],
    downloads: counts[2],
    infoHash: infoHash.toLowerCase(),
    categoryId: category?.[1] ?? '',
    category: decodeHtml(category?.[2] ?? ''),
    size,
    sizeBytes: parseSize(size),
    trusted: kind === 'success',
    remake: kind === 'danger',
    comments: Number(row.match(/class="comments" title="(\d+) comments?"/)?.[1] ?? 0)
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeHtml(s: string): string {
  return decodeNumericEntities(s).replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => NAMED_ENTITIES[n])
}

/** The RSS feed: always the newest ~75 matches, whatever the sort or page. */
async function searchRss(baseUrl: string, params: NyaaSearchParams): Promise<NyaaResult[]> {
  const url = new URL('/', baseUrl)
  url.searchParams.set('page', 'rss')
  url.searchParams.set('q', params.query.trim())
  url.searchParams.set('c', params.category)
  url.searchParams.set('f', String(params.filter))

  const doc = parser.parse(await fetchText(url))
  const raw = doc?.rss?.channel?.item
  const items: Record<string, string>[] = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  return items.map(toResult)
}

function toResult(item: Record<string, string>): NyaaResult {
  const viewUrl = String(item.guid ?? '')
  return {
    id: Number(viewUrl.match(/\/view\/(\d+)/)?.[1] ?? 0),
    title: decodeNumericEntities(String(item.title ?? '')),
    torrentUrl: String(item.link ?? ''),
    viewUrl,
    pubDate: new Date(String(item.pubDate)).toISOString(),
    seeders: Number(item['nyaa:seeders'] ?? 0),
    leechers: Number(item['nyaa:leechers'] ?? 0),
    downloads: Number(item['nyaa:downloads'] ?? 0),
    infoHash: String(item['nyaa:infoHash'] ?? '').toLowerCase(),
    categoryId: String(item['nyaa:categoryId'] ?? ''),
    category: String(item['nyaa:category'] ?? ''),
    size: String(item['nyaa:size'] ?? ''),
    sizeBytes: parseSize(String(item['nyaa:size'] ?? '')),
    trusted: item['nyaa:trusted'] === 'Yes',
    remake: item['nyaa:remake'] === 'Yes',
    comments: Number(item['nyaa:comments'] ?? 0)
  }
}

function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

const UNITS: Record<string, number> = {
  Bytes: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4
}

function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*(\w+)$/)
  return m ? Math.round(Number(m[1]) * (UNITS[m[2]] ?? 1)) : 0
}

/** Far larger than any real .torrent; a bigger answer isn't one. */
const MAX_TORRENT_BYTES = 10 * 1024 * 1024
/** Listing a torrent's files and then adding it fetch the same file; keep recent ones a while. */
const TORRENT_CACHE_MS = 10 * 60_000
const TORRENT_CACHE_SIZE = 20
const torrentCache = new Map<string, { at: number; buf: Promise<Buffer> }>()

/** Download a .torrent file from the configured nyaa host. */
export function fetchTorrentFile(baseUrl: string, torrentUrl: string): Promise<Buffer> {
  const target = new URL(torrentUrl)
  if (target.host !== new URL(baseUrl).host || !target.pathname.endsWith('.torrent')) {
    throw new Error('Only .torrent files from the configured nyaa host can be fetched')
  }
  const key = target.href
  const hit = torrentCache.get(key)
  if (hit && Date.now() - hit.at < TORRENT_CACHE_MS) return hit.buf

  const buf = downloadTorrent(target)
  torrentCache.delete(key)
  torrentCache.set(key, { at: Date.now(), buf })
  while (torrentCache.size > TORRENT_CACHE_SIZE) torrentCache.delete(torrentCache.keys().next().value!)
  // A failed download isn't kept, so the next try fetches again.
  buf.catch(() => torrentCache.get(key)?.buf === buf && torrentCache.delete(key))
  return buf
}

async function downloadTorrent(target: URL): Promise<Buffer> {
  const res = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`nyaa returned HTTP ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX_TORRENT_BYTES) throw new Error('That .torrent file is too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_TORRENT_BYTES) throw new Error('That .torrent file is too large')
  return buf
}

/** List a torrent's files without touching the swarm. */
export async function getTorrentInfo(baseUrl: string, torrentUrl: string): Promise<TorrentInfo> {
  const { infoHash: _, pieceLength: __, ...info } = parseTorrentFile(await fetchTorrentFile(baseUrl, torrentUrl))
  const release = parseRelease(info.name)
  const videos = info.files.filter((f) => VIDEO_EXT.test(f.path)).length
  return { ...info, series: release.series, batch: videos > 1 && release.episode == null }
}
