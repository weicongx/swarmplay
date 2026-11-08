// Types shared by the main process, preload bridge, and renderer.

import type { CompanionPairing, CompanionStatus } from './companion'

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

export type NyaaSort = 'date' | 'seeders' | 'downloads' | 'size'

export interface NyaaSearchParams {
  query: string
  category: string
  filter: number
  /** Highest first; default 'date' */
  sort?: NyaaSort
  /** 1-based, 75 results a page; default 1 */
  page?: number
}

export interface NyaaSearchPage {
  results: NyaaResult[]
  page: number
  /** Matches in all, as nyaa counts them (it stops counting at 1000) */
  total: number
  hasMore: boolean
  /** nyaa's search page couldn't be read, so these are RSS's newest 75, unsorted and without more pages */
  limited: boolean
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
  /** Several episodes (a batch), not one episode with extras */
  batch: boolean
}

/**
 * `streaming`: the player is streaming from a torrent with nothing kept.
 * `idle`: nothing kept and not streaming; it's only there for its library episodes.
 */
export type TorrentStatus = 'starting' | 'downloading' | 'seeding' | 'done' | 'paused' | 'error' | 'streaming' | 'idle'

export interface TorrentFileStatus {
  /** Index in the torrent's file list (stable; what selection uses). */
  index: number
  path: string
  length: number
  progress: number
  /** Downloaded to keep. Streamed files aren't selected. */
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
  /** The player is streaming a file from it that isn't kept */
  streaming: boolean
  /** File whose start is being fetched ahead because it plays next, or null */
  aheadFile: number | null
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
  /** Downloaded (or downloading) to keep; otherwise it plays by streaming. */
  downloaded: boolean
  positionSec: number
  durationSec: number | null
  watched: boolean
  lastPlayedAt: number | null
}

/** An episode of a followed series that's on nyaa but not downloaded. */
export interface AvailableEpisode {
  /** Release id, for streamRelease/downloadRelease */
  id: number
  folderId: number
  followId: number
  episodeNum: number
  /** nyaa release name */
  title: string
  sizeBytes: number
  publishedAt: number
  /** As of the last follow check; null when not known yet */
  seeders: number | null
}

/** A series whose new episodes are added to a folder as they're uploaded. */
export interface FollowInfo {
  id: number
  folderId: number
  group: string
  resolution: string | null
  checkedAt: number | null
  /** Why the last check failed, if it did */
  error: string | null
}

export interface LibraryData {
  folders: FolderInfo[]
  episodes: EpisodeInfo[]
  available: AvailableEpisode[]
  follows: FollowInfo[]
}

export interface FollowResult {
  folderId: number
  folderName: string
  /** Episodes in the folder that aren't downloaded yet */
  available: number
}

export interface AddTorrentResult {
  id: number
  /** True when the torrent was already in Downloads (new files are merged into its selection). */
  existed: boolean
  /** Where a batch spanning several seasons was filed */
  filed?: FiledBatch
}

/** A season of a show, as a batch's files map onto it. */
export interface BatchSeason {
  anilistId: number
  /** Folder name in the series folder, e.g. "Season 2 Part 2" */
  label: string
  /** AniList romaji title */
  title: string
  /** Its folder, if the library already has one */
  folderId: number | null
}

/** How a batch of a show with several seasons splits into a folder per season. */
export interface BatchPlan {
  /** The show's folder, holding a folder per season; null if it isn't in the library yet */
  series: { folderId: number | null; name: string }
  /** Seasons the batch's videos fall in, in airing order */
  seasons: BatchSeason[]
  /** Each video: its season (an index into `seasons`) and episode number within that season */
  files: { index: number; season: number; episode: number | null }[]
}

export interface FiledBatch {
  folderId: number
  name: string
  seasons: { label: string; folderId: number; episodes: number }[]
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
  /** Show a Windows notification when a followed series gets a new episode */
  notifyNewEpisodes: boolean
  upscaler: Upscaler
  /** Skip chapters named OP/Opening (and ED/Ending) without asking */
  autoSkip: 'off' | 'openings' | 'both'
  /** When a stream is slow, switch to another upload of the episode without asking (once per episode) */
  autoTryAnother: boolean
  /** Look for a new version on GitHub at launch and every few hours */
  autoUpdateCheck: boolean
  /** Keep this many GB of recently streamed episodes for replay; 0 deletes each stream when it ends */
  streamCacheGB: number
  /** Serve the phone companion page to paired phones. Changed only through the companion's own calls. */
  companionEnabled: boolean
  companionPort: number
}

export interface UpdateStatus {
  /** The running version */
  current: string
  /** A newer release on GitHub, if one was found */
  available: { version: string; notes: string; size: number } | null
  phase: 'idle' | 'checking' | 'downloading' | 'installing'
  /** 0–1 while downloading */
  progress: number
  error: string | null
  checkedAt: number | null
  /** Updates install only in the installed app, not when running from source */
  supported: boolean
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
  /** Plain-text synopsis; null if AniList has none, undefined if not fetched yet */
  description?: string | null
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
  /** Of the torrent being played from; 0 when playing from disk */
  downloadSpeed: number
  numPeers: number
  /** Stuck buffering, or no peers: worth trying another release */
  slow: boolean
  /** The opening or ending chapter playing now; `to` is the next chapter's start, null for the end of the file */
  skip: { kind: 'opening' | 'ending'; to: number | null } | null
  /** Playing a complete file from disk, not streaming */
  local: boolean
  /** Parts of the file fetched so far, as [from, to] fractions of its length */
  fetched: [number, number][]
  volume: number
  muted: boolean
  audioTracks: PlayerTrack[]
  subTracks: PlayerTrack[]
  hasNext: boolean
  /** Started by autoplay or a release switch rather than the user, so the view (mini or full) stays as it is */
  continued: boolean
  fullscreen: boolean
  upscaler: Upscaler
  error: string | null
}

export type PlayerCommand =
  | { type: 'toggle-pause' }
  | { type: 'seek'; seconds: number }
  | { type: 'seek-by'; seconds: number }
  /**
   * The seek bar's spot under the cursor, or null once it leaves: a stream starts
   * fetching there, so a seek to it plays sooner. Doesn't move playback.
   */
  | { type: 'seek-preview'; seconds: number | null }
  | { type: 'volume'; value: number }
  | { type: 'toggle-mute' }
  | { type: 'audio'; id: number }
  /** id null turns subtitles off */
  | { type: 'sub'; id: number | null }
  | { type: 'next' }
  /** Past the opening or ending chapter playing now */
  | { type: 'skip-chapter' }
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
  searchNyaa(params: NyaaSearchParams): Promise<NyaaSearchPage>
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
  /** Remove from Downloads; its episodes stay in the library to stream. */
  removeTorrent(id: number, deleteFiles: boolean): Promise<void>
  showTorrentInFolder(id: number): Promise<void>

  /** Open a file of a torrent in the in-app player, streaming it if it isn't fully downloaded. */
  play(torrentId: number, fileIndex: number): Promise<void>
  playerCommand(cmd: PlayerCommand): Promise<void>
  getPlayerState(): Promise<PlayerState>
  onPlayerState(cb: (state: PlayerState) => void): () => void
  /**
   * Switch the playing episode to another upload of it (any group, most seeders
   * first), keeping the position. The library uses the new one from then on.
   * Returns the new release's name.
   */
  tryAnotherRelease(): Promise<string>
  /** Bytes in the stream folder, cached episodes included */
  getStreamCacheSize(): Promise<number>
  /** Update a folder's not-yet-added episodes' seeder counts from the tracker; true if any changed */
  refreshSeeders(folderId: number): Promise<boolean>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdate(): Promise<UpdateStatus>
  /** Download the new version, run its installer and restart */
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  /** Place the video over this part of the page; null hides it. */
  setVideoBounds(rect: VideoRect | null): void
  /**
   * Add the torrent's episodes to the library without downloading them and
   * start streaming one. Nothing is kept on disk after playback.
   */
  streamNow(req: AddTorrentRequest, fileIndex: number): Promise<void>
  setWatched(torrentId: number, fileIndex: number, watched: boolean): Promise<void>
  getPlayerInfo(): Promise<PlayerInfo>
  pickMpv(): Promise<string | null>
  getVersion(): Promise<string>

  getLibrary(): Promise<LibraryData>
  createFolder(name: string, parentId: number | null): Promise<number>
  renameFolder(id: number, name: string): Promise<void>
  /** Episodes inside move to Unsorted; with deleteDownloads, torrents only used by this folder are removed with their files. */
  deleteFolder(id: number, deleteDownloads: boolean): Promise<void>
  moveFolder(id: number, parentId: number | null): Promise<void>
  /** folderId null moves them to Unsorted */
  moveEpisodes(episodeIds: number[], folderId: number | null): Promise<void>
  /** Download an episode that was only streamed, to keep it. */
  downloadEpisode(episodeId: number): Promise<void>
  /** Download every episode in a folder and the folders inside it that isn't kept yet. */
  downloadFolder(folderId: number): Promise<void>
  /**
   * Delete an episode's downloaded file; it stays in the library to stream.
   * With removeFromLibrary it leaves the library too (the series stays).
   */
  deleteEpisode(episodeId: number, removeFromLibrary: boolean): Promise<void>
  /** Hide a followed series' episode that isn't downloaded. */
  dismissRelease(releaseId: number): Promise<void>
  /** The folder a release with this series name belongs in, matching by name and AniList entry. */
  suggestFolder(series: string): Promise<{ folderId: number | null; name: string }>
  /** How a batch would split into seasons, or null if it isn't a batch of a show with several. */
  planBatch(torrentUrl: string): Promise<BatchPlan | null>
  /** Add a torrent's episodes to the library to stream, without playing or downloading them. */
  addToLibrary(req: AddTorrentRequest): Promise<AddTorrentResult>
  searchAniList(query: string): Promise<AniListMedia[]>
  /** anilistId null unlinks */
  linkFolder(folderId: number, anilistId: number | null): Promise<void>
  /**
   * Follow the series this release belongs to (same group, series, season and
   * resolution): its other episodes go into the folder without downloading, and
   * new ones are added as they're uploaded.
   */
  followSeries(release: NyaaResult, folder: AddTorrentRequest['folder']): Promise<FollowResult>
  /** Search nyaa for new episodes now; returns how many were added. */
  checkFollow(followId: number): Promise<number>
  /** Stop following; episodes not downloaded leave the library, downloaded ones stay. */
  unfollow(followId: number): Promise<void>
  downloadRelease(releaseId: number): Promise<void>
  /** Add the release's torrent and start playing it while it downloads. */
  streamRelease(releaseId: number): Promise<void>
  /** Main process asks the window to show a page, e.g. after a notification is clicked. */
  onNavigate(cb: (to: { page: 'library' | 'settings'; folderId: number | null }) => void): () => void
  /** Called about once a second with every torrent's status. Returns an unsubscribe function. */
  onTorrentsUpdate(cb: (torrents: TorrentStatusInfo[]) => void): () => void

  // The phone companion
  getCompanion(): Promise<CompanionStatus>
  /** Starts or stops its server; a busy port comes back as `error`, with it left off. */
  setCompanionEnabled(on: boolean): Promise<CompanionStatus>
  setCompanionPort(port: number): Promise<CompanionStatus>
  /** A new one-time code, valid for 5 minutes, with a QR code for each address */
  pairPhone(): Promise<CompanionPairing>
  cancelPairing(): Promise<void>
  /** Its cookie and video links stop working at once, and its playback ends. */
  removePhone(id: number): Promise<void>
  removeAllPhones(): Promise<void>
  /** Stop what a phone is playing */
  stopPhone(): Promise<void>
  /** Called when the companion's status, devices or phone playback change */
  onCompanionUpdate(cb: (status: CompanionStatus) => void): () => void
}
