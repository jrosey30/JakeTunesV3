# Brain Improvement H2 2026 — the road to a trustworthy Year in Review

Jake, 2026-08-23: "how is year in review going to look? im not sure i
trust it the way the brain is today. the brain must improve."

Baseline captured that night (Mini /api/brain-eval, 02:56Z):
- taste AUC **0.819** (down 0.010 from the 8/07 baseline 0.825) — the
  judgment layer SLIPPED as the library grew to 9,686 / 1,226 starred
- embeddings + mood coverage complete; self-recall@5 = 1.0; vibe
  queries sane → retrieval is healthy, JUDGMENT is the weak layer
- discovery verdict stream: 72 signals (53 accept / 19 reject) and
  growing fast since the shop reorg

## Year in Review (Dec 17) — two trust classes

**Class A — play-data facts (trustworthy TODAY, no brain involved):**
top artists/songs/albums by real windowed play events; minutes/days;
month-by-month timeline; Starred class of 2026; import history; the
Best of 2026 playlist as the soundtrack. These come from the per-play
log and library records. Ship-ready.

**Class B — brain claims (the trust gap):** "the shape of your taste,"
genre/era narrative, mood characterizations, "your discovery wins,"
persona commentary over the year. These lean on embeddings + the taste
model + descriptors. At AUC 0.82 they'd read plausibly-wrong often
enough to break the whole Review.

**Design rule carried over from the learned panel:** every Class-B
claim in the Review states its evidence volume, and thin evidence says
so out loud. A Review that can say "I don't know you well enough to
claim this" earns the right to be believed elsewhere.

## The program (measure-first; the revertible-ledger gate applies)

1. **Descriptor upgrade A/B.** Descriptors are written nightly by
   gemma3:4b on the Mini — a 4B model is the quality ceiling under
   every embedding. Experiment: re-descriptor a stratified ~300-track
   sample with Claude Haiku, re-embed the sample, run the eval's
   recall + vibe queries + AUC on a sample-swapped index. Adopt
   library-wide ONLY on a measured win (the nightly-improve gate).
   ⚠️ buildEmbeddingText has a declared TWIN in scripts/brain-trainer.mjs
   — any text-shape change lands on both sides in one commit.
2. **Verdict volume.** The shop now feeds accept/reject into scoring
   (2026-08-22). Keep the flow growing. ⚠️ 2026-09-01 disposition: the
   Aug-23 taste-v4 lab RE-tested skips at 6x the June data — still
   nothing. Skip-folding is measured-dead; verdict volume remains the
   live lever.
3. **Taste-model features.** ⚠️ 2026-09-01 disposition: exp-recency
   tested by the Aug-23 lab = noise; playINTENSITY shipped (+0.006).
   Completion-rate has NO per-track data yet — it waits on new signal
   collection (play-event completion / iPod Round Trip), not model
   work. The 0.85 AUC target stands, gated on new signals.
4. **The became-loved metric (the trust metric).** ✅ SHIPPED 2026-09-01
   in kpi-snapshot (Sun 9am): discover accept → imported → playCount
   ≥ 5 within 60d, decided-cohorts-only. First run: 87 accepts pending;
   first decided cohort ~Oct 7 — trend exists before December.
   ALSO 2026-09-01: the 6.0 3c RERANKER shipped both repos —
   retrieval_prod 0.753 → 0.815 (lexical genre bonus w=0.08 at the
   ragRetrieveByQuery choke point, twinned to Mobile).
5. **AUC drift alarm.** ✅ SHIPPED 2026-09-01 (Mobile 1ecb280): the
   weekly Mini eval WARNs on aucDelta < -0.02 alongside the 0.72
   absolute floor — a slipping brain pings the phone. Also 2026-09-01:
   run_eval.py now scores the PRODUCTION retrieval path (V2 bucket via
   brain-eval/bridge/) — first reading retrieval_prod 0.753; mood-route
   vibe queries (0.24–0.48) are the measured weak wing for item 2/3 +
   the 6.0 reranker to move.

## Sequencing

Sept: 1 + 5 (descriptor A/B decided by data; drift alarm live).
Oct: 2 + 3 (signal growth; feature work measured weekly).
Nov: 4 trend review; freeze the Review's Class-B section list based on
what the numbers actually support.
Dec 17: ship the Review with Class A everywhere and only the EARNED
Class B.

## 2026-08-23 overnight: the descriptor A/B campaign (4 arms, no launch)

| arm | result |
|---|---|
| gemma4:e4b | 100% empty responses — and it's Gemma 3n *effective*-4B, an edge model, not an upgrade at all |
| qwen3:8b | fluent but MORE monotone than incumbent (diversity 0.213 vs 0.26); needed think:false (empty otherwise — lesson now in the trainer) |
| prompt-v2 (ban-list + "unusual detail") | diversity 0.331 (+27%!) but the detail demand made 4B CONFABULATE — theremins, carousel calliopes, children whispering. Would poison retrieval. |
| prompt-v3 (ban-list + no-invention) | grounded but stilted ("This track possesses…" template), diversity back to 0.27 |

**Decision: no full rewrite.** The incumbent gemma3:4b descriptors are
genuinely good; the 8h re-embed had nothing better to write. The REAL
finding: the descriptor layer is near its useful ceiling — the AUC
slippage (0.819) lives in the TASTE MODEL, so the improvement effort
moves to program items 2+3 (verdict/skip volume, recency+completion
features). Assets banked: the A/B rig (runner on the Mini, reusable in
one command), trainer --redescribe-all + GEMMA_MODEL override +
think:false (all committed — the moment a genuinely better
model/prompt exists, the overnight path is one launch away), qwen3:8b
staged on the Mini.
