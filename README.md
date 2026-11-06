# Swarmplay

A Windows desktop app for watching anime from torrents. Search nyaa.si, pick a release, and start watching in the app while it downloads. Episodes land in a library of series folders with AniList cover art, and playback picks up where you left off.

## Features

- **Search nyaa.si** by category and filter (trusted only, no remakes) and sort by seeders, size or date. Open any result to see its file list before downloading.
- **Stream while downloading.** Pick which files you want, then press *Stream now* to play the first episode within seconds. WebTorrent fetches the pieces near the playhead first.
- **In-app player.** mpv draws the video inside the app window, with Swarmplay's own controls: seek bar, volume, audio and subtitle tracks, and fullscreen.
- **Resume and autoplay.** Your position saves every few seconds. An episode counts as watched at 90%, and the next one in the folder starts automatically.
- **Upscaling.** Two options:
  - Anime4K shaders, which run on any GPU.
  - NVIDIA RTX Video Super Resolution, which needs an RTX card.

  Switch between them live from the player.
- **Library.**
  - New downloads go into one folder per series. The folder name is parsed from the release name, with the season normalized (*S2*, *2nd Season* and *- S02* all become *Show S2*).
  - Folders can be nested and renamed.
  - Episodes move between folders by drag and drop.
- **AniList.** Folders link to their AniList entry for the cover, alternate titles and episode count. An English-titled release still finds the folder you named in romaji. *Continue watching* sits at the top of the library.
- **Background downloads.** Downloads keep going from the tray when you close the window. Swarmplay notifies you when an episode finishes, and seeds afterwards if you want.

## Install

1. Install [mpv](https://mpv.io). Swarmplay uses it for playback but doesn't bundle it:

   ```bash
   winget install shinchiro.mpv
   ```

2. Run `Swarmplay-Setup-<version>.exe` (build it with `npm run dist`, below). It installs for your user only, with no admin prompt, and adds Start-menu and desktop shortcuts.

The installer isn't code-signed, so SmartScreen warns the first time. Click **More info → Run anyway**.

On first launch Windows Firewall asks whether Swarmplay may accept connections. Allowing it lets peers connect to you, which speeds up downloads and lets you seed.

Swarmplay finds mpv in the usual places (winget, scoop, Chocolatey, `C:\Program Files`, `PATH`). If it's somewhere else, set the path in **Settings**.

## Build from source

You need Windows and a recent Node.js (developed on Node 24).

```bash
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload |
| `npm run typecheck` | Type-checks the main, preload and renderer code |
| `npm run build` | Bundles everything into `out/` |
| `npm run dist` | Builds the NSIS installer at `dist/Swarmplay-Setup-<version>.exe` |
| `node scripts/make-icon.mjs` | Regenerates the app and tray icons in `resources/` |

## Using it

1. **Search.** Type a show name. Click a result to open its details, tick the episodes you want, and pick a library folder (one is suggested from the release name).
2. **Download** saves the files in the background. **Stream now** also starts playing right away.
3. **Downloads** shows progress, speed and peers for each torrent, with pause, resume and remove. Remove can keep or delete the files.
4. **Library** holds your series folders. Click an episode to play it. Use **Find on AniList** when a folder didn't get a cover automatically.

### Player keys

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Seek 5 s (hold Shift for 30 s) |
| ↑ / ↓ | Volume |
| M | Mute |
| F / double-click | Fullscreen |
| N | Next episode |
| U | Cycle upscaling (off → Anime4K → RTX) |
| Esc | Leave fullscreen, then close the player |

### Settings

- nyaa mirror URL, and the default category and filter for searches
- Library folder on disk (default `Videos\Anime`)
- Download and upload speed limits
- Whether to seed after downloading
- Autoplay next episode
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

- **Search.** Results come from nyaa's RSS feed, which returns the newest 75 matches and ignores sort and page parameters. Swarmplay sorts the results itself. `.torrent` files are parsed by a small bencode decoder that also computes the info-hash.
- **Streaming.**
  - WebTorrent serves every active torrent at `http://127.0.0.1:<port>/webtorrent/<infoHash>/<path>`. mpv plays from that URL, and each range request moves WebTorrent's download priority to the pieces mpv is reading.
  - The server only answers requests that carry no browser `Origin`, so web pages can't read from it.
  - Files that are already complete play straight from disk.
- **Pause.** Pausing removes the torrent from the WebTorrent client entirely, because WebTorrent's own pause only stops new connections. Resuming re-adds the torrent and re-checks the pieces already on disk.
- **Player.**
  - One long-lived mpv process (`--idle`) is controlled over a named pipe. It renders with `--wid` into a borderless child window that the main process keeps positioned over the player page's video area. The page draws the controls on top.
  - The child window ignores the mouse so that clicks reach the page.
  - Chromium's DirectComposition is turned off, because it layers the page above child windows and hides the video.
- **Library and matching.**
  - Release names are parsed with [anitomy](https://www.npmjs.com/package/anitomy). Folder matching ignores case and punctuation.
  - AniList auto-linking only accepts an exact title match for the same season, preferring the TV series over spin-offs. Anything less certain is left for you to pick.
  - AniList responses are cached for a week, and requests are throttled under its limit of 30 per minute.
  - Moving episodes between folders changes the library only, not the files on disk, because one batch torrent can feed several folders.
- **Storage.** Settings, the library, torrents, per-file progress and watch positions are stored in SQLite at `%APPDATA%\Swarmplay\swarmplay.db`, using Electron's built-in `node:sqlite`.

### Code layout

```
src/
  main/            Electron main process
    index.ts         window, tray, single-instance lock, notifications
    nyaa.ts          nyaa RSS search and .torrent download
    bencode.ts       bencode decoder and info-hash
    torrentFile.ts   .torrent parsing (file list, path safety)
    torrent.ts       WebTorrent engine, stream server, pause/resume
    player.ts        embedded mpv: window, IPC, resume, upscaling
    library.ts       folders, episodes, auto-filing, next episode
    release.ts       release-name parsing (anitomy)
    anilist.ts       AniList GraphQL search, cache, throttling
    tray.ts          tray icon and menu
    db.ts            SQLite schema, migrations, settings
    ipc.ts           IPC handlers
  preload/         window.api bridge
  shared/          types and folder-name helpers used by both sides
  renderer/        React UI (Search, Downloads, Library, Player, Settings)
resources/         icons and Anime4K shaders
scripts/           icon generator
```

## Notes and limitations

- Windows only. The embedded player relies on mpv's `--wid` and Win32 child windows.
- mpv isn't bundled and has to be installed separately.
- nyaa's RSS feed only returns the newest 75 results for a search, so older releases of a long-running show may need a more specific query.
- When running from source, the taskbar icon and the notification sender show as Electron. The installed app shows Swarmplay's name and icon. Source runs use a separate app ID (`com.weicongx.swarmplay.dev`) so that Windows' per-ID icon cache doesn't mix up the two.
- The development and installed builds share the same database.
- The UI colors are sampled from the Claude desktop app's dark theme.

## Credits

- [WebTorrent](https://webtorrent.io) for the torrent engine and streaming
- [mpv](https://mpv.io) for playback
- [Anime4K](https://github.com/bloc97/Anime4K) by bloc97 for the upscaling shaders (MIT license, included in `resources/shaders/anime4k/LICENSE`)
- [anitomy](https://www.npmjs.com/package/anitomy) for release-name parsing
- [AniList](https://anilist.co) for series metadata and cover art
- [Electron](https://www.electronjs.org), [electron-vite](https://electron-vite.org) and [React](https://react.dev)

## Disclaimer

Swarmplay is a torrent client. You are responsible for what you download and share, and for following copyright law where you live.
