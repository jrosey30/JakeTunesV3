# Brief 177 — Enrichment ledger + scheduled CLAP/lyrics catch-up

## Source / evidence
- Proposed briefs 160+, Brief 177 (desktop audit Lens 3, finding F2;
  steps audit §2 — CLAP throughput measured at 20/50/122 tracks/min under
  three load profiles, so the safe nightly window is a measurement).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`:
  - `scripts/audio-embed.py` (CLAP) was hand-run only; it skipped tracks
    already in `audio-index.bin` but recorded NO attempts — every run
    re-decoded known-dead files first, in library order.
  - `scripts/lyrics-fetch.mjs` was manual-only. It already has the right
    local discipline: `lyrics.json` store, hits/instrumentals are done,
    misses retry after a 30-day TTL (`MISS_TTL_MS`).

## Documented deviation — the ledger is a sidecar, not library.json fields
The brief's literal text put the ledger in `library.json`
(`clapAttempted`/`clapDone`/`lyricsDone`/`taxonomyDone` + timestamps).
**That is not what shipped, deliberately** (the same documented-deviation
pattern as Brief 159): `library.json`'s sole writer is the desktop app
(Lens 2 / Brief 165 single-writer discipline — `lyrics-fetch.mjs`' own
header states it: "NEVER touches library.json (V3 is the single
writer)"). Nightly jobs writing per-track fields into it would recreate
exactly the multi-writer defect that discipline exists to prevent.
The ledger therefore lives in **`enrichment-ledger.json` in the same
state dir** the jobs already use, carrying the brief's exact field names
and its full intent: queryable per-track attempted/done state so no job
re-attempts blindly, and dead files stop leading every run.

## What changes
- **NEW `scripts/enrichment-ledger.mjs`** — the ledger format + rules:
  `{ version:1, tracks:{ "<id>": { clapAttempted, clapDone, lyricsDone,
  taxonomyDone, …At timestamps, lastError, lastJob, updatedAt } } }`;
  atomic save (tmp+rename); corrupt/missing reads as empty (source stores
  re-derive done-state); `RETRY_TTL_MS` = 30 days (mirrors lyrics' miss
  TTL); `clapNeedsAttempt` + `orderClapCandidates` (fresh first,
  recently-failed deferred to the back).
- **`scripts/audio-embed.py`** — a Python mirror of the ledger (same
  shape, same TTL): consults it before ordering work (index-held tracks
  are recorded done; failed-inside-TTL tracks go to the BACK of the queue
  instead of being re-decoded first); marks each attempt BEFORE the work
  (a crash still leaves the record), done/error after; saves at the
  existing index-flush cadence and at exit.
- **`scripts/lyrics-fetch.mjs`** — records outcomes into the ledger
  (done for hits/instrumentals, attempted for misses), best-effort and
  in-memory until its existing persist points. Its fetch decisions and
  `lyrics.json` store are unchanged.
- **NEW `scripts/clap-probe.py`** — the runtime probe: loads CLAP exactly
  as audio-embed does, times decode+embed on a sample of unindexed
  tracks, prints tracks/min and a recommended nightly cap for a given
  budget (×0.7 safety), and with `--write` leaves `clap-probe.json` in
  the state dir for the driver. It cannot be run from the agent
  environment (it needs the CLAP machine) — see Manual steps.
- **NEW `scripts/enrichment-catchup.mjs`** — the scheduled driver:
  refreshes the ledger's lyrics/taxonomy done-state from the source
  stores (read-only), computes the CLAP delta from `audio-index.bin`,
  sets the cap from `clap-probe.json` when a measurement exists (scaled
  to the run's budget) and otherwise from an explicitly-labelled
  UNMEASURED fallback (default 300), runs the CLAP delta, then a lyrics
  batch with the remaining budget, and writes `enrichment-status.json`.
  `--dry-run` prints the full plan and spawns/writes nothing.
  Its launchd template ships in Brief 183's manifest
  (`com.jaketunes.enrichment-catchup`).

## What does NOT change
- `library.json` gains no fields and no new writers.
- CLAP embedding itself (model, windows, index format) is untouched;
  the ledger changes ORDER and bookkeeping only.
- Lyrics fetching logic, grounding, and TTL are untouched.
- Nothing is scheduled by this PR — launchd installation is Brief 183's
  installer + a manual step. No version bump.

## Done looks like
- A track that fails CLAP tonight is attempted-marked with the error and
  is not touched again for 30 days; new tracks are always first in line.
- The nightly catch-up runs CLAP + lyrics inside a measured budget; its
  status file says what ran and where the cap came from.

## Tests (run in the agent environment)
- `node --test scripts/__tests__/enrichment-ledger.test.mjs` — **4/4
  pass** (load/save round-trip + field shape, corrupt→empty, TTL edges
  incl. exactly-at-the-line, fresh/deferred ordering).
- `python3 scripts/tests/test_enrichment_ledger.py` — **3/3 pass**
  (the Python mirror: same field set as the node module, round-trip,
  ordering). `python3 -m py_compile` clean on audio-embed.py and
  clap-probe.py; `node --check` clean on lyrics-fetch.mjs and
  enrichment-catchup.mjs.
- Catch-up driver fixture dry-runs (synthetic state dir): refresh
  derived +1 lyricsDone (a miss correctly NOT counted) and +1
  taxonomyDone; CLAP delta 3; with no probe file the cap reported
  "UNMEASURED fallback"; with a fixture `clap-probe.json`
  (2100 @ 60 min) and a 30-min budget the cap computed 1050 from the
  measurement. Dry-run wrote no files.
- The probe itself was NOT run (no CLAP machine here) — first run is a
  manual step below.

## Manual steps (verbatim)
1. On the laptop (the CLAP machine), after merge:
   `.venv-clap/bin/python scripts/clap-probe.py --tracks 12 --budget-min 60 --write`
   — this produces the measured cap in `clap-probe.json` that the
   catch-up driver reads. Re-run it if the machine's load profile
   changes materially.
2. Install the nightly agent via Brief 183's installer
   (`scripts/launchd/install-launchagents.sh`, dry-run first, then
   `--apply`) once Brief 183 lands; until then the catch-up can be run
   by hand: `node scripts/enrichment-catchup.mjs --dry-run` to preview,
   without `--dry-run` to run.
