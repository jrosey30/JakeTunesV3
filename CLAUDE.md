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

## Security Protocols — Supply Chain Defense

Active npm supply chain attacks (worm-class compromises that steal env
vars and self-propagate through stolen maintainer credentials) make
the rules below non-negotiable. Each one stops a real, observed attack
vector. Strict — but no ceremony that doesn't catch a real risk.

### Dependencies (npm / pip)

- **Lockfile is law.** `package-lock.json` is committed with every dep
  change. CI and build use `npm ci`, never `npm install` — `npm install`
  can mutate the resolved tree and pull a fresh malicious version even
  with a lockfile on disk. Same rule for Python: pin everything in
  `requirements.txt` to exact versions (`==`, not `>=`).
- **Adding a new top-level dep requires three checks, in order:**
  1. `npm view <pkg> time` — reject if the latest version is < 72
     hours old. Fresh publishes on long-stable packages are the
     canonical worm signature. Wait it out, or pin to the prior
     version.
  2. `npm view <pkg> maintainers` — confirm the maintainer set looks
     stable. A new maintainer added in the last week on a popular
     package is a takeover signal.
  3. Read the package's `package.json` for `postinstall`,
     `preinstall`, and `install` scripts. Default to
     `npm install --ignore-scripts` for the first install, then read
     any scripts before re-enabling. Same treatment for any
     transitive dep flagged by audit.
- **Justify every dep add in the commit message.** "Needed for X
  feature" is enough. An unjustified `package.json` addition is
  rejected at review.
- **No `npm install -g` from automation.** Global installs escape
  the lockfile entirely.
- **`npm audit` runs before every release build.** Critical / high
  CVEs block the build unless explicitly waived with a one-sentence
  rationale in the commit.
- **Lockfile diffs get read line-by-line** when a dep is added or
  bumped. Unexpected transitive additions are the worm's calling
  card.

### Secrets

- Every API key, token, and signing credential lives in `.env`.
  `.env` is gitignored. `.env.example` carries placeholder values only.
- Before every commit, scan staged content for accidental leakage:
  ```bash
  git diff --staged | grep -Ei \
    '(sk-[a-z0-9_-]{20,}|api[_-]?key|bearer |password|secret|token)' \
    && echo "POSSIBLE SECRET — investigate before committing"
  ```
  A hit doesn't always mean a real leak (could be a variable name),
  but every hit is reviewed by eye. Never bypass on autopilot.
- No secrets in code, comments, test fixtures, log lines, telemetry,
  or error messages. If a Claude / ElevenLabs / Discogs / GitHub key
  ever shows up in a stack trace or log — P0: redact in source,
  rotate the key, audit recent git history for the same pattern.
- The packaged `.app` / `.exe` does **not** bundle `.env`. Each user
  supplies their own keys in their own userData directory.

### Build / runtime hardening

- Electron renderer must keep `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. Preload exposes a
  typed, narrow API surface via `contextBridge`. No raw
  `ipcRenderer` reachable from renderer.
- The electron-builder code-signing identity is on hardware-key or
  TOTP 2FA. The signing keychain stays on the developer machine —
  never uploaded to CI, never committed.
- `npm run dist` must not require network access beyond the initial
  `npm ci`. If a build step makes an outbound HTTP call during the
  packaging phase, that is a red flag — investigate the offending
  postinstall before shipping the DMG.
- Python helper scripts in `core/` run as subprocesses with explicit
  argv arrays. Never pass user-controlled strings to `shell=True`.
  Existing code follows this — don't regress.
- External HTTP callers (MusicBrainz, Last.fm, Discogs, Pitchfork
  RSS, ElevenLabs, Anthropic, OpenWeatherMap, Cover Art Archive) go
  through `https://` URLs only. No `http://` to a third party,
  ever, even in dev.

### Incident response

- When an npm advisory lands for a package in `package-lock.json`:
  1. `npm ls <pkg>` — confirm presence and dependency depth.
  2. Direct dep: bump to the patched version, regen lockfile,
     rebuild, verify locally before tagging.
  3. Transitive dep: `npm audit fix`, or force the patched version
     via the `overrides` block in `package.json`.
  4. No patch yet: pin to the last known-good prior version via
     `overrides`; track upstream for the fix.
- **During active worm-class incident windows, the lockfile is
  frozen.** No new `npm install` runs against the public registry
  until it is verified clean. Existing builds continue from the
  committed lockfile.
- Any API key that may have touched a compromised build environment
  (the dev machine, CI, a shared workstation) is rotated
  immediately, not "soon." Assume exfil; treat as burned.

### Anti-cargo-cult (what we explicitly DO NOT do)

These would feel security-flavored but cost more than they're worth
on a single-developer Electron project. Not adopted unless
circumstances change:

- Vendoring `node_modules` into the repo (lockfile + `npm ci` is the
  right primitive).
- Running a private registry mirror (introduces its own attack
  surface).
- Manual review gating on every install (kills velocity without
  catching anything `npm view time` + lockfile diff doesn't already
  catch).
- Air-gapping the build (Electron + native deps make this
  prohibitive, with no proportionate gain).

---

## Out of Scope (current phase)
- AirPlay auto-detection via Bonjour/mDNS
- Intel Mac universal binary testing
- Listener profile data in Get Info modal
- Double-click to rename playlists (deferred)
- Select-all on playlist input focus (deferred)
