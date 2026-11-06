// Minimal bencode decoder, enough to read .torrent files.
// Byte strings stay as Buffers because torrent piece hashes are binary.

export type BValue = number | Buffer | BValue[] | { [key: string]: BValue }

export interface Decoded {
  value: BValue
  /** Raw bytes of the top-level "info" dict, which is what the info-hash is computed over. */
  info: Buffer | null
}

export function bdecode(buf: Buffer): Decoded {
  let pos = 0
  let info: Buffer | null = null

  function next(depth: number): BValue {
    const c = buf[pos]
    if (c === 0x69 /* i */) {
      const end = buf.indexOf(0x65 /* e */, pos)
      const n = Number(buf.toString('ascii', pos + 1, end))
      pos = end + 1
      return n
    }
    if (c === 0x6c /* l */) {
      pos++
      const list: BValue[] = []
      while (buf[pos] !== 0x65) list.push(next(depth + 1))
      pos++
      return list
    }
    if (c === 0x64 /* d */) {
      pos++
      const dict: { [key: string]: BValue } = {}
      while (buf[pos] !== 0x65) {
        const key = (next(depth + 1) as Buffer).toString('utf8')
        const start = pos
        dict[key] = next(depth + 1)
        if (depth === 0 && key === 'info') info = buf.subarray(start, pos)
      }
      pos++
      return dict
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a /* : */, pos)
      const len = Number(buf.toString('ascii', pos, colon))
      const start = colon + 1
      pos = start + len
      if (pos > buf.length) throw new Error('Truncated bencode string')
      return buf.subarray(start, pos)
    }
    throw new Error(`Invalid bencode at byte ${pos}`)
  }

  const value = next(0)
  return { value, info }
}
