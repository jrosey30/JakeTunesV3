# Nightly brain exercise — 2026-11-13 (homemini)

**Outcome: IDLE (28th consecutive) — baselines only, nothing applied, brain untouched.**

## Pre-flight
- brain-trainer finished 02:09 EST (log dated today, exit normal): +43 enriched, embeddings.bin 13,965 vectors, mood-index 13,751. NAS mtimes 02:08–02:09, stable ~57 min before snapshot — clean (before the 02:30 promotion watch line).
- Mood accounting FULL: 13,708 + 43 trainer updates = 13,751 ✓. **No prune tonight** (no new brain-prune-ledger.jsonl line — last entry remains 11-12, id 15018). No unlogged writer events.
- Redescribe job yielded to the trainer then ended on its swap guard (12,066 MB > 12,000, exit 143) — writes only brain-descriptors.next.json, benign. Backlog remains 100% staged; the gemma4 promotion PRICING item is still not queued (Jake ask #2).
- Snapshot `/tmp/brain-snap-20261113`, all 7 files sha-verified before + after copy:
  emb `fd18dace2ac9` / mood `d93a784677db` / library `e41d993ceb5b` / descriptors `b93dd5643428`.
- Worktree `/tmp/wt-20261113` fresh from origin/brain-eval (9c1700db).

## Pick
`pick_experiment.py pick` → **IDLE**. E1 bare backlog = 0; E2 genre-tag churn 24/11,549 = 0.21% (need >1%). Jake lane empty. Ledger 'picked' event committed.

## Baselines (brain_id b4cacaf3ce63, library 765b0446d5f3)
### v1 (B1-20261113)
- **retrieval 0.807 / grounding 1.000 / overall 0.903**
- **grd-005 RECOVERED** (scored 1 after two consecutive unparseable nights) — the first repeat-ID v1 parse flake stopped at ×2; stays a parse-class data point for PROPOSAL-grd16-fenced-json-parse.md, not fabrication.
- Retrieval held at 0.807 (2nd night; ret-015 held 0.83). The re-center recommendation to ~0.804 stands — 0.807 is one ruler-residual slot above it.
- Routes 8 mood / 7 main — identical to 11-12.

### v3 (B3-20261113)
- **headline 0.7791** (11-12: 0.779 — exactly flat; 8th night settled ~0.78 below the old 0.794–0.803 band; re-center over band re-entry still the lean).
- **grounding 0.900** — the deterministic grd-15 trap (cited 2, as every night) **plus grd-20 unparseable (reply was not JSON) — a NEW flake ID, first grd-20 in the tally.** Notably grd-20 is a trap question: the flake scored it 0 where a parsed empty reply scores 1. v3 flake tally now 14/28 (grd-16 ×5 / grd-14 ×3 / grd-19 ×2 / grd-12 ×1 / grd-05 ×1 / grd-11 ×1 / grd-20 ×1) — 7 distinct IDs, more consecutive-night fuel for the fenced-JSON parser proposal.
- Groups: artist 0.963 / umbrella 0.907 / leaf 0.833 / family_decade 0.876 / tempo_family 0.445 / vibe 0.651. tempo_family remains the top open quality item (needs a Jake-approved hypothesis).
- Primary source **bridge**; routes 29 main / 94 mood / 1 mood+lexicon / 30 main+decade — identical to 11-12; main-src fe8fed66715a unchanged.
- **Movers 2/174 — the quietest night on record:** grd-20 1→0 (the flake) and fdec-18 0.40→0.36 (one slot). The 43-vector add wave moved almost nothing.
- **Watch items ALL HELD exactly:** leaf-33 0.64 (4th night, settled), leaf-41 0.68, leaf-29 0.48, tempo-12 0.04, vibe-prod-006 0.68, leaf-12 0.52, leaf-38 0.68.
- vocab stale guard passed (no exit 3); churn 0.21%.

## Gate / apply
Nothing to gate — IDLE. APPLY-BLOCKER unchanged: grd-15 trap caps v3 grounding at 0.950 (0.900 tonight with the extra flake) until Jake rewords the ruler (PROPOSAL-grd15-trap-staleness-colloquial-dance.md).

## End-of-run verification
NAS embeddings.bin `fd18dace2ac9` and mood-index.bin `d93a784677db` — identical to pre-measurement shas. **Brain untouched.**

## Open Jake asks (unchanged order)
1. grd-15 trap reword (apply-blocker).
2. Queue the gemma4-promotion PRICING item (redescribe staging is 100% complete — price BEFORE any --promote-next).
3. Fenced-JSON parser proposal — 7 distinct flake IDs now, incl. tonight's first-ever trap-question flake (grd-20), which costs a full grounding point a parsed empty reply would have earned.
4. tempo_family 0.445 — needs a new hypothesis (tempo in mood text, or bpm-aware rerank).
5. v1 retrieval re-center to ~0.804 (0.807 ×2 nights — still that neighborhood).
6. grd-12 legacy-tag proposal; Plunderphonics vocab re-export.
