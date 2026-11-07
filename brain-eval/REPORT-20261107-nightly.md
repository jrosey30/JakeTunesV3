# Nightly brain-eval — 2026-11-07 (homemini)

**Outcome: IDLE (21st consecutive) — baselines only, NOTHING applied, brain untouched.**
v3 headline 0.778 — second consecutive night below the 0.794–0.803 band,
fully explained by add-churn in the mood-routed groups (7/174 movers, all
in tempo/vibe, on a +244-add night). grounding 0.950 = the known grd-15
deterministic trap failure — the apply-blocker proposal stands.

## Pre-flight

- brain-trainer finished 02:15 EST (log dated today): +244 enriched, brain
  13,026/13,026 (embeddings.bin 13,222 vectors), purity gate PASSED
  (0.9130 vs 0.9150, regression 0.0020 ≤ 0.02), meaning catch-up 150,
  overrides applied 12,995.
- Redescribe staging: 89/89 new tracks staged with gemma4:12b tonight
  00:00–00:14 EST, 0 fails; `brain-descriptors.next.json` complete
  (NAS mtime 11-07 00:13). Staged-only confirmed — it wrote ONLY
  next.json plus a **properly-ledgered** mood prune at 00:00
  (brain-prune-ledger.jsonl: 12,784→12,782, ids 14079/14108; undo at
  mood-index.bin.prune.bak) — normal per the writer rule, not a writer
  event. **The gemma4 promotion queue item is still NOT queued — remains
  the top Jake ask after the grd-15 reword.**
- No early promotion (emb/mood NAS mtimes 02:15, before the 02:30 cutoff).
- Mood count fully accounted: 12,784 − 2 prune + 244 trainer = 13,026. ✓
- Snapshot `/tmp/brain-snap-20261107` sha-verified against NAS before+after
  copy; NAS re-verified UNCHANGED after measurement (end-of-run check).
  emb sha256 1a638d5a8550… (13,222 vec) · mood e3ce707798c3… (13,026 vec);
  harness brain_id 2a636c1afcf3 / mood_id b50a7e8eb262.
- Worktree wt-20261107 fresh from origin/brain-eval (a82b071b), removed after.

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag
churn 24/11,550 = 0.21% (needs >1%). Jake lane empty. Picked event in the
ledger, committed.

## Baselines (snapshot, bridge = production)

Main src sha MOVED: bba035366c8e → **c959335d2160** (expected — the
redescribe-window PRs #294/#295 merged to main). Routes IDENTICAL on both
rulers, so the bridge behavior is unchanged where it matters.

- **v1 (B1-20261107): retrieval 0.808 / grounding 1.000 / overall 0.904.**
  Identical to 11-06, a hair under the ×22 band (0.810–0.816) — add-churn,
  not a sentinel breach (rt<0.80 = NEW; not hit). Routes 8 mood / 7 main.
- **v3 (B3-20261107): headline 0.778 (11-06: 0.789), grounding 0.950 (20).**
  Groups: artist 0.963 / umbrella 0.904 / leaf 0.838 / family_decade 0.876 /
  tempo_family 0.455 / vibe 0.629. Routes IDENTICAL (29/94/1/30).
  Vocab stale guard 33 unresolved / 13,027 = 0.25% < 0.5% → passing.
  grd-15 failed exactly as diagnosed 11-06 ("cited 1 on a trap") — the
  deterministic Johnny B. Goode citation; all other grounding 19/19.

## Movers (7/174 vs 11-06 — small count, down-skewed, all mood-routed)

- v3-tempo-07 **0.76→0.44** (−0.32, the big one) — tempo_family 0.477→0.455
- v3-vibe-prod-002 **0.84→0.60** (−0.24)
- v3-vibe-ret-013 **0.93→0.73** (−0.20) — vibe 0.677→0.629
- v3-tempo-16 0.20→0.16, v3-vibe-prod-003 0.08→0.04 (1-slot each)
- Up: v3-leaf-24 0.88→1.00, v3-fdec-18 0.36→0.40 (main-routed)
- No route changes on any scored probe. Interpretation: 244 fresh mood
  vectors crowding top-k on tempo/vibe probes = the documented add-churn
  pattern (cf. 11-06's 20-mover down-skew on +125 adds). artist / umbrella /
  leaf / family_decade are flat — the brain's structure is stable; the
  churn is confined to the two weakest groups.
- **Watch, don't chase:** if tempo-07 / vibe-prod-002 / vibe-ret-013 do not
  partially recover as the new adds get their gemma4 descriptors + tempo
  lines, that's evidence for the tempo_family hypothesis work (still needs
  a NEW Jake-approved hypothesis — tempo in mood text or bpm-aware rerank).

## Applied

Nothing. No candidate was built (IDLE); the dual-run gate never ran.
Brain untouched end-to-end (shas re-verified post-measurement).

## Open Jake items (unchanged, priority order)

1. **grd-15 trap reword** (PROPOSAL-grd15-trap-staleness-colloquial-dance.md)
   — blocks ALL future applies while grounding pins at 0.950.
2. **Queue the gemma4 promotion item** — staging is complete ×2 nights
   (1,147 + 82 + 89 tracks); the dual-run gate should price the gemma4
   mood index BEFORE any --promote-next.
3. grd-16/grd-14 tolerant-parse (PROPOSAL-grd16-fenced-json-parse.md).
4. tempo_family gap (0.455 tonight, trending down) — needs a new hypothesis.
5. grd-12 legacy-tag re-tag; Plunderphonics vocab re-export.
