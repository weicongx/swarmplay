import { basename } from 'path'
import { seriesKey, splitSeason } from '@shared/folders'
import { VIDEO_EXT, type NyaaResult } from '@shared/types'
import { getDb, getSettings } from './db'
import { folderTitles, resolveFolder } from './library'
import { getTorrentInfo, searchNyaa } from './nyaa'
import { getPlayerState, play } from './player'
import { parseRelease } from './release'
import { addStream, isKept, pruneStreamTorrents, torrentIdentity } from './torrent'

/** Searches to try, at most: one per distinct name the series goes by. */
const MAX_QUERIES = 3

/**
 * Switch the playing episode to the best-seeded other upload of it on nyaa,
 * from any group, at the same position. The library episode (and a followed
 * series' release) points at the new upload from then on.
 */
export function tryAnotherRelease(): Promise<string> {
  // A second ask while one is searching (say, from the player after a switch
  // between full and mini) waits for the same switch rather than starting another.
  switching ??= switchRelease().finally(() => (switching = null))
  return switching
}
let switching: Promise<string> | null = null

async function switchRelease(): Promise<string> {
  const s = getPlayerState()
  if (!s.open || s.torrentId == null || s.fileIndex == null) throw new Error('Nothing is playing.')
  const { torrentId, fileIndex, timePos } = s
  const db = getDb()
  const ep = db
    .prepare('SELECT folder_id, episode_num, title FROM episodes WHERE torrent_id = ? AND file_index = ?')
    .get(torrentId, fileIndex) as { folder_id: number | null; episode_num: number | null; title: string } | undefined
  const current = torrentIdentity(torrentId)
  const parsed = parseRelease(ep?.title || current.name)
  const episode = ep?.episode_num ?? parsed.episode
  if (episode == null) throw new Error("Can't tell which episode this is, so there's no finding another upload of it.")

  // The release's own series name, plus the folder's and its AniList titles,
  // so uploads that use another language's title still match.
  const names = [parsed.series, parseRelease(current.name).series, ...(ep?.folder_id != null ? folderTitles(ep.folder_id) : [])]
  const keys = new Set(names.flatMap(seriesKeys))
  const queries = [...new Set(names.map((n) => splitSeason(n).base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).filter(Boolean))]

  const { nyaaBaseUrl, defaultCategory } = getSettings()
  const found = new Map<string, NyaaResult>()
  for (const query of queries.slice(0, MAX_QUERIES)) {
    const results = await searchNyaa(nyaaBaseUrl, { query, category: defaultCategory, filter: 0, sort: 'seeders' })
      .then((p) => p.results)
      .catch(() => [])
    for (const r of results) {
      if (r.infoHash === current.infoHash || r.seeders === 0 || found.has(r.infoHash)) continue
      const p = parseRelease(r.title)
      if (p.episode === episode && seriesKeys(p.series).some((k) => keys.has(k))) found.set(r.infoHash, r)
    }
  }
  // Most seeders first, but never swap subtitles for a dub-only upload unless that's
  // what's playing; between equals, the same resolution as now.
  const isDub = (title: string): boolean => /\bdub(bed)?\b/i.test(title) && !/\b(dual|multi)[- ]?audio\b/i.test(title)
  const dubNow = isDub(ep?.title ?? '') || isDub(current.name)
  const fits = (r: NyaaResult): number => (isDub(r.title) === dubNow ? 1 : 0)
  const sameRes = (r: NyaaResult): number => (parseRelease(r.title).resolution === parsed.resolution ? 1 : 0)
  const best = [...found.values()].sort(
    (a, b) => fits(b) - fits(a) || b.seeders - a.seeders || sameRes(b) - sameRes(a)
  )[0]
  if (!best) throw new Error(`No other upload of episode ${episode} with seeders was found on nyaa.`)

  const info = await getTorrentInfo(nyaaBaseUrl, best.torrentUrl)
  const videos = info.files.filter((f) => VIDEO_EXT.test(f.path))
  const video =
    videos.length === 1 ? videos[0] : videos.find((f) => parseRelease(basename(f.path)).episode === episode)
  if (!video) throw new Error(`Couldn't find episode ${episode} in ${best.title}.`)

  // The search takes a while; if playback stopped or moved on meanwhile, leave it be.
  const stillPlaying = (): boolean => {
    const now = getPlayerState()
    return now.open && now.torrentId === torrentId && now.fileIndex === fileIndex
  }
  if (!stillPlaying()) throw new Error('Playback moved on, so the upload was left as it is.')

  const folder = ep?.folder_id != null ? await resolveFolder({ id: ep.folder_id }) : null
  const added = await addStream({ torrentUrl: best.torrentUrl, nyaaId: best.id, fileIndexes: [video.index] }, folder)
  const newId = added.id

  // Checked again before the library changes, with no waiting from here to play():
  // if playback moved on while the upload was added, the library stays as it was.
  if (!stillPlaying()) {
    if (!added.existed) db.prepare('DELETE FROM episodes WHERE torrent_id = ?').run(newId)
    await pruneStreamTorrents()
    throw new Error('Playback moved on, so the upload was left as it is.')
  }
  const at = getPlayerState().timePos || timePos

  // The new upload takes over the episode: its watch state, resume position (kept
  // even if another start cancels this one), and its place in a followed series.
  db.prepare(
    `UPDATE episodes SET episode_num = ?, position_sec = ?,
       watched = (SELECT watched FROM episodes WHERE torrent_id = ? AND file_index = ?)
     WHERE torrent_id = ? AND file_index = ?`
  ).run(episode, at, torrentId, fileIndex, newId, video.index)
  db.prepare(
    `UPDATE releases SET nyaa_id = ?, title = ?, torrent_url = ?, info_hash = ?, size_bytes = ?, published_at = ?, seeders = ?
     WHERE info_hash = ?`
  ).run(best.id, best.title, best.torrentUrl, best.infoHash, best.sizeBytes, Date.parse(best.pubDate), best.seeders, current.infoHash)
  // A downloaded copy stays; one that was only streamed leaves the library with its torrent.
  if (!isKept(torrentId, fileIndex)) {
    db.prepare('DELETE FROM episodes WHERE torrent_id = ? AND file_index = ?').run(torrentId, fileIndex)
  }

  await play(newId, video.index, at, true)
  await pruneStreamTorrents()
  return best.title
}

/** Keys for a series name and the titles inside it: "Tempal (Overgeared) S2" also matches "Overgeared S2". */
function seriesKeys(series: string): string[] {
  const { base, season } = splitSeason(series)
  const suffix = season > 1 ? ` S${season}` : ''
  const variants = [base, base.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '), ...[...base.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])]
  return [...new Set(variants.map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean))].map((v) => seriesKey(v + suffix))
}
