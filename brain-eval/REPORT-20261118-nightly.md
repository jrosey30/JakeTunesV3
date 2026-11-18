# Nightly brain-eval — 2026-11-18 (homemini)

**Outcome: IDLE (33rd) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished cleanly but **EARLY**: 23:40–23:46 EST Nov 17 (04:40–04:46Z)
  instead of the usual ~02:00 EST, and the normal 02:00 slot did NOT fire a second
  run. +63 enriched (every new add), purity gate 0.9279 vs 0.9279 (regression
  0.0000), embeddings.bin 14,376 vectors / mood 14,162 (= 14,099 + 63, fully
  accounted, NO prune — brain-prune-ledger last line unchanged). NAS mtimes
  23:45/23:46 match the log; stable ~3.3 h before measurement. ⚠️ WATCH: if the
  trainer fires early again tomorrow, check its launchd plist/schedule — one night
  could be a reboot/catch-up artifact, two is a schedule change.
- Redescribe pass ACTIVE during the session (writes only `.next*.json`, no race):
  1,100/6,246 at 03:02 EST, 0 fails, ~9.9 s/track, yielded politely to the BPM
  worker 02:20–02:32. **Denominator watch RESOLVED**: 8,928 → 6,944 → 6,246 —
  the denominator is remaining-at-pass-restart, shrinking as prior nights'
  completions drop out (6,944 − 750 done ≈ tonight's 6,246). Not a recount bug.
- Snapshot `/tmp/brain-snap-20261118`, sha-verified before/after copy (NAS stable
  during copy). emb sha256 `caee1049df14` / mood `20fffd5cbe3b` — both NEW vs
  11-17 (trainer +63), so full LLM runs, not `--no-llm`.

## Baselines (worktree jt-braineval-20261118 @ e68603e7, origin/brain-eval)
- **v1 (B1-20261118): retrieval 0.811 / grounding 1.000 / overall 0.906** —
  numerically identical 4th night running; zero v1 movers; ret-015 held 0.90;
  all traps clean. Routes 8 mood / 7 main, main-src cf87f18dce90 (stable).
- **v3 (B3-20261118): headline 0.781**, primary source **bridge**, routes
  29 main / 94 mood / 1 mood+lexicon / 30 main+decade (identical to 11-17).
  Groups: artist 0.963 / umbrella_family 0.909 / leaf 0.838 / family_decade
  0.876 / tempo_family 0.450 / vibe 0.651. 15th night settled ~0.78.
- **v3 grounding 0.950 = grd-15 trap ONLY** (deterministic colloquial-dance,
  cited 2) — the standing APPLY-BLOCKER until Jake rewords the ruler
  (PROPOSAL-grd15-trap-staleness-colloquial-dance.md). **No parser flake
  tonight** (grd-16/20 etc. all clean) — flake tally stays 16 flake-nights
  across 7 IDs.
- **Movers 2/174, both gains, zero drops:** tempo-16 0.16→0.20, leaf-03
  0.48→0.52. Watch items ALL HELD: leaf-33 0.64 / leaf-41 0.72 / leaf-29 0.48 /
  tempo-12 0.04 / vibe-prod-006 0.68 / leaf-12 0.52 / leaf-38 0.72 / fdec-18 0.36.
- Harness ids: brain_id ad98b1dd9b00 / mood_id d8787f3eb703 / library
  7164fc9b620c (14,162 tracks). Vocab stale guard passed (24/11,549 = 0.21%).

## Queue
`pick_experiment.py pick` → **IDLE** (ledger 'picked' event 03:09 committed).
- E1 skip: bare mood vectors = 0.
- E2 skip: genre-tag churn 0.21% (needs >1%).
- Jake lane empty. Open Jake asks unchanged, in priority order: (1) grd-15
  reword, (2) queue the gemma4 promotion PRICING item, (3) fenced-json parser
  proposal, (4) tempo_family 0.450 needs a new approved hypothesis.

## Apply / verify
Nothing passed any gate because nothing ran — nothing applied. End-of-run NAS
check: emb `caee1049df14` / mood `20fffd5cbe3b`, mtimes 23:45/23:46, byte-identical
to the measurement snapshot. Brain untouched.
