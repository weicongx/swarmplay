// Types shared by the main process, preload bridge, and renderer.

export const NYAA_CATEGORIES = [
  { id: '1_0', label: 'All anime' },
  { id: '1_2', label: 'English-translated' },
  { id: '1_3', label: 'Non-English-translated' },
  { id: '1_4', label: 'Raw' },
  { id: '1_1', label: 'Music video' }
] as const

export const NYAA_FILTERS = [
  { id: 0, label: 'No filter' },
  { id: 1, label: 'No remakes' },
  { id: 2, label: 'Trusted only' }
] as const

export interface NyaaSearchParams {
  query: string
  category: string
  filter: number
}

export interface NyaaResult {
  id: number
  title: string
  torrentUrl: string
  viewUrl: string
  /** ISO 8601 */
  pubDate: string
  seeders: number
  leechers: number
  downloads: number
  infoHash: string
  categoryId: string
  category: string
  /** Human-readable, as nyaa reports it ("1.4 GiB") */
  size: string
  sizeBytes: number
  trusted: boolean
  remake: boolean
  comments: number
}

export interface TorrentFileEntry {
  /** Position in the torrent's file list */
  index: number
  /** Relative path; multi-file torrents start with the torrent's folder name */
  path: string
  length: number
}

export interface TorrentInfo {
  name: string
  files: TorrentFileEntry[]
  totalLength: number
  trackers: string[]
  /** Series name parsed from the release name, used to suggest a library folder */
  series: string
}

export type TorrentStatus = 'starting' | 'downloading' | 'seeding' | 'done' | 'paused' | 'error'

export interface TorrentFileStatus {
  /** Index in the torrent's file list (stable; what selection uses). */
  index: number
  path: string
  length: number
  progress: number
  selected: boolean
  /** Local HTTP URL that streams the file while it downloads; null when the torrent isn't active. */
  streamUrl: string | null
  isVideo: boolean
  /** Saved playback position in seconds (0 if never played or finished) */
  positionSec: number
  durationSec: number | null
  watched: boolean
}

export interface TorrentStatusInfo {
  id: number
  infoHash: string
  name: string
  savePath: string
  status: TorrentStatus
  error: string | null
  /** 0–1 over the selected files only */
  progress: number
  downloaded: number
  /** Total size of the selected files */
  length: number
  downloadSpeed: number
  uploadSpeed: number
  uploaded: number
  numPeers: number
  /** Seconds, or null when unknown */
  timeRemaining: number | null
  addedAt: number
  files: TorrentFileStatus[]
}

export interface AddTorrentRequest {
  torrentUrl: string
  nyaaId?: number
  /** Files to download; omitted means every file. */
  fileIndexes?: number[]
  /** Library folder for the new episodes: an existing one, or a new one to create. */
  folder?: { id: number } | { name: string; parentId?: number | null }
}

export interface FolderInfo {
  id: number
  name: string
  parentId: number | null
  createdAt: number
  /** The AniList entry this folder is linked to, if any */
  anilist: AniListMedia | null
}

export interface EpisodeInfo {
  id: number
  folderId: number | null
  torrentId: number
  fileIndex: number
  /** File name */
  title: string
  episodeNum: number | null
  sizeBytes: number
  positionSec: number
  durationSec: number | null
  watched: boolean
  lastPlayedAt: number | null
}

export interface LibraryData {
  folders: FolderInfo[]
  episodes: EpisodeInfo[]
}

export interface AddTorrentResult {
  id: number
  /** True when the torrent was already in Downloads (new files are merged into its selection). */
  existed: boolean
}

export interface Settings {
  nyaaBaseUrl: string
  defaultCategory: string
  defaultFilter: number
  libraryRoot: string
  seedAfterDownload: boolean
  /** KiB/s, 0 = unlimited */
  downloadLimitKiB: number
  /** KiB/s, 0 = unlimited */
  uploadLimitKiB: number
  /** Full path to mpv.exe; empty means find it automatically */
  mpvPath: string
  /** Play the torrent's next episode when one finishes */
  autoplayNext: boolean
  /** Closing the window hides it to the tray so downloads and seeding continue */
  closeToTray: boolean
  /** Show a Windows notification when an episode finishes downloading */
  notifyOnDownload: boolean
  upscaler: Upscaler
}

/**
 * Real-time upscaling in mpv. `anime4k` runs Anime4K's GPU shaders (made for
 * anime line art); `rtx` uses NVIDIA's RTX Video Super Resolution in the driver.
 */
export type Upscaler = 'off' | 'anime4k' | 'rtx'

export interface AniListMedia {
  id: number
  /** Romaji title */
  title: string
  english: string | null
  format: string | null
  year: number | null
  episodes: number | null
  coverUrl: string | null
  /** Accent color of the cover, e.g. "#e4a15d" */
  color: string | null
}

export interface PlayerTrack {
  id: number
  title: string | null
  lang: string | null
  codec: string | null
  selected: boolean
}

/** What the in-app player is doing, pushed from the main process. */
export interface PlayerState {
  open: boolean
  torrentId: number | null
  fileIndex: number | null
  /** File name */
  title: string
  /** Library folder, e.g. "Sousou no Frieren S2" */
  series: string | null
  /** "Episode 5", or the file name when unnumbered */
  episodeLabel: string | null
  timePos: number
  duration: number | null
  paused: boolean
  /** Waiting for torrent pieces */
  buffering: boolean
  volume: number
  muted: boolean
  audioTracks: PlayerTrack[]
  subTracks: PlayerTrack[]
  hasNext: boolean
  fullscreen: boolean
  upscaler: Upscaler
  error: string | null
}

export type PlayerCommand =
  | { type: 'toggle-pause' }
  | { type: 'seek'; seconds: number }
  | { type: 'seek-by'; seconds: number }
  | { type: 'volume'; value: number }
  | { type: 'toggle-mute' }
  | { type: 'audio'; id: number }
  /** id null turns subtitles off */
  | { type: 'sub'; id: number | null }
  | { type: 'next' }
  | { type: 'close' }
  | { type: 'fullscreen'; on?: boolean }
  /** Also saved as the default for future episodes */
  | { type: 'upscaler'; mode: Upscaler }

/** Where the video should appear, in CSS pixels relative to the page. */
export interface VideoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PlayerInfo {
  /** The mpv.exe that will be used, or null if none was found */
  mpvPath: string | null
  /** An NVIDIA GPU is present, so RTX Video Super Resolution may be available */
  nvidia: boolean
}

export const VIDEO_EXT = /\.(mkv|mp4|avi|webm|m4v|mov|ts|wmv)$/i

/** Playback only resumes from a saved position past this many seconds. */
export const RESUME_MIN_SEC = 10

/** The API the preload script exposes on `window.api`. */
export interface AppApi {
  searchNyaa(params: NyaaSearchParams): Promise<NyaaResult[]>
  getTorrentInfo(torrentUrl: string): Promise<TorrentInfo>
  getRecentSearches(): Promise<string[]>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickFolder(): Promise<string | null>
  openExternal(url: string): Promise<void>

  addTorrent(req: AddTorrentRequest): Promise<AddTorrentResult>
  listTorrents(): Promise<TorrentStatusInfo[]>
  pauseTorrent(id: number): Promise<void>
  resumeTorrent(id: number): Promise<void>
  removeTorrent(id: number, deleteFiles: boolean): Promise<void>
  showTorrentInFolder(id: number): Promise<void>

  /** Open a file of a torrent in the in-app player, streaming it if it isn't fully downloaded. */
  play(torrentId: number, fileIndex: number): Promise<void>
  playerCommand(cmd: PlayerCommand): Promise<void>
  getPlayerState(): Promise<PlayerState>
  onPlayerState(cb: (state: PlayerState) => void): () => void
  /** Place the video over this part of the page; null hides it. */
  setVideoBounds(rect: VideoRect | null): void
  /** Add a torrent (if needed) and immediately start streaming one of its files. */
  streamNow(req: AddTorrentRequest, fileIndex: number): Promise<void>
  setWatched(torrentId: number, fileIndex: number, watched: boolean): Promise<void>
  getPlayerInfo(): Promise<PlayerInfo>
  pickMpv(): Promise<string | null>

  getLibrary(): Promise<LibraryData>
  createFolder(name: string, parentId: number | null): Promise<number>
  renameFolder(id: number, name: string): Promise<void>
  /** Episodes inside move to Unsorted; with deleteDownloads, torrents only used by this folder are removed with their files. */
  deleteFolder(id: number, deleteDownloads: boolean): Promise<void>
  moveFolder(id: number, parentId: number | null): Promise<void>
  /** folderId null moves them to Unsorted */
  moveEpisodes(episodeIds: number[], folderId: number | null): Promise<void>
  /** The folder a release with this series name belongs in, matching by name and AniList entry. */
  suggestFolder(series: string): Promise<{ folderId: number | null; name: string }>
  searchAniList(query: string): Promise<AniListMedia[]>
  /** anilistId null unlinks */
  linkFolder(folderId: number, anilistId: number | null): Promise<void>
  /** Main process asks the window to show a page, e.g. after a notification is clicked. */
  onNavigate(cb: (to: { page: 'library'; folderId: number | null }) => void): () => void
  /** Called about once a second with every torrent's status. Returns an unsubscribe function. */
  onTorrentsUpdate(cb: (torrents: TorrentStatusInfo[]) => void): () => void
}
