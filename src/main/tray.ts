import { Menu, Tray, nativeImage } from 'electron'
import trayIcon from '../../resources/tray.png?asset'
import { listTorrents, pauseAll, resumeAll } from './torrent'

let tray: Tray | null = null
let lastMenuKey = ''

/** Tray icon with a live status tooltip and quick download controls. */
export function createTray(onShow: () => void, onQuit: () => void): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon))
  tray.setToolTip('Swarmplay')
  tray.on('click', onShow)

  const update = (): void => {
    if (!tray) return
    const list = listTorrents()
    const downloading = list.filter((t) => t.status === 'downloading' || t.status === 'starting')
    const seeding = list.filter((t) => t.status === 'seeding').length
    const paused = list.filter((t) => t.status === 'paused').length
    const down = list.reduce((sum, t) => sum + t.downloadSpeed, 0)

    const parts = [
      downloading.length > 0 && `${downloading.length} downloading · ↓ ${speed(down)}`,
      seeding > 0 && `${seeding} seeding`,
      paused > 0 && `${paused} paused`
    ].filter(Boolean)
    const status = parts.length ? parts.join(' · ') : 'Nothing downloading'
    tray.setToolTip(`Swarmplay\n${status}`)

    // Only rebuild the menu when what it offers changes, not every second.
    const key = `${downloading.length > 0}|${paused > 0}|${status.replace(/↓ .*?\/s/, '')}`
    if (key === lastMenuKey) return
    lastMenuKey = key
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Swarmplay', click: onShow },
        { label: status, enabled: false },
        { type: 'separator' },
        { label: 'Pause all downloads', enabled: downloading.length > 0, click: () => void pauseAll() },
        { label: 'Resume all', enabled: paused > 0, click: () => void resumeAll() },
        { type: 'separator' },
        { label: 'Quit Swarmplay', click: onQuit }
      ])
    )
  }

  update()
  setInterval(update, 2000)
}

function speed(bytesPerSec: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytesPerSec
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}/s`
}
