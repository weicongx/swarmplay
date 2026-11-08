// Measure streaming speed: how fast peers arrive, and how long seeks into parts
// not fetched yet take to play, with and without reading ahead under the seek bar.
// Downloads are capped (SPEED_CAP_KIB) so the episode isn't fetched whole before
// the seeks, and runs stay comparable. Follows a moderately seeded weekly series
// into "ZZ Speed Test" (the follow plays its ~300 MB HEVC upload); run cleanup.js
// before it, so the episode starts with nothing on disk.
const SPEED_CAP_KIB = 2048
const { lib, folder } = await setup('ZZ Speed Test', 'Erai-raws Keroro Gunsou 2026 1080p WEB-DL AVC', /Keroro Gunsou \(2026\) - \d+ \[1080p CR WEB-DL AVC/)
const nums = episodeNums(lib, folder)
// The newest episode: the most peers, and the same one each run.
const a = nums[nums.length - 1]
const before = await window.api.getSettings()
await window.api.setSettings({ downloadLimitKiB: SPEED_CAP_KIB })

try {
  let t = Date.now()
  await playEpisode(folder, a)
  // Peers and speed each second while it starts.
  const timeline = []
  const started = waitFor(async () => {
    const s = await window.api.getPlayerState()
    timeline.push(`${((Date.now() - t) / 1000).toFixed(0)}s:${s.numPeers}p/${(s.downloadSpeed / 1048576).toFixed(1)}`)
    return s.open && s.duration && !s.buffering ? s : null
  }, 120000, 1000)
  let s = await started
  note('episode', a, 'started in', Date.now() - t, 'ms;', s.title)
  for (let i = 0; i < 10; i++) {
    await sleep(1000)
    const n = await window.api.getPlayerState()
    timeline.push(`${((Date.now() - t) / 1000).toFixed(0)}s:${n.numPeers}p/${(n.downloadSpeed / 1048576).toFixed(1)}`)
  }
  note('peers/MiB/s:', timeline.join(' '))

  /** A spot that isn't fetched, nor near the playhead. */
  const unfetched = (state, used) =>
    [0.3, 0.55, 0.78, 0.42, 0.66, 0.9, 0.36, 0.6, 0.84, 0.48, 0.72, 0.95].find(
      (f) =>
        !used.has(f) &&
        Math.abs(f - state.timePos / state.duration) > 0.06 &&
        !state.fetched.some(([from, to]) => to > f - 0.01 && from < f + 0.03)
    )
  /** Seek, and time until playback moves again at the new spot. */
  const timedSeek = async (seconds) => {
    const t1 = Date.now()
    await window.api.playerCommand({ type: 'seek', seconds })
    let last = null
    await waitFor(async () => {
      const n = await window.api.getPlayerState()
      const moving = !n.buffering && !n.paused && n.timePos >= seconds - 15 && last != null && n.timePos > last + 0.05
      last = n.timePos >= seconds - 15 ? n.timePos : null
      return moving
    }, 120000, 100)
    return Date.now() - t1
  }

  const used = new Set()
  const results = { plain: [], preview: [] }
  for (let round = 0; round < 4; round++) {
    for (const mode of ['plain', 'preview']) {
      s = await window.api.getPlayerState()
      const f = unfetched(s, used)
      if (f == null) {
        note('no unfetched spot left to seek to')
        break
      }
      used.add(f)
      const target = Math.round(s.duration * f)
      // Hovering for 2 s before letting go; plain waits as long without it. The app
      // fetches under the cursor only with 20 s buffered ahead, which the cap leaves room for.
      // Before the seek bar fetched ahead, this did nothing: a baseline run measures plain seeks only.
      if (mode === 'preview') await window.api.playerCommand({ type: 'seek-preview', seconds: target })
      await sleep(2000)
      const ms = await timedSeek(target)
      results[mode].push(ms)
      const now = await window.api.getPlayerState()
      note(`seek (${mode}) to ${(f * 100).toFixed(0)}%: playing after ${ms} ms | ${now.numPeers} peers, ${(now.downloadSpeed / 1048576).toFixed(1)} MiB/s`)
      await sleep(3000)
    }
  }
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : null)
  note('average seek ms:', { plain: avg(results.plain), preview: avg(results.preview) })
} finally {
  await window.api.playerCommand({ type: 'close' })
  await window.api.setSettings({ downloadLimitKiB: before.downloadLimitKiB })
  await sleep(2000)
}
return log.join('\n')
