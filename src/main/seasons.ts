import { basename, dirname } from 'path'
import { splitSeason } from '@shared/folders'
import { parseRelease } from './release'

/**
 * Splitting a batch's episodes into the show's seasons. Pure, so it can be
 * checked without AniList or a library.
 */

export interface Season {
  id: number
  /** Romaji title */
  title: string
  english: string | null
  /** Unknown while it airs */
  episodes: number | null
}

export interface SeasonName {
  /** Season number as release groups count it: both cours of "2nd Season" are 2 */
  num: number
  /** Folder name within the series folder, e.g. "Season 2 Part 2" */
  label: string
}

/**
 * Number and name the seasons of a show, given in airing order. A title that
 * says its season ("2nd Season Part 2", "Season 3") keeps it; one that doesn't
 * ("Yuukaku-hen") follows the season before it.
 */
export function nameSeasons(seasons: Season[]): SeasonName[] {
  const root = tidy(splitSeason(seasons[0]?.title ?? '').base)
  let prev = 0
  return seasons.map((s, i) => {
    const said = [s.title, s.english].map((t) => (t ? splitSeason(t).season : 1)).find((n) => n > 1)
    const num = i === 0 ? 1 : Math.max(said ?? prev + 1, prev)
    prev = num
    // What the title adds to the show's name: "Part 2", "Yuukaku-hen".
    const base = tidy(splitSeason(s.title).base)
    const rest = base.toLowerCase().startsWith(root.toLowerCase())
      ? base.slice(root.length).replace(/^[\s:\-–~.,]+/, '').trim()
      : null
    let label: string
    if (rest == null) label = s.title // named unlike the show; its own title says most
    else if (!rest) label = `Season ${num}`
    else label = said || i === 0 ? `Season ${num} ${rest}` : rest
    return { num, label: label.slice(0, 120) }
  })
}

export interface FileSeason {
  index: number
  /** Index into the seasons */
  season: number
  /** Episode number within that season */
  episode: number | null
}

/**
 * Which season each video belongs to, and its episode number there.
 *
 * Batches number episodes either through the whole show ("Show - 37" is the
 * first episode of the third season) or per season ("Show S2 - 01", or a
 * "Season 2" folder). A file's season comes from its name, its folders, or the
 * batch's name; a season's files numbered past every episode before that
 * season are counted through the whole show. Null when a file names a season
 * the show doesn't have (AniList may not list it yet).
 */
export function mapToSeasons(
  seasons: Season[],
  names: SeasonName[],
  files: { index: number; path: string }[],
  batchSeason: number
): FileSeason[] | null {
  const parsed = files.map((f) => ({
    index: f.index,
    episode: parseRelease(basename(f.path)).episode,
    tag: seasonTag(f.path) ?? batchSeason
  }))

  // Where each tagged season starts, and whether its files count through the whole show.
  const absolute = new Map<number, boolean>()
  const startOf = (tag: number): number => {
    const named = names.findIndex((n) => n.num === tag)
    if (named >= 0) return named
    // Past the last season AniList lists: not one the show has yet.
    return tag > (names.at(-1)?.num ?? 0) ? seasons.length : tag - 1
  }
  for (const tag of new Set(parsed.map((p) => p.tag))) {
    if (tag <= 1) continue
    if (startOf(tag) >= seasons.length) return null
    const before = seasons.slice(0, startOf(tag)).reduce((n, s) => n + (s.episodes ?? Infinity), 0)
    const lowest = Math.min(...parsed.filter((p) => p.tag === tag && p.episode != null).map((p) => p.episode!))
    absolute.set(tag, Number.isFinite(before) && Number.isFinite(lowest) && Math.floor(lowest) > before)
  }

  return parsed.map((p) => {
    const from = p.tag <= 1 || absolute.get(p.tag) ? 0 : startOf(p.tag)
    if (p.episode == null) return { index: p.index, season: from, episode: null }
    return { index: p.index, ...place(seasons, from, p.episode) }
  })
}

/** Count `episode` through the seasons from `from`; extras like 24.5 stay with episode 24. */
function place(seasons: Season[], from: number, episode: number): { season: number; episode: number } {
  let rest = episode
  for (let i = from; i < seasons.length; i++) {
    const count = seasons[i].episodes
    if (count == null || i === seasons.length - 1 || Math.floor(rest) <= count) return { season: i, episode: rest }
    rest = Math.round((rest - count) * 100) / 100
  }
  return { season: from, episode }
}

/** A season above 1 named by the file ("Show S2 - 05") or a folder it's in ("Season 2/"). */
function seasonTag(path: string): number | null {
  const own = splitSeason(parseRelease(basename(path)).series).season
  if (own > 1) return own
  for (const dir of dirname(path).split(/[\\/]/).reverse()) {
    const m = dir.match(/\b(?:season\s*|s)0*(\d{1,2})\b/i) ?? dir.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i)
    if (m && Number(m[1]) > 1) return Number(m[1])
  }
  return null
}

/** Collapse runs of whitespace. */
export function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
