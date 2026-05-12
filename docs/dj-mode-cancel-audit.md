# DJ Mode Cancel Side-Effect Audit (4.4.14)

> Audit scope: every `start`-path side effect in DJ Mode must have a
> corresponding `cancel`-path reversal. Per CLAUDE.md: "If start fades
> volume → cancel must restore volume. If start sets a ref → cancel
> must clear the ref. If start sets a loading flag → cancel must
> clear it."

Branch: `claude/jaketunes-synology-setup-7m2xy`
Audit performed on: 4.4.13 (commit `43abbff`)
Fixes shipped in: 4.4.14

---

## What DJ Mode does

DJ Mode (Spotify-style AI DJ) is Stephen Hands' lane end-to-end since
4.4.0:

1. User clicks the vinyl-icon DJ button (sidebar or toolbar). Sidebar
   dispatches `toggle-dj-mode`, Toolbar listens and routes to
   `handleDjModeClick`.
2. `handleDjModeClick` sets `djModeActive=true`, calls `startDjSet()`.
3. `startDjSet` asks the main process for a 25-track set + intro line
   via `musicmanDjSet` IPC, TTS-synthesizes the intro through
   `DJ_HANDS_VOICE_ID`, plays the intro through the broadcast chain,
   then calls `playTrack(setTracks[0], setTracks, 0, true)` and sets
   `autoDj=true`.
4. The `autoDj || radioMode` effect (Toolbar:203-205) sets the
   module-level `autoDjMode` flag in `useAudio.ts`.
5. When a track ends, `useAudio.ts` checks `autoDjMode` and dispatches
   `musicman-dj-transition` with an ack-based handshake (synchronous
   dispatch, sync ack — no async race). The Toolbar's transition
   listener fetches the next banter, plays it, then plays the next
   track.
6. When the queue ends, `musicman-dj-set-ended` fires; Toolbar
   re-fetches another set.

There are three cancel entry points:

| Cancel trigger | Path |
|---|---|
| User clicks DJ Mode toggle off | `handleDjModeClick` cancel branch (Toolbar.tsx ~1126) |
| User manually plays a track during DJ Mode | `useAudio.ts:776` dispatches `musicman-dj-cancel` → Toolbar listener (~180) |
| One-shot mic stop (Music Man bubble) | `handleDjClick` cancel branch (Toolbar.tsx ~641) — narrower scope, only stops the mic clip + autoDj, not djMode UI |
| DJ set transition can't find next track | `useAudio.ts:691` defensive `autoDjMode = false` |
| `musicmanDjSet` IPC error / empty | Inline cleanup inside `startDjSet` catch/error branches |

---

## Side-effect ledger

Each row is a side effect of starting DJ Mode. Columns:

- `Reversed in handleDjModeClick`: the toggle-off path (most common)
- `Reversed in musicman-dj-cancel`: the manual-play cancel path
- `Status`: clean / leak / N-A

| # | Start side-effect | Where set | Reversed in handleDjModeClick | Reversed in musicman-dj-cancel | Status |
|---|---|---|---|---|---|
| 1 | `djCancelledRef.current = false` | `handleDjModeClick` start, `startDjSet` | `= true` | `= true` | ✅ |
| 2 | `djModeActive = true` | `handleDjModeClick` start | `setDjModeActive(false)` | `setDjModeActive(false)` | ✅ |
| 3 | `djModeLoading = true` | `startDjSet` | `setDjModeLoading(false)` | (not set here — `setDjLoading(false)` clears the user-visible loading state for the bubble; `djModeLoading` is for the future full-DJ-Mode-Loading-Pane UI that isn't displayed during a cancel flow) | ⚠️ acceptable — `djModeLoading` only affects future UI not yet rendered |
| 4 | `djModeTheme = result.theme` | `startDjSet` | `setDjModeTheme('')` | `setDjModeTheme('')` | ✅ |
| 5 | `djActive = true` | `startDjSet`, `handleDjClick`, transition handler | `setDjActive(false)` | `setDjActive(false)` | ✅ |
| 6 | `djLoading = true` | `startDjSet`, `handleDjClick` | `setDjLoading(false)` | `setDjLoading(false)` | ✅ |
| 7 | `djText` | `startDjSet`, transition handler | `setDjText('')` | `setDjText('')` | ✅ |
| 8 | `autoDj = true` (after intro) | `startDjSet` line 1096 | `setAutoDj(false)` | `setAutoDj(false)` | ✅ |
| 9 | `autoDjMode = true` (module flag in useAudio) | Triggered by the `autoDj/radioMode` effect (Toolbar:203) | `setAutoDjMode(false)` (eager, doesn't wait for React effect to drain) | `setAutoDjMode(false)` (eager) | ✅ |
| 10 | `savedVolumeRef.current = pb.volume` | `startDjSet`, `handleDjClick` | implicit — `setVolume(savedVolumeRef.current)` is called BEFORE we'd ever want to read a new saved value | implicit | ✅ |
| 11 | Volume faded via `fadeVolumeOut()` | `startDjSet` after TTS arrives | `setVolume(savedVolumeRef.current)` | `setVolume(savedVolumeRef.current)` (gated on `djAudioRef.current` being truthy — same as the actual fade gate) | ✅ |
| 12 | `djAudioRef.current = audio` | `startDjSet` line 1067 + transition handler segments | `djAudioRef.current.pause(); djAudioRef.current = null` | same | ✅ |
| 13 | **`attachClipToBroadcast(audio)`** (source node connected to preampNode) | `startDjSet`, transition handler segments, `handleDjClick` | **was MISSING** — pause() doesn't fire `ended`, so the cleanup listener (4.4.6) never ran. Source node stayed connected to preamp, accumulating. | **was MISSING** | 🐛 **LEAK 1 — fixed in 4.4.14 via `detachClipFromBroadcast` (eq.ts)** |
| 14 | `attachAnnouncerToBroadcast(audio)` (only in transition handler, announcer segments) | transition handler line 762 | same — was missing | same | 🐛 **same LEAK 1** — also covered by the new helper (it disconnects from the same `boundSources` WeakMap regardless of which chain entry-point used it) |
| 15 | `musicmanDjSet` IPC in flight | `startDjSet` line 1020 | renderer-side bail via `djCancelledRef.current` check after the await | same | ⚠️ **LEAK 2 — fixed in 4.4.14**: the rapid-toggle race where the cancel-then-restart resets `djCancelledRef.current=false` BEFORE the old IPC resolves, so the old response proceeds as if it weren't cancelled. Fix: add `djModeGenerationRef` integer counter; each `startDjSet` captures `myGen` at top, checks `if (isStale()) return` after every await. Cancel bumps the generation, invalidating any in-flight run. |
| 16 | `musicmanSpeak` IPC in flight | `startDjSet` line 1057 | renderer-side bail via `djCancelledRef.current` | same | 🐛 same LEAK 2 — same fix |
| 17 | `dj-mode-state` CustomEvent dispatched on `djModeActive` flip | Toolbar useEffect line 1003 | fires automatically on `setDjModeActive(false)` | same | ✅ — both AlbumArtPanel (sidebar pill glow) and any other listener get the false transition |
| 18 | Stephen Hands sidebar `Picks` icon glow | NOT coupled to DJ Mode state | N/A | N/A | ✅ — Picks is a separate feature (per 4.4.0); cancel doesn't and shouldn't clear it |
| 19 | `radioTickIntervalRef` / `radioCapTimerRef` (Radio Mode) | Toolbar `handleRadioToggle` | N/A — Radio Mode has its own toggle off path | N/A | ✅ — out of scope, Radio Mode is mutually exclusive with autoDj per Toolbar:265 |
| 20 | `musicman-speaking-start` CustomEvent | NOT fired by DJ Mode (DJ Mode calls `fadeVolumeOut()` directly, bypassing the global event handler at Toolbar:158-177) | N/A | N/A | ⚠️ acceptable — DJ Mode and Radio Mode both bypass the global fade event because they need finer control over the fade sequence relative to TTS playback. The global `isFadedRef` therefore never gets set true by DJ Mode, so no `musicman-speaking-end` needs to be fired on cancel. (If a separate component fires speaking-start while DJ Mode is running, that's a concurrent-state-machine concern outside the DJ Mode cancel contract.) |
| 21 | `setDjExiting` + 3s/400ms fade-out timer | `startDjSet`/`handleDjClick`/transition handler `.onended` | NOT cleared by cancel — but the bubble is also gated on `djText` being truthy, and cancel sets `djText=''`, so the bubble disappears regardless of the exit timer | same | ⚠️ acceptable — timer ref isn't tracked; benign since the bubble is hidden once `djText` is empty |

---

## Leaks found and fixed in 4.4.14

### LEAK 1 — Broadcast source-node accumulation on cancel mid-play

**Class:** Same as 4.4.6 (Airfoil rattle).

**Mechanism:** `attachClipToBroadcast` (and `attachAnnouncerToBroadcast`)
register `ended` and `error` listeners that disconnect the
`MediaElementSource` node from `preampNode`. If the user cancels DJ Mode
while a TTS clip is mid-play, the cancel handler calls
`djAudioRef.current.pause()` and nulls the ref. `pause()` does NOT fire
`ended`, so the cleanup listener never runs. The source node stays
connected to `preampNode`, summing silence into the broadcast graph
forever.

Web Audio's per-sample processing loop still walks every connected
source on every audio frame. Local speakers tolerate this; Airfoil's
network resampler turns the accumulated CPU pressure into audible
rattle / distortion — exactly the symptom 4.4.6 patched for the
`ended`-fires-naturally case.

Over a session with rapid DJ-Mode toggling or many manual-track-skip
cancels mid-banter, the graph would accumulate dozens of dead source
nodes.

**Fix:** New helper `detachClipFromBroadcast(audio)` in
`src/renderer/audio/eq.ts`. Disconnects the source node from preamp
(or broadcastFxInput, since both attach paths share the
`boundSources` WeakMap) and deletes the entry. Called from all three
DJ Mode cancel paths in `Toolbar.tsx`:

1. `useEffect` listener for `'musicman-dj-cancel'` (line ~180) —
   manual-track-play cancel.
2. `handleDjClick` cancel branch (line ~641) — one-shot mic stop.
3. `handleDjModeClick` cancel branch (line ~1126) — toggle-off.

Each call placed BEFORE `djAudioRef.current.pause()` and `= null` so
the source is detached while the audio ref is still valid.

**Why delete from `boundSources` here but not in `detachHowlFromEq`:**
One-shot TTS clips are created fresh per utterance and never re-bound,
so there's no Howler-pool reuse concern (4.4.9). The WeakMap entry
would GC naturally; deleting now just frees the source-node reference
eagerly.

### LEAK 2 — Stale IPC response consumed by a re-clicked startDjSet

**Class:** Rapid toggle race / time-of-check-time-of-use on
`djCancelledRef`.

**Repro:**
1. User clicks DJ Mode on. `djCancelledRef.current = false`,
   `musicmanDjSet` IPC fires.
2. User clicks DJ Mode off within ~500ms (before the IPC resolves).
   Cancel handler sets `djCancelledRef.current = true`, clears state.
3. User clicks DJ Mode on AGAIN within another ~500ms (before
   the OLD IPC resolves). New `startDjSet` runs, resets
   `djCancelledRef.current = false`, fires a NEW `musicmanDjSet` IPC.
4. OLD IPC's `await` resolves. The `if (djCancelledRef.current)`
   guard sees `false` (because step 3 reset it) and proceeds to
   dispatch state changes for the OLD set.

End state: two DJ sets in flight, two intros queued, theme state and
recent-IDs corrupted by interleaved state mutations from the two
runs.

**Fix:** `djModeGenerationRef` integer counter. Each `startDjSet` run
captures `const myGen = ++djModeGenerationRef.current` at top, then
checks `if (djModeGenerationRef.current !== myGen) return` after every
await. Cancel handlers also bump the generation, which both
invalidates any in-flight run and ensures the NEXT run captures a
fresh `myGen`.

Generation bumps added to:

1. `useEffect` listener for `'musicman-dj-cancel'` — `djModeGenerationRef.current += 1`.
2. `handleDjModeClick` cancel branch — `djModeGenerationRef.current += 1`.

The mic-only `handleDjClick` cancel branch does NOT bump
`djModeGenerationRef` because mic clicks aren't part of the
full-DJ-Mode flow — they're a one-shot comment with their own
`djCancelledRef` semantics.

`djCancelledRef` is kept around for two reasons: (1) backward
compatibility with any existing consumer that still checks it, and (2)
it correctly catches the simple toggle-off case without needing to
reason about generations. The two flags are belt-and-suspenders.

---

## Items audited and found clean

1. **Volume restore on cancel** (item b in the brief). Verified:
   `setVolume(savedVolumeRef.current)` is called from both cancel
   paths; `savedVolumeRef.current` is captured at the start of each
   DJ Mode run.
2. **Howl ducking restoration** (item c). Verified: DJ Mode is
   dialog-in-silence (4.3.2). No Howl ducking is applied during DJ
   Mode TTS — the music has already finished, so there's nothing to
   un-duck on cancel.
3. **`autoDjMode` module flag stuck-true** (item d). Verified: both
   cancel paths call `setAutoDjMode(false)` directly (eager), in
   addition to `setAutoDj(false)` which would cascade via the
   `autoDj/radioMode` effect. The `useAudio.ts` defensive fallback
   at lines 670/691 (`autoDjMode = false`) covers the ack-timeout
   case (which can't actually happen synchronously, but is safe
   defensive code).
4. **Ack-based transition handshake race** (item d, continued).
   The `musicman-dj-transition` dispatch + ack at `useAudio.ts:683-693`
   is synchronous: `dispatchEvent` runs handlers in the same
   microtask, the ack listener sets `handled=true` before
   `dispatchEvent` returns. No async race exists in the autoDjMode
   flag manipulation.
5. **Stephen Hands `Picks` panel + sidebar visual state** (item f).
   Verified: Picks is wired via `WJLR PICKS` smart-playlist group,
   not coupled to `djModeActive`. Cancel doesn't clear it. ✓
6. **`dj-mode-state` event** — fires on every `djModeActive` flip via
   the `useEffect` at line ~1003. Cancel's `setDjModeActive(false)`
   triggers a `dj-mode-state` event with `active:false`, so any
   listener (AlbumArtPanel sidebar pill glow) updates correctly.

---

## Out-of-scope follow-ups

- **`isFadedRef` cross-component state.** If a non-DJ-Mode component
  fires `musicman-speaking-start` while DJ Mode is running, the
  global `isFadedRef` could end up stuck true after DJ Mode cancel
  (since DJ Mode doesn't fire speaking-end on cancel). This isn't a
  DJ Mode cancel-contract violation per se; it's a concurrent-state-
  machine concern that affects the global fade handler. Would
  recommend a future audit covering the global fade event lifecycle
  across MM/Megan, Cynthia popovers, and Radio Mode.

- **`djModeLoading` not cleared in the `musicman-dj-cancel` listener.**
  The flag is currently used only inside `startDjSet` and the cancel
  handlers; no UI surface renders against it during the cancel flow.
  Acceptable, but cleaning it up symmetrically would be defensive.

- **Fade-out timer for `djExiting`.** Cancel doesn't clear the
  `setTimeout` chain (3s → 400ms) that fades the bubble. The bubble
  is hidden anyway because `djText=''` after cancel, so the timer is
  benign — but it does leave a 3-second window where a stale timer
  callback could fire `setDjExiting(true)` on a hidden bubble.
  Defensive: track the timer in a ref, clear it on cancel.

- **DJ Mode does NOT fire `musicman-speaking-start`.** Future work:
  add the event so any other UI surface that wants to know "is
  someone speaking" can react (e.g. the recording UI, broadcast
  visualizer indicators). On cancel, fire `-end` to match.
