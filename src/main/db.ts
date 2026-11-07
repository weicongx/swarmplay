import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { Settings } from '@shared/types'

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE search_history (
    query       TEXT PRIMARY KEY,
    searched_at INTEGER NOT NULL
  );

  -- Library: a folder is usually one series; parent_id allows nesting later.
  CREATE TABLE folders (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    cover_url  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE torrents (
    id           INTEGER PRIMARY KEY,
    info_hash    TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    torrent_file BLOB,
    nyaa_id      INTEGER,
    save_path    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    progress     REAL NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL
  );

  -- One torrent can hold many episodes (batches), so episodes point at a file index.
  CREATE TABLE episodes (
    id           INTEGER PRIMARY KEY,
    folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    torrent_id   INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    file_index   INTEGER NOT NULL,
    title        TEXT NOT NULL,
    episode_num  REAL,
    file_path    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    position_sec REAL NOT NULL DEFAULT 0,
    duration_sec REAL,
    watched      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (torrent_id, file_index)
  );

  CREATE INDEX episodes_folder ON episodes(folder_id);
  `,
  `
  -- JSON array of selected file indexes; NULL means all files.
  ALTER TABLE torrents ADD COLUMN selected_files TEXT;
  -- JSON array of per-file progress (0–1), so paused torrents still show it.
  ALTER TABLE torrents ADD COLUMN file_progress TEXT;
  ALTER TABLE torrents ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE torrents ADD COLUMN completed_at INTEGER;
  `,
  `
  -- AniList link for a series folder. anilist_titles is a JSON array of every
  -- title and synonym, so releases in another language find the same folder.
  ALTER TABLE folders ADD COLUMN anilist_id INTEGER;
  ALTER TABLE folders ADD COLUMN anilist_titles TEXT;
  ALTER TABLE folders ADD COLUMN anilist_meta TEXT;
  ALTER TABLE folders ADD COLUMN anilist_checked_at INTEGER;
  ALTER TABLE episodes ADD COLUMN last_played_at INTEGER;

  CREATE TABLE anilist_cache (
    query      TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  `
  -- A followed series: one group's uploads of one series and season at one
  -- resolution, re-searched on nyaa so new episodes show up in the folder.
  CREATE TABLE follows (
    id            INTEGER PRIMARY KEY,
    folder_id     INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    release_group TEXT NOT NULL,
    series_key    TEXT NOT NULL,
    resolution    TEXT,
    query         TEXT NOT NULL,
    category      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    checked_at    INTEGER,
    last_error    TEXT
  );

  -- The newest upload of each episode of a followed series. Downloading one
  -- adds a torrent as usual; the library hides releases it already has.
  CREATE TABLE releases (
    id           INTEGER PRIMARY KEY,
    follow_id    INTEGER NOT NULL REFERENCES follows(id) ON DELETE CASCADE,
    episode_num  REAL NOT NULL,
    nyaa_id      INTEGER NOT NULL,
    title        TEXT NOT NULL,
    torrent_url  TEXT NOT NULL,
    info_hash    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    published_at INTEGER NOT NULL,
    added_at     INTEGER NOT NULL,
    UNIQUE (follow_id, episode_num)
  );
  `,
  `
  -- An episode of a followed series the user removed from the library.
  ALTER TABLE releases ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Seeders as of the last follow check, to warn before streaming a dead upload. NULL: unknown.
  ALTER TABLE releases ADD COLUMN seeders INTEGER;
  `,
  `
  -- JSON: the audio and subtitle tracks last picked for the series (TrackPrefs in player.ts).
  ALTER TABLE folders ADD COLUMN track_prefs TEXT;
  `
]

let db: DatabaseSync | null = null

const BACKUPS_KEPT = 7
const BACKUP_EVERY_MS = 24 * 60 * 60_000

function dbPath(): string {
  return join(app.getPath('userData'), 'swarmplay.db')
}

interface DbShape {
  version: number
  /** Folders plus torrents: the library itself. */
  library: number
  settings: number
}

function shapeOf(conn: DatabaseSync): DbShape {
  const version = (conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const tables = new Set(
    (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
  )
  const count = (t: string): number =>
    tables.has(t) ? (conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : 0
  return { version, library: count('folders') + count('torrents'), settings: count('settings') }
}

/**
 * The shape of a copy of swarmplay.db, with or without its -wal. Only copies
 * are opened here: closing a connection to the real file would write the -wal
 * into it before there's a chance to set it aside.
 */
function shapeOfCopy(path: string, withWal: boolean): DbShape | null {
  const copy = join(dirname(path), 'swarmplay-check.db')
  const files = [copy, `${copy}-wal`, `${copy}-shm`]
  try {
    for (const f of files) rmSync(f, { force: true })
    copyFileSync(path, copy)
    if (withWal) copyFileSync(`${path}-wal`, `${copy}-wal`)
    const conn = new DatabaseSync(copy)
    try {
      return shapeOf(conn)
    } finally {
      conn.close()
    }
  } catch {
    return null
  } finally {
    for (const f of files) rmSync(f, { force: true })
  }
}

/**
 * SQLite applies whatever swarmplay.db-wal sits next to the database, even one
 * left by a different database (a copied file, another build). Its changes
 * then hide the library. A real WAL only adds to the file it belongs to, so
 * one that lowers the schema version, or empties the library and the settings
 * along with it, is set aside in "db-recovery" instead.
 */
function openGuarded(path: string): DatabaseSync {
  const wal = `${path}-wal`
  if (!existsSync(wal) || !existsSync(path) || statSync(path).size === 0) return new DatabaseSync(path)
  const main = shapeOfCopy(path, false)
  const view = shapeOfCopy(path, true)
  const foreign =
    !!main &&
    !!view &&
    (view.version < main.version || (main.library > 0 && view.library === 0 && view.settings < main.settings))
  if (!foreign) return new DatabaseSync(path)

  const dir = join(dirname(path), 'db-recovery')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(path + ext)) renameSync(path + ext, join(dir, `${stamp}-swarmplay.db${ext}`))
  }
  console.error(`Set aside a database log that didn't match swarmplay.db; it's in ${dir}`)
  return new DatabaseSync(path)
}

/** Copy the database to backups\ once a day, keeping the newest few. Skips an empty library. */
function backUp(): void {
  if (!db) return
  try {
    if (shapeOf(db).library === 0) return
    const dir = join(app.getPath('userData'), 'backups')
    mkdirSync(dir, { recursive: true })
    const old = readdirSync(dir)
      .filter((f) => /^swarmplay-[\d-]+\.db$/.test(f))
      .sort()
    const newest = old.at(-1)
    if (newest && Date.now() - statSync(join(dir, newest)).mtimeMs < BACKUP_EVERY_MS) return
    const name = `swarmplay-${new Date().toISOString().slice(0, 10)}.db`
    if (!old.includes(name)) {
      db.prepare('VACUUM INTO ?').run(join(dir, name))
      old.push(name)
    }
    for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) rmSync(join(dir, f), { force: true })
  } catch (err) {
    console.error('Failed to back up the database:', err)
  }
}

export function getDb(): DatabaseSync {
  if (db) return db
  db = openGuarded(dbPath())
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  backUp()
  setInterval(backUp, 60 * 60_000).unref()
  return db
}

function defaultSettings(): Settings {
  return {
    nyaaBaseUrl: 'https://nyaa.si',
    defaultCategory: '1_2',
    defaultFilter: 0,
    libraryRoot: join(app.getPath('videos'), 'Anime'),
    seedAfterDownload: true,
    downloadLimitKiB: 0,
    uploadLimitKiB: 0,
    mpvPath: '',
    autoplayNext: true,
    closeToTray: true,
    notifyOnDownload: true,
    notifyNewEpisodes: true,
    upscaler: 'off',
    autoSkip: 'off',
    autoTryAnother: false,
    autoUpdateCheck: true,
    streamCacheGB: 0
  }
}

// Read on every tick and request, so kept in memory; setSettings is the only writer.
let settingsCache: Settings | null = null

export function getSettings(): Settings {
  if (settingsCache) return { ...settingsCache }
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const defaults = defaultSettings()
  // The table also holds internal flags (see firstTime), so keep only real settings.
  const stored = Object.fromEntries(
    rows.filter((r) => r.key in defaults).map((r) => [r.key, JSON.parse(r.value)])
  )
  settingsCache = { ...defaults, ...stored }
  return { ...settingsCache }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const allowed = Object.keys(defaultSettings())
  const upsert = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.includes(key) && value !== undefined) upsert.run(key, JSON.stringify(value))
  }
  settingsCache = null
  return getSettings()
}

/** True the first time it's called for `key`, ever; for one-time tips. */
export function firstTime(key: string): boolean {
  const res = getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
    .run(`once:${key}`, 'true')
  return res.changes > 0
}

export function recordSearch(query: string): void {
  getDb()
    .prepare(
      'INSERT INTO search_history (query, searched_at) VALUES (?, ?) ON CONFLICT(query) DO UPDATE SET searched_at = excluded.searched_at'
    )
    .run(query, Date.now())
}

export function getRecentSearches(limit = 8): string[] {
  const rows = getDb()
    .prepare('SELECT query FROM search_history ORDER BY searched_at DESC LIMIT ?')
    .all(limit) as { query: string }[]
  return rows.map((r) => r.query)
}
