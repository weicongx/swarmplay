import { folderKey, splitSeason } from '@shared/folders'
import type { AniListMedia } from '@shared/types'
import { getDb } from './db'

const ENDPOINT = 'https://graphql.anilist.co'
const CACHE_MS = 7 * 24 * 3600_000
// AniList allows 30 requests a minute right now; stay under it.
const MIN_GAP_MS = 2_100

const QUERY = `query ($s: String) {
  Page(perPage: 10) {
    media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
      id
      title { romaji english }
      synonyms
      format
      seasonYear
      episodes
      coverImage { large color }
    }
  }
}`

interface RawMedia {
  id: number
  title: { romaji: string; english: string | null }
  synonyms: string[]
  format: string | null
  seasonYear: number | null
  episodes: number | null
  coverImage: { large: string | null; color: string | null }
}

/** A search result plus every name it goes by, for matching. */
export interface Candidate {
  media: AniListMedia
  titles: string[]
}

let queue: Promise<unknown> = Promise.resolve()
let lastRequest = 0
/** Recent results by id, so linking a result the user just picked needs no extra request. */
const seen = new Map<number, Candidate>()

export function recentCandidate(id: number): Candidate | undefined {
  return seen.get(id)
}

export async function searchAniList(query: string): Promise<Candidate[]> {
  const q = query.trim()
  if (!q) return []
  const db = getDb()
  const cached = db.prepare('SELECT json, fetched_at FROM anilist_cache WHERE query = ?').get(q.toLowerCase()) as
    | { json: string; fetched_at: number }
    | undefined
  if (cached && Date.now() - cached.fetched_at < CACHE_MS) return toCandidates(JSON.parse(cached.json))

  // Serialize requests so bursts (auto-linking a whole library) respect the rate limit.
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequest = Date.now()
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { s: q } }),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 429) throw new Error('AniList rate limit reached; try again in a minute')
    if (!res.ok) throw new Error(`AniList returned HTTP ${res.status}`)
    const body = (await res.json()) as { data?: { Page?: { media?: RawMedia[] } } }
    return body.data?.Page?.media ?? []
  })
  queue = run.catch(() => {})
  const media = await run

  db.prepare(
    'INSERT INTO anilist_cache (query, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at'
  ).run(q.toLowerCase(), JSON.stringify(media), Date.now())
  return toCandidates(media)
}

/**
 * The AniList entry for a series name like "Sousou no Frieren S2", or null.
 * Only an exact title match for the same season counts, so covers are never
 * guessed; anything less certain is left for the user to link by hand.
 */
export async function findSeries(series: string): Promise<Candidate | null> {
  const { base, season } = splitSeason(series)
  // Some groups write "Romaji (English)"; try each part.
  const names = [base, base.replace(/\s*\([^)]*\)\s*/g, ' ').trim(), ...[...base.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])]
  const keys = new Set(names.map(folderKey).filter(Boolean))

  const candidates = await searchAniList(names[1] || base)
  let best: { c: Candidate; score: number } | null = null
  for (const c of candidates) {
    const exact = c.titles.some((t) => {
      const s = splitSeason(t)
      return s.season === season && keys.has(folderKey(s.base))
    })
    if (!exact) continue
    const score = 100 + formatBonus(c.media.format)
    if (!best || score > best.score) best = { c, score }
  }
  return best?.c ?? null
}

// ---------------------------------------------------------------------------

/** Prefer the main series over spin-offs with a similar title. */
function formatBonus(format: string | null): number {
  if (format === 'TV') return 10
  if (format === 'TV_SHORT' || format === 'ONA') return 5
  return 0
}

function toCandidates(media: RawMedia[]): Candidate[] {
  const out = media.map((m) => ({
    media: {
      id: m.id,
      title: m.title.romaji,
      english: m.title.english,
      format: m.format,
      year: m.seasonYear,
      episodes: m.episodes,
      coverUrl: m.coverImage?.large ?? null,
      color: m.coverImage?.color ?? null
    },
    titles: [m.title.romaji, m.title.english, ...(m.synonyms ?? [])].filter((t): t is string => !!t)
  }))
  for (const c of out) seen.set(c.media.id, c)
  return out
}
