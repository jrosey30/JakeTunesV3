# Nightly brain exercise — 2026-09-08 (homemini)

**Outcome: (b) nothing beat baseline, nothing changed — brain untouched.**
Both brain files verified unchanged before and after every measurement
(embeddings.bin sha `882bfb33adc7195d7cba851a3846bca46b1bdd9b`, 65,144,220
bytes, mtime 02:01:47; mood-index.bin sha `67c1e12c354b4c5a0122f9bd617dec61b6623bc7`,
64,320,388 bytes, mtime 02:01:51 — the trainer's own final writes).

## Preconditions

- Trainer clean via launchd 06:00:02–06:01:52Z: +50 enriched (10,229/10,793),
  500-track tempo catch-up ("0 newly analysed, 500 on an older encoding"),
  embeddings 10,596 vectors, mood 10,462. No meaning catch-up line tonight.
- No post-trainer replay: brain mtimes == trainer's writes, stable >1h.
- Snapshot to /tmp/brain-snap-20260908, per-file sha ×3 before copy, copy
  sha-verified (keeper-flap paranoia held; no torn reads).
- Worktree from origin/brain-eval @ 25d08a7 (local branch was 3 nights
  stale — fast-forwarded first); throwaway venv; 1-token Anthropic probe
  (200) before grounding spend.

## Pre-check: NO clobber (4th consecutive lucky import day)

Import day (+66, library 10,727→10,793). Fingerprint **18 orphans /
5 dup groups** — the naive >10 threshold in precheck says CLOBBERED but
the composition is entirely benign (verified in `diag_precheck_20260908.py`):

- Orphans = the known 11338–11349 block (12, byte-familiar from
  09-05/06/07) + **6 new** (9796, 9820, 9863, 10642, 10923, 10924 =
  same-day-deleted tracks; the same 6 appear as new embeddings-index
  orphans, 146→152). Not the replay signature (~125/60 with resurrected
  prune-list ids).
- All 5 dup groups = the benign un-enriched same-artist class (te=None,
  no descriptor): Creed ×2, Tate McRae ×5, Bad Colours ×7, Lifehouse ×5,
  orphan block ×4.

Clobber ledger stays **15/19 import days**; the replay writer
(autoBackupStateToNas) is still unfixed — luck, not fix.

## Baseline (frozen snapshot, JT_STATE_DIR honored)

**retrieval 0.750 / grounding 1.000 (10/10 incl. 4 traps) / overall 0.875**
— in the v2 band (0.748–0.757). score_log row appended + committed.

## Router-truth series (rt_20260908.py — current indexes, read-only)

**0.808** (mood-routed mean 0.784/9). Series: 0.818 (09-04) → 0.816 →
0.811 → **0.808**. The wave depression is deepening, and tonight's
diagnosis (`diag_ret007_20260908.py`) shows exactly why: ret-007
"punk rock" mood top-9 = 4 orphan bare embeds (11338–11341, cos 0.622)
+ 5 un-enriched Lifehouse `genre: Rock` bare vectors; ranks 10–25 are
genuinely punk. Known classes only — no new failure mode.

## Watch items

1. **Tempo-catchup watchlist: 33/34 STILL te=False** (11467–11499; id
   454 cleared) after a 4th straight 500-re-encode night. New: exact
   queue position ~7,488 of 7,588 te≠3 entries = **~14 more nights**.
   Appended as the 4th data point to PROPOSAL-tempo-catchup-queue-order.
2. **Enrichment backlog GROWING: 315 → 458 → 542 → 564** over four
   nights — batch=50 loses to a 66–193/day import wave; rt sags in
   lockstep. → **NEW PROPOSAL-enrichment-backlog-drain.md** (supervised
   one-shot drain or adaptive batch; Jake-gated, trainer-side).
3. Embeddings-index standing orphans 146→152 (watch only; prune proven
   0.000 on this ruler 08-10).
4. NAS tmp litter 9 (steady, benign). Skips **1,049 mobile** (+42;
   merged ~1,659; v4 verbatim re-run gate ~3,000, ~mid-Oct).

## Why nothing was applied

The only buildable candidates tonight (orphan prune ± un-enriched
re-embeds) are the same shapes 09-05/09-06 proved and correctly refused:
mid-wave rt tops out ~0.82–0.83 vs the pre-registered ≥0.83 bar, and
re-embedding mid-wave fresh imports pre-empts the trainer's own
self-heal with unsettled metadata (the 09-05 lesson). Re-running a
known-FAIL candidate to adjudicate my own bar downward would be the
exact multiple-comparisons move the guardrails ban. Skip experiments
are gated until ~3k; taste-drift re-run due ~09-16.

## For tomorrow's nightly

- Standard pre-check; clobber can return any import day.
- Expect ret-007 depressed until the Lifehouse/Tate McRae/Bad Colours
  block enriches (nightly-50 order) or a backlog drain runs.
- If brain mtimes > trainer-done: post-trainer replay → BOTH repairs
  (09-04 pattern, verify .bak count vs trainer log first).
- Taste-drift monthly re-run due ~09-16.
