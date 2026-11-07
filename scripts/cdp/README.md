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
| `cleanup.js` | Deletes the test folders and their files |

Test data goes only in folders named `ZZ …` (`setup()` in `lib.js` follows a weekly series into "ZZ Stream Test"). Run `cleanup.js` when done; it deletes those folders with their downloads, so the library folder's `.swarmplay-streaming` ends up empty.
