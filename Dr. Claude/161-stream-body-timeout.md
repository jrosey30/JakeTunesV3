# Brief 161 — Desktop stream body-timeout

**Repo:** JakeTunesV3 · **Patch:** `patches/brief-161-stream-body-timeout.patch` · **Branch:** `fix/brief-161-stream-body-timeout` (base: main `12bb43b`; chain-B patch #1 for index.ts)

## Problem (audit Lens 1, finding 2)

A mid-stream stall had no body timeout. In `fetchAudioFromHomemini`
(`src/main/index.ts`), headers were budgeted (12 s, 25 s for
transcode) but, per the code's own comment, "the body is never
aborted by this timer" — a wedged stream hung the track
indefinitely on a bad link. (The headers-only rule in
`fetch-headers.ts` is deliberate and stays: an AbortSignal on the
whole response once cut healthy long transfers mid-body.)

## What the patch does

- **New module `src/main/stream-body-timeout.ts`** —
  `withBodyInactivityTimeout(body, timeoutMs = 10_000, onTimeout?)`
  wraps a web ReadableStream: chunks pass through untouched, the
  timer resets on every chunk, and ~10 s of zero bytes errors the
  stream (and cancels the wedged source). A slow-but-alive stream
  is never cut — the budget is per-gap, not a total deadline. The
  timer is bounded and self-clearing, so it is not `unref`'d (fix
  commit on this branch: unref let Node exit mid-read).
- **`src/main/index.ts` hunk** (3 small pieces): import the wrapper;
  extend the budget comment; wrap the live-proxy body in
  `fetchAudioFromHomemini`'s `once()` before it is handed to the
  protocol `Response`, with a warn-on-timeout log line.
- **Unchanged:** the background spool path (`spoolAwareServe`
  returns before the wrap for landed copies, and spool filling for
  later plays is deliberately unguarded — it fills at its own
  pace, per the brief).

Erroring the body surfaces to Chromium/Howler as a load failure —
which is exactly Brief 160's ending (advance, counted) in the
renderer. The two briefs are cross-referenced in both docs.

## Tests

`src/main/__tests__/stream-body-timeout.test.ts` (new, in the
patch): healthy stream passes byte-for-byte; a stalled body errors
after the budget with `onTimeout` firing exactly once; gaps under
the budget never cut a slow stream; a source error propagates.
Worker-verified: 4/4 pass under `node --experimental-strip-types
--test`, both standalone and in the fully-applied chain-B tree
(17/17 across the chain's new suites). CI (`npm run check`) is the
gate — merge only on green CI.

## Rails

index.ts +14/−3 net for this patch (the bulk lives in the new
module, per the decomposition doctrine). No new silent catches.
