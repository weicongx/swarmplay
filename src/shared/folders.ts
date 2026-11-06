import type { EpisodeInfo, FolderInfo } from './types'

/** Loose key for matching folder names: case, punctuation and spacing don't matter. */
export function folderKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
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
export function compareEpisodes(a: EpisodeInfo, b: EpisodeInfo): number {
  const an = a.episodeNum ?? Infinity
  const bn = b.episodeNum ?? Infinity
  if (an !== bn) return an - bn
  return a.title.localeCompare(b.title, undefined, { numeric: true })
}
