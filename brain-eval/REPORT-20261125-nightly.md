# Nightly brain-eval — 2026-11-25 (homemini, 03:05 launchd)

**Outcome: IDLE (40th) — baselines only, nothing applied, brain untouched.**
Queue: auto lane empty (E1 bare=0; E2 genre-tag churn 24/11,547 = 0.21%, need >1%),
jake lane empty → `pick` returned IDLE (ledger `picked` event 03:06:33).
The gemma4 promotion pricing item (TOP Jake ask) is STILL NOT QUEUED.

**Night's real finding: the grd-005 flake finally caught red-handed.** First
flake since the 11-23 raw_excerpt fix went live, so the raw reply was
persisted — and the read-only forensic nailed a SECOND mechanical parser
class (double-emission + truncated self-correction), with a full failing raw
preserved. PROPOSAL-grd16 updated with the anatomy and a refined fix
(raw_decode first). Details below; nothing applied — harness scoring is
Jake's call.

## Pre-flight
- brain-trainer (23:40 EST slot) finished 23:44:44 EST Nov 24: +28 enriched,
  brain 14,787/14,787, embeddings.bin 15,008 vectors, mood-index 14,787
  vectors, purity gate ok (0.9018 vs 0.9018, regression 0.0000 ≤ 0.02). NO
  mood prune tonight — clean; writer rule clean, no unlogged writes.
- NAS mtimes embeddings.bin / mood-index.bin both 23:44 (Nov 24 EST) —
  trainer slot, stable ~3.3h before measurement. No post-02:30 writes.
- Snapshot `/tmp/brain-snap-20261125`, sha-verified pre/post on all 7 files
  (emb d89fc62e3e8f, mood bece1b08242b, library 9ae257e6c347 = 14,787 tracks,
  + descriptors/artist-members/metadata-overrides/lyrics). No torn reads.
- End-of-run re-verify: NAS emb/mood shas UNCHANGED since snapshot.

## Scores (harness brain_id d89fc62e3e8f / mood_id bece1b08242b)
- **v1 (B1-20261125): retrieval 0.808 / grounding 0.900 printed — true
  grounding ≈ 1.000, overall ≈ 0.904.** Sole mover: **grd-005 1.00 → 0.00,
  reason `unparseable (reply was not JSON)`** — a PARSER artifact, not a
  brain or model-behavior failure (see forensic below; the model's first
  JSON object was complete, valid, and cited 5 real in-context Nirvana
  tracks = would score 1.0). Retrieval probes IDENTICAL to last night
  (ret-011 held 0.48, ret-015 0.90, traps clean); routes 8 mood / 7 main
  unchanged.
- **v3 (B3-20261125): headline 0.779** — 22nd night in the ~0.78 band.
  Primary source **bridge**; routes main 29 / mood 94 / mood+lexicon 1 /
  main+decade 30 — identical. v3 grounding **0.950 = grd-15 trap ONLY
  (cited 3; APPLY-BLOCKER stands), zero v3 parser flakes.**
- Groups: artist 0.963 / umbrella 0.909 / leaf 0.840 / family_decade 0.877 /
  tempo_family 0.427 / vibe 0.658 — no group moved beyond churn
  (tempo_family +0.005 and vibe +0.007 vs last night, both drift-up).
- **main-src e8597fdd3773 — CHANGED from 5afffcf4** (origin/main advanced:
  this week's genre-sort/sidebar merges). Not a harness problem: routes
  identical on both rulers, retrieval probes identical, v1 8/7 unchanged.
  New stability baseline = e8597fdd.
- vocab ruler_check 33/14,787 unresolved = 0.22% — pass (threshold 0.5%).
- qvec 348 cached / 0 fresh — frozen, bit-identical queries.

## Movers — v3 5/174 net +0.15 (quiet night)
All inside churn, no new watches:
- v3-tempo-01 0.76 → 0.84 (+0.08, double-slot bounce up)
- v3-tempo-15 0.20 → 0.24 (churn-list regular)
- v3-vibe-ret-013 0.83 → 0.87, v3-vibe-ret-014 0.27 → 0.30 (single-slot)
- v3-tempo-16 0.20 → 0.16 (−0.04 single-slot churn; churn-list regular)
- tempo-13 HELD 0.08 (watch stays CLOSED; re-open < 0.08).

## grd-005 forensic — flake class SOLVED (read-only, standing ×3 recipe)
First flake with raw_excerpt persistence live. The 400-char excerpt showed
clean fenced JSON — but `parse_json_obj` already fence-strips and has a
`{.*}` fallback, so fencing alone can't explain a parse failure. Rebuilt the
exact context (top-14 retrieval, same brain) and called claude-haiku-4-5 ×7
(3+4): 2 failed, and the full failing raw shows the real anatomy:
1. complete VALID fenced JSON object (5 citations, all real + in-context);
2. then `Wait—I need to correct myself. Let me be precise:` + a SECOND
   fenced JSON object;
3. obj2 truncates at max_tokens=500 mid-`answer`;
4. `json.loads` → `Extra data (char 743)`; greedy `\{.*\}` fallback spans
   obj1's `{` to truncated obj2's last `}` → invalid → 0.

So the tally's two proven classes are now: (1) unescaped inner double quotes
(10-22 raw), (2) double-emission + truncated self-correction (tonight's
raw). Both transport/formatting, ZERO fabrication across all 7 flake nights
(10-14, 10-18, 10-22, 10-24, 11-22, 11-23, 11-25; 4 probes; both rulers).
PROPOSAL-grd16 updated: recommended mechanism refined to fence-strip →
`json.JSONDecoder().raw_decode` (first valid object, ignores trailing data —
kills class 2 in one line) → bounded `"tracks":[...]` regex (kills class 1),
raw_excerpt persisted on every fallback, citations still exists+predicate
checked. NOT applied — score-changing harness code is Jake ask #3.
Full failing raw embedded in the proposal (+ /tmp/grd005-fail-raw-20261125.txt).

## Standing items — all held
- grd-15 trap (v3) still the only v3 grounding miss; reword = Jake ask #2.
- tempo_family 0.427 gap unchanged in substance = Jake ask #4.
- E1 bare = 0; E2 churn 0.21%; no mood prune; skip gate closed; foreground
  rule held ×40.

## Jake asks (unchanged order, #3 now has a root cause)
1. gemma4 promotion pricing item — STILL NOT QUEUED (top ask).
2. grd-15 trap reword (apply-blocker).
3. fenced-json parser — **root cause now fully proven with raws; see
   PROPOSAL-grd16 2026-11-25 section; recommend approving fix (a)+raw_decode.**
4. tempo_family 0.42–0.43 gap (tempo-13 settled 0.08).
5. grd-12 legacy-tag + Plunderphonics re-export.

## Hygiene
- Worktree jt-braineval-20261125 from origin/brain-eval (603d063d), removed
  after push. /tmp snaps present 20261117..1125.
- Nothing written to the NAS brain; no backups needed (no apply).
