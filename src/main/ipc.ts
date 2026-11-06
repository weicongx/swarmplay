import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AddTorrentRequest, NyaaSearchParams, PlayerCommand, Settings, VideoRect } from '@shared/types'
import { getRecentSearches, getSettings, recordSearch, setSettings } from './db'
import { getTorrentInfo, searchNyaa } from './nyaa'
import {
  addTorrent,
  applyLimits,
  listTorrents,
  pauseTorrent,
  removeTorrent,
  resumeTorrent,
  showTorrentInFolder
} from './torrent'
import { findMpv, getPlayerState, hasNvidiaGpu, play, playerCommand, setVideoBounds, setWatched } from './player'
import {
  createFolder,
  deleteFolder,
  getLibrary,
  linkFolder,
  moveEpisodes,
  moveFolder,
  renameFolder,
  resolveFolder,
  suggestFolder
} from './library'
import { searchAniList } from './anilist'

export function registerIpc(): void {
  ipcMain.handle('nyaa:search', async (_e, params: NyaaSearchParams) => {
    const { nyaaBaseUrl } = getSettings()
    if (params.query.trim()) recordSearch(params.query.trim())
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
    return settings
  })

  ipcMain.handle('torrents:add', async (_e, req: AddTorrentRequest) => addTorrent(req, await resolveFolder(req.folder)))
  ipcMain.handle('torrents:list', () => listTorrents())
  ipcMain.handle('torrents:pause', (_e, id: number) => pauseTorrent(id))
  ipcMain.handle('torrents:resume', (_e, id: number) => resumeTorrent(id))
  ipcMain.handle('torrents:remove', (_e, id: number, deleteFiles: boolean) =>
    removeTorrent(id, deleteFiles === true)
  )
  ipcMain.handle('torrents:showInFolder', (_e, id: number) => showTorrentInFolder(id))

  ipcMain.handle('player:play', (_e, torrentId: number, fileIndex: number) => play(torrentId, fileIndex))
  ipcMain.handle('player:command', (_e, cmd: PlayerCommand) => playerCommand(cmd))
  ipcMain.handle('player:getState', () => getPlayerState())
  ipcMain.on('player:bounds', (_e, rect: VideoRect | null) => setVideoBounds(rect))
  ipcMain.handle('player:streamNow', async (_e, req: AddTorrentRequest, fileIndex: number) => {
    const { id } = await addTorrent(req, await resolveFolder(req.folder))
    await play(id, fileIndex)
  })

  ipcMain.handle('library:get', () => getLibrary())
  ipcMain.handle('library:createFolder', (_e, name: string, parentId: number | null) => createFolder(name, parentId))
  ipcMain.handle('library:renameFolder', (_e, id: number, name: string) => renameFolder(id, name))
  ipcMain.handle('library:deleteFolder', (_e, id: number, deleteDownloads: boolean) =>
    deleteFolder(id, deleteDownloads === true)
  )
  ipcMain.handle('library:moveFolder', (_e, id: number, parentId: number | null) => moveFolder(id, parentId))
  ipcMain.handle('library:moveEpisodes', (_e, ids: number[], folderId: number | null) => moveEpisodes(ids, folderId))
  ipcMain.handle('library:suggestFolder', (_e, series: string) => suggestFolder(series))
  ipcMain.handle('library:linkFolder', (_e, folderId: number, anilistId: number | null) => linkFolder(folderId, anilistId))
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
