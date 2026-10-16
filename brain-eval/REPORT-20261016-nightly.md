# Nightly brain-eval — 2026-10-16 (homemini, 03:05)

**Outcome: MEASURE night — E10 priced and refuted; NOTHING applied, the brain
is byte-identical to what brain-trainer wrote at 02:00.**

## Pre-flight
- brain-trainer finished 02:00:31 EDT: 11,600/11,600 enriched, embeddings.bin
  11,757 vectors (+1 track), and a logged **mood-index prune** (1 vector for a
  de-libraried track, 11,600 → 11,599, undo at `mood-index.bin.prune.bak`) plus
  1 new vector → mood back at 11,600. Both brain shas changed vs last night —
  fully accounted for by the trainer log, not an anomaly.
- Snapshot `/tmp/brain-snap-20261016`, sha-verified before and after copy:
  emb `17cd46e53641…`, mood `86952d028156…`. Aux files (library,
  metadata-overrides, artist-members, lyrics, descriptors) carried.
- Worktree `/tmp/jt-brain-eval-20261016` at brain-eval `cfb3244` (= origin).

## Baselines (full, LLM grounding — shas changed so not a --no-llm night)
- **v1 (`B1-20261016`): retrieval 0.810 / grounding 1.000 / overall 0.905** —
  exactly the confirmed normals. Routes 8 mood / 7 main.
- **v3 (`B3-20261016`): headline 0.803, grounding 1.000 (20/20)**, primary
  source bridge (main src `69c1e5e7e5e7`), routes main 29 / mood 94 /
  mood+lexicon 1 / main+decade 30 — same as 10-14/10-15. Groups: artist 0.963,
  umbrella_family 0.913, leaf 0.843, family_decade 0.872, tempo_family 0.510,
  vibe 0.719. No grounding flake tonight (v3-grd-16 clean).
- `B3NL-20261016` (--no-llm) retrieval rows identical to B3 — determinism holds.

## Tonight's pick: E10 (jake lane, MEASURE — never applies)
"Leaf-genre queries reach the index that knows them" — route a query naming a
vocab leaf/family to the main index. Priced on a scratch copy of origin/main
with the one-line router change (leaf-name word-boundary match in
`pickRetrievalIndex`), the favorable core case.

**REFUTED on the post-E3 brain** (`C3NL-E10-20261016`, gate
`/tmp/gate-E10-20261016.json`, exit 1):
- headline 0.803 → 0.766; mean per-probe Δ **−0.0200**, CI90 [−0.0431, +0.0029]
- leaf +0.022 → 0.865 (meets the item's 0.70 target — but 17/50 leaf probes drop)
- **tempo_family −0.250** (0.510 → 0.260): "fast punk"-style tempo-qualified
  queries hijacked to the tempo-blind main index; umbrella_family −0.027
- routes main 29 → 105, mood 94 → 18

The 10-12 premise (leaf 0.428 production vs 0.784 main) is gone: E3's genre
line in the mood text already lifted leaf to 0.843 on the production path,
above the main index. Full analysis + recommendation (close E10; the real gap
is tempo_family = E7 territory) in `PROPOSAL-E10-leaf-genre-routing.md`.

Ledger: `record --outcome priced` with gate JSON + group metrics.

## Applied
Nothing. No NAS write of any kind; post-run shas re-verified identical to the
02:00 trainer output.

## Queue state after tonight
- Auto lane still empty (E1 premise gone bare=0, E2 churn 0.00%, E3/E5 spent,
  E8 measured).
- E10 **priced** (recommend close). Remaining Jake-lane: E7 (tempo_family,
  priority 55) — now clearly the highest-value open item (tempo_family 0.510,
  main-idx diag 0.110).

## Artifacts
- score_log.jsonl: B1-20261016, B3-20261016, B3NL-20261016, C3NL-E10-20261016
- score_rows.jsonl: 25 + 174 + 154 + 154 rows
- candidate tree kept at `/tmp/brain-cand-E10-20261016/main-src` (scratch only)
- snapshot kept at `/tmp/brain-snap-20261016`
