// Reads what the phone companion needs from a Matroska (mkv, webm) file's first
// bytes: the duration (Info's Duration × TimestampScale), and the tracks with
// their default flags. Both come before the first Cluster, normally within the
// first few tens of KB.

import { crc32 } from 'zlib'

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TIMESTAMP_SCALE = 0x2ad7b1
const DURATION = 0x4489
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_NUMBER = 0xd7
const TRACK_TYPE = 0x83
const FLAG_DEFAULT = 0x88
const FLAG_FORCED = 0x55aa
const LANGUAGE = 0x22b59c
const LANGUAGE_IETF = 0x22b59d
const NAME = 0x536e
const CRC_32 = 0xbf
const CLUSTER = 0x1f43b675

/** Reads EBML elements from `buf`; a read that runs past its end gives null. */
// No TypeScript-only syntax here: scripts/cdp/companion.mjs imports this file in plain Node.
class Reader {
  pos = 0
  readonly buf: Uint8Array
  constructor(buf: Uint8Array) {
    this.buf = buf
  }

  /** An element ID keeps its length marker: 1 to 4 bytes. */
  id(): number | null {
    const b = this.buf[this.pos]
    if (b === undefined) return null
    const len = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : b >= 0x10 ? 4 : 0
    if (!len || this.pos + len > this.buf.length) return null
    let id = 0
    for (let i = 0; i < len; i++) id = id * 256 + this.buf[this.pos + i]
    this.pos += len
    return id
  }

  /** A size drops its marker: 1 to 8 bytes. All ones means unknown (-1), as a live Segment may be. */
  size(): number | null {
    const b = this.buf[this.pos]
    if (b === undefined || b === 0) return null
    let len = 1
    while (!(b & (0x80 >> (len - 1)))) len++
    if (this.pos + len > this.buf.length) return null
    let value = b & (0xff >> len)
    let allOnes = value === 0xff >> len
    for (let i = 1; i < len; i++) {
      value = value * 256 + this.buf[this.pos + i]
      allOnes &&= this.buf[this.pos + i] === 0xff
    }
    this.pos += len
    return allOnes ? -1 : value
  }

  uint(size: number): number {
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + this.buf[this.pos + i]
    return v
  }

  text(size: number): string {
    return new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + size)).replace(/\0+$/, '')
  }
}

/**
 * Finds one of the Segment's elements before the first Cluster. Returns a reader
 * at the start of its data and where the data ends, or null if `buf` isn't the
 * start of a Matroska file or doesn't hold all of the element.
 */
function topLevel(buf: Uint8Array, want: number): { r: Reader; end: number } | null {
  const r = new Reader(buf)
  if (r.id() !== EBML) return null
  const headerSize = r.size()
  if (headerSize == null || headerSize < 0) return null
  r.pos += headerSize
  if (r.id() !== SEGMENT || r.size() == null) return null

  while (r.pos < buf.length) {
    const id = r.id()
    const size = r.size()
    if (id == null || size == null) return null
    if (id === CLUSTER) return null // past the header
    if (id === want) return size < 0 || r.pos + size > buf.length ? null : { r, end: r.pos + size }
    if (size < 0) return null
    r.pos += size // SeekHead, Void, and so on
  }
  return null
}

/** The duration in seconds, or null if `buf` isn't the start of a Matroska file or Info isn't in it. */
export function mkvDuration(buf: Uint8Array): number | null {
  const info = topLevel(buf, INFO)
  if (!info) return null
  const { r, end } = info
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let scale = 1_000_000 // nanoseconds per tick, Matroska's default
  let duration: number | null = null
  while (r.pos < end) {
    const id = r.id()
    const size = r.size()
    if (id == null || size == null || size < 0 || r.pos + size > end) return null
    if (id === TIMESTAMP_SCALE && size >= 1 && size <= 8) scale = r.uint(size)
    else if (id === DURATION && size === 4) duration = view.getFloat32(r.pos)
    else if (id === DURATION && size === 8) duration = view.getFloat64(r.pos)
    r.pos += size
  }
  return duration != null && duration > 0 && scale > 0 ? (duration * scale) / 1e9 : null
}

export interface MkvTrack {
  number: number
  type: 'video' | 'audio' | 'sub' | 'other'
  /** LanguageIETF, else Language; Matroska's default is English */
  lang: string
  name: string | null
  isDefault: boolean
  forced: boolean
  /** Where FlagDefault's and FlagForced's one-byte values are in the file; null if not written that way */
  defaultAt: number | null
  forcedAt: number | null
}

export interface MkvTracks {
  tracks: MkvTrack[]
  /** The Tracks element's CRC-32, if it has one: where its 4 bytes are, and the bytes it covers */
  crc: { at: number; from: number; to: number } | null
}

const TYPES: Record<number, MkvTrack['type']> = { 1: 'video', 2: 'audio', 17: 'sub' }

/** The tracks in the file's header, or null if `buf` doesn't hold all of them. */
export function mkvTracks(buf: Uint8Array): MkvTracks | null {
  const found = topLevel(buf, TRACKS)
  if (!found) return null
  const { r, end } = found
  const tracks: MkvTrack[] = []
  let crc: MkvTracks['crc'] = null
  let first = true
  while (r.pos < end) {
    const id = r.id()
    const size = r.size()
    if (id == null || size == null || size < 0 || r.pos + size > end) return null
    const dataEnd = r.pos + size
    // A CRC-32 is always the first child, and covers all that follows it.
    if (id === CRC_32 && size === 4 && first) crc = { at: r.pos, from: dataEnd, to: end }
    if (id === TRACK_ENTRY) {
      const track = readTrack(r, dataEnd)
      if (!track) return null
      tracks.push(track)
    }
    r.pos = dataEnd
    first = false
  }
  return { tracks, crc }
}

function readTrack(r: Reader, end: number): MkvTrack | null {
  let number = 0
  let type = 0
  let language: string | null = null
  let ietf: string | null = null
  let name: string | null = null
  // An empty flag, or a missing one, has its default value.
  let isDefault = true
  let forced = false
  let defaultAt: number | null = null
  let forcedAt: number | null = null
  while (r.pos < end) {
    const id = r.id()
    const size = r.size()
    if (id == null || size == null || size < 0 || r.pos + size > end) return null
    if (id === TRACK_NUMBER) number = r.uint(size)
    else if (id === TRACK_TYPE) type = r.uint(size)
    else if (id === LANGUAGE) language = r.text(size)
    else if (id === LANGUAGE_IETF) ietf = r.text(size)
    else if (id === NAME) name = r.text(size)
    else if (id === FLAG_DEFAULT && size > 0) {
      isDefault = r.uint(size) !== 0
      defaultAt = size === 1 ? r.pos : null
    } else if (id === FLAG_FORCED && size > 0) {
      forced = r.uint(size) !== 0
      forcedAt = size === 1 ? r.pos : null
    }
    r.pos += size
  }
  return {
    number,
    type: TYPES[type] ?? 'other',
    lang: ietf || language || 'eng',
    name: name || null,
    isDefault,
    forced,
    defaultAt,
    forcedAt
  }
}

export interface Patch {
  at: number
  byte: number
}

/**
 * The byte changes that make the chosen tracks the defaults, so a player that
 * goes by the file's flags, like VLC, starts with them. Only one-byte flags
 * change, so the file keeps its length; the CRC-32, if any, is redone. A type
 * whose flags can't all be set this way is left as it is.
 *
 * `want.sub` null turns every subtitle off; a type left undefined isn't touched.
 * Returns the changes and the types they set.
 */
export function defaultTrackPatches(
  head: Uint8Array,
  info: MkvTracks,
  want: { audio?: number; sub?: number | null }
): { patches: Patch[]; audio: boolean; sub: boolean } {
  const forType = (type: 'audio' | 'sub', chosen: number | null): Patch[] | null => {
    const out: Patch[] = []
    for (const t of info.tracks) {
      if (t.type !== type) continue
      const on = t.number === chosen
      if (t.isDefault !== on) {
        if (t.defaultAt == null) return null
        out.push({ at: t.defaultAt, byte: on ? 1 : 0 })
      }
      // A forced track would win over the default one, and it shows even with subtitles off.
      if (!on && t.forced) {
        if (t.forcedAt == null) return null
        out.push({ at: t.forcedAt, byte: 0 })
      }
    }
    return out
  }
  const audio = want.audio === undefined ? null : forType('audio', want.audio)
  const sub = want.sub === undefined ? null : forType('sub', want.sub)
  const patches = [...(audio ?? []), ...(sub ?? [])]
  if (patches.length && info.crc) {
    const { at, from, to } = info.crc
    const covered = Buffer.from(head.subarray(from, to))
    for (const p of patches) covered[p.at - from] = p.byte
    const crc = crc32(covered)
    // Matroska stores it little-endian.
    for (let i = 0; i < 4; i++) patches.push({ at: at + i, byte: (crc >>> (8 * i)) & 0xff })
  }
  return { patches, audio: audio != null, sub: sub != null }
}
