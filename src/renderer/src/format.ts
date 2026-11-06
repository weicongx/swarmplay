import type { Upscaler } from '@shared/types'

export const UPSCALERS: { id: Upscaler; short: string; label: string; note: string }[] = [
  { id: 'off', short: 'Off', label: 'Off', note: 'Plays the video as released.' },
  {
    id: 'anime4k',
    short: 'Anime4K',
    label: 'Anime4K',
    note: 'GPU shaders made for anime line art: crisper lines, works on any recent GPU. Some find it over-sharpened.'
  },
  {
    id: 'rtx',
    short: 'RTX',
    label: 'RTX Video Super Resolution',
    note: 'NVIDIA’s AI upscaler, natural-looking and cheap to run. Turn on "RTX Video Enhancement → Super Resolution" in the NVIDIA App, or the driver falls back to plain scaling.'
  }
]

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** At or under this many seeders, a stream is likely to stall. */
export const FEW_SEEDERS = 2

export function seedersLabel(n: number): string {
  return `${n} seeder${n === 1 ? '' : 's'}`
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d`
}

/** 83.4 → "1:23", 3725 → "1:02:05" */
export function formatClock(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Drop the torrent's own folder name from a multi-file path for display. */
export function displayPath(path: string, torrentName: string): string {
  return path.startsWith(`${torrentName}/`) ? path.slice(torrentName.length + 1) : path
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke wraps main-process errors; keep only the original message.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function formatAge(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
]

export function magnetFor(infoHash: string, title: string): string {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}${tr}`
}
