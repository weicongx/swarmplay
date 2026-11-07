// Usage: node scripts/release.mjs <x.y.z> [--publish] [--co-author "Name <email>"]
//
// The local half of a release: set the version, bump nyaa's User-Agent, build
// the installer, and draft release notes from the commits since the last tag.
// It then prints the commands that publish it (commit, push, GitHub release).
// With --publish it runs those too, which needs the GitHub CLI signed in
// (winget install GitHub.cli, then gh auth login).
//
// The in-app updater looks for an asset named Swarmplay-Setup-<version>.exe on
// the latest release, so the release must carry exactly that file.
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a))
const publish = args.includes('--publish')
const coAuthor = args.includes('--co-author') ? args[args.indexOf('--co-author') + 1] : null
if (!version) {
  console.error('Usage: node scripts/release.mjs <x.y.z> [--publish] [--co-author "Name <email>"]')
  process.exit(2)
}

const run = (cmd, cmdArgs, opts = {}) => {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`)
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} failed`)
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

if (git('branch', '--show-current') !== 'main') throw new Error('Release from main.')
if (git('status', '--porcelain')) throw new Error('Commit or stash your changes first; the release commit holds only the version bump.')
if (git('tag', '--list', `v${version}`)) throw new Error(`v${version} is already tagged.`)

// 1. Version, and the User-Agent nyaa sees (major.minor).
run('npm', ['version', version, '--no-git-tag-version'])
const nyaa = join(root, 'src/main/nyaa.ts')
const ua = readFileSync(nyaa, 'utf8')
const bumped = ua.replace(/(const USER_AGENT = 'swarmplay\/)[\d.]+/, `$1${version.split('.').slice(0, 2).join('.')}`)
if (bumped === ua && !ua.includes(`swarmplay/${version.split('.').slice(0, 2).join('.')} `)) {
  throw new Error("Couldn't find USER_AGENT in src/main/nyaa.ts")
}
writeFileSync(nyaa, bumped)

// 2. The installer.
run('npm', ['run', 'dist'])
const installer = join(root, 'dist', `Swarmplay-Setup-${version}.exe`)
if (!existsSync(installer)) throw new Error(`Expected ${installer}`)

// 3. Release notes to edit: one line per commit since the last release.
const lastTag = git('describe', '--tags', '--abbrev=0')
const subjects = git('log', '--format=%s', `${lastTag}..HEAD`).split('\n').filter(Boolean)
const notesFile = join(root, 'dist', `release-notes-${version}.md`)
writeFileSync(
  notesFile,
  `Download **Swarmplay-Setup-${version}.exe** and run it. It installs over earlier versions and keeps your library and settings. mpv is included. Installed copies of 1.4.0 and later can also update from Settings.\n\n` +
    subjects.map((s) => `- ${s}`).join('\n') +
    '\n'
)

const message = `Version ${version}` + (coAuthor ? `\n\nCo-Authored-By: ${coAuthor}` : '')
const steps = [
  ['git', ['commit', '-am', message]],
  ['git', ['push', 'origin', 'main']],
  ['gh', ['release', 'create', `v${version}`, installer, '--title', `Swarmplay ${version}`, '--notes-file', notesFile]]
]
console.log(`\nBuilt ${installer}\nRelease notes draft: ${notesFile}`)
if (!publish) {
  console.log('\nTo publish, edit the notes, then run:')
  for (const [c, a] of steps) console.log(`  ${c} ${a.map((x) => (/[\s<>]/.test(x) ? JSON.stringify(x) : x)).join(' ')}`)
  console.log(`\nThen install it with: "${installer}" /S --force-run`)
} else {
  for (const [c, a] of steps) run(c, a, { shell: false })
  console.log(`\nPublished v${version}.`)
}
