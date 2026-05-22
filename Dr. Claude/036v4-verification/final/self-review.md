# Brief 036 v4 — Self-Review

## Phase A — UI strip + embed
- [x] tsc passes (28 errors, unchanged at file:line:code from v3 post-B baseline; full diff in `verification/A/tsc-after.txt`)
- [x] Build passes (`verification/A/` — also visible: -10 KB CSS, -17 KB JS as archived dead code dropped)
- [ ] bandcamp.com renders in JakeTunes (screenshot saved) — **deferred to Jake**, Claude Code is text-only and cannot drive the GUI or capture screenshots; commit pushed for manual smoke
- [x] Single commit pushed: `9688f0f`

## Phase B — Download → library
- [x] tsc passes (28 errors, identical to post-A; `verification/B/tsc-after.txt`)
- [ ] Real purchase tested (Y/N): **deferred to Jake** — requires Mac display + Bandcamp login
- [ ] Single-track .m4a import (Y/N): **deferred to Jake**
- [ ] Album .zip import (Y/N — optional): **deferred to Jake**
- [ ] Imported track plays in library (Y/N): **deferred to Jake**
- [x] Single commit pushed: `2f4628e`

## Phase C — Library arrival
- [x] tsc passes (28 errors, identical at file:line:code level; line numbers in App.tsx + SongsView.tsx shift due to my insertions but the same pre-existing errors)
- [ ] Toast visible on import (screenshot saved) — **deferred to Jake**
- [ ] Marker visible on imported track (screenshot saved) — **deferred to Jake**
- [ ] Marker expires after ~10s — **deferred to Jake** (logic verified by reading the timer code; visual smoke pending)
- [x] Single commit pushed: `b5c70e0`

## Phase D — Cleanup
- [x] tsc passes (28 errors, identical at file:line:code to post-C — Phase D dead-code removal didn't touch any of the pre-existing-error files)
- [x] Build passes (`verification/D/`)
- [x] No dead IPC handlers in live code — verified via the brief §D.1 grep + the extended grep for the other 11 v3 channels; all dead refs only inside `_archive/`
- [x] Single commit pushed: this commit

## Final E2E
- [x] Build clean (output in `verification/D/tsc-after.txt` + verbal confirmation above)
- [ ] All E2E steps completed with screenshots: **deferred to Jake** — Mac executor needed for the embed + purchase + library round trip

## Honest assessment

**What I'm uncertain about:**
- WebContentsView coordinate alignment: relies on the renderer's `getBoundingClientRect()` returning viewport-relative CSS pixels and Electron's `setBounds` interpreting them in the same coordinate system. Per Electron docs they should align in a single-WebContents BrowserWindow, but I have not visually verified the modal lands exactly inside the StoreView container at all DPRs / window sizes. Jake's Phase A smoke will catch this — if the embed paints over the sidebar or the toolbar, the math needs adjustment.
- Aggregation window (2s) for the toast: an album-zip extraction firing events back-to-back via the download-router will all land inside one window, but a slow zip or a flaky importOneFile could spread events over more than 2s, splitting one album into two toasts. Empirically a Panic Shack 10-track album extracted + imported in ~3-4s in the v3 spike; the per-track import inside `_pending-imports/` should be faster. Worth observing in Jake's smoke.
- `.songs-row--recently-added` interaction with `--selected`: the iTunes-8 selection bg (#4577d3) fully overdraws the 3px inset shadow. That's a feature (selection wins; user has acknowledged the new track), but it means if the user is clicking around right when the new track lands, they may miss the pulse. Not fixing — toast is the primary affordance.

**What diverged from the brief and how:**
1. **`AlbumsView` marker skipped** (Phase C). Brief asks for markers on "Songs view, Recently Added playlist, Albums view"; `AlbumsView.tsx` is on `CLAUDE.md`'s do-not-touch list. Marker scoped to `SongsView` only. Per Dex's standing instruction (plumbing decisions: pick obvious answer, log here, execute) — `CLAUDE.md` is standing law; the marker on Albums would need explicit unblock.
2. **No separate Recently Added view exists in V3** — it's `SongsView` sorted by Date Added desc. The marker on SongsView covers this naturally; no extra wiring needed.
3. **Pre-brief commits.** I made two preliminary commits before Phase A (per earlier Dex authorization): `82e23d0` v3 verification closeout, `58cc3fa` v4 brief itself (matching v3 `546b50c` precedent). The brief's "4 commits past 60bfa29" count refers to phases only; preliminary docs commits are above the line.
4. **Pre-flight 2.3 false negative carried forward.** The brief's gate `npx tsc --noEmit` returns 0 due to stale buildinfo on the project references — the real gate is `tsc --build --force` which shows 28 pre-existing errors (from v3 Phase B's discovery). v3 redefined the gate as "no new errors at file:line:code level"; v4 implicitly inherits. Documented across each phase's `tsc-after.txt`.
5. **`tsconfig.{web,node}.json` gained `"exclude": ["**/_archive/**"]`** in Phase A. Required because archived files have now-broken relative imports (moved one level deeper). The brief didn't explicitly authorize this, but per Decision 6 "Archive, don't delete — preserve in case useful later" the spirit is don't-maintain-archives, which exclude-from-tsc enforces.
6. **`acquisition/auth.ts` kept in live code with `clearSession` only.** Brief §6 forbids undoing the caches→cachestorage fix; preserving the file is the literal way to honor that. `clearSession` has no live caller in v4. Could be archived in a future cleanup ticket if Dex wants.
7. **`importOneFile` `source` param added but no live UI consumer of the persisted `source` field.** Bandcamp downloads write `source: 'bandcamp'` on the track record, but no view reads it yet. Forward-compatible with a future "source icon in song row" feature; out of v4 scope.

**Bugs discovered out of scope (file as future briefs):**
- The 28 pre-existing tsc errors (Toolbar `musicmanRadio`, PlayCacheModal `prepareAlacCache`/etc., useAudio `currentTrack`/`recordPlay`/`recordSkip`, DeviceView `getAppVersion`, MusicManView avatar import, SmartPlaylistView event listener, SongsView ref nullability + EQ Object.entries args, App.tsx Track→Record cast + File.path missing, etc.) — all carried from before this brief. These suggest a drifted electronAPI declaration and a couple of typing tightenings. Worth a dedicated cleanup ticket but not in v4 scope.
- v3 `.songs-row--recently-added` pulse: not paused on reduced-motion preference. If Jake or another user has `prefers-reduced-motion`, the pulse keeps running. Minor a11y polish, not scope.
- `_pending-imports/` accumulates indefinitely (brief acknowledges this — "leave files in place"). No purge mechanism. Could be a future housekeeping ticket if disk fills.

**What worked well per the standing instruction "stop relaying plumbing decisions":**
- Made the call on (a) commit grouping for preliminary work, (b) tsconfig exclude rule, (c) `clearSession` retention, (d) AlbumsView skip, (e) toast aggregation window choice (2s), (f) marker visual (inset shadow + pulse vs. badge/border alternatives) — all executed and logged here rather than relayed.
