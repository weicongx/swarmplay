import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
  suggestFolder
} from './library'
import { searchAniList } from './anilist'
import { tryAnotherRelease } from './alternatives'
import { checkFollow, downloadRelease, followSeries, streamRelease, unfollow } from './follows'

export function registerIpc(): void {
  ipcMain.handle('nyaa:search', async (_e, params: NyaaSearchParams) => {
    const { nyaaBaseUrl } = getSettings()
    if (params.query.trim() && (params.page ?? 1) === 1) recordSearch(params.query.trim())
    return searchNyaa(nyaaBaseUrl, params)
  })

  ipcMain.handle('nyaa:torrentInfo', async (_e, torrentUrl: string) => {
    return getTorrentInfo(getSettings().nyaaBaseUrl, torrentUrl)
  })

  ipcMain.handle('search:recent', () => getRecentSearches())
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const settings = setSettings(patch)
    applyLimits()
    if ('streamCacheGB' in patch) void trimStreamCache()
    return settings
  })

  ipcMain.handle('torrents:add', (_e, req: AddTorrentRequest) => addToFolder(req.folder, (folder) => addTorrent(req, folder)))
  ipcMain.handle('torrents:list', () => listTorrents())
  ipcMain.handle('torrents:pause', (_e, id: number) => pauseTorrent(id))
  ipcMain.handle('torrents:resume', (_e, id: number) => resumeTorrent(id))
  ipcMain.handle('torrents:remove', (_e, id: number, deleteFiles: boolean) => {
    if (deleteFiles === true) closeIfPlaying(id)
    return removeDownload(id, deleteFiles === true)
  })
  ipcMain.handle('torrents:showInFolder', (_e, id: number) => showTorrentInFolder(id))
  ipcMain.handle('torrents:streamCacheSize', () => streamCacheSize())

  ipcMain.handle('player:play', (_e, torrentId: number, fileIndex: number) => play(torrentId, fileIndex))
  ipcMain.handle('player:command', (_e, cmd: PlayerCommand) => playerCommand(cmd))
  ipcMain.handle('player:getState', () => getPlayerState())
  ipcMain.handle('player:tryAnother', () => tryAnotherRelease())
  ipcMain.on('player:bounds', (_e, rect: VideoRect | null) => setVideoBounds(rect))
  ipcMain.handle('player:streamNow', async (_e, req: AddTorrentRequest, fileIndex: number) => {
    const { id } = await addToFolder(req.folder, (folder) => addStream(req, folder))
    await play(id, fileIndex)
  })

  ipcMain.handle('library:get', () => getLibrary())
  ipcMain.handle('library:refreshSeeders', (_e, folderId: number) => refreshFolderSeeders(folderId))
  ipcMain.handle('updates:get', () => getUpdateStatus())
  ipcMain.handle('updates:check', () => checkForUpdate())
  ipcMain.handle('updates:install', () => installUpdate())
  ipcMain.handle('library:createFolder', (_e, name: string, parentId: number | null) => createFolder(name, parentId))
  ipcMain.handle('library:renameFolder', (_e, id: number, name: string) => renameFolder(id, name))
  ipcMain.handle('library:deleteFolder', (_e, id: number, deleteDownloads: boolean) =>
    deleteFolder(id, deleteDownloads === true)
  )
  ipcMain.handle('library:moveFolder', (_e, id: number, parentId: number | null) => moveFolder(id, parentId))
  ipcMain.handle('library:moveEpisodes', (_e, ids: number[], folderId: number | null) => moveEpisodes(ids, folderId))
  ipcMain.handle('library:downloadEpisode', (_e, id: number) => downloadEpisode(id))
  ipcMain.handle('library:deleteEpisode', (_e, id: number, remove: boolean) => {
    // mpv has to let go of the file before it can be deleted.
    closeIfPlaying(episodeSource(id).torrentId)
    return deleteEpisode(id, remove === true)
  })
  ipcMain.handle('releases:dismiss', (_e, id: number) => dismissRelease(id))
  ipcMain.handle('library:suggestFolder', (_e, series: string) => suggestFolder(series))
  ipcMain.handle('library:linkFolder', (_e, folderId: number, anilistId: number | null) => linkFolder(folderId, anilistId))
  ipcMain.handle('follows:follow', (_e, release: NyaaResult, folder: AddTorrentRequest['folder']) =>
    followSeries(release, folder)
  )
  ipcMain.handle('follows:check', (_e, id: number) => checkFollow(id))
  ipcMain.handle('follows:unfollow', (_e, id: number) => unfollow(id))
  ipcMain.handle('releases:download', (_e, id: number) => downloadRelease(id))
  ipcMain.handle('releases:stream', (_e, id: number) => streamRelease(id))
  ipcMain.handle('anilist:search', async (_e, query: string) => (await searchAniList(query)).map((c) => c.media))
  ipcMain.handle('player:setWatched', (_e, torrentId: number, fileIndex: number, watched: boolean) =>
    setWatched(torrentId, fileIndex, watched === true)
  )
  ipcMain.handle('player:info', async () => ({ mpvPath: findMpv(), nvidia: await hasNvidiaGpu() }))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('dialog:pickMpv', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'mpv', extensions: ['exe'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
}
