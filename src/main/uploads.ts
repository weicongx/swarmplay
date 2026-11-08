// Uploads of the same episode on nyaa, and picking a well-seeded one: before a
// followed series' episode is first added, and for Try another while it plays.

import { seriesKey, splitSeason } from '@shared/folders'
import type { NyaaResult } from '@shared/types'
import { getDb, getSettings } from './db'
import { searchNyaa } from './nyaa'
import { parseRelease } from './release'
import { markScraped, scrapedRecently, scrapeSeeders } from './scrape'

/** Searches to try, at most: one per distinct name the series goes by. */
const MAX_QUERIES = 3

export interface UploadSearch {
  episode: number
  /** Names the series goes by: the release's own, the folder's, its AniList titles */
  names: string[]
  /** The upload to find others of, left out of the results */
  infoHash: string
  /** Its titles (release and file), to tell a dub from subtitles */
  titles: string[]
  /** Preferred between uploads with as many seeders */
  resolution: string | null
  /** Only uploads at `resolution`, and dubbed only if this one is */
  strict?: boolean
  maxQueries?: number
}

/**
 * Other uploads of an episode on nyaa that have seeders, from any group, best
 * first: never a dub-only upload for subtitles (or the other way round), then
 * most seeders, then the same resolution.
 */
export async function otherUploads(q: UploadSearch): Promise<NyaaResult[]> {
  const keys = new Set(q.names.flatMap(seriesKeys))
  const queries = [...new Set(q.names.map((n) => splitSeason(n).base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).filter(Boolean))]

  const { nyaaBaseUrl, defaultCategory } = getSettings()
  const found = new Map<string, NyaaResult>()
  for (const query of queries.slice(0, q.maxQueries ?? MAX_QUERIES)) {
    const results = await searchNyaa(nyaaBaseUrl, { query, category: defaultCategory, filter: 0, sort: 'seeders' })
      .then((p) => p.results)
      .catch(() => [])
    for (const r of results) {
      if (r.infoHash === q.infoHash || r.seeders === 0 || found.has(r.infoHash)) continue
      const p = parseRelease(r.title)
      if (p.episode !== q.episode || !seriesKeys(p.series).some((k) => keys.has(k))) continue
      if (q.strict && q.resolution && p.resolution !== q.resolution) continue
      found.set(r.infoHash, r)
    }
  }
  const dubNow = q.titles.some(isDub)
  const fits = (r: NyaaResult): number => (isDub(r.title) === dubNow ? 1 : 0)
  const sameRes = (r: NyaaResult): number => (parseRelease(r.title).resolution === q.resolution ? 1 : 0)
  return [...found.values()]
    .filter((r) => !q.strict || fits(r))
    .sort((a, b) => fits(b) - fits(a) || b.seeders - a.seeders || sameRes(b) - sameRes(a))
}

/** Fewer seeders than this, live from the tracker, and an episode's upload is compared with the others before it's added. */
const WEAK_SEEDERS = 10
/** Another upload takes its place with at least this many times its seeders, and this many more. */
const BETTER_TIMES = 2
const BETTER_BY = 5
/** The comparison never holds a start up longer than this; past it, the stored upload is used. */
const PICK_BUDGET_MS = 4000

/**
 * Before a followed series' episode is first added to stream, make sure its stored upload
 * isn't a poorly seeded one when a well-seeded upload of the same episode, at
 * the same resolution, is on nyaa: if so, the release switches to that one, the
 * way Try another would mid-episode. Healthy uploads (most) cost one tracker
 * request; the search runs only for weak ones, within PICK_BUDGET_MS.
 */
export async function preferHealthyUpload(releaseId: number, names: string[]): Promise<void> {
  let expired = false
  const work = (async () => {
    const db = getDb()
    const rel = db
      .prepare(
        `SELECT r.title, r.info_hash, r.seeders, r.episode_num, r.published_at, f.resolution
         FROM releases r JOIN follows f ON f.id = r.follow_id WHERE r.id = ?`
      )
      .get(releaseId) as
      | {
          title: string
          info_hash: string
          seeders: number | null
          episode_num: number
          published_at: number
          resolution: string | null
        }
      | undefined
    if (!rel) return
    // Opening the folder scraped the counts a moment ago, most likely: no need to ask again.
    const fresh = rel.seeders != null && scrapedRecently(rel.info_hash)
    const live = fresh ? null : (await scrapeSeeders([rel.info_hash])).get(rel.info_hash)
    if (expired) return
    if (live != null) {
      markScraped(rel.info_hash)
      if (live !== rel.seeders) db.prepare('UPDATE releases SET seeders = ? WHERE info_hash = ?').run(live, rel.info_hash)
    }
    const seeders = live ?? rel.seeders ?? 0
    if (seeders >= WEAK_SEEDERS) return

    const parsed = parseRelease(rel.title)
    const [best] = await otherUploads({
      episode: rel.episode_num,
      names: [parsed.series, ...names],
      infoHash: rel.info_hash,
      titles: [rel.title],
      resolution: rel.resolution ?? parsed.resolution,
      strict: true,
      maxQueries: 2
    })
    if (expired || !best || best.seeders < Math.max(seeders * BETTER_TIMES, seeders + BETTER_BY)) return
    // A follow check replaces a release with an upload published after it, so the
    // date kept is the later of the two: the weak upload it replaced doesn't come back.
    const published = Math.max(Date.parse(best.pubDate) || 0, rel.published_at)
    db.prepare(
      `UPDATE releases SET nyaa_id = ?, title = ?, torrent_url = ?, info_hash = ?, size_bytes = ?, published_at = ?, seeders = ?
       WHERE id = ?`
    ).run(best.id, best.title, best.torrentUrl, best.infoHash, best.sizeBytes, published, best.seeders, releaseId)
    console.log(`Upload picked for its seeders: ${best.title} (${best.seeders}) over ${rel.title} (${seeders})`)
  })().catch((err) => console.error('Failed to compare uploads:', err))
  await Promise.race([work, new Promise((r) => setTimeout(r, PICK_BUDGET_MS))])
  expired = true
}

export function isDub(title: string): boolean {
  return /\bdub(bed)?\b/i.test(title) && !/\b(dual|multi)[- ]?audio\b/i.test(title)
}

/** Keys for a series name and the titles inside it: "Tempal (Overgeared) S2" also matches "Overgeared S2". */
function seriesKeys(series: string): string[] {
  const { base, season } = splitSeason(series)
  const suffix = season > 1 ? ` S${season}` : ''
  const variants = [base, base.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '), ...[...base.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])]
  return [...new Set(variants.map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean))].map((v) => seriesKey(v + suffix))
}
