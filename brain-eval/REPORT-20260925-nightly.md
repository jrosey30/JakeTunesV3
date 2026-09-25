# Nightly brain exercise — 2026-09-25 (homemini)

## Situation at start (03:05 ET)
- Trainer clean launchd 06:00Z: "library fully enriched — nothing to do tonight" — SECOND consecutive
  nothing-to-do night (first was 09-24). No tempo catch-up line at all tonight (te!=3 queue exhausted
  down to the 31 v2 / 39 False bpm-less residue that cannot re-encode).
- library.json untouched since 09-21 12:50 → +0 imports, 21st consecutive no-clobber day.
- **NAS brain shas ×3-verified stable AND BYTE-IDENTICAL to the 09-24 measurement:**
  embeddings.bin 129d7cee147542ef8b89c8a09f542839d42375ea (68,187,480 bytes, mtime Sep 24 02:00),
  mood-index.bin c2d2e23414378b7ae377a05ccdf5a38ad1785eae (67,363,648 bytes, mtime Sep 24 02:00).
  First time in the nightly series the brain is unchanged across two consecutive nightlies.
- Pre-check fingerprint (precheck_20260925.py on frozen /tmp/brain-snap-20260925): mood 10,957 vec /
  18 orphans / 1 dup group (n=4) — the same benign id list an 11th night; embeddings 11,091 vec /
  152 orphans steady; enrichment 10,939/10,939 backlog 0; watchlist 0/34 (stays CLOSED).

## Tonight's one bounded experiment — pre-registered BEFORE any paid measurement

**A/A ruler calibration.** Every no-regression bar this series uses (the 0.744–0.757 retrieval band,
the ±0.003 rt wobble, "ruler wobble" adjudications on 09-18/20/21/22/24) rests on INFERRED run-to-run
eval noise — decomposition arguments, never a direct measurement. Tonight the brain is byte-identical
to last night's measured brain, so a full re-run measures PURE ruler noise (query re-embedding
nondeterminism + slot tie-breaks) with the brain provably constant. This datum is unobtainable on any
normal night.

Pre-registration:
- 09-24 readings on these exact bytes: run_eval retrieval **0.736** / grounding **1.000** / overall
  **0.868**; router-truth **0.821**; orphan component **+0.013** (S1==S2==0.835, un-enriched +0.000).
- Tonight's deltas vs those numbers = pure ruler noise, by construction. This is a CALIBRATION, not a
  gate: no brain action will be taken on any outcome.
- Alarm bars (harness-broken, not noise, if tripped): retrieval outside 0.72–0.78, rt outside
  0.80–0.84, grounding < 1.000 with a verified-live key, or any wrong-index artifact probe moving
  by >0.10 (ret-014/015 class). Any alarm ⇒ diagnose the harness; the brain cannot have changed
  (sha-pinned frozen snapshot).
- No apply is possible tonight by design: the only open lever (trainer-side orphan prune,
  sixteen-point +0.013–0.016) is Jake-gated; skips gate CLOSED at 1,186/3,000 organic; taste-drift
  due ~10-13.

## Results — A/A EXACT: the eval is deterministic on fixed bytes

Key probes first: OpenAI 200, Anthropic 200 (1-token each).

| metric | 09-24 (same bytes) | tonight | delta |
|---|---|---|---|
| run_eval retrieval | 0.736 | **0.736** | 0.000 |
| grounding | 1.000 | **1.000** (10/10 incl. 4 traps) | 0.000 |
| overall | 0.868 | **0.868** | 0.000 |
| router-truth | 0.821 | **0.821** | 0.000 |
| orphan component (17th point) | +0.013 | **+0.013** (S0 0.821 → S1 0.835) | 0.000 |
| S1 / S2 | 0.835 / 0.835 | **0.835 / 0.835** (un-enriched +0.000, unenriched_in_lib=0) | 0.000 |
| orphan slots | 007:4, 012:4, 008:1 | **007:4, 012:4, 008:1** | identical |

Intra-night check: a second retrieval pass (`--no-llm`, fresh query embeds ~30 min later) reproduced
all 15 per-probe scores exactly. rt per-probe vector byte-for-byte matches the 09-24 decomp.

**Conclusion (the calibration this night uniquely afforded):**
1. The harness is empirically **deterministic given fixed brain bytes** — OpenAI query re-embeds
   across 24h leave every top-k list unchanged (embedding nondeterminism is below tie-break
   threshold), and the grounding bucket reproduces 10/10.
2. Therefore the long-standing night-to-night "ruler wobble" (retrieval 0.736–0.757, rt ±0.003
   plateau wobble) is **NOT sampling noise — it is entirely real content churn** (trainer nightly
   re-embeds shifting cosine neighborhoods, library composition). The wobble adjudications stand
   (identity-index composition effects, not production regressions), but the mechanism is now
   proven content-driven, not measurement-driven.
3. **New standing diagnostic rule: on any night where embeddings.bin + mood-index.bin shas are
   unchanged from the last measurement, ANY eval delta — however small — means the HARNESS or
   environment broke, never the brain. Zero-tolerance A/A invariant; check brain shas against the
   prior score_log row before blaming anything else.**

## Actions
- Brain: **UNTOUCHED** (outcome b). Nothing beat baseline — no candidate was even buildable: the
  only open lever (trainer-side orphan prune, now SEVENTEEN-point-proven at +0.013–0.016) is
  Jake-gated; skips gate CLOSED (organic 1,186/3,000); taste-drift due ~10-13. End-of-run sha
  re-verify below.
- SEVENTEENTH orphan point +0.013 appended to the PROPOSAL-mood-import-clobber evidence series
  (0.013/0.013/0.011×6/0.013/0.016×4/0.013/0.016/0.013/0.013).
- Snapshot hygiene: /tmp/brain-snap-20260917…0922 deleted per 09-24 eligibility note; kept
  0923 + 0924 + 0925.
- score_log: 2 rows appended (full run + --no-llm probe capture), committed with this report.

## Open asks for Jake (unchanged)
1. PROPOSAL-mood-import-clobber fixes 4/5 (exclude brain indexes from autoBackupStateToNas replay)
   + trainer-side orphan prune (+0.013–0.016 rt, seventeen-point-proven — the only lever left).
2. PROPOSAL-tempo-catchup-queue-order — evidence complete (19 points, watch closed), decision his.
3. PROPOSAL-taste-weights-refresh-v4 + PROPOSAL-mobile-failure-skip-cascade — gated.
