# Nightly brain exercise — 2026-09-24 (homemini)

**Outcome: (b) — nothing beat baseline, nothing changed. Brain untouched**
(embeddings sha1 `129d7cee1475…`, mood sha1 `c2d2e2341437…`, verified before
measurement and re-verified after — identical sha + mtime; no writes to any
NAS state file).

Tonight was the 19th and FINAL pre-registered watchlist checkpoint (set 09-23).

## Pre-flight
- Trainer clean, launchd 06:00Z: **+0 enriched — "library fully enriched,
  nothing to do tonight"** (first such night; 10,939/10,939 = 100%, backlog 0).
  Tempo catch-up 119 (119 newly analysed + 0 older-encoding — the v2 re-encode
  well has run dry). Embeddings 11,091 vectors / mood 10,957. Brain mtimes =
  trainer write times (02:00), stable 65+ min before measurement; library.json
  untouched since 09-21 12:50 → zero-import night.
- Snapshot /tmp/brain-snap-20260924, byte-identical shas verified.
- Fingerprint precheck: mood 18 orphans / 1 dup group (n=4) — same benign id
  list a 10th consecutive night; embeddings orphans 152 steady. **20th
  consecutive no-clobber day** (clobber 15/30 import days; replay writer
  unfixed but idle 20 days).

## FINAL checkpoint — watchlist te→3: **PASSED exactly, watch CLOSED**
wl_final_20260924.py (id-level te diff vs /tmp/brain-snap-20260923): all
**20 survivors (exactly 11480–11499, queue positions 1–20) drained tonight**
— 0 survived, 0 joined, 0 absent. 19 data points, zero queue-order exceptions
across quiet nights, import waves, and analysis-wave queue-jumps. Appended as
the closing entry to PROPOSAL-tempo-catchup-queue-order (evidence complete;
decision Jake's). te census: 10,903 v3 / 31 v2 / 22 True / 39 False; the
te!=3 queue is down to 36. Cohort check (exp_20260924_stale_drain_check):
0→0, nothing joined — stays closed.

## Altimeter
- 1-token probes 200 first (Anthropic + OpenAI); run_eval on the frozen
  snapshot: retrieval **0.736** / grounding **1.000** (traps 4/4) / overall
  **0.868** — the established ruler-wobble band (0.736–0.740, same shape as
  09-18/20/21/22: identity-side one-slot spread, rt decomp zero-residual).
- Router-truth **0.821** — the predicted post-drain climb continues
  (0.802→0.804→0.815→0.811→**0.821**), right in the pre-registered
  0.815–0.826 window from last night's watch item. exp_20260924_sag_decomp:
  **SIXTEENTH orphan point +0.013** (S0 0.821 → S1 0.835, worst per-probe
  delta +0.00; ret-007 4 + ret-012 4 + ret-008 1 orphan slots), un-enriched
  **+0.000 a third night with `unenriched_in_lib=0`**, **S1 == S2 = 0.835**.
  0.821 + 0.013 ≈ 0.835: zero residual. The gap to the healthy band is now
  pure orphan tax by construction — nothing hidden.

## Experiments/changes applied
None. No candidate built: enrichment is 100%, the cohort is empty, the
watchlist is closed, and the single remaining lever (trainer-side mood-orphan
prune, +0.013–0.016 rt, sixteen-point-proven) is Jake-gated code the harness
must not touch. Default-to-do-nothing honored.

## Guards
- Taste-W guard PASS: v4 W line byte-identical in V3 src:89, Mobile
  backend/src:87, Mobile dist:63 — PROPOSAL-taste-weights-refresh-v4 premise
  intact.
- Skip gate not re-counted (09-16: organic 1,186/3,000, CLOSED).
- Brain re-verified post-run: embeddings 129d7cee1475 / mood c2d2e2341437,
  mtimes unchanged.

## Standing asks (unchanged)
1. PROPOSAL-mood-import-clobber fixes 4/5 + **trainer-side orphan prune**
   (+0.013–0.016 rt, SIXTEEN-point-proven — the only lever left).
2. PROPOSAL-tempo-catchup-queue-order — evidence COMPLETE at 19 points,
   awaiting Jake.
3. Taste-drift monthly re-run due ~10-13 (v4 script; re-diff deployed W first).

## Watch for 09-25+
No open falsifiable checkpoints remain — first time since 09-16. Standard
nightly only: clobber pre-check on import days; rt below ~0.80 without
orphan-slot growth = something NEW. The te!=3 tail (36) and v2 residue (31)
should finish draining in ~1–2 catch-up nights (no watch needed — the
mechanism is 19-point proven).

Snapshots kept: /tmp/brain-snap-20260923 + /tmp/brain-snap-20260924 (next
set-diff, if any, needs consecutive nights). Older snaps (0916–0922) are
eligible for cleanup.
