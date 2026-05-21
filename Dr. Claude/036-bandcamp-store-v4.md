# Brief 036 v4 — Bandcamp Store: Embedded Web + Library Import Magic

**Status:** Ready for Claude Code
**Priority:** P1 (replaces remainder of v3 brief)
**Scope:** Small-to-medium — 4 phases, mostly deletion + simple wiring, ~300–500 net lines (negative on most files)
**Branch:** Continue on `claude/036-bandcamp-store-phase1` — do not rebase, do not create a new branch
**Prerequisite:** v3 Phases A (`c29103b`) + B (`60bfa29`) already shipped — we keep the auth.ts fix from B, keep the persist:bandcamp partition wiring, drop the iTunes-Store UI scaffolding

---

## 1. Context — Why This Brief Exists

v3 pursued iTunes-Store-2008 visual fidelity over scraped Bandcamp data. After half a day of execution, the honest take is:

- The visual fidelity ambition was theater on top of the real value
- The actual unique value of JakeTunes Store is the **magic moment**: you buy something on Bandcamp, the file lands in your library tagged and ready to play
- Everything else (scraped surfaces, artist/release detail views, sidebar weighting, re-sync button) was speculative product work for value we can't currently prove

v4 collapses to the magic. Bandcamp Store becomes an embedded view of bandcamp.com on `persist:bandcamp`. Users browse, search, discover, and purchase using Bandcamp's own UI — which is good, already personalized to them, and always current. JakeTunes intercepts the download, unzips, and routes to library via existing `importOneFile()`. The library arrival is celebrated visually.

Ethical check: Bandcamp is a legitimate licensed marketplace whose business model is purchase + download. Embedding `bandcamp.com` to facilitate that purchase is the user's intended action. This is not the squid.wtf situation — there is no piracy or unlicensed content involved.

---

## 2. Pre-Flight

Run each. If any unexpected output, **STOP and report**.

### 2.1 — Clean working tree

```bash
cd ~/JakeTunesV3
git fetch origin
git status
git branch --show-current
```

Expected: clean tree, branch `claude/036-bandcamp-store-phase1`, in sync with origin.

### 2.2 — Prior phase commits present

```bash
git log --oneline -10
```

Expected to include `c29103b` (Phase A), `60bfa29` (Phase B), `546b50c` (v3 brief). Their work is partly carried, partly archived — covered in §4.

### 2.3 — tsc baseline holds

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected ≤ 28 (the post-Phase-B baseline). Gate semantics from v3 stand: no NEW errors beyond baseline, no new errors in files this brief touches.

### 2.4 — Build passes

```bash
npm run build 2>&1 | tail -10
```

Expected exit 0.

### 2.5 — Existing Bandcamp wiring present

```bash
ls src/main/bandcamp-integration/
ls src/renderer/views/BandcampStore/
```

Both directories should list files from prior phases. We're going to archive most of `BandcampStore/` and trim `bandcamp-integration/` significantly.

### 2.6 — Verification dir

```bash
mkdir -p Dr.\ Claude/036v4-verification/{A,B,C,D}
```

---

## 3. Architectural Decisions (Locked)

### Decision 1 — Single WebContentsView replaces the entire BandcampStore UI

The Bandcamp Store route renders a single `WebContentsView` on the `persist:bandcamp` partition, sized to fill the main content area (everything below the player chrome, to the right of the sidebar). No tiles, no search bar in JakeTunes UI, no detail views, no surfaces. Bandcamp's own UI is the UI.

### Decision 2 — Secure WebContentsView configuration

The embedded view runs with:
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- No preload script exposed to bandcamp.com content

Phase 1's WebContentsView had several of these disabled (we saw the warnings in console). We tighten them for v4 — Bandcamp doesn't need those disabled, and an embedded marketplace should follow Electron security best practices.

### Decision 3 — Initial URL is `https://bandcamp.com`

Authenticated users get auto-routed to their feed by Bandcamp. Unauthenticated users see the public homepage. Both paths are fine.

### Decision 4 — Downloads route through importOneFile()

`will-download` on the WebContentsView intercepts every download initiated from Bandcamp content.

- `.zip` files (album purchases) → unzip via `yauzl` to a temp directory → iterate audio files → `importOneFile()` each
- Single audio files (`.m4a`, `.mp3`, `.flac`, `.aiff`, `.wav`, `.ogg`, `.aac`) → directly `importOneFile()`
- Non-audio downloads → ignored (let Bandcamp's default behavior handle, or block — pick behavior consistent with Phase 1 spike)

The temp download directory is `~/Music2/JakeTunesLibrary/_pending-imports/`. After successful import, leave files in place (importOneFile already copies to the canonical hashed location).

### Decision 5 — Library arrival is celebrated visually

When a track is imported via this path, it gets tagged in a renderer-side `recentlyAdded` Set for 10 seconds. UI surfaces that render tracks (Songs view, Recently Added playlist, Albums view) show a visual marker (pulse, highlight, badge — match existing V3 styling) on tracks in that Set.

A toast at the bottom of the window confirms the import. For album-zip purchases, the toast aggregates: "Added 12 tracks from '[Album Name]' to your library." For single tracks: "Added '[Track Name]' to your library." Toast auto-dismisses after 4 seconds.

### Decision 6 — Archive, don't delete, the v3 UI scaffolding

The 12 files in `src/renderer/views/BandcampStore/` get moved to `src/renderer/views/_archive/BandcampStore-v3/`. Same for `src/main/bandcamp-integration/data/` and `src/main/bandcamp-integration/personalization/` if they exist. This preserves the work in case any of it becomes useful later and keeps `git blame` honest. Cleanup of `_archive/` is a future housekeeping task.

---

## 4. Phases

Four phases, one commit each, executed in order.

---

### Phase A — Strip and Replace UI

**Goal:** Bandcamp Store sidebar entry shows bandcamp.com in a secure WebContentsView. All v3 UI scaffolding archived.

**Files:**
- `src/renderer/views/BandcampStore/StoreView.tsx` — replaced with WebContentsView host
- `src/renderer/views/BandcampStore/*` (11 other files) — moved to `_archive/`
- `src/main/bandcamp-integration/index.ts` — simplified to register the WebContentsView, download intercept, and minimal IPC
- `src/main/bandcamp-integration/data/`, `personalization/` — moved to `_archive/`
- `src/main/index.ts` — sidebar routing should already work; verify

**Step A.1 — Archive v3 UI files:**

```bash
mkdir -p src/renderer/views/_archive/BandcampStore-v3
git mv src/renderer/views/BandcampStore/AlbumDetailView.tsx \
       src/renderer/views/_archive/BandcampStore-v3/
# ... repeat for the other 10 files; keep only StoreView.tsx in place
mkdir -p src/main/bandcamp-integration/_archive
git mv src/main/bandcamp-integration/data \
       src/main/bandcamp-integration/_archive/data
git mv src/main/bandcamp-integration/personalization \
       src/main/bandcamp-integration/_archive/personalization
```

**Step A.2 — Rewrite StoreView.tsx** as a minimal host that:
- Renders a container `<div>` filling the main content area
- Communicates the container's bounds (x, y, width, height) to main process via IPC `bandcamp:mount` on mount and `bandcamp:resize` on resize
- Calls `bandcamp:unmount` on unmount (when user navigates away from the Store)

**Step A.3 — Rewrite `src/main/bandcamp-integration/index.ts`** to:
- Create a single WebContentsView on `persist:bandcamp` with secure config (Decision 2)
- Attach to BrowserWindow on `bandcamp:mount`, set bounds
- Resize on `bandcamp:resize`
- Detach on `bandcamp:unmount`
- Load `https://bandcamp.com` on first mount
- Register `will-download` handler (wiring details in Phase B)

**Verification A:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # ≤ 28
npm run build 2>&1 | tail -5                       # exit 0
```

**Manual smoke (Jake runs):**
1. `npm run dev`
2. Click "Bandcamp Store" in sidebar
3. **Expected:** bandcamp.com renders in the main content area, sidebar/header still visible, footer still visible
4. Resize the window — bandcamp.com view resizes with it
5. Navigate to another sidebar entry — Bandcamp Store view unmounts cleanly
6. Click back to Bandcamp Store — view remounts, session/login persists

Screenshot: `Dr. Claude/036v4-verification/A/01-store-loaded.png`

**Commit:**

```
feat(store): v4/A — strip iTunes-Store UI, embed bandcamp.com directly

Brief 036 v4 Phase A. Archives the v3 UI scaffolding (12 React
components, scrape data modules) under _archive/. Replaces with a
single secure WebContentsView host showing bandcamp.com on the
persist:bandcamp partition. Bandcamp's own UI is now the Store UI.

- StoreView.tsx: WebContentsView host
- _archive/BandcampStore-v3/: prior UI preserved for reference
- bandcamp-integration/index.ts: simplified to view lifecycle + IPC
```

---

### Phase B — Download → Library Pipeline

**Goal:** Anything you buy and download from Bandcamp lands in the JakeTunes library.

**Files:**
- `src/main/bandcamp-integration/acquisition/` (keep, may need adjustment)
- `src/main/bandcamp-integration/index.ts` (will-download handler)

**Step B.1 — will-download handler:**
- Set the download path to `~/Music2/JakeTunesLibrary/_pending-imports/{originalFilename}`
- On `done` event, dispatch based on file extension:
  - `.zip` → invoke unzip-and-import flow
  - Audio extensions → invoke direct import
  - Anything else → log and ignore

**Step B.2 — Unzip-and-import flow:**
- yauzl-stream the zip to a sibling directory `_pending-imports/{albumName}-{timestamp}/`
- For each extracted entry whose extension matches the audio list, call `importOneFile(filepath, sourceTag: 'bandcamp')`
- Track each successful import for the Phase C toast/marker (emit `bandcamp:track-imported` event with track ID)
- On failure to extract or import, log + emit `bandcamp:import-failed` with reason

**Step B.3 — Direct-import flow:**
- For single audio files: `importOneFile(filepath, sourceTag: 'bandcamp')`
- Emit `bandcamp:track-imported`
- On failure, emit `bandcamp:import-failed`

**Step B.4 — sourceTag passing:**
- importOneFile may need a small extension to accept a `source` parameter and persist it on the track metadata. If the existing signature doesn't take it, add an optional second arg with default. Keep change minimal — no refactor.

**Verification B:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # ≤ 28
npm run build 2>&1 | tail -5                       # exit 0
```

**Manual smoke (Jake runs):**
1. `npm run dev`
2. Bandcamp Store → search a free or pay-what-you-want release (Panic Shack "grin & bear it" is the known-good single-track from the spike)
3. Purchase (or use the free download if PWYW supports $0)
4. **Expected:** The download completes inside Bandcamp's normal flow. The Bandcamp page shows the download as done. JakeTunes UI doesn't show anything yet (Phase C adds that) — but the file should be in the library.
5. Navigate to Library → Songs. Sort by Recently Added. **Expected:** The purchased track(s) appear with correct title, artist, album art.
6. Click play on the imported track. **Expected:** It plays.

Screenshots:
- `Dr. Claude/036v4-verification/B/01-pre-purchase.png` (Bandcamp checkout page)
- `Dr. Claude/036v4-verification/B/02-post-purchase-library.png` (track visible in Songs view)

If a track fails to play because of tagging or codec issues, **STOP and report** — that's a deeper compat problem.

**Commit:**

```
feat(store): v4/B — download intercept routes Bandcamp purchases to library

Brief 036 v4 Phase B. will-download on the embedded Bandcamp view
sends files to _pending-imports/. .zip albums unzip via yauzl, audio
files route through importOneFile() with sourceTag='bandcamp'. Each
imported track emits bandcamp:track-imported for Phase C UI.

- bandcamp-integration/index.ts: will-download handler
- bandcamp-integration/acquisition/: unzip + import dispatch
- (importOneFile signature extended for optional source tag)
```

---

### Phase C — Library Arrival Celebration

**Goal:** When a Bandcamp purchase lands in the library, you SEE it land — toast + visual marker. This is the moment the whole product is built around.

**Files:**
- New: `src/renderer/state/recentlyAdded.ts` (or wherever V3 manages renderer-side state)
- New or reuse: `src/renderer/components/Toast.tsx`
- Modify: `src/renderer/views/Songs/SongRow.tsx` (and similar for Albums, Recently Added) — add marker rendering when track ID is in the recentlyAdded set

**Step C.1 — recentlyAdded Set:**
- Renderer subscribes to `bandcamp:track-imported` events
- Each event adds the track ID to a Set with a 10s expiration timer
- Set updates trigger re-render of subscribed components

**Step C.2 — Visual marker:**
- Tracks rendered with their ID in the recentlyAdded set get a marker — pick the styling that matches V3 (a subtle pulse animation, or a "Just added" badge, or a colored left border — whichever fits existing V3 aesthetic)
- Marker fades out at 10s expiration

**Step C.3 — Toast component:**
- Search the codebase first — if V3 has a toast or notification component, REUSE it
- If not, build a minimal one: fixed-position bottom-center, 4s auto-dismiss, click to dismiss early
- Single-track import: "Added '[Track Name]' to your library"
- Album-zip import: aggregate multiple track-imported events within a 2s window, show "Added [N] tracks from '[Album Name]' to your library"

**Step C.4 — Failure toast:**
- On `bandcamp:import-failed`, show: "Couldn't import '[filename]' — [reason]" — let the user know

**Verification C:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # ≤ 28
npm run build 2>&1 | tail -5                       # exit 0
```

**Manual smoke (Jake runs):**
1. `npm run dev`
2. Buy something on Bandcamp
3. **Expected during/just after download:** toast appears at bottom of window naming the track(s)/album
4. Navigate to Songs view. The new track is highlighted or marked
5. Marker fades after ~10s
6. (Optional, if you can trigger a failure) Disconnect network mid-download → import-failed toast appears with a useful message

Screenshots:
- `Dr. Claude/036v4-verification/C/01-toast.png` (toast visible)
- `Dr. Claude/036v4-verification/C/02-marker.png` (track with marker in library)

**Commit:**

```
feat(store): v4/C — library arrival celebrated, toast + marker

Brief 036 v4 Phase C. Renderer subscribes to bandcamp:track-imported
events, holds new track IDs in a 10s recentlyAdded set. Library
views render a visual marker on those tracks. Toast confirms the
import — single-track or album-aggregated. Failure toast on import
errors. This is the magic moment the entire feature is built around.

- state/recentlyAdded.ts: subscription + expiry
- components/Toast.tsx: (new or reused)
- views/Songs/SongRow.tsx: marker rendering
- (similar minimal changes to Albums, Recently Added views)
```

---

### Phase D — Cleanup

**Goal:** Dead code removed, tsc remains clean, branch reads honestly.

**Files:**
- `_archive/` directories: leave in place for now (future housekeeping)
- Dead IPC handlers: remove any from prior phases that aren't called anywhere
- Dead types: trim BandcampSearchResult union and related types — keep only what Phase B uses

**Step D.1 — Find dead exports:**

```bash
grep -r "BandcampSearchResult\|bandcamp:search\|bandcamp:get-profile\|bandcamp:get-surface\|bandcamp:refresh-profile\|bandcamp:get-release-detail\|bandcamp:get-artist-detail" src/ | grep -v _archive
```

Anything that's only referenced inside `_archive/` or only declared but never called from live code = dead. Remove from live code (keep in _archive).

**Step D.2 — Trim types** to only what Phase B uses.

**Step D.3 — Final verification:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # ≤ 28
npm run build 2>&1 | tail -10                      # exit 0
```

**Commit:**

```
chore(store): v4/D — remove dead code from v3 path

Brief 036 v4 Phase D. Removes IPC channels, type exports, and helpers
that are only referenced in _archive/. Live code now reflects only
the embed-and-import architecture. tsc baseline holds at 28.

- bandcamp-integration/index.ts: prune dead IPCs
- types.ts: trim to current usage
```

---

## 5. Final Verification

After all four phases commit, run:

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # ≤ 28
npm run build 2>&1 | tail -10                      # exit 0
git log --oneline -10                              # 4 v4 commits + prior
```

**End-to-end smoke (Jake runs):**
1. Fresh `npm run dev`
2. Click Bandcamp Store. bandcamp.com renders.
3. Search, browse, click into a release.
4. Buy a single track or a free album.
5. **Watch:** toast appears confirming import. Track visible in library with marker. Plays cleanly.

Save the end-to-end screenshots to `Dr. Claude/036v4-verification/final/`.

### Self-Review Checklist

Create `Dr. Claude/036v4-verification/final/self-review.md`:

```markdown
# Brief 036 v4 — Self-Review

## Phase A — UI strip + embed
- [ ] tsc passes
- [ ] Build passes
- [ ] bandcamp.com renders in JakeTunes (screenshot saved)
- [ ] Single commit pushed

## Phase B — Download → library
- [ ] tsc passes
- [ ] Real purchase tested (Y/N): _____
- [ ] Single-track .m4a import (Y/N): _____
- [ ] Album .zip import (Y/N — optional): _____
- [ ] Imported track plays in library (Y/N): _____
- [ ] Single commit pushed

## Phase C — Library arrival
- [ ] tsc passes
- [ ] Toast visible on import (screenshot saved)
- [ ] Marker visible on imported track (screenshot saved)
- [ ] Marker expires after ~10s
- [ ] Single commit pushed

## Phase D — Cleanup
- [ ] tsc passes
- [ ] Build passes
- [ ] No dead IPC handlers in live code
- [ ] Single commit pushed

## Honest assessment
- What I'm uncertain about: _____
- What diverged from the brief and why: _____
- Bugs discovered out of scope (file as future briefs): _____
```

---

## 6. What NOT to Change

- Do NOT modify `importOneFile()` beyond an optional `source` parameter — its existing behavior is the bedrock
- Do NOT touch the `metadata-overrides.json` system
- Do NOT touch the library view layouts beyond adding the marker render
- Do NOT change the persist:bandcamp partition name (sessions would be invalidated)
- Do NOT add new top-level dependencies — yauzl is already in
- Do NOT touch non-Bandcamp code beyond the bare minimum needed for the marker + toast wiring
- Do NOT undo the auth.ts caches fix from v3 Phase B — it's still correct
- Do NOT delete the _archive/ contents — leave for future housekeeping

---

## 7. What Done Looks Like

1. Bandcamp Store sidebar entry shows bandcamp.com in a secure embedded view
2. Browse/search/discover all work — they're Bandcamp's UI, they always worked
3. Purchase a release → file downloads → imported into library
4. Toast confirms import, library marker visible for ~10s
5. Imported tracks play
6. tsc ≤ 28 errors, build exits 0
7. 4 commits on `claude/036-bandcamp-store-phase1` past `60bfa29`
8. Verification screenshots saved
9. Self-review checklist filled out and committed
10. All pushed to origin

---

## 8. Out of Scope

- Multi-currency display, Bandcamp Friday detection — let Bandcamp handle
- Refresh / forward / back navigation buttons in JakeTunes chrome — Bandcamp handles internally
- Loading spinner overlay while bandcamp.com first loads — only add if Bandcamp's own loading state feels bad
- Library-driven recommendations inside the Store — defer indefinitely; if it becomes a feature later it's a separate brief
- iOS mirror — separate brief, separate executor stream
- Cleanup of `_archive/` directories — separate housekeeping ticket

If during execution something looks like it should be added "while we're here," STOP and ask. Don't silently expand.

---

**End of Brief 036 v4.**
