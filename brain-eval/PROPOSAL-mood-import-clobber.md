# Gated proposal — stop import-time mood embeds from clobbering enriched vectors

Status: PROPOSED 2026-08-18 by the nightly brain exercise. App/trainer code
change → Jake's call. The nightly repair (REPORT-20260818) fixed the data;
this fixes the mechanism so it stops recurring.

## What happened (measured, 2026-08-18 nightly)
Tracks imported 08-09..08-16 ended up with mood vectors equal to
`embed("genre: Rap")` etc. — 228 tracks byte-identical in 39 groups — because
`buildMoodText` ran at import time, before bpm analysis and before the
nightly Gemma descriptor existed. For tracks the trainer had ALREADY enriched,
the stale bare-genre map overwrote the good vectors on the NAS (dual-writer
clobber; SMB attribute caching can defeat the mtime-tracked cache). Orphan
vectors (imported-then-deleted ids) additionally accumulate forever — 72 of
them, all bare-genre dupes, owned the entire "hip-hop and rap" top-25.

Production impact before repair: router-truth 0.818 → 0.759 (punk 1.00→0.52,
funk/soul 0.84→0.48, new-wave 1.00→0.45, hip-hop 0.84→0.68). run_eval saw
NOTHING (it scores the identity index — see PROPOSAL P1, router-aware eval).

## Proposed fixes (either alone helps; both is right)
1. **At the writer (src/main/ai/mood-index.ts):** when embedding a new track's
   mood vector, if there is no descriptor AND no bpm, either (a) skip the mood
   vector and let the trainer create it at enrichment time, or (b) write it but
   record a `bare: true` marker so the trainer's nightly pass re-embeds it even
   though the track is "enriched". Never let a bare-genre embed OVERWRITE an
   existing vector for the same id (one-line guard: only write if id absent).
2. **In the trainer (scripts/brain-trainer.mjs):** prune mood-index ids not in
   library.json at the end of each nightly run (identity-gated, after backup —
   same discipline as tonight's repair), so deleted-track vectors can't pool.
3. Optional self-heal: nightly, sample N random enriched tracks, re-embed their
   intended moodText, compare cos to stored; alert/repair on mismatch. Cheap
   canary against any future clobber path.

## Undo / risk
Fix 1 is a write-path guard (no data change). Fix 2 deletes only ids absent
from library.json, behind the existing .bak. If a deleted track is ever
restored with its old id, `--mood-backfill` re-creates its vector.

## Evidence files
REPORT-20260818-nightly.md (forensics + repair proof),
repair_20260818_ids.json (the 514 repaired + 72 pruned ids).
