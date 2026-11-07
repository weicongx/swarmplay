# Checks over the DevTools Protocol

Scripts that drive a running Swarmplay through `window.api`, the same bridge the UI uses, to check behavior without screenshots. Each check runs inside the renderer as one async function, with the helpers in `lib.js` prepended, and prints its report.

```powershell
scripts\cdp\relaunch.ps1                 # build, then start from source with CDP on port 9333
node scripts\cdp\run.mjs scripts\cdp\smoke.js
node scripts\cdp\run.mjs scripts\cdp\cleanup.js
```

`relaunch.ps1` runs the app on a test profile: its own database, settings and library folder in `%LOCALAPPDATA%\ZZ Swarmplay test`, or in the folder set in `SWARMPLAY_PROFILE`. The checks never see your real library, and the installed app can stay open. It stops only an earlier run from this repo, along with that run's mpv. To start over, delete the profile folder.

| Check | What it covers |
|---|---|
| `smoke.js` | Settings, library, mpv found, a search page sorted by seeders |
| `stream.js` | Streaming an episode, fetching the next one ahead, Next starting quickly |
| `tracks.js` | Audio and subtitle picks carrying over to the series' other episodes |
| `mini.js` | The mini player while browsing, through autoplay, and back |
| `another.js` | **Try another**: stopping mid-switch leaves the library as it was; a switch keeps the position and one library entry |
| `companion.mjs` | The phone companion, end to end (see below) |
| `cleanup.js` | Deletes the test folders and their files |

`companion.mjs` runs in Node rather than in the renderer: it drives the app through `window.api` over the same protocol, and plays the phone's part with plain HTTP. Start the app with the companion bound to `127.0.0.1`, so Windows Firewall never asks, and with short grace and idle times:

```powershell
$env:SWARMPLAY_COMPANION_HOST = '127.0.0.1'
$env:SWARMPLAY_COMPANION_GRACE_MS = '6000'
$env:SWARMPLAY_COMPANION_IDLE_MS = '10000'
scripts\cdp\relaunch.ps1
node scripts\cdp\companion.mjs
```

It turns the companion on at port 47819 and covers: refusing unpaired requests, bad `Host` names and cross-site POSTs; pairing codes running out and being used up; the library; Play and the video's byte ranges, matched against WebTorrent's own except for the tracks' flags; English subtitles marked default for VLC; the duration from the mkv, and watched past 90%; the session ending after the grace and after idling; the PC taking over; Stop on the phone and on the PC, with VLC's reconnects refused afterwards; deleting the folder mid-stream; removing the phone; the limit on pairing tries; and idle CPU. It deletes the test folder itself, and leaves the companion off. It also removes every paired phone, so to keep a real phone paired on the test profile, set `$env:SWARMPLAY_PROFILE` to another `ZZ …` folder before `relaunch.ps1`, and delete that folder afterwards. These variables only work from source; the installed app ignores them. With them set, the server listens on 127.0.0.1 only and the QR code points there, so a real phone can't connect: to pair one with the test copy afterwards, run `relaunch.ps1` again from a terminal without them.

Test data goes only in folders named `ZZ …` (`setup()` in `lib.js` follows a weekly series into "ZZ Stream Test"). Run `cleanup.js` when done; it deletes those folders with their downloads, so the library folder's `.swarmplay-streaming` ends up empty.
