# Nightly brain exercise — 2026-10-12 (homemini)

**Outcome: (a) — a proven, reversible improvement APPLIED to the live main
index (taxonomy text refresh, measured +0.015 retrieval / +0.009 rt with
zero production-path regression), plus a grounded ruler recalibration.
Mood index untouched.**

Measured from /tmp/brain-snap-20261012 (×3-sha256 stable over 40s before
copy: embeddings.bin 163b3f52eeef 71,415,180 B, mood e0664314ac52
70,456,092 B; NAS mtimes 02:01 = trainer-done; library.json last written
10-11 23:15 ET = the import, no post-trainer replay). Pre-apply score_log
brain_id **4427331cef3c** (11,616 vec); post-apply **c5c6eb10ab1d**
(11,716 vec).

## THE EVENT: taxonomy night (Jake's rollout, landed 10-11 23:15 ET)

The laptop metadata-overrides refresh (applied 11,345→11,558, stale 58→2)
shipped the smart genre taxonomy into library.json: **7,189 of 11,560
tracks changed genre tag** — coarse roots exploded into fine leaves
(Rap 1250→0, Funk/Soul 165→0, Electronic 734→0, Classic Rock 1073→634;
born: Midwest/East Coast/West Coast Rap, Hard/Glam/Prog Rock, Dance-Punk,
Synth-Pop…). Zero existing vectors changed bytes overnight, so 62% of
main-index embed texts (and the mood texts' genre line) woke up speaking
LAST season's taxonomy while library.json — the eval ruler AND the 6.0
reranker's lexical source — speaks the new one.

## 1. Ruler recalibration (instrument repair, committed)

run_eval fell 0.781→0.731 entirely on ret-006 (0.92→0.40) and ret-011
(0.60→0.12); rt read 0.762 (<0.80 rule fired). Adjudicated NOT a brain
regression: last night's bytes score identically under today's ruler
(diag_newvec_20261012), and ret-011's "0.00 mood route" was a top-25 of
Funkadelic/James Brown/Parliament/Curtis Mayfield scored all-miss because
the literal tag 'Funk/Soul' no longer exists. The ret-015 lesson again:
brain right, ruler broken.

Fix grounded in the empirical migration matrix (where each predicate's
10-11 cohort actually went — diag_ruler_20261012, no invented mappings):
- **ret-011** genre_any ['funk/soul','funk rock'] → **['funk','soul','motown']**
  (522 matches: Funk Rock/Funk/Modern+Classic Soul/Neo-Soul/Motown/Nu Funk).
- **ret-006** 'classic rock' + the leaves its 1073-track cohort migrated to
  (hard/prog/glam/southern/psychedelic/americana/blues/yacht rock; 467
  matches in 1970–79).
All other predicates survive by substring (Pop-Punk, Midwest Rap, French
House…). ret-015 ROSE honestly (0.53→0.70) — fine leaves credit its
already-correct top-30.

**Post-recalibration baseline (pre-apply): 0.795 / 1.000 / 0.898; rt 0.852
(≥ the 10-11 ATH 0.849); mood-routed mean 0.790.** The scare was entirely
the instrument.

## 2. The bounded experiment: stale-text refresh

Candidate built with the REAL trainer (`--reembed-all`, JT_STATE_DIR →
scratch copy — Jake's own 10-10 method; grounded: texts come only from
library.json + existing descriptors).

| | retrieval | overall | rt | mood-routed | verdict |
|---|---|---|---|---|---|
| baseline (fixed ruler) | 0.795 | 0.898 | 0.852 | 0.790 | — |
| full reembed-all (both indexes) | 0.810 | 0.905 | 0.849 | 0.769 | **REJECTED** — ret-007 mood 0.44→0.16: the ~100 vectorless imports got bare tempo+genre mood vectors; bare-in-top25 14→21 (diag_cand_ret007) |
| **v3 = main index only** (mood byte-identical) | **0.810** | **0.905** | **0.861** | 0.790 (=) | **APPLIED** |

v3 production routes: every mood route identical by construction; main
routes ret-006 0.88→**0.96**, ret-012 0.80→**0.85**, artists 1.00 flat.
**rt 0.861 = new all-time high.** The only dips are main-INDEX readings on
mood-routed probes (ret-007 0.88→0.84, ret-011 0.60→0.52) — the
doctrine-accepted PR #66 class (coarse query words lexically match the
stale coarse tags better; production never serves those queries from main).
Grounding 1.000 incl. all traps, both runs.

## Apply ledger (exact undo)

- Pre-apply re-verify: NAS emb sha 163b3f52eeef / mtime 02:01:26 UNCHANGED
  since measurement; mood e0664314ac52.
- Backups ON the NAS: `embeddings.bin.pre-taxrefresh-20261012`
  (sha256 163b3f52eeef, verified) + `brain-descriptors.json.pre-taxrefresh-20261012`.
  (Descriptors turned out byte-identical to candidate — 72c820f10326 — the
  10-10 reembed-all had already set all te flags; only embeddings.bin changed.)
- Write: cp → `embeddings.bin.taxrefresh.tmp` → sha verified 99d0de2fdc27 →
  atomic `mv` over live.
- Post-verify: live = 99d0de2fdc27, 72,029,980 B, EMBD v1 dim 1536 count
  11,716, unit norms, **byte-identical to the measured v3 candidate**;
  mood sha unchanged e0664314ac52.
- **UNDO = `cp embeddings.bin.pre-taxrefresh-20261012 embeddings.bin`** (NAS
  state dir); /tmp/brain-snap-20261012 holds a second pristine copy.
- The +100 added main vectors are tonight's vectorless imports gaining
  complete plain vectors (main text needs no descriptor) — they become
  searchable on main routes; mood stays absent for them (absent > bare,
  measured).

## Watches & proposals moved tonight

- **ret-007 bare-in-top25 did NOT fall: 14→14** (diag_ret007_20261012),
  recall 0.44 static. Mechanism found in the precheck: the trainer's 50-batch
  went ENTIRELY to the newest imports (adds 12663–12712, 0 existing vectors
  changed) — the 227-track bare cohort drained by ZERO on an import night.
  "Self-heals ~50/night" is falsified while imports keep landing: the enrich
  queue starves the oldest bare tracks. Evidence appended to
  PROPOSAL-enrichment-backlog-drain (+ queue-order proposal). Backlog
  236→327 (compounding 4th night; 100 vectorless + 227 present-but-bare).
- **Mood-side taxonomy staleness deliberately NOT fixed**: measured HARMFUL
  tonight (full-candidate mood refresh: ret-007 −0.28, mood-routed −0.021).
  Sequencing note filed: drain the bare cohort FIRST, then refresh mood
  texts (one trainer `--rebuild-mood-index` after backlog ≈ 0) — Jake-gated.
- Import-day pre-check: mood orphans 0 / same 8 benign un-enriched dup
  groups (30 tracks) / emb orphans 156 steady / +50/+50 adds all-in-lib =
  **guard-proof night 6**.
- Taste-W guard PASS ×3 (V3:89 / Mobile src:87 / dist:63, byte-identical).
  **Taste-drift monthly DUE TOMORROW ~10-13** (v4 script; W pre-diff PASS).
- Skip gate: organic 750 mobile + 610 desktop = **1,360/3,000 CLOSED**
  (+10); no new bursts (15/2,342, latest still 10-11T00:34Z).
- score_log tonight: 0.7311 (pre-recal, broken ruler — comparability note:
  the 0.781 row and older are on the OLD ruler) → 0.7951 (recalibrated
  baseline) → 0.8104 ×2 (candidate, then v3 = applied brain c5c6eb10ab1d).

## Watch 10-13

1. **Taste-drift monthly (v4)** — due; re-diff deployed W first (Mobile's W
   lives in backend/src).
2. Trainer night on the refreshed brain: expect +50 adds (ids ≥12713 or the
   vectorless 100), 0 changed-bytes beyond the enrich batch; bare-in-top25
   falls ONLY if the batch reaches the old cohort — another all-new-ids
   night is more starvation evidence, not an anomaly.
3. New normals (recalibrated ruler + refreshed main): run_eval
   **0.810/1.000/0.905**, rt **0.861**, mood-routed 0.790. rt<0.80 = NEW
   still stands. ret-013/014/015 low on main remains BY DESIGN.
4. If Jake ships another re-tag wave (taxonomy still rolling out), re-run the
   migration-matrix check before trusting any probe drop; a main-index
   refresh after a tag wave is now a PROVEN, repeatable nightly move (this
   report is the recipe).
