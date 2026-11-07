// Helpers prepended to every check by run.mjs. Checks run inside the renderer
// and use window.api, the same bridge the UI uses.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 120000, step = 500) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  throw new Error('timeout waiting')
}
const log = []
const t0 = Date.now()
/** Add a timestamped line to the report; return log.join('\n') at the end of a check. */
const note = (...a) =>
  log.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
/** Wait until the player has opened a file and isn't buffering. */
const loaded = () =>
  waitFor(async () => {
    const s = await window.api.getPlayerState()
    return s.open && s.duration && !s.buffering ? s : null
  }, 120000, 200)

// The database is shared with the installed app, so test data lives only in
// folders named "ZZ …", which cleanup.js deletes with their files.
const TEST_FOLDER = 'ZZ Stream Test'
const TEST_QUERY = 'overgeared judas 1080p'

/** The test folder, following a weekly series in it if it isn't there yet. */
const setup = async () => {
  let lib = await window.api.getLibrary()
  let folder = lib.folders.find((f) => f.name === TEST_FOLDER)
  if (!folder || !lib.follows.some((f) => f.folderId === folder.id)) {
    const page = await window.api.searchNyaa({ query: TEST_QUERY, category: '1_2', filter: 0, sort: 'date' })
    const pick = page.results.find((r) => /S01E0\d/.test(r.title))
    if (!pick) throw new Error(`No result for "${TEST_QUERY}" to follow`)
    await window.api.followSeries(pick, { name: TEST_FOLDER })
    lib = await window.api.getLibrary()
    folder = lib.folders.find((f) => f.name === TEST_FOLDER)
  }
  return { lib, folder }
}

/** Every episode number in the test folder, in the library or only on nyaa. */
const episodeNums = (lib, folder) =>
  [...new Set([...lib.episodes, ...lib.available].filter((e) => e.folderId === folder.id).map((e) => e.episodeNum))].sort(
    (a, b) => a - b
  )

/** Play an episode of the test folder by number, streaming it if it isn't in the library yet. */
const playEpisode = async (folder, n) => {
  const lib = await window.api.getLibrary()
  const e = lib.episodes.find((x) => x.folderId === folder.id && x.episodeNum === n)
  if (e) return window.api.play(e.torrentId, e.fileIndex)
  const rel = lib.available.find((x) => x.folderId === folder.id && x.episodeNum === n)
  if (!rel) throw new Error(`Episode ${n} isn't in ${folder.name}`)
  return window.api.streamRelease(rel.id)
}
