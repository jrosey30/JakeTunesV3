# Nightly brain exercise — 2026-08-07 (homemini)

**Outcome: nothing beat baseline → NOTHING APPLIED.** Two counterfactual
candidates were built and measured in full isolation (/tmp scratch dirs);
both were refuted and discarded. `embeddings.bin` on the NAS was never
written: sha `b2710b4321e7` / mtime 20:12 / 55,830,000 bytes identical
before and after the run. All numbers below are from the real harness
(`run_eval.py`) on a frozen snapshot (same `library.json` for every run).

## Preconditions
- brain-trainer finished 06:06Z: "library fully enriched — nothing to do".
- Run happened ~20:30 EDT (off-schedule trigger, not 3 AM). Jake was
  actively using the app (play logged 20:06, library.json written 20:30),
  so **no live-brain write was permissible tonight regardless** — the
  desktop→NAS sync wrote embeddings.bin at 20:12. Measure-and-propose was
  the ceiling from the start.
- Library grew to 9,078 tracks (~200 added today); brain 9,081 vectors
  (3 orphans — healthy).

## Baseline (brain b2710b4321e7)
retrieval **0.762** · grounding **1.000** · overall **0.881**
(07-12 known-good was 0.822 / 0.911 on a library ~200 tracks smaller.)

Per-prompt vs 07-12 where recorded:
- ret-013 (fast workout, bpm≥130): 0.80 → **0.87** (improved)
- ret-014 (slow mellow late-night, bpm≤85): 0.80 → **0.23** (collapsed)
- ret-015 (aggressive, punk/grunge/metal): 0.67 → **0.47** (drifted)

## Diagnosis (read-only top-30 dumps)
- **ret-015 is NOT a brain problem.** Top-30 = Pantera, SOAD, Motörhead,
  I Prevail, RATM, Judas Priest, AC/DC, QOTSA, Refused — qualitatively
  perfect. Every "miss" is an aggressive band genre-tagged plain
  "Rock"/"Alternative" — the documented 07-12 ruler residual. Score
  wobble is composition churn, by design.
- **ret-014 collapsed to literal title matching.** Top-30 polluters are
  overwhelmingly night/chill-TITLED fast songs: "Nights" (161 bpm),
  "Wednesday Night Interlude" (136), "After Dark" (142), "Late Night
  Talking" (116), "3AM", "Good Night" (133), "Chillin'" (125). Zero of
  today's 200 new tracks and zero un-enriched tracks in the top-30.
- Timeline suspect: commit `b2f855c` (2026-07-26, "key/mode in, fake
  energy out") rewrote `tempoEnergy()`: fast+minor tracks (1,832) gained
  the phrase **"driving late-night"**, and slow tracks lost the old
  "mellow and calm … late night … chilling" vocabulary that previously
  sat on exactly the bpm≤85 set. The old 0.80 was partly vocabulary
  alignment between the old encoding and the eval predicate.

## Experiment (one exercise, two arms, both in-memory, both DISCARDED)
Embed-text reconstruction was verified byte-perfect first (cosine 1.0000
vs stored vectors on 6 samples incl. meaning-line tracks). 36 bare
desktop-embedded tracks failed the fidelity gate and were excluded.

**Arm A1** — remove "late-night" from the fast+minor "good for:" clause
(1,796 vectors re-embedded, sha `828b5e98fb06`):
ret-014 0.23→0.27 only; **regressions** ret-013 0.87→0.83, ret-007
0.76→0.72, ret-008 0.88→0.84. Net retrieval 0.762→**0.759**. REFUTED.

**Arm A2** — restore "mellow, chilled-out" to the b<88 tempo adjectives
(770 vectors re-embedded, sha `191ddca811a9`):
ret-014 0.23→0.27 only; **regression** ret-011 0.48→0.44. Net retrieval
0.762→**0.761**. REFUTED.

Conclusion: single-clause vocabulary edits measurably CANNOT recover
ret-014 — title-word similarity dominates at this cosine scale. Any
"fix" that forces it would be teaching the ruler's vocabulary to the
index (the exact failure mode the 07-12 postmortem warns about).

## The finding that matters: production is healthier than ret-014 implies
The user-facing vibe path routes through **mood-index.bin**, whose text
is identity-stripped (descriptor + tempo + genre — **no titles**). Same
query probed against the mood index: **15/30** bpm≤85 hits vs the
identity index's 7/30, with a clean slow-track top-15 and zero title
pollution. ret-014 is scoring a mood-intent query against the identity
index; the index users actually hit for that intent is roughly 2× better.

## Gated proposals for Jake (nothing executed)
1. **Ruler question, your call:** should the enrichment-sensitive
   prompts (ret-013/014/015) score `mood-index.bin` instead of (or
   alongside) `embeddings.bin`? That measures the index that serves the
   intent. It resets score comparability, so it's a deliberate decision,
   not a nightly tweak. (Precedent: the 07-12 ret-015 recalibration.)
2. The suggested skip-signal taste experiment was **not re-run**: it was
   already tested by `scripts/taste-experiments-v2.py` (skip-rate feature
   AND skips-as-hard-negatives) and refuted — production `tasteScore.ts`
   header records "skips don't help". Skip events have only grown
   ~460→493 since; no reason to expect a flipped verdict.
3. Verified benign, no action: "meaning catch-up: 150" appearing two
   nights running is the MEANING_CAP=150 draining a large backlog
   (6,617/8,899 done), with per-track persistence confirmed in code.
   Also note `scripts/brain-trainer.mjs` carries 139 uncommitted lines
   on the main checkout — worth committing when convenient.

## Score log
Four rows appended to `score_log.jsonl` this run: live baseline
(b2710b), frozen base (b2710b), candidate A1 (828b5e), candidate A2
(191ddc). Candidates were scratch-only and no longer exist as files.
