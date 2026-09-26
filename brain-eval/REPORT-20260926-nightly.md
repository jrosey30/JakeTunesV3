# Nightly brain exercise — 2026-09-26 (homemini)

## Situation at start (03:05 ET)
- Trainer clean launchd 06:00–06:00:54Z: **import night after two quiet ones** — library 10,939 → 10,954
  (+15), all 15 Gemma-enriched same night (brain 10,954/10,954, backlog stays 0); tempo catch-up 20 =
  20 newly-analysed (5 formerly bpm-less got bpm: te False 39 → 34); embeddings 11,106 vectors,
  mood 10,972; artist-members 5,881 → 5,885 tracks.
- **NAS brain shas ×3-verified stable** (first read, second read, snapshot copy — all identical):
  embeddings.bin 75e8c5b20c910abbc670c9ff83e738d6e617aaf2 (68,279,700 bytes, mtime Sep 26 02:00:49),
  mood-index.bin 87077e033262ead7e1d7ddfbbcd9b6b74aabdf20 (67,455,868 bytes, mtime Sep 26 02:00:54).
  Shas CHANGED from 09-25 (trainer wrote) → the 09-25 zero-tolerance A/A rule does not bind tonight;
  content-churn wobble is the expected mechanism.
- Frozen measurement snapshot: /tmp/brain-snap-20260926 (embeddings, mood, library.json,
  brain-descriptors.json — shas verified against NAS after copy).

## Clobber pre-check (import day ⇒ mandatory, before any paid call)

precheck_20260926.py on the frozen snapshot: mood 10,972 vec / **18 orphans** (the SAME benign id list
a 12th night: 9796, 9820, 9863, 10642, 10923–10924, 11338–11349) / **1 dup group** (n=4, the known
11338–11341 un-enriched block) — nothing like the ~125/60 replay signature. Embeddings 11,106 vec /
**152 orphans steady**. Enrichment 10,954/10,954, backlog 0. Watchlist stays CLOSED (0/34).
**22nd consecutive no-clobber day; clobber remains 15/31 import days.** The replay writer
(autoBackupStateToNas) is still unfixed — durability continues to be luck plus a quiet desktop,
not a landed fix.

## Measurements (keys probed 1-token first: OpenAI 200, Anthropic 200)

| metric | 09-25 (prior bytes) | tonight (new bytes) | read |
|---|---|---|---|
| run_eval retrieval | 0.736 | **0.733** | hair below the 0.736 band floor — same one-slot identity-side wobble shape as 09-18/20/22 (rt healthy, decomp zero-residual ⇒ ruler/content churn, not production) |
| grounding | 1.000 | **1.000** (10/10 incl. 4 traps) | clean |
| overall | 0.868 | **0.867** | in-band |
| router-truth | 0.821 | **0.819** | one slot (ret-013 0.90→0.87 inside S0); healthy plateau |
| orphan component | +0.013 | **+0.016** (S0 0.819 → S1 0.835) | **EIGHTEENTH data point**, series 0.013/0.013/0.011×6/0.013/0.016×4/0.013/0.016/0.013/0.013/0.016 |
| S1 / S2 | 0.835 / 0.835 | **0.835 / 0.835** | S1==S2, un-enriched +0.000, unenriched_in_lib=0, zero residual (0.819+0.016=0.835 exact) |
| orphan slots | 007:4, 012:4, 008:1 | **007:4, 008:1, 012:4** | identical occupancy |
| worst S1 per-probe delta | +0.00 | **+0.00** | prune remains strictly non-harmful |

The 15 fresh imports entered fully enriched (unenriched_in_lib=0 on night one) — the enrichment
pipeline now absorbs an import wave the same night it lands; no new sag forms.

## Standing guards

- **Taste-W premise guard (resumed tonight — content-change night): PASS.** All three copies
  byte-identical to the v4 line PROPOSAL-taste-weights-refresh-v4 targets
  (`bias −6.529, album 12.625, artist 1.892, genre −0.068, decade 0.285, plays −0.824,
  recency −0.191, intensity 4.65`): V3 src/renderer/utils/tasteScore.ts:89,
  Mobile backend/src/util/tasteScore.ts:87, Mobile backend/dist/util/tasteScore.js:63.
- **Skip gate (forensics recount, organic-only standard): CLOSED — 666 mobile organic + 610 desktop
  = 1,276/3,000** (+90 organic since 09-16). ⚠️ New evidence for
  PROPOSAL-mobile-failure-skip-cascade: **two NEW mechanical bursts** since the last count —
  2026-09-25T17:50Z (62 skips) and 2026-09-26T03:13Z (46 skips); mechanical total now
  2,237 in **14 sessions** (was 2,129 in 12). The failure-cascade behavior is ongoing, not a
  September-12/13 one-off. Appended as a data point; the proposal stays Jake-gated.

## Experiment verdict — outcome (b)

Nothing beat baseline; **nothing applied; brain untouched** (embeddings 75e8c5b20c91,
mood 87077e0332 — re-verified unchanged on the NAS after all measurement). Every open lever remains
correctly gated on Jake:

1. **Trainer-side mood orphan prune** — +0.013–0.016 rt, now **eighteen-point-proven**, worst
   per-probe delta +0.00 on all eighteen nights. The single highest-value, lowest-risk ask.
2. **PROPOSAL-mood-import-clobber fixes 4/5** — replay writer still live; tonight was clean by luck.
3. **PROPOSAL-taste-weights-refresh-v4** — premise re-verified intact tonight.
4. **PROPOSAL-tempo-catchup-queue-order** — evidence complete (19 points), decision Jake's.
5. **PROPOSAL-mobile-failure-skip-cascade** — reinforced tonight (2 new bursts, above).
6. Taste-drift monthly re-run due ~10-13 (v4 script; re-diff deployed W first).
7. Skip v4 re-run gate: 1,276/3,000 organic — CLOSED.

## Watch for 09-27
- Standard nightly only: clobber pre-check (import days), rt <0.80 without orphan-slot growth =
  something NEW.
- Snapshot hygiene: kept /tmp/brain-snap-20260924/-25/-26; deleted 20260923.
