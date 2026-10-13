# brain-eval — an altimeter for the JakeTunes brain

## THE ONE RULE
Nothing in this directory may touch, edit, pause, import-for-modification, or
write near the JakeTunes app, the nightly **brain-trainer** (`scripts/brain-trainer.mjs`),
or **`embeddings.bin`**. This is instrumentation that runs *alongside* the live
loop and **reads** its outputs. It never modifies the loop. The entire footprint
is this `brain-eval/` folder. The only files it writes are `score_log.jsonl`,
`staged_dataset.jsonl`, and `tmp/`.

If any change here would require editing the app or the trainer to work — **STOP
and report.** Do not adapt the live system to fit the harness.

## What the brain actually is (the brief's premise was wrong — on purpose-correctly caught)
Brief 003 assumed a nightly **LoRA fine-tune** of Gemma producing checkpoints.
The pre-flight proved there is **none**: no training script, no `peft`/`torch`,
no adapters/checkpoints, and Ollama serves only **stock** Gemma. The JakeTunes
"brain" is **OpenAI `text-embedding-3-small` vectors** (1536-dim) stored in
`embeddings.bin` + **RAG**. The nightly `brain-trainer.mjs` doesn't retrain any
model — it has local Gemma write a one-line *sound/mood* descriptor per track,
folds it into the embed text, and **re-embeds via OpenAI**, updating
`embeddings.bin` in place.

So the thing that changes over time — the real "checkpoint" — **is
`embeddings.bin` itself**. Its `sha1` is the `brain_id`. Re-run the harness after
each night and `score_log.jsonl` shows whether the brain is getting better.

The original brief's **general-reasoning / catastrophic-forgetting** bucket is
**intentionally dropped**: nothing trains Gemma's weights, so there is no
forgetting to detect. Measuring base Gemma would log a constant, not an altimeter.

## The three files you read
- **`eval_set.json`** — the fixed, held-out ruler (~35 prompts). Editing it resets
  score comparability. Three buckets: `retrieval`, `grounding`, `persona`.
- **`score_log.jsonl`** — append-only; one row per (brain, run). This is the drift log.
- **`staged_dataset.jsonl`** — append-only pile of real usage, `vetted:false`, for a
  FUTURE deliberate fine-tune. Gathering only — never wired into training here.

## What gets measured
| Bucket | How it's scored | What it tells you |
|---|---|---|
| **retrieval** | `recall@k` of a natural-language query vs an objective predicate (artist/genre/era/BPM) resolved from `library.json` | Does the brain pull back the right tracks? The `enrichment_sensitive` prompts (mood/energy) are the **true altimeter** — they should rise as the brain learns to *hear*. |
| **grounding** | The Music Man (Claude) answers a library question; every track it cites must EXIST in `library.json`. Fabricating one = **automatic 0** (Decision 4). `trap` questions ask about content you don't own — the only passing answer cites nothing. | Is the AI honest about what's actually in the library? |
| **persona** | Optional Claude judge, 0–5 per rubric (`--judge`) | Does it still sound like the Music Man? |

A **known-bad self-test** runs at startup: it feeds the hallucination check a
fabricated track and aborts (exit 2) if the check fails to fire — guaranteeing
the most important signal works before any scoring.

## How to run
```bash
cd ~/JakeTunesV3/brain-eval

python run_eval.py                 # score the current brain, print a table, append a log row
python run_eval.py --baseline      # also score embeddings.bin.bak as "base" → before/after Δ
python run_eval.py --judge         # add the persona judge (extra Claude calls)
python run_eval.py --no-llm        # retrieval only (no Claude; fast/cheap)
python run_eval.py --limit 4       # quick smoke: first 4 prompts per bucket
python run_eval.py --models base current   # brief-compat alias for --baseline

python stage_dataset.py --dry-run  # report what would be staged; writes nothing
python stage_dataset.py            # append new (deduped) examples, vetted:false
```
Needs `OPENAI_API_KEY` (query embeddings) and, for grounding/persona,
`ANTHROPIC_API_KEY`. Both are read directly from `~/JakeTunesV3/.env`.

## How to read drift over time
Each run appends rows to `score_log.jsonl`. To watch the brain improve:
```bash
cat score_log.jsonl | python3 -c "import sys,json; [print(j['iso'], j['label'], 'ret',j['retrieval'],'grd',j['grounding'],'overall',j['overall']) for j in map(json.loads,sys.stdin)]"
```
- **`retrieval` rising** (especially the enrichment_sensitive prompts) = the nightly
  trainer is making the brain hear better. This is the headline number.
- **`grounding` dropping** = the Music Man is starting to hallucinate library
  contents — investigate.
- The metadata-based retrieval prompts (artist/genre/era) are a **stable control**:
  they shouldn't move much, because metadata is already in every embedding.

## Out of scope (unchanged from the brief)
- Wiring `staged_dataset.jsonl` into an actual fine-tune (future, human-gated).
- Any change to the nightly trainer's cadence or method.
- Auto-promoting/rejecting anything. This brief **only measures**.
- Building a real prompt+correction usage log (the current interaction log lacks
  the user's prompt and any correction signal — its own future brief).

---

## Scorecard v3 (2026-10-12) — vocab-resolved ruler, production path, keep gate, experiment queue

**Why.** The 15-probe v1 ruler matched genres by substring, so the 10-11
taxonomy refresh (7,189 tags re-filed) read as a 0.05 "regression" until two
predicates were hand-recalibrated. v3 resolves genres through the app's own
vocab, refuses to score a stale ruler, scores what production actually
retrieves, and turns "keep it?" into a fixed statistical gate.

| file | what it is |
|---|---|
| `vocab_snapshot.json` | the app's genre vocab, frozen: leaf → family (genre-vocab "area") → umbrella (Genre Iceberg). `export_vocab.py` executes `src/common/genre-vocab.ts` + `genre-iceberg.ts` from a `git archive` of origin/main (`--check` = is it current?) |
| `eval_set_v3.json` | the frozen v3 ruler from `gen_probes.py` (seed + generating library sha inside): 154 probes in six groups + 20 grounding questions (14 normal, 6 anachronistic-era traps) |
| `eval_set_v3.qvec.json` | the ruler's query vectors, frozen — baseline vs candidate and night N vs N+1 see bit-identical queries |
| `scorecard.py` | shared v3 machinery: predicates, ruler-stale guard, query-vector cache, bridge runner, Python router fallback |
| `bridge/` | the production-path bridge (`rag-bridge.ts`, ported from main) + the electron stub; runs main's real `ragRetrieveByQuery` (router, mood index, audio fusion, decade gate, reranker, subgenre lexicon) from `bridge/.main-src/<sha>/` |
| `gate.py` | the keep gate (v3) + the unchanged v1 bar; the dual-run decision |
| `experiments/` | `queue.json` (E1–E9), `ledger.jsonl`, `state/`, `tools/` (scratch-copy-only methods) |
| `pick_experiment.py` | picks the night's ONE item, records results, guards re-queues |
| `nightly-prompt-v3.md` | DRAFT of the homemini prompt (not installed) |
| `tests/` | `python3 -m unittest discover -s brain-eval/tests` |

**Predicates (v3).** `genre_leaf` / `genre_family` / `genre_umbrella` are exact
vocab names, UNIONed; `year_range`, `bpm_min` / `bpm_max` (measured bpm only) and
`artist` (exact folded name vs `artist` or `contributingArtists`) are ANDed on.
An unknown name is an error, never a zero. If >0.5% of the library's genre tags
don't resolve in the vocab, run_eval exits 3 with **RULER STALE**.

**Groups.** artist 30 (≥20 tracks) · umbrella_family 18 (7 umbrellas + 11
families) · leaf 50 (≥25 tracks; catch-all leaves excluded) · family_decade 30
(≥50 tracks) · tempo_family 16 (bpm ≤85 / ≥130 × family, ≥30 tracks) · vibe 10
(ret-013..015 + v2 prod-001..007, recast mechanically and proven equal on the
generating library). **Headline = mean of the group means.**

**Running it.**
```bash
python3 run_eval.py --ruler v3 --no-llm --state-dir /tmp/brain-snap-YYYYMMDD   # retrieval only
python3 run_eval.py --ruler v3 --state-dir "$SNAP" --label baseline --run-id B3   # + 20 grounding Qs
python3 run_eval.py --ruler v1 --state-dir "$SNAP" --run-id B1                    # v1, unchanged
python3 gate.py --base B3 --cand C3 --v1-base B1 --v1-cand C1                     # exit 0 = APPLY
python3 pick_experiment.py pick --state-dir "$SNAP" --dry-run
```
Per-probe rows land in `score_rows.jsonl` (keyed by `run_id`); every
`score_log.jsonl` row now carries `ruler` (rows without one are v1).
`--log-dir` sends both elsewhere (use it for lab runs).

**The bridge needs:** node + `npx --yes tsx` (or `JT_TSX="node /path/to/tsx/dist/cli.mjs"`),
git (it `git archive`s origin/main's `src/` — no checkout), and, for audio fusion,
the CLAP helper (`~/JakeTunesV3/.venv-clap` + `scripts/audio-embed.py`, or
`JT_CLAP_ROOT`). Without the helper, production falls back to mood-only and so
does the bridge; the `routes` field records which ran, and gate.py refuses to
compare a fusion run with a non-fusion one. If the bridge can't run at all,
run_eval says so loudly and scores the Python router port (`primary_source:
py-router`) — that is NOT the production path and nothing may be applied on it.

**Keep gate (v3):** mean per-probe Δ ≥ +0.005 · 90% paired bootstrap lower
bound > 0 · no group mean drops > 0.01 · candidate grounding = 1.000.
**Dual run:** apply only if the v1 bar AND the v3 gate both pass (gate.py).

**Regenerating the ruler** (only when it goes stale — it resets v3 comparability):
`export_vocab.py` → `gen_probes.py --library <snapshot>/library.json` →
`run_eval.py --ruler v3 --no-llm --state-dir <snapshot> --freeze-qvec`.

**Baseline (laptop snapshot 2026-10-12, library 10ca503eec45, main c36a3bd70694,
mood a7f0bb302353):** headline **0.743** — artist 0.963, umbrella_family 0.960,
leaf 0.428, family_decade 0.872, tempo_family 0.472, vibe 0.761; grounding
1.000 (20/20). Diagnostics: main-index 0.585, mood-index 0.457. The leaf group
is the production gap: genre-name queries ("Garage Punk", "Prog Rock") route to
the mood/fusion path and score 0.43 where the main index alone scores 0.78.
