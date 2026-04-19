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
