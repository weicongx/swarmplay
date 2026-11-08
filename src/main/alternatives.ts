import { basename } from 'path'
import { VIDEO_EXT } from '@shared/types'
import { getDb, getSettings } from './db'
import { folderTitles, resolveFolder } from './library'
import { getTorrentInfo } from './nyaa'
import { activePlayback } from './playback'
import { getPlayerState, play } from './player'
import { parseRelease } from './release'
import { addStream, isKept, pruneStreamTorrents, torrentIdentity } from './torrent'
import { otherUploads } from './uploads'

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
  // so uploads that use another language's title still match. Most seeders first,
  // but never subtitles swapped for a dub-only upload unless that's what's
  // playing; between equals, the same resolution as now.
  const { nyaaBaseUrl } = getSettings()
  const [best] = await otherUploads({
    episode,
    names: [parsed.series, parseRelease(current.name).series, ...(ep?.folder_id != null ? folderTitles(ep.folder_id) : [])],
    infoHash: current.infoHash,
    titles: [ep?.title ?? '', current.name],
    resolution: parsed.resolution
  })
  if (!best) throw new Error(`No other upload of episode ${episode} with seeders was found on nyaa.`)

  const info = await getTorrentInfo(nyaaBaseUrl, best.torrentUrl)
  const videos = info.files.filter((f) => VIDEO_EXT.test(f.path))
  const video =
    videos.length === 1 ? videos[0] : videos.find((f) => parseRelease(basename(f.path)).episode === episode)
  if (!video) throw new Error(`Couldn't find episode ${episode} in ${best.title}.`)

  // The search takes a while; if playback stopped or moved on meanwhile (a phone
  // taking over included), leave it be.
  const stillPlaying = (): boolean => {
    const now = activePlayback()
    return now?.owner.kind === 'pc' && now.torrentId === torrentId && now.fileIndex === fileIndex
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
