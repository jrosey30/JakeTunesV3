# Nightly brain report — 2026-10-13 (homemini)

**Outcome (b): nothing applied, brain untouched.** The picked item (E3,
mood-text rebuild) was measured and **REJECTED by the dual-run gate** despite
a +0.111 mean v3 delta; the regression mechanism is understood and filed as
PROPOSAL-mood-umbrella-genre-line.md. Live brain byte-identical before and
after: embeddings.bin sha256 `c2f0f9a75275`, mood-index.bin `5428c156dfaf`
(score_log brain_id `e91acab6930c`, mood_id `9468e89e55c6`), NAS mtimes
frozen at Oct 13 02:00 throughout.

## The night's headline: PR #105 drained everything, production hit an ATH

The trainer ran twice: 10-12 23:29 ET (first budget-bounded PR #105 run,
**+328 enriched in 7m51s** — the whole compounding backlog including the
227-track bare-mood cohort) and launchd 02:00 (+16). Library
**11,577/11,577 enriched, backlog 0**; mood index **11,577/11,577 =
first-ever complete coverage**, 0 orphans / 0 dups / 0 missing.

- **rt 0.891 = ALL-TIME HIGH** (0.861 → 0.891), mood-routed mean
  0.790 → **0.839** over 9 probes. ret-007 mood 0.92→(baseline) — the
  bare-slot pollution is gone without any index surgery.
- run_eval baseline **0.810 / 1.000 / 0.905** — exactly the 10-12 new
  normals, first confirmation night of the recalibrated ruler + refreshed
  main index.
- v3 baseline **headline 0.742, grounding 1.000 (20/20)**, primary source
  **bridge** (production path), routes main 29 / mood 94 / mood+lexicon 1 /
  main+decade 30. First v3 night on homemini; comparable to the 10-12
  laptop baseline 0.743.

## Pre-check (guard-proof night 7)

Snapshot `/tmp/brain-snap-20261013` sha-verified ×3 (pre/post/live).
Id-level diff vs the 10-12 PRE-APPLY snap adjudicated clean: main 9,723
changed = the known applied taxonomy refresh; mood changed **exactly 227 =
the bare cohort** re-embedded with descriptors; +117 adds both indexes,
all-in-lib, 0 removed, 0 orphan adds. emb orphans 156 steady-benign.
te census: 3:11491 / 2:27 / True:22 / False:109.

## The experiment: E3 picked, measured, rejected

Pick log: E1 skip (bare_backlog 0 — its premise drained), E2 skip (0% tag
churn), **E3 ELIGIBLE** (bare ≤ 25) — the 10-12 sequencing rule's step 2.

Candidate: trainer `--rebuild-mood-index` on a scratch copy (11,577 mood
vectors re-embedded with taxonomy-era genre lines, ~60 s), snapshot
embeddings.bin restored (mood-only change, per `touches`).

| | baseline | E3 candidate |
|---|---|---|
| v3 headline | 0.742 | 0.804 |
| v3 leaf | 0.518 | **0.854** |
| v3 umbrella_family | 0.913 | **0.880** ❌ (−0.033 > 0.01 limit) |
| v3 grounding | 1.000 | **0.950** ❌ (v3-grd-11 fabrication) |
| v1 topline | 0.810/1.000/0.905 | identical |
| v1 worst mood probe | — | **ret-004 −0.25** ❌ (ret-006 −0.16) |

gate.py exit 1 (mean Δ +0.1107, CI [+0.0791, +0.1432] both PASSED; failed
group_drop + grounding + v1_mood_per_probe). **Candidate discarded**;
recorded `rejected` in experiments/ledger.jsonl.

**Mechanism:** old mood texts carry coarse pre-taxonomy tags ("Pop", "Rap");
the rebuild wrote fine leaves, so umbrella-level query tokens ("pop music"
0.80→0.44, "jazz and world music" 0.76→0.56) literally left the texts — the
mirror image of the leaf win. Fix = genre line carrying leaf + family/
umbrella (`genre: Synthpop (Pop)`), a `moodText()`/`buildMoodText()` twin
change → **PROPOSAL-mood-umbrella-genre-line.md** (pre-registered pricing
protocol + numbers to beat inside). E3 may be requeued only with that
proposal's numbers as the NEW hypothesis, after Jake ships the twins.

## Guards & gates

- Taste-W guard **PASS ×3** (V3:89 / Mobile src:87 / dist:63 byte-identical).
- Skip gate recount (forensics standard): merged organic **1,392/3,000
  CLOSED** (+32 since 10-12); no new mechanical bursts (15/2,342, latest
  still 10-11T00:34Z); listen log alive.
- Both API keys 1-token-probed 200 before any paid run.
- **Taste-drift monthly v4 was DUE today and deliberately NOT run**: the
  one-item-per-night rule bound tonight to E3 (auto). With E1/E2 precondition-
  blocked and E3 now rejected, the next pick falls through to the jake lane —
  the drift pricing (E5) runs as that MEASURE night (E10, prio 70, may go
  first).
- `experiments/state/main-index-tags.json` was MISSING (dir never committed);
  recorded tonight from the snapshot via `record-tags` (11,577 tags). Caveat:
  the main index was last embedded 10-12, so tonight's recording is ~16 adds
  fresher than the true embed-time tags — immaterial (<0.2%), and it will be
  re-recorded after every E2 apply.

## Proposals moved

- **PROPOSAL-enrichment-backlog-drain: RESOLVED by PR #105** (first budget
  run drained 328; resolution note appended; archive is Jake's call).
- PROPOSAL-tempo-catchup-queue-order: enrich-queue half moot (note in the
  same appendix); tempo-ordering nuance still open.
- **NEW: PROPOSAL-mood-umbrella-genre-line** (from the E3 rejection) — the
  single largest measured headroom: ~+0.11 v3 mean / leaf +0.34 available
  once the umbrella loss is repaired.

## Watch 10-14

1. Next pick is a jake-lane MEASURE night (no auto item eligible): E10
   (leaf routing, prio 70) then E5 (taste-drift v4, prio 60 — overdue).
2. Trainer nights are now budget-bounded: expect every new add absorbed
   same-night; a reappearing backlog >50 on a quiet night = NEW.
3. Normals unchanged: run_eval 0.810/1.000/0.905; **rt band now 0.891**
   (rt<0.80 = NEW stands, with headroom); v3 baseline 0.742 on homemini.
4. Mood index is complete — any future mood orphan/dup/missing ≠ 0 in the
   precheck is a real writer event, zero tolerance.

Snaps kept: 20261012 + 20261013 (20261011 + /tmp/brain-cand-E3-20261013
deleted). score_log rows tonight: B1/B3 (baseline), C1-E3/C3-E3 (rejected
candidate, mood_id ccf75431559e).
