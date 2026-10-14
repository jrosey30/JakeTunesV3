# Brief 183 — Scheduler definitions live in git + sync-script drift assertion

## Source / evidence
- Proposed briefs 160+, Brief 183 (steps audit §2/§10; Lens 3 — the
  scheduler state was the least discoverable part of the system).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`:
  - Loose plists already in the repo: `scripts/com.jaketunes.dev-mirror.plist`
    (every 300s + RunAtLoad), `scripts/com.jaketunes.listening-history.plist`
    (daily 04:00), `scripts/com.jaketunes.scotus-backup.plist`. No other
    job definitions existed in git.
  - Trainer time **02:00** evidenced in `brain-trainer.mjs`'s header
    ("the trainer (02:00) is always finished well before brain-improve
    (03:05)"); no plist or label for the trainer existed in the repo.
  - `brain-improve` runs **03:05** (same comment) and is discussed in
    `docs/brain-improvement-2026h2.md`, but no script or plist for it
    exists in the repo → manifest `external`, definition NOT invented.
  - taste-eval label + cadence evidenced in `taste-eval.py`'s docstring:
    "runs on the homemini every few days via com.jaketunes.taste-eval";
    it appends to `taste-eval-history.jsonl`.
  - The taxonomy job's existence is evidenced (nightly, app-gated) but no
    schedule/label exists in the repo → proposed, marked as such.
  - Sync: `src/main/sync-orchestrator.ts`'s header records that the
    `com.jaketunes.sync` LaunchAgent **was replaced by the app's main
    process** because macOS Sequoia blocks launchd-domain processes from
    network volumes regardless of TCC grants; the script it ran,
    `~/bin/jaketunes-homemini-sync.sh`, is "a copy of
    Dr. Claude/scripts/" — and the repo copy EXISTS at
    `Dr. Claude/scripts/jaketunes-homemini-sync.sh`, so the drift check
    compares against it (checksum primary). The header also notes an
    older copy "ignores the flag" (--skip-library-json) — drift is a
    real, already-observed failure mode here.

## What changes
- **NEW `scripts/launchd/`**:
  - `jobs.json` — the manifest: 5 `managed` jobs (brain-trainer 02:00,
    brain-watchdog hourly [Brief 176's template, assigned here],
    taxonomy 01:30 proposed, taste-eval 3-day interval proposed from
    "every few days", enrichment-catchup 04:30 proposed [Brief 177]),
    3 `existing-plist` jobs (dev-mirror, listening-history,
    scotus-backup), 2 `external` jobs (brain-improve — time evidenced,
    definition not in repo; com.jaketunes.sync — superseded, marked
    DO NOT INSTALL). Every entry carries its evidence in `notes`;
    `proposed: true` marks every schedule this manifest newly proposes.
  - `templates/*.plist.template` — one per managed job, in the repo's
    existing plist style, with `__HOME__`/`__REPO__`/`__NODE__`/
    `__PYTHON3__` tokens.
  - `install-launchagents.sh` — idempotent installer: render → diff →
    reload only what changed. **Dry-run by default; `--apply` required
    to change anything.** launchctl is used when present; without it the
    file install still happens and the reload is reported skipped (so
    the mechanics are testable off-Mac).
  - `status.sh` (also `install-launchagents.sh --status`) — every job's
    last-known status from its own status file: brain-status.json
    (176), taxonomy-deferred.json (182), taste-eval-history.jsonl,
    enrichment-status.json (177).
  - `README.md` — the directory's contract.
- **`src/main/sync-orchestrator.ts`** — startup drift assertion:
  `checkSyncScriptDrift()` runs in `startSyncOrchestrator` right after
  the script-presence gate. It locates the repo copy
  (`$JAKETUNES_REPO_DIR`, else `app.getAppPath()`, +
  `Dr. Claude/scripts/jaketunes-homemini-sync.sh`), sha256s both files,
  and on mismatch logs a loud `⚠️ SYNC SCRIPT DRIFT` warning (console +
  the flight recorder via `quietWarn`). If no repo counterpart is
  found, it warns that drift is UNVERIFIABLE. Warn-only in all paths —
  a drifted script still syncs; the check itself is try/caught so it
  can never break startup.

## What does NOT change
- No agent is installed by this PR on any machine — activation is the
  manual step below, per machine, with the installer's dry-run first.
- The existing loose plists are not moved or re-rendered.
- Sync behaviour, timing, and batching are untouched; the drift check
  observes and warns, it never blocks, edits, or re-copies anything.
- No version bump.

## Done looks like
- A rebuilt machine gets its whole scheduler back from one repo
  directory and one `--apply`.
- A stale `~/bin` sync script announces itself at app startup instead
  of silently syncing with last month's semantics.

## Tests (run in the agent environment)
- `bash -n` clean on both scripts; `jobs.json` parses; all 5 templates
  are well-formed plist XML.
- Installer fixture runs (fixture HOME + LAUNCHAGENTS_DIR under /tmp,
  repo pointed at the working tree):
  1. dry-run on an empty agents dir → all 5 rendered plists shown,
     **zero files written**;
  2. `--apply` → all 5 installed (launchctl absent on Linux → "reload
     skipped" reported, as designed);
  3. dry-run again → **5 up to date, 0 changed** (idempotent);
  4. hand-edit the installed watchdog plist (3600→1800) → dry-run shows
     exactly that one-line unified diff and makes no change.
- `status.sh` against a fixture state dir → all 10 manifest entries
  printed with correct per-job status (brain ok + age, taxonomy
  DEFERRED with pending count, taste-eval last history line,
  enrichment phases + cap source).
- sync-orchestrator.ts: type-stripped with Node's own
  `stripTypeScriptTypes` and `node --check` **passes** on the result.
  Full `npm run check` is not runnable from the agent env (no
  node_modules) — Mac/CI verification is a manual step.

## Manual steps (verbatim)
1. On EACH machine that runs pipeline jobs (laptop, homemini), after
   merge, from the repo checkout:
   `scripts/launchd/install-launchagents.sh` — read the diffs.
   Then `scripts/launchd/install-launchagents.sh --apply`.
   Proposed schedules (watchdog hourly, taxonomy 01:30, taste-eval
   3-day, catch-up 04:30) take effect at that moment — adjust the
   templates first if a time is wrong for that machine.
2. Run `npm run check` (or the repo's CI) on the Mac to typecheck the
   sync-orchestrator change in the full project context.
3. After the next app start on the laptop, check the log for the
   "sync script matches the repo copy" line — or act on the drift
   warning by re-copying `Dr. Claude/scripts/jaketunes-homemini-sync.sh`
   to `~/bin/` if one appears.
