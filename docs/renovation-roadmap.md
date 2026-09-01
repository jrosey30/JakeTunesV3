# Structural Renovation Roadmap

Jake, 2026-08-16: "the app needs a structural rennovation. it is beginning
to break down a lot. improve build internally. all code rules need to be
iron clad to making the app work as designed."

Phase 0 shipped the same day (rails + hook + gated nightly push — see the
Enforcement section of CLAUDE.md). This document is the rest: the order of
work, chosen so every step shrinks the blast radius of the steps after it.
One cut per brief. Every cut lands through the gate.

## Why the app "breaks down a lot" — the honest diagnosis

Every major incident of August traces to one of four structural causes:

1. **The god file.** `src/main/index.ts` (17,067 lines at lock) holds ~200
   IPC handlers, the sync engine, the download pipeline, the import
   pipeline, caches, and the wiring for every extracted module. Every
   rebuild inside it risks dropping a wire — and has (explicitWins,
   radio facts, the title-search rescue).
2. **Rules without enforcement.** The type net was down for weeks; the
   Do-Not-Touch list was prose; nothing ran tests before commits. Fixed
   in Phase 0 — the gate now exists.
3. **Silent failure.** 78 `.catch(() => {})` in main. When something
   breaks, it breaks invisibly, and the investigation starts from zero at
   2am. Ratcheted in Phase 0; drawn down in Phase 3.
4. **Concurrent writers with no seam contracts.** Parallel sessions, the
   nightly robot, PR merges — all landing on main with no shared
   contract but git itself. Phase 0 gates them; Phase 4 gives the
   modules explicit seams so parallel work stops colliding.

## Phase 1 — Decompose the sync + import pipelines out of index.ts

The two highest-churn, highest-blast-radius regions. Cut BY DEPENDENCY
MAP, never by section comment (the personas extraction proved why: function
hoisting makes proximity meaningless). Pattern per cut, proven across
persona-memory / library-digest / listener-profile / library-eviction:

- New module is electron-free; every side effect arrives injected.
- Suppliers (`() => x`), never captured values, for mutable state.
- SHA-1 byte-identity check on moved blocks before/after.
- Tests land in the same commit; wiring lock added to structural-rails.

Cut order (each ~1 brief):
1. `import-pipeline.ts` — importOneFile + importDownloadedFiles + dupe
   fingerprints + the cleanup pass (~600 lines, self-contained-ish).
2. `sync-engine/` — runSyncToIpod + verification gauntlet (~1,500 lines).
   ⚠️ Coordinate with the iPod-thread session; they own behavior, this
   is a MOVE-ONLY cut.
3. `download-search.ts` — the iTunes/Deezer search + rescue machinery
   (~800 lines, includes fetchExplicitAlbumMap + resolveExplicitEdition).
4. `caches.ts` — RE-SCOPED after the P1C4 audit (2026-08-16): the
   play-cache machinery (PLAY_CACHE dir, transcode coalescing map, codec
   cache, prewarm/prune) lives INSIDE the ipod-audio:// protocol
   handler's closure and shares live state with the serving path — the
   region the 2026-08-11 streaming postmortem fenced. Extracting it is
   closure surgery on the critical playback path, not a move-only cut.
   Precondition: a dedicated brief that first gives the protocol handler
   an explicit seam (state object in, serving policy out), reviewed
   against stream-playback-path locks. Also found: SYNC_CONVERT_CACHE
   in index.ts is a DEAD constant (zero uses — the machinery moved with
   the iPod thread's work); its removal belongs to the sync-engine cut.
5. Repeat until index.ts is wiring + window lifecycle only. Ratchet
   follows it down automatically.

## Phase 2 — Renderer structural debt

- Toolbar.tsx (500+ lines, most complex renderer file) → split transport /
  DJ / search into hook modules. The TDZ crash class dies with the split.
- Kill the two `-1`-suffix mount fallbacks and every `[class*=...]`
  selector coupling in tests.

## Phase 3 — Silent-catch drawdown

78 → 0 in batches of ~15 per brief. Each catch either: handles the error,
logs ONCE through a rate-limited helper (add `quietWarn()` — the
silence-expected-failures doctrine says gate on observable state, log the
abnormal), or gets a written justification comment AND stays counted by a
named allowlist in the rail (not the raw number). Lower the ratchet each
batch.

## Phase 4 — Seam contracts

The mobile repo already vendors `@jaketunes/contracts` (sidecar ownership,
API shapes). V3 consumes nothing from it. Extend the contract package to
cover: library.json ownership + schema version, the state-dir file roster,
and the ipod-audio:// URL shape — then make both repos' rails assert
against the SAME vendored source, so a cross-repo drift fails a build
instead of a 2am session.

## Phase 5 — Build provenance

- electron-builder: assert at build time that every file in out/ has a
  source twin (the June squid-store ghost, generalized).
- Stamp buildSha into the About dialog (mobile backend already does this)
  so "which build is this machine running" is never a forensic question.

## What this roadmap deliberately does NOT do

- No behavior changes ride along with structure moves. Ever. A cut brief
  that wants to also "fix a thing it noticed" splits into two briefs.
- No new features until Phase 1 is done — the god file is the fire.
- iPod/Activity Sync internals stay with their owning session; Phase 1
  cut #2 moves their code without changing it, coordinated first.

## Phase 1 progress log (6.0 push)

- 2026-09-01: P1C2 sync-engine/ cut LANDED (move-only, 13 enumerated
  substitutions; index.ts 16,586 → 14,609). IPC batches 1–3 LANDED:
  cd-ipc, audio-output-ipc, live-sets-ipc, mobile-reads-ipc,
  artwork-engine.ts + artwork-ipc (32 handlers total; index.ts →
  12,834; ratchet follows at every step).
- NEXT batch (scouted, needs its own session): the recommendations
  subsystem (~9,420–10,740) — but it INTERLEAVES with playlist/mixtape
  hub-sync inits, friends/credits, and iMessage capture. Sub-map the
  braid first; candidate shape is src/main/recommendations/ owning
  readRecommendationsFile/outbox/converge + exporting
  syncRecommendationsToLocal + startRecoSyncTimer for boot. After that:
  discovery feed cluster (1,400–2,100), musicman/AI handler bodies
  (with the Phase-3a rag-core extraction), metadata/overrides.
