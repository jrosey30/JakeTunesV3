# Brief 258 — Record Shop, Phase 5: downloads you can trust

**Date:** 2026-11-20
**Repo:** JakeTunes V3 (desktop)
**Plan:** Record Shop rework, Phase 5 of 6 (`JakeTunesMobile/Dr. Claude/record-shop-rework-plan.html`). Phases 1–2 were Briefs 253 (#451) and 255 (#454). Phase 3 (search) and Phase 4 (edition offers, Brief 257) are built beside this one.

## Why

- One queue, one job at a time: a 20-song Deluxe held every single song saved behind it, for its whole walk (up to its ladder budget).
- The queue lived only in the renderer's memory. A quit, a crash or an app update lost everything waiting, and a job mid-download was simply gone.
- An album in flight said "Downloading · 412s" and nothing else.
- The Downloads panel was one list sorted by status; what needed Jake was mixed in with what was finished.

## Pre-flight (the seams, at `origin/main` ebe16555)

- Scheduler: `src/renderer/views/DownloadStore/downloadQueue.ts` — `enqueue`, `pump` (one global `running`), `cancel` (→ `streamripCancelActive()`, which killed every download rip).
- Main: `src/main/streamrip-store/index.ts` — a module-level `cancelRequested` and a closure `lastStageFailure`, both reset at the start of every download handler (`download-by-query`, `download-id`, `download`); `activeProcs` tagged download/search; `stageRip` (one `mkdtemp` folder per rip, `--no-db`), `stageBandcamp`, `importStaged` → `deps.importDownloaded`; `sweepOrphanedStaging` at boot (only folders over an hour old).
- Imports: `src/main/import-pipeline.ts` `importDownloadedFiles` — each file goes through `runImportExclusive` (Brief 170: ids reserved on disk), but the dupe fingerprints are loaded once per batch, so two batches at once could each miss the other's songs.
- streamrip (`~/.local/pipx/venvs/streamrip`): `rip` writes config.toml only when its config is modified (app id/secrets blank — they are set); `--no-db` turns the downloads DB off; the failed-downloads DB is sqlite (locks); `requests_per_minute = 60` per process. `rip search` already runs beside `rip id` today (suggestions, the Brief 255 preflight).
- Panel: `src/common/downloads-panel-model.ts` (`panelRowFor`, `downloadsPanelRows`), `src/renderer/components/DownloadsPanel.tsx`.
- Atomic JSON: `src/main/atomic-write.ts` `writeJsonAtomic` (unique temp, fsync, rename, dir fsync).

## The concurrency decision

Two rips at once are safe; two jobs sharing main's state were not.

- **streamrip:** each rip has its own temp folder and `--no-db`; with the app id set, `rip` never writes config.toml; Qobuz already sees a search beside a download today. Two downloads double the request rate (two processes at 60/min), well inside what a search-plus-download already does.
- **Main's state was per process, now per job** (`streamrip-store/rip-jobs.ts`): each download IPC call runs in its own job (AsyncLocalStorage carries it through every await of the walk). The cancel flag, the last rip error and the rip processes are the job's. Cancel names a job (the renderer's arm id) and stops only it; Cancel with no id still stops all (old callers).
- **Imports stay one at a time:** `importOneAtATime` wraps `deps.importDownloaded` in `importStaged`, so the second lane's import loads its dupe fingerprints after the first lane's import finished: a song saved while its album downloads is imported once, and the album counts it as already in the library. The Bandcamp purchase import doesn't go through `importStaged` and is unchanged.
- The walk itself (identity, explicit, ladder, Bandcamp after Qobuz) is untouched: the handlers' bodies change only where they read the cancel flag and the last rip error.

## Changes

### Phase A — two lanes (renderer)

1. `laneOf` (`common/download-lanes.ts`): an album request (by query, picked or pasted id) runs in the album lane; everything else in the song lane. `pump` starts both lanes; each lane runs its first queued job, one at a time. The album lane still waits for an album's preflight answer (Brief 255); the song lane never does.
2. Every arm of a job gets an `armId`, sent to main as `jobId` (by query, by id). Cancel sends it.

### Phase B — main, one job each

3. `streamrip-store/rip-jobs.ts`: `runInJob`, `currentJob`, `cancelJobs(id?)`, `importOneAtATime`, `watchLanding`, `stopAllJobsNow`. In `index.ts`: the three download channels are registered through `jobScopedIpc` (the job, its progress sender, and the finished ledger); `cancelRequested` / `lastStageFailure` reads become `currentJob()`; `run` adds a download child to its job; each staging folder is noted on its job; `importStaged` goes through `importOneAtATime`; `streamrip:cancel-active` takes an optional job id.
4. A quit (`process 'exit'`) kills every rip and removes its staging folders, so nothing half-arrived is left; the job starts again from nothing on the next launch.

### Phase C — the saved list

5. `main/download-queue-store.ts`: `userData/download-queue.json`, written whole with `writeJsonAtomic`, one write at a time, a save during a write written once after it (newest wins). IPC `download-queue:load` / `download-queue:save`.
6. The finished ledger: when a job's import answers ok, main writes its arm id to the same file **before** it answers the renderer (`deps.onJobFinished` → `markFinished`). A quit between the import and the renderer saving "done" restores the job as done.
7. Renderer: every change saves (`toSavedJobs`, coalesced in a microtask). Nothing is saved, and nothing starts, until the saved list has been read back, so a fresh start can't overwrite yesterday's list. `restoreSavedQueue`: the job that was downloading is queued again at the head of its lane with a new arm id (its old rip is stopped first if main is still running, as after a window reload); a job in main's ledger is done; the rest keep their order; album jobs ask their preflight again without a second usage line. Kept on disk: everything unfinished, today's finished, what needs Jake for 14 days; at most 400 jobs.

### Phase D — "7 of 12"

8. While an album rip runs, `watchLanding` looks at its staging folder every 2 s: a song file whose size held still between two looks has landed (streamrip writes under the final name). Main sends `streamrip:job-progress { jobId, have, of }`; the job carries `progress`; the row's status reads "Downloading · 7 of 12 · 41s". Songs show no count.

### Phase E — one tidy list, and the Needs you slot

9. `downloadsPanelSections`: **In progress** (downloading, queued, or a refused album whose recovered songs are still on the way), **Done today** (done or canceled since midnight), **Needs you** (failed or refused). Older finished jobs are not shown.
10. Each row carries `needsYou: { kind: 'refused' | 'failed', line } | null`. `components/NeedsYouSlot.tsx` renders, beside a Needs you row, the one component registered with `setNeedsYouFix` (none in this phase).

## Words added

Section heads: "In progress", "Done today", "Needs you". Status: "Downloading · 7 of 12". Nothing else.

## What NOT to change

- The walk: album identity, the explicit rules, the ladder, Bandcamp after a Qobuz miss, the preflight (Brief 255) and the edition logic (Brief 257).
- The Search tab.
- The Bandcamp purchase import.
- The usage log (no new events; nothing saved carries the click time).
- The Qobuz token: never in the saved list, a log line or the renderer.

## How Phase 4 plugs in

- Register one component: `setNeedsYouFix(ClosestEditionOffer)` from `components/NeedsYouSlot.tsx`. It gets `{ row, item }`: `row.needsYou.kind` / `row.needsYou.line`, `item` is the queue job (result, outcome, alternatives, `preflightAnswer`, and anything Phase 4 puts on it). Return null when there is no offer. The panel renders it under the row's line, only in Needs you.
- A field Phase 4 adds to a job that must survive a restart goes in `SAVED_FIELDS` (`common/download-lanes.ts`).
- The fix itself queues through `enqueue` as today; it lands in the right lane by itself.

## Done when

- A song saved while an album downloads finishes without waiting; each lane runs one job; at most two at once.
- A quit in the middle of three album saves loses nothing: the same three come back in order, the interrupted one restarted from nothing (`download-lanes.test.ts`).
- An album that finished just before the quit is not downloaded again.
- An album row shows "7 of 12".
- Downloads shows In progress, Done today, Needs you.
- Both typechecks and the related tests green.

## Out of scope

Retrying the songs a short Qobuz transfer missed (still the walk's time), resuming a half-downloaded album song by song (it starts again from nothing; the staged files are never imported), the phone (Phase 6).
