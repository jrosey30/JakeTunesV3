# Gated proposal — stop import-time mood embeds from clobbering enriched vectors

Status: **ESCALATED 2026-08-20 — the clobber RECURRED on the first import day
after the repair, and the mechanism is now fully identified** (see the
2026-08-20 section below). Originally PROPOSED 2026-08-18. App/trainer code
change → Jake's call. The nightly repairs (REPORT-20260818, REPORT-20260820)
fix the data; this fixes the mechanism so it stops recurring.

**RECURRENCE LOG:** 4th event 2026-08-23 (library 9,645→9,686, +41 imports;
96 orphans back, 709 clobbered vectors; router-truth 0.755 → repaired 0.830
— REPORT-20260823). 3rd event 2026-08-22 (library 9,592→9,645, +53 imports;
96 orphans back, 668 clobbered vectors; router-truth 0.750 → repaired 0.830
— REPORT-20260822). Prediction now confirmed on EVERY import day since the
mechanism was identified (08-20, 08-22, 08-23): each one reverts the NAS
mood-index to the app's stale local map until fixes 4/5 land. Each
recurrence costs a nightly re-embed of ~600-700 vectors (~$0.15) and a day
of degraded phone mixes. This is the top open ask.

## ESCALATION (2026-08-20): the real writer is autoBackupStateToNas

The 08-18 repair was reverted within ~40 hours, on the first day with an
import. Forensics (byte-level, REPORT-20260820):
- The NAS mood-index reverted to **exactly** the pre-08-18-repair map (all 72
  pruned orphans back byte-identical; 491/514 repaired vectors back to their
  corrupted bytes) **plus exactly the 2 tracks imported 08-19 19:02** (Bob
  Sinclar 10609/10610). Set algebra: clobbered ∖ pre-repair = {10609, 10610},
  pre-repair ∖ clobbered = ∅. Only a whole-map replay from a stale copy can
  produce that — import-time embeds alone cannot recreate deleted tracks'
  vectors.
- The writer is **`autoBackupStateToNas` (src/main/index.ts:3538)** — the
  silent boot+timer mirror that pushes ANY local-newer STATE_FILE_NAMES entry
  wholesale. The import bumped the local mood-index.bin mtime (persistMoodIndex
  after the import-time embed), local became "newer" than the NAS copy, and the
  auto-backup replayed the entire stale-lineage local file over the repaired
  NAS one. No .reconcile-bak by design (the manual reconcile path was ruled
  out: newest .reconcile-bak is 2026-06-23). The `.tmp` litter naming on the
  NAS (`mood-index.bin.<pid>.<ts>.<rand>.tmp`) matches atomicPublishToNas,
  confirming this path has been writing brain files to the NAS all month.
- Structural flaw: mood-index.bin (and embeddings.bin) have TWO writers with a
  **mtime-wins-whole-file** policy. The trainer enriches the NAS copy nightly;
  the app evolves its LOCAL copy at import; local-primary means the app's copy
  never receives the trainer's enrichment, so every auto-backup push after an
  import replays a progressively staler brain over the enriched one.

## Additional/updated fixes (beyond fixes 1–3 below)
4. **Exclude `mood-index.bin` from STATE_FILE_NAMES auto-backup/reconcile**
   (or make the brain files pull-only NAS→local): the trainer + nightly
   exercise own the NAS mood-index; the app's local copy is a read cache that
   must never overwrite it wholesale. This is the single smallest change that
   ends the recurrence. Same reasoning arguably applies to embeddings.bin
   (identity metrics show no damage yet, but the same replay path exists).
5. **Repair the app machine's LOCAL mood-index.bin** (its lineage predates
   08-18 and is the resurrection reservoir) — or simply delete it and let the
   app re-pull/rebuild, whichever matches the intended cache semantics.

Until one of these lands, every import day reverts the NAS repair and the
nightly exercise will keep re-repairing (recipe: repair_20260820.py →
prove_20260820.py → apply_20260820.py, fidelity-gated, backup + atomic).

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
