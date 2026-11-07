// The phone companion: what the PC shows about it (Settings, tray, banner), and
// the API the phone page uses over HTTP.

export type AddressKind = 'home' | 'tailscale' | 'other'

/** An address the phone may reach the PC at */
export interface CompanionAddress {
  address: string
  kind: AddressKind
  /** The network adapter, e.g. "Wi-Fi" or "Tailscale" */
  adapter: string
}

export interface CompanionDevice {
  id: number
  name: string
  createdAt: number
  lastSeenAt: number | null
  lastIp: string | null
}

/** A phone's playback, as the PC shows it */
export interface CompanionSessionInfo {
  deviceId: number
  deviceName: string
  title: string
  series: string | null
  episodeLabel: string | null
  /** Still getting the episode ready */
  starting: boolean
}

export interface CompanionStatus {
  enabled: boolean
  port: number
  /** The server is listening */
  running: boolean
  /** Why it couldn't start, e.g. the port is in use */
  error: string | null
  addresses: CompanionAddress[]
  devices: CompanionDevice[]
  session: CompanionSessionInfo | null
  /** A pairing code waiting to be used */
  pairing: { code: string; expiresAt: number } | null
}

export interface CompanionPairing {
  code: string
  expiresAt: number
  /** A link and QR code for each address the phone might reach the PC at */
  links: { address: CompanionAddress; url: string; qrSvg: string }[]
}

// --- The phone page's API -----------------------------------------------------

export interface PhoneFolder {
  /** null: Unsorted */
  id: number | null
  name: string
  hasCover: boolean
  episodes: number
  watched: number
  /** A followed series' episodes on nyaa, not in the library yet */
  available: number
}

export interface PhoneEpisode {
  torrentId: number
  fileIndex: number
  folderId: number | null
  /** File name */
  title: string
  episodeNum: number | null
  watched: boolean
  positionSec: number
  durationSec: number | null
  downloaded: boolean
  lastPlayedAt: number | null
}

/** A followed series' episode that's on nyaa but not in the library yet */
export interface PhoneRelease {
  id: number
  folderId: number
  episodeNum: number
  title: string
  sizeBytes: number
  seeders: number | null
}

export interface PhoneLibrary {
  /** This phone's name, as paired */
  device: string
  /** The PC's name */
  pc: string
  folders: PhoneFolder[]
  episodes: PhoneEpisode[]
  available: PhoneRelease[]
  /** Episodes to pick up again, newest first */
  continueWatching: { torrentId: number; fileIndex: number }[]
}

export interface PhoneResult {
  id: number
  title: string
  size: string
  sizeBytes: number
  seeders: number
  leechers: number
  /** ISO 8601 */
  pubDate: string
  trusted: boolean
  remake: boolean
}

export interface PhoneSearchPage {
  results: PhoneResult[]
  page: number
  hasMore: boolean
  /** From nyaa's RSS feed: the newest 75 only */
  limited: boolean
}

export interface PhoneTorrent {
  name: string
  /** The series parsed from the release name */
  series: string
  /** The library folder it would go in */
  folderName: string
  files: { index: number; path: string; length: number; isVideo: boolean }[]
}

export interface PhonePlayResult {
  /** The video's address, for VLC */
  url: string
  /** Opens the video in VLC to stream it (VLC's x-callback link) */
  vlcUrl: string
  title: string
}

export type PhoneEndReason = 'stop' | 'takeover' | 'removed' | 'grace' | 'idle' | 'quit' | 'error'

export interface PhoneSession {
  torrentId: number
  fileIndex: number
  title: string
  series: string | null
  episodeLabel: string | null
  /** Still getting the episode ready */
  starting: boolean
  /** Playing a complete file from the PC's disk */
  local: boolean
  url: string | null
  vlcUrl: string | null
  numPeers: number
  downloadSpeed: number
  /** Parts of the file fetched, as [from, to] fractions of its length */
  fetched: [number, number][]
  /** How far VLC has read, as a fraction of the file */
  readTo: number
  /** Fetched past where VLC has read, as a fraction of the file */
  ahead: number
  /** Estimated from how far VLC has read; null without a duration */
  positionSec: number | null
  durationSec: number | null
  /** Where the duration came from: an earlier play on the PC, or the file's header */
  durationFrom: 'library' | 'mkv' | null
  /** Where it was saved at before this play; VLC starts from the beginning */
  resumeSec: number
  /** The subtitles VLC starts with, by name, when Swarmplay chose them; null otherwise */
  subtitles: string | null
  /** Open connections from VLC */
  connections: number
  watched: boolean
  next: { label: string } | null
}

export interface PhoneNow {
  session: PhoneSession | null
  /** How this phone's last playback ended, until it plays again */
  ended: {
    reason: PhoneEndReason
    /** Who took over, for `takeover` */
    by: 'pc' | 'phone' | null
    error: string | null
    torrentId: number
    fileIndex: number
    title: string
    watched: boolean
    next: { label: string } | null
  } | null
  /** Something else is playing: the PC, or another phone */
  busy: 'pc' | 'phone' | null
}

/** "Frieren · Episode 3", for the tray, the sidebar and Settings */
export function sessionTitle(s: { title: string; series: string | null; episodeLabel: string | null }): string {
  if (s.series && s.episodeLabel) return `${s.series} · ${s.episodeLabel}`
  return s.series ?? s.title
}
