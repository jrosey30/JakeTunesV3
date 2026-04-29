# JakeTunes Mobile

iOS-first React Native companion to the desktop JakeTunes app. Phase 0
scaffolding for an architecture that will sit in front of a Synology
DS224 NAS once that hardware is online.

## What this is (Phase 0)

- React Native 0.76 (New Architecture), TypeScript, bare CLI (not Expo).
- A complete app shell: providers, navigation, views, playback wiring.
- A NAS service layer with the **shape** of the eventual Synology
  integration — auth, library fetch, stream-URL building. The actual
  network calls are implemented but unverified until the DS224 lands.
- No native iOS project committed yet (`ios/` is generated on first
  setup; see [Setup on Mac](#setup-on-mac) below).

## What this isn't (yet)

- Music Man / DJ Mode / Cynthia: those are desktop-only Phase 0+.
- Album art: tile placeholders only. Synology Audio Station's cover
  endpoint wires up in Phase 1 alongside real auth.
- Smart playlists, Genres tab, recently-played: deferred.
- Any write path back to the library: deferred. See
  [`MobileTrackOverrides`](src/types.ts) for the queue type that the
  desktop will eventually drain.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Desktop JakeTunes (Electron, src/)                              │
│   • Source of truth for library.json + audio files              │
│   • Writes library.json to NAS at libraryJsonPath               │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼  (HTTP/WebDAV)
┌─────────────────────────────────────────────────────────────────┐
│  Synology DS224 (DSM 7.x)                                        │
│   • /music/...               raw audio files                    │
│   • /music/.jaketunes/library.json   desktop-exported snapshot  │
│   • Audio Station / WebDAV / File Station HTTP                   │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼  (HTTP, range requests)
┌─────────────────────────────────────────────────────────────────┐
│  JakeTunes Mobile (this app)                                     │
│   ConnectionContext  → SynologyClient (auth, sid)               │
│   LibraryContext     → fetchLibrarySnapshot → in-memory + cache │
│   PlaybackContext    → react-native-track-player → stream URL   │
└─────────────────────────────────────────────────────────────────┘
```

### Data model

The desktop's `Track`/`Playlist` types are the source of truth. Mobile
mirrors them in [`src/types.ts`](src/types.ts) with a `⚠️ TWIN` marker
on both sides. **When the desktop type changes, update the mobile twin
in the same commit.** Desktop-only fields (`audioMissing`, audio
analysis fields) are kept on mobile for parity but unused in Phase 0.

Mobile-only mutations (play counts queued on device) live in
`MobileTrackOverrides`, never bolted onto `Track`. The eventual sync
step on the desktop drains this queue and merges into the desktop
library.

### NAS transports

Three transports are supported, set per-config:

| Transport                 | Use case                                  | Auth                      |
| ------------------------- | ----------------------------------------- | ------------------------- |
| `synology-audio-station`  | Default. Uses DSM's Audio Station +       | DSM session (`_sid`)      |
|                           | File Station endpoints over HTTP(S).      |                           |
| `webdav`                  | DSM's WebDAV Server package. Universal,   | HTTP Basic                |
|                           | works without Audio Station installed.    |                           |
| `auto`                    | Probe order: Audio Station → WebDAV.      | (resolved at save time)   |

Stream URLs are built fresh per track (not cached on the URL itself)
so DSM session sids don't go stale mid-queue.

### Storage layout

- **Non-secret state** (`AsyncStorage`):
  - `jt.nasConfig` — `NasConnectionConfig` minus password
  - `jt.mobileSettings` — `MobileSettings`
  - `jt.libraryCache` — last `LibrarySnapshot` for offline boot
  - `jt.overridesQueue` — `MobileTrackOverrides[]` pending sync
- **Secrets** (Keychain via `react-native-keychain`):
  - `jt.nasPassword` — NAS account password

Phase 0's `secureStore` is an in-memory stub. **Replace with
`react-native-keychain` before any build that talks to a real NAS.**

### Provider order (matters)

```
GestureHandlerRootView
  SafeAreaProvider
    ConnectionProvider     ← owns SynologyClient
      LibraryProvider      ← reads client + auto-refreshes on connect
        PlaybackProvider   ← queues stream URLs from client + config
          RootNavigator
```

## Setup on Mac

The repo on Linux scaffolds JS/TS only. The iOS project, pods, and
device build all happen on macOS with Xcode 16+ installed.

```bash
cd mobile

# 1) Install JS deps
npm install

# 2) Generate the ios/ project (first time only)
npx react-native init JakeTunesMobile --template react-native-template-typescript --skip-install
# Or if you'd rather scaffold ios/ in place:
npx @react-native-community/cli init-ios

# 3) Install pods
cd ios && pod install && cd ..

# 4) Run on simulator
npm run ios

# 5) Run on a physical device (recommended for audio)
npm run ios:device
```

`Info.plist` additions you'll need before shipping:

- `UIBackgroundModes` → `audio` (background playback)
- `NSAppTransportSecurity` → allow your local NAS hostname if HTTP
- `NSLocalNetworkUsageDescription` → "JakeTunes streams from your
  Synology NAS on this Wi-Fi network."
- `NSBonjourServices` → `_dsm._tcp` if you add Bonjour discovery

## Phase 1 checklist

Before building the next phase against the live DS224:

- [ ] Replace `secureStore` stub with `react-native-keychain`
- [ ] Wire Audio Station's `SYNO.AudioStation.Stream` (proper id-based
      streaming, not File Station download)
- [ ] Album art: Audio Station `cover.cgi` → on-disk cache via
      `react-native-fs`
- [ ] Implement the on-device audio cache (`MobileSettings.cache`)
- [ ] Queue + drain `MobileTrackOverrides` (mobile → desktop sync)
- [ ] Genres tab parity with desktop
- [ ] Background sync of `library.json` on app foreground

## Code rules (mobile-specific)

These extend the project root `CLAUDE.md`. The full list of lessons
inherited from desktop postmortems lives there — this is the
mobile-relevant slice.

- **Never bolt mobile-only state onto `Track`.** Use
  `MobileTrackOverrides`. The desktop's library schema is the contract.
- **Identity > text, always.** `MobileTrackOverrides` carries an
  `audioFingerprint` for exactly this reason. Mobile→desktop merge
  rejects overrides whose fingerprint doesn't match the live track
  rather than force-applying based on `trackId`. Track IDs get
  reassigned on re-import; fingerprints don't.
- **Twin discipline applies across the platform boundary.** If you
  touch `formatDuration`, `albumKey`, `groupByAlbum`, or anything in
  `types.ts`, grep both `mobile/src/` and `src/renderer/` (and
  `core/` for Python twins) for the partner before committing.
- **Stream URLs are built per-call, never cached on the model.**
  Session ids expire; URLs that look fine in storage break at play time.
- **Secrets only go through `secureStore`, never AsyncStorage.**
  AsyncStorage on iOS is plaintext on a jailbroken device.
- **Provider order is locked.** Don't reorder
  `Connection → Library → Playback`. Library reads from Connection;
  Playback reads from both.

## Unit contracts

The single most expensive class of bug in cross-language codebases:
"the field is named `duration` on both sides, but one is ms and the
other is seconds." Document this here, once, and link to it from any
new code that touches a unit.

| Where                                 | Field           | Unit  |
| ------------------------------------- | --------------- | ----- |
| `library.json` (NAS)                  | `duration`      | ms    |
| `mobile/src/types.ts::Track`          | `duration`      | ms    |
| `mobile/src/utils/format.ts`          | `formatDuration(ms)` | ms |
| `react-native-track-player::Track`    | `duration`      | **s** |
| `useProgress()` from track-player     | `position` / `duration` | **s** |
| `iPod iTunesDB mhit 0x28`             | `duration_ms`   | ms    |
| `music-metadata format.duration`      | `duration`      | **s** |

The two boundaries where the unit changes:

1. **`mobile/src/services/playback/queueAdapter.ts`** — divides
   `track.duration` by 1000 before handing to TrackPlayer.
2. **`mobile/src/views/NowPlayingView.tsx`** — multiplies
   `useProgress` values by 1000 before calling `formatDuration`.

If you add a third boundary, add it to this table. If you find
yourself doing math on a duration in some other file without
consulting this table, stop and either (a) move the conversion to one
of the two existing boundaries, or (b) update this table.

## Debugging discrepancies (layer order)

When mobile and desktop disagree on a count, a track set, or
metadata for a specific track, **never start at the audio engine.**
The order is:

| Layer | Inspect with | Touch only when |
|---|---|---|
| 1. NAS `library.json` (the wire format) | `cat | jq`, `python -c 'import json…'` | Always start here. |
| 2. Mobile in-memory snapshot | log `tracks.length`, `lastRefreshedAt`, write a temporary RN debug screen if needed | Layer 1 is consistent. |
| 3. Desktop `library.json` on disk | `~/Library/Application Support/JakeTunes/library.json` | Layer 1 ≠ Layer 2 and you suspect the desktop didn't write what you expected. |
| 4. TrackPlayer queue, AsyncStorage, Keychain | `TrackPlayer.getQueue()`, AsyncStorage dump | Layers 1–3 are provably consistent. |

A 5-line jq query over `library.json` beats hours of TrackPlayer
queue inspection. The desktop build learned this the hard way; see
`docs/postmortems/2026-04-26-duplicates-wrong-layer.md`.

## Phase 1 audit checklist

Before any build that talks to a real DS224:

- [ ] `secureStore` swapped to `react-native-keychain`.
- [ ] `streamUrl` Audio Station path swapped to
      `SYNO.AudioStation.Stream` with id-based streaming.
- [ ] WebDAV transport's Basic auth header is actually populated from
      Keychain in the playback layer (currently an empty `headers: {}`
      placeholder in `queueAdapter`).
- [ ] Album art: Audio Station `cover.cgi` → on-disk cache via
      `react-native-fs`.
- [ ] On-device audio cache (`MobileSettings.cache`) implemented +
      eviction by `lastPlayedAt`.
- [ ] `MobileTrackOverrides` queue + drain (mobile → desktop sync)
      with **fingerprint-gated merge** on the desktop side.
- [ ] Background sync of `library.json` on app foreground.
- [ ] Genres tab parity with desktop.
- [ ] Twin grep run on every shared utility (`formatDuration`,
      `albumKey`, normalize-style helpers, the `Track` type).
- [ ] Schema-version bump documented and reader updated if the
      desktop snapshot shape changed.

## Status

Phase 0 — infrastructure complete. No real NAS to test against until
the DS224 ships.
