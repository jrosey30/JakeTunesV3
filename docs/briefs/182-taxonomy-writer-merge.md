# Brief 182 — Taxonomy writer: merge at write time, apply cooperatively, show deferrals

## Source / evidence
- Proposed briefs 160+, Brief 182 (Lens 2 finding 9; Lens 3 finding F8;
  steps audit §2 item B + §10).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`,
  `scripts/taxonomy-classify.py`: overrides loaded ONCE at start (`ov =
  json.load(open(OVP))`), classification runs for minutes, `app_running()`
  checked once, then the whole file is replaced from the in-memory copy —
  any override written in between was silently lost; exactly one
  `.bak-classify` generation was kept; a deferral (app running) exited 0
  with only a log line — invisible for weeks. The write's existing
  discipline is exemplary and is preserved exactly: additive-only (only
  add subgenre where still absent), all existing fields preserved,
  accepted fps kept (fp computed only for brand-new entries), dry-run
  writes only its preview.

## What changes (all in `scripts/taxonomy-classify.py`)
- **Merge at write time.** The staged-write loop is factored into
  `merge_staged(ovmap, cache, byid)` — the same additive discipline,
  applied to whatever map it is given. After classification, the script
  RE-READS `metadata-overrides.json` from disk and merges onto the
  current file, so anything another writer landed during the classify
  survives. (A load-time preview merge still runs first, only to decide
  whether there is anything to write and to produce the dry-run preview.)
- **Cooperative re-check.** `app_running()` is re-checked immediately
  before `os.replace` (after the merge + verify of the temp file); if
  the app started in the meantime, the write defers instead of racing it.
- **Backup generations.** `rotate_backups()` keeps 5 generations
  (`.bak-classify` newest, `.1`–`.4` older, the oldest rotated out)
  instead of one overwritten backup.
- **Deferral visibility.** When the app is running at write time (either
  check), the script writes `taxonomy-deferred.json` `{at, pendingCount}`
  beside the overrides and exits **3** (a distinct code — deferred is not
  success; previously it exited 0 silently). A successful write removes
  a stale marker. The marker is the surface Brief 178/183 consume
  (Brief 183's `--status` reads it).
- **Dry-run stays clean, decided and documented:** `--dry-run` writes
  ONLY its `/tmp/overrides-preview.json` — no deferred marker, no backup
  rotation, no live writes of any kind.

## What does NOT change
- Classification itself (shortlists, Sonnet calls, punk/grunge locks),
  the durable assignment cache, and the re-embed trigger are untouched.
- The app-running gate itself is untouched — writes still never happen
  while JakeTunes runs (the clobber constraint is real: ~62 override
  writes/day from the app). This brief chooses the brief's "visible
  deferred state" option over a single-writer token: the app cannot be
  made to honour a token it doesn't know about, so visibility + the
  existing cache (no re-burned Sonnet calls) is the cooperative apply
  that is actually available.
- Verify discipline (parse + count + size guard, indent=2 format) is
  unchanged. No version bump.

## Done looks like
- An override written by the app at 02:07, mid-classify, is still there
  after the 02:12 taxonomy write — and the taxonomy subgenres landed
  additively around it.
- A deferred night leaves `taxonomy-deferred.json` with the pending
  count and exit code 3 in the log; the next successful write clears it.
- A botched write can be rolled back from any of 5 backup generations.

## Tests (run in the agent environment)
- `python3 -m py_compile scripts/taxonomy-classify.py` — clean.
- `python3 scripts/tests/test_taxonomy_merge.py` — **3/3 pass**. The
  suite extracts the shipped write-path functions by source segment and
  execs them (the script runs its pipeline at import, so it cannot be
  imported whole):
  1. concurrent-edit scenario — an on-disk subgenre for track 1 landed
     mid-run is NOT overwritten by the cached pick; a concurrent field
     on track 2 survives while its staged subgenre is added; track 2's
     accepted fp is preserved (not recomputed); an unknown track 9 is
     untouched; a brand-new entry gets a correctly-formatted fp.
  2. backup rotation keeps exactly 5 generations, oldest rotated out.
  3. deferred marker round-trips `{at, pendingCount}` and clears.
- The full classify run itself needs Sonnet + the real library and was
  not run here — the write path is what changed and it is what is tested.

## Manual steps (verbatim)
1. None for activation — the nightly taxonomy job picks up the new
   write path on its next run after merge.
2. If a rollback is ever needed: the pre-write overrides are at
   `metadata-overrides.json.bak-classify` (newest) through
   `.bak-classify.4` beside the live file in the app-support dir.
