# Nightly brain-eval — 2026-10-30

**Outcome: IDLE (13th consecutive idle night) — baselines only, nothing applied, brain untouched.**

## Pre-flight

- brain-trainer finished 02:03 EDT (log dated today): **+54 tracks enriched**
  (library 12,158 → 12,212; embeddings.bin → 12,399 vectors, mood-index.bin
  → 12,212), plus a lyrics-meaning catch-up of **28** re-embeds (10-29: 9 →
  tonight: 28 — still new-adds-with-lyrics, not backlog). Nightly purity
  gate passed (candidate 0.8989 vs previous 0.8989, regression 0.0000 ≤
  0.02). Note the gate's *level* moved 0.9079 → 0.8989 between nights
  (−0.009, within its own 0.02 tolerance) — the add wave shifted the
  neighbourhood mix; the gate compared like-for-like and passed.
- Files stable ~60 min before snapshot. Snapshot `/tmp/brain-snap-20261030`
  sha-verified against the NAS before and after copy:
  - embeddings.bin `b592fa44d6e2…` (12,399 vec)
  - mood-index.bin `28b7f9f73f4b…` (12,212 vec)
  - carried library.json, metadata-overrides.json, artist-members.json,
    lyrics.json, brain-descriptors.json.
- Both shas changed vs 10-29 (prior emb `79f21c96b661…`, mood
  `3b9bb0276379…`) — fully accounted for by tonight's trainer run (+54 adds
  + 28 meaning re-embeds). No unlogged writer event. Re-verified at session
  end: NAS shas identical to snapshot, mtimes still 02:03.
- `com.jaketunes.brain-redescribe` ran its window concurrently and stayed
  **staged-only** as designed: `brain-descriptors.next.json` mtime 02:58,
  live brain files untouched (02:03, before the 02:30 window opened).
  Progress: **3,399/12,212** descriptors staged (night 3; ahead of the
  night-1 pace). Promotion still requires the separate eval-gated
  `--promote-next` — the auto-lane promotion item remains for Jake to queue
  when staging completes.
- Fresh worktree at brain-eval tip `d2d4138` (created from origin). Audio
  fusion OFF as always on homemini (mood-only routing both rulers).

## Bridge main-src advanced: 628ed75 → 3de5c49 (PRs #296–#301)

Year-in-Review redesign + found-artists, friend share (desktop twin),
concerts Going/I-went. **Zero `src/main/ai` diff.** ONE brain-adjacent
change (commit 8489a90): **`Plunderphonics` added to genre-vocab +
genre-iceberg** (depth-4 leaf, Electronic & Dance, KEPT_ONE_ARTIST), and
The Avalanches' *No Bad Memories* re-filed to it — **31 tracks changed
genre tag**. Consequences, all verified tonight:

- `export_vocab.py --check`: **vocab snapshot now OUT OF DATE vs
  origin/main.** Per standing rule I did NOT regenerate — re-export +
  ruler regeneration is Jake's call. The in-run ruler-stale guard passed:
  33/12,212 library tags unresolved (**0.27%**, threshold 0.5%) — 31
  Plunderphonics + 2 legacy tags (see the new proposal). Every probe name
  in the frozen ruler still resolves; scoring is sound, and baseline vs
  candidate comparisons tonight saw identical code + vocab.
- Routes identical to prior nights: v1 **8 mood / 7 main**, v3
  **29 main / 94 mood / 1 mood+lexicon / 30 main+decade**. The vocab add
  was route-neutral, as the 10-29 report predicted a genre-filer change
  might not be — E2's churn check saw only 0.19%.

## Baselines (the night's only runs)

| ruler | result | normal band |
|---|---|---|
| v1 (B1-20261030) | retrieval **0.813** / grounding **1.000** / overall **0.906** | 0.810–0.816 / 1.000 / 0.905–0.908 — ×16 nights |
| v3 (B3-20261030) | headline **0.796** | 0.796–0.803 since E3 |

v3 groups: artist 0.963 · umbrella_family 0.911 · leaf 0.838 ·
family_decade 0.868 · tempo_family **0.495** · vibe 0.699.
Primary source: bridge. Foreground rule held (16th night).

**v3 grounding 0.950 — NEW flake probe, diagnosed.** `v3-grd-12` cited
"Let No Man Put Asunder — First Choice (1977)" for "1970s r&b and soul" —
factually correct, but the track's genre tag is the literal legacy string
`R&B, Soul, Funk`, which resolves to no vocab leaf, so the citation scored
off-predicate. **Data artifact, not a model error and not transport** (the
answer parsed fine — this is not grd-16). Exactly 2 tracks in the whole
library carry dead legacy tags. Written up as
**`PROPOSAL-grd12-legacy-tag-citation.md`** (Jake lane; recommended fix:
re-tag the two tracks via the laptop overrides flow). Flake tally: **6 of
16 nights** (grd-16 ×3: 10-14/18/22; grd-14 ×2: 10-24/27; grd-12 ×1:
tonight). Reminder: any flake night blocks a candidate apply (candidate
grounding must be 1.000), so scoring-artifact flakes are the main
apply-risk — two open proposals now address the two known causes.

## Churn vs 10-29 (add night: +54 tracks, +31-track genre re-file)

**18 of 174 rows moved** — more rows than recent nights but all small
(±0.04 one-slot moves except leaf-36 +0.16, leaf-21 +0.08, leaf-43 −0.08,
vibe-prod-003 −0.08) and balanced (7 up / 10 down / grd-12). Headline
0.797 → 0.796, deep in-band. Driver: the add wave plus the Avalanches
re-file shifting leaf/umbrella expected sets.

- **tempo_family 0.497 → 0.495 — FLAGGED.** The 10-29 report said "if
  tempo_family drops again next add night, flag it." It did: 0.507 → 0.497
  → 0.495 over three consecutive add nights (tempo-11 and tempo-13 each
  −0.04 tonight, tempo-03 +0.04). Still the standing gap (main-idx diag
  0.107) with NO queued remedy — any fix needs a NEW Jake-approved
  hypothesis (tempo in mood text, or a bpm-aware rerank term). The drift is
  slow and in-band per night, but it is now directional across add nights
  rather than noise. Jake's call whether to prioritize the hypothesis.
- Sentinels: **vibe-prod-006 0.64 → 0.68** — its first move in 7 nights,
  and UP. **leaf-20 0.92 → 0.88** (−1 slot, first move after holding 0.92;
  watch informally, not a series).

## Queue

`pick_experiment.py pick` → **IDLE** (ledger row written):
- E1 skip — bare mood vectors = 0 (every add enriched same-night, again).
- E2 skip — genre-tag churn 22/11,550 = **0.19%** vs the snapshot (needs
  >1%). The Avalanches re-file is most of it; `main-index-tags.json`
  unchanged (no E2 apply).

Auto lane EMPTY, Jake lane EMPTY. Open Jake items after tonight:
grd-16 fenced-JSON parse proposal, **NEW grd-12 legacy-tag proposal**, the
tempo_family gap (now flagged as directional), the gemma4 promotion queue
item (when redescribe staging completes), and the vocab re-export
(Plunderphonics — clears 31 of the 33 unresolved tags).

## Applied

**Nothing.** No candidate was built; no brain file was written. NAS brain
re-verified unchanged at session end (emb `b592fa44d6e2…`, mood
`28b7f9f73f4b…`, mtimes 02:03).
