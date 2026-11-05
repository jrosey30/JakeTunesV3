# Nightly brain exercise — 2026-11-05 (homemini)

**Outcome: IDLE (19th idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished 02:06 EST (07:06Z): +68 enriched, purity gate passed
  (0.8820 vs 0.8820, regression 0.0000). Note: the gate LEVEL moved back **UP**
  0.8580 → 0.8820 during the daytime interval — the 11-04 "biggest downward
  step yet" watch did NOT continue; levels remain daytime-volatile but tonight
  reversed the drop. Watch stays informal.
- NAS brain stable: embeddings.bin mtime 02:05, mood-index.bin 02:06, no
  writes after (measured 03:05+). No 00:00 mood prune tonight (ledger's last
  entry is 11-04; mood vector count 12,659 = 12,591 + 68, fully accounted).
- Redescribe campaign (staged-only, brain-descriptors.next.json): running
  during the run, 1000/1147 at 03:03 EST, 0 fails, ~11.0s/track — on pace to
  finish staging ~03:35 EST **tonight**. Yielded cleanly around the 02:00
  trainer again. ⇒ the gemma4 promotion queue item is now URGENT-adjacent:
  staging is complete; `--promote-next` must NOT run until Jake queues the
  promotion item so the dual-run gate prices the gemma4 mood index first.
- Snapshot /tmp/brain-snap-20261105, all 7 files sha-verified before+after copy.
  emb sha256 679f396704d1 (12,853 vec incl. orphans; 12,659 in-library),
  mood 2ee467348c7c (12,659 vec).
- Bridge main-src bba035366c8e (origin/main 46384434 → bba03536, PRs ~#339–#346,
  all downloads/streamrip/exact-recording/home-verb work): **zero diff** on
  src/main/index.ts, src/main/ai/, genre-vocab/iceberg, mix-brain-twin,
  embedding-text ⇒ tonight's bridge = production.
- Worktree fresh from origin/brain-eval (437dc4b0), .env copied.

## Baselines (snapshot, /usr/bin/python3)
- **v1 (B1-20261105): retrieval 0.813 / grounding 1.000 / overall 0.906** —
  in the ×22-confirmed normal band. Routes 8 mood / 7 main, identical.
- **v3 (B3-20261105): headline 0.795 / grounding 1.000 (20/20)** — primary
  source bridge; routes {main 29, mood 94, mood+lexicon 1, main+decade 30},
  identical to 11-04. Groups: artist 0.963 / umbrella_family 0.909 /
  leaf 0.837 / family_decade 0.875 / tempo_family 0.485 / vibe 0.700.
- Grounding 1.000 BOTH rulers — no grd-16/grd-14 flake. Tally now 7/22 nights.

## Movement vs 11-04 (add-churn only)
- 11/174 movers, balanced: 6 up / 5 down, all ±0.03–0.04 except
  **vibe-prod-006 0.76 → 0.84 (+0.08) — new all-time high for the sentinel**.
  Headline 0.794 → 0.795. Zero route changes.
- Sentinels: leaf-20 0.88 held, tempo-13 0.32 held (recovery holding),
  tempo-04 0.88 / tempo-10 0.52 held. tempo_family flat 0.485 — slide-watch
  stays paused (×5); still the top open quality item, still needs a
  Jake-approved hypothesis before anything is queued.

## Queue
- PICK: IDLE. E1 bare mood vectors = 0 (every add enriched same-night);
  E2 genre-tag churn 22/11,550 = 0.19% (< 1%). Both lanes empty.
- vocab_snapshot still out of date (Plunderphonics + 2 legacy), in-run stale
  guard ~0.27% < 0.5% threshold — re-export remains Jake's call.

## Applied
Nothing. No candidate was built; gate not invoked. Brain files unchanged
(shas re-checked identical after the runs).

## Open Jake items (unchanged + one time-sensitive)
1. **gemma4 promotion queue item — staging finishes TONIGHT**; queue it so the
   dual-run gate prices the gemma4 mood index before any --promote-next.
2. grd-16/grd-14 tolerant-parse proposal (PROPOSAL-grd16-fenced-json-parse.md).
3. grd-12 legacy-tag re-tag via LAPTOP overrides.
4. tempo_family 0.485 gap — needs a new hypothesis (tempo in mood text, or
   bpm-aware rerank).
5. Plunderphonics vocab re-export.
