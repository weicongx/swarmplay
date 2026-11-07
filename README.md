# Swarmplay

A Windows desktop app for streaming anime from torrents. Search nyaa.si, pick a release, and start watching in the app within seconds, without saving the episode to disk. Episodes land in a library of series folders with AniList cover art, playback picks up where you left off, and you can download any episode to keep it.

## Features

- **Search nyaa.si** by category and filter (trusted only, no remakes). Results come sorted by most seeders, the uploads that stream best, or by date, size or downloads, across every match rather than just the newest. **Load more** pages through up to 1000 results. Open any result to see its file list before downloading.
- **Streaming first.** Press **Stream** to play an episode within seconds. WebTorrent fetches the pieces near the playhead first. Nothing is kept: the data goes to a hidden temporary folder that's deleted when playback stops. The episode stays in the library so you can stream it again. If you rewatch a lot, Settings can keep recently streamed episodes up to a size you choose, so they replay without peers. This is off by default.
- **Download only what you want to keep.** Press **Download** in Search, or on any library episode, even mid-stream. An episode streamed and then downloaded keeps what's already fetched.
- **In-app player.** mpv draws the video inside the app window, with Swarmplay's own controls: seek bar, volume, audio and subtitle tracks, and fullscreen. **Now streaming** at the foot of the sidebar shows the episode, download speed and peers. While streaming, the seek bar shades the parts already fetched, which play without waiting. When it buffers, the player shows the download speed and peer count.
- **Resume and autoplay.** Your position saves every few seconds. An episode counts as watched at 90%, and the next one in the folder starts automatically, including new episodes of a followed series you haven't streamed yet.
- **Skip intro and credits.** When a release names its chapters (OP, Opening, ED, Ending and similar), the player shows **Skip intro** during the opening and **Skip credits** during the ending. Settings can skip openings, or both, automatically.
- **Next episode loads early.** Near the end of an episode, Swarmplay starts fetching the start of the next one, so autoplay (or **Next**) begins at once instead of waiting for peers. If you stop watching instead, that data is deleted like any stream.
- **Seeders before you press play.** Search results and a followed series' new episodes show how many people are seeding each upload. With two or fewer, the count turns amber and Search warns that streaming may stall.
- **Switch to a faster upload.** If a stream is stuck buffering or has no peers for 15 seconds, the player offers **Try another**. It finds the best-seeded other upload of the same episode on nyaa, from any group, and carries on from the same moment. The library episode points at the new upload from then on.
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

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload |
| `npm run typecheck` | Type-checks the main, preload and renderer code |
| `npm run build` | Bundles everything into `out/` |
| `npm run dist` | Builds the NSIS installer, with mpv bundled, at `dist/Swarmplay-Setup-<version>.exe` |
| `node scripts/make-icon.mjs` | Regenerates the app and tray icons in `resources/` |

## Using it

1. **Search.** Type a show name. Results start with the most seeded; change **Sort** or press **Load more** at the bottom for more. Click a result to open its details, tick the episodes you want, and pick a library folder (one is suggested from the release name).
2. **Stream** plays the first ticked episode right away and adds the episodes to the library without saving them. **Download** saves the files in the background.
3. **Downloads** shows progress, speed and peers for each download, with pause, resume and remove. Remove keeps the episodes in the library to stream, and can also delete the files. While you stream, the stream shows here too. The badge on **Downloads** counts only downloads still fetching, so streaming never adds to it.
4. **Add series to library** (in the same panel) follows the series instead of picking one episode. Its new episodes show up in the folder with **Stream** and **Download**, and **Remove** hides one you don't want. Each one shows its seeders as of the last check, with ⚠ at two or fewer. **Unfollow** in the folder header stops it and removes the episodes you never downloaded.
5. **Library** holds your series folders. Click an episode to play it. Each episode shows whether it's downloaded, with **Download** and **Delete**. Use **Find on AniList** when a folder didn't get a cover automatically.

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
| Esc | Leave fullscreen, then close the player |

### Settings

- nyaa mirror URL, and the default category and filter for searches
- Library folder on disk (default `Videos\Anime`)
- Download and upload speed limits
- Whether to seed after downloading
- Autoplay next episode
- Keep recently streamed episodes, up to a number of GB (off by default)
- Openings and endings: a Skip button, or skip automatically
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
nyaa.si RSS ──► search results ──► .torrent ──► WebTorrent ──► files in <library>/<folder>/
                                                    │
                                  local HTTP server (127.0.0.1, range requests)
                                                    │
                                     mpv ◄── JSON IPC ── main process ◄── IPC ── React UI
```

- **Search.** Results come from nyaa's search page, which sorts on the server and pages through up to 1000 matches, 75 a page. Its results table is read for the title, size, date, seeders, leechers, downloads and comment count, and the info-hash comes from the magnet link. If the page can't be read (a mirror with another layout, a changed layout, or an error), Swarmplay falls back to the RSS feed. That feed returns only the newest 75 matches, so Search says so and sorts those itself. A full follow check reads the pages one at a time, a second apart, and scheduled checks read only the newest page. `.torrent` files are parsed by a small bencode decoder that also computes the info-hash.
- **Streaming.**
  - WebTorrent serves every active torrent at `http://127.0.0.1:<port>/webtorrent/<infoHash>/<path>`. mpv plays from that URL, and each range request moves WebTorrent's download priority to the pieces mpv is reading.
  - The server only answers requests that carry no browser `Origin`, so web pages can't read from it.
  - Files that are already complete play straight from disk.
  - A stream-only torrent saves into `<library>\.swarmplay-streaming\<infoHash>`, a hidden folder on the same drive as the library. When playback stops (or another episode starts) the torrent is stopped and that folder is deleted. Downloading an episode mid-stream keeps the data. When playback stops, the file is moved (a rename, since it's the same drive) into the series folder. Leftover stream folders are cleared at startup.
  - With the stream cache on, a stream's folder stays when playback stops, and its time is marked as last used. Streaming it again re-checks the pieces on disk and plays them without peers. The cache is then trimmed, oldest first, to the limit. The folder playing or fetched ahead counts toward the limit but is never deleted. Sizes are file sizes, not bytes fetched: once mpv has read the end of an mkv (its seek index), Windows allocates the whole file. Folders left at startup, including ones no torrent uses anymore, stay until they're the oldest. Turning the limit down trims at once, and turning the cache off clears it. Removing an episode from the library still deletes its stream folder.
  - Once a second the player reads which of the file's pieces WebTorrent has and shades them on the seek bar. Byte positions are mapped to time in proportion, so the shading is close but not exact for variable-bitrate video. While buffering, the top bar shows the torrent's download speed and peer count, and in fullscreen the bars stay up until playback resumes.
  - Skipping uses mpv's `chapter-list`. A chapter whose title has OP, Opening or Intro (or ED, Ending, Credits or Outro) as a word counts, if it's no longer than 200 seconds. A longer one is more likely a cold open or the episode itself. Skipping seeks to the next chapter's start. An ending that's the last chapter skips to the end of the file, so autoplay moves on. Auto-skip handles each chapter once per episode, so seeking back into an opening plays it. In fullscreen, where the bars may be hidden, mpv's on-screen text says when you can press S, and also shows the buffering speed and peers.
  - At 85% of an episode, or when a chapter named ED, Ending or Credits starts, the next episode is prefetched: its first 40 MB and last 2 MB (where an mkv keeps its seek index). A followed series' next episode is added to the library first. Prefetching waits until mpv has at least 30 seconds buffered, and it adds no stream selection of its own, so it only gets bandwidth the playing file doesn't need. Playing into it takes over its torrent. Closing the player or playing something else stops it and deletes what it fetched.
  - A stream counts as slow after 15 seconds of buffering (mpv's `core-idle` while not paused), or 15 seconds with no peers before the file is fully cached. **Try another** then searches nyaa under the release's series name and the folder's AniList titles (up to three queries) and keeps results for the same episode number and season. It doesn't offer one that has no seeders, or a dub-only upload in place of a subbed one. It picks the result with the most seeders, preferring the current resolution between equals. The new upload is streamed into the same folder, starting at the same position. It takes over the episode's watched state and the followed series' release entry. If the old upload was only streamed, its torrent and data are removed.
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
- **Storage.** Settings, the library, torrents, per-file progress and watch positions are stored in SQLite at `%APPDATA%\Swarmplay\swarmplay.db`, using Electron's built-in `node:sqlite`.

### Code layout

```
src/
  main/            Electron main process
    index.ts         window, tray, single-instance lock, notifications
    nyaa.ts          nyaa search (search page, RSS fallback) and .torrent download
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
    db.ts            SQLite schema, migrations, settings
    ipc.ts           IPC handlers
  preload/         window.api bridge
  shared/          types and folder-name helpers used by both sides
  renderer/        React UI (Search, Downloads, Library, Player, Settings)
resources/         icons and Anime4K shaders
scripts/           icon generator, mpv vendoring for the installer
licenses/          license notice for the bundled mpv
```

## Notes and limitations

- Windows only. The embedded player relies on mpv's `--wid` and Win32 child windows.
- nyaa's RSS feed only returns the newest 75 results for a search, so older releases of a long-running show may need a more specific query.
- When running from source, the taskbar icon and the notification sender show as Electron. The installed app shows Swarmplay's name and icon. Source runs use a separate app ID (`com.weicongx.swarmplay.dev`) so that Windows' per-ID icon cache doesn't mix up the two.
- The development and installed builds share the same database.
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
