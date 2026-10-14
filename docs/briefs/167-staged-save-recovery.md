# Brief 167 — Staged-save recovery: recency, not track count (JakeTunesV3)

- **Problem:** `recoverPartialIfNewer` promoted a staged save only if
  it had strictly more tracks than the live file. A staged save
  containing only metadata edits, playlist edits, star changes,
  deletions, or a legitimate shrink was deleted as stale on next
  launch — the user's last session of edits vanished with no trace.
- **Evidence:** desktop audit Lens 2, finding 3 —
  `src/main/index.ts:3735-3764` (at 12bb43b).
- **Fix (as implemented):** decide on "candidate parses AND is newer
  than the live file".
  - The staging code writes NO commit marker (verified at 12bb43b: the
    stage is a bare JSON payload at the fixed sidecar path), so recency
    is mtime.
  - New module `src/main/staged-recovery.ts`: pure
    `decideStagedRecovery(candidate, live)` over file snapshots +
    `snapshotLibraryFile()` (never throws). Rules: candidate missing →
    leave; unparseable → discard; zero tracks → discard; live missing
    or unparseable → promote; candidate strictly newer → promote;
    otherwise → discard.
  - `recoverPartialIfNewer` acts on the decision and logs BOTH
    promotions and discards with the reason.
  - Fixture tests (`src/main/__tests__/staged-recovery.test.ts`):
    metadata-only newer candidate promotes; older candidate discarded;
    equal-mtime discarded; unparseable candidate discarded;
    live-unparseable + candidate-good promotes; live-missing promotes;
    legitimate newer shrink promotes; empty candidate never promotes;
    missing candidate leaves everything alone.
  - Deliberate change from the old code: an unparseable candidate is
    now discarded (logged) instead of left forever. Torn bytes can
    never be promoted; leaving them only hid the loss.
- **Size:** S. **Risk:** low-medium (recovery semantics; fixture-tested).
