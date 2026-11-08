// "Download all" on a folder: one season of a batch keeps only that season; the series
// folder covers its seasons, and overlapping requests add nothing twice; on a followed
// series, the button in the page fetches the episodes not added yet. Capped at 50 KiB/s,
// so little downloads. Run cleanup.js afterwards.
const SERIES = 'ZZ Download All'
const FOLLOWED = 'ZZ Download All Followed'
const kept = (lib, ids) => lib.episodes.filter((e) => ids.includes(e.folderId))
const describe = (eps) => `${eps.filter((e) => e.downloaded).length}/${eps.length} downloaded`
const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}

const { downloadLimitKiB } = await window.api.getSettings()
await window.api.setSettings({ downloadLimitKiB: 50 })
try {
  const page = await window.api.searchNyaa({ query: 'SubsPlease Tensei Shitara Slime Datta Ken batch', category: '1_2', filter: 0, sort: 'seeders' })
  const batch = page.results.find((r) => /Slime Datta Ken \(01-48\)/.test(r.title))
  assert(batch, 'No batch found')
  await window.api.addToLibrary({ torrentUrl: batch.torrentUrl, nyaaId: batch.id, folder: { name: SERIES } })

  let lib = await window.api.getLibrary()
  const series = lib.folders.find((f) => f.name === SERIES)
  const seasons = lib.folders.filter((f) => f.parentId === series.id).map((f) => f.id)
  assert(seasons.length > 1, 'Expected several seasons')
  assert(kept(lib, seasons).every((e) => !e.downloaded), 'Episodes were downloaded before asking')

  await window.api.downloadFolder(seasons[0])
  lib = await window.api.getLibrary()
  const first = kept(lib, [seasons[0]])
  const rest = kept(lib, seasons.slice(1))
  note('After one season:', describe(first), '· other seasons', describe(rest))
  assert(first.every((e) => e.downloaded), 'The season was not fully kept')
  assert(rest.every((e) => !e.downloaded), 'Another season was kept too')

  await Promise.all([window.api.downloadFolder(series.id), window.api.downloadFolder(series.id)])
  lib = await window.api.getLibrary()
  const all = kept(lib, seasons)
  note('After the series:', describe(all), '· torrents', new Set(all.map((e) => e.torrentId)).size)
  assert(all.every((e) => e.downloaded), 'The series was not fully kept')

  const { folder } = await setup(FOLLOWED)
  lib = await window.api.getLibrary()
  const waiting = lib.available.filter((a) => a.folderId === folder.id)
  note('Followed series: episodes not added yet:', waiting.length)
  assert(waiting.length > 0, 'Nothing to download in the followed series')

  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith(label))
  document.querySelectorAll('.nav-item').forEach((n) => n.textContent.includes('Library') && n.click())
  const card = await waitFor(() => [...document.querySelectorAll('.folder-card')].find((c) => c.textContent.includes(FOLLOWED)), 10000, 100)
  card.click()
  const start = await waitFor(() => button('Download all'), 10000, 100)
  note('Button:', start.textContent)
  start.click()
  lib = await waitFor(async () => {
    const l = await window.api.getLibrary()
    return !l.available.some((a) => a.folderId === folder.id) && !button('Starting') ? l : null
  })
  const eps = kept(lib, [folder.id])
  note('After the button:', describe(eps), '· duplicate episodes', eps.length - new Set(eps.map((e) => e.episodeNum)).size)
  assert(eps.length >= waiting.length && eps.every((e) => e.downloaded), 'The followed series was not fully kept')
  await waitFor(() => !button('Download all'), 20000, 200)
  note('Button gone once everything is downloading')
} finally {
  await window.api.setSettings({ downloadLimitKiB })
}
return log.join('\n')
