# Brief 170 — Import IDs: one mutex, atomic reservation, no ID-1 fallback

**Repo:** JakeTunesV3 · **Branch:** `fix/brief-170-import-ids` · **Base:** main `12bb43b`

## Problem (audit Lens 2, finding 6)

`nextLibraryId()` returned max+1 — or **1 on any read/parse failure**.
The collision guard (`findFreeImportedId`) only *checked* whether the
`imported_<id>.<ext>` slot was free, and it ran *before* the possibly
minutes-long conversion that creates the file. Three independent
entry points allocated IDs, so two concurrent imports could take the
same ID and destination path, and the second conversion overwrote
the first's audio.

## What this PR does (all inside `src/main/import-pipeline.ts`)

1. **One in-process import mutex.** `runImportExclusive()` — a
   promise-chain mutex — now wraps `importOneFile`, the single
   function every entry point shares (renderer `import-track` and
   `import-tracks` in `src/main/index.ts`, `importDownloadedFiles`
   for the Bandcamp/streamrip stores, the CD ripper's imports).
   Because the guard lives at the shared function, **no index.ts
   change was needed** and no entry point can forget the lock. The
   chain survives a rejected import: the next one still runs.
2. **Atomic reservation.** After allocation, the destination file is
   created with `fs.open(path, 'wx')` *before* conversion runs. The
   reservation is a fact on disk the instant it happens: any other
   allocator's `findFreeImportedId` sees the placeholder and bumps.
   The convert/copy then overwrites its own placeholder in place
   (ffmpeg runs with `-y`; `copyFile` truncates). If conversion
   fails over to a copy under the source extension, that slot is
   reserved the same way. A failed import releases its reservation
   (no 0-byte file squats on an ID forever).
3. **`nextLibraryId` fails loudly.** Unparseable library, wrong
   shape, or a non-ENOENT read error now throw a descriptive error
   instead of returning 1. The one legitimate bootstrap is kept:
   no library file at all (fresh install) still returns 1. The pure
   half is exported as `computeNextLibraryId` for tests.

Caller impact of the throw: `nextLibraryId` is called at the top of
`importDownloadedFiles`; its callers (the store integrations) receive
the rejection through the existing import bridge — a loud import
failure instead of silent ID-1 corruption. The renderer entry points
do not call `nextLibraryId` (the renderer supplies the starting ID,
which the reservation now makes safe).

## Tests

Appended to `src/main/__tests__/import-pipeline.test.ts` (repo style,
`node --test`): `computeNextLibraryId` max+1/junk handling;
`nextLibraryId` reads a real max, throws on a torn library,
bootstraps on ENOENT; the mutex never overlaps two tasks and
survives a rejection; and the headline race — two concurrent
`importOneFile` calls requesting the **same** id land on distinct
ids (5 and 6) with both destination files on disk.

Verified locally by the worker: the full import-pipeline suite
passes 17/17 (10 pre-existing + 7 new) under `node --test
--experimental-strip-types` with the repo's deps installed.
`npm run check` in a full checkout is the CI gate — CI status is
not readable from the agent environment (GitHub App 403 on checks),
so this PR is PR-ready only; do not merge until CI is verified
green.

## Rails

No `index.ts` change, no new silent catches, no version bump.
`import-pipeline.ts` grows by design (the guard belongs in a module,
per the decomposition doctrine).
