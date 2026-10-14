# Brief 162 — Persist desktop playback state, restore paused

**Repo:** JakeTunesV3 · **Branch:** `feat/brief-162-persist-playback-state` · **Base:** main `12bb43b`

## Do-Not-Touch mandate (required note)

`src/renderer/context/PlaybackContext.tsx` is on CLAUDE.md's
Do-Not-Touch list. It is changed here **only because Brief 162
explicitly mandates it**: the brief's whole content is "persist
queue track IDs, index, position, and volume; on launch, restore
into a PAUSED state" — the queue/index/position/volume live in
PlaybackContext's reducer state and nowhere else, so the persistence
and the restore dispatch cannot be implemented without touching
this file. The change is additive: one new reducer action
(`RESTORE_PLAYBACK`), one restore effect, and two persist effects.
No existing case, wire, or behaviour is modified.

A companion hunk in `src/renderer/hooks/useAudio.ts` (also
Do-Not-Touch, also mandated — a restored track has state but no
Howl, so the resume path must build one) ships as a patch in the
chain-B handoff package (`brief-162-useaudio-resume.patch`), not in
this PR, because useAudio.ts is 100,560 B and exceeds the connector
push cap.

## Problem (audit Lens 1, finding 3)

Playback state was never persisted. Quit, crash, or a renderer
reload (Brief 163's CrashNet recovery included) destroyed the
queue, position, and volume — the window recovered into silence.

## What this PR does

- **Persist** via the EXISTING ui-state IPC store
  (`load-ui-state` / `save-ui-state`, `src/main/ipc/ui-state-ipc.ts`)
  under a top-level `playbackState` key. Main deep-merges top-level
  keys, so playback saves never clobber layout/column state, and no
  main-side change (and no new IPC channel) was needed. localStorage
  is banned in this renderer and is not used.
  - Saves snapshot queue track IDs, queue index, current track ID,
    position (seconds), and volume (`snapshotPlayback`).
  - Structural changes debounce at 800 ms; a 5 s ticker saves the
    position while playing, so a crash loses only seconds.
  - Nothing is written before the launch restore read has run, so a
    fresh empty state can never overwrite the saved one first.
- **Restore** once, when the library first lands: saved IDs resolve
  against live tracks (`resolveRestoredQueue` — missing IDs drop
  out, the index follows the playing track, the position clamps to
  inside the track), then `RESTORE_PLAYBACK` installs queue, track,
  position, and volume **paused** (`isPlaying: false`). No
  auto-audio on launch, ever. If the user already started a track
  this run, the reducer refuses to stomp it.
- The shape/parse/resolve logic lives in a new pure module,
  `src/renderer/playback-persistence.ts`, unit-tested in
  `src/main/__tests__/playback-persistence.test.ts` (the repo's
  node --test tree, same as queue-seam's tests).

## Resume behaviour

Pressing play on a restored track builds its Howl at the restored
position — that half is the useAudio.ts patch in the chain-B
handoff (see the mandate note above). This PR's state side is
complete without it; the patch is what makes the play button reach
the restored track instead of dispatching RESUME into a null Howl.

## Tests

Worker-verified locally: the new suite passes 9/9 under
`node --test --experimental-strip-types` (snapshot shape, garbage →
no restore, junk-ID filtering, volume clamp, drop-out index
following, position clamping, empty resolution). The PlaybackContext
edits are parse-checked; the full `npm run check` gate runs in CI.

CI status is not readable from the agent environment (GitHub App
403 on checks) — PR-ready only; do not merge until CI is verified
green.
