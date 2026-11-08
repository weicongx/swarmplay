// Batches of a show with several seasons: the first goes in a series folder with
// a folder per season, matched to AniList; a later batch of the same show, numbered
// on from the first or per season, joins the same series folder, and a season's
// folder made before (here, as if streamed week by week) moves in. Nothing downloads.
const SERIES = 'ZZ Batch Test'
const BATCHES = [/Slime Datta Ken \(01-48\)/, /Slime Datta Ken \(49-72\)/, /Slime Datta Ken S4 \(01-24\)/]

const page = await window.api.searchNyaa({ query: 'SubsPlease Tensei Shitara Slime Datta Ken batch', category: '1_2', filter: 0, sort: 'seeders' })
const picks = BATCHES.map((re) => page.results.find((r) => re.test(r.title)))
if (picks.some((p) => !p)) throw new Error(`Missing batch: ${BATCHES.filter((_, i) => !picks[i]).join(', ')}`)

const earlier = await window.api.createFolder('Tensei Shitara Slime Datta Ken S3', null)

for (const [n, r] of picks.entries()) {
  const started = Date.now()
  const plan = await window.api.planBatch(r.torrentUrl)
  if (!plan) throw new Error(`No season plan for ${r.title}`)
  note(r.title, `planned in ${Date.now() - started} ms; series folder`, plan.series.folderId ?? 'new', '·',
    plan.seasons.map((s, i) => `${s.label}: ${plan.files.filter((f) => f.season === i).length}`).join(', '))
  // The first add names the series folder; later ones must find it on their own.
  const folder = n === 0 ? { name: SERIES } : plan.series.folderId != null ? { id: plan.series.folderId } : { name: 'ZZ Batch Test (should merge)' }
  const res = await window.api.addToLibrary({ torrentUrl: r.torrentUrl, nyaaId: r.id, folder })
  note('  filed in', res.filed?.name, res.filed?.seasons.map((s) => `${s.label} (${s.episodes})`).join(', '))
}

const lib = await window.api.getLibrary()
const series = lib.folders.filter((f) => f.name.startsWith('ZZ Batch Test'))
if (series.length !== 1) throw new Error(`Expected one series folder, found ${series.map((f) => f.name).join(', ')}`)
note('Series folder:', series[0].name, '· AniList:', series[0].anilist?.title)
for (const s of lib.folders.filter((f) => f.parentId === series[0].id)) {
  const eps = lib.episodes.filter((e) => e.folderId === s.id).map((e) => e.episodeNum)
  note(`  ${s.name} [${s.anilist?.title}]: ${eps.length} eps:`, eps.join(','))
}
const moved = lib.folders.find((f) => f.id === earlier)
if (moved?.parentId !== series[0].id) throw new Error('The earlier season folder stayed outside the series folder')
note('Earlier season folder now:', moved.name)
note('Episodes left directly in the series folder:', lib.episodes.filter((e) => e.folderId === series[0].id).length)
return log.join('\n')
