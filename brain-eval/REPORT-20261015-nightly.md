# Nightly brain report — 2026-10-15 (homemini)

**Outcome (b): nothing applied, by design and by result.** The queue picked
**E8** (auto lane, measure-only): price whether folding the grounded
lyrics-meaning line back into the MOOD text sharpens vibe retrieval.
**Answer: no — the hypothesis is refuted.** Meaning arm vs control arm on
the same 300-track sample: mean per-probe Δ **−0.0008** (CI90
[−0.0023, +0.0008]), vibe **−0.004** (hypothesis needed ≥ +0.01),
tempo_family −0.0075. Recorded `measured`; no Jake proposal is warranted.
The NAS brain was never written — scratch copies only. Both brain files'
shas are unchanged from the 03:06 snapshot.

## Pre-check

Brain-trainer finished tonight at 06:00:52Z (02:00:52 ET): +16 enriched,
brain now **11,600/11,600 tracks, embeddings.bin 11,756 vectors,
mood-index 11,600 vectors**. Both files' mtimes stable since 02:00 ET —
no writer race. Snapshot `/tmp/brain-snap-20261015` sha-verified pre/post
copy: embeddings sha256 `e2a68df77975…`, mood `d8763a494ba0…` (both new vs
10-14 — the trainer's 16-track run, a known writer, not an anomaly).
Snapshot carries the aux files (artist-members / metadata-overrides /
lyrics; no audio-index.bin on the NAS — fusion off, as recorded).
Worktree `/tmp/jt-eval-20261015` at brain-eval `042d353`, `.env` copied.

## Baselines (snapshot, production bridge, main src 12bb43b24d49)

- **v1 (`B1-20261015`): 0.810 / 1.000 / 0.905** — exactly the 10-12
  normals, fourth confirmation night. Routes 8 mood / 7 main.
- **v3 (`B3-20261015`): headline 0.804, grounding 1.000 (20/20)**, primary
  source **bridge**, routes main 29 / mood 94 / mood+lexicon 1 /
  main+decade 30 — identical route profile to 10-13/10-14. Groups: artist
  0.963, umbrella_family 0.913, leaf **0.845**, family_decade 0.872,
  tempo_family 0.510, vibe 0.719. vs the post-E3 reference 0.805: −0.001
  on a brain that gained 16 tracks tonight — the E3 win is holding. No
  grounding flake this night (v3-grd-16 scored 1.000 normally).

## The experiment: E8 picked, measured, refuted

`pick_experiment.py pick` → **E8** "Lyrics meaning in the mood text
(300-track sample)" (auto lane, prio 40, `measure_only: true`,
max_nights 1). E1 skip (bare backlog 0), E2 skip (genre-tag churn 0.00%).
Preconditions held: 7,507 described tracks with a lyrics meaning + mood
vector (≥300 needed); `bridge/mood-meaning-sample.ts` present.

Method run exactly as written (scratch copies only, seed 8, n=300,
main src `12bb43b24d49`):

- **Control arm** (`E8-control-20261015`): re-embedded the 300 sampled
  mood vectors with production text. Result **retrieval-identical to the
  baseline** — headline 0.804, every group equal. The re-embed round-trip
  is clean, so the comparison isolates the meaning line itself.
- **Meaning arm** (`E8-meaning-20261015`): same 300 tracks with the
  grounded "what the song is about" line folded into the mood text.
  Headline 0.802 — vibe 0.715 (−0.004), tempo_family 0.502 (−0.008),
  umbrella_family 0.916 (+0.003); 3 probes up / 4 down / 147 same.

`gate.py --v3-only` (pricing mode, never applies): exit 1 —
mean Δ −0.0008 (need ≥ +0.005), CI90 [−0.0023, +0.0008] (lower bound must
be > 0). Gate JSON: `/tmp/gate-E8-20261015.json` (quoted in the ledger).

**Interpretation.** The meaning line's semantic content doesn't help the
mood index find vibes — it adds lyric-topic words that slightly blur the
sound/feel signal the router depends on (tempo_family took the largest
hit). This closes the question PR #66 left open when the meaning line left
the main brain on 10-10: it doesn't belong in the mood text either. E8 is
spent (max_nights 1); a re-queue would need a NEW hypothesis per the
requeue rule.

## Ledger / queue state

- E8 → `status: measured` (2026-10-15T03:09:09), metrics + gate JSON in
  `experiments/ledger.jsonl`.
- Auto lane now empty of eligible items: E1 premise gone (bare=0), E2
  blocked (churn 0), E3 spent, E8 measured. Remaining queue: **E7 and E10
  (both Jake-lane, tempo_family gap — main-idx diagnostic still 0.110)**
  and nothing else. Unless churn/backlog reappears, the next nights will
  be MEASURE (pricing a Jake proposal) or IDLE. tempo_family (0.510
  primary) is the clear next gap and it needs Jake's call on E7/E10.
- Open proposals unchanged; PROPOSAL-taste-weights-refresh-v4 still
  Jake-gated.

## Current scores (post-night — brain unchanged)

| ruler | headline | notes |
|---|---|---|
| v1 | 0.810 / 1.000 / 0.905 | fourth straight night at the normals |
| v3 | **0.804** | grounding 20/20; new reference for the 11,600-track brain |

Live brain: embeddings.bin sha256 `e2a68df77975…` (11,756 vectors),
mood-index.bin sha256 `d8763a494ba0…` (11,600 vectors) — both written only
by brain-trainer tonight; this job wrote nothing to the NAS.
