# Nightly brain exercise — 2026-09-04 (homemini)

## Outcome (a): two proven, reversible repairs applied
1. **mood-index.bin** — 14th clobber repaired: router-truth **0.728 → 0.818** live-verified,
   worst per-probe delta **+0.00** (strictly no harm).
2. **embeddings.bin** — trainer's night output RESTORED over a stale desktop replay
   (612 vectors), proven eval-neutral. First identity-index apply since 08-25.

## The night's new event: the replay fired AFTER the trainer
Every prior clobber replayed during the day; tonight `autoBackupStateToNas` fired at
02:18–02:25, **after** the trainer finished (02:09), so it reverted the trainer's
whole night in BOTH indexes:
- `library.json` 02:05 (+12 Ramones imports), `embeddings.bin.bak` 02:18 (the replay's
  own backup = the trainer's post-run state, exactly 10,384 vectors == trainer log),
  `embeddings.bin` 02:20 (desktop's stale map, 10,396), `mood-index.bin` 02:25.
- Proven: fresh-enriched tracks' stored mood vectors matched the app's tempo+genre
  import embeds at **cos 1.0000** (VW "Horchata", Dylan "Hurricane") — the trainer's
  fresh-50, the 500 tempo/key-v3 catch-up, and the 150 meaning re-embeds were gone.
- **Severity escalation for PROPOSAL-mood-import-clobber:** the replay now also
  reverts identity-index enrichment whenever it fires post-trainer, and the te=3 /
  meaning stamps in brain-descriptors.json (NOT replayed, mtime 02:09) survive — so
  the trainer never revisits those tracks: silent permanent staleness, the exact
  mood-clobber mechanism now on embeddings.bin.

## Coordination checks
- Trainer clean (launchd 06:00–06:09Z): +50 enriched (10,035/10,250 at run time),
  tempo catch-up 500 on **encoding v3** (efd066e, PR #43: omit low-confidence
  key/Camelot), meaning catch-up 150. 8th consecutive clean trainer night.
- Files stable ≥40 min before measurement; snapshot sha-verified ×3 per file.
- Anthropic key probed (1 token, 200) before grounding spend.

## Baseline (frozen snapshot, library 10,262 = +277 import day)
run_eval retrieval **0.756** / grounding **1.000** / overall **0.878** — v2-band
normal, blind to the clobber as ever (P1 exhibit #10). Pre-check fingerprint:
mood 133 orphans / 68 dup groups (438 tracks) = clobber (14/14 import days).

## Repair 1: mood-index (recipe run, two adaptations — both committed)
- **Gate variant (new):** fresh cohort was itself reverted (see above), so gating on
  trainer-fresh vectors is impossible. Gated on **50 aged never-repaired key-trusted
  te=2** vectors (8,285 eligible; "key: " in intended text ⇒ v3 text == v2 text, so
  the encoding change is a no-op for the cohort): **50/50 ≥0.98, min cos 0.9999**.
- **Suspect-rule refinement 1:** suspects now require a descriptor. The +277 wave has
  ~215 un-enriched tracks; "repairing" their app embeds (tempo+genre from the app's
  LIVE bpm) down to our poorer bare-genre reconstruction turned Staind/Lifehouse
  "genre: Rock" into punk-query hijackers — first candidate FAILED bars at
  ret-007 0.68→0.32. With the rule: skipped 133 un-enriched, ret-007 0.68→0.80.
- **Suspect-rule refinement 2:** the tempo-view exclusion now parses the
  reconstruction's bpm from the intended text (override-applied) instead of raw
  library bpm — the raw check had wrongly protected 43 clobbered fresh imports whose
  bpm lives only in metadata-overrides. Exclusions tonight: 0.
- 1,256 suspects re-embedded (median cos 0.808 = clobber signature), 133 orphans
  pruned. Overrides line: recon `applied 10148` vs trainer `10144` — NOT byte-identical
  for the first time, explained: +12 imports and override rows landed 02:05, after the
  trainer's 02:00 read (Dylan's analysis hit overrides at 02:05:23, hence teb=0 while
  reconstruction rightly has tempo 135).
- **Prove:** worst per-probe mood delta **+0.00**; router-truth 0.728 → **0.818**.
  Formal 0.83-band bar FAILED; adjudicated and applied per the 08-20/24 precedent:
  - Watched probes: 007 **0.80** / 008 **1.00** / 011 **0.92** / 012 **1.00**.
  - ret-007's 5 misses and ret-013's misses = 100% fresh un-enriched imports
    (Lifehouse, Sister Nancy, Staind bare app embeds) — composition churn that
    self-heals at ~50 enrichments/night; ret-002 0.70 = the documented solo-Beatle
    P2 router artifact. No regression anywhere + a day of phone routing at 0.728
    if unapplied → apply.
- **Applied** sha 15f4f8097c05 → **04bfa4f34ad1**, backup
  `mood-index.bin.pre-repair-20260904` (undo = cp back), atomic rename, post-write
  live re-verify: 10,262 == library, 0 orphans, 5 dup groups — all same-artist
  un-enriched imports (benign class, self-resolves).

## Repair 2: embeddings.bin restore (apply_emb_20260904.py)
- Candidate = `.bak` (trainer post-run) + 12 live-only post-trainer imports
  (Ramones wave) = 10,396; restores 612 vectors to trainer bytes; drops nothing.
- Pre-registered bars, all PASS: worst identity probe delta −0.03 (ret-015, the
  documented Rock-tag ruler residual class, mood-routed anyway), 15-probe mean
  0.756→0.754 (bar −0.005: pass at −0.002), router-truth unchanged 0.818.
- **Applied** sha 7313b1807776 → **42930dfc1383**, backup
  `embeddings.bin.pre-restore-20260904` (undo = cp back), atomic rename, post-write
  verify 10,396 vecs dim 1536; stable double-read after.

## Watch list for next nightly
- **If the replay fires post-trainer again** (embeddings/mood mtime > trainer done),
  re-run BOTH repairs: mood recipe + `.bak`-merge restore (apply_emb pattern). Check
  `.bak` count == trainer log's vector count before trusting it.
- Router-truth ceiling is temporarily ~0.82 until the import wave enriches
  (~4–5 nights at 50/night); don't chase it. Expect the watched-probe fingerprint
  to return to 1.00/0.96–1.00/0.88+/1.00 as backlog drains (215 un-enriched tonight).
- Encoding-v3 rollout continues (~9,000 te=2 remain, 500/night). On zero-import
  nights the fresh gate returns; the aged key-trusted variant stays correct while
  te=2 vectors exist.
- Skips: not re-counted tonight (closed at <1,000; last 779).

## Ledger
| what | before | after | backup / undo |
|---|---|---|---|
| mood-index.bin | 15f4f8097c05 (10,395 v) | 04bfa4f34ad1 (10,262 v) | mood-index.bin.pre-repair-20260904 |
| embeddings.bin | 7313b1807776 (10,396 v, 612 stale) | 42930dfc1383 (10,396 v) | embeddings.bin.pre-restore-20260904 |

Scores: baseline 0.756/1.000/0.878 (frozen); live router-truth 0.728 → 0.818.
Snapshot + candidates left in /tmp (brain-snap-20260904, *.candidate-20260904.bin)
as day-of forensics.
