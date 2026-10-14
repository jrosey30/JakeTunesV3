# Brief 176 — Trainer failures get loud

## Source / evidence
- Proposed briefs 160+, Brief 176 (desktop audit Lens 3, finding F1; steps audit §2 item A).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`:
  - `scripts/brain-trainer.mjs` wrote `brain-status.json` only from `writeStatus()`,
    reached on handled paths (the `fatal()` helper, redescribe-all, the
    fully-enriched no-op, and the success tail of `main()`).
  - The top-level runner was `main().catch(e => { log('FATAL', e.message); process.exit(1) })`
    — a crash mid-run wrote **no** status, so last night's `ok:true` survived.
  - Five in-`main()` verify-failure sites did `process.exit(1)` directly after
    restoring the backup — also no status write.
  - The stall path (0 descriptors produced) notified but wrote no status.
  - `notifyFailure()` was osascript-only. The ntfy push existed only inside
    the async `notify()` used on success/stall paths (topic file
    `~/.config/jaketunes/ntfy-topic`).

## What changes
- **NEW `scripts/brain-status.mjs`** — the one module that owns
  `brain-status.json`: `makeStatus` / `writeBrainStatus` (best-effort per
  path) / `readBrainStatus` / `statusAgeMs` / `isStale` (`STALE_AFTER_MS`
  = 26 h). The trainer's `writeStatus()` now delegates to it (same dual
  write: STATE_DIR copy + local app-support fallback).
- **`scripts/brain-trainer.mjs`**
  - Every exit path writes a status: the five verify-failure sites now
    `throw` after restoring the backup (instead of `process.exit(1)`), the
    stall path writes `{ ok:false, stalled:true, error }`, and the top-level
    catch writes `{ ok:false, error:"crash: …" }` and alerts before exiting 1.
    `fatal()` is unchanged in shape (it already wrote status) — see below.
  - `notifyFailure()` additionally pushes via the **existing** ntfy channel
    (same topic file/config as `notify()`), synchronously via `curl` so the
    push lands before `process.exit` — an async fetch would be cut off.
- **NEW `scripts/brain-watchdog.mjs`** — reads the status file
  (`--status-path`, else `$JT_STATE_DIR/brain-status.json`, else the local
  fallback copy). Fresh (< ~26 h, `--max-age-hours` to override) → exit 0,
  silent. Missing / unparseable / stale → console error + local notification
  + ntfy push on the same topic + exit 1. `BRAIN_WATCHDOG_NO_NOTIFY=1`
  suppresses pushes for fixture runs. Its launchd template ships in
  Brief 183's manifest (`com.jaketunes.brain-watchdog`, hourly).
- **NEW `scripts/__tests__/brain-status.test.mjs`** — node:test suite for
  the status module.

## What does NOT change
- No training logic, batching, prompts, embedding, or verify semantics.
  Verify-failure sites restore the backup exactly as before; only the exit
  mechanism changed (throw → the one top-level handler).
- The status file's shape is unchanged (`{ ok, at, host, ...counts, error? }`).
- `notify()` (success/stall) is untouched, including its `BRAIN_QUIET`
  behaviour; failures ignore `BRAIN_QUIET`, as `notifyFailure` always did.
- No version bump. No launchd installed by this PR (see Manual steps).

## Done looks like
- A crashed trainer leaves `brain-status.json` reading `ok:false` with the
  crash reason — never a surviving stale `ok:true`.
- A failed run pushes an ntfy alert in addition to the macOS notification.
- The watchdog exits 1 and pushes when the status is missing/stale, and is
  silent (exit 0) when fresh.

## Tests (run in the agent environment, Node v24.20.0)
- `node --check` on `brain-status.mjs`, `brain-watchdog.mjs`,
  `brain-trainer.mjs` — clean.
- `node --test scripts/__tests__/brain-status.test.mjs` — **4/4 pass**
  (write/read round-trip, best-effort multi-path write, null on
  missing/unparseable/shapeless, age + 26 h staleness edges).
- Watchdog fixture runs (status fixtures in /tmp, `BRAIN_WATCHDOG_NO_NOTIFY=1`):
  fresh (2 h old) → exit 0, silent; stale (30 h) → exit 1 with reason;
  unparseable → exit 1; missing → exit 1.
- Trainer fixture runs with `JT_STATE_DIR` pointed at /tmp fixtures and a
  fake `HOME`:
  - No `OPENAI_API_KEY` → `fatal()` path: exit 1, `ok:false` status written
    to BOTH the state-dir and local-fallback paths.
  - Corrupt `library.json` (crash inside `main()`) → exit 1, status
    `ok:false, error:"crash: Expected property name or '}' in JSON…"` where
    previously NO status was written at all.

## Manual steps (verbatim)
1. On homemini: after this PR merges, the trainer picks up the new status
   behaviour on its next nightly run — no action needed for the trainer
   itself.
2. Install the watchdog's LaunchAgent from Brief 183's installer
   (`scripts/launchd/install-launchagents.sh` — dry-run first, then
   `--apply`) once Brief 183 lands; until then the watchdog can be run by
   hand: `node scripts/brain-watchdog.mjs`.
3. Confirm `~/.config/jaketunes/ntfy-topic` exists on homemini (the same
   file the success-path pushes already use) so failure pushes reach the
   phone.
