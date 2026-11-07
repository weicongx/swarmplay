import { app, BrowserWindow } from 'electron'
import type { CompanionPairing, CompanionSessionInfo, CompanionStatus } from '@shared/companion'
import { getSettings, setSettings } from '../db'
import { onCompanionChange } from './changed'
import { listDevices, pruneDevices, removeAllDevices, removeDevice } from './devices'
import { cancelPairing, companionAddresses, newPairingCode, pairingLinks, pendingCode } from './pairing'
import { serverRunning, startServer, stopServer } from './server'
import { endDeviceSession, endPhoneSession, forgetDevice, phoneSessionInfo } from './session'

// The phone companion as the rest of the app sees it: on or off, pairing, the
// device list, and the phone's playback. Tailscale or the home network decides
// who can reach the PC; pairing decides who can use it.

/** From source, SWARMPLAY_COMPANION_HOST=127.0.0.1 keeps tests off the network (and the Firewall prompt). */
const BIND_HOST = (!app.isPackaged && process.env.SWARMPLAY_COMPANION_HOST) || '0.0.0.0'

let error: string | null = null
let lastSent = ''

/** At startup: drop devices unused for 90 days, and start the server if it's on. */
export async function initCompanion(): Promise<void> {
  pruneDevices()
  onCompanionChange(sendStatus)
  if (getSettings().companionEnabled) await enable(true)
}

export function companionStatus(): CompanionStatus {
  const { companionEnabled, companionPort } = getSettings()
  const running = serverRunning()
  return {
    enabled: companionEnabled,
    port: companionPort,
    running,
    error,
    addresses: running ? companionAddresses(BIND_HOST) : [],
    devices: listDevices(),
    session: phoneSessionInfo(),
    pairing: running ? pendingCode() : null
  }
}

/** Push companion:update to the app window when anything it shows changed. */
function sendStatus(): void {
  const status = companionStatus()
  const json = JSON.stringify(status)
  if (json === lastSent) return
  lastSent = json
  for (const w of BrowserWindow.getAllWindows()) {
    // Not the video host, which is a child window.
    if (!w.isDestroyed() && !w.getParentWindow()) w.webContents.send('companion:update', status)
  }
}

async function enable(on: boolean): Promise<void> {
  if (on) {
    const port = getSettings().companionPort
    try {
      await startServer(port, BIND_HOST)
      error = null
      setSettings({ companionEnabled: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      error =
        code === 'EADDRINUSE'
          ? `Port ${port} is in use by another program. Pick another port.`
          : code === 'EACCES'
            ? `Windows didn't allow port ${port}. Pick another port.`
            : `Couldn't start: ${err instanceof Error ? err.message : String(err)}`
      setSettings({ companionEnabled: false })
    }
  } else {
    error = null
    setSettings({ companionEnabled: false })
    endPhoneSession('stop')
    cancelPairing()
    await stopServer()
  }
  sendStatus()
}

export async function setCompanionEnabled(on: boolean): Promise<CompanionStatus> {
  await enable(on === true)
  return companionStatus()
}

export async function setCompanionPort(port: number): Promise<CompanionStatus> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Pick a port from 1024 to 65535.')
  if (port !== getSettings().companionPort) {
    setSettings({ companionPort: port })
    if (serverRunning()) {
      // Paired phones keep working; their page just needs the new address.
      endPhoneSession('stop')
      cancelPairing()
      await stopServer()
      await enable(true)
    }
  }
  sendStatus()
  return companionStatus()
}

/** A new pairing code, with a link and QR code for each address the phone might use. */
export function pairPhone(): CompanionPairing {
  if (!serverRunning()) throw new Error('Turn on the phone companion first.')
  const { code, expiresAt } = newPairingCode()
  sendStatus()
  return pairingLinks(code, expiresAt, getSettings().companionPort, BIND_HOST)
}

export function cancelPhonePairing(): void {
  cancelPairing()
  sendStatus()
}

/** Removing a phone ends its playback, and its cookie and video URLs stop working at once. */
export function removePhone(id: number): void {
  endDeviceSession(id, 'removed')
  removeDevice(id)
  forgetDevice(id)
  sendStatus()
}

export function removeAllPhones(): void {
  for (const d of listDevices()) {
    endDeviceSession(d.id, 'removed')
    forgetDevice(d.id)
  }
  removeAllDevices()
  sendStatus()
}

/** Stop on the PC (tray, banner) for what a phone is playing. */
export function stopPhone(): void {
  endPhoneSession('stop')
}

export function phonePlayback(): CompanionSessionInfo | null {
  return phoneSessionInfo()
}

/** On quit: save the phone's position and close the server. index.ts then ends the stream. */
export function stopCompanion(): void {
  endPhoneSession('quit')
  void stopServer()
}
