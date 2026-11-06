import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AddTorrentRequest, NyaaSearchParams, Settings } from '@shared/types'
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

  ipcMain.handle('torrents:add', (_e, req: AddTorrentRequest) => addTorrent(req))
  ipcMain.handle('torrents:list', () => listTorrents())
  ipcMain.handle('torrents:pause', (_e, id: number) => pauseTorrent(id))
  ipcMain.handle('torrents:resume', (_e, id: number) => resumeTorrent(id))
  ipcMain.handle('torrents:remove', (_e, id: number, deleteFiles: boolean) =>
    removeTorrent(id, deleteFiles === true)
  )
  ipcMain.handle('torrents:showInFolder', (_e, id: number) => showTorrentInFolder(id))

  ipcMain.handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
}
