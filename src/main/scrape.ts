import { bdecode, type BValue } from './bencode'
import { getDb } from './db'
import { AVAILABLE_SQL } from './library'

// nyaa's tracker answers scrapes for many torrents in one request, with live
// seeder counts; nyaa's pages show the same counts, but only as of the last check.
const SCRAPE_URL = 'http://nyaa.tracker.wf:7777/scrape'
/** Hashes per request, which keeps the URL short */
const BATCH = 40
const TIMEOUT_MS = 10_000
/** A torrent scraped this recently isn't scraped again */
const FRESH_MS = 10 * 60_000

const scrapedAt = new Map<string, number>()

/** Seeders per info-hash (hex), for the torrents the tracker knows. Failures leave hashes out. */
export async function scrapeSeeders(infoHashes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < infoHashes.length; i += BATCH) {
    const batch = infoHashes.slice(i, i + BATCH)
    const query = batch.map((h) => 'info_hash=' + h.replace(/../g, '%$&')).join('&')
    try {
      const res = await fetch(`${SCRAPE_URL}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) continue
      // The files dict is keyed by the raw 20-byte hashes.
      const { value } = bdecode(Buffer.from(await res.arrayBuffer()), 'latin1')
      const files = (value as { [k: string]: BValue }).files as { [k: string]: { complete?: BValue } } | undefined
      for (const [key, stats] of Object.entries(files ?? {})) {
        if (typeof stats.complete === 'number') out.set(Buffer.from(key, 'latin1').toString('hex'), stats.complete)
      }
    } catch {
      // Tracker down or slow: keep the counts we have.
    }
  }
  return out
}

/**
 * Refresh the seeder counts of a folder's episodes that are on nyaa but not in
 * the library, from the tracker. Scheduled follow checks only read the newest
 * page, so older episodes' counts would otherwise date from the first check.
 * True if any count changed.
 */
export async function refreshFolderSeeders(folderId: number): Promise<boolean> {
  const db = getDb()
  const rows = db
    .prepare(`SELECT r.info_hash, r.seeders FROM releases r WHERE r.id IN (SELECT id FROM (${AVAILABLE_SQL}) WHERE folder_id = ?)`)
    .all(folderId) as { info_hash: string; seeders: number | null }[]
  const now = Date.now()
  const due = rows.filter((r) => now - (scrapedAt.get(r.info_hash) ?? 0) > FRESH_MS)
  if (due.length === 0) return false
  for (const r of due) scrapedAt.set(r.info_hash, now)
  const counts = await scrapeSeeders(due.map((r) => r.info_hash))
  const update = db.prepare('UPDATE releases SET seeders = ? WHERE info_hash = ?')
  let changed = false
  for (const r of due) {
    const n = counts.get(r.info_hash)
    if (n == null) {
      scrapedAt.delete(r.info_hash) // try again next time
    } else if (n !== r.seeders) {
      update.run(n, r.info_hash)
      changed = true
    }
  }
  return changed
}
