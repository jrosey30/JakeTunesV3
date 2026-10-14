# Brief 180 — Desktop embeddings reader throws on truncation (JakeTunesV3)

## Problem / source

The desktop's `parseEmbeddingsBlob` tolerated truncation — its own
header comment called it a "KNOWN HOLE (2026-08-25)", and that hole once
amputated 1,280 vectors in the trainer. The trainer's reader throws on a
truncated read; the desktop's quietly trained its UI on a partial brain.
(Audit: Lens 3, finding F4.)

## Evidence (verified at HEAD 12bb43b)

- `src/main/ai/embeddings.ts` — `parseEmbeddingsBlob`: the parse loop
  ran `for (let i = 0; i < count && offset + recordSize <= buf.length; i++)`,
  silently stopping at the end of a short buffer and returning the
  partial map. The header comment named the hole and deferred the fix
  pending "caller-by-caller analysis".
- Twin: `scripts/brain-trainer.mjs` `readEmb` (already carries the
  `⚠️ TWIN:` declaration on the desktop side) throws:
  `if (buf.length < 12 + count * rec) throw new Error('... truncated read — header says ...')`.
- Callers of `parseEmbeddingsBlob` (whole-repo search — exactly three):
  1. `getEmbeddingsMap` (embeddings.ts itself) — wraps the read+parse in
     try/catch; on error it keeps the previous cache (or an empty one)
     and does **not** adopt the file's mtime, so the next getter retries.
  2. `getMoodIndexMap` (`src/main/ai/mood-index.ts`) — identical
     catch-and-keep-previous pattern.
  3. `pullBrainFromNas` (`src/main/brain-pull.ts`) — the whole pull loop
     is wrapped in a try/catch that logs `[brain-pull] failed (will
     retry next tick)` and records no adoption state for the file, so a
     truncated NAS copy is refused loudly and retried on the next tick
     (previously `planBrainAdopt`'s header-count check refused it —
     that guard in `src/common/brain-adopt.ts` stays, as defence in
     depth for size-mismatch cases that are not truncation).

  Conclusion of the caller analysis the old comment asked for: **every
  caller already treats a thrown parse as "keep the previous state /
  refuse the copy", so making the reader throw is safe with no caller
  changes.** A partial brain is never served.

## What changes

- `src/main/ai/embeddings.ts`
  - `parseEmbeddingsBlob` throws when the buffer is shorter than the
    12-byte header, and when `buf.length < 12 + count * recordSize`
    (record size computed from the header's declared dimension) — the
    trainer's exact truncation semantics. The parse loop itself is
    otherwise unchanged (the loop bound is now guaranteed by the check).
  - The stale "KNOWN HOLE" header comment is replaced with the fixed
    semantics, the caller analysis, and the retained `⚠️ TWIN:`
    declaration naming `scripts/brain-trainer.mjs` `readEmb` and the
    mobile backend's parser of the same format.
  - Unchanged behaviours, deliberately: bad magic ⇒ empty map;
    version/dimension mismatch vs the app's expected format ⇒ warn +
    discard (that is a format problem, not truncation); a header-only
    blob declaring zero vectors ⇒ empty map.
  - Noted consequence: `serializeEmbeddingsBlob` skips vectors whose
    length ≠ EMBED_DIM while the header counts the whole map, so a map
    poisoned with a wrong-dimension vector now produces a blob whose
    reload throws loudly (previous cache kept) instead of silently
    landing as a smaller brain. That is the intended failure mode of
    this brief.
- `src/main/__tests__/embeddings-parse.test.ts` (new) — drives the real
  extracted function (embeddings.ts has Electron load-time side
  effects; the extraction approach follows `brain-text.test.ts`) with
  hand-built EMBD fixtures:
  - well-formed blob parses fully (ids, dimension, first/last values);
  - header declares 3 records, payload holds 2 ⇒ throws /truncated/;
  - payload cut mid-record ⇒ throws;
  - buffer shorter than the header ⇒ throws;
  - header-only, zero declared vectors ⇒ empty map, no throw;
  - source guards: the stale hole comment is gone; the trainer twin
    still throws; the `⚠️ TWIN:` declaration is intact.

## What does NOT change

- The binary EMBD format, `serializeEmbeddingsBlob`, and every caller
  (`embeddings.ts` getters, `mood-index.ts`, `brain-pull.ts`,
  `brain-adopt.ts`) — no caller edits were needed (see analysis above).
- The trainer (`scripts/brain-trainer.mjs`) and the mobile backend —
  they already throw / are outside this brief; the twin declaration
  keeps the three readers linked.
- No version bump.

## Done looks like

- A truncated `embeddings.bin` / `mood-index.bin` (short SMB/NAS read)
  surfaces as a loud load failure at the parse site: the app keeps
  serving the last good in-memory brain (or refuses the NAS copy and
  retries), and no code path ever trains the UI on a partial map.

## Tests

- `node --test --experimental-strip-types src/main/__tests__/embeddings-parse.test.ts`
  (the repo's own test invocation, run in a temp-dir mirror of the
  touched files): **6/6 pass**.
- Pre-existing `src/main/__tests__/brain-text.test.ts` against the
  edited embeddings.ts: **4/4 pass** (twin text shapes untouched).
- `node --check` clean on the edited file.
- Full `npm run check` (tsc zero + full suite) is the repo gate and
  must be verified in CI / a real clone — it cannot run in the agent
  environment (no local checkout).
