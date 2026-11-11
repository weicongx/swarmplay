// Remove in Downloads, keeping the files: a finished episode stays downloaded and leaves
// the list, an unfinished one goes back to streaming. Run it twice, with relaunch.ps1 in
// between: the second run checks that this outlasts a restart, and that downloading the
// episode again puts it back in Downloads. Run cleanup.js afterwards.
const FOLDER = 'ZZ Remove Test'
const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}
const episode = async (folder, num) =>
  (await window.api.getLibrary()).episodes.find((e) => e.folderId === folder.id && e.episodeNum === num)
const torrent = async (id) => (await window.api.listTorrents()).find((t) => t.id === id)
// What the Downloads page shows (its filter).
const inDownloads = (t) => t.streaming || (t.listed && t.files.some((f) => f.selected))

const { lib, folder } = await setup(FOLDER)
const removed = (await window.api.listTorrents()).find(
  (t) => !t.listed && lib.episodes.some((e) => e.folderId === folder.id && e.torrentId === t.id)
)

const { downloadLimitKiB } = await window.api.getSettings()
try {
  if (!removed) {
    const avail = lib.available.filter((a) => a.folderId === folder.id).sort((a, b) => a.sizeBytes - b.sizeBytes)
    assert(avail.length >= 2, 'Need two episodes not in the library yet')

    // A finished download.
    await window.api.setSettings({ downloadLimitKiB: 0 })
    await window.api.downloadRelease(avail[0].id)
    let ep = await waitFor(() => episode(folder, avail[0].episodeNum))
    await waitFor(async () => ((await torrent(ep.torrentId))?.progress ?? 0) >= 1, 900000, 1000)
    note(`Ep ${ep.episodeNum} downloaded (${(avail[0].sizeBytes / 2 ** 20).toFixed(0)} MiB)`)
    await window.api.removeTorrent(ep.torrentId, false)
    let t = await torrent(ep.torrentId)
    ep = await episode(folder, ep.episodeNum)
    note('Removed, keeping files:', { listed: t.listed, status: t.status, inDownloads: inDownloads(t), downloaded: ep.downloaded })
    assert(!inDownloads(t) && t.status === 'done', 'It is still in Downloads, or still running')
    assert(ep.downloaded && t.files[ep.fileIndex].progress >= 1, 'The finished episode is no longer downloaded')
    note('File:', t.savePath)

    // An unfinished one, slowly.
    await window.api.setSettings({ downloadLimitKiB: 50 })
    await window.api.downloadRelease(avail[1].id)
    let ep2 = await waitFor(() => episode(folder, avail[1].episodeNum))
    await waitFor(async () => ((await torrent(ep2.torrentId))?.downloaded ?? 0) > 0, 120000, 500)
    t = await torrent(ep2.torrentId)
    note(`Ep ${ep2.episodeNum} at ${(t.progress * 100).toFixed(1)}%, in ${t.savePath}`)
    await window.api.removeTorrent(ep2.torrentId, false)
    t = await torrent(ep2.torrentId)
    ep2 = await episode(folder, ep2.episodeNum)
    note('Removed, keeping files:', { inDownloads: inDownloads(t), downloaded: ep2.downloaded, savePath: t.savePath })
    assert(!inDownloads(t) && !ep2.downloaded, 'The unfinished episode is still a download')
    assert(t.savePath.includes('.swarmplay-streaming'), 'The unfinished episode did not go back to streaming')
    note('Now relaunch and run this again')
  } else {
    let ep = lib.episodes.find((e) => e.folderId === folder.id && e.torrentId === removed.id)
    note(`After a restart: Ep ${ep.episodeNum}`, { listed: removed.listed, status: removed.status, downloaded: ep.downloaded })
    assert(ep.downloaded && removed.status === 'done' && !inDownloads(removed), 'The removed download changed on restart')

    // Downloading it again (deleted first, as nothing else of it is left to keep) lists it again.
    await window.api.setSettings({ downloadLimitKiB: 50 })
    await window.api.deleteEpisode(ep.id, false)
    await window.api.downloadEpisode(ep.id)
    const t = await torrent(removed.id)
    note('Downloading again:', { listed: t.listed, status: t.status, inDownloads: inDownloads(t) })
    assert(t.listed && inDownloads(t), 'Downloading again did not bring it back to Downloads')
  }
} finally {
  await window.api.setSettings({ downloadLimitKiB })
}
return log.join('\n')
