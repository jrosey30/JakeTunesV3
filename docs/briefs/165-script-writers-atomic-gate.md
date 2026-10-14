# Brief 165 — Script writers go through temp+rename, behind a gate (JakeTunesV3)

## Problem / source

The app serializes only its own saves. Several maintenance scripts
overwrote `library.json` in place — no temp+rename, no lock — so a script
killed mid-write leaves a torn library, and an external write landing
mid-save is silently overwritten (the mtime guard only catches writes
from *before* the save started). The scripts' timestamped backups make
this recoverable by hand, not safe. (Audit: Lens 2, finding 1.)

## core/ mandate (why this PR touches `core/`)

`core/` is on this repo's do-not-touch list ("do not change them unless
a brief explicitly says to and explains why"). **Brief 165 explicitly
names the `core/` writer files below and requires them to be routed
through the shared write helper** — three of the five in-place writers
live in `core/`, and the fix cannot be made from `scripts/` alone. That
explicit naming is the escape hatch the do-not-touch rule itself
provides. Accordingly, in this PR the `core/` changes are their own
commit, clearly separated from the `scripts/` changes, and are limited
to: one new sibling helper module (`core/atomic_write.py`) plus, in each
named writer, an import line, a gate call on the apply path, and the
replacement of the final in-place `json.dump` with the helper call. No
other `core/` behaviour changes.

## Evidence (verified at HEAD 12bb43b)

Direct in-place writers of `library.json`:

| Writer | In-place write | Existing backup (kept) |
|---|---|---|
| `scripts/remove-dead-tracks.mjs` | `writeFileSync(LIBRARY_PATH, …)` (~137-140) | `.pre-dead-remove-<stamp>.bak` |
| `core/repair_mismatches.py` | `open(library_path, 'w')` + `json.dump` (~510-511) | `.bak-repair-<ts>` (~400-401) |
| `core/tools/refresh_fingerprints.py` | `open(LIB, 'w')` + `json.dump` (~161-171) | `library.json.<ts>.bak` via `shutil.copy2` |
| `core/dedupe_compilation_years.py` | `open(LIBRARY, 'w')` + `json.dump` (~104-120) | `.bak-yeardedup-<ts>` |
| `core/reclaim_orphans.py` | `open(args.library, 'w')` + `json.dump` (~216-224) | `.bak-reclaim-<ts>` |

Writers that already do it right (pattern matched, unchanged):
`scripts/fix-bpm-octaves.mjs` (backup → tmp → parse-back → rename),
`scripts/recover-orphans.mjs` (backup → tmp → rename → verify),
`scripts/brain-trainer.mjs` (tmp+rename), `scripts/taxonomy-classify.py`
(app-quit gate + tmp + `os.replace` for `metadata-overrides.json`).

The gate mirrors `scripts/taxonomy-classify.py`'s `app_running()`:
`pgrep -f 'JakeTunes.app/Contents/MacOS/JakeTunes'`, returncode 0 ⇒
running, any exception ⇒ not running.

## Sweep (scripts/ + core/, for other direct in-place writers of library.json)

Searched `writeFileSync` / `writeFile` (scripts/), `json.dump` (core/ +
scripts/), plus per-file inspection of every hit. **No additional
in-place `library.json` writers were found.** Already-correct writers
found by the sweep: `scripts/brief-031-apply-collabs.py` and
`scripts/brief-031-apply-decisions.py` (`.partial` + `os.rename`, plus
their own pgrep quit gate and hash-verified backups),
`scripts/nightly_loop.py` (outputs via tmp + `os.replace`; library is
read-only there). Everything else writes a different file (noted in the
PR summary): listening-history/year-in-review outputs, `lyrics.json`,
`artist-members.json`, contracts codegen, cover-vault manifests,
embeddings/descriptors (already tmp+rename), iTunesDB, /tmp reports,
stdout.

## What changes

### Shared helpers (one per language)

- `scripts/lib/atomic-write.mjs` (new)
  - `writeJsonAtomic(path, value)` — temp file in the same directory →
    parse-back verify → rename. JSON format unchanged
    (`JSON.stringify(value, null, 2)`, as the callers already wrote).
  - `appRunning()` — taxonomy semantics via `pgrep`.
  - `assertAppNotRunning(action)` — prints why and exits 3.
- `core/atomic_write.py` (new, own commit — see mandate above)
  - `atomic_write_json(path, obj, indent=2, ensure_ascii=False)` — temp
    file in the same directory → fsync → parse-back verify →
    `os.replace`. Defaults reproduce each caller's existing byte format
    exactly (all four dumped with `indent=2, ensure_ascii=False`).
  - `app_running()` / `require_app_not_running(action)` — same gate,
    exit 3 on refusal.
  - Imported the way `core/` files already import siblings
    (`sys.path.insert` of the file's own dir + plain import);
    `core/tools/refresh_fingerprints.py` inserts the parent dir
    (`core/`), following the same pattern one level up.

### Writers routed through the helpers (backup behaviour untouched)

- `scripts/remove-dead-tracks.mjs` — gate on the `--commit` path (after
  the safety guard, before the backup + write); final write via
  `writeJsonAtomic`. The now-unused `writeFileSync` import is removed.
- `core/repair_mismatches.py` — gate at the top of the `--apply` section
  (before backup); final write via `atomic_write_json`.
- `core/tools/refresh_fingerprints.py` — gate on the `--apply` path
  after the nothing-to-write check (before backup); final write via
  `atomic_write_json`.
- `core/dedupe_compilation_years.py` — gate after the dry-run return
  (before backup); library write via `atomic_write_json`. (Its audio
  tag re-embedding that follows is also covered by the same gate.)
- `core/reclaim_orphans.py` — gate after the dry-run / nothing-to-do
  returns, before **any** apply mutation (the library write and the
  orphan-file deletions alike); library write via
  `atomic_write_json`.

### Per-writer gate applicability

| Writer | Gate | If the gate can't see the app |
|---|---|---|
| All five | Same-host pgrep gate (refuse, exit 3) on the write/apply path only — dry runs are never gated | If run on a different machine than the app against a NAS-resident library, pgrep sees nothing and the write proceeds; there, temp+rename is the protection, exactly as the brief specifies |

## What does NOT change

- Every script's timestamped backup behaviour, filename, and placement
  (backups still happen before the write, in the same order relative to
  the write as before — except the gate now runs first, so a refused run
  writes nothing at all).
- Dry-run behaviour and output of all five writers (the gate sits only
  on the apply/commit path).
- Safety guards (remove-dead-tracks' `assessDeadTrackRemoval`, repair's
  dedupe/delete logic, refresh's change detection) — untouched.
- On-disk JSON byte format of `library.json` for every writer.
- No `index.ts` change; no version bump; no other `core/` files.

## Done looks like

- Killing any of the five writers mid-write leaves either the old or
  the new `library.json`, never a torn one.
- Running any of them with `--commit`/`--apply` while JakeTunes is open
  prints a refusal and exits 3 without touching the file.
- Dry runs behave exactly as before, app running or not.

## Tests

- Python helper fixture run: round-trip equality, byte-format parity
  with the previous in-place `json.dump`, overwrite, no temp files left
  behind, `app_running()` false on a clean host — **pass**.
- Gate positive test (dummy process whose argv contains the pgrep
  pattern): `require_app_not_running` refuses with exit 3 — **pass**.
- Import-pattern fixtures mirroring both placements (`core/` sibling,
  `core/tools/` parent-dir) — **pass**.
- Node helper fixture run: round-trip, byte-format parity, overwrite,
  no temp left behind, gate negative; gate positive with a dummy
  process → refusal, exit 3 — **pass**.
- `py_compile` clean on all touched Python files; `node --check` clean
  on both touched JS files.
- The five writers themselves were not executed end-to-end here (they
  operate on the real library/iPod paths); their changed regions are
  line-level substitutions covered by the helper fixtures above. Full
  `npm run check` does not cover these scripts; CI verification still
  applies to the PR as a whole.
