# Swarmplay

Swarmplay is a desktop app: search nyaa.si, download torrents, watch episodes while they download, and organize them into series folders.

## Run

Playback needs [mpv](https://mpv.io). On Windows:

```bash
winget install shinchiro.mpv
```

Then:

```bash
npm install
npm run dev
```

`npm run typecheck` and `npm run build` check and bundle without launching.

## Layout

- `src/main/` – Electron main process: nyaa RSS client (`nyaa.ts`), `.torrent` parsing (`bencode.ts`, `torrentFile.ts`), torrent engine and local stream server (`torrent.ts`), mpv control and resume positions (`player.ts`), SQLite via Electron's built-in `node:sqlite` (`db.ts`), IPC handlers (`ipc.ts`)
- `src/preload/` – exposes `window.api` (typed by `src/shared/types.ts`)
- `src/renderer/` – React UI

The database lives at `%APPDATA%/Swarmplay/swarmplay.db`.

## Status

| Phase | Status |
|---|---|
| 0 Scaffold (Electron, React, SQLite) | done |
| 1 nyaa search + torrent file list | done |
| 2 Torrent engine (WebTorrent), Downloads page | done |
| 3 mpv playback, resume position, autoplay next | done |
| 4 Library folders, auto-filing | next (schema in place) |
| 5 Polish (cover art, tray, notifications) | |

## Notes

- nyaa's RSS feed ignores sort/page params and returns the newest 75 matches, so sorting is done client-side.
- webtorrent 3 uses top-level await, so the CJS main bundle loads it with `import()`.
- Active torrents are streamable at `http://127.0.0.1:<random port>/webtorrent/<infoHash>/<path>` with range support. The server only answers requests without a browser Origin, so web pages can't read it.
- Pause fully removes the torrent from the client (WebTorrent's own pause only stops new connections); resume re-adds it and re-verifies pieces on disk.
- One mpv process is reused for every episode (`--idle`), controlled over a named pipe. Complete files play from disk; anything else streams from the local server. Positions save every 5 s; an episode counts as watched at 90%, and the next selected video in the torrent autoplays.
- mpv is found automatically in the usual install locations (winget, scoop, chocolatey, PATH) or set in Settings.
