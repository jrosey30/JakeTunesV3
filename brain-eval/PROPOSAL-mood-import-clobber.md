# Gated proposal — stop import-time mood embeds from clobbering enriched vectors

Status: **ESCALATED 2026-08-20 — the clobber RECURRED on the first import day
after the repair, and the mechanism is now fully identified** (see the
2026-08-20 section below). Originally PROPOSED 2026-08-18. App/trainer code
change → Jake's call. The nightly repairs (REPORT-20260818, REPORT-20260820)
fix the data; this fixes the mechanism so it stops recurring.

**RECURRENCE LOG:** 11th event detected 2026-09-01 (import day: library
9,852→9,925, +73 imports; 124 orphans, 61 dup groups, 1,072 suspects).
Repaired + applied same night — router-truth 0.747→**0.841** (new post-repair
high; ret-004 0.00→0.50, ret-012 0.30→1.00, ret-007 0.52→1.00), worst
per-probe delta +0.00, strict bars PASS, fidelity gate 50/50 trainer-fresh
min cos 0.9987 (REPORT-20260901). Eleven-for-eleven on import days.
10th event detected 2026-08-31 (import day: library
9,838→9,852, +14 imports; 122 orphans, 61 dup groups, 1,057 suspects).
Repaired + applied same night — router-truth 0.738→0.833, worst per-probe
delta +0.00, strict bars PASS, hybrid fidelity gate 50/50 min cos 0.9972
(14 trainer-fresh + 36 aged never-repaired — first use of the hybrid cohort;
small-import nights can't fill the fresh-50 gate now that the enrichment
backlog is done) (REPORT-20260831). Ten-for-ten on import days. 9th event
detected 2026-08-30 (import day: library
9,806→9,838, +32 imports; 122 orphans, 61 dup groups, 1,020 suspects).
Repaired + applied same night — router-truth 0.744→0.833, worst per-probe
delta +0.00, strict bars PASS, fidelity gate 37/37 min cos 1.0000
(REPORT-20260830). Nine-for-nine on import days. 8th event detected
2026-08-29 (import day: library
9,791→9,806, +15 imports; 122 orphans, 62 dup groups, 970 suspects). Repaired
+ applied same night — router-truth 0.756→0.833, worst per-probe delta +0.00,
strict bars PASS with no precedent-based judgment needed (REPORT-20260829).
Eight-for-eight on import days; the mechanism fires regardless of import
count. 7th event detected 2026-08-27 (import day 08-26: library
9,783→9,791, +8 incl. the Parcels album; 109 orphans, 57 dup groups). The
08-27 session ABORTED before repairing (REPORT-20260827 — three stacked infra
failures + a fidelity-gate blind spot it fixed), so the damage stayed LIVE for
~24h and was repaired+applied 08-28 (router-truth 0.744→0.826, mood-routed
0.838, 870 suspects re-embedded, 109 orphans pruned — REPORT-20260828). New
cost datum: when the nightly repair misses a night, the phone serves the
clobbered map all day. 6th event 2026-08-26 (library 9,692→9,783, +91 imports;
104 orphans/60 dups; rt 0.744→0.826 — REPORT-20260826). 5th event 2026-08-24 (library 9,686→9,692, +6 imports;
97 orphans back, 768 clobbered vectors; router-truth 0.748 → repaired 0.823,
mood-routed mean 0.833 — REPORT-20260824. NEW this night: the 2:00 trainer
FATAL'd before writing, so (a) the clobber also wiped the 08-23 trainer batch
with nothing re-writing it — the fidelity gate had to move to an aged cohort —
and (b) the tempo-view exclusion protected 8 corrupted import embeds the
trainer's tempo catch-up would normally have fixed; rule refined, see report.
Even a +6-import day reverts the whole map — event size does not scale down
with import count.) 4th event 2026-08-23 (library 9,645→9,686, +41 imports;
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
