# homemini — home server architecture

**homemini** is Jake's always-on Mac Mini M2 at home. It is registered on [Tailscale](https://tailscale.com) as `homemini` (SSH user: `jakerosenbaumnas`). Magic DNS lets every tailnet device reach services as `http://homemini:<port>` from anywhere.

homemini is the **canonical streaming host** for JakeTunes Mobile and Nowhere TV. The Synology NAS (`ds225`, SMB share `JakeShared`) is the **vault** (master library + backup). The MacBook is the **editor** (imports, metadata, curation).

## Ecosystem map

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MacBook (jacobrosenbaum) — source of edits & imports                   │
│  • JakeTunes V3 desktop (Electron)                                      │
│  • ~/bin/jaketunes-homemini-sync.sh  (music + JSON → NAS + homemini)    │
│  • JakeTunesMobile/deploy/macbook-nas-sync.sh  (new files → NAS, 60s)   │
│  • nowhere-player dev engine (optional) + disc rip → NAS → scan homemini│
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                    Tailscale + SMB (ds225 / JakeShared)
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Synology NAS — VAULT                                                   │
│  • /Volumes/JakeShared/JakeTunesLibrary   (music files)                 │
│  • /Volumes/JakeShared/JakeTunesState     (library.json, reco, etc.)    │
│  • /Volumes/JakeShared/Movies, Family Videos, Cable Bumpers, …           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  homemini (jakerosenbaumnas@homemini) — CANONICAL STREAMING HOST        │
│                                                                         │
│  JakeTunes Mobile backend  :3000   com.jaketunes.mobile.backend         │
│    → HTTP Range audio, artwork, API for iOS                             │
│  JakeTunes Boom API        :3001   com.jaketunes.boom  (Phase 2)        │
│    → SQLite library SoT + SSE push + /api/audio                         │
│  Nowhere engine            :8730   com.nowhere.server                   │
│    → HTTP Range video, Nowhere Cable, catalog API for tvOS/iPad         │
│  NAS → local pull          60s     com.jaketunes.mini-nas-pull          │
│    → keeps ~/Music/JakeTunesLibrary current for resilient playback      │
│  JakeTunes V3 desktop app  (optional local player / screen-share target)  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  Tailscale (homemini:3000, :3001, :8730)
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  JakeTunes Mobile         Nowhere TV (Apple TV)    Nowhere iPad
  (iOS, this repo)         appletv/                 ipad/
```

## Repos on homemini

| Repo | Path on homemini | Role |
|------|------------------|------|
| [JakeTunesMobile](https://github.com/jrosey30/JakeTunesMobile) | `~/JakeTunesMobile` | Express backend + deploy scripts |
| [nowhere-player](https://github.com/jrosey30/nowhere-player) | `~/nowhere-player` (git) · `~/nowhere-server` (running build) | Video engine |
| [JakeTunesV3](https://github.com/jrosey30/JakeTunesV3) | `~/JakeTunesV3` | Desktop app clone; not the mobile API |

There is **no** central docker-compose or Ansible repo. Orchestration is **launchd agents** plus shell scripts in each repo's `deploy/` folder and `~/bin/` on the MacBook.

## JakeTunes music pipeline

1. **Import on MacBook** — V3 writes audio to `~/Music2/JakeTunesLibrary/` and updates `library.json`.
2. **MacBook → NAS** — `deploy/macbook-nas-sync.sh` (launchd `com.jaketunes.macbook-nas-sync`, every 60s) ADD-only rsync to `/Volumes/JakeShared/JakeTunesLibrary/`.
3. **MacBook → homemini (full chain)** — `~/bin/jaketunes-homemini-sync.sh`, triggered by V3's sync orchestrator after imports/edits and on a 10-minute safety net. Pushes JSON state to homemini, rsyncs music to NAS, triggers Plex scan, syncs artwork and mobile-stars.
4. **NAS → homemini local disk** — `JakeTunesMobile/deploy/mini-nas-pull.sh` (launchd `com.jaketunes.mini-nas-pull`, every 60s on homemini). Pulls new files into `~/Music/JakeTunesLibrary/` and refreshes `~/JakeTunesState/library.json`.
5. **Stream** — iPhone hits `http://homemini:3000` (Tailscale). Backend reads **local** `MUSIC_ROOT` first, NAS fallback for tracks not yet pulled.

**Why the local copy on homemini?** Streaming directly from an SMB mount caused wholesale 404s when the mount dropped (2026-07-09 outage). Local disk + 60s pull makes NAS blips non-fatal.

### JakeTunes deploy commands

**Mobile backend (after pushing to `main`):**

```bash
ssh jakerosenbaumnas@homemini 'cd ~/JakeTunesMobile && git pull && ./deploy/install-on-mini.sh'
```

**NAS pull agent (first-time or after plist changes):**

```bash
ssh jakerosenbaumnas@homemini 'cd ~/JakeTunesMobile && git pull && ./deploy/install-mini-nas-pull.sh'
```

**MacBook-side NAS sync (run once on the laptop):**

```bash
cd ~/JakeTunesMobile && ./deploy/install-macbook-nas-sync.sh
```

**Full homemini sync script** lives at `~/bin/jaketunes-homemini-sync.sh` (copy from `JakeTunesV3/Dr. Claude/scripts/jaketunes-homemini-sync.sh`). V3's sync orchestrator calls it automatically when the script exists.

### JakeTunes ports & env (homemini backend)

| Variable | homemini value |
|----------|----------------|
| `PORT` | `3000` |
| `MUSIC_ROOT` | `~/Music/JakeTunesLibrary` (local) |
| `MUSIC_ROOT_FALLBACK` | `/Volumes/JakeShared/JakeTunesLibrary` |
| `LIBRARY_JSON_PATH` | `~/JakeTunesState/library.json` (local; pulled from NAS) |
| `ARTWORK_DIR` | `~/Library/Application Support/JakeTunes/artwork` |

Health check: `curl http://homemini:3000/healthz`

## Nowhere video pipeline

1. **Media vault** — Movies on NAS (`/Volumes/Movies` from MacBook, `~/nowhere-media/` on homemini). TV shows delivered to homemini via `server/scripts/seinfeld-*.sh`.
2. **Engine on homemini** — Fastify server on **port 8730** (`com.nowhere.server`). Serves catalog + HTTP Range `/stream/:id` for Direct Play.
3. **Curation on MacBook** — Desktop engine can run with `CABLE_PEER_URL=http://homemini:8730` so cable favorites/clips mirror one-way to homemini (`server/src/cable-sync.ts`). **homemini itself should leave `CABLE_PEER_URL` unset** (no peer).
4. **Clients** — Apple TV and iPad resolve `homemini:8730` over Tailscale/LAN (`shared/NowhereClient.swift`). The TV watches homemini, not the laptop.
5. **Disc import** — MacBook `~/bin/nowhere-disc-import.sh` rips DVDs/Blu-rays, stages to NAS, then `POST http://homemini:8730/scan`.

### Nowhere deploy commands

**Video engine (after pushing to `main`):**

```bash
ssh jakerosenbaumnas@homemini 'cd ~/nowhere-player && git pull && ./deploy/install-on-mini.sh'
```

Deploy details: see [nowhere-player/README.md](../../nowhere-player/README.md).

Health check: `curl http://homemini:8730/health`

## Other machines

| Host | Tailscale name | Role |
|------|---------------|------|
| **workmini** | `workmini` | Work Mac mini — JakeTunes desktop clone via `~/bin/jaketunes-workmini-deploy.sh`. Sync **destination**. Plays by streaming from **homemini:3000** (`library.streamSource=homemini`) with a local NAS cache-farm fallback; it must never read the Synology SMB mount on the playback hot path (that is what made it hang). |
| **ds225** | `ds225` | Synology NAS — vault, Plex, SMB shares |
| **MacBook** | (varies) | Primary editor, sync source, dev |

## Diagnostics

| System | Command |
|--------|---------|
| JakeTunes Mobile | `python3 ~/JakeTunesMobile/tools/vern.py` (from MacBook) |
| JakeTunes V3 | `~/JakeTunesV3/scripts/vern` |
| homemini SSH | `ssh jakerosenbaumnas@homemini` |
| Tailscale mesh | `tailscale status` — confirm `homemini` is listed |

## Related docs

- [JakeTunesMobile/CLAUDE.md](../../JakeTunesMobile/CLAUDE.md) — mobile architecture (living source of truth for iOS)
- [JakeTunesMobile/README.md](../../JakeTunesMobile/README.md) — quick start + homemini deploy
- [nowhere-player/README.md](../../nowhere-player/README.md) — video engine + homemini deploy
- [docs/jaketunes-5-plan.md](./jaketunes-5-plan.md) — longer-term sync roadmap
