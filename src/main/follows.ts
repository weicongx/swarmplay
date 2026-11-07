import { seriesKey, splitSeason } from '@shared/folders'
import type { AddTorrentRequest, FollowResult, NyaaResult } from '@shared/types'
import { getDb, getSettings } from './db'
import { addRelease, AVAILABLE_SQL, resolveFolder } from './library'
import { searchNyaaPages } from './nyaa'
import { play } from './player'
import { parseRelease, type ReleaseInfo } from './release'
import { isKept, pruneStreamTorrents } from './torrent'

const CHECK_EVERY_MS = 30 * 60_000
// Space out searches when checking many series, to go easy on nyaa.
const GAP_MS = 3_000
/** Pages a full check reads: nyaa pages through 1000 results at most, 75 a page. */
const FIRST_CHECK_PAGES = 14

interface FollowRow {
  id: number
  folder_id: number
  release_group: string
  series_key: string
  resolution: string | null
  query: string
  category: string
  checked_at: number | null
  last_error: string | null
}

interface ReleaseRow {
  id: number
  follow_id: number
  episode_num: number
  nyaa_id: number
  torrent_url: string
  published_at: number
}

let newEpisodesCb: ((folderId: number, episodes: number[]) => void) | null = null
let checking: Promise<void> | null = null

/** Called after a scheduled check finds new episodes of a followed series. */
export function onNewEpisodes(cb: (folderId: number, episodes: number[]) => void): void {
  newEpisodesCb = cb
}

/** Check every followed series shortly after startup, then every 30 minutes. */
export function startFollowChecks(): void {
  setTimeout(checkAll, 20_000)
  setInterval(checkAll, CHECK_EVERY_MS)
}

export async function followSeries(release: NyaaResult, folder: AddTorrentRequest['folder']): Promise<FollowResult> {
  const r = parseRelease(release.title)
  if (!r.group) throw new Error("This release has no [Group] tag, so there's no telling which uploads go with it.")
  if (r.episode == null) throw new Error("This looks like a batch or a movie, not a single episode, so there's nothing to follow.")
  const target = await resolveFolder(folder)
  if (!target) throw new Error('Choose a library folder for the series.')

  const db = getDb()
  const key = seriesKey(r.series)
  let follow = db
    .prepare(
      'SELECT * FROM follows WHERE folder_id = ? AND release_group = ? COLLATE NOCASE AND series_key = ? AND resolution IS ?'
    )
    .get(target.id, r.group, key, r.resolution) as unknown as FollowRow | undefined
  if (!follow) {
    const res = db
      .prepare(
        'INSERT INTO follows (folder_id, release_group, series_key, resolution, query, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(target.id, r.group, key, r.resolution, buildQuery(r), release.categoryId || '1_0', Date.now())
    follow = db.prepare('SELECT * FROM follows WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as FollowRow
  }

  // The release the user picked counts even if the search doesn't return it.
  saveRelease(follow.id, release, r.episode)
  await check(follow)
  return { folderId: target.id, folderName: target.name, available: countAvailable(target.id) }
}

/** A check asked for by hand reads every page, so it also finds episodes older than the newest 75. */
export async function checkFollow(followId: number): Promise<number> {
  return (await check(mustGetFollow(followId), true)).length
}

/** Stop following. Its episodes that were only streamed leave the library; downloads stay. */
export async function unfollow(followId: number): Promise<void> {
  const f = mustGetFollow(followId)
  const db = getDb()
  const streamed = db
    .prepare(
      `SELECT e.id, e.torrent_id, e.file_index FROM episodes e JOIN torrents t ON t.id = e.torrent_id
       WHERE e.folder_id = ? AND t.info_hash IN (SELECT info_hash FROM releases WHERE follow_id = ?)`
    )
    .all(f.folder_id, f.id) as { id: number; torrent_id: number; file_index: number }[]
  const drop = db.prepare('DELETE FROM episodes WHERE id = ?')
  for (const e of streamed) if (!isKept(e.torrent_id, e.file_index)) drop.run(e.id)
  db.prepare('DELETE FROM follows WHERE id = ?').run(followId)
  await pruneStreamTorrents()
}

export async function downloadRelease(releaseId: number): Promise<void> {
  await addRelease(releaseId, true)
}

/** Add the release to the library without downloading it, and play it. */
export async function streamRelease(releaseId: number): Promise<void> {
  const { torrentId, fileIndex } = await addRelease(releaseId, false)
  if (fileIndex == null) throw new Error('That torrent has no video file to play.')
  await play(torrentId, fileIndex)
}

// ---------------------------------------------------------------------------

/** Group, title words and resolution, e.g. "Judas Tempal Item no Chikara Overgeared 1080p". */
export function buildQuery(r: ReleaseInfo): string {
  const words = splitSeason(r.series).base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return [r.group, words, r.resolution].filter(Boolean).join(' ')
}

export function matches(f: Pick<FollowRow, 'release_group' | 'series_key' | 'resolution'>, r: ReleaseInfo): boolean {
  return (
    r.episode != null &&
    r.group?.toLowerCase() === f.release_group.toLowerCase() &&
    seriesKey(r.series) === f.series_key &&
    (f.resolution == null || r.resolution === f.resolution)
  )
}

/** Search nyaa for the series and store matching episodes; returns the episode numbers that are new. */
async function check(f: FollowRow, full = f.checked_at == null || f.last_error != null): Promise<number[]> {
  const db = getDb()
  try {
    // A full check (the first, or after a failed one) reads every page, so a long series
    // lists all its episodes; the scheduled ones only need the newest page.
    const results = await searchNyaaPages(
      getSettings().nyaaBaseUrl,
      { query: f.query, category: f.category, filter: 0, sort: 'date' },
      full ? FIRST_CHECK_PAGES : 1
    )
    const fresh: number[] = []
    // Oldest first, so a later re-upload (v2) of an episode replaces the original.
    for (const res of results.sort((a, b) => Date.parse(a.pubDate) - Date.parse(b.pubDate))) {
      const r = parseRelease(res.title)
      if (matches(f, r) && saveRelease(f.id, res, r.episode!)) fresh.push(r.episode!)
    }
    db.prepare('UPDATE follows SET checked_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), f.id)
    return fresh
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.prepare('UPDATE follows SET checked_at = ?, last_error = ? WHERE id = ?').run(Date.now(), message, f.id)
    throw err
  }
}

/**
 * Store a release as its episode's upload, unless a newer one is stored, and refresh
 * the stored one's seeder count. True if the episode is new.
 */
function saveRelease(followId: number, res: NyaaResult, episode: number): boolean {
  const db = getDb()
  const published = Date.parse(res.pubDate)
  const existing = db
    .prepare('SELECT * FROM releases WHERE follow_id = ? AND episode_num = ?')
    .get(followId, episode) as unknown as ReleaseRow | undefined
  if (!existing) {
    db.prepare(
      `INSERT INTO releases (follow_id, episode_num, nyaa_id, title, torrent_url, info_hash, size_bytes, published_at, added_at, seeders)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(followId, episode, res.id, res.title, res.torrentUrl, res.infoHash, res.sizeBytes, published, Date.now(), res.seeders)
    return true
  }
  if (published > existing.published_at && res.id !== existing.nyaa_id) {
    db.prepare(
      'UPDATE releases SET nyaa_id = ?, title = ?, torrent_url = ?, info_hash = ?, size_bytes = ?, published_at = ?, seeders = ? WHERE id = ?'
    ).run(res.id, res.title, res.torrentUrl, res.infoHash, res.sizeBytes, published, res.seeders, existing.id)
  } else if (res.id === existing.nyaa_id) {
    db.prepare('UPDATE releases SET seeders = ? WHERE id = ?').run(res.seeders, existing.id)
  }
  return false
}

function checkAll(): void {
  if (checking) return
  checking = (async () => {
    const follows = getDb().prepare('SELECT * FROM follows ORDER BY id').all() as unknown as FollowRow[]
    for (const [i, f] of follows.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS))
      const fresh = await check(f).catch(() => [])
      if (fresh.length > 0) newEpisodesCb?.(f.folder_id, fresh.sort((a, b) => a - b))
    }
  })().finally(() => (checking = null))
}

function countAvailable(folderId: number): number {
  const { n } = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM (${AVAILABLE_SQL}) WHERE folder_id = ?`)
    .get(folderId) as { n: number }
  return n
}

function mustGetFollow(id: number): FollowRow {
  const f = getDb().prepare('SELECT * FROM follows WHERE id = ?').get(id) as unknown as FollowRow | undefined
  if (!f) throw new Error('That series is no longer followed.')
  return f
}
