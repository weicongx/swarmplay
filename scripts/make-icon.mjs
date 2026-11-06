// Renders the app icon to resources/icon.png (256px), resources/icon.ico (16–256px,
// used for the window and taskbar on Windows) and resources/tray.png (32px).
// No image tools needed: shapes are rasterized with 4x supersampling and written as PNG.
//   node scripts/make-icon.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SS = 4

function render(size) {
  const n = size * SS
  const px = new Float64Array(size * size * 4)
  // Terracotta, matching the app's accent (#d97757): lighter top-left to deeper bottom-right.
  const top = [0xe8, 0x93, 0x73]
  const bottom = [0xb8, 0x58, 0x3a]
  const r = 0.22 // corner radius (fraction of size)

  // Play triangle and three trailing "swarm" dots, in unit coordinates.
  const tri = [
    [0.42, 0.3],
    [0.42, 0.7],
    [0.75, 0.5]
  ]
  const dots = [
    [0.28, 0.5, 0.055],
    [0.2, 0.37, 0.038],
    [0.2, 0.63, 0.038]
  ]

  const inRoundRect = (x, y) => {
    const cx = Math.min(Math.max(x, r), 1 - r)
    const cy = Math.min(Math.max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  const inTri = (x, y) => {
    const s = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
    const p = [x, y]
    const d1 = s(p, tri[0], tri[1])
    const d2 = s(p, tri[1], tri[2])
    const d3 = s(p, tri[2], tri[0])
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  const inDot = (x, y) => dots.some(([dx, dy, dr]) => (x - dx) ** 2 + (y - dy) ** 2 <= dr * dr)

  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      const x = (sx + 0.5) / n
      const y = (sy + 0.5) / n
      if (!inRoundRect(x, y)) continue
      const t = (x + y) / 2
      let c = top.map((v, i) => v + (bottom[i] - v) * t)
      if (inTri(x, y) || inDot(x, y)) c = [255, 255, 255]
      const i = (Math.floor(sy / SS) * size + Math.floor(sx / SS)) * 4
      px[i] += c[0]
      px[i + 1] += c[1]
      px[i + 2] += c[2]
      px[i + 3] += 255
    }
  }

  // Average the subsamples; colors are premultiplied by coverage, so un-premultiply.
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3] / (SS * SS)
    out[i * 4 + 3] = Math.round(a)
    if (a > 0) for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(px[i * 4 + k] / (SS * SS) / (a / 255))
  }
  return png(size, out)
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An .ico holding PNG images (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // 0 means 256
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', render(256))
writeFileSync('resources/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }))))
writeFileSync('resources/tray.png', render(32))
console.log('wrote resources/icon.png, resources/icon.ico and resources/tray.png')
