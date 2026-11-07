import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { AddTorrentRequest, NyaaResult, NyaaSearchParams, PlayerCommand, Settings, VideoRect } from '@shared/types'
import { getRecentSearches, getSettings, recordSearch, setSettings } from './db'
import { getTorrentInfo, searchNyaa } from './nyaa'
import { refreshFolderSeeders } from './scrape'
import { checkForUpdate, getUpdateStatus, installUpdate } from './updates'
import {
  addStream,
  addTorrent,
  applyLimits,
  listTorrents,
  pauseTorrent,
  isKept,
  removeDownload,
  resumeTorrent,
  showTorrentInFolder,
  streamCacheSize,
  trimStreamCache
} from './torrent'
import {
  closeIfPlaying,
  findMpv,
  getPlayerState,
  hasNvidiaGpu,
  play,
  playerCommand,
  setVideoBounds,
  setWatched
} from './player'
import {
  addToFolder,
  createFolder,
  deleteEpisode,
  deleteFolder,
  dismissRelease,
  downloadEpisode,
  episodeSource,
  getLibrary,
  linkFolder,
  moveEpisodes,
  moveFolder,
  renameFolder,
  suggestFolder,
  torrentsOnlyIn
} from './library'
import { activePlayback } from './playback'
import { searchAniList } from './anilist'
import { tryAnotherRelease } from './alternatives'
import { checkFollow, downloadRelease, followSeries, streamRelease, unfollow } from './follows'
import {
  cancelPhonePairing,
  companionStatus,
  pairPhone,
  removeAllPhones,
  removePhone,
  setCompanionEnabled,
  setCompanionPort,
  stopPhone
} from './companion'

/** Only the app's own page may call in; the window never navigates elsewhere, but check anyway. */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && dev && url.startsWith(dev)) return true
  return url.startsWith('file:') && /[\\/]renderer[\\/]index\.html(?:[?#].*)?$/.test(decodeURIComponent(url))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Not allowed')
    return fn(e, ...args)
  })
}

/** An episode of this torrent is playing, on the PC or a phone. */
function playingFrom(torrentId: number): boolean {
  return activePlayback()?.torrentId === torrentId
}

export function registerIpc(): void {
  handle('nyaa:search', async (_e, params: NyaaSearchParams) => {
    const { nyaaBaseUrl } = getSettings()
    if (params.query.trim() && (params.page ?? 1) === 1) recordSearch(params.query.trim())
    return searchNyaa(nyaaBaseUrl, params)
  })

  handle('nyaa:torrentInfo', async (_e, torrentUrl: string) => {
    return getTorrentInfo(getSettings().nyaaBaseUrl, torrentUrl)
  })

  handle('search:recent', () => getRecentSearches())
  handle('settings:get', () => getSettings())
  handle('settings:set', (_e, patch: Partial<Settings>) => {
    // Only the companion's own calls turn it on or change its port, since that starts or stops its server.
    const { companionEnabled: _on, companionPort: _port, ...rest } = patch
    const settings = setSettings(rest)
    applyLimits()
    if ('streamCacheGB' in patch) void trimStreamCache()
    return settings
  })

  handle('torrents:add', (_e, req: AddTorrentRequest) => addToFolder(req.folder, (folder) => addTorrent(req, folder)))
  handle('torrents:list', () => listTorrents())
  handle('torrents:pause', (_e, id: number) => {
    // Pausing stops the torrent, which would cut off the episode playing from it.
    if (playingFrom(id)) throw new Error("This download is playing. Stop playback to pause it.")
    return pauseTorrent(id)
  })
  handle('torrents:resume', (_e, id: number) => resumeTorrent(id))
  handle('torrents:remove', (_e, id: number, deleteFiles: boolean) => {
    // Removing stops the torrent (and may delete the file), so playback from it ends first.
    closeIfPlaying(id)
    return removeDownload(id, deleteFiles === true)
  })
  handle('torrents:showInFolder', (_e, id: number) => showTorrentInFolder(id))
  handle('torrents:streamCacheSize', () => streamCacheSize())

  handle('player:play', (_e, torrentId: number, fileIndex: number) => play(torrentId, fileIndex))
  handle('player:command', (_e, cmd: PlayerCommand) => playerCommand(cmd))
  handle('player:getState', () => getPlayerState())
  handle('player:tryAnother', () => tryAnotherRelease())
  ipcMain.on('player:bounds', (e, rect: VideoRect | null) => trusted(e) && setVideoBounds(rect))
  handle('player:streamNow', async (_e, req: AddTorrentRequest, fileIndex: number) => {
    const { id } = await addToFolder(req.folder, (folder) => addStream(req, folder))
    await play(id, fileIndex)
  })

  handle('library:get', () => getLibrary())
  handle('library:refreshSeeders', (_e, folderId: number) => refreshFolderSeeders(folderId))
  handle('updates:get', () => getUpdateStatus())
  handle('updates:check', () => checkForUpdate())
  handle('updates:install', () => installUpdate())
  handle('library:createFolder', (_e, name: string, parentId: number | null) => createFolder(name, parentId))
  handle('library:renameFolder', (_e, id: number, name: string) => renameFolder(id, name))
  handle('library:deleteFolder', (_e, id: number, deleteDownloads: boolean) => {
    // Its downloads can't be deleted while mpv has one open.
    if (deleteDownloads === true) for (const torrentId of torrentsOnlyIn(id)) closeIfPlaying(torrentId)
    return deleteFolder(id, deleteDownloads === true)
  })
  handle('library:moveFolder', (_e, id: number, parentId: number | null) => moveFolder(id, parentId))
  handle('library:moveEpisodes', (_e, ids: number[], folderId: number | null) => moveEpisodes(ids, folderId))
  handle('library:downloadEpisode', (_e, id: number) => downloadEpisode(id))
  handle('library:deleteEpisode', (_e, id: number, remove: boolean) => {
    // mpv has to let go of the file before it can be deleted. Deleting a download
    // also restarts its torrent, which cuts off a stream of another of its episodes.
    const src = episodeSource(id)
    const a = activePlayback()
    if (a && a.torrentId === src.torrentId && (a.fileIndex === src.fileIndex || (!a.local && isKept(src.torrentId, src.fileIndex)))) {
      closeIfPlaying(src.torrentId)
    }
    return deleteEpisode(id, remove === true)
  })
  handle('releases:dismiss', (_e, id: number) => dismissRelease(id))
  handle('library:suggestFolder', (_e, series: string) => suggestFolder(series))
  handle('library:linkFolder', (_e, folderId: number, anilistId: number | null) => linkFolder(folderId, anilistId))
  handle('follows:follow', (_e, release: NyaaResult, folder: AddTorrentRequest['folder']) =>
    followSeries(release, folder)
  )
  handle('follows:check', (_e, id: number) => checkFollow(id))
  handle('follows:unfollow', (_e, id: number) => unfollow(id))
  handle('releases:download', (_e, id: number) => downloadRelease(id))
  handle('releases:stream', (_e, id: number) => streamRelease(id))
  handle('anilist:search', async (_e, query: string) => (await searchAniList(query)).map((c) => c.media))
  handle('player:setWatched', (_e, torrentId: number, fileIndex: number, watched: boolean) =>
    setWatched(torrentId, fileIndex, watched === true)
  )
  handle('player:info', async () => ({ mpvPath: findMpv(), nvidia: await hasNvidiaGpu() }))
  handle('app:version', () => app.getVersion())

  handle('companion:get', () => companionStatus())
  handle('companion:setEnabled', (_e, on: boolean) => setCompanionEnabled(on === true))
  handle('companion:setPort', (_e, port: number) => setCompanionPort(Number(port)))
  handle('companion:pair', () => pairPhone())
  handle('companion:cancelPair', () => cancelPhonePairing())
  handle('companion:removeDevice', (_e, id: number) => removePhone(Number(id)))
  handle('companion:removeAll', () => removeAllPhones())
  handle('companion:stop', () => stopPhone())
  handle('dialog:pickMpv', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'mpv', extensions: ['exe'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
}
