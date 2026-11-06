import type { AddTorrentRequest, EpisodeInfo, FolderInfo, LibraryData } from '@shared/types'
import { compareEpisodes, folderKey } from '@shared/folders'
import { getDb } from './db'
import { playableFiles, removeTorrent } from './torrent'

interface FolderRow {
  id: number
  name: string
  parent_id: number | null
  created_at: number
}

interface EpisodeRow {
  id: number
  folder_id: number | null
  torrent_id: number
  file_index: number
  title: string
  episode_num: number | null
  size_bytes: number
  position_sec: number
  duration_sec: number | null
  watched: number
}

export function getLibrary(): LibraryData {
  const db = getDb()
  const folders = (db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all() as unknown as FolderRow[]).map(
    (f): FolderInfo => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at })
  )
  // Only episodes that belong to a selected file (phase 3 could create rows for others).
  const episodes = (
    db.prepare("SELECT * FROM episodes WHERE title != '' ORDER BY episode_num, title").all() as unknown as EpisodeRow[]
  ).map(
    (e): EpisodeInfo => ({
      id: e.id,
      folderId: e.folder_id,
      torrentId: e.torrent_id,
      fileIndex: e.file_index,
      title: e.title,
      episodeNum: e.episode_num,
      sizeBytes: e.size_bytes,
      positionSec: e.position_sec,
      durationSec: e.duration_sec,
      watched: e.watched === 1
    })
  )
  return { folders, episodes }
}

export function createFolder(name: string, parentId: number | null): number {
  const clean = cleanName(name)
  if (parentId != null) mustGetFolder(parentId)
  const res = getDb()
    .prepare('INSERT INTO folders (name, parent_id, created_at) VALUES (?, ?, ?)')
    .run(clean, parentId, Date.now())
  return Number(res.lastInsertRowid)
}

export function renameFolder(id: number, name: string): void {
  mustGetFolder(id)
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(cleanName(name), id)
}

export async function deleteFolder(id: number, deleteDownloads: boolean): Promise<void> {
  mustGetFolder(id)
  const subtree = descendants(id)

  if (deleteDownloads) {
    // Only remove torrents whose every episode lives in this folder tree,
    // so a batch shared with another folder keeps its files.
    const placeholders = subtree.map(() => '?').join(',')
    const torrentIds = getDb()
      .prepare(
        `SELECT torrent_id FROM episodes WHERE title != '' GROUP BY torrent_id
         HAVING SUM(CASE WHEN folder_id IN (${placeholders}) THEN 0 ELSE 1 END) = 0`
      )
      .all(...subtree) as { torrent_id: number }[]
    for (const { torrent_id } of torrentIds) await removeTorrent(torrent_id, true)
  }

  // Child folders cascade; their episodes fall back to Unsorted (ON DELETE SET NULL).
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id)
}

export function moveFolder(id: number, parentId: number | null): void {
  mustGetFolder(id)
  if (parentId != null) {
    mustGetFolder(parentId)
    if (descendants(id).includes(parentId)) throw new Error("A folder can't go inside itself")
  }
  getDb().prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(parentId, id)
}

export function moveEpisodes(episodeIds: number[], folderId: number | null): void {
  if (folderId != null) mustGetFolder(folderId)
  const update = getDb().prepare('UPDATE episodes SET folder_id = ? WHERE id = ?')
  for (const id of episodeIds) update.run(folderId, id)
}

/** Turn a request's folder choice into a real folder, creating it or reusing a same-named one. */
export function resolveFolder(choice: AddTorrentRequest['folder']): { id: number; name: string } | null {
  if (!choice) return null
  if ('id' in choice) return { id: choice.id, name: mustGetFolder(choice.id).name }

  const parentId = choice.parentId ?? null
  const siblings = getDb()
    .prepare('SELECT * FROM folders WHERE parent_id IS ?')
    .all(parentId) as unknown as FolderRow[]
  const match = siblings.find((f) => folderKey(f.name) === folderKey(choice.name))
  if (match) return { id: match.id, name: match.name }
  const name = cleanName(choice.name)
  return { id: createFolder(name, parentId), name }
}

/**
 * The episode to autoplay after this one: the next in its folder by episode
 * number (so weekly single-episode torrents chain), else the next file in the torrent.
 */
export function nextEpisode(torrentId: number, fileIndex: number): { torrentId: number; fileIndex: number } | null {
  const db = getDb()
  const current = db
    .prepare('SELECT folder_id FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(torrentId, fileIndex) as { folder_id: number | null } | undefined

  if (current?.folder_id != null) {
    const eps = getLibrary()
      .episodes.filter((e) => e.folderId === current.folder_id)
      .sort(compareEpisodes)
    const i = eps.findIndex((e) => e.torrentId === torrentId && e.fileIndex === fileIndex)
    const next = eps[i + 1]
    return next ? { torrentId: next.torrentId, fileIndex: next.fileIndex } : null
  }

  const queue = playableFiles(torrentId)
  const next = queue[queue.indexOf(fileIndex) + 1]
  return next !== undefined ? { torrentId, fileIndex: next } : null
}

// ---------------------------------------------------------------------------

function mustGetFolder(id: number): FolderRow {
  const f = getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id) as unknown as FolderRow | undefined
  if (!f) throw new Error('That folder no longer exists')
  return f
}

/** The folder and every folder nested under it. */
function descendants(id: number): number[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id)
       SELECT id FROM tree`
    )
    .all(id) as { id: number }[]
  return rows.map((r) => r.id)
}

function cleanName(name: string): string {
  const s = name.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!s) throw new Error('Folder name cannot be empty')
  return s
}
