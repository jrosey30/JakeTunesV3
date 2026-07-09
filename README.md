# JakeTunes

A pixel-faithful classic-iTunes desktop player for macOS, built with Electron + React + TypeScript. V5 moves the visual target from iTunes 8 to iTunes 10 — brushed-metal chrome, List/Grid/Cover Flow view modes, row checkboxes — same warm palette.

**Vision:** classic iTunes shell, 2040 brain inside. Brushed warm-silver chrome, cool blue-gray sidebar, cream LCD pill, Cover Flow, and a persistent AI DJ called The Music Man.

## Features

- **Full music library** — songs, artists, albums, genres, playlists, smart playlists
- **Live Concert Mode** — declare a live album and its tracks merge into one gapless "live set" file (originals untouched); the Now Playing pill tracks the current song in the set list, and undeclaring deletes the merged file
- **iPod Mini sync** — auto-detects a connected iPod and reads the on-device iTunesDB
- **CD import** — detects audio CDs, looks up tracks via MusicBrainz, rips to AAC/ALAC/AIFF/WAV
- **The Music Man** — an AI record-store savant (powered by Claude) who answers music questions, builds playlists, fixes metadata, and picks a rotating daily set
- **DJ Mode** — Spotify-style continuous set with spoken commentary between tracks. **Requires an ElevenLabs API key.**
- **AirPlay support** — route audio to AirPlay speakers
- **Discogs integration** — pulls your vinyl collection into the AI's taste profile

## Requirements

- **macOS** (Apple Silicon recommended, Intel untested) OR **Windows 10/11 (x64)**
- [Node.js 18+](https://nodejs.org)
- [Python 3](https://www.python.org/downloads/) — used for reading the iPod database. On Windows, make sure "Add Python to PATH" is checked during install.
- **Windows only:** [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) on PATH — needed for CD ripping and library format conversion. Download "release essentials", extract, and add its `bin/` folder to your system PATH. macOS has this built in via `afconvert`; no install needed.
- API keys (all have free tiers sufficient for personal use):
  - **[Anthropic](https://console.anthropic.com/settings/keys)** (required) — for The Music Man's brain. Every AI feature depends on this.
  - **[ElevenLabs](https://elevenlabs.io/app/settings/api-keys)** (highly recommended, optional) — for The Music Man's voice. **Without this key, DJ Mode does not work at all** and Music Man is text-only. The rest of the app (playback, library, iPod, CD import, AI chat, playlist builder, daily picks) still works fine.
  - **[Discogs](https://www.discogs.com/settings/developers)** (optional) — pulls your vinyl collection into The Music Man's taste profile. Skip it if you don't use Discogs; the app runs fine without it.

## Setup

1. **Clone or unzip the repo**, then `cd` into it.

2. **Install dependencies:**
   ```bash
   npm install
   pip install -r requirements.txt
   ```
   The `pip install` step is required: the helper scripts in `core/` (tag
   reading, audio analysis for BPM and key, etc.) need `mutagen` and
   `librosa`. Use `pip3` if `pip` isn't aliased on your system. On
   Homebrew Python you may need `pip3 install --break-system-packages
   -r requirements.txt` (PEP 668).

3. **Create your `.env` file:**
   ```bash
   cp .env.example .env
   ```
   Open `.env` and paste in the three keys you created above.

4. **Run in dev mode:**
   ```bash
   npm run dev
   ```
   An Electron window should open. The app will look for music in `~/Music/JakeTunesLibrary/` — if that folder doesn't exist, it's empty until you connect an iPod or import a CD.

## Building a distributable app

Build for your current platform:
```bash
npm run dist
```

Or build for a specific platform:
```bash
npm run dist:mac   # .dmg + .zip in release/mac-arm64/
npm run dist:win   # .exe NSIS installer in release/
```

The build does **not** bundle your `.env` — each user of the distributed app must supply their own keys via their own `.env` file in the app's user data directory.

## Project layout

```
src/
  main/         Electron main process (IPC, menu, Python bridge)
  preload/      contextBridge exposing APIs to renderer
  renderer/     React app (views, components, contexts, hooks, styles)
core/
  db_reader.py  Parses iPod iTunesDB binary format
  audio_helper  Universal binary for native audio device queries
```

## Architecture notes

- **State:** React Context + useReducer, split into `LibraryContext` (tracks, view, search) and `PlaybackContext` (now-playing, position, volume) to keep 60fps playback updates from re-rendering the full track list.
- **Audio:** Howler.js in the renderer.
- **Virtual scroll:** Custom `useVirtualScroll` hook to keep 3,000+ track lists smooth.
- **AI:** All Claude and ElevenLabs calls happen in the main process — the renderer talks to them via IPC.

## homemini & multi-device sync

JakeTunes is not MacBook-only. A Mac Mini at home (**homemini**, Tailscale hostname `homemini`) runs the mobile streaming backend and stays in sync with this desktop app.

| This machine (MacBook) | homemini |
|------------------------|----------|
| Canonical **editor** — imports, metadata, playlists, AI | Canonical **streamer** for [JakeTunes Mobile](https://github.com/jrosey30/JakeTunesMobile) at `http://homemini:3000` |
| Triggers `~/bin/jaketunes-homemini-sync.sh` after library changes | Pulls new music from NAS every 60s (`mini-nas-pull`) for resilient playback |
| Music in `~/Music2/JakeTunesLibrary/` | Local copy in `~/Music/JakeTunesLibrary/` |

**Setup:** install `Dr. Claude/scripts/jaketunes-homemini-sync.sh` to `~/bin/`, ensure Tailscale + Synology `JakeShared` mount work, then deploy the mobile backend from [JakeTunesMobile](https://github.com/jrosey30/JakeTunesMobile):

```bash
ssh jakerosenbaumnas@homemini 'cd ~/JakeTunesMobile && git pull && ./deploy/install-on-mini.sh'
```

The sync orchestrator (`src/main/sync-orchestrator.ts`) only runs the homemini sync script when it exists on disk — homemini, workmini, and fresh installs stay quiet.

Full ecosystem diagram, ports, and NAS pipeline: **[docs/homemini.md](docs/homemini.md)**.

## Known limitations

- AirPlay device discovery is manual (no Bonjour/mDNS auto-detect yet)
- Intel Mac universal binary untested
- iPod sync requires a properly powered USB connection — USB-A-to-C adapters may not deliver enough current for the iPod Mini's Microdrive to spin up

### Windows-specific

- **AirPlay device selection is macOS-only.** On Windows, audio plays through the system default output device. Change the output via Windows Sound Settings.
- **Windows title bar uses the native Windows chrome** rather than the custom Mac-style one. The inside-the-window iTunes look is the same on both platforms.
- **ffmpeg must be installed manually** (see Requirements). macOS has `afconvert` built in; Windows needs ffmpeg on PATH for CD ripping to work.
- **Windows is tested less thoroughly than macOS** — if something breaks, please report it.

## License

MIT — see [`LICENSE`](./LICENSE).
