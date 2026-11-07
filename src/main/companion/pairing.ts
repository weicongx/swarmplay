import { createHash, randomInt, timingSafeEqual } from 'crypto'
import { networkInterfaces } from 'os'
import qrcode from 'qrcode-generator'
import type { AddressKind, CompanionAddress, CompanionPairing } from '@shared/companion'

// Pairing a phone: Settings shows a one-time code, as a QR code linking to
// /pair#CODE and in large type for typing. The fragment never reaches a server
// log; the page reads it and posts it.

/** No 0/O, 1/I/L: easy to read off the screen and type. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const VALID_MS = 5 * 60_000
/** Wrong tries before the code is void */
const TRIES_PER_CODE = 5
/** Tries of any code, across every phone */
const TRIES_PER_WINDOW = 20
const TRIES_WINDOW_MS = 10 * 60_000

let pending: { code: string; expiresAt: number; wrong: number } | null = null
let tries: number[] = []

/** A new code; only the newest one works. */
export function newPairingCode(): { code: string; expiresAt: number } {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  pending = { code, expiresAt: Date.now() + VALID_MS, wrong: 0 }
  return { code, expiresAt: pending.expiresAt }
}

export function pendingCode(): { code: string; expiresAt: number } | null {
  if (pending && Date.now() > pending.expiresAt) pending = null
  return pending && { code: pending.code, expiresAt: pending.expiresAt }
}

export function cancelPairing(): void {
  pending = null
}

/** "abcd-efgh", "ABCD EFGH" → "ABCDEFGH" */
function normalize(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '')
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

/**
 * Check a code a phone sent. `ok` uses it up. Five wrong tries void it, and
 * past 20 tries in 10 minutes everything is `limited` until the window moves on.
 */
export function usePairingCode(input: string): 'ok' | 'wrong' | 'limited' {
  const now = Date.now()
  tries = tries.filter((t) => now - t < TRIES_WINDOW_MS)
  if (tries.length >= TRIES_PER_WINDOW) return 'limited'
  tries.push(now)

  const p = pendingCode() && pending
  if (!p) return 'wrong'
  // Hashing first gives both sides the same length, so the compare is constant-time.
  if (!timingSafeEqual(digest(normalize(String(input))), digest(p.code))) {
    if (++p.wrong >= TRIES_PER_CODE) pending = null
    return 'wrong'
  }
  pending = null
  return 'ok'
}

// --- Addresses ----------------------------------------------------------------

/** Adapters for virtual machines and containers, which a phone can't reach. */
const VIRTUAL_ADAPTER = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback|docker|VPN Client/i

function kindOf(address: string): AddressKind | null {
  const [a, b] = address.split('.').map(Number)
  if (a === 169 && b === 254) return null // link-local: no DHCP, nothing to reach
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'home'
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale' // 100.64.0.0/10, Tailscale's range
  return 'other'
}

/** IPv4 addresses a phone might reach this PC at: the home network first, then Tailscale. */
export function companionAddresses(bindHost: string): CompanionAddress[] {
  if (bindHost !== '0.0.0.0') return [{ address: bindHost, kind: 'other', adapter: 'Test address' }]
  const out: CompanionAddress[] = []
  for (const [adapter, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(adapter)) continue
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const kind = kindOf(a.address)
      if (kind) out.push({ address: a.address, kind, adapter })
    }
  }
  const rank: Record<AddressKind, number> = { home: 0, tailscale: 1, other: 2 }
  return out.sort((x, y) => rank[x.kind] - rank[y.kind])
}

/** This PC's Tailscale IPv6 address (in fd7a:115c:a1e0::/48), if Tailscale is up. */
export function tailscaleIPv6(): string | null {
  for (const [adapter, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(adapter)) continue
    for (const a of list ?? []) {
      if (a.family === 'IPv6' && !a.internal && /^fd7a:115c:a1e0:/i.test(a.address)) return a.address
    }
  }
  return null
}

/** Whether an IPv4 address is in Tailscale's range. */
export function isTailscaleIPv4(address: string): boolean {
  return kindOf(address) === 'tailscale'
}

/** The QR code for a link, as an SVG that scales to its box. */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
}

export function pairingLinks(code: string, expiresAt: number, port: number, bindHost: string): CompanionPairing {
  return {
    code,
    expiresAt,
    links: companionAddresses(bindHost).map((address) => {
      const url = `http://${address.address}:${port}/pair#${code}`
      return { address, url, qrSvg: qrSvg(url) }
    })
  }
}
