# Brief 164 — Local serve: clamp ranges, label formats honestly

**Repo:** JakeTunesV3 · **Patches:** `patches/brief-164-range-ranges.patch` (index.ts chain, position #3) + `patches/brief-164-format-labels.patch` (renderer chain, position #3) · **Branches:** `fix/brief-164-range-ranges` (stacked on chain B), `fix/brief-164-format-labels` (stacked on the renderer chain)

## Problem (audit Lens 1, findings 7 and 8)

(a) The local `ipod-audio://` serve had the same Range edge cases
the mobile backend had: oversize ends returned 416 instead of
clamping, and suffix ranges (`bytes=-500`) were parsed as
start-at-0 or ignored entirely. (b) Unknown file extensions were
silently labeled `mp3` for Howler (`FORMAT_MAP[ext] || 'mp3'` in
`useAudio.ts`) — the player was told a lie about what it was
decoding.

## What the patches do

### (a) Ranges — mobile twin, ported

- **New module `src/main/range-header.ts`** — `parseRangeHeader`,
  the Brief 154 parser (RFC 9110 §14.2): clamps an oversize `end`
  to fileSize−1, honours suffix ranges, returns `'unsatisfiable'`
  only when a well-formed range truly can't be served, and `null`
  for garbage/multi-range (caller keeps its existing behaviour).
  The file carries a `⚠️ TWIN:` comment naming the mobile file
  (`backend/src/util/rangeHeader.ts`, JakeTunesMobile) and the
  lockstep rule. **Twin note:** at port time the mobile copy lives
  on the unmerged Brief 154 branch (PR #411), not on Mobile main —
  the port was made from that branch's blob
  (`c27afe3d2f1537c00fc18c80006d9119063409df`), behaviour-identical.
  When #411 lands, the mobile side should gain the reciprocal
  TWIN comment.
- **index.ts hunks:** both local serve sites in the `ipod-audio://`
  handler (the streaming-client local-cache serve and the
  fully-local serve) now call `parseRangeHeader`. `'unsatisfiable'`
  → the existing 416 shape; a parsed range → the existing 206
  response with the clamped values; `null` → falls through to the
  full-file serve, as garbage headers did before. Net index.ts
  delta for this patch is negative-to-flat (two hand-rolled parsers
  replaced by one call each).
- **Tests:** `src/main/__tests__/range-header.test.ts` — the Brief
  154 cases ported case-for-case (9/9 pass, worker-verified).

### (b) Format labels — omit, don't lie

In `src/renderer/hooks/useAudio.ts` (renderer patch chain):
`ipodPathToAudioURL` now returns `format: string | undefined` —
from the extension map, else from the track's known codec
(`CODEC_FORMAT_MAP`; import stamps `codec` on track records — the
`Track` type doesn't declare it yet, hence narrow casts at the
call sites), else **undefined**. All four Howl construction sites
(main, both prefetches, gapless preload) pass the format only when
defined (`...(format ? { format: [format] } : {})`), so Howler
sniffs the bytes itself instead of being told `mp3`. No other
behaviour changes; known extensions label exactly as before.

## Tests

Range suite 9/9 (above). Format labels: no renderer test tree
exists; the patch applies in chain order and the file parses
(`node --check`). CI (`npm run check`) is the gate — merge only on
green CI.
