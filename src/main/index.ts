import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { getDb } from './db'
import { registerIpc } from './ipc'
import { initTorrents, shutdownTorrents } from './torrent'
import { stopPlayer } from './player'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

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

app.whenReady().then(() => {
  getDb()
  registerIpc()
  createWindow()
  initTorrents().catch((err) => console.error('Failed to resume torrents:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  stopPlayer()
  shutdownTorrents()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
