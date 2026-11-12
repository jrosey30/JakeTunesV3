# Nightly brain exercise — 2026-11-12 (homemini)

**Outcome: IDLE (27th consecutive) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished 02:08 EST (log dated today, exit normal): +71 enriched, embeddings.bin 13,922 vectors, mood-index 13,708. NAS mtimes 02:07–02:08, stable >55 min before snapshot — clean (before the 02:30 promotion watch line).
- Mood accounting FULL: 13,638 − 1 ledgered prune at 00:00 (brain-prune-ledger.jsonl, id 15018) + 71 trainer updates = 13,708 ✓. No unlogged writer events.
- Redescribe job yielded to the trainer then ended on its swap guard (12,478 MB > 12,000, exit 143) — writes only brain-descriptors.next.json, benign. Backlog remains 100% staged.
- Snapshot `/tmp/brain-snap-20261112`, all 7 files sha-verified before + after copy:
  emb `6d4da3d8bd35` / mood `3fa3bee36a9e` / library `39bfe22d3a71` / descriptors `332d08ab081e`.
- Worktree `/tmp/wt-20261112` fresh from origin/brain-eval (e28c8e21).

## Pick
`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21% (need >1%). Jake lane empty. Ledger 'picked' event committed.

## Baselines (brain_id a9563de486fa)
### v1 (B1-20261112)
- **retrieval 0.807 / grounding 0.900 / overall 0.853**
- Retrieval up one slot off the 6-night 0.804 plateau: sole mover ret-015 0.80→0.83 (the documented plain-"Rock"-tag ruler-residual probe, normal wobble).
- **grd-005 unparseable AGAIN — 2nd consecutive night, same ID.** Parse class, not fabrication (grader read "unparseable/no-LLM"). v1 grd-005 flake count now ×2. Third data point in two nights for PROPOSAL-grd16-fenced-json-parse.md — the parser proposal now has repeat-ID evidence on the v1 ruler too.
- Routes 8 mood / 7 main — identical to 11-11.

### v3 (B3-20261112)
- **headline 0.7793** (11-11: 0.780 — flat; 7th night in the add-churn zone below the 0.794–0.803 band).
- **grounding 0.950** — only the deterministic grd-15 trap failed (cited 2 on a trap, as every night). **All four recent parse-flake IDs recovered** (grd-05, grd-11, grd-16, grd-19 all scored 1). v3 flake tally now 13/27 nights.
- Groups: artist 0.963 / umbrella 0.907 / leaf 0.833 / family_decade 0.877 / tempo_family 0.445 / vibe 0.651. tempo_family remains the top open quality item (needs a Jake-approved hypothesis).
- Primary source **bridge**; routes 29 main / 94 mood / 1 mood+lexicon / 30 main+decade — identical to 11-11. main-src moved a45b4052 → fe8fed66715a with routes unchanged, so bridge = production holds.
- **Movers 9/174, very quiet:** grd-05 and grd-11 recovering (+1.00 each); leaf-38 0.56→0.68 (+0.12, biggest real mover — plausibly the 71-vector add wave); the other six ±0.04 one-slot shuffles (umb-05, fdec-03, tempo-09, tempo-10, leaf-13, leaf-30).
- **Watch items ALL HELD exactly:** leaf-33 0.64 (3rd night, settled), leaf-41 0.68, leaf-29 0.48, tempo-12 0.04, vibe-prod-006 0.68, leaf-12 0.52.
- vocab stale guard passed (no exit 3); churn 0.21%.

## Gate / apply
Nothing to gate — IDLE. APPLY-BLOCKER unchanged: grd-15 trap caps v3 grounding at 0.950 until Jake rewords the ruler (PROPOSAL-grd15-trap-staleness-colloquial-dance.md).

## End-of-run verification
NAS embeddings.bin `6d4da3d8bd35` and mood-index.bin `3fa3bee36a9e` — identical to pre-measurement shas, mtimes unchanged (02:07). **Brain untouched.**

## Open Jake asks (unchanged order, #3 strengthened)
1. grd-15 trap reword (apply-blocker).
2. Queue the gemma4-promotion PRICING item (redescribe staging is 100% complete — price BEFORE any --promote-next).
3. Fenced-JSON parser proposal — now with a repeat-ID v1 flake (grd-005 ×2 consecutive).
4. tempo_family 0.445 — needs a new hypothesis (tempo in mood text, or bpm-aware rerank).
5. v1 retrieval re-center to ~0.804 (tonight 0.807 — still in that neighborhood).
6. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.
