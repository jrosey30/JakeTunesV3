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

## Proof of working + progressing
See **`PROGRESS.md`** for the validation verdict (measured scores, capability
timeline, offline test proof, and how to take the next live reading). Quick table:

```bash
python progress_report.py            # drift table from score_log.jsonl
python progress_report.py --self-check   # harness integrity, no network
```

## How to read drift over time
Each run appends rows to `score_log.jsonl`. To watch the brain improve:
```bash
python progress_report.py
# or:
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
