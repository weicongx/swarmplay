# Swarmplay

A Windows desktop app for streaming anime from torrents. Search nyaa.si, pick a release, and start watching in the app within seconds, without saving the episode to disk. Episodes land in a library of series folders with AniList cover art, playback picks up where you left off, and you can download any episode to keep it.

## Features

- **Search nyaa.si** by category and filter (trusted only, no remakes). Results come sorted by most seeders, the uploads that stream best, or by date, size or downloads, across every match rather than just the newest. **Load more** pages through up to 1000 results. Press **▶** on a result to start streaming it straight away, filed in the series' folder, or open the result to see its file list first.
- **Streaming first.** Press **Stream** to play an episode within seconds. WebTorrent fetches the pieces near the playhead first. Nothing is kept: the data goes to a hidden temporary folder that's deleted when playback stops. The episode stays in the library so you can stream it again. If you rewatch a lot, Settings can keep recently streamed episodes up to a size you choose, so they replay without peers. This is off by default.
- **Download only what you want to keep.** Press **Download** in Search, or on any library episode, even mid-stream. An episode streamed and then downloaded keeps what's already fetched.
- **In-app player.** mpv draws the video inside the app window, with Swarmplay's own controls: seek bar, volume, audio and subtitle tracks, and fullscreen. The audio and subtitles you pick are remembered for the series, so its other episodes start with the same language, or with subtitles off. **Now streaming** at the foot of the sidebar shows the episode, download speed and peers. Browsing the app shrinks the player into a corner (the mini player), where the episode keeps playing. While streaming, the seek bar shades the parts already fetched, which play without waiting. A click on the seek bar goes to that spot, and the bar stays there while a stream fetches it. When it buffers, the player shows the download speed and peer count.
- **Resume and autoplay.** Your position saves every few seconds. An episode counts as watched at 90%, and the next one in the folder starts automatically, including new episodes of a followed series you haven't streamed yet.
- **Skip intro and credits.** When a release names its chapters (OP, Opening, ED, Ending and similar), the player shows **Skip intro** during the opening and **Skip credits** during the ending. Settings can skip openings, or both, automatically.
- **Next episode loads early.** Near the end of an episode, Swarmplay starts fetching the start of the next one, so autoplay (or **Next**) begins at once instead of waiting for peers. If you stop watching instead, that data is deleted like any stream.
- **Seeders before you press play.** Search results and a followed series' new episodes show how many people are seeding each upload. With two or fewer, the count turns amber and Search warns that streaming may stall. Opening a folder updates its counts live from nyaa's tracker.
- **Switch to a faster upload.** If a stream is stuck buffering or has no peers for 15 seconds, the player offers **Try another**. It finds the best-seeded other upload of the same episode on nyaa, from any group, and carries on from the same moment. The library episode points at the new upload from then on. Turn on **Switch to another upload automatically** in Settings to have it switch without asking, once per episode.
- **Upscaling.** Two options:
  - Anime4K shaders, which run on any GPU.
  - NVIDIA RTX Video Super Resolution, which needs an RTX card.

  Switch between them live from the player.
- **Library.**
  - New downloads go into one folder per series. The folder name is parsed from the release name, with the season normalized (*S2*, *2nd Season* and *- S02* all become *Show S2*).
  - Folders can be nested and renamed.
  - Episodes move between folders by drag and drop.
  - Each episode has **Delete**. For a downloaded episode, **Delete file** frees the space and keeps the episode to stream, and **Remove from library** takes it out entirely. The series folder stays either way.
- **Follow a series.** Pick any episode in Search and choose **Add series to library**. Swarmplay finds that group's other uploads of the series (same season and resolution) and lists them in the folder without downloading, each with **Stream** and **Download**. The first check reads every page of results, so a long-running series lists all its episodes, not just the newest 75. After that it checks nyaa every 30 minutes and adds new episodes as they come out, with a notification. **Check now** reads every page again. Each check also refreshes the episodes' seeder counts.
- **AniList.** Folders link to their AniList entry for the cover, alternate titles and episode count. An English-titled release still finds the folder you named in romaji. *Continue watching* sits at the top of the library.
- **Updates itself.** Swarmplay checks GitHub for a new version when it starts and every six hours. When there is one, the sidebar shows **Update to X**, and **Install and restart** in Settings downloads it, checks it against GitHub's checksum, and installs it over the current version, keeping your library and settings.
- **Background downloads.** Downloads keep going from the tray when you close the window. Swarmplay notifies you when an episode finishes, and seeds afterwards if you want.

## Install

Download `Swarmplay-Setup-<version>.exe` from the [latest release](https://github.com/weicongx/swarmplay/releases/latest) and run it. That's the only step. The installer includes [mpv](https://mpv.io) for playback, installs for your user only with no admin prompt, and adds Start-menu and desktop shortcuts.

The installer isn't code-signed, so SmartScreen warns the first time. Click **More info → Run anyway**.

On first launch Windows Firewall asks whether Swarmplay may accept connections. Allowing it lets peers connect to you, which speeds up downloads and lets you seed.

If you already have mpv installed (winget, scoop, Chocolatey, `C:\Program Files` or on `PATH`), Swarmplay uses yours. Otherwise it uses the bundled copy. To use a specific mpv.exe, set its path in **Settings**.

## Build from source

You need Windows, a recent Node.js (developed on Node 24), and mpv installed locally:

```bash
winget install shinchiro.mpv
```

```bash
npm install
npm run dev
```

`npm run dist` copies the installed mpv (`C:\Program Files\MPV Player`, or the folder in `MPV_DIR`) into `vendor/mpv` and bundles it into the installer.

Running from source uses the installed app's database and library unless you set `SWARMPLAY_PROFILE` to a folder. The app then keeps its database, settings, backups and library (`<folder>\Videos\Anime`) there, and can run alongside the installed app. Installed builds ignore it. `scripts/cdp/relaunch.ps1` uses `%LOCALAPPDATA%\ZZ Swarmplay test` by default.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload |
| `npm run typecheck` | Type-checks the main, preload and renderer code |
| `npm run build` | Bundles everything into `out/` |
| `npm run dist` | Builds the NSIS installer, with mpv bundled, at `dist/Swarmplay-Setup-<version>.exe` |
| `node scripts/make-icon.mjs` | Regenerates the app and tray icons in `resources/` |
| `node scripts/release.mjs <x.y.z>` | Sets the version, bumps nyaa's User-Agent, builds the installer, drafts release notes, and prints the commit, push and `gh release create` commands (`--publish` runs them) |
| `npm run check -- scripts/cdp/<check>.js` | Runs a behavior check in the running app over the DevTools Protocol (see `scripts/cdp/README.md`) |

## Using it

1. **Search.** Type a show name. Results start with the most seeded; change **Sort** or press **Load more** at the bottom for more. Press **▶** on a result to stream it at once. Or click the result to open its details, tick the episodes you want, and pick a library folder (one is suggested from the release name).
2. **Stream** plays the first ticked episode right away and adds the episodes to the library without saving them. **Download** saves the files in the background.
3. **Downloads** shows progress, speed and peers for each download, with pause, resume and remove. Remove keeps the episodes in the library to stream, and can also delete the files. While you stream, the stream shows here too. The badge on **Downloads** counts only downloads still fetching, so streaming never adds to it. The download an episode is playing from can't be paused until you stop playback, since pausing would cut the episode off; **Pause all** in the tray skips it. Removing it, or deleting a folder with its downloads, stops playback first.
4. **Add series to library** (in the same panel) follows the series instead of picking one episode. Its new episodes show up in the folder with **Stream** and **Download**, and **Remove** hides one you don't want. Each one shows its seeders as of the last check, with ⚠ at two or fewer. **Unfollow** in the folder header stops it and removes the episodes you never downloaded.
5. **Library** holds your series folders. Click an episode to play it. To browse while it plays, press **Mini player** or click Search, Downloads, Library or Settings in the sidebar. The video keeps playing in a corner; click it, or **Now streaming** in the sidebar, to go back. Each episode shows whether it's downloaded, with **Download** and **Delete**. Use **Find on AniList** when a folder didn't get a cover automatically.

### Player keys

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Seek 5 s (hold Shift for 30 s) |
| ↑ / ↓ | Volume |
| M | Mute |
| F / double-click | Fullscreen |
| N | Next episode |
| S | Skip the opening or ending |
| U | Cycle upscaling (off → Anime4K → RTX) |
| I | Mini player |
| Esc | Leave fullscreen, then close the player |

### Settings

- nyaa mirror URL, and the default category and filter for searches
- Library folder on disk (default `Videos\Anime`)
- Download and upload speed limits
- Whether to seed after downloading
- Autoplay next episode
- Keep recently streamed episodes, up to a number of GB (off by default)
- Openings and endings: a Skip button, or skip automatically
- Switch to another upload automatically when a stream is slow (off by default)
- Check for updates automatically (on by default)
- Close to tray
- Download notifications
- Upscaling mode
- mpv path

## Upscaling

Upscaling runs inside mpv during playback. Changing it takes effect immediately, without restarting the episode.

- **Anime4K** uses the bundled [Anime4K](https://github.com/bloc97/Anime4K) v4.0.1 *Mode A* GLSL shaders, which are tuned for 1080p sources. It works on any reasonably modern GPU.
- **RTX** adds mpv's `d3d11vpp` filter with `scaling-mode=nvidia` and scales the video to your screen's height (up to 4×). It only appears when an NVIDIA GPU is detected, and it switches decoding to `d3d11va`.

  You also need to turn on **RTX Video Enhancement → Super Resolution** in the NVIDIA App. Without it the driver falls back to ordinary scaling.

## How it works

```
nyaa.si search ──► result list ──► .torrent ──► WebTorrent ──► files in <library>/<folder>/
                                                    │
                                  local HTTP server (127.0.0.1, range requests)
                                                    │
                                     mpv ◄── JSON IPC ── main process ◄── IPC ── React UI
```

- **Search.** Results come from nyaa's search page, which sorts on the server and pages through up to 1000 matches, 75 a page. Its results table is read for the title, size, date, seeders, leechers, downloads and comment count, and the info-hash comes from the magnet link. If the page can't be read (a mirror with another layout, a changed layout, or an error), Swarmplay falls back to the RSS feed. That feed returns only the newest 75 matches, so Search says so and sorts those itself. A full follow check reads the pages one at a time, a second apart, and scheduled checks read only the newest page. `.torrent` files are parsed by a small bencode decoder that also computes the info-hash. Opening a folder scrapes nyaa's tracker (`nyaa.tracker.wf`) for the seeder counts of its episodes not yet in the library, up to 40 torrents per request and each at most every 10 minutes, since scheduled follow checks only refresh the newest page.
- **Streaming.**
  - WebTorrent serves every active torrent at `http://127.0.0.1:<port>/webtorrent/<infoHash>/<path>`. mpv plays from that URL, and each range request moves WebTorrent's download priority to the pieces mpv is reading.
  - The server only answers requests that carry no browser `Origin`, so web pages can't read from it.
  - Files that are already complete play straight from disk.
  - A stream-only torrent saves into `<library>\.swarmplay-streaming\<infoHash>`, a hidden folder on the same drive as the library. When playback stops (or another episode starts) the torrent is stopped and that folder is deleted. Downloading an episode mid-stream keeps the data. When playback stops, the file is moved (a rename, since it's the same drive) into the series folder. Leftover stream folders are cleared at startup.
  - Streaming an episode of a batch you've partly downloaded writes into the series folder, where the batch lives. When playback stops, the streamed file is deleted there. Pieces span file boundaries and WebTorrent writes whole pieces, so the files next to a kept one also get a fragment. The one after is trimmed to that fragment, and the one before is deleted only if you streamed it. A file that shares a piece on both sides with kept files is left alone.
  - Quitting mid-stream stops mpv and cleans up as stopping playback would, waiting up to 5 seconds. Whatever that misses is cleared at the next start.
  - With the stream cache on, a stream's folder stays when playback stops, and its time is marked as last used. Streaming it again re-checks the pieces on disk and plays them without peers. The cache is then trimmed, oldest first, to the limit. The folder playing or fetched ahead counts toward the limit but is never deleted. Sizes are file sizes, not bytes fetched: once mpv has read the end of an mkv (its seek index), Windows allocates the whole file. Folders left at startup, including ones no torrent uses anymore, stay until they're the oldest. Turning the limit down trims at once, and turning the cache off clears it. Removing an episode from the library still deletes its stream folder.
  - Once a second the player reads which of the file's pieces WebTorrent has and shades them on the seek bar. Byte positions are mapped to time in proportion, so the shading is close but not exact for variable-bitrate video. While buffering, the top bar shows the torrent's download speed and peer count, and in fullscreen the bars stay up until playback resumes.
  - Skipping uses mpv's `chapter-list`. A chapter whose title has OP, Opening or Intro (or ED, Ending, Credits or Outro) as a word counts, if it's no longer than 200 seconds. A longer one is more likely a cold open or the episode itself. Skipping seeks to the next chapter's start. An ending that's the last chapter skips to the end of the file, so autoplay moves on. Auto-skip handles each chapter once per episode, so seeking back into an opening plays it. In fullscreen, where the bars may be hidden, mpv's on-screen text says when you can press S, and also shows the buffering speed and peers.
  - At 85% of an episode, or when a chapter named ED, Ending or Credits starts, the next episode is prefetched: its first 40 MB and last 2 MB (where an mkv keeps its seek index). A followed series' next episode is added to the library first. Prefetching waits until mpv has at least 30 seconds buffered, and it adds no stream selection of its own, so it only gets bandwidth the playing file doesn't need. In a batch, where the next episode is in the same torrent, that means it waits until the rest of the playing file is fetched. Next still starts quickly there, because the torrent is already connected to its peers. Playing into it takes over its torrent. Closing the player or playing something else stops it and deletes what it fetched.
  - A stream counts as slow after 15 seconds of buffering (mpv's `core-idle` while not paused), or 15 seconds with no peers before the file is fully cached. **Try another** then searches nyaa under the release's series name and the folder's AniList titles (up to three queries) and keeps results for the same episode number and season. It doesn't offer one that has no seeders, or a dub-only upload in place of a subbed one. It picks the result with the most seeders, preferring the current resolution between equals. The new upload is streamed into the same folder, starting at the same position. It takes over the episode's watched state, its resume position and the followed series' release entry. If the old upload was only streamed, its torrent and data are removed. If playback stops or moves to another episode before the switch, the library is left as it was.
- **Pause.** Pausing removes the torrent from the WebTorrent client entirely, because WebTorrent's own pause only stops new connections. Resuming re-adds the torrent and re-checks the pieces already on disk.
- **Player.**
  - One long-lived mpv process (`--idle`) is controlled over a named pipe. It renders with `--wid` into a borderless child window that the main process keeps positioned over the player page's video area. The page draws the controls on top.
  - The child window ignores the mouse so that clicks reach the page.
  - Chromium's DirectComposition is turned off, because it layers the page above child windows and hides the video.
- **Library and matching.**
  - Release names are parsed with [anitomy](https://www.npmjs.com/package/anitomy). Folder matching ignores case and punctuation.
  - AniList auto-linking only accepts an exact title match for the same season, preferring the TV series over spin-offs. Anything less certain is left for you to pick.
  - AniList responses are cached for a week, and requests are throttled under its limit of 30 per minute.
  - A followed series' episodes keep the seeder count from nyaa's RSS feed (`nyaa:seeders`) as of the last check. That's the only count there is before a torrent starts, so it can be up to 30 minutes old.
  - Moving episodes between folders changes the library only, not the files on disk, because one batch torrent can feed several folders.
- **Updates.** The app reads the latest release from the GitHub API (`weicongx/swarmplay`) and compares its tag with the running version. Installing downloads the `Swarmplay-Setup-<version>.exe` asset to the temp folder, verifies its SHA-256 against the digest GitHub lists for it, and runs it with `/S --force-run`: the NSIS installer installs silently into the existing location and starts the new version once the app has quit. Running from source, `SWARMPLAY_UPDATE_FROM=1.2.0` pretends to be an older version; the download and check then run, but not the installer.
- **Safety.**
  - A torrent's file paths come from whoever made it. One whose path would leave the save folder (`..`, a drive letter, a backslash or another character Windows reserves in a folder name) is refused before anything is written. Opening, moving and deleting files also check that the path is inside the torrent's folder.
  - `.torrent` files come only from the nyaa host set in Settings, at most 10 MB, and are kept in memory for 10 minutes so listing a torrent's files and then adding it fetches it once.
  - The window never navigates away from the app's own page, and the main process answers IPC only from that page.
  - Updates install only an asset of this repository's own release, and only if GitHub lists a SHA-256 for it that the download matches.
- **Storage.** Settings, the library, torrents, per-file progress and watch positions are stored in SQLite at `%APPDATA%\Swarmplay\swarmplay.db`, using Electron's built-in `node:sqlite`.
  - **Backups.** Once a day the app saves a copy to `%APPDATA%\Swarmplay\backups\swarmplay-<date>.db` and keeps the newest 7. It skips the copy while the library is empty, so an empty database never pushes good copies out. To restore one, quit Swarmplay, delete `swarmplay.db`, `swarmplay.db-wal` and `swarmplay.db-shm`, then copy the backup in as `swarmplay.db`.
  - **Leftover logs.** SQLite keeps recent changes in `swarmplay.db-wal` and applies whatever file sits there on startup, even one from a different database. Before opening, Swarmplay checks copies of the database with and without that file. The file is set aside in `db-recovery\` if it would lower the schema version, or empty both the library and the settings. A log left by a crash or a forced quit belongs to the database and is applied as normal. If you copy your library to another PC, quit Swarmplay on both and copy all three `swarmplay.db*` files together.

### Code layout

```
src/
  main/            Electron main process
    index.ts         window, tray, single-instance lock, notifications
    nyaa.ts          nyaa search (search page, RSS fallback) and .torrent download
    scrape.ts        live seeder counts from nyaa's tracker
    bencode.ts       bencode decoder and info-hash
    torrentFile.ts   .torrent parsing (file list, path safety)
    torrent.ts       WebTorrent engine, stream server, pause/resume
    player.ts        embedded mpv: window, IPC, resume, upscaling
    library.ts       folders, episodes, auto-filing, next episode
    follows.ts       followed series: matching uploads, 30-minute checks
    alternatives.ts  switching a slow stream to another upload of the episode
    release.ts       release-name parsing (anitomy)
    anilist.ts       AniList GraphQL search, cache, throttling
    tray.ts          tray icon and menu
    updates.ts       update check and install from GitHub releases
    db.ts            SQLite schema, migrations, settings
    ipc.ts           IPC handlers
  preload/         window.api bridge
  shared/          types and folder-name helpers used by both sides
  renderer/        React UI (Search, Downloads, Library, Player, Settings)
resources/         icons and Anime4K shaders
scripts/           icon generator, mpv vendoring for the installer
  cdp/             behavior checks run in the app over the DevTools Protocol (see its README)
licenses/          license notice for the bundled mpv
```

## Notes and limitations

- Windows only. The embedded player relies on mpv's `--wid` and Win32 child windows.
- Search reaches at most 1000 results, nyaa's own cap. On a mirror whose search page can't be read, only the newest 75 come back (from RSS), so older releases need a more specific query.
- When running from source, the taskbar icon and the notification sender show as Electron. The installed app shows Swarmplay's name and icon. Source runs use a separate app ID (`com.weicongx.swarmplay.dev`) so that Windows' per-ID icon cache doesn't mix up the two.
- The development and installed builds share the same database.
- **Privacy.** Like any BitTorrent client, Swarmplay shows your IP address to the trackers and peers of every torrent you stream or download, and they can see what you fetch. Seeder counts are scraped from nyaa's tracker over plain HTTP, which shows the info-hashes looked up to anyone on the network path. Use a VPN that allows torrent traffic if that matters to you. Swarmplay sends nothing else about you: no accounts, telemetry or analytics. It contacts nyaa, its trackers and peers, AniList for metadata, and the GitHub API for update checks.
- The UI colors are sampled from the Claude desktop app's dark theme.

## Credits

- [WebTorrent](https://webtorrent.io) for the torrent engine and streaming
- [mpv](https://mpv.io) for playback. The installer bundles the [shinchiro](https://github.com/shinchiro/mpv-winbuild-cmake) Windows build, under the GPL v3; see `licenses/` for the license and source links.
- [Anime4K](https://github.com/bloc97/Anime4K) by bloc97 for the upscaling shaders (MIT license, included in `resources/shaders/anime4k/LICENSE`)
- [anitomy](https://www.npmjs.com/package/anitomy) for release-name parsing
- [AniList](https://anilist.co) for series metadata and cover art
- [Electron](https://www.electronjs.org), [electron-vite](https://electron-vite.org) and [React](https://react.dev)

## Disclaimer

Swarmplay is a torrent client. You are responsible for what you download and share, and for following copyright law where you live.
