# Nightly brain exercise — 2026-08-11 (homemini)

**Brain untouched.** embeddings.bin sha `c5126c470cad` (9,406 vectors) before and after;
mood-index.bin sha `d727a43859d2` (9,406 vectors). All measurement on a frozen /tmp
snapshot of the NAS state dir. brain-trainer completed cleanly at 02:01 EDT
(+50 enriched, brain 9,057/9,370).

## Baseline (frozen snapshot, run_eval.py)

retrieval **0.756** / grounding **1.000** / overall **0.878** — squarely in the
encoding-v2 normal band (0.762 ± 0.03 nightly wobble). ret-014 0.20, ret-015 0.50 =
documented wobble; nothing anomalous.

## Tonight's experiment (queued 08-10, diagnosis-first): do the weak genre probes
## ret-011 / ret-012 measure the wrong index?

`diag_ret011_012.py` (read-only, committed) scored all 15 retrieval probes on BOTH
indexes and emulated the production router (`pickRetrievalIndex`,
src/main/index.ts:11830 — decade regex → main; library-artist match → main; else mood).

| probe | query | identity | mood | Δ | production routes to |
|---|---|---|---|---|---|
| ret-001 | RHCP songs | 1.00 | 0.10 | −0.90 | main (artist) |
| ret-002 | Beatles tracks | 1.00 | 0.70 | −0.30 | **mood** ⚠️ see P2 |
| ret-003 | Sublime songs | 1.00 | 0.00 | −1.00 | main (artist) |
| ret-004 | Daft Punk electronic | 0.95 | 0.25 | −0.70 | main (artist) |
| ret-005 | Nirvana grunge | 1.00 | 0.60 | −0.40 | main (artist) |
| ret-006 | classic rock from the 1970s | 0.64 | 0.52 | −0.12 | main (decade) ✓ correct |
| ret-007 | punk rock | 0.76 | 1.00 | +0.24 | mood |
| ret-008 | hip-hop and rap | 0.88 | 0.84 | −0.04 | mood |
| ret-009 | house and dance | 0.80 | 1.00 | +0.20 | mood |
| ret-010 | grunge | 1.00 | 0.96 | −0.04 | mood |
| **ret-011** | **funk and soul** | **0.40** | **0.84** | **+0.44** | **mood** |
| **ret-012** | **new wave 80s** | **0.35** | **1.00** | **+0.65** | **main (decade)** ⚠️ see P3 |
| ret-013 | high-energy workout | 0.87 | 1.00 | +0.13 | mood |
| ret-014 | slow mellow late-night | 0.23 | 0.30 | +0.07 | mood |
| ret-015 | aggressive heavy intense | 0.50 | 0.73 | +0.23 | mood |

**mean identity-only (what run_eval reports): 0.759**
**mean router-truth (what production actually retrieves): 0.821**

### Findings

1. **ret-011 CLOSED as a brain problem.** Production routes "funk and soul" to the
   mood index and gets 0.84; the qualitative top-30 is near-solid Funk/Soul (James
   Brown, Curtis Mayfield, Bill Withers…) with the misses being honest-underestimate
   ruler residue (Dabeull tagged plain "Funk", Bowie "Young Americans" tagged Classic
   Rock). The eval's 0.40 measures an index production doesn't use for this query.
   Same class as ret-014 (08-07). **Don't chase ret-011 with embed-text changes.**

2. **ret-012 is a REAL router miss, now quantified.** "80s" trips `DECADE_QUERY_RE`
   → identity index → 0.35. The mood index scores a PERFECT 1.00 (top-30 is flawless
   New Wave) because "new wave" is in the mood text's genre line and the genre itself
   pins the era. The decade guard remains correct for true year-filter queries
   (ret-006: main 0.64 > mood 0.52 — mood text has no year). No clean lexical fix:
   "contains a genre tag" doesn't discriminate (ret-006 contains "classic rock" too).
   The durable fix is P3.

3. **The eval underreports production by ~0.06** (0.759 vs 0.821) by scoring every
   probe against the identity index only. This is the 08-07 ruler question, now
   quantified across all 15 probes.

4. **Router artist-guard gap (found incidentally, verified against app source):**
   `ragLibraryArtistSet` stores full normalized names ("the beatles"), so "Beatles
   tracks" fails the substring match and routes to mood (0.70 instead of identity's
   1.00). Any "The X" band queried without "The" retrieves from the wrong index.

## Applied tonight

**Nothing.** No brain-data change was on the table — all three fixes are code
(harness or app), outside the nightly auto-apply scope. Brain sha verified unchanged
after measurement.

## Proposals for Jake (gated, none applied)

- **P1 — router-aware eval (harness change):** run_eval scores each retrieval probe
  on the index the production router would pick (the emulation in diag_ret011_012.py
  is ready to lift). Retrieval bucket would read ~0.821 and stop flagging phantom
  regressions (ret-011, ret-014). Cost: comparability reset vs all prior score_log
  rows — your call, per the 08-07 open question.
- **P2 — one-line app fix:** in `ragLibraryArtistSet`, also add the leading-"the"-
  stripped variant of each artist name (guard len≥4 + GENRE_WORD_ARTISTS as today).
  Fixes "Beatles tracks"-shaped queries. Needs a desktop rebuild to go live.
- **P3 — future gated experiment:** add a decade/era token to `moodText()` (trainer
  twin + `--rebuild-mood-index`), then relax the router's decade guard. Potential:
  ret-012 0.35→1.00 and decade queries served by mood without the ret-006 regression.
  Note the 07-03 era-token NO-GO was for the IDENTITY index (year digits already
  present); mood text has no year at all, so this is a genuinely new experiment.
  Must be counterfactual-validated (mood-text reconstruction fidelity gate first)
  before any rebuild.

## Ops notes

- 329 stale `*.tmp` files still litter the NAS state dir (unchanged since 08-10;
  storm remains stopped). Daytime cleanup still pending.
- Worktree at f62e0c7, throwaway venv, frozen snapshot in /tmp — all removed after
  commit.
