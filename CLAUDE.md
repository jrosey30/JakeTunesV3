# JakeTunes V3 — Project Rules

## What This Is
A desktop iTunes replica for macOS built with Electron + React + TypeScript.
Vision: 2006 iTunes shell, 2040 brain inside. Every interaction must feel
intentional and finished. This is a personal app — polish matters as much
as functionality.

---

## Enforcement (2026-08-16 — rules are MACHINE-CHECKED now)

Jake: "all code rules need to be iron clad." The rules below are no longer
advisory prose — the load-bearing ones are enforced:

- **`npm run check`** — both tsconfigs at ZERO errors + the full test
  suite. This is the gate; run it before claiming anything works.
- **`tools/pre-commit`** (install once per clone: `./tools/install-git-hooks.sh`)
  blocks any commit that fails `npm run check`, and blocks staged
  **Do-Not-Touch** files unless you commit with `PROTECTED_OK=1` — which
  means you have Jake's explicit permission, not that you want to skip the
  dialog. `SKIP_CHECKS=1` is the emergency hatch and prints a loud mark.
- **`src/main/__tests__/structural-rails.test.ts`** — BANS (renderer
  dialogs, raw `ipcMain.handle` outside the registrar), RATCHETS
  (index.ts line count and silent-catch count are locked and may only
  shrink), and WIRING locks (doctrine functions must have live call
  sites). If a rail fails your build, the answer is almost never to edit
  the rail.
- The nightly auto-push robot commits without `--no-verify`, so its 23:00
  push is gated by the same hook: a tree that fails checks stays local
  and notifies instead of propagating breakage.

New sessions: run `./tools/install-git-hooks.sh` before your first commit.

---

## Diagnostic capture

When a bug or issue needs investigation, run `./scripts/vern "brief context note"`
from the repo root. It produces a single markdown file in `diagnostics/`
containing repo state, build health (tsc error counts), code structure, and
recent activity. Upload that one file to the AI advisor instead of running
individual grep/sed/cat/git/tsc commands manually.

The context note is optional — `./scripts/vern` alone works fine. Each run
is timestamped, so multiple captures in a session don't overwrite each other.
Diagnostics output is gitignored.

See Brief 017 for the v0 design. Future versions will add dev console
capture, screenshot integration, and live terminal tailing.

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

**JakeTunesMobile is a twin surface for the brain.** Desktop is the
source of truth for mix / RAG / embedding behavior. Daily mixes,
decade gates, orbit quality floors, and `embeddings.bin` load semantics
MUST stay in lockstep with JakeTunesV3 — see
`src/common/mix-brain-twin.ts`. Generating tapes on homemini from soft
cosine alone while desktop hard-gates the same decision is a twin
violation (2026-08: Turnstile on a 1970s tape; RHCP in a Ginga orbit).
When you change a listed desktop file, the Mobile paths in that
contract file are updated in the same change set (or the change is
explicitly incomplete). Safety-net filtering on desktop hydration does
not replace generation-time twinning on Mobile.

**Twin functions must declare each other in code.** Any function with
a twin in another language **or repo** (Python ↔ TypeScript, or
JakeTunesV3 ↔ JakeTunesMobile) carries a `⚠️ TWIN: <path>` comment on
both sides, naming the file and reason. The first thing the next
editor sees is the link to the other implementation.

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

## Version numbering (don't inflate)

**`4.X` (minor) = feature milestone.** A new capability the user
notices. `4.5` = Bandcamp + squid stores with download → library
pipeline. Bump the minor when the *story* of the app changes, not
when code does.

**`4.X.Y` (patch) = real shipped bug fix on top of an
already-distributed build.** Only bump when:
1. A build was already handed to / installed by the user, AND
2. The fix is meaningful enough that the version label needs to track
   "before this fix" vs "after this fix" for future debugging.

**Dev iterations during one feature cycle stay on the same version.**
Rebuild the same dmg over and over; the version doesn't move. Five
fixes in an afternoon while the user is testing on the same dmg
filename = still the same version. Bumping every commit produces
version inflation that erodes the meaning of the number.

**Semver constraint:** electron-builder requires `X.Y.Z`. So `4.5`
is referred to colloquially but the package.json string is `4.5.0`.
The About dialog reads `4.5.0` — same thing.

When in doubt, don't bump. The user will tell you when a label
matters.

---

## Do Not Touch (without explicit permission)

These are working correctly. Do not change them unless a brief explicitly
says to and explains why:

- `src/renderer/context/PlaybackContext.tsx`
- `src/renderer/context/LibraryContext.tsx`
- `src/renderer/hooks/useAudio.ts`
- `src/renderer/hooks/useVirtualScroll.ts`
- `src/renderer/components/playback/NowPlaying.tsx` (scrubber drag logic)
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

## Streaming / workmini playback (CRITICAL)

See `docs/postmortems/2026-08-11-workmini-playback-smb.md`.

On any machine with `library.streamRoot` set (workmini's cache-farm) or
`library.streamSource=homemini`:

- **Playback goes through homemini HTTP first** — same path as the phone.
- **Never** put SMB / `streamRoot` / symlink-follow / `realpath` of those
  links on the `ipod-audio://` hot path. When the mount wedges, the player
  hangs in the kernel with no useful error.
- If homemini is down, **fail closed** (404 + boot warning). Do not "fix"
  by reading the NAS.
- Policy lives in `src/main/stream-playback.ts`. Source-shape locks live in
  `src/main/__tests__/stream-playback-path.test.ts`. If those tests fail,
  the path changed on purpose or by accident — decide before updating them.

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
