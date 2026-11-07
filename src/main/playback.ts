// One owner of playback at a time, across the PC's player and phones. Every
// player registers here, so a guard (pausing a torrent, deleting a folder) asks
// one question, whoever is playing, and starting playback anywhere stops
// whatever played before. The newest explicit Play wins.

export type Owner = { kind: 'pc' } | { kind: 'phone'; deviceId: number }

export interface ActivePlayback {
  owner: Owner
  torrentId: number
  fileIndex: number
  /** Playing a complete file from disk, not streaming */
  local: boolean
}

/**
 * Why playback stops. `takeover`: another player is starting, and its own
 * start takes over (or ends) the stream, so the stopping one leaves it be.
 */
export type StopReason = 'stop' | 'takeover' | 'removed' | 'quit'

interface Player {
  kind: Owner['kind']
  /** What it's playing (or starting) now, or null */
  current(): ActivePlayback | null
  /** Stop, and cancel a start still on its way. */
  stop(reason: StopReason): void
}

const players: Player[] = []

/** Each player registers once: how to tell what it's playing, and how to stop it. */
export function registerPlayer(player: Player): void {
  players.push(player)
}

export function activePlayback(): ActivePlayback | null {
  for (const p of players) {
    const c = p.current()
    if (c) return c
  }
  return null
}

export function stopActivePlayback(reason: StopReason): void {
  for (const p of players) if (p.current()) p.stop(reason)
}

/** Stop playback if it's from this torrent, e.g. before deleting its files. */
export function stopIfPlayingFrom(torrentId: number, reason: StopReason = 'removed'): void {
  if (activePlayback()?.torrentId === torrentId) stopActivePlayback(reason)
}

/**
 * A player of `kind` is starting: every other kind stops, including one still
 * starting. A player handles a new start of its own kind itself.
 */
export function takeOver(kind: Owner['kind']): void {
  for (const p of players) if (p.kind !== kind) p.stop('takeover')
}
