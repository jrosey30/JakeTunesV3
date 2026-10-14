# Brief 168 — fsync the canonical save path (JakeTunesV3)

- **Problem:** neither the canonical save nor `writeJsonAtomic` fsyncs
  the file before rename or the directory after. Rename protects
  against app crashes, not power loss — after an outage the renamed
  file can come back empty or stale. (The NAS staging path already
  attempts `fh.sync()`; the local path is the odd one out.)
- **Evidence:** desktop audit Lens 2, finding 4 —
  `src/main/index.ts:5231-5246`, `:5070-5082`;
  `src/main/atomic-write.ts:30-56` (at 12bb43b).
- **Fix (as implemented, two halves):**
  1. **PR half (standalone, off main):** `src/main/atomic-write.ts` —
     `writeJsonAtomic` fsyncs the staged file before the rename and
     the destination directory after (file fsync strict, directory
     fsync best-effort: some filesystems refuse it, and the rename has
     already landed by then). Tests added to
     `src/main/__tests__/atomic-write.test.ts`.
  2. **Chain half (patch, stacked on Brief 167):** new module
     `src/main/fs-durability.ts` (`fsyncFile` strict, `fsyncParentDir`
     best-effort, unit-tested); `saveLibraryImpl` fsyncs the staged
     `library.json.partial.json` before its rename and the directory
     after; Brief 166's heal helper `stagePayloadAndRename` gets the
     same discipline so the heal path is not the durability hole.
- **Size:** S. **Risk:** low.
