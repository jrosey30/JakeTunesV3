# Gated proposal — make ALL EMBD readers refuse truncated buffers

Status: **PROPOSED 2026-08-25.** Trainer side already fixed and shipped
(V3 `5d3ed34`); the desktop and mobile twins still silently tolerate
truncation. App/backend code change → Jake's call.

## The failure this guards against (it already happened)

2026-08-25, 02:00: a flapping SMB mount handed the trainer's `readFileSync`
8,510 of embeddings.bin's 9,790 records **with no error**. Every EMBD reader
in the family bounds its parse loop by buffer length (`i < count && off +
rec <= buf.length`), so a short buffer yields a smaller map instead of an
error. The trainer folded 8 re-embeds into that amputated map and wrote it
over the live brain. Only a lucky second mount failure (verify read died on
EBADF) kept it from being *accepted* — the verify baseline (`startCount`) is
captured from the same bad read, so verify cannot catch this class.

## The three readers (⚠️ TWIN-linked in code as of tonight)

| Reader | Risk | Status |
| --- | --- | --- |
| `scripts/brain-trainer.mjs` `readEmb` | writes the map back nightly — **amputation** | **FIXED** (`5d3ed34`): throws when bytes < header count |
| `src/main/ai/embeddings.ts` `parseEmbeddingsBlob` (also parses mood-index via `mood-index.ts`) | feeds long-lived caches that `autoBackupStateToNas` **replays to the NAS** — desktop-side short read of the NAS mirror or local file can do the same amputation via day sync; plausibly relevant to the mood-clobber family | OPEN — this proposal |
| `~/JakeTunesMobile/backend/src/util/rag.ts` | read-only serving; a short read degrades phone results until next reload, no write-back | OPEN — low priority |

## Proposed change (desktop)

In `parseEmbeddingsBlob`, after reading `count`: if
`buf.length < 12 + count * (4 + dim*4)`, treat the blob as corrupt.

**The open question — and why this is gated:** corrupt-blob handling there
today returns an **empty map** (bad magic / format mismatch). Empty may be
dangerous if any write path would replay "empty" over a good file, exactly
the whole-map-replay mechanism from PROPOSAL-mood-import-clobber. Options:

1. **Throw** — loud, but both call sites (`embeddings.ts:88`,
   `mood-index.ts:79`) assign straight into a cache load; need to confirm
   the app surfaces rather than crash-loops.
2. **Return empty** — consistent with existing corrupt handling, but must
   first prove no write path replays an empty map over a populated file.
3. **Return empty + poison flag** that blocks `autoBackupStateToNas` and any
   other writer until a clean read succeeds — safest, slightly bigger.

Recommendation: (3), but it touches the sync path, so it needs a deliberate
session with the app running, not a 3 AM unilateral edit.

## Mobile backend

Same one-line guard in `rag.ts` `readBrain`; on failure keep serving the
previous in-memory brain and retry next reload. Low stakes, can ride along
with any backend deploy.
