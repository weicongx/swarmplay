import { parse } from 'anitomy'

export interface ReleaseInfo {
  /** Series name used for library folders, with the season appended after S1 ("Frieren S2") */
  series: string
  /** Episode number, or null for batches, movies and unrecognized names */
  episode: number | null
  /** Release group from the leading "[Group]" tag */
  group: string | null
  /** e.g. "1080p" */
  resolution: string | null
}

// Groups disagree on where the season goes ("Show S2 - 05", "Show 2nd Season - 05",
// "Show - S02E05"), so strip it from the title and re-add it in one format.
const TRAILING_SEASON = /[\s\-–:]*(?:S\d{1,2}|Season\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+Season)$/i

export function parseRelease(name: string): ReleaseInfo {
  // anitomy reads a re-released extra, "24.9v2", as episode 9.
  const r = parse(name.replace(/(\d+\.\d+)v\d+\b/g, '$1'))
  let series = (r?.title ?? '').replace(TRAILING_SEASON, '').replace(/[\s\-–:.|]+$/, '').trim()
  const season = Number(r?.season)
  if (season > 1) series += ` S${season}`

  const ep = r?.episode?.number
  // A range (01-12) means a batch, not a single episode.
  const episode = typeof ep === 'number' && r?.episode?.numberAlt == null ? ep : null
  // anitomy doesn't report the group, but nyaa uploads almost always lead with it.
  const group = name.match(/^\s*\[([^\]]+)\]/)?.[1].trim() || null
  const resolution = r?.video?.resolution?.toLowerCase() || null
  return { series: series || name, episode, group, resolution }
}
