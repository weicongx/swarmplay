import { parse } from 'anitomy'

export interface ReleaseInfo {
  /** Series name used for library folders, with the season appended after S1 ("Frieren S2") */
  series: string
  /** Episode number, or null for batches, movies and unrecognized names */
  episode: number | null
}

// Groups disagree on where the season goes ("Show S2 - 05", "Show 2nd Season - 05",
// "Show - S02E05"), so strip it from the title and re-add it in one format.
const TRAILING_SEASON = /[\s\-–:]*(?:S\d{1,2}|Season\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+Season)$/i

export function parseRelease(name: string): ReleaseInfo {
  const r = parse(name)
  let series = (r?.title ?? '').replace(TRAILING_SEASON, '').replace(/[\s\-–:.|]+$/, '').trim()
  const season = Number(r?.season)
  if (season > 1) series += ` S${season}`

  const ep = r?.episode?.number
  // A range (01-12) means a batch, not a single episode.
  const episode = typeof ep === 'number' && r?.episode?.numberAlt == null ? ep : null
  return { series: series || name, episode }
}
