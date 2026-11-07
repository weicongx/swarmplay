import { app, BrowserWindow, Notification, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import iconIco from '../../resources/icon.ico?asset'

// Must match appId in electron-builder.yml. Windows caches a taskbar icon per id,
// so runs from source (electron.exe, with Electron's icon) use their own id.
const APP_ID = app.isPackaged ? 'com.weicongx.swarmplay' : 'com.weicongx.swarmplay.dev'
import { firstTime, getDb, getSettings } from './db'
import { registerIpc } from './ipc'
import { autoLinkAll, describeEpisode } from './library'
import { onNewEpisodes, startFollowChecks } from './follows'
import { endStream, initTorrents, onFileComplete, shutdownTorrents } from './torrent'
import { attachPlayerWindow, stopPlayer } from './player'

// The in-app player is mpv drawing into a child window. Chromium's DirectComposition
// layers the page above child windows, which hides the video (audio still plays).
app.commandLine.appendSwitch('disable-direct-composition')

// From source, SWARMPLAY_PROFILE runs on a separate profile: its own database,
// settings, backups and library folder (<profile>\Videos\Anime). Test runs then
// never touch the installed app's data, and both can run at once, since the
// single-instance lock is per profile too. Must run before anything reads a path.
const profile = !app.isPackaged && process.env.SWARMPLAY_PROFILE
if (profile) {
  app.setPath('userData', profile)
  app.setPath('videos', join(profile, 'Videos'))
}
import { createTray } from './tray'
import { startUpdateChecks } from './updates'

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
    backgroundColor: '#181818', // matches --bg, so the window doesn't flash before the page paints
    autoHideMenuBar: true,
    icon: process.platform === 'win32' ? iconIco : icon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  attachPlayerWindow(win)
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
  // The window never leaves the app's own page: a link or file dropped on it
  // would otherwise load in place, with the app's API available to that page.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

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
  // Windows groups notifications and taskbar entries by this id; the installer's
  // Start-menu shortcut carries the same id, giving toasts the app's name and icon.
  // The taskbar button shows the running exe's icon, so only Swarmplay.exe shows
  // ours; running from source shows electron.exe's.
  app.setAppUserModelId(APP_ID)

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

    onNewEpisodes((folderId, episodes) => {
      if (!getSettings().notifyNewEpisodes) return
      const folder = getDb().prepare('SELECT name FROM folders WHERE id = ?').get(folderId) as { name: string } | undefined
      const which = episodes.length === 1 ? `Episode ${episodes[0]}` : `Episodes ${episodes.join(', ')}`
      notify(episodes.length === 1 ? 'New episode' : 'New episodes', `${folder?.name ?? 'A followed series'} · ${which}`, () =>
        win?.webContents.send('app:navigate', { page: 'library', folderId })
      )
    })
    startFollowChecks()
    startUpdateChecks((version) =>
      notify('Update available', `Swarmplay ${version} is out. Install it from Settings.`, () =>
        win?.webContents.send('app:navigate', { page: 'settings', folderId: null })
      )
    )

    app.on('activate', showWindow)
  })
}

app.on('before-quit', () => {
  quitting = true
})

// Quitting mid-stream: stop mpv and delete what was streamed before exiting,
// as stopping playback would. Startup clears anything this doesn't finish.
let cleanedUp = false
app.on('will-quit', (e) => {
  if (cleanedUp) return
  cleanedUp = true
  e.preventDefault()
  stopPlayer()
  const timeout = new Promise<void>((r) => setTimeout(r, 5_000))
  Promise.race([endStream(), timeout])
    .catch((err) => console.error('Failed to clean up a stream on quit:', err))
    .finally(() => {
      shutdownTorrents()
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
