# Anime

Desktop app: search nyaa.si, download torrents, watch episodes, and organize them into series folders.

## Run

```bash
npm install
npm run dev
```

`npm run typecheck` and `npm run build` check and bundle without launching.

## Layout

- `src/main/` – Electron main process: nyaa RSS client (`nyaa.ts`), `.torrent` parsing (`bencode.ts`, `torrentFile.ts`), torrent engine and local stream server (`torrent.ts`), SQLite via Electron's built-in `node:sqlite` (`db.ts`), IPC handlers (`ipc.ts`)
- `src/preload/` – exposes `window.api` (typed by `src/shared/types.ts`)
- `src/renderer/` – React UI

The database lives at `%APPDATA%/anime-app/anime.db`.

## Status

| Phase | Status |
|---|---|
| 0 Scaffold (Electron, React, SQLite) | done |
| 1 nyaa search + torrent file list | done |
| 2 Torrent engine (WebTorrent), Downloads page | done |
| 3 mpv playback, resume position | next |
| 4 Library folders, auto-filing | schema in place |
| 5 Polish (cover art, up next, tray) | |

## Notes

- nyaa's RSS feed ignores sort/page params and returns the newest 75 matches, so sorting is done client-side.
- webtorrent 3 uses top-level await, so the CJS main bundle loads it with `import()`.
- Active torrents are streamable at `http://127.0.0.1:<random port>/webtorrent/<infoHash>/<path>` with range support; the "Copy stream link" button gives that URL for mpv/VLC.
- Pause fully removes the torrent from the client (WebTorrent's own pause only stops new connections); resume re-adds it and re-verifies pieces on disk.
