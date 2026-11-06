import { XMLParser } from 'fast-xml-parser'
import type { NyaaResult, NyaaSearchParams, TorrentInfo } from '@shared/types'
import { parseRelease } from './release'
import { parseTorrentFile } from './torrentFile'

const USER_AGENT = 'swarmplay/0.1 (+desktop)'
const TIMEOUT_MS = 15_000

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true
})

/**
 * Search nyaa through its RSS feed. The feed ignores sort and page params and
 * always returns the newest ~75 matches, so sorting happens in the renderer.
 */
export async function searchNyaa(baseUrl: string, params: NyaaSearchParams): Promise<NyaaResult[]> {
  const url = new URL('/', baseUrl)
  url.searchParams.set('page', 'rss')
  url.searchParams.set('q', params.query.trim())
  url.searchParams.set('c', params.category)
  url.searchParams.set('f', String(params.filter))

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`nyaa returned HTTP ${res.status}`)

  const doc = parser.parse(await res.text())
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

/** Download a .torrent file from the configured nyaa host. */
export async function fetchTorrentFile(baseUrl: string, torrentUrl: string): Promise<Buffer> {
  const target = new URL(torrentUrl)
  if (target.host !== new URL(baseUrl).host || !target.pathname.endsWith('.torrent')) {
    throw new Error('Only .torrent files from the configured nyaa host can be fetched')
  }

  const res = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`nyaa returned HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** List a torrent's files without touching the swarm. */
export async function getTorrentInfo(baseUrl: string, torrentUrl: string): Promise<TorrentInfo> {
  const { infoHash: _, ...info } = parseTorrentFile(await fetchTorrentFile(baseUrl, torrentUrl))
  return { ...info, series: parseRelease(info.name).series }
}
