# Brief 166 — Save self-heal: atomic, and verify by hash (JakeTunesV3)

- **Problem:** after the atomic rename, save-library re-read the file and
  compared only the landed track count; on mismatch it "healed" with a
  direct in-place `writeFile` on the live file. A crash during the heal
  leaves exactly the torn file the temp+rename design exists to
  prevent, and a landing with the right count but wrong content passes
  verification.
- **Evidence:** desktop audit Lens 2, finding 2 —
  `src/main/index.ts:5258-5265` (at 12bb43b).
- **Fix (as implemented):** verify a HASH of what was written, and heal
  by re-running the staged partial+rename path.
  - New module `src/main/save-verify.ts`: `hashPayload` (sha256 of the
    exact payload string), `verifyLandedFile` (hashes the landed file;
    a missing/unreadable landing is a mismatch, not a throw),
    `stagePayloadAndRename` (write staging → rename — the only
    sanctioned heal; never an in-place write on the live file).
  - `saveLibraryImpl` hashes the payload once at staging, verifies the
    landed hash after the rename, and on mismatch re-runs
    `stagePayloadAndRename` with the same pre-stamp ordering for
    `lastSelfWriteMtimeMs` as the main write.
  - Tests: `src/main/__tests__/save-verify.test.ts` — known sha256
    vectors; same-track-count/wrong-content landing FAILS verification;
    missing landing is a mismatch; the heal changes the file's inode
    (proves rename, not in-place write) and leaves no staging litter.
- **Size:** S. **Risk:** low.
