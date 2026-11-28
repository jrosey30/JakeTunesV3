# Nightly brain-eval — 2026-11-28 (homemini)

**Outcome: IDLE (43rd consecutive) — baselines only, nothing applied, brain untouched.
v3 headline 0.798 = new high for the comparable series (second night running), still
the trainer's tempo-v3 catch-up landing. First DOUBLE parser-flake night: grd-005 (v1)
and v3-grd-07 both scored 0 unparseable; read-only forensics reproduced BOTH proven
classes live, one each, zero fabrication. True grounding: v1 1.000, v3 0.950.**

## Pre-flight
- brain-trainer finished 23:41 EST (log dated 2026-11-28T04:41Z): tempo catch-up
  re-embedded **386 tracks** with tempo/key encoding v3 (386 newly analysed), meaning
  catch-up 20; 0 newly enriched — "library fully enriched"; library stays **14,866**
  (embeddings.bin 15,089 vectors). No mood prune tonight (none logged, none observed —
  writer rule satisfied). mood-index tempo-catchup updated 386 vectors.
- embeddings.bin / mood-index.bin mtimes 23:41 / 23:40 EST — well before the 02:30
  early-promotion cutoff; stable ~3.5 h before measurement.
- Snapshot `/tmp/brain-snap-20261128` (7 files incl. artist-members / metadata-overrides /
  lyrics), sha-verified against NAS before AND after copy:
  - embeddings.bin `8efc81d905ed` (15,089 vectors)
  - mood-index.bin `d9f4ae2db303`
  - library.json `952396b55aa1` (14,866 tracks)
- Worktree `/tmp/jt-braineval-20261128` from origin/brain-eval (5a05f047), .env copied.

## Pick
`pick_experiment.py pick` → **IDLE** — E1 bare mood vectors = 0; E2 genre-tag churn
24/11,545 = 0.21% (need >1%). Queue remains fully drained both lanes. Ledger 'picked'
event committed.

## v1 (B1-20261128)
**retrieval 0.812 / grounding 0.900 printed — true grounding 1.000, overall ≈0.906.**
- **Zero retrieval movers vs 11-27** (ret-011 0.48, ret-012 0.85, ret-015 0.90, traps
  clean). Routes 8/7 identical.
- Sole change: **grd-005 flaked 0** `unparseable (reply was not JSON)` — see Forensics.

## v3 (B3-20261128)
**headline 0.798** — up from 0.791, best comparable reading to date (since 10-12);
**grounding 0.900 printed — true 0.950** (grd-15 trap, the known apply-blocker, plus the
v3-grd-07 flake below). Primary source **bridge**; routes identical 29/94/1/30. Ruler
fresh: 34/14,866 = 0.23%. qvec 348 cached / 0 fresh (frozen holds).
- Groups: artist 0.963 / umbrella 0.927 / leaf 0.848 / family_decade 0.877 /
  **tempo_family 0.453** (0.440 → 0.453, Jake ask #4 improving on its own via tempo-v3) /
  **vibe 0.720** (0.704 →).
- Movers 23/174 net −0.20, but −1.00 of that is the grd-07 parser flake. Excluding it:
  **22/174 net +0.80, all benign ±1-slot churn**, tilted positive across tempo (tempo-16
  0.16→0.24, tempo-13 0.12→0.16 — watch stays CLOSED) and umbrella (umb-05 0.40→0.48,
  fam-17 0.88→0.96); biggest leaf-34 0.36→0.48.
- **leaf-38 watch: held exactly 0.44** (no escalation; threshold <0.40).

## Forensics — first double-flake night, both proven classes fired (read-only)
`grd_flake_forensic_20261128.py` rebuilt each probe's exact grounding context from the
snapshot (grd-005: main-index top-14; v3-grd-07: production bridge, k=14) and replayed
claude-haiku-4-5 ×3 each; full raws in `/tmp/grd-flake-raws-20261128.txt`:
- **grd-005 = CLASS 2** (1/3 live repro): valid obj1 citing **5 real Nirvana tracks**,
  then "Wait—I need to correct that" + a second emission; `json.JSONDecoder().raw_decode`
  recovers obj1 cleanly. Clean replays: 5 real / 0 fabricated.
- **v3-grd-07 = CLASS 1** (1/3 live repro): unescaped inner double quotes in the `answer`
  string (`Check out "Caldo Verde" by Erwin, ...`) → delimiter error at pos 401. Clean
  replays: 4–5 real / 0 fabricated. **Fifth probe to join the class.**
- Flake tally now **8 nights / 5 probes / both rulers / zero fabrication ever**.
  PROPOSAL-grd16 updated in-file: its recommended fix (fence-strip → raw_decode →
  bounded tracks regex) would have scored BOTH probes 1.0 tonight. This is the first
  night both classes fired together — strengthens Jake ask #3 (apply-blocker: a flake
  night zeroes candidate grounding, which the v3 gate requires at 1.000).

## main-src advance (benign)
origin/main **596b3b50 → cbdf973ba976** (PR #524 weekly release: iPod sync Brief 266,
edits fail-closed journal, island/favorite-artist pickers). `git diff --name-only` shows
**zero rag / bridge / router / embedding / mood-index files touched**; routes identical
on both rulers. **cbdf973b = new stability baseline.**

## Applied
Nothing. No candidate was built (IDLE); the brain was not written. End-of-run NAS shas
re-verified unchanged vs the snapshot.

## Open Jake asks (unchanged order)
1. **gemma4 promotion pricing item — STILL NOT QUEUED (top ask)**
2. grd-15 trap reword (apply-blocker)
3. fenced-json tolerant parse (PROPOSAL-grd16 — now 8 flake nights, both classes
   live-reproduced tonight; recommend approval)
4. tempo_family 0.453 (improving on its own via tempo-v3 — three straight gains)
5. grd-12 legacy-tag + Plunderphonics vocab re-export
