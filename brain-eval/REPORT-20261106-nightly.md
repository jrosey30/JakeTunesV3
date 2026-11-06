# Nightly brain-eval — 2026-11-06 (homemini)

**Outcome: IDLE (20th consecutive) — baselines only, NOTHING applied, brain untouched.**
One NEW finding: trap v3-grd-15 went deterministically soft → grounding 0.950
→ **all future applies are blocked until the ruler is fixed** → urgent Jake
proposal `PROPOSAL-grd15-trap-staleness-colloquial-dance.md`.

## Pre-flight

- brain-trainer finished 02:13 EST (log dated today): +125 enriched, brain
  12,784/12,784, purity gate PASSED (0.9289 vs 0.9269, −0.0020 ≤ 0.02),
  meaning catch-up 150, overrides applied 12,752.
- Redescribe staging CAUGHT UP: 82/82 new tracks staged with gemma4:12b
  tonight 00:00–00:13 EST, 0 fails; `brain-descriptors.next.json` complete
  (NAS mtime 11-06 00:13). **The gemma4 promotion queue item is still NOT
  queued — remains the top Jake ask.**
- No early promotion (emb/mood mtimes 02:12:56 / 02:13:25, before the 02:30
  cutoff), no unlogged mood write (prune ledger last entry 11-04; tonight's
  mood delta = trainer +125, fully accounted: 12,659+125=12,784).
- Snapshot `/tmp/brain-snap-20261106` sha-verified against NAS before+after
  copy; NAS unchanged across measurement.
  emb sha256 09ac353d7a34… (12,978 vec) · mood c9c0fdde6bda… (12,784 vec).
- Worktree wt-20261106 fresh from origin/brain-eval (1f826d6a), removed after.

## Pick

`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag
churn 24/11,550 = 0.21% (needs >1%). Jake lane empty.

## Baselines (snapshot, bridge = production, main src bba035366c8e — unchanged since 11-05)

- **v1 (B1-20261106): retrieval 0.808 / grounding 1.000 / overall 0.904.**
  A hair under the ×22 band (0.810–0.816 / 0.905–0.908) — add-churn drift,
  not a sentinel breach (rt<0.80 = NEW; not hit). Routes 8 mood / 7 main.
- **v3 (B3-20261106): headline 0.789 (11-05: 0.795), grounding 0.950 (20).**
  Groups: artist 0.963 / umbrella 0.904 / leaf 0.835 / family_decade 0.875 /
  tempo_family 0.477 / vibe 0.677. Routes IDENTICAL (29/94/1/30).
  Vocab stale guard 33 unresolved / 12,784 = 0.26% < 0.5% → still passing.
- Movers 20/174 vs 11-05 — bigger and DOWN-skewed vs the usual balanced
  ~11 (15 down / 4 up + grd-15), consistent with tonight's heavier churn
  (+125 adds, 150 meaning re-embeds, override wave). All retrieval moves
  ±0.04–0.08 (1–2 slots). Sentinels: vibe-prod-006 gave back its ATH
  (0.84→0.76, back to the 11-03 level); tempo-13 slipped 0.32→0.24 (lost
  its recovery); leaf-20 0.88→0.84. tempo_family 0.485→0.477 — still the
  top open quality item, still needs a Jake-approved hypothesis.

## grd-15 forensics (the night's real finding)

Trap "Name some 1950s dance music songs I own." (Electronic & Dance +
1950–1959, 0 strict matches — verified in tonight's library) failed for the
FIRST time: "cited 1 on a trap". Reproduced read-only:

- 11-05 snapshot bridge context: 1 hit (Elton Britt country, 1955) → model
  named nothing → passed.
- 11-06 snapshot bridge context: 2 hits — **"Johnny B. Goode" (Chuck Berry,
  Classic Rock, 1959) newly surfaced** (old May add; tonight's re-embeds /
  override wave moved the retrieval) + Elton Britt (year override 1955→1956).
- Model cites Johnny B. Goode **3/3 re-asks**, reasoning rock'n'roll = dance
  music, and explicitly rejects the country song each time. Real track, in
  context, no fabrication — the model is behaving well; the trap's strict
  predicate doesn't match the question's colloquial reading.

NOT added to the grounding flake tally (that stays 7/22: grd-16 ×3,
grd-14 ×3, grd-12 ×1 — transport/formatting). This is a distinct,
DETERMINISTIC ruler-trap miscalibration. Because the gate requires
candidate grounding = 1.000, grd-15 pins grounding at 0.950 and blocks
every future apply → urgent Jake-lane proposal with 3 options
(recommended: reword to "1950s electronic dance music (EDM/techno/house)").
Ruler NOT touched tonight (v3 comparability freeze, Jake's lane).

## Applied

Nothing. No candidate was built; the live brain and NAS state are untouched
(shas above unchanged at end of run).

## Open Jake items (ranked)

1. **grd-15 trap reword** (NEW, urgent — deterministic apply-blocker) —
   pairs with the grd-16/grd-14 tolerant-parse proposal in one ruler PR.
2. **gemma4 promotion queue item** — staging 100% complete (1,147 + 82
   catch-up, 0 fails); queue it so the dual-run gate prices the gemma4 mood
   index before any `--promote-next`.
3. tempo_family gap (0.477) — needs a new hypothesis (tempo in mood text,
   or bpm-aware rerank).
4. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.
