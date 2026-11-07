import { createHash } from 'crypto'
import type { TorrentInfo } from '@shared/types'
import { bdecode, type BValue } from './bencode'

export interface ParsedTorrent extends Omit<TorrentInfo, 'series'> {
  infoHash: string
  /** Bytes per piece; files are laid end to end, so pieces at their edges are shared. */
  pieceLength: number
}

/** Read name, files, trackers and info-hash from raw .torrent bytes. */
export function parseTorrentFile(buf: Buffer): ParsedTorrent {
  const { value, info: infoBytes } = bdecode(buf)
  const meta = value as Record<string, BValue>
  const info = meta.info as Record<string, BValue> | undefined
  if (!info || !infoBytes) throw new Error('Not a valid .torrent file')

  const text = (v: BValue | undefined): string => (Buffer.isBuffer(v) ? v.toString('utf8') : '')
  const name = text(info['name.utf-8'] ?? info.name)

  // Multi-file torrents nest files under a folder named after the torrent,
  // which is also how WebTorrent lays them out on disk.
  const files = Array.isArray(info.files)
    ? (info.files as Record<string, BValue>[]).map((f, index) => ({
        index,
        path: safePath([name, ...((f['path.utf-8'] ?? f.path) as BValue[]).map(text)]),
        length: f.length as number
      }))
    : [{ index: 0, path: safePath([name]), length: info.length as number }]

  const trackers = new Set<string>()
  if (meta.announce) trackers.add(text(meta.announce))
  for (const tier of (meta['announce-list'] as BValue[][] | undefined) ?? []) {
    for (const t of tier) trackers.add(text(t))
  }

  return {
    infoHash: createHash('sha1').update(infoBytes).digest('hex'),
    pieceLength: Number(info['piece length']) || 0,
    name,
    files,
    totalLength: files.reduce((sum, f) => sum + f.length, 0),
    trackers: [...trackers]
  }
}

/** Characters Windows doesn't allow in a file name; WebTorrent drops them from the file's own name. */
// eslint-disable-next-line no-control-regex
const RESERVED = /[<>:"/\\|?*\u0000-\u001F]/

/**
 * Join a torrent's path segments the way WebTorrent lays the file out on disk,
 * or refuse it. A segment can't climb out of the save folder ("..", a drive,
 * or a backslash, which Windows treats as a separator), because the app opens,
 * moves and deletes files by these paths. Like WebTorrent, the file name itself
 * loses characters Windows forbids, so the path matches the file it writes.
 */
function safePath(segments: string[]): string {
  const last = segments.length - 1
  const out = segments.map((seg, i) => {
    const clean = i === last ? seg.replace(new RegExp(RESERVED.source, 'g'), '') : seg
    if (clean === '' || clean === '.' || clean === '..' || RESERVED.test(clean)) {
      throw new Error(`Torrent contains an unsafe file path: ${segments.join('/')}`)
    }
    return clean
  })
  return out.join('/')
}
