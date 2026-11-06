import { app, BrowserWindow, Notification, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { firstTime, getDb, getSettings } from './db'
import { registerIpc } from './ipc'
import { autoLinkAll, describeEpisode } from './library'
import { initTorrents, onFileComplete, shutdownTorrents } from './torrent'
import { stopPlayer } from './player'
import { createTray } from './tray'

let win: BrowserWindow | null = null
let quitting = false
// Keep shown notifications referenced, or their click handlers can be garbage collected.
const notifications = new Set<Notification>()

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  // Closing hides to the tray so downloads and seeding keep going.
  win.on('close', (e) => {
    if (quitting || !getSettings().closeToTray) return
    e.preventDefault()
    win?.hide()
    if (firstTime('tray-tip')) {
      notify('Swarmplay is still running', 'Downloads continue in the background. Quit from the tray icon.')
    }
  })
  win.on('closed', () => (win = null))

  // Links clicked inside the app open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon })
  notifications.add(n)
  n.on('click', () => {
    showWindow()
    onClick?.()
  })
  n.on('close', () => notifications.delete(n))
  n.show()
}

// A second launch just brings the running app forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  // Windows groups notifications and taskbar entries by this id.
  app.setAppUserModelId('com.swarmplay.app')

  app.whenReady().then(() => {
    getDb()
    registerIpc()
    createWindow()
    createTray(showWindow, () => {
      quitting = true
      app.quit()
    })
    initTorrents().catch((err) => console.error('Failed to resume torrents:', err))
    // Fetch covers for folders that have none yet, after startup settles.
    setTimeout(() => autoLinkAll().catch(() => {}), 5_000)

    onFileComplete((torrentId, fileIndex) => {
      if (!getSettings().notifyOnDownload) return
      const ep = describeEpisode(torrentId, fileIndex)
      notify('Episode downloaded', `${ep.folderName ?? 'Unsorted'} · ${ep.label}`, () =>
        win?.webContents.send('app:navigate', { page: 'library', folderId: ep.folderId })
      )
    })

    app.on('activate', showWindow)
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  stopPlayer()
  shutdownTorrents()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
