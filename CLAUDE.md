# JakeTunes V3 — Project Rules

## What This Is
A desktop iTunes replica for macOS built with Electron + React + TypeScript.
Vision: 2006 iTunes shell, 2040 brain inside. Every interaction must feel
intentional and finished. This is a personal app — polish matters as much
as functionality.

---

## Platform Rules — Electron Renderer (CRITICAL)

These APIs are silently blocked or broken in Electron renderer processes.
**Never use them. No exceptions.**

- `window.prompt()` — returns null silently. Use inline React input components instead.
- `window.alert()` — silently blocked. Use the existing `ConfirmDialog` component.
- `window.confirm()` — silently blocked. Use the existing `ConfirmDialog` component.
- `localStorage` / `sessionStorage` — use `electron-store` or IPC to main process instead.
- `navigator.clipboard` — use Electron's clipboard module via IPC instead.

**Before using any browser API, ask: "Does this work in Electron's renderer process?"**
If unsure — use IPC to main process, or check the existing codebase for the established pattern.

**Lint check:** If you add any of the above, the build will catch it. Run:
```bash
grep -r "window\.prompt\|window\.alert\|window\.confirm" src/renderer/
```
Zero results is the only acceptable output.

---

## React Hook Rules

**Never place a useEffect before the useState declaration of any variable
in its dependency array.**

Toolbar.tsx is 500+ lines with state declarations scattered throughout.
Before placing any new useEffect, scan downward from the proposed location.
If any dependency variable is declared below that location, move the
useEffect down until it is after all its dependencies. Violation causes
a JavaScript Temporal Dead Zone crash — grey screen, error boundary,
no useful console message.

**Every cancel/undo/stop path must reverse all side effects of the
corresponding start path.**
- If start fades volume → cancel must restore volume
- If start sets a ref → cancel must clear the ref
- If start sets a loading flag → cancel must clear the loading flag
- If start assigns an audio element → cancel must pause and null it
Audit cancel paths against start paths before submitting any fix.

---

## Brief & Build Rules

**Do not use browser dialogs for user input.** For any text input from the
user (naming a playlist, renaming, entering a search term), use an inline
React `<input>` component rendered in the UI — not a native OS dialog.

**Specify useEffect placement by line number or by dependency declaration,
never by proximity to another hook.** "Place alongside the X useEffect"
is not an acceptable location instruction in this codebase.

**Icon sizing must be specified as a ratio to the container, not just
absolute pixels.** "20×20 icon in a 28×28 button" is acceptable.
"20×20" alone is not — it will require correction rounds.

**Color and style specs must include a hex value and a visual reference.**
"Make it pop" is not a spec. "#e0812e with double-layer box-shadow glow"
is a spec.

---

## Code Hygiene — Twins, Destructive Ops, Sweep Before Ship

These rules exist because they have already been violated in costly ways.
See `docs/postmortems/2026-04-25-verify-repair-cascade.md` for what
happens when they aren't followed.

**Twin/sibling discovery is mandatory before declaring a fix done.**
When fixing any function named `normalize`, `compare`, `match`,
`canonicalize`, `dedupe`, `serialize`, `parse` — or any function whose
behavior is shared across language boundaries (Python ↔ TypeScript) —
grep the whole tree for implementations of the same name *before*
running any build:

```bash
grep -rn "function <name>\|const <name>\|^def <name>" src/ core/
```

If a twin exists, fix it in the same commit. Shipping one side of a
twin pair is the most expensive failure mode this codebase has seen.

**Twin functions must declare each other in code.** Any function with
a twin in another language carries a `⚠️ TWIN: <path>` comment on both
sides, naming the file and reason. The first thing the next editor
sees is the link to the other implementation.

**Destructive operations may not gate on text comparison.** Deletion,
overwriting, sync abort, or any other irreversible/blocking operation
must gate on **identity** — binary fingerprint (`audioFingerprint`),
content hash, stable ID, exact path. Not on whether two strings
happen to normalize equal. If text comparison is the only signal
available, the operation requires explicit per-item user confirmation.
The verify-and-repair feature violated this rule and deleted user
tracks because "Pt." didn't equal "Part."

**Removing a feature requires a problem-space audit.** Before deleting
an IPC handler, menu entry, or feature module, list the sub-problems
that feature was solving and confirm each one is either still covered,
explicitly out of scope (with user sign-off), or replaced in the same
change. Don't orphan a sub-problem the user will hit five minutes
later.

**Sweep before ship.** Before `npx electron-builder`:
- Grep for related code paths (named twins, shared regex constants,
  shared comparators).
- Re-read the edited file end-to-end.
- Check that any new field on a `Track`, IPC type, or reducer action
  is consumed everywhere it needs to be.

The cycle is **edit → grep → reread → build → install**. Skipping
the middle two makes the user the test suite.

---

## Do Not Touch (without explicit permission)

These are working correctly. Do not change them unless a brief explicitly
says to and explains why:

- `src/renderer/context/PlaybackContext.tsx`
- `src/renderer/context/LibraryContext.tsx`
- `src/renderer/hooks/useAudio.ts`
- `src/renderer/hooks/useVirtualScroll.ts`
- `src/renderer/components/playback/NowPlaying.tsx` (scrubber drag logic)
- `src/renderer/views/AlbumsView.tsx`
- `src/renderer/views/ArtistsView.tsx`
- `src/renderer/views/GenresView.tsx`
- `src/renderer/views/CDImportView.tsx`
- `src/renderer/views/DeviceView.tsx`
- `core/` directory (Python and Swift — do not touch)

---

## Commit Rules

- Commit all prior uncommitted work before starting any new brief
- Polish work and feature work belong in separate commits
- A commit that mixes both makes the diff unreadable and the do-not-touch
  list unverifiable

---

## Testing Rules

- **P0 (Blocker):** App crashes, data lost, wrong output, security issue, or
  silent Electron API failure. Fix immediately before anything else.
- **P1 (Must fix):** Feature broken. Fix before moving on.
- **P2 (Should fix):** Cosmetic issue affecting usability. Fix in current session.
- **P3 (Nice to have):** Log it, do not block progress.

**Smoke test after every session:** Before closing, verify these basics:
- Every button in the sidebar does something when clicked
- Playback controls respond on first click
- Get Info modal opens, fields are editable and text is selectable
- DJ Mode starts and stops correctly, volume restores on cancel
- DJ sidebar button glows orange when DJ Mode is active

---

## Architecture Notes

**State communication between Toolbar and AlbumArtPanel:**
These components are in separate React tree branches (toolbar vs sidebar).
They communicate via CustomEvents on `window`:
- `toggle-dj-mode` — fired by AlbumArtPanel to start/stop DJ Mode
- `dj-mode-state` — fired by Toolbar when `djModeActive` changes (detail: `{ active: boolean }`)
- `musicman-dj-cancel` — fired when DJ Mode is cancelled by user track selection
- `musicman-speaking-start` / `musicman-speaking-end` — fired by Music Man speech events
- `musicman-dj-transition` — fired by useAudio when auto-DJ needs to transition
- `musicman-dj-set-ended` — fired by useAudio when the DJ set queue is exhausted

Do not lift DJ state to a shared context — the CustomEvent bridge is intentional
and keeps Toolbar's internal state self-contained.

**Toolbar.tsx is the most complex file in the codebase (~500 lines).**
It manages: transport controls, now-playing pill, volume, DJ one-shot comments,
auto-DJ mode, DJ Mode (Spotify-style set), AirPlay device selection, queue toggle,
and search. Be surgical when editing it.

---

## Out of Scope (current phase)
- AirPlay auto-detection via Bonjour/mDNS
- Intel Mac universal binary testing
- Listener profile data in Get Info modal
- Double-click to rename playlists (deferred)
- Select-all on playlist input focus (deferred)

---

## Mobile (mobile/)

JakeTunes Mobile is the iOS-first React Native client living in
`mobile/`. It ships as a thin client over the future Synology DS224 —
the desktop is the source of truth for the library, the NAS is the
storage layer, the phone is a player. See `mobile/README.md` for the
full architecture diagram.

**Twin discipline crosses the platform boundary.** `Track`, `Playlist`,
`formatDuration`, `albumKey`, and the album/artist grouping logic
exist in both `src/renderer/` and `mobile/src/`. Both sides carry a
`⚠️ TWIN: <path>` comment. Treat them like any other twin pair: when
you change one, grep the other in the same commit.

**Never put mobile-only state on `Track`.** Mobile mutations queued on
the device (play counts, ratings) live in `MobileTrackOverrides` in
`mobile/src/types.ts`. The desktop owns `Track`'s shape; the mobile
app is not allowed to extend it.

**The mobile app is its own npm project.** `mobile/package.json` is
independent — running `npm install` at the repo root does NOT install
mobile deps. CI and dev flows for the desktop never touch `mobile/`.

**Phase 0 stubs that must be replaced before any build hits a real
NAS:**
- `mobile/src/services/secureStore.ts` is in-memory only — replace
  with `react-native-keychain` before storing a real password.
- `mobile/src/services/nas/streamUrl.ts` uses File Station for the
  Audio Station transport — Phase 1 swaps to
  `SYNO.AudioStation.Stream` for proper id-based streaming.

**Do Not Touch (mobile, without explicit permission):**
- `mobile/src/types.ts` `Track` interface — desktop is authoritative.
- `mobile/src/services/playback/playbackService.ts` — runs in a
  separate JS context; cannot import React or any context.
- Provider order in `mobile/App.tsx`: Connection → Library → Playback.
  Library reads from Connection; Playback reads from both. Reordering
  causes silent null-deref on first render.

### Lessons baked in from the desktop postmortems

These are the explicit things the desktop build learned the hard way.
They apply to mobile too — sometimes more so, because the cross-language
twin distance is larger (TS/desktop ↔ TS/mobile ↔ Python/core ↔
Synology DSM HTTP).

**Unit contracts at every boundary.** `Track.duration` is **ms**
everywhere in JakeTunes — the source field in `src/main/index.ts`
(`durationMs = Math.round((format.duration || 0) * 1000)`) sets the
contract; the library JSON the desktop writes carries ms; the mobile
type carries ms; `formatDuration` on both sides takes ms. The ONLY
boundary where seconds appear is react-native-track-player (its
`Track.duration` and `useProgress()` are seconds). The conversion
happens in exactly two places: `mobile/src/services/playback/queueAdapter.ts`
(ms → s on the way in) and `mobile/src/views/NowPlayingView.tsx` (s
→ ms on the way out, for `formatDuration`). Don't add a third site —
every conversion site is a chance to forget one. **When you add a
new field with a unit, document the unit in the type definition,
not just in one consumer's comment.** (Postmortem citation:
`docs/postmortems/2026-04-25-verify-repair-cascade.md` §4 — the
"normalize" twin shipped because the contract wasn't named in one place.)

**Layer order on count/discrepancy investigations.** When mobile and
desktop disagree on a count or a set, inspect the easier-to-read
layer first. The order is:

1. **NAS-hosted `library.json`** (the wire format) — `cat | jq`.
2. **Mobile in-memory snapshot** — log `tracks.length`, `lastRefreshedAt`.
3. **Desktop in-memory state** — DevTools or `library.json` on disk.
4. **TrackPlayer queue / device storage** — only after layers 1–3 are
   provably consistent.

A 5-line jq query over the wire JSON beats hours of TrackPlayer queue
inspection. (Citation: `docs/postmortems/2026-04-26-duplicates-wrong-layer.md`.)

**Schema-version contract on `library.json`.** The wire JSON the
desktop writes carries a `version` field
(`mobile/src/types.ts::LIBRARY_SNAPSHOT_VERSION`). Mobile **refuses**
snapshots with a higher version than it understands and surfaces a
"desktop and mobile are out of sync" message instead of crashing or
silently misreading. When you change the snapshot shape on the
desktop side, bump the version in the same commit and update the
mobile reader. Never silently re-purpose a field. (Citation: the
0x64 mediaKind incident — `docs/postmortems/2026-04-26-ipod-songcount-counter.md`
— a writer repurposed a field the consumer treated as a classifier
and silently filtered out 150 tracks.)

**Identity over text, on every destructive op.** When the eventual
mobile→desktop sync drains `MobileTrackOverrides`, the desktop merge
MUST verify `audioFingerprint` matches the current track at
`trackId` before applying the override. If it doesn't match, the
override is stale (the user re-imported between mobile-play and
desktop-merge) and is discarded with a log line — never force-merged.
The same rule applies to ANY future mobile feature that writes back
to the library. Text comparison is a hint; binary fingerprint is a
fact. (Citation: §C of the verify-repair postmortem.)

**No native dialogs for input or confirmation.** The Electron-renderer
rule (`window.prompt`/`alert`/`confirm` are silently blocked) does
NOT directly apply on RN — `Alert.alert` works. But the spirit
applies: native dialogs hide intent and break the inline React UX.
Mobile uses inline `<TextInput>` for text input (see `ConnectionView`)
and inline two-step "tap to arm, tap again within Ns to fire"
buttons for destructive ops (see `ForgetNasButton`). When you add a
destructive action, do not reach for `Alert.alert`.

**Cancel paths must reverse start-path side effects.** Every
imperative async flow in mobile (connect, refresh, playTracks) has a
counterpart that can run while the original is in flight. The
ConnectionContext uses a generation counter (`connectGenRef`) so a
racing `forget()`/`saveConfig()` invalidates the in-flight `connect()`
result. When you add a new async action, check whether something
else can stomp it mid-flight and add the equivalent guard.

**Sweep before ship — mobile edition.** Before declaring a mobile
change done:

```bash
# 1) No forbidden APIs (per the renderer rule, applied to mobile).
grep -rn "window\.prompt\|window\.alert\|window\.confirm\|localStorage" mobile/src

# 2) Twin grep for any utility you touched.
grep -rn "function <name>\|const <name>\|^def <name>" src/ core/ mobile/

# 3) Unit grep — make sure no bare Number is being passed across a
#    seconds/ms boundary without a comment.
grep -rn "duration:" mobile/src
```

Cycle: **edit → grep → reread → typecheck → run on simulator**.
Skipping the middle two makes the user the test suite.
