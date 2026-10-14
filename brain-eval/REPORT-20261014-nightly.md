# Nightly brain report — 2026-10-14 (homemini)

**Outcome (a): E3 APPLIED.** The mood-text rebuild WITH the #110
family/umbrella genre line passed the dual-run gate (exit 0) and is live:
NAS `mood-index.bin` sha256 `2e84bd21b734…` (score_log mood_id
`bee4dfb077ac`), applied via temp-file + atomic rename, header self-verified
(EMBD v1, dim 1536, count 11,584, size exact). `embeddings.bin` untouched
throughout (sha256 `a174a607bd65…`, brain_id `6570041e2fc7`). Backup on the
NAS: `mood-index.bin.pre-E3-20261014` (sha256 `028b02ea0e93…`, verified).
**Undo = copy the backup back over mood-index.bin.**

**v3 production headline 0.742 → 0.805 — the biggest measured single-night
win of the v3 era**, exactly the headroom PROPOSAL-mood-umbrella-genre-line
priced on 10-13.

## Note on timing: this is the 03:05 job re-run at 11:22 ET

The 03:05 session on 10-14 violated the foreground rule (started the E3
rebuild in the background and ended at 03:08 — rebuild killed, nothing
measured, no report; the prompt now carries the rule). This run redid the
night start-to-finish in the foreground. Brain-trainer had finished at
06:00:36Z (+7 enriched, 11,584/11,584, embeddings.bin 11,740 vectors) and
both brain files sat untouched (mtime Oct 14 02:00 ET) from 02:00 until the
apply — no writer race. NAS shas re-verified unchanged immediately before
the apply.

## Pre-check

Snapshot `/tmp/brain-snap-20261014` sha-verified pre/post copy:
embeddings `a174a607bd65…`, mood `028b02ea0e93…`. Mid-run the snapshot was
extended with the NAS aux files (`artist-members.json`,
`metadata-overrides.json`, `lyrics.json`; no `audio-index.bin` on the NAS —
fusion off, as recorded) because the E3 method copies them into the
candidate if present and the trainer reads them. Both baselines were then
**re-run on the completed snapshot** (`B1b`/`B3b`): all 154 v3 retrieval
rows and all v1 rows **bit-identical** to the first pass — the aux files are
inert for retrieval, and the unchanged-brain determinism rule held. The only
diff was grounding trap v3-grd-16 scoring 0 on B3b with reason
`unparseable/no-LLM` — an LLM-call flake, not a fabrication (B3 scored it
1.000 with "named nothing (correct)"). The clean B3/B1 pair was used as the
gate base.

## Baselines (snapshot, production bridge, main src 12bb43b24d49)

- **v1 (`B1-20261014`): 0.810 / 1.000 / 0.905** — exactly the 10-12 normals,
  third confirmation night. Routes 8 mood / 7 main.
- **v3 (`B3-20261014`): headline 0.742, grounding 1.000 (20/20)**, primary
  source **bridge**, routes main 29 / mood 94 / mood+lexicon 1 /
  main+decade 30 — identical profile to 10-13. Groups: artist 0.963,
  umbrella_family 0.913, leaf 0.517, family_decade 0.872,
  tempo_family 0.475, vibe 0.711.

## The experiment: E3 picked, measured, APPLIED

`pick_experiment.py pick` → **E3** (auto lane, prio 70, requeued 10-13 with
a new hypothesis after JakeTunesV3 #110/#112 shipped the leaf+family/umbrella
genre line into `brain-trainer.mjs` — the `genreWithParents(` precondition
grep confirmed the live trainer carries it). E1 skip (bare backlog 0),
E2 skip (genre-tag churn 0.00%).

Candidate build per the method: scratch copy `/tmp/brain-cand-E3-20261014`,
`JT_STATE_DIR=$S node scripts/brain-trainer.mjs --rebuild-mood-index`
(11,584 vectors re-embedded in 75 s, foreground), then `embeddings.bin`
restored from the snapshot — mood-only change, candidate mood sha
`2e84bd21b734…`.

### Candidate v3 (`C3-E3-20261014`): headline **0.805**, grounding 1.000

| group | base | cand | Δ |
|---|---|---|---|
| artist | 0.963 | 0.963 | 0.000 |
| umbrella_family | 0.913 | 0.916 | **+0.002** (10-13's −0.033 repaired) |
| leaf | 0.517 | 0.844 | **+0.327** |
| family_decade | 0.872 | 0.872 | 0.000 |
| tempo_family | 0.475 | 0.510 | +0.035 |
| vibe | 0.711 | 0.723 | +0.013 |

### Gate (`/tmp/gate-E3-20261014.json`, exit 0 — all checks green)

- **v3:** mean per-probe Δ **+0.1110** (need ≥ +0.005) over 154 probes;
  90% paired bootstrap **[+0.0800, +0.1429]** (lower bound > 0); worst
  group +0.000 (no drop); candidate grounding **1.000** measured.
  Churn 52 up / 10 down / 92 same.
- **v1 bar:** retrieval/grounding/overall all bit-equal
  (0.810 / 1.000 / 0.905). mood-index.bin changed → mood rule: **ret-014
  −1/30 is the only mood-routed drop and the mood-routed mean improves
  +0.0308 over 8 probes — allowed under Jake's 10-13 one-slot rule**
  (applied by gate.py, not by hand).

This reproduces the 10-13 pricing almost digit-for-digit (+0.110,
CI [+0.079, +0.142], ret-014 the only drop) — the fix behaved exactly as
priced. Hypothesis's own bars also met: leaf ≥ 0.80 (0.844),
umbrella ≥ base − 0.01 (+0.002), grounding 20/20.

### Apply

NAS mtime+size+sha re-checked unchanged since measurement → backup
`mood-index.bin.pre-E3-20261014` written and sha-verified → candidate copied
to `mood-index.bin.tmp-E3`, sha-verified, atomic `mv` → post-apply
self-verify: sha matches candidate, header EMBD v1 / dim 1536 /
count 11,584 / size 71,218,444 exact. Ledger `record --outcome applied`
with the gate JSON; queue E3 → `applied`.

## New reference numbers (production, homemini)

- **v3 headline 0.805** (was 0.742) — leaf 0.844, umbrella_family 0.916,
  tempo_family 0.510, vibe 0.723, artist 0.963, family_decade 0.872;
  grounding 1.000; mood-index diagnostic 0.475 → 0.561.
- v1 unchanged: 0.810 / 1.000 / 0.905 (a mood-only change is invisible to
  the v1 topline by design; its win shows on the v3 production path).
- Live brain: embeddings.bin `a174a607bd65…` (11,740 vectors), mood-index.bin
  `2e84bd21b734…` (11,584 vectors). Previous mood index preserved as
  `mood-index.bin.pre-E3-20261014`.
- The remaining production gap is now **tempo_family 0.510** (main-idx
  diagnostic 0.110) — E7 (reranker genre-bonus sweep) and E10 (leaf queries
  reach the index that knows them, prio 70) are the queued Jake-lane items
  pointed at the rest of it.

## For Jake

- PROPOSAL-mood-umbrella-genre-line is **resolved — shipped (#110/#112) and
  now measured + applied**: +0.063 v3 headline on the production path, the
  full priced headroom realized with zero regressions.
- v3-grd-16's one-off `unparseable/no-LLM` flake (baseline-full re-run only)
  is worth an eye if it recurs: a grounding-runner retry on transport
  failure would stop a flake from ever masquerading as a fabrication.
- Nothing else was run: one queue item, no side experiments, no new series.
