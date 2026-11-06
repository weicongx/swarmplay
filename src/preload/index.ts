import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppApi, PlayerState, TorrentStatusInfo } from '@shared/types'

const api: AppApi = {
  searchNyaa: (params) => ipcRenderer.invoke('nyaa:search', params),
  getTorrentInfo: (torrentUrl) => ipcRenderer.invoke('nyaa:torrentInfo', torrentUrl),
  getRecentSearches: () => ipcRenderer.invoke('search:recent'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  addTorrent: (req) => ipcRenderer.invoke('torrents:add', req),
  listTorrents: () => ipcRenderer.invoke('torrents:list'),
  pauseTorrent: (id) => ipcRenderer.invoke('torrents:pause', id),
  resumeTorrent: (id) => ipcRenderer.invoke('torrents:resume', id),
  removeTorrent: (id, deleteFiles) => ipcRenderer.invoke('torrents:remove', id, deleteFiles),
  showTorrentInFolder: (id) => ipcRenderer.invoke('torrents:showInFolder', id),

  play: (torrentId, fileIndex) => ipcRenderer.invoke('player:play', torrentId, fileIndex),
  playerCommand: (cmd) => ipcRenderer.invoke('player:command', cmd),
  getPlayerState: () => ipcRenderer.invoke('player:getState'),
  onPlayerState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: PlayerState): void => cb(s)
    ipcRenderer.on('player:state', listener)
    return () => ipcRenderer.removeListener('player:state', listener)
  },
  setVideoBounds: (rect) => ipcRenderer.send('player:bounds', rect),
  streamNow: (req, fileIndex) => ipcRenderer.invoke('player:streamNow', req, fileIndex),
  setWatched: (torrentId, fileIndex, watched) =>
    ipcRenderer.invoke('player:setWatched', torrentId, fileIndex, watched),
  getPlayerInfo: () => ipcRenderer.invoke('player:info'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  pickMpv: () => ipcRenderer.invoke('dialog:pickMpv'),

  getLibrary: () => ipcRenderer.invoke('library:get'),
  createFolder: (name, parentId) => ipcRenderer.invoke('library:createFolder', name, parentId),
  renameFolder: (id, name) => ipcRenderer.invoke('library:renameFolder', id, name),
  deleteFolder: (id, deleteDownloads) => ipcRenderer.invoke('library:deleteFolder', id, deleteDownloads),
  moveFolder: (id, parentId) => ipcRenderer.invoke('library:moveFolder', id, parentId),
  moveEpisodes: (ids, folderId) => ipcRenderer.invoke('library:moveEpisodes', ids, folderId),
  downloadEpisode: (episodeId) => ipcRenderer.invoke('library:downloadEpisode', episodeId),
  deleteEpisode: (episodeId, removeFromLibrary) =>
    ipcRenderer.invoke('library:deleteEpisode', episodeId, removeFromLibrary),
  dismissRelease: (releaseId) => ipcRenderer.invoke('releases:dismiss', releaseId),
  suggestFolder: (series) => ipcRenderer.invoke('library:suggestFolder', series),
  searchAniList: (query) => ipcRenderer.invoke('anilist:search', query),
  linkFolder: (folderId, anilistId) => ipcRenderer.invoke('library:linkFolder', folderId, anilistId),
  followSeries: (release, folder) => ipcRenderer.invoke('follows:follow', release, folder),
  checkFollow: (followId) => ipcRenderer.invoke('follows:check', followId),
  unfollow: (followId) => ipcRenderer.invoke('follows:unfollow', followId),
  downloadRelease: (releaseId) => ipcRenderer.invoke('releases:download', releaseId),
  streamRelease: (releaseId) => ipcRenderer.invoke('releases:stream', releaseId),
  onNavigate: (cb) => {
    const listener = (_e: IpcRendererEvent, to: Parameters<typeof cb>[0]): void => cb(to)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  onTorrentsUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, list: TorrentStatusInfo[]): void => cb(list)
    ipcRenderer.on('torrents:update', listener)
    return () => ipcRenderer.removeListener('torrents:update', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
