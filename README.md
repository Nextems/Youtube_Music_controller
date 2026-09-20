# YM Overlay

**English** · [Русский](README.ru.md)

A small always-on-top controller for [YouTube Music](https://music.youtube.com): transport buttons, progress bar, volume, the play queue and your playlists in a compact frameless window that floats above whatever you are doing.

It does not use any YouTube API. The app opens the real `music.youtube.com` in a normal window and drives it by reading its page and clicking its buttons, so your account, subscription and settings work exactly as in the browser.

<!-- Add a screenshot: ![YM Overlay](docs/screenshot.png) -->

> **Unofficial project.** Not affiliated with, endorsed by or sponsored by Google or YouTube. "YouTube" and "YouTube Music" are trademarks of Google LLC. Because the app depends on YouTube Music's page markup, a YouTube Music redesign can break parts of it (see [Known limitations](#known-limitations)).

## Features

- **Playback controls** – previous / next, play/pause (click the album art), ±15 seconds.
- **Progress bar** with seeking and elapsed / remaining time.
- **Volume** – hover the middle button group to get a slider; the level is remembered between launches.
- **Queue** – the current track, a few played tracks before it and the next ones after it; click a row to jump to it, or add a track to one of your playlists from its `…` menu.
- **Playlists** – the playlists from YouTube Music's sidebar, with two ways to start each one:
  - **Shuffle** – starts it shuffled;
  - **Play sequentially** – starts it in order from the first track.
- **Pin / unpin** – keep the overlay above all windows or let other windows cover it.
- Frameless, transparent, draggable window.

## Requirements

- **Windows 10 / 11** with the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already included in current Windows).
- A YouTube Music account to sign in with (free or Premium).

Other platforms are not tested. Parts of the code are Windows/WebView2-specific.

## Install (from a release)

1. Download the installer from the [Releases](../../releases) page and run it.
2. Start **ymoverlay**. Two windows open: the **YouTube Music** window and the small **overlay** on top of it.
3. Sign in to YouTube Music in the first window (only the first time – the session is stored by the app).
4. Start playing something. The overlay follows the player.

**Keep the YouTube Music window open** (you can minimize it or put it behind other windows). It is the actual player; closing it stops the music and the overlay has nothing to control.

## Usage

| What | How |
|---|---|
| Play / pause | click the album art |
| Previous / next | side buttons |
| ±15 s | the two circular arrow buttons |
| Volume | hover the middle button group, use the slider |
| Seek | drag the progress bar |
| Queue | arrow button, bottom right |
| Playlists | list button, bottom left; `…` on a row → Shuffle / Play sequentially |
| Add queued track to a playlist | `…` on the queue row → Add to Playlist |
| Move the window | drag the title/artist text, the card's margins or the window edge |
| Pin on top | pin icon, top right |

## Build from source

Prerequisites: [Node.js 18+](https://nodejs.org), [Rust (stable)](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/) (Visual Studio Build Tools with the "Desktop development with C++" workload).

```bash
npm install

# app icons (a 1024x1024 PNG of your choice) – needed for a production build
npx tauri icon path/to/logo.png

# run in development mode
npm run tauri dev

# build the installer (output: src-tauri/target/release/bundle/)
npm run tauri build
```

Stack: [Tauri 2](https://tauri.app) (Rust) + React 18 + Vite + Tailwind CSS.

## How it works

The app is two Tauri windows:

| Window | Shows | Role |
|---|---|---|
| `main` | the real `music.youtube.com` | the player and your logged-in session |
| `overlay` | this project's React UI | the compact controller |

A script (`src-tauri/scripts/ytm-watcher.js`) is injected into `main` at startup. It reads the page (track, timer, queue, sidebar playlists) and sends changes to the overlay as Tauri events. Commands go the other way: the overlay builds small JavaScript snippets (`src/lib/ytmBridge.js`) and sends them to `main` through the `ytm_eval` command, where they click the same buttons you would.

For the full architecture and the list of past bugs and their fixes, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

## Known limitations

- **Depends on YouTube Music's markup.** Selectors can stop working after a YouTube Music update. `PROJECT_MAP.md` lists the fragile places.
- **Play sequentially briefly opens the playlist page** in the YouTube Music window (it is the only place with an in-order Play button), starts it, and returns to the previous page. To stay on the playlist page instead, run `window.__ymoverlay.returnAfterSequential = false` in that window's DevTools.
- The sidebar only lists the playlists YouTube Music shows there (up to 30).
- Clicking the playlist that is already playing may pause it (YouTube Music's own Play button behaves as a toggle).
- The queue view is a window around the current track, not the entire queue.
- Not tested on macOS or Linux.

## Troubleshooting

- **The overlay shows "Nothing playing"** – start a track in the YouTube Music window and make sure you are signed in.
- **Nothing reacts** – make sure the YouTube Music window has not been closed.
- **Diagnostics** – in DevTools of the YouTube Music window, `window.__ymoverlay.enableDiagnostics()` logs long tasks and timer drift; in DevTools of the overlay, `window.__ovDiag.enable()` logs scroll/input delays.

## Contributing

Issues and pull requests are welcome. Please read [`PROJECT_MAP.md`](PROJECT_MAP.md) first: it documents the non-obvious decisions, for example why the window is dragged with `data-tauri-drag-region` and not with CSS `-webkit-app-region` (the latter froze list scrolling).

## License

<!-- Choose a license and add a LICENSE file, then name it here. -->
Not specified yet.
