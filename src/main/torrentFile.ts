import { createHash } from 'crypto'
import type { TorrentInfo } from '@shared/types'
import { bdecode, type BValue } from './bencode'

export interface ParsedTorrent extends TorrentInfo {
  infoHash: string
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
        path: [name, ...((f['path.utf-8'] ?? f.path) as BValue[]).map(text)].join('/'),
        length: f.length as number
      }))
    : [{ index: 0, path: name, length: info.length as number }]

  for (const f of files) {
    if (f.path.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new Error(`Torrent contains an unsafe file path: ${f.path}`)
    }
  }

  const trackers = new Set<string>()
  if (meta.announce) trackers.add(text(meta.announce))
  for (const tier of (meta['announce-list'] as BValue[][] | undefined) ?? []) {
    for (const t of tier) trackers.add(text(t))
  }

  return {
    infoHash: createHash('sha1').update(infoBytes).digest('hex'),
    name,
    files,
    totalLength: files.reduce((sum, f) => sum + f.length, 0),
    trackers: [...trackers]
  }
}
