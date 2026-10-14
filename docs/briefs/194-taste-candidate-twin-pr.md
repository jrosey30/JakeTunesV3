# Brief 194 — Taste refit: candidate job + twin-PR generator

## Source / evidence
- Proposed briefs 160+, Brief 194 (steps audit §2/§3; the taste model
  improves in labs while the deployed W sits frozen — the beloved stable
  core's learning loop has to run through PRs).
- Verified against main `12bb43b24d49a146bc73489d945f34092878f707` (V3) and
  JakeTunesMobile main `8a9fac42aba297b203db231cb7ac1453c1193953`:
  - `scripts/taste-eval.py` measures the identity model every few days
    (5x5 CV, appends `auc_identity` to `taste-eval-history.jsonl`) and
    never refits. Confirmed.
  - W lives at `src/renderer/utils/tasteScore.ts:99` (V3) and
    `backend/src/util/tasteScore.ts:97` (mobile backend) — the two
    `const W = {...}` lines verified **byte-identical** on 2026-10-14.
    Its header documents how W is derived: "Weights re-derived on the
    full-rate basis (deployment parity)"; v5: "Refit on the matured-90d
    library (out-of-fold affinities, LogReg)".

## Documented deviation — the lab does not emit W
The brief pointed at `scripts/taste-experiments-v2.py` as the lab that
"emits W as JSON ~line 314". It does neither: the file is 119 lines, a
read-only AUC study of skip/behavior feature variants that prints means
and exports nothing (and it predates the deployed v5 feature set — it
has no intensity-in-sqrt-months form). Per the program's stop rule the
premise was corrected rather than improvised around: the candidate job
implements the refit protocol that IS documented in the repo —
tasteScore.ts's header (deployment-parity basis, out-of-fold affinities,
matured-90d fit) + taste-eval.py's dataset definition and 5x5 CV
protocol. Recorded here and in `taste-candidate.py`'s header.

## What changes
- **NEW `scripts/taste-candidate.py`** — the candidate job:
  - Dataset: taste-eval.py's exactly (starred positives; unstarred
    added before 2026-05-25 as negatives, subsample ≤1600, seed 42).
  - Features on the deployed basis tasteScore() actually computes:
    album/artist/genre/decade affinities (k=4), plays =
    log1p(playCount)/playMax, recency = 1 − days/3650, intensity =
    log1p(playCount)/√monthsOwned.
  - `candidateCvAuc`: repeated 5x5 CV (seed 0) with taste-eval's learner
    (StandardScaler + LogisticRegression C=0.2, class_weight balanced).
  - Final W: LogReg (same hyper-parameters) on out-of-fold affinity
    features over the matured-90d fit set, raw basis, no scaler — the
    coefficients ARE the deployed W shape, rounded to 3 dp.
  - `baselineCvAuc`: last `auc_identity` in taste-eval-history.jsonl.
  - Emits `taste-candidate.json` {W, candidateCvAuc, candidateCvAucStd,
    baselineCvAuc, beatsBaseline, generatedAt, nPos, nNeg, nFit,
    protocol, note} to the state dir (atomic write). A candidate that
    does not beat the baseline is still written, marked
    `beatsBaseline: false` — it never hides a result. It never edits
    tasteScore, never opens a PR, never deploys.
- **NEW `scripts/taste-candidate-pr.py`** — the twin-PR generator:
  - `--dry-run` (default): prints the EXACT unified diffs for both
    repos' tasteScore files and verifies the two W blocks are identical
    BEFORE and AFTER the would-be edit. Writes nothing.
  - Hard gates: pre-edit W drift → abort (fix drift first); post-edit
    mismatch → abort; `--apply` refuses a non-beating candidate unless
    `--allow-non-beating` is passed deliberately.
  - `--apply` (Mac, local clones + gh): edits both files, re-verifies
    the on-disk W before committing, pushes one branch per repo and
    opens twin PRs cross-referencing each other. It opens PRs only —
    merging is Jake's call.
- Brief 159's no-auto-refit decision stands, stated in both scripts and
  in the candidate file itself: nothing here deploys or merges; Jake's
  approval + the nightly W guard remain the gates.

## What does NOT change
- Neither tasteScore.ts copy is touched by this PR (in either repo).
- taste-eval.py is untouched; its history format is read, not written.
- No schedule is added here; if the candidate job is scheduled later it
  belongs in Brief 183's manifest as another entry.

## Done looks like
- Every few days a fresh `taste-candidate.json` exists saying, with
  numbers, whether a refit would beat the deployed W — win or lose.
- Promoting it is one deliberate command on the Mac that produces two
  reviewable PRs with byte-identical W blocks, or aborts loudly.

## Tests (run in the agent environment)
- `python3 -m py_compile` clean on both scripts.
- Candidate fixture run (synthetic 307-track library with a strong
  identity structure + fixture history with auc_identity 0.751;
  scikit-learn 1.9.1): exit 0, `candidateCvAuc 0.9864 ± 0.0146`,
  `beatsBaseline: true`, W emitted in the deployed key order/shape,
  `nFit 292` = 307 − the 15 immature (<90d) positives — the maturity
  filter demonstrably applied.
- Losing path: fixture baseline raised to 0.999 → candidate file still
  written with `beatsBaseline: false`. No result hidden.
- Generator dry-run HERE against pristine fetched copies of BOTH
  tasteScore.ts files at their real repo-relative paths: BEFORE check
  identical ✓; exact one-line unified diffs printed for both repos;
  AFTER check identical ✓; fixture files verified byte-untouched
  afterwards (dry-run writes nothing).
- Generator drift gate: one W value perturbed in the mobile fixture →
  abort, exit 1, "the twins have drifted" — no diffs produced.
- The candidate's first run against the REAL library is a manual step
  (below) — the fixture proves the machinery, not the real AUC.

## Manual steps (verbatim)
1. On the Mac (the taste jobs' environment), after merge:
   `python3 scripts/taste-candidate.py` — produces the first real
   `taste-candidate.json` in the state dir. Read its candidateCvAuc vs
   baselineCvAuc before doing anything else.
2. To promote a beating candidate:
   `python3 scripts/taste-candidate-pr.py` (dry-run — read the diffs),
   then `python3 scripts/taste-candidate-pr.py --apply` with local
   clones at ~/JakeTunesV3 and ~/JakeTunesMobile (or pass --v3-repo /
   --mobile-repo). Review and merge the twin PRs yourself — nothing
   merges automatically.
