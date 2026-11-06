import type { AddTorrentRequest, AniListMedia, EpisodeInfo, FolderInfo, LibraryData } from '@shared/types'
import { compareEpisodes, seriesKey } from '@shared/folders'
import { fetchDescription, findSeries, recentCandidate, type Candidate } from './anilist'
import { getDb } from './db'
import { playableFiles, removeTorrent } from './torrent'

interface FolderRow {
  id: number
  name: string
  parent_id: number | null
  created_at: number
  anilist_id: number | null
  /** JSON string[] of AniList titles and synonyms */
  anilist_titles: string | null
  /** JSON AniListMedia */
  anilist_meta: string | null
  anilist_checked_at: number | null
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
  last_played_at: number | null
}

export function getLibrary(): LibraryData {
  const db = getDb()
  const folders = (db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all() as unknown as FolderRow[]).map(
    (f): FolderInfo => ({
      id: f.id,
      name: f.name,
      parentId: f.parent_id,
      createdAt: f.created_at,
      anilist: f.anilist_meta ? (JSON.parse(f.anilist_meta) as AniListMedia) : null
    })
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
      watched: e.watched === 1,
      lastPlayedAt: e.last_played_at
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
  const id = Number(res.lastInsertRowid)
  autoLink(id).catch(() => {}) // fills in the cover in the background
  return id
}

/** Link a folder to an AniList entry the user picked, or unlink it (null). */
export function linkFolder(folderId: number, anilistId: number | null): void {
  mustGetFolder(folderId)
  if (anilistId == null) {
    getDb()
      .prepare(
        'UPDATE folders SET anilist_id = NULL, anilist_titles = NULL, anilist_meta = NULL, cover_url = NULL, anilist_checked_at = ? WHERE id = ?'
      )
      .run(Date.now(), folderId)
    return
  }
  const c = recentCandidate(anilistId)
  if (!c) throw new Error('Search AniList again, then pick the entry')
  saveLink(folderId, c)
}

/** Link every folder that has never been checked against AniList, one request at a time. */
export async function autoLinkAll(): Promise<void> {
  const ids = getDb()
    .prepare('SELECT id FROM folders WHERE anilist_id IS NULL AND anilist_checked_at IS NULL')
    .all() as { id: number }[]
  for (const { id } of ids) await autoLink(id).catch(() => {})

  // Folders linked before descriptions were stored.
  const linked = getDb().prepare('SELECT id, anilist_meta FROM folders WHERE anilist_meta IS NOT NULL').all() as {
    id: number
    anilist_meta: string
  }[]
  for (const f of linked) {
    if (!('description' in JSON.parse(f.anilist_meta))) await fillDescription(f.id).catch(() => {})
  }
}

/** Fetch the synopsis for a linked folder whose stored AniList data predates it. */
async function fillDescription(folderId: number): Promise<void> {
  const before = getDb().prepare('SELECT anilist_id FROM folders WHERE id = ?').get(folderId) as
    | { anilist_id: number | null }
    | undefined
  if (before?.anilist_id == null) return
  const description = await fetchDescription(before.anilist_id)
  // Re-read: the folder may have been relinked or deleted while the request waited.
  const f = getDb().prepare('SELECT anilist_id, anilist_meta FROM folders WHERE id = ?').get(folderId) as
    | { anilist_id: number | null; anilist_meta: string | null }
    | undefined
  if (!f?.anilist_meta || f.anilist_id !== before.anilist_id) return
  const meta = { ...(JSON.parse(f.anilist_meta) as AniListMedia), description }
  getDb().prepare('UPDATE folders SET anilist_meta = ? WHERE id = ?').run(JSON.stringify(meta), folderId)
}

async function autoLink(folderId: number): Promise<void> {
  const f = getDb().prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as unknown as FolderRow | undefined
  if (!f || f.anilist_id != null) return
  const match = await findSeries(f.name)
  if (match) saveLink(folderId, match)
  else getDb().prepare('UPDATE folders SET anilist_checked_at = ? WHERE id = ?').run(Date.now(), folderId)
}

function saveLink(folderId: number, c: Candidate): void {
  getDb()
    .prepare(
      'UPDATE folders SET anilist_id = ?, anilist_titles = ?, anilist_meta = ?, cover_url = ?, anilist_checked_at = ? WHERE id = ?'
    )
    .run(c.media.id, JSON.stringify(c.titles), JSON.stringify(c.media), c.media.coverUrl, Date.now(), folderId)
  // Search results cached before descriptions were fetched don't carry one.
  if (c.media.description === undefined) fillDescription(folderId).catch(() => {})
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

/**
 * Turn a request's folder choice into a real folder. A "new" folder reuses an
 * existing one for the same series (by name, or by AniList entry when the
 * release uses another language's title) before creating one.
 */
export async function resolveFolder(choice: AddTorrentRequest['folder']): Promise<{ id: number; name: string } | null> {
  if (!choice) return null
  if ('id' in choice) return { id: choice.id, name: mustGetFolder(choice.id).name }

  const { folder, anilist } = await matchSeries(choice.name)
  if (folder) return { id: folder.id, name: folder.name }

  const name = cleanName(choice.name)
  const res = getDb()
    .prepare('INSERT INTO folders (name, parent_id, created_at) VALUES (?, ?, ?)')
    .run(name, choice.parentId ?? null, Date.now())
  const id = Number(res.lastInsertRowid)
  if (anilist) saveLink(id, anilist)
  else getDb().prepare('UPDATE folders SET anilist_checked_at = ? WHERE id = ?').run(Date.now(), id)
  return { id, name }
}

/** Which existing folder a series name belongs in, for the search panel's "Save to". */
export async function suggestFolder(series: string): Promise<{ folderId: number | null; name: string }> {
  const { folder } = await matchSeries(series)
  return { folderId: folder?.id ?? null, name: folder?.name ?? series }
}

/** Match a series name to a folder: by name or AniList titles first, then by AniList id. */
async function matchSeries(series: string): Promise<{ folder: FolderRow | null; anilist: Candidate | null }> {
  const folders = getDb().prepare('SELECT * FROM folders').all() as unknown as FolderRow[]
  const key = seriesKey(series)
  const byName = folders.find(
    (f) =>
      seriesKey(f.name) === key ||
      (f.anilist_titles ? (JSON.parse(f.anilist_titles) as string[]) : []).some((t) => seriesKey(t) === key)
  )
  if (byName) return { folder: byName, anilist: null }

  // Offline or rate-limited: just don't match by AniList this time.
  const anilist = await findSeries(series).catch(() => null)
  const byId = anilist ? folders.find((f) => f.anilist_id === anilist.media.id) : undefined
  return { folder: byId ?? null, anilist }
}

/** Folder and a short label for an episode, for notifications. */
export function describeEpisode(
  torrentId: number,
  fileIndex: number
): { folderId: number | null; folderName: string | null; label: string } {
  const row = getDb()
    .prepare(
      `SELECT e.title, e.episode_num, e.folder_id, f.name AS folder_name
       FROM episodes e LEFT JOIN folders f ON f.id = e.folder_id
       WHERE e.torrent_id = ? AND e.file_index = ?`
    )
    .get(torrentId, fileIndex) as
    | { title: string; episode_num: number | null; folder_id: number | null; folder_name: string | null }
    | undefined
  if (!row) return { folderId: null, folderName: null, label: 'A new episode' }
  return {
    folderId: row.folder_id,
    folderName: row.folder_name,
    label: row.episode_num != null ? `Episode ${row.episode_num}` : row.title
  }
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
