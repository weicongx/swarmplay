import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
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
  `
]

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(join(app.getPath('userData'), 'swarmplay.db'))
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
    upscaler: 'off'
  }
}

export function getSettings(): Settings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const defaults = defaultSettings()
  // The table also holds internal flags (see firstTime), so keep only real settings.
  const stored = Object.fromEntries(
    rows.filter((r) => r.key in defaults).map((r) => [r.key, JSON.parse(r.value)])
  )
  return { ...defaults, ...stored }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const allowed = Object.keys(defaultSettings())
  const upsert = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.includes(key) && value !== undefined) upsert.run(key, JSON.stringify(value))
  }
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
