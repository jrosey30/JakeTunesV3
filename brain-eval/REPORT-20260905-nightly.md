# Nightly brain exercise — 2026-09-05 (homemini)

**Outcome: (b) nothing beat the requirements for an apply — brain untouched
(embeddings sha 7a7923afa128…, mood sha 3ac4f7955976…, before + after,
verified ×3 at 03:05 and again at 03:16).** First import day in 15 with **NO
mood-index clobber** — but that is luck/timing, not a fix: `STATE_FILE_NAMES`
in src/main/index.ts still mirrors both brain indexes, so
PROPOSAL-mood-import-clobber (fixes 4/5) remains the TOP ask.

## State of the night

- Trainer clean (launchd 06:00:04–06:08:04Z): +50 enriched (10,085/10,400 at
  trainer time), 500-track tempo/key-v3 catch-up, 150 meaning re-embeds, and
  the **first live run of the artist-members sidecar** (712 groups, 5,768
  tracks carry `members:` — identity text only; verified moodText does NOT
  include members, so mood reconstruction is unaffected).
- Import wave still landing DURING the night: library.json re-pushed 02:50
  and 03:16 (10,400 → 10,431+), post-trainer. The desktop app is awake and
  syncing (playlist hubs 03:02–03:03) yet did not replay either brain index
  all session.

## Pre-check + scan (no clobber, proven)

- Fingerprint: **12 orphans / 5 dup groups** vs the replay signature
  ~125/60. Orphans = ids 11338–11349, a contiguous just-imported block
  deleted/re-keyed during the day (zero overlap with the 09-04 prune list);
  dup groups = the documented benign same-artist un-enriched class
  (Creed / Tate McRae / Bad Colours / Lifehouse + one orphan group).
- Fidelity gate (aged key-trusted te=2 variant — see below): **50/50 min
  cos 0.9998**; overrides line byte-identical to the trainer's
  (`applied 10144, skipped 103 stale`).
- Full scan (10,300 embeds): **34 suspects = 33 fresh-tonight + 1 aged.**
  The 33 are tonight's fresh-50 cohort embedded BEFORE their librosa
  bpm (and for 8 Bear Ghost tracks, even genre) landed in the 02:50
  library push — proven faithful under the trainer's actual 02:00 view:
  6/6 sampled at cos **1.0000** with bpm/key nulled, 3/3 Bear Ghost at
  **1.0000** descriptor-only (/tmp/notempo_check_20260905.py,
  /tmp/ablate_20260905.py). This is why the fresh-50 could not serve as
  the fidelity cohort tonight (a THIRD reason after 08-24 trainer-FATAL
  and 09-04 post-trainer replay): **post-trainer metadata arrival at
  wave scale**. The 1 aged suspect is id 454 (The White Stripes — Black
  Math, cos ≤0.972, teb 90.9 == bpm 90.9): genre/descriptor micro-drift
  on one track, noise not an event; watch only if the class grows.

## Candidate proven but NOT applied (pre-registered bars honored)

Candidate = fresh-50 re-embedded with just-arrived bpm/genre + 12-orphan
prune: router-truth **0.816 → 0.829**, worst per-probe delta **+0.00**
(ret-007 0.64→0.80, ret-012 0.80→1.00, ret-013 +0.03). **BARS: FAIL**
(0.829 < 0.83). Not adjudicated around, because the candidate is not a
repair — there is nothing broken:

1. Every one of the 33 is the trainer's own tempo-catch-up target
   tomorrow night (bpm>0, te≠3) — the pipeline self-heals this class by
   design, with SETTLED metadata; librosa/genre were still landing at
   03:16.
2. The 09-04 note stands: rt ceiling ~0.82 until the wave enriches —
   current 0.816 is exactly that, don't chase.
3. The replay writer is alive and unfixed; an unforced write tonight
   buys ~24h of marginal mood freshness against real churn risk.

`repair_20260905_ids.json` is marked **scan_only_not_applied** so future
`prior_ids` loaders don't count tonight as an applied repair. Candidate
left at /tmp/mood-index.candidate-20260905.bin as forensics.

## Baseline + series

- run_eval (frozen snapshot, 1-token Anthropic probe 200 first):
  retrieval **0.757** / grounding **1.000** / overall **0.878** — top of
  the v2 band, traps 4/4 clean. Row appended to score_log.jsonl.
- Router-truth series: 0.816 (09-04 post-repair 0.818 → consistent,
  production stable through the wave).
- Skips **878/1000** (+99 in two days — fastest accrual yet; the 1k
  skip re-test may arrive in ~2 weeks, not 6). Taste-drift re-run due
  ~09-16. NAS tmp litter 4 → 9 (benign daytime accrual).

## Watch for tomorrow

1. Standard pre-check — the clobber can return any import day until
   fixes 4/5 land.
2. Tonight's fresh-50 should drop out of the suspect list after the
   trainer's tempo catch-up; if any of ids 11467–11499 are STILL
   suspects tomorrow with te≠3, the catch-up missed them — investigate.
3. If fidelity misses ever show this cos 0.78–0.94 teb=0 pattern again
   on a wave night, it's metadata-arrival skew, not a clobber — verify
   with the no-tempo/no-genre reconstruction before repairing anything.
