// Try another: stopping playback mid-switch leaves the library as it was; a
// switch keeps the place in the episode and leaves one library entry for it.
// Uses the test folder (see lib.js); needs another upload of its first episode.
const { lib, folder } = await setup()
const [a] = episodeNums(lib, folder)
const entries = async () => (await window.api.getLibrary()).episodes.filter((e) => e.folderId === folder.id && e.episodeNum === a)
const key = (eps) => eps.map((e) => `${e.torrentId}:${e.fileIndex}`).join()
const at120 = async () => {
  await playEpisode(folder, a)
  await loaded()
  await window.api.playerCommand({ type: 'seek', seconds: 120 })
  return waitFor(async () => {
    const s = await window.api.getPlayerState()
    return s.timePos >= 119 ? s : null
  }, 30000, 200)
}

// Stop while the switch is searching: nothing in the library changes.
await at120()
const was = key(await entries())
const pending = window.api.tryAnotherRelease().then(
  (n) => `switched to ${n}`,
  (err) => String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
)
await sleep(300)
await window.api.playerCommand({ type: 'close' })
note('mid-switch stop:', await pending)
await sleep(1000)
let eps = await entries()
note('library unchanged', key(eps) === was, '| resume position', Math.round(eps[0]?.positionSec ?? -1), 's')
if (key(eps) !== was || !(eps[0]?.positionSec >= 110)) throw new Error('mid-switch check failed:\n' + log.join('\n'))

// A switch that runs through.
let s = await at120()
const before = s.torrentId
const t = Date.now()
const name = await window.api.tryAnotherRelease()
s = await loaded()
eps = await entries()
note('switched to', name, 'in', Date.now() - t, 'ms; now at', Math.round(s.timePos), 's')
note('library entries for episode', a, eps.length, '| on the new upload', eps[0]?.torrentId === s.torrentId && s.torrentId !== before)
if (s.torrentId === before || s.timePos < 110 || eps.length !== 1 || eps[0].torrentId !== s.torrentId) {
  throw new Error('switch check failed:\n' + log.join('\n'))
}
await window.api.playerCommand({ type: 'close' })
await sleep(2000)
return log.join('\n')
