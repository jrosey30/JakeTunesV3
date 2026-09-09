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
