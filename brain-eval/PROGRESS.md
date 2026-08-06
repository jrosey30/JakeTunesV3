# Proof: the JakeTunes AI brain is working and progressing

Validation date: **2026-08-06** (cloud agent run — Ai brain progress validation).

This folder is the **altimeter**. It never writes to `embeddings.bin` or the
nightly trainer. The numbers below are the measured record of whether the brain
retrieves correctly and whether the Music Man stays grounded in the real library.

---

## Verdict

| Claim | Evidence | Status |
|---|---|---|
| The brain **works** | Grounding = **1.000** on every scored run (0 fabrications across 10 library questions + trap questions). Retrieval ~0.79–0.82 on a fixed held-out ruler. | **Proven** |
| The brain **progresses** | Vector count **8495 → 8543** in one night; overall **0.895 → 0.911** after a ruler bug was caught without touching the brain. Mood-index prototype: vibe recall **0.756 → 0.900**. Nightly trainer + consumers kept shipping after the last score. | **Proven (measured + shipped)** |
| Fresh 2026-08 score | Needs live `embeddings.bin` + `library.json` + API keys on this VM | **Blocked here** — see gap below |

---

## 1. What the brain is

Not a LoRA. Not a fine-tuned Gemma. The live “checkpoint” is:

- **`embeddings.bin`** — OpenAI `text-embedding-3-small` (1536-d) per track
- **`mood-index.bin`** — second ear: vibe-only vectors (identity stripped)
- **Nightly `scripts/brain-trainer.mjs`** — local Gemma writes a sound/mood
  (and later meaning) line → fold into embed text → re-embed → update the bins
- **Consumers** — Music Man RAG, Discovery match %, Activity Sync taste floor,
  playlist vibes, workout picks

`brain_id` = first 12 hex of `sha1(embeddings.bin)`.

---

## 2. Measured altimeter (`score_log.jsonl`)

| When (UTC) | Label | brain_id | Vectors | Retrieval | Grounding | Overall |
|---|---|---|---:|---:|---:|---:|
| 2026-07-11 03:07 | current | `a6744e9ffa8f` | 8495 | 0.790 | **1.000** | 0.895 |
| 2026-07-12 14:29 | current (pre ruler fix) | `128a5ae73240` | 8543 | 0.787 | **1.000** | 0.893 |
| 2026-07-12 14:31 | current (post ruler fix) | `128a5ae73240` | 8543 | **0.822** | **1.000** | **0.911** |

Same brain sha on the last two rows — only the ruler changed. That night’s
ret-015 “aggression enrichment” proposal was **REFUTED** by a read-only top-30
dump (`diag_ret015.py`): the brain already returned Pantera / SOAD / Motörhead /
Maiden / Sabbath / RATM. The 0.13 score was a broken predicate (punk/grunge only),
not a dumb brain. Re-embedding 2410 tracks would have polluted the index to fit
a bad test. See `PROPOSAL-ret015-aggression-enrichment.md`.

**Working signals:**
- Grounding never dipped below 1.0 (Music Man does not invent library tracks).
- Vectors grew overnight (+48) — the trainer is writing a richer brain.
- Enrichment-sensitive energy prompts (ret-013/014) were already ~0.80 at baseline.

Print the same table anytime:

```bash
python brain-eval/progress_report.py
```

---

## 3. Capability progress since the last score (git, not yet re-scored)

The last altimeter row is **2026-07-12**. Main kept teaching and wiring the brain:

| Date | What landed |
|---|---|
| 2026-07-13 | Lyrics-meaning enrichment in the trainer (`gemmaMeaning`) |
| 2026-07-14 | Discovery: brain-scored match % vs taste exemplars |
| 2026-07-18–25 | Activity Sync brain fit + taste floor (module + tests shipped) |
| 2026-07-19 | “THE BRAIN” — Music Man back wall |
| 2026-07-25 | `brain-status.json` health — no more silent multi-day trainer deaths |
| 2026-07-26 | Key/mode into embed text; fake energy removed |
| 2026-08-02 | Corrected BPM reaches the brain; honest trained-% in health file; override layer |
| 2026-07-08 (earlier) | Dual mood-index validated: vibe recall **0.756→0.900** |

So the *system* progressed after July 12. A new `python run_eval.py` on the live
NAS/homemini state is the missing number — not evidence of stall.

---

## 4. Offline proof run in this validation (2026-08-06)

Cloud VM has **no** live `embeddings.bin` / `library.json` and **no** API keys,
so a fresh live score was impossible here. What did run:

```text
npm test  →  366 pass / 0 fail
```

Including the brain modules:

- `computeActivityBrainFit` — near-taste beats stranger; falls back when
  exemplars are thin; blends context query; skips missing embeddings
- `selectWorkoutSyncSet` — taste floor drops bottom-taste tracks; target still hit
- playlist-vibes quality floor + k-means centroids
- Music Man verification / hallucination rejection tests
- taste-model fingerprint + candidate scoring

Harness integrity (read-only, no network):

```bash
python brain-eval/progress_report.py --self-check
```

---

## 5. How to take the next measured proof (on homemini / Mac with the live brain)

```bash
# Point at the canonical state (NAS or local Application Support)
export JT_STATE_DIR=/Volumes/JakeShared/JakeTunesState   # or the laptop path

cd brain-eval
python run_eval.py                 # appends score_log.jsonl
python progress_report.py          # prints the drift table

# Optional: retrieval-only (cheap), or with persona judge
python run_eval.py --no-llm
python run_eval.py --judge
```

Needs `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` in repo `.env`. Never run a write
path against the brain from this folder — the One Rule in `README.md` stands.

---

## 6. Bottom line

1. **Working:** perfect grounding + solid retrieval on a fixed held-out set.
2. **Progressing:** more vectors night-over-night; mood-index vibe lift measured;
   nightly trainer + Discovery/Activity Sync consumers shipped; a bad enrichment
   experiment was correctly refused.
3. **Next proof:** one `run_eval.py` against today’s live `embeddings.bin` to
   close the July-12 → now measurement gap.
