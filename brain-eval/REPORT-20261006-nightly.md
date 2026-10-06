# Nightly brain exercise — 2026-10-06 (homemini)

## THE NIGHT'S HEADLINE: the trainer-side orphan prune SHIPPED and DELIVERED — orphan tax 0.000, rt 0.835 (the predicted S1/S2 ceiling). Nineteen data points of evidence, closed by measurement.

First nightly since 09-27. The 09-28..10-05 gap: brain-trainer went FATAL nine
consecutive nights ("library.json or embeddings.bin missing — is the NAS
mounted?", log 2026-09-27..2026-10-05 06:00Z) — the NAS mount never came back
after the 09-27 power blip at the 02:00 hour. No nightly eval ran either.

## What changed while we were dark (main branch, all Jake-side ships)

Three of the standing TOP asks landed as code:

1. **`34ba4de` "brain-trainer: prune vibe vectors for songs that left the
   library"** — THE eighteen/nineteen-point-proven lever
   (PROPOSAL-mood-import-clobber appendix). Trainer now prunes mood-index
   orphans each run, writes `brain-prune-ledger.jsonl` + a
   `mood-index.bin.prune.bak` undo copy. Tonight's ledger: 19 ids pruned at
   02:27Z (the benign-18 list + 09-27's id 12071) + 1 more (12128) at 06:00Z.
2. **`ecba7d1` "brain-trainer: wait up to an hour for the NAS"** —
   PROPOSAL-nas-mount-resilience (trainer half). Tonight the trainer ran clean
   at its launchd hour for the first time since 09-26.
3. **`5baa13e` "Auto-backup: a machine that is behind the NAS never pushes" +
   `309b375` "Brain files flow one way: the laptop adopts homemini's brain,
   never pushes its own"** — the replay-writer clobber fixes
   (PROPOSAL-mood-import-clobber fixes 4/5, upgraded to TOP ask after the
   09-27 library.json stomp). Stale-push guard + one-way brain adoption,
   with tests.

## Pre-flight (all clean)

- Trainer: TWO clean runs tonight (02:27Z catch-up + 06:00Z launchd); nine
  dark nights absorbed in one go — enrichment **11,033/11,033 = 100%,
  backlog 0** same-night. te census: 11,008 v3 / 27 v2 / 22 True / 46 False.
- library.json FRESH: 11,033 tracks, 42 playlists, max dateAdded
  2026-10-06T02:37Z — the 09-27 replay-stomp watch (max-dateAdded-first) PASSES;
  no stale replay since the guards shipped.
- Snapshot: `/tmp/brain-snap-20261006` (emb `593283fb28bd` 68,777,688 B /
  mood `d5bda6475bd5` 67,830,896 B, ×-verified vs NAS, mtimes stable ≥60 min).
- Fingerprint (precheck_20261006.py): **mood-index 11,033 vectors == library,
  orphans 0, dup groups 0, in-library tracks without a mood vector 0** — the
  prune removed exactly the dead ids and ate nothing live. embeddings.bin
  11,187 vectors / 154 orphans (152 steady + 09-27's additions; identity-index
  orphans measured exactly 0.000 on this ruler 08-10 — not a concern),
  0 in-lib missing.
- Keys probed 1-token first: OpenAI 200, Anthropic 200.

## Measurements (frozen snapshot; shas re-verified unchanged after)

| metric | 09-27 (last reading) | tonight | read |
|---|---|---|---|
| run_eval retrieval | 0.736 | **0.734** | hair below the 0.736 band floor — the familiar one-slot wobble shape (09-18/20/22/26); shas changed massively tonight (nine nights of churn + prune), content churn as proven by the 09-25 A/A calibration |
| grounding | 1.000 | **1.000** (10/10 incl. 4 traps) | clean |
| overall | 0.868 | **0.867** | in-band |
| router-truth rt | 0.832 | **0.835** | series 0.802→0.804→0.815→0.811→0.821→0.819→0.832→**0.835** |
| orphan component | +0.003 | **+0.000 — TWENTIETH and CLOSING point** | S0==S1==S2==0.835; orphan slots 0 on every watched probe (007/008/011/012/014/015 all 0/0) |
| un-enriched component | +0.000 | **+0.000** | unenriched_in_lib = 0 |

**The prune story closes exactly as predicted.** The 09-16→09-24 forecast was:
cohort drains → rt ~0.828–0.835 with the residual gap = pure orphan tax
(+0.013–0.016), removable only by a trainer-side prune. The prune shipped;
tonight S0==S1: there is NO orphan tax left to remove, and production rt sits
at the former S2 ceiling, 0.835. Per-probe S0≡S1≡S2 identical on all 15.
The remaining distance to 1.0 is the documented wrong-index ruler artifacts
(ret-006 0.64 / ret-012 0.35 / ret-014 0.33 — P1/P3 proposals, Jake-gated)
plus genuine single-vector blend costs.

## Guards

- **Taste-W guard PASS ×3** — V3 src/renderer/utils/tasteScore.ts:89,
  Mobile backend/src/util/tasteScore.ts:87, Mobile dist/util/tasteScore.js:63 —
  byte-identical W line (refresh-v4 proposal premise intact).
- **Skip gate recount (forensics standard): organic 666 mobile + 610 desktop
  = 1,276/3,000 — CLOSED, zero new events since 09-26.** No new mechanical
  bursts (still 14 sessions / 2,237).

## 🚩 NEW FLAG: mobile-listening-log.jsonl FROZEN since 2026-09-26T03:20:06Z

Ten days with zero events — while mobile-plays.json (mtime tonight 00:04),
mobile-stars.json (Oct 5) and mobile-playlists.json all advance. So the phone
IS being used and the backend CAN write the state dir; only the /api/listen
stream is silent. Read-only diagnosis tonight:

- The LAST logged event is the FINAL skip of the 09-26 mechanical burst
  (03:13→03:20Z, 46 skips) — the freeze boundary IS the burst boundary.
- Backend route (listen.ts) + sidecar fence unchanged since 09-13 (git log);
  backend restarted Oct 5 22:19 (09-27 reboot wiped /tmp logs), serving fine,
  no per-request logging to confirm/deny incoming POSTs.
- Most likely CLIENT-side: whatever ended the 09-26 cascade session also
  stopped the iOS app's /api/listen reporting (same event loop?). Cannot
  distinguish "app stopped POSTing" from "route 500s on the fence" without an
  active probe that would pollute the ground-truth log — declined.
- CONSEQUENCES if it stays frozen: the skip gate (1,276/3,000) can never
  advance; Year-in-Review/KPI phone parity silently degrades; the
  failure-cascade evidence stream goes dark. Appended to
  PROPOSAL-mobile-failure-skip-cascade — needs an iOS-side check (does the
  app still fire /api/listen?) or one authorized marked probe POST.

## Outcome

**(b) — brain untouched (emb `593283fb28bd`, mood `d5bda6475bd5`, ×-verified
before + after); nothing I ran beat anything, because the one lever left was
already pulled — and tonight's pre-registered check PROVES it paid
(+0.013–0.016 predicted, +0.014 realized vs the 0.821 pre-prune plateau,
orphan tax now structurally 0.000).** The orphan-prune evidence series
(nineteen points + tonight's closing zero) is COMPLETE AND RESOLVED — stop
collecting it. Standard nightly watch going forward: clobber pre-check on
import days (now guarded by 5baa13e/309b375 — watch them work, don't assume),
rt <0.80 = something NEW (no orphan excuse remains), taste-drift monthly due
~10-13, listening-log freeze flag above.

Snapshot hygiene: kept /tmp/brain-snap-20260927 + 20261006.
