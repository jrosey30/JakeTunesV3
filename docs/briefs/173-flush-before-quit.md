# Brief 173 — Flush sidecars before the quit completes (JakeTunesV3)

- **Problem:** `JsonFileCache.update()` resolves after the in-memory
  mutation; the disk flush is backgrounded, a flush failure is logged
  with the write dropped, and on quit the flush of all five caches is
  a fire-and-forget `void Promise.all([...])` racing a 180 ms
  audio-fade deferral. Quit or crash inside that window loses the
  final seconds of override/star/profile edits.
- **Evidence:** desktop audit Lens 2, finding 10 —
  `src/main/state-cache.ts:148-187`; `src/main/index.ts:11395-11408`
  (at 12bb43b).
- **Fix (as implemented, two halves):**
  1. **PR half (standalone, off main):** `src/main/state-cache.ts` —
     flush failures and safety-lock dropped writes are counted and
     the last error recorded (`flushStats()`); `whenIdle()` gives the
     quit path an awaitable settle; module-level `flushAllCaches(
     caches, timeoutMs)` awaits all caches' flushes bounded by the
     timeout and reports `{ timedOut, failures, dropped }` without
     ever rejecting. `update()` semantics otherwise unchanged.
     Tests added to `src/main/__tests__/state-cache.test.ts`.
  2. **Chain half (patch, stacked on Brief 169; REQUIRES the PR
     half's `flushAllCaches` API — merge/cherry-pick the PR branch
     first):** the `before-quit` handler `preventDefault()`s the
     first quit until `flushAllCaches([...five caches], 2000)`
     settles, preserving the 180 ms audio-fade deferral in parallel;
     a timeout or failure/drop counts are logged; then `app.quit()`
     re-enters and proceeds via the re-entry guard.
- **Size:** S. **Risk:** low.
