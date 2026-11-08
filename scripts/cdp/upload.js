// Before a followed episode is first played, a weakly seeded upload gives way to
// a well-seeded one of the same episode and resolution (uploads.ts). Follows a
// series whose older uploads have few seeders, streams the weakest episode, and
// reports which upload played. Run cleanup.js afterwards. It depends on nyaa's
// live counts: once every episode there has 10 seeders or more, it says so and
// the switch isn't exercised.
const { folder } = await setup(
  'ZZ Upload Test',
  'EMBER Gachiakuta 1080p',
  /^\[EMBER\] Gachiakuta S01E\d+ \[1080p\]/
)
const lib = await window.api.getLibrary()
const avail = lib.available.filter((e) => e.folderId === folder.id)
note('stored:', avail.map((e) => `${e.episodeNum}:${e.seeders}s`).join(' '))
const weakest = [...avail].sort((a, b) => (a.seeders ?? 0) - (b.seeders ?? 0))[0]
if (!weakest) return log.concat('no episode left to stream').join('\n')
if ((weakest.seeders ?? 0) >= 10) note('no upload under 10 seeders here, so no switch is expected; pick another series')
note(`streaming episode ${weakest.episodeNum}: ${weakest.title} (${weakest.seeders} seeders stored)`)

const t = Date.now()
await window.api.streamRelease(weakest.id)
await loaded()
note(`started in ${Date.now() - t} ms`)
const after = await window.api.getLibrary()
const ep = after.episodes.find((e) => e.folderId === folder.id && e.episodeNum === weakest.episodeNum)
note('playing upload:', ep?.title ?? '(not in the library)')
note(ep && ep.title !== weakest.title ? 'switched to a better-seeded upload' : 'kept the stored upload')
await window.api.playerCommand({ type: 'close' })
return log.join('\n')
