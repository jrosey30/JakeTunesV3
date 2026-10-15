# Brief 162 (useAudio hunk) — Resume a restored track by building its Howl

**Repo:** JakeTunesV3 · **Patch:** `patches/brief-162-useaudio-resume.patch` (renderer chain, position #2) · **Branch:** `fix/brief-162-useaudio-resume` (stacked on `fix/brief-160-failure-endings` — see README)

## Do-Not-Touch mandate (required note)

`src/renderer/hooks/useAudio.ts` is on CLAUDE.md's Do-Not-Touch
list. This hunk changes it **only because Brief 162 explicitly
mandates the behaviour it implements**: Brief 162 restores playback
state (queue, index, position, volume) into a PAUSED state on
launch, "ready to play". A restored track exists in
PlaybackContext state but has no Howl — the audio engine builds
Howls only in `playTrack`/`loadAndPlay`. Without this hunk, the
transport's play button dispatches RESUME against a null
`sharedHowl` and the "ready to play" state plays nothing. The
state-side half of Brief 162 (persistence + restore) ships as the
real PR for `feat/brief-162-persist-playback-state`
(PlaybackContext.tsx + playback-persistence.ts); this hunk is a
patch only because useAudio.ts (100,560 B) exceeds the connector
push cap.

## What the patch does

One branch in `togglePlayPause`'s resume path (+15 lines): when
resuming with a `nowPlaying` track but NO `sharedHowl` (the
restored-session signature), call the existing `playTrackRef` with
the restored track/queue/index — building the Howl through the
normal path — and seek to the restored position on the new Howl's
first `play` event (if > 1 s). The ordinary resume path (Howl
exists) is untouched, byte for byte.

## Tests

No renderer test tree exists; the patch applies in chain order and
the file parses (`node --check`). Live check: play a track, note
queue + position, quit, relaunch — state restores paused; press
play — the same track starts at (approximately) the restored
position. CI (`npm run check`) is the gate — merge only on green
CI.
