// Copies an installed mpv into vendor/mpv so the installer can bundle it.
// Uses MPV_DIR if set, otherwise the winget (shinchiro.mpv) install location.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = process.env.MPV_DIR ?? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MPV Player')
const out = join(root, 'vendor', 'mpv')

if (!existsSync(join(src, 'mpv.exe'))) {
  console.error(`mpv.exe not found in ${src}. Install it (winget install shinchiro.mpv) or set MPV_DIR.`)
  process.exit(1)
}

// mpv.exe is a static build; the dll is needed for d3d11 shader compilation and
// fonts.conf for subtitle font lookup.
const files = ['mpv.exe', 'd3dcompiler_43.dll', join('mpv', 'fonts.conf')]

rmSync(out, { recursive: true, force: true })
for (const f of files) {
  if (!existsSync(join(src, f))) {
    console.error(`Missing ${f} in ${src}`)
    process.exit(1)
  }
  mkdirSync(dirname(join(out, f)), { recursive: true })
  copyFileSync(join(src, f), join(out, f))
}

const version = execFileSync(join(out, 'mpv.exe'), ['--version'], { encoding: 'utf8' }).split('\n')[0]
console.log(`Bundling ${version.trim()} from ${src}`)
