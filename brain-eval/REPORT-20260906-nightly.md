# Nightly brain exercise — 2026-09-06 (homemini)

**Outcome: (b) nothing beat the pre-registered bars — brain untouched
(embeddings sha a922565701f4…, mood sha b19351a1a8f8…, verified identical
to the measurement snapshot before and after the night's work), plus (c)
one new gated proposal: PROPOSAL-tempo-catchup-queue-order.md — last
night's "self-heals tomorrow" rationale is DISPROVEN and the fix is a
one-line trainer sort, Jake-gated.**

## State of the night

- Trainer clean (launchd 06:00:05–06:07:46Z): +50 enriched (10,135/10,593
  at trainer time; embeddings.bin 10,496 vectors), 500-track tempo
  catch-up (all 500 = aged te=2 re-encodes — see below), 150 meaning
  re-embeds. Overrides line byte-identical to my reconstruction
  (`applied 10144, skipped 103 stale`).
- Brain mtimes == trainer-done (02:07:41/02:07:46), stable ≥58 min before
  snapshot, snapshot copy verified stable-during-copy, and live shas
  still identical to the snapshot at end of night. **No replay fired all
  session** (second consecutive import night — still luck: STATE_FILE_NAMES
  is unfixed, PROPOSAL-mood-import-clobber remains the TOP ask).
- Wave still landing DURING the night: library.json re-pushed 02:40
  (trainer's 10,593 → 10,614 by measurement time).
- embeddings.bin cross-check vs .bak: tonight's file = yesterday's + the
  trainer's exact fresh-50, **zero new orphans** (the 146 standing
  embeddings orphans pre-date tonight — daytime wave churn, trainer never
  prunes that index; watch, don't chase).

## Pre-check + scan (no clobber, proven)

- Fingerprint: **12 orphans / 5 dup groups** — byte-for-byte the SAME
  benign signature as 09-05 (same contiguous 11338–11349 re-keyed block,
  same 4 benign dup classes) vs the replay signature ~125/60.
- Fidelity gate (aged key-trusted te=2 variant, wave-night rule):
  **50/50 min cos 1.0000** — reconstruction is exact.
- Full scan (10,350 embeds): **83 suspects = 49 fresh-tonight + 34 aged.**
  - The 49 fresh (ids 11643–11692) are tonight's cohort embedded before
    their librosa bpm landed in the 02:40 push — the documented
    metadata-arrival class (third wave night running). Not repaired:
    their metadata is still moving.
  - The 34 aged are **EXACTLY last night's watch item** (11467–11499 +
    454, 34/34 match): the trainer's tempo catch-up MISSED them. Root
    cause read from trainer source: `needTempo = filter(...).slice(0,500)`
    in library order with **8,481 te=2 tracks queued ahead** — fresh
    imports heal in ~17 nights, not 1. Class compounds every wave night.
    → PROPOSAL-tempo-catchup-queue-order.md (one-line sort, Jake-gated).

## Two candidates proven, NEITHER applied (bars honored)

Both built read-only, proven on the frozen 15-probe ruler + production
router emulation; **worst per-probe delta +0.00 on both** (no regression
anywhere):

| candidate | contents | router-truth | bar ≥0.83 |
|---|---|---|---|
| full | all 83 re-embedded + 12-orphan prune | 0.811 → **0.829** | **FAIL** |
| surgical B | aged-34 only (24h-settled: intended vectors cos **1.0000** vs last night's — repair == what the trainer will eventually write) + prune | 0.811 → **0.821** | **FAIL** |

Same verdict as 09-05 at the same 0.829: the 0.83 bar is pre-registered
and does not get adjudicated around at 3 AM. The rt ceiling ~0.82 during
the wave (09-04 note) stands — current 0.811 is wave depression, not
damage. When the queue-order proposal lands, this whole suspect class
self-heals on N+1 and the candidates become moot.

`repair_20260906_ids.json` marked **scan_only_not_applied** (loader-safe
keys). Forensics: /tmp/mood-index.candidate-20260906.bin (full),
/tmp/mood-index.candidateB-20260906.bin (surgical), /tmp/scan-20260906.log.

## Baseline + series

- run_eval (frozen snapshot, both keys 1-token-probed 200 first):
  retrieval **0.755** / grounding **1.000** / overall **0.877** — in-band,
  traps 4/4 clean. Row appended to score_log.jsonl.
- Router-truth series: 0.811 (09-04 0.818, 09-05 0.816 — mild drift down
  as un-enriched wave tracks accumulate; expected, watch).
- Skips: **990/1000** (mobile log; +112 during the day of 09-05, last
  write 14:43 — accrual accelerating). **The 1k re-test will likely
  arrive within days, not mid-Sep.** Note for the counter: desktop
  listening-log has been static since 05-25 (610 skips); the live stream
  is mobile-listening-log.jsonl — zero overlap between the two.
- NAS tmp litter 9 → 10 (benign).

## Watch for tomorrow

1. Standard pre-check — replay writer still unfixed; two lucky nights in
   a row is not a trend.
2. Aged-suspect count: expect ~83 (34 + tonight's 49) if no proposal
   lands and the wave's bpm settles — that is QUEUE BACKLOG, not a
   clobber. A clobber still announces itself as ~125 orphans/60 dups +
   median cos ~0.81 across a thousand+ aged tracks.
3. Skips ≥1000 → run the gated skip/taste re-test (taste-experiments-v3
   methodology, JT_STATE_DIR pointed at a frozen snapshot, +0.70 AUC
   bar). Use the mobile log; do NOT double-count the static desktop log.
4. If tonight's 49 (11643–11692) are still suspects tomorrow WITH settled
   bpm, they join the aged class — more weight behind the proposal, still
   not a clobber.
