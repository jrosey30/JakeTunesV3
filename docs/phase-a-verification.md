# Phase A Day 1 — Verification Report

**Codebase verified against:** 4.4.10 (commit `92640dc`)
**Date:** 2026-05-11
**Purpose:** confirm or refute the Phase A bug diagnoses (originally
made against 4.0.5 source) before any code changes in 4.4.10.

---

## Bug 1 — Get Info auto-select clobbers user mouse-drag

**Status: CONFIRMED REAL in 4.4.10. No change from 4.0.5.**

**Evidence:** `src/renderer/components/GetInfoModal.tsx:62-65`

```ts
useEffect(() => {
  const t = setTimeout(() => firstInputRef.current?.select(), 50)
  return () => clearTimeout(t)
}, [currentIdx])
```

The 50ms timer fires `firstInputRef.current?.select()` on **every**
`currentIdx` change — both initial mount and every prev/next
navigation (`currentIdx` is the dependency).

**Failure sequence:**
1. User opens Get Info, OR clicks the prev/next nav arrows at
   `GetInfoModal.tsx:387, 397`.
2. `currentIdx` changes → `useEffect` runs → 50ms timer scheduled.
3. Within that 50ms window, user mouse-downs in the Name field
   (`firstInputRef`-bound input at line 332) and starts dragging
   to select a substring.
4. Timer fires `.select()` → input contents fully selected →
   user's in-progress drag is terminated mid-flight.
5. From the user's POV: "I tried to highlight 'Pretender' to retype
   it, but the whole field jumped to fully selected."

**Scope:** affects only the first input (the Name field). Other
fields use `<input>` without `firstInputRef`, so their mouse-drag
selection works normally. **If the user is reporting drag-broken on
all fields,** there is a second cause we haven't found — most likely
a CSS `user-select: none` on a parent container. Should re-confirm
scope with the user before fixing.

**Fix readiness:** the fix is unchanged from the earlier diagnosis:
- (a) Use a `useRef` flag so auto-select runs only on initial mount,
  not on every `currentIdx` change, OR
- (b) Cancel the timer if any input receives `mousedown` or `focus`
  before it fires.
Both are 5-line changes. Recommend (a) + (b) together.

---

## Bug 2 — Artwork doesn't persist after navigation

**Status: ORIGINAL DIAGNOSIS (missing ADD_ARTWORK dispatch) IS
FALSE in 4.4.10. The 4.0.5 bug was fixed somewhere in the
4.0.5 → 4.4.10 work. The user's reported bug must have a different
underlying cause.**

**What I verified:**

1. **`ADD_ARTWORK` reducer action exists** at
   `LibraryContext.tsx:44` and the handler merges into
   `artworkMap` correctly at line 197-198.

2. **All 6 view render sites of `GetInfoModal` dispatch
   `ADD_ARTWORK`** after their `setCustomArtwork` IPC call:
   - `ArtistsView.tsx:117, 126, 173, 185`
   - `SongsView.tsx:175, 186, 312, 324`
   - `SmartPlaylistView.tsx:522, 533, 571, 583`
   - `PlaylistView.tsx:266, 278, 399, 410`
   - `GenresView.tsx:84, 93, 123, 135`
   - `AlbumsView.tsx:161, 172, 227, 239`
   - Plus `AlbumArtPanel.tsx:39, 51, 70, 87` (sidebar art-set).

3. **Key normalization is consistent** end-to-end:
   - `set-custom-artwork` IPC at `src/main/index.ts:5071`:
     ``` `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}` ```
   - Same exact pattern in `GetInfoModal.tsx:200`,
     `App.tsx:209`, and all view artwork lookups.
   - No diacritic or whitespace-collapse drift between sides.

4. **The versioned-hash cache-bust pattern works correctly.**
   - IPC writes file as `${hash}.jpg` and returns
     `${hash}_${timestamp}` to force React re-render
     (`index.ts:5072-5094`).
   - Protocol handler at `index.ts:5548` strips the `_timestamp`
     before reading: `rawHash.replace(/_\d+$/, '')`.
   - File lookup succeeds correctly.

5. **`SET_ARTWORK_MAP` (which would replace the entire map and
   could drop a just-added entry) is dispatched in only ONE place:**
   `App.tsx:203`, inside the startup `loadArtworkMap` chain. It
   does NOT fire on view changes, library reloads, or modal
   close. So map-replacement-clobber is not the cause.

**The 4.0.5 bug is genuinely gone.** Whatever the user is observing
in 4.4.10 has a different cause.

### Three remaining suspects, ranked by likelihood

**(A) `localArtHash` bleed across in-modal navigation.**
`GetInfoModal.tsx:55` declares `const [localArtHash, setLocalArtHash]`
as a local override for instant feedback. The `useEffect` at lines
67-70 resets `editedFields` on `currentIdx` change but **does NOT
reset `localArtHash`**. So after the user adds custom art for track A
and navigates Next to track B (different album), the modal displays
track A's artwork as if it were track B's. Confusing UX — could be
perceived as "artwork moved to the wrong song." Doesn't explain
"art disappears after navigation away from Get Info."

**(B) The reported symptom may actually be after restart, not
navigation.** The user said "after navigation" but the only path
where art could vanish is restart (where `loadArtworkMap`
re-populates from disk). If the disk write in `set-custom-artwork`
silently fails for some reason (path conflict, disk-full, sips
binary missing), the in-memory state has the art but disk doesn't,
and the next launch loses it. Worth re-asking the user precisely:
*"after navigation away from the album view, or after closing and
reopening the app?"*

**(C) The auto-fetch background loop racing with manual set.**
`App.tsx:223-230` is a one-shot background loop that fetches
artwork for albums missing from the loaded map. It runs only at
app launch. So this should NOT race with a user adding art
mid-session. Unless... there's a path where the loop is re-triggered
by a library reload. Need to grep for other callers of `fetch-album-art`
that might run during a session — but none surfaced in the renderer.

**Recommended next step before any fix:** re-confirm the symptom
with the user. Specifically:
1. Add custom art for an album via Get Info → close modal → does
   the album view show the art?
2. Navigate away from the album view → return → does it still show?
3. Quit JakeTunes → relaunch → does it still show?

Knowing which step it disappears at narrows to one of (A), (B), or
something else not listed here. Without that, fixing (A) could be a
noop on the user's actual problem.

---

## Items already fixed in 4.0.6 → 4.4.10 (from CHANGELOG)

For reference, these were on Phase A and are already shipped:

| Original concern | Fixed in | Mechanism |
|---|---|---|
| Music stutter from setState storms | 4.0.11 | Throttled `SET_POSITION` to 10Hz |
| Audio pipeline observability | 4.0.9 | `__audioLog()` ring buffer |
| Background workers competing with playback | 4.0.10 | Workers yield while music plays |
| AirPlay/external-pause recovery | 4.0.6 | Auto-recovery on device renegotiation |
| Audio watchdog | 4.2.13 + 4.2.14 | Heartbeat + active recovery loop |
| App Nap killing playback at 29s | 4.2.13 | `powerSaveBlocker('prevent-app-suspension')` |
| Web Audio source-node leak | 4.4.6 + 4.4.8 + 4.4.9 | Disconnect-on-end + Howler-pool reuse |
| Metadata-edit cascade clobber | 4.4.5 | Always merge into `fields`, not replace |
| Library-wipe via playlist context menu | 4.4.10 | Removed Delete from playlist menu |

---

## Day 1 conclusions

- **Bug 1 is real and fixable.** Day 2 morning can ship it as
  diagnosed, with the user's clarification on whether other
  fields are also drag-broken (which would point to a CSS cause
  to fix in the same commit).
- **Bug 2 is NOT the bug I diagnosed against 4.0.5.** Day 2
  cannot proceed on this until the user re-confirms the symptom
  precisely (after-navigate vs after-restart vs other) so we
  target the actual cause, not a phantom.
- **Several Phase A items are already shipped** and can be
  removed from the plan.

---

## Recommended Day 2 plan

1. **Morning:** ship Bug 1 fix (Get Info auto-select). Small,
   surgical, well-understood. Build + smoke test + commit.
2. **Pause for user reply:** "Bug 2 — does art disappear after
   in-app navigation or after restart? Which view do you see it
   missing in?"
3. **Afternoon (depending on user reply):**
   - If after-restart → investigate disk-write reliability in
     `set-custom-artwork` IPC (line 5067-5097).
   - If after-navigation away from Get Info → fix `localArtHash`
     bleed (item A above) AND investigate whether some view
     re-mounts in a way that loses the dispatched state.
   - If after-restart but disk write looks fine → may be a
     `loadArtworkMap` ordering bug at startup (loaded from
     stale cache before disk write flush).

No code changes will be committed until the user has read this
report and confirmed the path forward.
