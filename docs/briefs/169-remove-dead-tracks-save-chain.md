# Brief 169 — remove-dead-tracks joins the save chain (JakeTunesV3)

- **Problem:** the in-app remove-dead-tracks handler wrote its own
  tmp+rename outside `librarySaveChain`, with no external-write check
  — and it pre-stamped `lastSelfWriteMtimeMs`, so the mtime guard
  couldn't see its staleness either. Any normal save landing during
  its (long) verification window was silently overwritten.
- **Evidence:** desktop audit Lens 2, finding 5 —
  `src/main/index.ts:10707-10760` (at 12bb43b). Its mass-deletion
  guard and `.bak-dead-*` backup (`:10723-10751`) are real and STAY,
  untouched by this change.
- **Fix (as implemented):**
  - The handler records the on-disk mtime of the library state its
    removal is based on, right after the initial read.
  - The final write (same tmp name, same pre-stamp ordering, same
    post-rename mtime refinement) runs as a task on
    `librarySaveChain`, and immediately before the rename re-checks
    the on-disk mtime: if `library.json` moved since the read, the
    write refuses with `reason: 'external-write-conflict'` instead of
    clobbering the newer state (the user can retry; the backup was
    already taken).
  - The chain-keeper uses a LOGGED `.catch` (not the silent pattern)
    so the structural rails' silent-catch count does not grow.
  - Known residual (documented, out of scope): a save queued AFTER
    this write can still re-add dead tracks from its own in-memory
    state; chain ordering prevents simultaneous renames, which is the
    lost-update class this brief targets.
- **Size:** S. **Risk:** low.
