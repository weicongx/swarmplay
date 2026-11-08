// Reads what the phone companion needs from a Matroska (mkv, webm) file's first
// bytes: the duration (Info's Duration × TimestampScale), and the tracks with
// their default flags. Both come before the first Cluster, normally within the
// first few tens of KB. Also reads the seek index (Cues), which the torrent
// engine uses to fetch the right bytes for a seek before the player asks.

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
const SEEK_HEAD = 0x114d9b74
const SEEK = 0x4dbb
const SEEK_ID = 0x53ab
const SEEK_POSITION = 0x53ac
const CUES = 0x1c53bb6b
const CUE_POINT = 0xbb
const CUE_TIME = 0xb3
const CUE_TRACK_POSITIONS = 0xb7
const CUE_TRACK = 0xf7
const CUE_CLUSTER_POSITION = 0xf1

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
  const r = segmentReader(buf)
  if (!r) return null

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

/** A reader at the start of the Segment's data, or null if `buf` isn't the start of a Matroska file. */
function segmentReader(buf: Uint8Array): Reader | null {
  const r = new Reader(buf)
  if (r.id() !== EBML) return null
  const headerSize = r.size()
  if (headerSize == null || headerSize < 0) return null
  r.pos += headerSize
  if (r.id() !== SEGMENT || r.size() == null) return null
  return r
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

/** Where a file's seek index is, from its first bytes. Positions are bytes from the file's start. */
export interface MkvCuesAt {
  /** The Cues element (its ID) */
  at: number
  /** Where the Segment's data starts: Cues give cluster positions from here */
  segmentStart: number
  /** Nanoseconds per Cue time tick */
  scale: number
  /** The video track's number, whose cues give keyframes; null if the header has none */
  videoTrack: number | null
}

/**
 * Find the Cues from the file's first bytes: the SeekHead points at them (most
 * muxers write them after the clusters), or they come before the first Cluster.
 * Null if `buf` isn't the start of a Matroska file or doesn't say where they are.
 */
export function mkvCuesAt(buf: Uint8Array): MkvCuesAt | null {
  const r = segmentReader(buf)
  if (!r) return null
  const segmentStart = r.pos
  let at: number | null = null
  while (r.pos < buf.length) {
    const start = r.pos
    const id = r.id()
    const size = r.size()
    if (id == null || size == null || size < 0) break
    if (id === CLUSTER) break
    if (id === CUES) {
      at = start
      break
    }
    if (id === SEEK_HEAD && r.pos + size <= buf.length) {
      const end = r.pos + size
      while (r.pos < end) {
        const sid = r.id()
        const ssize = r.size()
        if (sid == null || ssize == null || ssize < 0 || r.pos + ssize > end) break
        const seekEnd = r.pos + ssize
        if (sid === SEEK) {
          let target: number | null = null
          let pos: number | null = null
          while (r.pos < seekEnd) {
            const eid = r.id()
            const esize = r.size()
            if (eid == null || esize == null || esize < 0 || r.pos + esize > seekEnd) break
            if (eid === SEEK_ID) target = r.uint(esize)
            else if (eid === SEEK_POSITION) pos = r.uint(esize)
            r.pos += esize
          }
          if (target === CUES && pos != null && at == null) at = segmentStart + pos
        }
        r.pos = seekEnd
      }
      continue
    }
    r.pos += size
  }
  if (at == null) return null

  const info = topLevel(buf, INFO)
  let scale = 1_000_000
  if (info) {
    const { r: ir, end } = info
    while (ir.pos < end) {
      const id = ir.id()
      const size = ir.size()
      if (id == null || size == null || size < 0 || ir.pos + size > end) break
      if (id === TIMESTAMP_SCALE && size >= 1 && size <= 8) scale = ir.uint(size)
      ir.pos += size
    }
  }
  const video = mkvTracks(buf)?.tracks.find((t) => t.type === 'video')
  return { at, segmentStart, scale: scale > 0 ? scale : 1_000_000, videoTrack: video?.number ?? null }
}

/** The size of the element starting at `buf[0]` (its ID and size included), or null if they aren't all there. */
export function mkvElementLength(buf: Uint8Array): number | null {
  const r = new Reader(buf)
  if (r.id() == null) return null
  const size = r.size()
  return size == null || size < 0 ? null : r.pos + size
}

/** A keyframe: seconds into the video, and the byte its cluster starts at in the file. */
export interface Cue {
  time: number
  pos: number
}

/** The keyframes in a Cues element (`buf` starts at its ID), in time order. Null if it isn't one. */
export function mkvCues(buf: Uint8Array, where: MkvCuesAt): Cue[] | null {
  const r = new Reader(buf)
  if (r.id() !== CUES) return null
  const size = r.size()
  if (size == null || size < 0) return null
  const end = Math.min(buf.length, r.pos + size)
  const cues: Cue[] = []
  while (r.pos < end) {
    const id = r.id()
    const psize = r.size()
    if (id == null || psize == null || psize < 0 || r.pos + psize > end) break
    const pointEnd = r.pos + psize
    if (id === CUE_POINT) {
      let time: number | null = null
      let pos: number | null = null
      while (r.pos < pointEnd) {
        const cid = r.id()
        const csize = r.size()
        if (cid == null || csize == null || csize < 0 || r.pos + csize > pointEnd) break
        const childEnd = r.pos + csize
        if (cid === CUE_TIME) time = r.uint(csize)
        else if (cid === CUE_TRACK_POSITIONS && pos == null) {
          let track: number | null = null
          let cluster: number | null = null
          while (r.pos < childEnd) {
            const tid = r.id()
            const tsize = r.size()
            if (tid == null || tsize == null || tsize < 0 || r.pos + tsize > childEnd) break
            if (tid === CUE_TRACK) track = r.uint(tsize)
            else if (tid === CUE_CLUSTER_POSITION) cluster = r.uint(tsize)
            r.pos += tsize
          }
          if (cluster != null && (where.videoTrack == null || track === where.videoTrack)) pos = cluster
        }
        r.pos = childEnd
      }
      if (time != null && pos != null) cues.push({ time: (time * where.scale) / 1e9, pos: where.segmentStart + pos })
    }
    r.pos = pointEnd
  }
  return cues.sort((a, b) => a.time - b.time)
}
