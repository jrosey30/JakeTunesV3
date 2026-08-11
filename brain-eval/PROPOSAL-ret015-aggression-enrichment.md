# Gated proposal — close the "aggressive/heavy/intense" enrichment gap (ret-015)

Status: **REFUTED — RESOLVED 2026-07-12, do NOT execute the re-embed plan below.**

The "Open risk to check first" (§ bottom) was run 2026-07-12 by the nightly brain-improve
run (`diag_ret015.py`, read-only): the brain's actual top-30 for "aggressive heavy intense
music" is Pantera / System of a Down / Motörhead / Iron Maiden / Black Sabbath / RATM —
20/30 aggressive-genre tracks. **The brain retrieves this query correctly.** The 0.13 score
was the eval predicate (`punk/grunge` only) contradicting its own rubric ("aggressive
genres") — a miscalibrated ruler, not a descriptor gap. Fix applied: `"metal"` added to
ret-015's `genre_any` (grounded in library.json's real genre tags: metal/heavy metal/funk
metal/nu-metal/thrash ≈ 151 tracks; aggressive space = 1106). ret-015 now reads 0.67;
retrieval 0.787→0.822, overall 0.893→0.911 with **zero changes to embeddings.bin**
(sha `128a5ae73240` before and after). Residual: aggressive bands genre-tagged plain
"Rock" (SOAD, RATM, I Prevail…) still count as misses by design — plain "rock" in the
predicate would corrupt the proxy the other way. The descriptor-enrichment experiment
below is therefore unnecessary; re-embedding 2410 tracks to satisfy the old predicate
would have polluted the brain to fit a broken ruler.

Original text (kept for the record):

Status: ~~PROPOSED, not applied.~~ Written 2026-07-11 03:xx by the nightly brain-improve run.
Do NOT execute while the JakeTunes app is running or while brain-trainer/taxonomy-classify may run.

## Why (grounded, measured)
Tonight's baseline (committed to `score_log.jsonl`, brain 8495 vec, sha `a6744e9f…`):

| bucket | score |
|---|---|
| retrieval | 0.790 |
| grounding | 1.000 |
| overall | 0.895 |

Per-prompt, the enrichment-sensitive altimeter prompts read:
- ret-013 "high-energy fast … work out" (bpm≥130) → **0.80**
- ret-014 "slow mellow chilled-out … late night" (bpm≤85) → **0.80**
- ret-015 "aggressive heavy intense music" (punk/grunge) → **0.13**  ← outlier

ret-015 is the lone failure. Measured library facts (from `library.json`, 8412 tracks):
- punk/grunge genre tracks: **1684 (~20% of library)**
- all aggressive-genre tracks (punk/grunge/metal/hardcore/hard-rock/thrash/…): **2410**
- punk/grunge is **~70%** of the aggressive space.

So a random top-30 would recall ~0.20 punk/grunge. The brain scores **0.13 — below random** for
"aggressive heavy intense music." This is NOT a too-narrow-proxy artifact (punk/grunge dominates the
aggressive space); it is a **genuine gap**: the identity index does not associate the words
*aggressive / heavy / intense* with the punk/grunge cluster, even though ret-013/014's energy words
(fast/slow) map fine. Likely cause: the nightly Gemma sound/mood descriptor folded into embed text
carries tempo/energy language but rarely the aggression/intensity register for punk/grunge tracks.

## The bounded experiment (one change, isolated, reversible)
Target ONLY the descriptor→embed-text step for aggressive-genre tracks. Do not touch retrieval code,
the harness, or any other bucket.

1. **Precondition gate (abort if any fail):** app quit (`pgrep -f "MacOS/JakeTunes$"` empty);
   brain-trainer + taxonomy-classify finished for the night; `embeddings.bin` mtime stable ≥2 min;
   a verified `embeddings.bin.bak` exists.
2. **Select** the aggressive-genre track ids from `library.json` (the 2410 set; punk/grunge is the
   scored subset). Grounding: genre/subgenre + measured `bpm` are already in library.json — real,
   not invented.
3. **Descriptor tweak (grounded):** in the embed-text builder used by `scripts/brain-trainer.mjs`,
   for tracks whose genre/subgenre is in the aggressive set AND whose measured bpm is high, append a
   grounded intensity clause (e.g. derived strictly from {genre label, bpm band}: punk@fast →
   "aggressive, heavy, intense, high-energy"). Never invent per-track mood from model memory —
   derive only from the genre label + measured bpm already on the track.
4. **Re-embed IN ISOLATION:** write the candidate vectors to a **scratch copy**
   (`embeddings.candidate.bin`), never the live file. (The harness only reads `embeddings.bin` /
   `.bin.bak`; to score a candidate, either temporarily place it as `.bak` and run `--baseline`
   comparing base=candidate vs current=live, or add a tiny read-only driver that calls
   `run_eval.eval_brain(path=...)` — do not modify the harness's scoring logic.)
5. **Prove it:** re-run the full eval on the candidate. KEEP only if **ret-015 rises AND overall
   rises AND no tracked bucket regresses** (retrieval, grounding). Watch for overfitting: if only
   ret-015 moves while ret-006/009/011/012 (genre retrieval) drop, REJECT — the aggression clause is
   polluting other genre clusters.
6. **Apply safely (only if proven):** backup → temp-file + atomic rename over `embeddings.bin` →
   self-verify vector count (should stay ~8495) + dim (1536) → restore `.bak` on any mismatch.
   Write a revert ledger entry (before/after sha + scores + exact undo). Then let the desktop→NAS
   sync carry it to homemini, or deploy explicitly.

## Why it was NOT done tonight
- The app was **running** → no safe exclusive write to the live brain (guardrail 5; the documented
  live-app-clobbers-external-writes lesson).
- The fix spans ~1684–2410 track re-embeds — too large to prove cheaply in one bounded step at
  3 AM, and unapplicable tonight regardless.
- Per guardrail 6 (default to do-nothing when a change can't be proven both safe AND better),
  the correct action was to measure, preserve the reading, and propose. Nothing was changed.

## Open risk to check first (do this before spending on re-embeds)
Confirm ret-015 is a descriptor gap and not the query-vs-cluster geometry: add a read-only driver
that dumps ret-015's actual top-30 genres. If the top-30 are dominated by *other* aggressive genres
(metal/hard-rock/rap) the fix is different (broaden the proxy or accept it); if they're unrelated
(pop/mellow) the descriptor-enrichment hypothesis is confirmed. Cheap, read-only, do it first.
