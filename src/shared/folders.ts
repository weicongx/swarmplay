import type { EpisodeInfo, FolderInfo } from './types'

/**
 * Loose key for matching folder names: case, punctuation and spacing don't
 * matter, nor common romanization variants (wo/o, ō/ou, ū/uu).
 */
export function folderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bwo\b/g, 'o')
    .replace(/ō/g, 'ou')
    .replace(/ū/g, 'uu')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5 }

/** "Show 2nd Season", "Show Season 2", "Show S2", "Show II" → { base: "Show", season: 2 } */
export function splitSeason(title: string): { base: string; season: number } {
  let season = 1
  const base = title
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i, (_, n) => ((season = Number(n)), ' '))
    .replace(/\bSeason\s*(\d{1,2})\b/i, (_, n) => ((season = Number(n)), ' '))
    .replace(/(?:^|\s)S(\d{1,2})$/i, (_, n) => ((season = Number(n)), ' '))
    .replace(/\s(II|III|IV|V)$/, (_, r: string) => ((season = ROMAN[r]), ' '))
  return { base: base.replace(/[\s\-–:]+$/, '').trim(), season }
}

/** Key for "same series and season": "Frieren S2" and "Frieren 2nd Season" match. */
export function seriesKey(name: string): string {
  const { base, season } = splitSeason(name)
  return `${folderKey(base)}#${season}`
}

/** Folders depth-first by name, each with its nesting depth, for pickers. */
export function flattenFolders(folders: FolderInfo[]): { folder: FolderInfo; depth: number }[] {
  const out: { folder: FolderInfo; depth: number }[] = []
  const walk = (parentId: number | null, depth: number): void => {
    for (const f of folders.filter((x) => x.parentId === parentId)) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Episode number first; unnumbered episodes go last, by file name. */
export function compareEpisodes(
  a: Pick<EpisodeInfo, 'episodeNum' | 'title'>,
  b: Pick<EpisodeInfo, 'episodeNum' | 'title'>
): number {
  const an = a.episodeNum ?? Infinity
  const bn = b.episodeNum ?? Infinity
  if (an !== bn) return an - bn
  return a.title.localeCompare(b.title, undefined, { numeric: true })
}

/**
 * Episodes to pick up again, newest first: the latest played in each folder, or,
 * once that one is watched, the next unwatched episode after it.
 */
export function continueWatching(episodes: EpisodeInfo[], limit = 8): { ep: EpisodeInfo; playedAt: number }[] {
  const latest = new Map<number | null, EpisodeInfo>()
  for (const e of episodes) {
    if (e.lastPlayedAt == null) continue
    const cur = latest.get(e.folderId)
    if (!cur || e.lastPlayedAt > cur.lastPlayedAt!) latest.set(e.folderId, e)
  }
  const out: { ep: EpisodeInfo; playedAt: number }[] = []
  for (const [folderId, last] of latest) {
    let ep: EpisodeInfo | undefined = last
    if (last.watched) {
      const eps = episodes.filter((e) => e.folderId === folderId).sort(compareEpisodes)
      ep = eps.slice(eps.indexOf(last) + 1).find((e) => !e.watched)
    }
    if (ep) out.push({ ep, playedAt: last.lastPlayedAt! })
  }
  return out.sort((a, b) => b.playedAt - a.playedAt).slice(0, limit)
}
