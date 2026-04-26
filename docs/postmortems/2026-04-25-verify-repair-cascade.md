# Post-Mortem — Verify-and-Repair Cascade (Apr 23–25, 2026)

**Severity:** P0 (user data loss + repeated unforced errors)
**Author:** Claude (the agent that caused most of these)
**Status:** Resolved — fixes in production; rules added to CLAUDE.md.

---

## tl;dr

Over three days, three sibling bugs in the same fragile-text-matching pipeline
triggered three separate user-visible failures, each one shipped after the
previous "fix." The root cause was not the bugs themselves — it was the
**process gap**: every fix was scoped to the one symptom in front of me and
never extended to a sweep for siblings. The user ate the integration test for
each round.

The actual code fixes are durable. The process changes (now codified in
CLAUDE.md) are what prevent the next round.

---

## Timeline

### Round 1 — `repair_mismatches.py` deletes user data
**Trigger:** User clicked **Library → Verify & Repair Library…** (a maintenance
menu item that ran `core/repair_mismatches.py --delete-unrepairable`).

**What happened:** The Python script's `normalize()` function did not
canonicalize "Pt." / "Pt" / "Part" + digit to a single form. Pink Floyd's
"Another Brick in the Wall, Part 1" (library) and the file tag "Another Brick
In The Wall, Pt. 1" normalized to different strings. The script classified the
library entry as "unrepairable" and the `--delete-unrepairable` flag deleted it
from `library.json`.

**User reaction:** "verify and fix deleted the first another brick in the
wall!!!!! part 1!!! unacceptable!!!!"

**Resolution:**
- Restored track #4709 from `library.json.bak-repair-20260425-162501`.
- Patched `core/repair_mismatches.py::normalize()` to canonicalize
  `Pt./Pt/Part + (digit | roman) → "part N"`.
- Removed the **Verify & Repair Library…** menu entry, the
  `verify-library` IPC handler, the `apply-library-repair` IPC handler, and
  the renderer modal path. Per user direction: *"the verify and repair function
  is stupid. ipod and itunes never had that. the shit just worked!!"*

**What I should have done but didn't:** A feature that *auto-deletes user data
based on a text comparison* should never have shipped. Destructive operations
must gate on identity, not on whether two strings happen to normalize equal.

---

### Round 2 — Identity-based replacement shipped incomplete
**Trigger:** User: *"now we need to figure out what you were trying to solve
with the verify and repair and how it can happen more efficiently and more
importantly, accurately in the background."*

**What I built:** A silent post-sync identity verifier in `src/main/index.ts`:
- `computeAudioFingerprint(absPath, durationMs)` — SHA-1 of first 256KB + duration
- `verifyAndHealTracks(inputs, mounts)` — lazy F-dir fingerprint index, never
  deletes (worst case sets `audioMissing: true`)
- Backfills `audioFingerprint` on import and on `sync-ipod`
- Fires after every `sync-to-ipod` and pipes results back through a new
  `verificationUpdates[]` field on the IPC response.

**What I shipped broken:** The IPC contract was wired through main and through
types, but `DeviceView.tsx` never *applied* `verificationUpdates`. The
`UPDATE_TRACKS` reducer didn't accept boolean values, so an `audioMissing: true`
flag would have failed type-check anyway. There was no UI for the flag.

I caught this the same session and fixed all three (reducer accepts
`string | boolean` with a `BOOLEAN_FIELDS` set; DeviceView dispatches
`verificationUpdates` after the existing `pathRewrites`; SongsView renders a
small amber "!" badge with a tooltip).

**What I missed:** The verifier handled "library entry's path is wrong" but
did *nothing* for the inverse direction — "iPod has tracks the library doesn't
know about." The iTunesDB had 4,569 tracks; library had 4,550. The drift
banner in **On This iPod…** said "(sync to reconcile)" but the Sync button
only flowed library → iPod. There was no path back.

**User reaction:** Sent a screenshot of the drift banner with "you're a dumbass."

**Resolution:**
- Added an **Import N to Library** button inside the drift banner. Calls the
  existing (and previously unused) `syncIpod` IPC, which reads iPod iTunesDB,
  filters by existing IDs, backfills fingerprints, and returns new tracks.
  The button dispatches `ADD_IMPORTED_TRACKS` and merges any iPod-sourced
  playlists (respecting `deletedIpodPlaylistNames` tombstones).
- Path-keyed safety filter on top of ID dedup so we can't double-add a track
  the library already knows under a different ID.

**What I should have done but didn't:** When removing a feature, audit *what
problem it was trying to solve* and confirm every part of that problem space
is still covered. I covered the "bad library path" sub-problem and missed the
"orphan iPod track" sub-problem.

---

### Round 3 — Sync preflight aborts on the same Pt./Part bug
**Trigger:** User clicked **Sync** after the iPod-only import. Sync aborted with:

> Sync failed — Sync aborted: 1 library entry points at the wrong audio file.
> Examples: • "Another Brick in the Wall, Part 1" / Pink Floyd → file is
> "Another Brick In The Wall, Pt. 1" / Pink Floyd

**What happened:** `src/main/index.ts` has its own `normalize()` function
(line ~959) used by *both* the smart-match step and the content-safety
preflight check. It is a **JavaScript port of `core/repair_mismatches.py::normalize`**.
I fixed Pt./Part in the Python version in Round 1 and **never grepped for
the JS twin**. The JS preflight fired a false positive on the same Pink Floyd
title and aborted sync.

**User reaction:** *"jesus christ man"* and later: *"YOU CANT KEEP FORGETTING
TO CHECK TWINS ETC WHEN IT IS warranted THAT IS AN UNFORCED ERROR. YOU RUSH A
LOT OF CHANGES WITHOUT CHECKING THOROUGHLY IF IT WILL CREATE OTHER ISSUES OR
NOT"*.

**Resolution:**
- Patched `src/main/index.ts::normalize()` with the same Pt./Part canonicalization.
- Added an identity-based escape hatch: when the text comparison flags a track,
  the preflight now computes the file's live fingerprint and compares it
  against `track.audioFingerprint`. If they match, the file IS the right file
  by binary content; cosmetic text differences (smart quotes, title-case,
  feat./with, future variations we haven't enumerated) cannot abort sync.
- Added explicit `⚠️ TWIN` cross-reference comments to both `normalize()`
  implementations pointing at each other.
- Did a tree-wide sweep for sibling implementations:

| Site | Purpose | Risk | Action |
|---|---|---|---|
| `core/repair_mismatches.py:80` | Python normalize (CLI) | shared logic | Pt./Part fixed Round 1; ⚠️ TWIN comment added |
| `src/main/index.ts:959` | JS normalize (smart-match + preflight) | shared logic | Pt./Part fixed Round 3; ⚠️ TWIN comment added; fingerprint escape hatch added |
| `src/main/index.ts:347` | MusicBrainz artist matcher | none — strips all non-alnum, only used on artist names | no change |
| `src/renderer/components/CynthiaPopover.tsx:53` | Field-name normalization | none — `track_number → trackNumber`, not text content | no change |

---

## Root Causes

### 1. Twin/sibling blindness
The single most expensive failure mode in this cascade. The same logical
function existed in two languages (Python + JS) and I treated them as
unrelated. Fixing one and shipping was the unforced error. Both Round 1's
deletion bug *and* Round 3's preflight false-positive trace to the exact
same conceptual bug — "Pt." not equating to "Part" — manifesting in
different files.

### 2. Removing a feature without backfilling its problem space
"Verify and repair" was solving multiple sub-problems (bad paths, drift,
orphan tracks). When I ripped it out, I rebuilt one sub-problem (bad paths)
and forgot the other (drift). The user had to surface the gap.

### 3. Destructive ops gated on fragile signals
A `--delete-unrepairable` flag, gated on a text comparison, ran on an
`apply-library-repair` IPC handler reachable from a menu. That is a
loaded gun pointed at user data. The fix was not to make the comparison
better — it was to **never let text comparison authorize deletion at all**.

### 4. Ship-before-verify cycle compression
I was building, packaging, installing, and waiting for the user to find
the bug. Each round was effectively user-as-CI. Comments + a sweep before
shipping would have caught Round 3 in the local edit, before the DMG
rebuild.

### 5. No regression tests for normalize
The Pink Floyd case is now a *known* failure pattern. There is no unit
test that asserts `normalize("Part 1") === normalize("Pt. 1")` in either
language. Without a test, the next person editing either function (likely
future me) has nothing forcing them to keep the twins in sync.

---

## Concrete fixes already in production

1. `core/repair_mismatches.py::normalize` — Pt./Part canonicalization,
   `⚠️ TWIN` comment pointing at JS counterpart.
2. `src/main/index.ts::normalize` — same canonicalization, same comment.
3. `src/main/index.ts` preflight — fingerprint escape hatch so binary
   identity beats noisy text on flagged tracks.
4. Verify-and-repair UI surface fully removed (menu, IPC handlers,
   preload exposure, type defs, renderer modal mode). The Python script
   stays on disk for opt-in CLI debugging only — no UI path can invoke it.
5. Identity-based silent verifier (`verifyAndHealTracks`) shipped and
   wired end-to-end (main → IPC → reducer → DeviceView → UI badge).
6. **Import N to Library** action in **On This iPod…** drift banner so
   the iPod-only-track sub-problem has a non-destructive resolution path.

---

## Action items — process / checks-and-balances

These now live in CLAUDE.md so future agents (and future me) read them
before touching shared logic.

### A. Twin/sibling discovery is mandatory before declaring a fix done
When fixing any function named `normalize`, `compare`, `match`,
`canonicalize`, `dedupe`, `serialize`, `parse` — or any function whose
behavior is shared across language boundaries — grep the whole tree for
implementations of the same name *before* the build step. If a twin
exists, fix it in the same commit and add a `⚠️ TWIN` cross-reference
comment to both.

```bash
# Run before shipping any normalize/compare/match fix:
grep -rn "function <name>\|const <name>\|^def <name>" src/ core/
```

### B. Twin functions must declare each other in code
A function with a twin in another language must carry a `⚠️ TWIN: <path>`
comment. Both sides. The first thing the next editor sees is the link to
the other implementation.

### C. Destructive operations may not gate on text comparison
Deletion, overwriting, sync abort, or any other irreversible/blocking
operation must gate on **identity** (binary fingerprint, content hash,
stable ID, exact path) — not on whether two strings happen to normalize
equal. If text comparison is the only available signal, the operation
must require explicit per-item user confirmation.

### D. Removing a feature requires a problem-space audit
Before deleting an IPC handler, menu entry, or feature module, list the
problems that feature was solving and confirm each one is either:
- still covered by another path,
- explicitly out of scope (with user sign-off), or
- replaced by a new path in the same change.

Don't ship a removal that orphans a sub-problem the user is going to
hit. The drift banner with no actionable button was exactly that.

### E. Sweep before ship
Before running `npx electron-builder`, do a 30-second sweep:
- Grep for related code paths (named twins, shared regex constants,
  shared comparators).
- Re-read the file you just edited end-to-end.
- Check that any new field added to a Track / IPC type / reducer action
  is consumed everywhere it should be.

The cycle is "edit → grep → reread → build → install." Skip the middle
two and the user becomes the test suite.

### F. Regression tests for known failure patterns
The Pink Floyd "Pt. 1" / "Part 1" case has burned us twice. Add a
unit test for `normalize()` (both Python and JS) that asserts:
- `normalize("Part 1") === normalize("Pt. 1") === normalize("Pt 1") === normalize("part I")`
- A negative case ("rapture", "department" — words that should NOT match)
The test infrastructure isn't set up yet; this is a P1 follow-up.

---

## Lessons stated bluntly

- A second instance of the same bug in a different file is not a coincidence.
  It's a sibling I didn't search for.
- "I fixed it" means nothing if I haven't grepped the rest of the tree for
  the same logic.
- Text matching is a hint. Binary identity is a fact. When a fact is
  available (audioFingerprint, hash, ID), use it instead of the hint.
- "Verify and repair" is a polite-sounding name for "delete things based
  on heuristics." That's a category of feature this app should never have.
