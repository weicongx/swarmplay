// Usage: node scripts/cdp/run.mjs <check.js> [more.js ...]
// Joins the files (lib.js first, always) and runs them as one async function in
// the Swarmplay renderer over the Chrome DevTools Protocol. Start the app with
// relaunch.ps1 first. The check's return value is printed.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const port = process.env.SWARMPLAY_CDP_PORT ?? '9333'
const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Usage: node scripts/cdp/run.mjs <check.js> [more.js ...]')
  process.exit(2)
}
const body = [join(here, 'lib.js'), ...files].map((f) => readFileSync(f, 'utf8')).join('\n')

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
// The app has two pages: the renderer, and the blank one hosting mpv's window.
const page = targets.find((t) => t.type === 'page' && t.url.includes('/renderer/index.html'))
if (!page) throw new Error(`No Swarmplay renderer on port ${port}; run relaunch.ps1 first`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== 1) return
  const r = msg.result
  if (r?.exceptionDetails) {
    console.error('EXCEPTION:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    process.exitCode = 1
  } else {
    const v = r?.result?.value
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  }
  ws.close()
}
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true, timeout: 600000 }
  })
)
