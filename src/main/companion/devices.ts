import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { CompanionDevice } from '@shared/companion'
import { getDb } from '../db'

// Paired phones. A phone proves itself with its cookie (only its SHA-256 is
// stored) on the API, and with a per-device HMAC in its video URLs, since VLC
// sends no cookies. Removing the row ends both at once.

const UNUSED_FOR_MS = 90 * 24 * 60 * 60_000
/** last_seen_at and last_ip are written at most this often per device. */
const TOUCH_EVERY_MS = 60_000

export interface Device {
  id: number
  name: string
}

interface DeviceRow {
  id: number
  name: string
  created_at: number
  last_seen_at: number | null
  last_ip: string | null
}

const touched = new Map<number, number>()

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Add a paired phone; returns its cookie value, which is never stored. */
export function addDevice(name: string, ip: string | null): { device: Device; token: string } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const res = getDb()
    .prepare('INSERT INTO devices (name, token_hash, url_key, created_at, last_seen_at, last_ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, hashToken(token), randomBytes(32), now, now, ip)
  const id = Number(res.lastInsertRowid)
  touched.set(id, now)
  return { device: { id, name }, token }
}

/** The device a cookie belongs to. */
export function deviceByToken(token: string): Device | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const row = getDb().prepare('SELECT id, name FROM devices WHERE token_hash = ?').get(hashToken(token)) as
    | { id: number; name: string }
    | undefined
  return row ? { id: row.id, name: row.name } : null
}

export function getDevice(id: number): Device | null {
  const row = getDb().prepare('SELECT id, name FROM devices WHERE id = ?').get(id) as Device | undefined
  return row ? { id: row.id, name: row.name } : null
}

/** Note that a device was used; true when the stored time changed. */
export function touchDevice(id: number, ip: string | null): boolean {
  const now = Date.now()
  if (now - (touched.get(id) ?? 0) < TOUCH_EVERY_MS) return false
  touched.set(id, now)
  getDb().prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(now, ip, id)
  return true
}

export function listDevices(): CompanionDevice[] {
  const rows = getDb()
    .prepare('SELECT id, name, created_at, last_seen_at, last_ip FROM devices ORDER BY created_at')
    .all() as unknown as DeviceRow[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastIp: r.last_ip
  }))
}

export function removeDevice(id: number): void {
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(id)
  touched.delete(id)
}

export function removeAllDevices(): void {
  getDb().prepare('DELETE FROM devices').run()
  touched.clear()
}

/** Drop devices not used for 90 days; run at startup. */
export function pruneDevices(): void {
  getDb()
    .prepare('DELETE FROM devices WHERE COALESCE(last_seen_at, created_at) < ?')
    .run(Date.now() - UNUSED_FOR_MS)
}

// --- Video URLs ---------------------------------------------------------------

function urlKey(deviceId: number): Buffer | null {
  const row = getDb().prepare('SELECT url_key FROM devices WHERE id = ?').get(deviceId) as
    | { url_key: Uint8Array }
    | undefined
  return row ? Buffer.from(row.url_key) : null
}

function mac(key: Buffer, torrentId: number, fileIndex: number): Buffer {
  return createHmac('sha256', key).update(`${torrentId}:${fileIndex}`).digest()
}

/**
 * The path segment that lets this device's VLC fetch one episode. It's stable,
 * so VLC sees the same URL each time. The ids are in the clear so the server can
 * find the key; the HMAC is what proves it.
 */
export function videoToken(deviceId: number, torrentId: number, fileIndex: number): string {
  const key = urlKey(deviceId)
  if (!key) throw new Error('This phone is no longer paired.')
  return `${deviceId}.${torrentId}.${fileIndex}.${mac(key, torrentId, fileIndex).toString('base64url')}`
}

export function checkVideoToken(token: string): { device: Device; torrentId: number; fileIndex: number } | null {
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,6})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!m) return null
  const [deviceId, torrentId, fileIndex] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const device = getDevice(deviceId)
  const key = device && urlKey(deviceId)
  if (!device || !key) return null
  const want = mac(key, torrentId, fileIndex)
  const got = Buffer.from(m[4], 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  return { device, torrentId, fileIndex }
}
