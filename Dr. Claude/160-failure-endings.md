# Brief 160 — Give desktop failure paths an ending

**Repo:** JakeTunesV3 · **Patch:** `patches/brief-160-failure-endings.patch` · **Branch:** `fix/brief-160-failure-endings` (base: main `12bb43b`)

## Do-Not-Touch mandate (required note)

`src/renderer/hooks/useAudio.ts` is on CLAUDE.md's Do-Not-Touch
list. It is changed here **only because Brief 160 explicitly
mandates it**: the brief's entire content is fixing this file's
failure paths — the log-only `onplayerror`/`onloaderror` handlers,
the silent stuck-`play()` give-up, and the disabled stuck-audio
watchdog all live in useAudio.ts and nowhere else. There is no way
to give those detectors endings without editing this file. The
patch is surgical: it adds endings to the existing detectors and
reuses the existing advance counters/cooldown idioms; it builds no
new detection machinery, per the brief.

## Problem (audit Lens 1, finding 1)

A failed or frozen track was detected, logged, and left silent
forever: `onplayerror`/`onloaderror` only logged; the stuck-`play()`
retry gave up silently (`howl.play.gaveup`); the stuck-audio
watchdog was disabled in code ("4.2.12: stuck-audio watchdog
DISABLED") and the 2 s heartbeat deliberately took no action on a
frozen position (`heartbeat.observed-stuck-no-action`).

## What the patch does

All in `src/renderer/hooks/useAudio.ts`, plus the toast surface:

1. **Failure advance.** A new `failAdvanceRef` ending, bound beside
   the natural-end binding: a load/play error on the CURRENT track
   advances to the next track through the same seam resolution
   natural-end uses (`resolveSeamAdvance` — live queue, track
   located by id). Wired into:
   - the main Howl's `onplayerror` and `onloaderror` (guarded by a
     per-Howl latch so Howler firing both produces ONE ending, and
     by `sharedHowl === howl` so a stale Howl can't advance), and
   - the stuck-`play()` retry's give-up branch.
   Prefetch/gapless-preload Howls keep their swallow handlers —
   they are not the current item.
2. **Bounded.** Advances count against a module-level consecutive-
   failure budget (`MAX_CONSECUTIVE_FAILURE_ADVANCES = 3`, reset by
   any successful `onplay`). At the cap, playback STOPs with a
   toast instead of skipping through the library. End-of-queue and
   repeat-one follow the seam's own answers; a failure with nowhere
   to go also STOPs with a toast.
3. **Freeze ending.** In the heartbeat, a confirmed freeze
   (position identical across ticks while `howl.playing()` is true,
   `stuckTicks >= 2` — the existing detector) earns exactly ONE
   Howl destroy/recreate via the existing `playTrackRef`, behind
   the watchdog's EXISTING 30 s cooldown
   (`WATCHDOG_COOLDOWN_MS` / `watchdogLastRecoveryMs` /
   `watchdogRecoveryInFlight` — the state vars that were kept alive
   for this). The recreated Howl seeks back to the frozen position
   on its first `play` event. This is deliberately narrower than
   the 4.5-removed hard-recover: no `node.play()` kick, no seek
   games on the dead element, at most one recreation per cooldown.
4. **Toast.** Both endings surface through the app's existing
   toast mechanism: the `recentlyAdded` store + `BandcampImportToast`
   component (the renderer's one transient-message surface). The
   patch adds a `{ kind: 'notice' }` toast kind + a `notifyToast()`
   export to `src/renderer/state/recentlyAdded.ts` and teaches the
   toast component to render it. Files touched for this:
   `src/renderer/state/recentlyAdded.ts`,
   `src/renderer/components/BandcampImportToast.tsx`.

Known limitation (accepted): in DJ mode a failure advance goes
straight to the next track without the DJ transition event —
continuity of music beats commentary sync on a failure path.

Cross-reference: Brief 161's body-timeout (chain B, main process)
surfaces as a load error here — a wedged homemini stream now errors
the body, Howler reports a load error, and this brief's advance is
the ending it lands in.

## Tests

No renderer test tree exists in this repo (`npm test` covers
`src/main/__tests__`); verification here is: the patch applies
cleanly in chain order, the resulting useAudio.ts parses
(`node --check`), and brace balance is exact. Behavioural proof is
the smoke test in CLAUDE.md plus the audio log events the patch
emits (`howl.failadvance`, `howl.failadvance.stop`,
`heartbeat.stuck-recover`). CI (`npm run check`) is the gate —
merge only on green CI.
