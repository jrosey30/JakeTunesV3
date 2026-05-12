# JakeTunes Changelog — 4.0.5 through 4.4.16

> **Purpose**: bring any contributor (or another Claude session) up to speed on everything that's shipped since 4.0.5. Grouped by minor version with a header summarizing the *theme* of each line, then each patch with a one-paragraph "what & why."
>
> Reading order: 4.0.x (foundation hardening) → 4.1.x (playback resilience + Radio Mode v1) → 4.2.x (Radio Mode v2 — cast, mid-track-crash hunt, picks expansion, recording) → 4.3.x (external APIs + memory + station ID production) → 4.4.x (show bible, caller rolodex, hour clock, polish & regressions).

---

## 4.0 line — foundation hardening

The 4.0 series was about getting playback / sync / metadata bulletproof before any "fun" features. The first half is sync-engine fixes, the second half is the playback-pipeline instrumentation work that exposed and fixed the resource fights between Airfoil, audio analysis, and the renderer.

| Version | Theme | Notes |
|---|---|---|
| **4.0.5** | Sync: dropped the 5-min full-library tag-verification preflight. The preflight blocked sync for 5 minutes scanning files for no reason; removed entirely. |
| **4.0.6** | Airfoil / external-pause auto-recovery: detect when Core Audio renegotiates output device under us and resume playback. |
| **4.0.7** | Queue fixes: shuffle reorders the actual queue, sequential playback, drag-reorder works. |
| **4.0.8** | Audio-analysis retry logic + atomic override writes (no torn JSON on crash). |
| **4.0.9** | Diagnostic ring buffer (`__audioLog()`) on the audio pipeline. Captures the last 50 events for post-mortem of "music stopped playing" issues. |
| **4.0.10** | Playback wins resource fights. Background workers (audio analysis, ALAC prewarm) yield while music is playing. |
| **4.0.11** | Throttle `SET_POSITION` dispatch to 10Hz. Was firing 60Hz, saturating the renderer thread, causing audio decoder to starve during mouse-move/scroll — the "broken record" stutter. |
| **4.0.12** | Reverted the auto-resume on `onpause`. It was creating a feedback loop where buffer-underrun → pause → auto-resume → re-buffer → pause again. Logging stays; auto-resume gone. |

---

## 4.1 line — playback cache + Radio Mode v1

4.1 introduces the play cache (ALAC → AAC pre-transcode so first-play isn't a 3-second hang) and ships the first version of Radio Mode (between-track WJLR-style commentary). Most of the line is bug-bashing around the cache, metadata-write races, and one big new feature ship.

| Version | Theme | Notes |
|---|---|---|
| **4.1.0** | **Playback cache** — three-part rework. ALAC→AAC transcode cache (~10 GB for typical library) so ALAC tracks start instantly. |
| **4.1.1** | Serialize metadata-overrides writes. Concurrent saves were stomping on each other; analysis data was being silently wiped. Single-flight writer. |
| **4.1.2** | Fix position-bar freeze after scrub-ahead. |
| **4.1.3** | Version display sourced from `package.json` (was hardcoded). Visible in Device view. |
| **4.1.4** | macOS Desktop permission crash + EPIPE harden across all `spawn`-and-write sites. Sequoia tightened sandbox permissions; we were crashing on import. |
| **4.1.5** | Stuck-audio watchdog. Airfoil's 10-min device-renegotiation hijack was leaving the Howl in a frozen state — recreate from scratch and resume from last known position. (Later disabled in 4.2.12 — see note.) |
| **4.1.6** | **Radio Mode (WJLR 330.9)**: between-track commentary, two voices (Music Man + Megan as bickering co-hosts), no delay between songs and chat. |
| **4.1.7** | Megan as co-host. Two-voice show; reactive dialog instead of solo monologue. |
| **4.1.8** | Radio Mode defaults to whole-library shuffle; right-click → "Start Artist Radio." |

---

## 4.2 line — Radio Mode v2 + cast expansion + the 29-second crash

The longest, messiest line. Radio Mode v2 (full cast, station IDs, broadcast feel), the multi-week hunt for the 29-second mid-track audio cutoff, the picks system (Music Man Picks → 3 weekly picks), recording → MP3, and the human-talk overhaul.

| Version | Theme | Notes |
|---|---|---|
| **4.2.0** | Visual polish on Radio Mode + DJ Mode vinyl-icon placeholder. |
| **4.2.1** | **Announcer voice** for campy WJLR station IDs. Distinct from MM/Megan. Hide bubble during Radio Mode. |
| **4.2.2** | Show opener (campy ID on Radio toggle on), profanity allowed, broadcast-wave animation, two-button toolbar layout. |
| **4.2.3** | Radio voices stop sounding scripted. Switched to `eleven_turbo_v2_5` model + reactive prompt + style 0.7. |
| **4.2.4** | (Skipped/internal.) |
| **4.2.5** | Switch default host between Music Man and Megan in Preferences → AI. |
| **4.2.6** | Wire the show opener — clicking Radio now plays the WJLR drop FIRST, before the first track. |
| **4.2.7** | Deterministic announcer scheduling. Opener + every 4th transition gets an announcer drop. Replaces the prior "Claude rolls a die" approach. |
| **4.2.8** | Mic mode back in top toolbar. Sidebar's orange button → vinyl DJ Mode. |
| **4.2.9** | 5-sec debounce on audio-analysis worker — librosa was running concurrently with playback, starving the audio decoder. (Worker later disabled entirely in 4.2.12.) |
| **4.2.10** | Megan voice ID swap (`T7eLpgAAhoXHlrNajG8v`) + phonetic announcer drops ("double-yoo... jay..."). |
| **4.2.11** | **29-second mid-track audio cutoff hunt, attempt 1**: replaced `Buffer.alloc` + `fh.read` (whole-file-in-memory) with streaming response via `createReadStream` + `Readable.toWeb` in the `ipod-audio://` protocol handler. Theory was Buffer GC; theory was wrong. |
| **4.2.12** | **29-second crash hunt, attempt 2**: disabled librosa audio-analysis worker AND the stuck-audio watchdog from 4.1.5. Both were suspects. Watchdog had false positives; librosa raced with playback. Both stay off. |
| **4.2.13** | **29-second crash hunt, attempt 3**: `powerSaveBlocker('prevent-app-suspension')` to defeat macOS App Nap. Plus heartbeat diagnostic (every 2s logs full audio state). Plus confident-announcer prompt rewrite (no more "double-yoo..." ellipses). |
| **4.2.14** | Heartbeat becomes an active recovery loop. If position is frozen >4s and Howler thinks it's playing → kick `node.play()`. >8s frozen → hard recover (recreate Howl + seek back). |
| **4.2.15** | **Real Radio Mode banter fix**: `handleRadioToggle` was passing `djTransition=false` to `playTrack`, dispatching `musicman-dj-cancel`, which killed the module-level `autoDjMode` flag *permanently* for the session. Result: opener fired, then no banter between tracks. Fixed by passing `djTransition=true`. |
| **4.2.16** | **Duck music under banter** (real-radio-DJ style). Next track starts ducked at ~15%, banter plays over the top, music fades back up on segment end. *Later revised in 4.3.2 — see below.* |
| **4.2.17** | **Topic rotation**: 18 conversation angles randomly picked per segment (back-announce, lateral pivot, lyric roast, Brooklyn local color, MM historian, …). Plus mandatory opener line: "Here's Megan, and the one, the only, the MUSIC MAN!" |
| **4.2.18** | **Megan Picks** added alongside MM Picks. Both 25 tracks, **weekly Friday-to-Friday rotation** (was daily). New default MM voice ID. |
| **4.2.19** | **Cast expansion**: **Giovanni** (recurring caller — Bay Ridge, earnest, asks music questions) and **DJ Hands** (rare guest, in-house DJ, party-first). Rotation slot map per 12 transitions: slot 0/4 = station ID, 5/11 = Giovanni, 9 = DJ Hands, else = MM+Megan. |
| **4.2.20** | **Record radio show → MP3** (Record button in toolbar, MediaRecorder → ffmpeg → save dialog). **Human-talk overhaul** (kill vanilla / kill Wikipedia recital — hard prompt guardrails). **DJ Hands → party-first** (rewrote `DJ_HANDS_CORE` after his picks came back as a beat-criticism syllabus). |

---

## 4.3 line — external APIs + memory + station ID production

Six external integrations, persistent show memory, broadcast-FX chain for the announcer voice, and the v3 TTS switch.

| Version | Theme | Notes |
|---|---|---|
| **4.3.0** | **Six external API integrations**: OpenWeatherMap (Brooklyn weather), Last.fm (charts + similar artists), Pitchfork/Stereogum/Quietus RSS, Discogs (release detail), Wikidata (artist info), Cover Art Archive. All cached, all fail-soft. **DJ Hands renamed to DJ Stephen Hands.** Harder artist-mix rule (max 1 per artist in picks, never 3+). |
| **4.3.1** | **ElevenLabs v3 TTS** for non-fast paths. Plus inline performance markers ([laughs], [scoffs], [sighs], [whispers], [excited], [interrupts]) in the radio prompt — v3 performs them as actual sound. |
| **4.3.2** | **Real-radio timing fix**: dialog plays in silence at the seam, next song fades up after the last segment. The 4.2.16 ducked-overlap approach was leaving the next song playing 30+ seconds at 15% before banter actually dropped. Also: prefetch window pushed from 30s → 60s remaining. **Persistent show memory** added (`src/main/radio-memory.ts`): last 8 angles + last 8 callback-worthy lines + slot-1 hot take + running-bit state, all in `userData/radio-memory.json`. |
| **4.3.3** | **Station ID production**: broadcast FX chain on the announcer voice (compressor 8:1 / low shelf +4 / presence peak +5 / high shelf +2 / convolver reverb) — sounds like a real FM imaging cut, not synthesized speech. Plus **procedural stingers** (Web Audio): riser, swoosh, drum hit, bell hit, sub drop, whoosh pad. Stinger before announcer voice, drum hit after. |
| **4.3.4** | **No-station-ID bug fix**: v3 TTS was silently failing for the announcer voice; the synth loop dropped the failed segment from the array, opener played MM/Megan but no announcer. Added per-call model fallback chain (`eleven_v3` → `eleven_turbo_v2_5`), hardened announcer FX bind to fall back to plain routing on failure, comprehensive logging across the radio path. |

---

## 4.4 line — the show bible (caller rolodex + hour clock) + recent polish/regressions

A formal "Show Bible" was generated by claude.ai (full structural framework — hour clock, 11 archetypes, 9-person caller rolodex, defer/counter ratios, running bits, energy/dwell tags). 4.4.x is the implementation, in phases.

| Version | Theme | Notes |
|---|---|---|
| **4.4.0** | **Phase 1 — Caller rolodex.** 8 new callers beyond Giovanni: Rajiv (format antagonist, challenges premises), Bernard (elder statesman who was actually there), LaShonte (contemporary corrective), Kristina (metal purist), Devin (wrong-show comic relief), Maya (real-question-asker), Mike (industry insider), Zoe (wildcard take-haver). Each in `src/main/cast.ts` with voice ID, weight, function, background, speech profile, MM/Megan reactions, never-list, voice settings. Scheduler: weighted random + no-repeat-within-3 + Giovanni-only for first 2 caller slots of session. **DJ Mode is now Stephen Hands end-to-end** (set generation, set intro, between-track commentary — all via `DJ_HANDS_CORE` + `DJ_HANDS_VOICE_ID`). **Picks featured section** in sidebar (`WJLR PICKS` group, distinct visual treatment from standard smart playlists). |
| **4.4.1** | **Phase 2 — Hour clock + 11 archetypes.** `src/main/archetypes.ts` defines 11 structural templates (Cold Open Hot Take, Lateral Pivot, Lightning Round, Deferred Punchline, Lineage Bridge, Lyric Roast, Brooklyn Texture, Historian Dwell, Hour Out, Back-Announce, Recovery). Slot-by-slot routing: slot 0 = full ID, 1 = Cold Open Hot Take (captured), 2 = back-announce, 3 = lateral/lineage, 4 = brooklyn/lyric-roast/lightning, 5 = caller, 6 = recovery, 7 = mini station ID (new — short dry mid-hour), 8 = Historian Dwell (slot 8 only — MM monologue), 9 = Stephen guest 1-in-3 hours / Lightning Round otherwise, 10 = recovery, 11 = Hour Out (pulls slot-1 hot take from memory + pays it off). |
| **4.4.2** | **Lock 3 picks personas into distinct lanes.** Music Man = classic rock canon + art rock + heritage jazz + singer-songwriter heritage. Megan = contemporary indie + critic territory + sharp left-field + underrated singer-songwriter. Stephen Hands = dance/disco/boogie/house/techno/hip-hop/electronic. **5-tier library-aware fallback** for Stephen so his picks never come back empty even if the library lacks pure dance music. **Regenerate button** added to picks panels (force fresh pull, bypasses weekly cache). |
| **4.4.3** | **90-minute Radio Mode cap.** Auto-stop after 90 min broadcast time. Visible elapsed/remaining countdown in the ON AIR pill. |
| **4.4.4** | **Caller knowledge boundary.** Hard rule in prompt: callers are listening from home, only know the song that JUST ended. They cannot reference/predict/ask about the upcoming track. MM and Megan can tease what's coming from the studio side; the caller can't. |
| **4.4.5** | **Metadata-override cascade fix.** Get Info edits were wiping each other. Cause: save handler required fingerprint match to merge; after applying edit 1 the in-memory track's fingerprint changed, so edit 2 saw a mismatch and overwrote the whole entry. Now always merges into the existing entry's `fields` object, only the latest fingerprint is updated. |
| **4.4.6** | **Airfoil rattle fix v1.** Long Radio sessions accumulated 80-200+ dead `MediaElementSource` nodes connected to preamp (TTS clips, never explicitly disconnected). Web Audio's per-sample loop still processed them → CPU pressure → Airfoil's network resampler turned that into audible rattle. `attachClipToBroadcast` and `attachAnnouncerToBroadcast` now register `ended`/`error` listeners that disconnect the source immediately on clip end. |
| **4.4.7** | **Songs sidebar freeze fix.** Pure regression from 4.4.5 — copy-paste typo: I used `libState.tracks` in `SongsView` (where the destructured name is `lib`, not `libState`). useCallback dep array threw a ReferenceError every render → infinite loop. Renamed to `lib.tracks`. |
| **4.4.8** | **Airfoil rattle fix v2.** Same disconnect-on-end treatment for music Howls (`detachHowlFromEq` called from useAudio.ts wherever the active Howl is replaced). Plus `window.__resetAudio()` escape hatch — call from dev console to fully rebuild the audio chain if anything ever desyncs. |
| **4.4.9** | **Silent music regression from 4.4.8 fix.** Howler uses an HTMLAudio *pool* — the same element gets reused across tracks. `detachHowlFromEq` disconnected the source on unload but kept the `boundSources` WeakMap entry (you can't re-bind a `MediaElementSource` — throws). Next attach saw the entry and skipped reconnection → source disconnected, element routed to nowhere, music silent. Fixed: if entry exists, just **reconnect** the existing source to preamp instead of trying to re-bind. |
| **4.4.10** | **No more accidental library-wipe from playlist context menu.** Right-click in playlist used to have both "Remove from Playlist" and "Delete Song" — one click apart. Latter wiped from the entire library. Now playlist context menu only has "Remove from Playlist." Library deletion still works from main Songs view (unaffected). |
| **4.4.11** | **Get Info: drag-select no longer clobbered by auto-select-on-navigate.** The 50ms `firstInputRef.current?.select()` timer fired on every prev/next navigation AND on initial mount. If the user mouse-downed in the Name input within that 50ms window and started a drag-select, the timer fired mid-drag, programmatically selected all the text, and destroyed the user's in-progress selection. Now: initial mount still selects-all (iTunes Get Info convention — type to overwrite the title); prev/next navigation focuses the first input without selecting; either way, the auto-select cancels itself if the user mousedowns or focuses any input first (capture phase, fires before the input handler). User reports drag broken on ALL fields, not just Name — if that persists after this fix, a separate cause exists (likely CSS or a Chromium quirk we haven't found). See `docs/phase-a-verification.md` for the full investigation. |
| **4.4.12** | **Embedded album art on import + artwork-index disk-write hardening + sips-failure surfacing.** Five linked changes. (1) `import-track` and `import-tracks` IPC handlers now read `metadata.common.picture[]` from `music-metadata` parse and save the front-cover into the artwork dir alongside the track, mirroring the `set-custom-artwork` conventions (JPG passthrough, `sips` convert for PNG/TIFF/etc., versioned hash for cache-bust). Factored into `extractAndSaveEmbeddedArtwork` helper. Identity-gated: never overwrites an existing index entry. Result passes `{key, hash}` back to renderer; `App.tsx` dispatches `ADD_ARTWORK` in the same React batch as `ADD_IMPORTED_TRACKS` so the cover shows up on the first render alongside the row. (2) `saveArtworkIndex` now writes to a unique tmp filename and atomic-renames, so a mid-write crash can't leave a torn JSON. (3) `saveArtworkIndex` calls are serialized via a single-flight Promise chain (`artworkWriteChain`) — same pattern as the metadata-overrides fix in 4.1.1. Concurrent IPC calls during a heavy import batch can no longer interleave and lose entries. (4) When `set-custom-artwork` returns `ok:false` (typically `sips` failing on a corrupt/unsupported image), all 6 view-level `handleSetCustomArt` handlers + `AlbumArtPanel` + the inline "Add Artwork…" context-menu actions now call `setNotice(...)` from the activity store. `NowPlaying.tsx` renders the notice as a 4th LCD-pill mode (in addition to playing / rip / sync) with auto-clear after 4 sec. Previously the renderer silently skipped `ADD_ARTWORK` but the user already saw the Get Info preview from `localArtHash` and assumed it stuck. (5) One-shot embedded-art backfill on app launch: new `backfill-embedded-artwork` IPC walks every track in the library, parses each file, extracts embedded art for albums missing artwork, yields between tracks (`setImmediate`, 4.0.10 pattern), and writes a marker file at `userData/artwork-backfill-done` so it only runs once. Progress events stream to the renderer every 25 tracks. See `docs/phase-a-verification.md`. |
| **4.4.13** | **Per-view scroll position persistence within the session.** Bug report: scroll halfway down Songs → switch to Artists → switch back to Songs → list jumps back to the top. Root cause: `MainContent.tsx` switches views via a switch/case that returns one component at a time, so `SongsView` (and every other view) fully unmounts when you navigate away. `useVirtualScroll`'s internal `scrollTop` `useState` resets to 0 on the remount, and the freshly created container div has `scrollTop: 0`. Nothing was preserving the position. Fix: new `src/renderer/hooks/useScrollPersistence.ts` — a `useLayoutEffect`-based hook backed by a module-level `Map<string, number>` keyed by view (e.g. `'songs'`, `'albums'`, `'playlist:<id>'`, `'smart-playlist:<id>'`). On mount, the hook reads the saved `scrollTop` and writes it onto the container ref **before** the browser paints (so the user never sees the scrollTop=0 flash); a passive `addEventListener('scroll')` keeps the cache fresh on every scroll, including programmatic writes from `scrollToIdx`/auto-follow. The key is reactive — switching playlist A→B inside `PlaylistView` triggers a fresh restore from B's cached value, so each playlist remembers its own position independently. Wired into all 6 library views (`SongsView`, `PlaylistView`, `SmartPlaylistView`, `ArtistsView`, `AlbumsView`, `GenresView`). Cross-launch persistence (writing to disk and restoring on app start) is **out of scope** — that's Phase C; this fix is in-session only, which is what 90% of the bug feels like. Known limitation: `GenresView.tsx`'s root uses flex layout — the inner column lists and tracklist scroll internally, not the root — so the hook is a no-op on Genres in the current layout. The hook is wired anyway for symmetry; a follow-up can persist the inner scroll containers if the user reports it. Out of scope: the `auto-follow-on-sorted-change` suspect in `SongsView.tsx:408-416` — the existing 5-second idle gate appears to handle it; revisit if "scroll resets unexpectedly when idle" is reported. |
| **4.4.14** | **DJ Mode cancel side-effect audit + two leak fixes.** Per the CLAUDE.md footgun "Every cancel/undo/stop path must reverse all side effects of the corresponding start path", audited the three DJ Mode cancel paths in `Toolbar.tsx` against the start path. Full ledger at `docs/dj-mode-cancel-audit.md`. Two leaks fixed: **(LEAK 1, Airfoil-rattle class)** `attachClipToBroadcast` / `attachAnnouncerToBroadcast` register `ended`/`error` listeners that disconnect the `MediaElementSource` from `preampNode` on natural clip end (4.4.6 fix). Cancel paths called `djAudioRef.current.pause()` and nulled the ref, but `pause()` does NOT fire `ended` — so the source node stayed connected and accumulated into the broadcast graph forever. Over a session of rapid DJ-Mode toggling or manual-track-skips mid-banter, dozens of dead source nodes piled up, exactly the same CPU-pressure pattern 4.4.6 fixed for the natural-end case. New helper `detachClipFromBroadcast(audio)` in `src/renderer/audio/eq.ts` disconnects from the broadcast chain (works for both preamp-direct and the announcer-FX chain since both share the `boundSources` WeakMap) and deletes the entry. Called from all three DJ Mode cancel paths before nulling `djAudioRef.current`. **(LEAK 2, rapid-toggle race)** If the user toggled DJ Mode off→on within ~500ms while `musicmanDjSet` or `musicmanSpeak` was in flight, the cancel's `djCancelledRef.current = true` was then reset to `false` by the re-click BEFORE the old IPC resolved. The stale response then proceeded as if it weren't cancelled, dispatching state changes that interleaved with the new run. Fix: added `djModeGenerationRef` integer counter; each `startDjSet` captures `myGen = ++djModeGenerationRef.current` at top and checks `if (djModeGenerationRef.current !== myGen) return` after every await. Cancel handlers bump the counter, invalidating any in-flight run. `djCancelledRef` is kept as belt-and-suspenders for the simple toggle-off case. Items audited and found clean: volume restore, autoDjMode flag clearing (eager + ack handshake is synchronous), Howl ducking (DJ Mode is dialog-in-silence per 4.3.2 so nothing to un-duck), `dj-mode-state` CustomEvent broadcast (fires automatically on `setDjModeActive(false)`), Stephen Hands sidebar Picks panel (not coupled to DJ Mode state). Out-of-scope follow-ups noted in the audit doc: global `isFadedRef` cross-component lifecycle, `djExiting` timer not cleared on cancel, DJ Mode not firing `musicman-speaking-start`/`-end` events. |
| **4.4.15** | **Output-device disconnect UX: banner + auto-reconnect + fallback notice.** User reports "AirPlay always breaks down" and "Airfoil mid-song stutter." 4.0.6 / 4.1.5 / 4.4.6 / 4.4.8 / 4.4.9 patched the audio-graph side (source-node disconnects, Howler pool reuse, broadcast-FX bind fallback). What was missing was user-visible feedback when the active AirPlay/Bluetooth/external device drops mid-playback — JakeTunes kept playing into the void with no indication anything was wrong. This adds three layers, all reusing the activity-store `setNotice` + LCD-pill mode 4 from 4.4.12: **(a) Poll-based disconnect detection.** While `pb.isPlaying && isExternalOutput && !airplayOpen`, `Toolbar.tsx` polls `list-audio-devices` IPC every 5 sec. When the previously-active external device disappears from the list (Core Audio has rerouted to internal), surfaces `"Output → internal speakers (<device name> unavailable)"` for 6 sec. Polling is gated on the three conditions so paused/internal/menu-open windows have zero IPC overhead. **(b) Auto-reconnect on next track start.** A `useEffect` keyed on `pb.nowPlaying?.id` checks if `lastExternalDeviceRef.current` is back in the device list, and if so calls `set-audio-device` to switch back. Notice: `"Reconnected to <device name>"`. **(c) Per-device cooldown.** `reconnectAttemptedRef = Map<deviceId, lastAttemptMs>`. Reconnect is skipped if attempted within the last 30 sec for that device id — prevents reconnect-loops on a flaky receiver. Per-device (not global) so two different AirPlay receivers each have their own cooldown. Device identity is the stable numeric `id` from the audio helper, not name (per twin-audit: "Living Room" can be two different receivers). `lastExternalDeviceRef` is auto-cleared when the user manually selects a builtin device (intent: stay on internal). **Out of scope:** Bonjour/mDNS auto-discovery of NEW AirPlay devices (per CLAUDE.md "Out of Scope (current phase)"); cross-launch persistence of preferred device (Phase C); settings toggle to disable auto-reconnect (defer, build feature first). |
| **4.4.16** | **iPod eject button no longer silently fails.** User reported "Eject button does nothing." Two bugs. **(1)** `Sidebar.tsx`'s eject-button onClick fired `window.dispatchEvent(new Event('jaketunes-ipod-ejected'))` unconditionally in the `.then()` — regardless of whether the IPC returned `{ ok: true }` or `{ ok: false, error: ... }`. When eject failed (most common cause: a track from the iPod was currently playing, so `diskutil eject` returned "Resource busy"), the sidebar still fired the ejected event, the UI briefly flickered, then re-detected the still-mounted device and rendered it again. From the user's POV: nothing happened. Fixed: button awaits the result, only fires the ejected event on `ok:true`, calls `setNotice` (4.4.12 LCD-pill notice) with the actual error message on `ok:false`. **(2)** The `eject-ipod` IPC handler bailed with "No iPod detected" if `detectedIpodMount` was null — but it never probed `findIpodMount()` like its peer handlers (`readIpodDatabase`, `check-ipod-mounted`) do. So if the module-level state desynced from disk reality (after sleep/wake, after a sync remount, after the renderer hadn't called `check-ipod-mounted` recently), eject silently refused even though the device was right there. Fixed: handler now probes `findIpodMount()` first if state is null, matching the existing pattern. **Out of scope (follow-up):** auto-pause iPod-sourced playback before attempting eject. Currently if the user is playing a track from the iPod, eject correctly fails with "Resource busy" via the new notice, but UX would be smoother if JakeTunes paused first. Deferred — the notice is enough to ship tonight. |

---

## Architecturally significant pieces (cross-version reference)

### The cast — `src/main/cast.ts`
Single source of truth for the 9-caller rolodex. Each caller has: id, name, tag (e.g. `[GIOVANNI]`), voiceId, weight (selection), fn (function), bg (background), speech (profile), openings (3 examples), mmReaction, meganReaction, never[] (taboos), voiceSettings (stability/similarity_boost/style overrides). `buildCallerSegmentMode(callerId)` returns the per-caller prompt block. `callerForTag(tag)` is the parser lookup.

### Persistent show memory — `src/main/radio-memory.ts`
JSON in `userData/radio-memory.json`. Tracks: last N topic angles, last N callback-worthy lines (extracted by heuristic — strong opinions, profanity, quoted lyrics), `hotTake` (slot-1 Cold Open Hot Take, scoped per-hour, paid off at slot 11), running-bit state. `formatMemoryForPrompt()` is what the radio handler injects.

### Segment archetypes — `src/main/archetypes.ts`
11 structural templates as a data table. `buildArchetypeBlock(id, opts)` returns the prompt fragment. Deferred-Punchline / Hour-Out archetypes consume the slot-1 hot take from memory.

### External APIs — `src/main/external.ts`
6 sources: OpenWeatherMap, Last.fm, RSS (Pitchfork/Stereogum/Quietus), Discogs, Wikidata SPARQL, Cover Art Archive (+ MusicBrainz release MBID lookup). All cached with TTL via `makeCache<T>(ttlMs)`. All fail-soft (return null/empty on error). Format-for-prompt helpers (`formatWeatherForPrompt`, `formatLastFmChartForPrompt`, etc.) return single-line summaries to inject into the radio prompt.

### Audio graph — `src/renderer/audio/eq.ts`
- `audioContext` (shared with Howler via `Howler.ctx`)
- `preampNode` → 10-band biquad filter chain → `audioContext.destination`
- `analyserNode` side-branched off preamp for the LCD-pill visualizer
- `attachHowlToEq(howl)` — music elements (idempotent, handles Howler pool reuse)
- `attachClipToBroadcast(audio)` — TTS clips (route through preamp; clean up on `ended`/`error`)
- `attachAnnouncerToBroadcast(audio)` — announcer voice (goes through broadcast FX chain → preamp; clean up on `ended`/`error`)
- Broadcast FX chain: compressor (8:1, -22dB) → low shelf +4dB @ 180Hz → presence peak +5dB @ 2.8kHz → high shelf +2dB @ 8kHz → split dry/wet (convolver IR = synthesized exp-decay noise, 1.5s tail)
- Recording: `MediaStreamAudioDestinationNode` taps the chain tail + Howler master gain; `MediaRecorder` produces webm/opus; main process transcodes to MP3 via ffmpeg

### Procedural stingers — `src/renderer/audio/stingers.ts`
Web Audio synthesis (no bundled SFX files): riser (saw + LP sweep), swoosh (bandpass-swept noise), drum-hit (sine pitch drop + click), bell-hit (fundamental + perfect 5th sines), sub-drop, whoosh-pad. `randomPreStinger()` / `randomEndStinger()` for the announcer drop production.

### Listener taste profile — `src/main/index.ts` (around `buildTasteProfile`)
`userData/listener-profile.json`: totalPlays, totalSkips, artistPlays, artistSkips, albumPlays, genrePlays, recentPlays[200], recentSkips[100], topRated[50], observations[15]. Auto-observations regenerated every 20 plays via a small Claude call. Fed into every persona prompt (Picks, chat, radio chatter, recommendations).

### Disabled / not yet wired
- **Audio-analysis (librosa) worker**: disabled in 4.2.12. `enqueueAudioAnalysis` is a no-op. Was racing with playback decoder.
- **Stuck-audio watchdog** (4.1.5 implementation): replaced by the heartbeat recovery in 4.2.14.
- **DJ Mode (Camelot mixing)**: the vinyl button is wired and Stephen Hands is the persona, but the actual beatmatched-Camelot transitions are placeholder. Real BPM/key-aware crossfading is the next big feature.

### Rotation slot map (current — 4.4.1 hour clock)
| Slot | Role | Archetype |
|---|---|---|
| 0 | Full station ID + show open | (built into segmentMode) |
| 1 | Cold Open Hot Take (captured to memory) | A |
| 2 | Back-announce | (Back-Announce) |
| 3 | Lateral Pivot or Lineage Bridge (50/50) | B or E |
| 4 | Brooklyn / Lyric Roast / Lightning Round (random) | I / F / C |
| 5 | Caller (full 9-person rolodex) | G |
| 6 | Recovery cool-down | (Recovery) |
| 7 | Mini station ID (dry, short) | (built in) |
| 8 | Historian Dwell — slot 8 ONLY | J |
| 9 | Stephen Hands (1 hour in 3) OR Lightning Round | H or C |
| 10 | Recovery cool-down | (Recovery) |
| 11 | Hour Out (pays off slot-1 hot take) | K |

### Cast voice IDs (current, for reference)
| Character | Voice ID |
|---|---|
| Music Man | `ljX1ZrXuDIIRVcmiVSyR` (env override: `ELEVENLABS_VOICE_ID`) |
| Megan | `T7eLpgAAhoXHlrNajG8v` |
| Announcer | `CeNX9CMwmxDxUF5Q2Inm` |
| DJ Stephen Hands | `ApBE43wHy5MiZGz9ihqB` |
| Giovanni | `UOB3uZCEf2cjGpZaGOXq` |
| Rajiv | `miqykcv8BCUvQnRlIGUV` |
| Bernard | `Q0HZwrR1H2SmRvd5cX3U` |
| LaShonte | `VYtAZPRhkK9OruILpVBz` |
| Kristina | `BlgEcC0TfWpBak7FmvHW` |
| Devin | `YrAYvOVjAFiqVwBgB4qI` |
| Maya | `aKw9UnnjRq5scbeeGI7Z` |
| Mike | `Ib97zM6uFBc71OWgj75I` |
| Zoe | `c8v8wiyiDwyuduufV6kB` |

### Current persona system prompts (where they live)
- `MUSIC_MAN_CORE` — `src/main/index.ts`, around line 3117. Fixed opinions list.
- `MEGAN_CORE` — `src/main/index.ts`, around line 3279. Non-overlapping fixed opinions.
- `DJ_HANDS_CORE` — `src/main/index.ts`, just after `MEGAN_CORE`. Party-first.
- Per-caller prompts — `src/main/cast.ts` via `buildCallerSegmentMode()`.

### Open items in flight (parallel session)
- A `'store'` ViewName + `musicmanStoreReview` IPC + Store icon in sidebar (`ICON_STORE_BLUE`) suggest a JakeTunes Store view is being scaffolded. Not yet documented here — defer to that session.

---

## Quick install reference (any version)

- DMG: `release/JakeTunes-X.Y.Z-arm64.dmg`
- Build: `npm run dist:dmg`
- Type-check: `npx tsc --noEmit`
- User data: `~/Library/Application Support/JakeTunes/`
- Music files (local "iPod" mirror): `~/Music2/JakeTunesLibrary/iPod_Control/Music/` (legacy path; default for new installs is `app.getPath('music')/JakeTunesLibrary/iPod_Control/Music/`)
