// Delete every "ZZ …" test folder with its downloads and streams, and report what's left.
const lib = await window.api.getLibrary()
for (const f of lib.folders.filter((x) => x.name.startsWith('ZZ ') && x.parentId == null)) {
  await window.api.deleteFolder(f.id, true)
  note('deleted', f.name)
}
await sleep(4000)
const after = await window.api.getLibrary()
note('folders left:', after.folders.map((f) => f.name).join(' / ') || 'none')
note('stream cache in use:', await window.api.getStreamCacheSize(), 'bytes')
return log.join('\n')
