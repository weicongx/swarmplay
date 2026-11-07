import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import type { UpdateStatus } from '@shared/types'
import { getSettings } from './db'

// New versions are GitHub releases of the public repo, each with the NSIS
// installer attached. Installing runs that installer silently over this copy
// (it keeps the library and settings) and starts the new version.
const LATEST_URL = 'https://api.github.com/repos/weicongx/swarmplay/releases/latest'
const INSTALLER = /^Swarmplay-Setup-[\d.]+\.exe$/
const DOWNLOAD_PREFIX = 'https://github.com/weicongx/swarmplay/releases/download/'
const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60_000

interface Release {
  version: string
  notes: string
  url: string
  size: number
  /** "sha256:<hex>", when GitHub has one for the file */
  digest: string | null
}

let release: Release | null = null
const status: UpdateStatus = {
  current: currentVersion(),
  available: null,
  phase: 'idle',
  progress: 0,
  error: null,
  checkedAt: null,
  supported: app.isPackaged
}

/** From source, SWARMPLAY_UPDATE_FROM pretends to be an older version, to try the update flow. */
function currentVersion(): string {
  return (!app.isPackaged && process.env.SWARMPLAY_UPDATE_FROM) || app.getVersion()
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  Object.assign(status, patch)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('updates:status', getUpdateStatus())
  }
}

/** True if version a is newer than b (plain x.y.z). */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0
  }
  return false
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (status.phase !== 'idle') return getUpdateStatus()
  setStatus({ phase: 'checking', error: null })
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Swarmplay/${app.getVersion()}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const r = (await res.json()) as {
      tag_name: string
      body?: string
      draft?: boolean
      prerelease?: boolean
      assets?: { name: string; size: number; browser_download_url: string; digest?: string | null }[]
    }
    const version = r.tag_name.replace(/^v/, '')
    // Only the repo's own release download, and only with a checksum to verify it against.
    const asset = r.assets?.find(
      (a) => INSTALLER.test(a.name) && a.browser_download_url.startsWith(DOWNLOAD_PREFIX) && /^sha256:[0-9a-f]{64}$/i.test(a.digest ?? '')
    )
    release =
      !r.draft && !r.prerelease && asset && newer(version, status.current)
        ? { version, notes: r.body ?? '', url: asset.browser_download_url, size: asset.size, digest: asset.digest ?? null }
        : null
    setStatus({
      phase: 'idle',
      checkedAt: Date.now(),
      available: release && { version: release.version, notes: release.notes, size: release.size }
    })
  } catch (err) {
    setStatus({ phase: 'idle', error: `Couldn't check for updates: ${(err as Error).message}` })
  }
  return getUpdateStatus()
}

/** Download the new installer, check it against GitHub's digest, run it, and quit. */
export async function installUpdate(): Promise<void> {
  const r = release
  if (!r) throw new Error('No update to install.')
  if (status.phase !== 'idle') return
  const file = join(app.getPath('temp'), `Swarmplay-Setup-${r.version}.exe`)
  setStatus({ phase: 'downloading', progress: 0, error: null })
  try {
    const res = await fetch(r.url, { headers: { 'User-Agent': `Swarmplay/${app.getVersion()}` } })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || r.size
    const hash = createHash('sha256')
    const out = createWriteStream(file)
    let got = 0
    let shown = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      got += value.length
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      if (got / total - shown >= 0.01) setStatus({ progress: (shown = got / total) })
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    const want = r.digest?.startsWith('sha256:') ? r.digest.slice(7).toLowerCase() : null
    if (!want || hash.digest('hex') !== want) throw new Error("the download doesn't match GitHub's checksum")
    if (!app.isPackaged) {
      throw new Error(`Downloaded and verified ${file}; updates install only in the installed app.`)
    }
    setStatus({ phase: 'installing', progress: 1 })
    // /S installs without asking, into the existing install; --force-run starts it afterwards.
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 500)
  } catch (err) {
    if (app.isPackaged) await rm(file, { force: true }).catch(() => {})
    setStatus({ phase: 'idle', progress: 0, error: (err as Error).message })
    throw err
  }
}

/** The installer of the last update stays in the temp folder while it runs; delete it once this version is up. */
async function removeOldInstallers(): Promise<void> {
  if (status.phase !== 'idle') return
  const dir = app.getPath('temp')
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (INSTALLER.test(name)) await rm(join(dir, name), { force: true }).catch(() => {})
  }
}

/** Check shortly after launch and then every few hours, when the setting is on. */
export function startUpdateChecks(onFound: (version: string) => void): void {
  let announced: string | null = null
  const run = async (): Promise<void> => {
    if (!getSettings().autoUpdateCheck) return
    const s = await checkForUpdate()
    if (s.available && s.available.version !== announced) {
      announced = s.available.version
      onFound(s.available.version)
    }
  }
  setTimeout(() => {
    void removeOldInstallers().then(run)
    setInterval(() => void run(), CHECK_EVERY_MS)
  }, FIRST_CHECK_MS)
}
