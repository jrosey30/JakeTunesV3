# AGENTS.md

Project-specific rules live in `CLAUDE.md` (Electron renderer API bans, React hook ordering, twin-function discovery, do-not-touch list, commit/testing rules). Read it before editing code.

## Cursor Cloud specific instructions

JakeTunes is a **single Electron + React + TypeScript desktop app** (an iTunes replica) with Python helper scripts in `core/`. There is no server/backend to run — "running the app" means launching the Electron app in dev mode. Standard commands live in `README.md` and `package.json`; notes below are only the non-obvious cloud specifics.

### Running the app (dev)
- The cloud VM has a headless X server on **`DISPLAY=:1`**. Launch with `export DISPLAY=:1 && npm run dev` (`electron-vite dev` — starts main + preload + renderer together; renderer dev server on `localhost:5173`, remote debug on `9222`). Use a long-lived tmux session; `npm run dev` is a watcher, not a one-shot.
- **The app launches with zero API keys.** Playback and the full library UI work with no `.env`. AI features ("The Music Man" / Cynthia) require `ANTHROPIC_API_KEY`; voice + DJ Mode additionally require `ELEVENLABS_API_KEY`. Missing keys fail soft ("Cynthia is on break"), never crash. `DISCOGS_API_TOKEN`, `OPENWEATHER_API_KEY`, `LASTFM_API_KEY`, `EXA_API_KEY` are enrichment-only.
- Benign startup noise in this headless VM (safe to ignore): `bus.cc ... Failed to connect to the bus` (dbus), `Exiting GPU process due to errors` (swiftshader GL), `No iPod detected`, `[reco] backend GET unreachable`, and the `library.json` watcher ENOENT before a library exists.

### Data / library locations (needed to test playback without hardware)
- Library state lives in Electron userData, **not** the repo: `~/.config/JakeTunes/library.json` (tracks + playlists). Music files live under `~/Music/JakeTunesLibrary/iPod_Control/Music/F##/`.
- The renderer plays a track via the custom `ipod-audio://` protocol: a track's colon path like `:iPod_Control:Music:F00:x.mp3` maps to `<music-library-path>/iPod_Control/Music/F00/x.mp3`. To exercise playback with no iPod/CD, drop audio files there and write matching entries into `library.json`, then restart the app (`load-tracks` reads `library.json` at renderer boot; the codec map is seeded from it at main-process boot). `ffmpeg` is available system-wide for generating test audio.

### Build / test / lint
- **`npm run build`** (electron-vite build) is the real gate and is what CI (`.github/workflows/check.yml`, macOS runner) enforces.
- `npx tsc -b --noEmit` currently reports pre-existing type errors and is `continue-on-error: true` in CI — informational, do **not** treat it as a blocker.
- `npm test` runs the main-process unit tests (Node's built-in runner). **Do not use `npm run test:mobile` / `npm run test:all`** — they reference a `mobile/` directory that does not exist and will fail.
- There is no lint script. `CLAUDE.md` documents a grep-based check for browser APIs banned in the Electron renderer (`window.prompt/alert/confirm`, `localStorage`, etc.).
- `python -m py_compile core/*.py` is the Python syntax check CI runs; `core/` scripts need `mutagen` + `librosa` (installed by the update script). Python is resolved at app startup into `PYTHON_CMD`; if librosa is missing only BPM/key analysis degrades — the app still runs.
