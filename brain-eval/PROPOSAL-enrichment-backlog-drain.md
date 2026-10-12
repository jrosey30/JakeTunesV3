# PROPOSAL: drain the enrichment backlog — the nightly-50 cap loses to the import wave

**Status: OPEN — Jake-gated (trainer behavior change / supervised one-shot run)**
**Filed: 2026-09-08 nightly**

## The problem, with tonight's numbers

The trainer enriches `batch=50` tracks/night (Gemma descriptor → OpenAI
re-embed). The September import wave has landed 66–193 tracks/day. The
un-enriched backlog is therefore **growing, not draining**:

| night | library | enriched | backlog |
|-------|---------|----------|---------|
| 09-05 | 10,400  | 10,085   | 315     |
| 09-06 | 10,593  | 10,085→10,135 | 458 |
| 09-07 | 10,727  | 10,185   | 542     |
| 09-08 | 10,793  | 10,229   | **564** |

Every un-enriched track carries a bare `genre:`-only mood vector — the
exact class that hijacks genre probes (tonight: 5 bare Lifehouse
`genre: Rock` vectors in ret-007 "punk rock"'s top-9, diagnosed in
`diag_ret007_20260908.py`). Production consequence: router-truth has
sagged 0.818 → 0.816 → 0.811 → **0.808** over four nights — the
documented "wave ceiling ~0.82" is not a ceiling that lifts on its own
while imports outpace enrichment. At current rates the mood side of the
brain degrades indefinitely.

## Why batch=50 exists

Gemma on homemini (16GB shared with Nextcloud) 500s under concurrent
load. The cap is a load limit, not a design target.

## Proposed fix (pick one, Jake's call)

1. **Supervised one-shot drain** (least code): run
   `node scripts/brain-trainer.mjs` manually in a loop over several
   afternoons (it's idempotent; each run takes the next 50) or with a
   temporary `batch` env override at ~100–150, watching Gemma for 500s.
   Zero permanent change.
2. **Adaptive batch** (small trainer change): if backlog > 300, raise
   the per-night batch to 150 with sequential (not concurrent) Gemma
   calls and a small sleep between tracks — throughput bound, not
   concurrency bound, so the OOM risk stays flat.

Either way, pairs with PROPOSAL-tempo-catchup-queue-order (fresh-first
queue sort) — enrichment gives new tracks descriptors, the queue fix
gives them tempo encoding; both are needed before a wave stops costing
~2–3 weeks of degraded mood routing.

## Evidence

- trainer log 2026-09-05→09-08 `done:` lines (the table above)
- `rt_20260908.py` — router-truth series point 0.808
- `diag_ret007_20260908.py` — bare-genre hijack of ret-007, verified
- REPORT-20260904-nightly.md — the "~0.82 wave ceiling" first noted

## 2026-09-09 update — backlog turned around; sag decomposed

- Backlog series now 315→458→542→564→**533** — first shrink night (+19-import day;
  batch=50 wins when imports < 50/day). The proposal stands for wave days, but no
  emergency drain is needed right now.
- exp_20260909_sag_decomp.py decomposed the rt sag (0.805 tonight): un-enriched
  component +0.022 (self-heals ~50/night), orphan component +0.013 (never heals —
  see PROPOSAL-mood-import-clobber 09-09 note). Post-wave ceiling estimate **0.840**
  = the healthy band, so the sag is fully accounted for; nothing hidden is broken.

## 2026-09-10 update — shrink stalled by a +49-import day

Backlog series 315→458→542→564→533→**532** — technically a second shrink night,
but only net −1: the trainer enriched +50 while 49 new imports landed (library
10,812 → 10,861). batch=50 merely treads water on a ~50-import day, exactly the
proposal's premise. Meanwhile the un-enriched rt component measured +0.011
tonight (down from +0.022 on 09-09 — it does self-heal when imports pause).

## 2026-09-11 update — first REAL drain night

Backlog series 315→458→542→564→533→532→**485** (net −47: +50 enriched vs +2
imports — batch=50 drains exactly as predicted the moment imports pause).
At this rate the wave clears in ~10 quiet nights. The un-enriched rt component
measured +0.009 tonight (series +0.022 → +0.011 → +0.009, self-heal on
schedule). Note: the mood-index's un-enriched-in-lib cohort is EXACTLY 215 for
a second night even as the backlog fell 47 — the stale bare-genre mood vectors
belong to earlier import days, and tonight's 50 newly-enriched tracks entered
the mood index only at enrichment time. The 215 will drain only as the queue
reaches those specific import-day tracks. Proposal stands for wave days;
no emergency drain needed while imports are quiet.

## 2026-09-12 update — second real drain night; the 215 cohort is queue-locked

Backlog series 315→458→542→564→533→532→485→**447** (net −38: +50 enriched vs
+13 imports). Two consecutive drain nights; ~9 quiet nights to clear at this
rate. The un-enriched rt component measured **+0.009** again (series +0.022 →
+0.011 → +0.009 → +0.009 — the self-heal curve has flattened because the
mood-index's un-enriched-in-lib cohort is EXACTLY 215 for a THIRD night even
as the backlog fell another 38). This is now three-point-proven: the stale
bare-genre mood vectors belong to specific earlier import days and drain only
when the enrichment queue (library-order) reaches those tracks — nightly
enrichment of *newer* queue positions never touches them. The remaining
~+0.009 of wave sag is therefore stuck until the queue arrives, which is the
same queue-order defect PROPOSAL-tempo-catchup-queue-order documents.
Proposal stands for wave days; no emergency drain needed while imports are quiet.

## 2026-10-10 update — October wave outruns batch=50 a second night

Backlog 0 (10-08) → 119 (10-09, +168 imports) → **226** (10-10, +156 imports):
two consecutive wave days each >3× the nightly batch. Production impact stayed
nil both nights (rt 0.837/0.837, baseline band-center — the 34ba4de prune means
vectorless new tracks are ABSENT from the mood index, not polluting it), so
this remains a latency problem, not a quality problem: at batch=50 the new wave
is vibe-blind for ~5+ quiet nights, longer if imports continue. Unchanged ask;
this is the first multi-day compounding wave since the proposal was filed.

## 2026-10-11 update — STATUS CHANGE: the backlog now actively COSTS production quality (was latency-only)

Backlog 226 → **236** (+60 imports vs +50 enriched — compounding a THIRD night).
The 10-10 daytime plain-brain re-embed (PR #66 `--reembed-all`) changed the
backlog's failure mode: it wrote mood vectors for ~277 backlog tracks that were
previously ABSENT from the index. Absent vectors can't pollute; present-but-BARE
(tempo+genre only, no descriptor) vectors can and do:

- ret-007 "punk rock" mood recall@25 fell 1.00 → **0.44**, with **14/25 top
  slots held by tonight's bare new-import vectors** (diag_ret007_20261011.py,
  id-level; every enriched slot in the top-25 is a hit — the brain is fine,
  the bare cohort is the entire gap).
- mood-routed rt mean 0.846 → **0.780** (−0.066) in one night.
- Headline rt still rose to an all-time high 0.849 (plain main brain lifted
  the main-routed probes), which MASKS the mood-side dilution in the topline.

So the trade-off the proposal weighs is no longer "vibe-blind new tracks for
~5 nights" but "degraded mood routing for every night the backlog persists,
growing with each wave day that outruns batch=50." At 236 and compounding,
that's ~5 quiet nights of degradation minimum. This is the strongest evidence
yet for the supervised drain / adaptive batch ask. NOT auto-applied (trainer
code + a ~236-call Gemma load on the shared 16GB box = supervised-run
territory, Jake-gated as filed). Self-heal check each nightly: bare-in-top25
on ret-007 must fall ~nightly; if it grows on a no-import night, something new.

## 2026-10-12 — queue-order starvation PROVEN + mood-refresh sequencing constraint
Import night wave 4 (+141, library 11,560; backlog 236→327, compounding 4th
night). The trainer's entire 50-batch went to the NEWEST imports (precheck:
+50 adds ids 12663–12712, 0 existing vectors changed) — the 227-track
present-but-bare mood cohort drained by ZERO; ret-007 bare-in-top25 static
14/25, recall 0.44 (diag_ret007_20261012). "Self-heals ~50/night" is
falsified while imports keep landing: the enrich queue starves the oldest
bare tracks (same ordering lever as PROPOSAL-tempo-catchup-queue-order).
NEW SEQUENCING CONSTRAINT (measured 10-12): refreshing mood texts to the new
genre taxonomy while the bare cohort exists is HARMFUL (full reembed-all
candidate: ret-007 mood 0.44→0.16, bare-in-top25 14→21, mood-routed mean
−0.021 → REJECTED; main-only applied instead). Right order: (1) drain the
bare cohort (this proposal), (2) THEN one `--rebuild-mood-index` to carry
the 10-11 taxonomy into mood texts. Both steps Jake-gated as filed.
