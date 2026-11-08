import { seriesKey, splitSeason } from '@shared/folders'
import { VIDEO_EXT, type AddTorrentRequest, type AddTorrentResult, type BatchPlan } from '@shared/types'
import { findFranchise, franchiseSeasons, type Candidate } from './anilist'
import { getDb, getSettings } from './db'
import { addToFolder, cleanName, saveLink } from './library'
import { getTorrentInfo } from './nyaa'
import { parseRelease } from './release'
import { mapToSeasons, nameSeasons, tidy } from './seasons'

/**
 * Batches of a show with several seasons go in one folder for the show, with a
 * folder per season inside. Every batch of the show finds the same series folder
 * through AniList, whichever season it starts at, so later batches join it.
 */

/** How long playing a batch waits for AniList before playing first and splitting it into seasons after. */
const PLAN_WAIT_MS = 1_500

interface FolderRow {
  id: number
  name: string
  parent_id: number | null
  anilist_id: number | null
  anilist_titles: string | null
  franchise_id: number | null
}

type Add = (folder: { id: number; name: string } | null) => Promise<AddTorrentResult>

interface Plan extends BatchPlan {
  /** Every season of the show, in airing order; the first is the show's own entry */
  all: Candidate[]
  /** Where each of `seasons` is in `all` */
  used: number[]
  /** Each video's episode number as its file name gives it */
  named: Map<number, number | null>
}

/** How a batch splits into seasons, or null if it's a single episode or the show has one season. */
export async function planBatch(torrentUrl: string): Promise<Plan | null> {
  const info = await getTorrentInfo(getSettings().nyaaBaseUrl, torrentUrl)
  if (!info.batch) return null
  const videos = info.files.filter((f) => VIDEO_EXT.test(f.path))

  // Offline or rate-limited: file it as one folder, like any other torrent.
  const start = await findFranchise(info.series).catch(() => null)
  const all = start ? await franchiseSeasons(start.media.id).catch(() => []) : []
  if (all.length < 2) return null

  const shows = all.map((c) => ({ id: c.media.id, title: c.media.title, english: c.media.english, episodes: c.media.episodes }))
  const names = nameSeasons(shows)
  const mapped = mapToSeasons(shows, names, videos, splitSeason(info.series).season)
  if (!mapped) return null // a season AniList doesn't list: better one folder than the wrong season

  // Only the seasons the batch has, in airing order.
  const used = [...new Set(mapped.map((m) => m.season))].sort((a, b) => a - b)
  const series = seriesFolder(all[0].media.id)
  const rows = folders()
  return {
    all,
    used,
    named: new Map(videos.map((f) => [f.index, parseRelease(f.path.split(/[\\/]/).pop()!).episode])),
    series: { folderId: series?.id ?? null, name: series?.name ?? tidy(splitSeason(all[0].media.title).base) },
    seasons: used.map((i) => ({
      anilistId: all[i].media.id,
      label: names[i].label,
      title: all[i].media.title,
      folderId: findSeasonFolder(rows, all[i], series?.id ?? null)?.id ?? null
    })),
    files: mapped.map((m) => ({ ...m, season: used.indexOf(m.season) }))
  }
}

/**
 * Add a torrent to the library. A batch of a show with several seasons is filed
 * into the show's series folder, a folder per season; anything else, or a batch
 * added to Unsorted, goes in the folder chosen.
 */
export async function addToLibrary(req: AddTorrentRequest, add: Add): Promise<AddTorrentResult> {
  const plan = req.folder ? await planBatch(req.torrentUrl).catch(() => null) : null
  return plan ? fileBatch(req, plan, add) : addToFolder(req.folder, add)
}

/**
 * Add a torrent to stream now. Playing doesn't wait on AniList: when a batch's
 * seasons aren't known in a moment, it goes in the folder chosen and moves into
 * its season folders once they are.
 */
export async function streamToLibrary(req: AddTorrentRequest, add: Add): Promise<AddTorrentResult> {
  if (!req.folder) return addToFolder(req.folder, add)
  const planning = planBatch(req.torrentUrl).catch(() => null)
  const quick = await Promise.race([planning, new Promise<undefined>((r) => setTimeout(r, PLAN_WAIT_MS))])
  if (quick !== undefined) return quick ? fileBatch(req, quick, add) : addToFolder(req.folder, add)

  const db = getDb()
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM folders').get() as { last: number }
  const result = await addToFolder(req.folder, add)
  void planning.then(async (plan) => {
    if (!plan) return
    const placed = db.prepare('SELECT folder_id FROM episodes WHERE torrent_id = ? AND folder_id IS NOT NULL LIMIT 1').get(result.id) as
      | { folder_id: number }
      | undefined
    await fileBatch(req, plan, async () => result).catch(() => {})
    // The folder made just for this stream, now that its episodes are in their seasons.
    const made = placed?.folder_id
    if (made != null && made > last && !db.prepare('SELECT 1 FROM folders WHERE parent_id = ? UNION ALL SELECT 1 FROM episodes WHERE folder_id = ?').get(made, made)) {
      db.prepare('DELETE FROM folders WHERE id = ?').run(made)
    }
  })
  return result
}

// ---------------------------------------------------------------------------

async function fileBatch(req: AddTorrentRequest, plan: Plan, add: Add): Promise<AddTorrentResult> {
  // The series folder holds the download on disk, so the files of every season stay together.
  const db = getDb()
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM folders').get() as { last: number }
  const seriesId = resolveSeries(req.folder!, plan)
  let result: AddTorrentResult
  try {
    result = await addToFolder({ id: seriesId }, add)
  } catch (err) {
    // Don't leave behind a series folder made for this add.
    if (seriesId > last && !db.prepare('SELECT 1 FROM folders WHERE parent_id = ? UNION ALL SELECT 1 FROM episodes WHERE folder_id = ?').get(seriesId, seriesId)) {
      db.prepare('DELETE FROM folders WHERE id = ?').run(seriesId)
    }
    throw err
  }
  const series = db.prepare('SELECT * FROM folders WHERE id = ?').get(seriesId) as unknown as FolderRow

  const wanted = new Set(req.fileIndexes ?? plan.files.map((f) => f.index))
  const file = db.prepare('UPDATE episodes SET folder_id = ?, episode_num = ? WHERE torrent_id = ? AND file_index = ?')
  const rows = folders()
  const seasons = plan.seasons.map((s, i) => {
    const files = plan.files.filter((f) => f.season === i && wanted.has(f.index))
    if (files.length === 0) return null
    const season = plan.all[plan.used[i]]
    const folderId = seasonFolder(rows, series, season, s.label, plan.used[i])
    // A followed season numbered through the show keeps the file's own numbers, so its releases line up.
    const throughShow = followedThroughShow(folderId, season.media.episodes)
    for (const f of files) file.run(folderId, throughShow ? (plan.named.get(f.index) ?? f.episode) : f.episode, result.id, f.index)
    return { label: s.label, folderId, episodes: files.length }
  })
  return { ...result, filed: { folderId: series.id, name: series.name, seasons: seasons.filter((s) => s != null) } }
}

/**
 * The series folder a batch goes in: the show's, if the library has one; the
 * existing folder picked; or a new one. Picking a folder of one of the show's
 * seasons makes a series folder beside it, which that season then moves into.
 */
function resolveSeries(choice: NonNullable<AddTorrentRequest['folder']>, plan: Plan): number {
  const root = plan.all[0]
  const existing = seriesFolder(root.media.id)
  if ('id' in choice) {
    const picked = getDb().prepare('SELECT * FROM folders WHERE id = ?').get(choice.id) as FolderRow | undefined
    if (!picked) throw new Error('That folder no longer exists')
    if (picked.franchise_id != null) return picked.id
    if (existing) return existing.id
    if (plan.all.some((c) => c.media.id === picked.anilist_id)) return createSeries(plan.series.name, picked.parent_id, root)
    // An ordinary folder becomes the show's series folder.
    getDb().prepare('UPDATE folders SET franchise_id = ? WHERE id = ?').run(root.media.id, picked.id)
    if (picked.anilist_id == null) saveLink(picked.id, root)
    return picked.id
  }
  return existing?.id ?? createSeries(choice.name, choice.parentId ?? null, root)
}

function createSeries(name: string, parentId: number | null, root: Candidate): number {
  const res = getDb()
    .prepare('INSERT INTO folders (name, parent_id, created_at, franchise_id) VALUES (?, ?, ?, ?)')
    .run(cleanName(name), parentId, Date.now(), root.media.id)
  const id = Number(res.lastInsertRowid)
  saveLink(id, root) // the show's cover and synopsis
  return id
}

/**
 * The folder for a season: one already linked to it or named for it (a season
 * streamed episode by episode before), or a new one in the series folder. A
 * season folder at the top of the library, or beside the series folder, moves in.
 */
function seasonFolder(rows: FolderRow[], series: FolderRow, season: Candidate, label: string, order: number): number {
  const db = getDb()
  const found = findSeasonFolder(rows, season, series.id)
  if (found) {
    if (found.parent_id == null || found.parent_id === series.parent_id) {
      // Named for the show, as a folder outside it would be; inside the series folder it's a season.
      db.prepare('UPDATE folders SET parent_id = ?, sort_order = ?, name = ? WHERE id = ?').run(series.id, order, cleanName(label), found.id)
      found.parent_id = series.id
    } else if (found.parent_id === series.id) {
      db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(order, found.id)
    }
    if (found.anilist_id == null) {
      saveLink(found.id, season)
      found.anilist_id = season.media.id
    }
    return found.id
  }
  const res = db
    .prepare('INSERT INTO folders (name, parent_id, created_at, sort_order) VALUES (?, ?, ?, ?)')
    .run(cleanName(label), series.id, Date.now(), order)
  const id = Number(res.lastInsertRowid)
  saveLink(id, season)
  rows.push({ id, name: label, parent_id: series.id, anilist_id: season.media.id, anilist_titles: null, franchise_id: null })
  return id
}

/** A season's folder: inside the series folder first, then anywhere; by AniList link, then by name. */
function findSeasonFolder(rows: FolderRow[], season: Candidate, seriesId: number | null): FolderRow | undefined {
  const keys = new Set(season.titles.map(seriesKey))
  const candidates = rows.filter((f) => f.franchise_id == null && f.id !== seriesId)
  const linked = candidates.filter((f) => f.anilist_id === season.media.id)
  const named = candidates.filter(
    (f) =>
      f.anilist_id == null &&
      (keys.has(seriesKey(f.name)) || (f.anilist_titles ? (JSON.parse(f.anilist_titles) as string[]) : []).some((t) => keys.has(seriesKey(t))))
  )
  const inSeries = (f: FolderRow): boolean => f.parent_id === seriesId
  return linked.find(inSeries) ?? linked[0] ?? named.find(inSeries) ?? named[0]
}

/** True when the folder follows uploads whose episode numbers run past this season's count. */
function followedThroughShow(folderId: number, count: number | null): boolean {
  if (count == null) return false
  const { lo } = getDb()
    .prepare('SELECT MIN(r.episode_num) AS lo FROM releases r JOIN follows f ON f.id = r.follow_id WHERE f.folder_id = ?')
    .get(folderId) as { lo: number | null }
  return lo != null && lo > count
}

function seriesFolder(rootId: number): FolderRow | undefined {
  return getDb().prepare('SELECT * FROM folders WHERE franchise_id = ? ORDER BY id LIMIT 1').get(rootId) as
    | FolderRow
    | undefined
}

function folders(): FolderRow[] {
  return getDb().prepare('SELECT * FROM folders').all() as unknown as FolderRow[]
}
