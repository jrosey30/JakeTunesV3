# Brief 171 — Snapshot metadata-overrides.json too (JakeTunesV3)

## Problem / source

The snapshot system covered `library.json` only. `metadata-overrides.json`
— play counts, ratings, skip counts, `lastPlayedAt`, BPM/key analysis,
subgenres, i.e. half the user's accumulated data — got no snapshots; its
only copies were one overwritten `.bak-classify` and mirrors that copy a
bad write as faithfully as a good one. One corrupt overrides write was
effectively unrecoverable. (Audit: Lens 2, finding 7; steps audit §2.)

## Evidence (verified at HEAD 12bb43b)

- `src/main/backup.ts` (1,462 B): wrapper binds the snapshot system to
  `LIBRARY_PATH = join(STATE_DIR, 'library.json')` only.
- `src/main/backup-core.ts` (4,837 B): exact-bytes snapshots, newest 20
  kept (`DEFAULT_KEEP = 20`), restore snapshots the current state first.
  All semantics are library-specific (filename `library-<stamp>-<N>tracks-<reason>.json`,
  track-count validation).
- `metadata-overrides.json` is a STATE_DIR state file (listed in
  `src/main/sidecar-contracts.ts` `STATE_FILE_NAMES`), i.e. it lives in
  the same directory as `library.json`.
- Caller analysis: the snapshotted-file list is defined **inside**
  `backup.ts`, not passed by a caller. `snapshotLibrary()` /
  `maybeAutoSnapshot()` are the entry points and their public API is
  unchanged, so **no `src/main/index.ts` change is needed** — the
  overrides snapshot rides the existing snapshot points.

## What changes

- `src/main/backup-core.ts`
  - The snapshot writer is generalized into an internal `snapshotFileAt`
    (prefix / count-label / counter / lister per file kind).
    `snapshotLibraryAt` keeps its exact signature, filename scheme, and
    behaviour, delegating to it.
  - New `snapshotOverridesAt(overridesPath, backupDir, reason?, keep?, stampStr?)`:
    exact-bytes snapshot named
    `metadata-overrides-<stamp>-<N>entries-<reason>.json`; refuses a
    missing, unparseable, non-object, or empty overrides file. For
    overrides snapshots, `BackupInfo.trackCount` carries the entry count.
  - New `listOverridesBackupsAt(backupDir)` (newest-first; prunes via the
    same rotation — each file kind keeps its own newest 20, and an
    overrides prune never touches library snapshots).
  - New `restoreOverridesBackupAt(overridesPath, backupDir, file)`:
    same restore semantics as the library — snapshots the CURRENT
    overrides first (`pre-restore`), refuses an empty/invalid snapshot,
    strips path traversal, writes via temp + rename.
  - `pruneOldAt` takes the kind's lister (defaults to the library lister).
- `src/main/backup.ts`
  - `snapshotLibrary()` now also snapshots `metadata-overrides.json`
    (same reason string) after the library snapshot — every existing
    snapshot point (manual + throttled auto) covers both files with no
    caller change.
  - New thin exports: `snapshotOverrides()`, `listOverridesBackups()`,
    `restoreOverridesBackup(file)` bound to the real STATE_DIR paths.
- `src/main/__tests__/backup.test.ts` — new describe block (5 tests):
  overrides file gets snapshotted (name, entry count, exact bytes);
  missing/empty/non-object refused; rotation keeps the newest 20 and
  never prunes library snapshots; restore snapshots the current state
  first (`pre-restore`, reversible); empty/invalid restore refused and
  traversal rejected (including a library snapshot name).

## What does NOT change

- Library snapshot filenames, validation, rotation, and restore behaviour
  are byte-for-byte the same (the pre-existing 6 tests pass unmodified).
- No IPC/UI wiring: the Settings backup list and restore flow still show
  library snapshots only. `restoreOverridesBackup` is available in the
  backup module for a future IPC surface; the protective half of this
  brief (snapshots exist and rotate) is fully live via the existing
  snapshot points.
- No `index.ts` change (none needed — see caller analysis above).
- No version bump.

## Done looks like

- After any library snapshot (manual or auto), a matching
  `metadata-overrides-*.json` snapshot exists in `STATE_DIR/backups/`
  whenever a non-empty overrides file exists.
- `backups/` holds at most 20 overrides snapshots and at most 20 library
  snapshots, independently.
- A corrupt overrides write can be rolled back to any of the 20 snapshots
  via `restoreOverridesBackupAt`, and the restore itself is reversible.

## Tests

- `node --test src/main/__tests__/backup.test.ts` (Node 24, type-stripped):
  **11/11 pass** — 6 pre-existing library tests + 5 new Brief 171 tests.
- `node --check` clean on `backup.ts` and `backup-core.ts`.
- Full `npm run check` (tsc zero + full suite) is the repo gate and must
  be verified in CI / a real clone — it cannot run in the agent
  environment (no local checkout).
