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
      description(asHtml: false)
    }
  }
}`

const DESCRIPTION_QUERY = `query ($id: Int) { Media(id: $id) { description(asHtml: false) } }`

// An entry, its relations, and theirs: two hops of the franchise per request.
const FIELDS = 'id type status title { romaji english } synonyms format seasonYear episodes startDate { year month day } coverImage { large color }'
const FRANCHISE_QUERY = `query ($id: Int) {
  Media(id: $id) {
    ${FIELDS}
    relations { edges { relationType node { ${FIELDS} relations { edges { relationType node { ${FIELDS} } } } } } }
  }
}`
/** Shorter than search results: a new season gets announced, an airing one's episode count changes. */
const FRANCHISE_CACHE_MS = 24 * 3600_000
/** A safety stop for very long franchises; each request explores two hops. */
const FRANCHISE_MAX_REQUESTS = 8
/** Formats that are seasons of the show; movies, OVAs and specials aren't. */
const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA'])

interface RawMedia {
  id: number
  type?: string
  status?: string | null
  startDate?: { year: number | null; month: number | null; day: number | null }
  relations?: { edges: { relationType: string; node: RawMedia }[] }
  title: { romaji: string; english: string | null }
  synonyms: string[]
  format: string | null
  seasonYear: number | null
  episodes: number | null
  coverImage: { large: string | null; color: string | null }
  /** Missing from results cached before descriptions were fetched */
  description?: string | null
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

  const data = await request<{ Page?: { media?: RawMedia[] } }>(QUERY, { s: q })
  const media = data?.Page?.media ?? []

  db.prepare(
    'INSERT INTO anilist_cache (query, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at'
  ).run(q.toLowerCase(), JSON.stringify(media), Date.now())
  return toCandidates(media)
}

/** The plain-text synopsis of an AniList entry, or null if it has none. */
export async function fetchDescription(id: number): Promise<string | null> {
  const data = await request<{ Media?: { description: string | null } }>(DESCRIPTION_QUERY, { id })
  return cleanDescription(data?.Media?.description ?? null)
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

/**
 * The AniList entry a batch of a series starts from: its first season if that
 * matches exactly ("Show" for "Show S4"), else the season named.
 */
export async function findFranchise(series: string): Promise<Candidate | null> {
  const { base, season } = splitSeason(series)
  return (await findSeries(base)) ?? (season > 1 ? await findSeries(series) : null)
}

/**
 * Every season of the show an entry belongs to, in airing order: the TV (or
 * ONA) entries reachable through sequel and prequel links. Movies and OVAs are
 * passed through but left out, since sequels are often linked through them;
 * spin-offs aren't sequels, so they stay out. Seasons not aired yet are left out.
 */
export async function franchiseSeasons(id: number): Promise<Candidate[]> {
  const key = `franchise:${id}`
  const db = getDb()
  const cached = db.prepare('SELECT json, fetched_at FROM anilist_cache WHERE query = ?').get(key) as
    | { json: string; fetched_at: number }
    | undefined
  if (cached && Date.now() - cached.fetched_at < FRANCHISE_CACHE_MS) return toCandidates(JSON.parse(cached.json))

  const nodes = new Map<number, RawMedia>()
  const expanded = new Set<number>()
  const visit = (m: RawMedia): void => {
    const { relations, ...plain } = m
    if (!nodes.has(m.id)) nodes.set(m.id, plain)
    if (!relations) return
    expanded.add(m.id)
    for (const e of relations.edges) {
      if ((e.relationType === 'SEQUEL' || e.relationType === 'PREQUEL') && e.node.type === 'ANIME') visit(e.node)
    }
  }
  for (let requests = 0, next: number | undefined = id; next != null && requests < FRANCHISE_MAX_REQUESTS; requests++) {
    const data = await request<{ Media?: RawMedia }>(FRANCHISE_QUERY, { id: next })
    if (!data?.Media) break
    visit(data.Media)
    // Entries seen two hops out, whose own links weren't fetched yet.
    next = [...nodes.keys()].find((n) => !expanded.has(n))
  }

  const date = (m: RawMedia): number =>
    (m.startDate?.year ?? 9999) * 10_000 + (m.startDate?.month ?? 12) * 100 + (m.startDate?.day ?? 31)
  const seasons = [...nodes.values()]
    .filter((m) => SEASON_FORMATS.has(m.format ?? '') && m.status !== 'NOT_YET_RELEASED' && m.status !== 'CANCELLED')
    .sort((a, b) => date(a) - date(b) || a.id - b.id)

  // Under every season of the show, so a batch starting at any of them finds it without asking again.
  const save = db.prepare(
    'INSERT INTO anilist_cache (query, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at'
  )
  const json = JSON.stringify(seasons)
  for (const m of new Set([id, ...seasons.map((s) => s.id)])) save.run(`franchise:${m}`, json, Date.now())
  return toCandidates(seasons)
}

// ---------------------------------------------------------------------------

/** One GraphQL request, serialized so bursts (auto-linking a whole library) respect the rate limit. */
function request<T>(query: string, variables: Record<string, unknown>): Promise<T | undefined> {
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequest = Date.now()
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 429) throw new Error('AniList rate limit reached; try again in a minute')
    if (!res.ok) throw new Error(`AniList returned HTTP ${res.status}`)
    const body = (await res.json()) as { data?: T }
    return body.data
  })
  queue = run.catch(() => {})
  return run
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

/** AniList descriptions carry <br>, <i> and the like even as "plain" text, plus ~!spoiler!~ blocks. */
function cleanDescription(raw: string | null): string | null {
  if (!raw) return null
  const text = raw
    .replace(/~!([\s\S]*?)!~/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : (ENTITIES[e.toLowerCase()] ?? m)
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

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
      color: m.coverImage?.color ?? null,
      description: m.description === undefined ? undefined : cleanDescription(m.description)
    },
    titles: [m.title.romaji, m.title.english, ...(m.synonyms ?? [])].filter((t): t is string => !!t)
  }))
  for (const c of out) seen.set(c.media.id, c)
  return out
}
