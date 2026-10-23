# Taste engine — how JakeTunes learns Jake's taste (2026-10-19)

Jake: *"I don't want an AI system that merely runs exercises every night. I want
one that actually gets smarter."* This is the design of that system. Before it,
the nightly jobs catalogued songs and graded search; nothing learned from what he
actually did with the music.

## Jobs (all nightly, one writer per output)

| When | Where | Job | Writes |
|---|---|---|---|
| 02:00 | homemini | brain-trainer — describes new songs (sound/mood/meaning) | embeddings.bin, mood-index.bin (NAS) |
| 02:15 | laptop | taxonomy-classify — subgenres; hands them to the running app (`taxonomy-staged.json` → `src/main/taxonomy-staged.ts`) | metadata-overrides.json (app is the writer) |
| 03:05 | homemini | brain-improve — search-quality guardian (154-probe quiz), idle when its queue is empty | brain-eval branch |
| 04:00 | homemini | listening history — every device's plays/skips, one file | yir/listening-history.jsonl |
| **04:40** | **homemini** | **taste engine** — `scripts/taste-engine-nightly.sh` → `scripts/taste-engine.py` | **taste-state.json** (~/JakeTunesState + NAS), scorecard, journal |
| 08:45 | laptop | strip learner v2 — `scripts/taste-ledger-learn.py` | taste-weights.json |

The 04:00 and 04:40 jobs watch each other (30 h staleness → phone alert / loud failure).

## What it learns from (Jake's rule: stars + behavior)
- Every **full listen** is a yes, every **real skip** a no (glances < 5 % and skip
  bursts are not verdicts). A **star** is the strongest yes. Repeats on different
  days, coming back after 45+ days, plays per month owned.
- The **sound** of each song (mood-index: descriptor + tempo + genre line, identity
  stripped), so it learns which characteristics pull him in. Artist love stays per
  artist — loving Geese never raises a band because it sounds like Geese.
- Suggestion verdicts (taste-ledger.jsonl, synced to homemini) and the daily-mix
  songs served (mixes-cache.json).
- **Top 1000 Quiz verdicts** (homemini `top1000-answers.jsonl`: in/out, still love it,
  both/neither, all three/none) as one more feature, counted only as of each snapshot,
  so a window is never graded with a verdict given after it started. Until the newest
  training window starts after his first answer (2026-11-20) the column is zero and
  changes nothing; then the held-back test decides its worth, and the scorecard's
  `quiz.gain` shows what it added. Using the verdicts as extra training LABELS was
  tried on 2026-10-23 and failed the test: held-back AUC 0.589 → 0.47, below v5.
  "One of my 1000 favorites" is a different question from "will he finish it next month".

## The nightly exercise
1. Ingest behavior. 2. Measure preference drift (recent vs long-run sound
preference; genre shares last 30 d vs the 90 before). 3. Grade past
recommendations (mix songs played through vs skipped; strip/Discovery adds kept
and played). 4. Name recurring mistakes (songs served and skipped 2+ times).
5. **Champion vs challenger on held-back time** — three rolling 28-day windows:
features from everything before a window, outcomes from inside it; nothing graded
was seen when the model was built. Champion = taste v5 (the formula mixes used).
6. **Promote** only on a mean gain ≥ 0.01 with a fold-stratified bootstrap 5th
percentile > 0, winning a majority of windows, and not ranking suggestion adds
worse (a veto, never a promoter). Stay promoted while not worse; **roll back**
otherwise. Too few verdicts → "insufficient data", never a score. 7. Publish.
8. Journal what changed, why, and whether it helped.

## Consumers (automatic rollback)
- homemini mixes / DJ: `backend/src/util/tasteState.ts` → `tasteScore` uses the
  learned score only while `promoted` and < 72 h old; v5 otherwise.
- Desktop: `src/main/taste-state.ts` adopts the NAS copy; the playlist strip's
  taste term uses the learned percentile under the same rule. With no NAS
  mount (workmini, a replica) it asks homemini's backend instead —
  `GET /api/taste-state` (JakeTunesMobile `backend/src/routes/tasteState.ts`)
  serves the same file from memory with an ETag, so the 10-minute poll is a
  304 until the next nightly build. Same rules: malformed or older builds are
  refused.
- Scores are quantile-mapped onto v5's distribution, so TASTE_W keeps its meaning.

## Both Macs (2026-10-20)
Jake's taste choices hold on the MacBook and workmini, wherever he made them:
Record Shop "Not for me" (+ "Allow again"), strip ✕ / refresh / add, Discovery
verdicts, the Rock DNA quiz and its Dislikes.
- Each Mac writes only its own `discovery-feedback.json`, `taste-ledger.jsonl`,
  `rock-dna.json`. The sync script pushes them to homemini (hub folder, or
  `replicas/<name>/`) and pulls the OTHER Mac's copies into
  `userData/taste-elsewhere/<source>/` (`pull_taste_elsewhere`).
- The app merges those read-only copies in memory (`src/common/taste-shared.ts`,
  readers in `src/main/taste-elsewhere.ts`): a union, the newest verdict wins
  (allow vs reject per artist, each quiz answer by its `at`, a retake supersedes
  the run before it). The strip's rules are unchanged and count both Macs: two
  refreshes, one on each Mac, hide for 90 days. An add made on the other Mac
  reads as "taken back" only once it is a day old.
- The Record Shop applies the merged verdicts when it builds the feed AND every
  time a feed leaves main (`dropVetoed`), so a cached feed loses a card the
  moment the other Mac's "Not for me" arrives.
- `taste-weights.json` and `taste-profile.json` have one writer (the laptop): a
  replica mirrors the hub's copy into its userData on every sync (valid JSON,
  newer only) and the workmini deploy carries them in SIDECARS.
- A taste choice queues a batched `taste` sync (≤ 5 min) so it leaves the Mac
  without waiting for an unrelated library save.
- Not shared: the strip learner (08:45) still learns weights from the laptop's
  own ledger only.
Tests: `src/main/__tests__/taste-shared.test.ts`, `sync-script-taste-shared.test.ts`.

## First readings (10/19, real data, out-of-time)
| test | challenger | v5 |
|---|---|---|
| finished vs skipped, 3 windows | 0.608 (0.595 / 0.649 / 0.580) | 0.501 (0.542 / 0.453 / 0.510) |
| strip adds vs passes (frozen 56 d ago) | 0.639 | 0.610 (strip's old stars/plays term: 0.558) |

## Ready for "Discover Weekly from my library" (not built)
taste-state.json carries per-song flags: underplayed favorite, forgotten
(starred/5+ plays, silent 180 d — fills in as play dates accumulate; history
starts 2026-05-25), overlooked album track, never played, matches recent sound.

## Files
`~/Library/Application Support/JakeTunes/taste-engine/` on homemini:
`taste-scorecard.json` (latest), `taste-journal.jsonl` (history),
`taste-engine-status.json` (staleness). Log: `~/Library/Logs/jaketunes-taste-engine.log`.
Tests: `python3 scripts/tests/test_taste_engine.py`, `src/main/__tests__/taste-state.test.ts`,
JakeTunesMobile `backend/src/util/__tests__/tasteState.test.ts` + `backend/src/routes/__tests__/tasteState.test.ts`.
