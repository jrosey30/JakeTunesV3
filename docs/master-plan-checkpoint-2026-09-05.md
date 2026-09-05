# Master plan checkpoint — 2026-09-05

Current phase: Desktop exact-download reliability, album-edition slice.
The playlist workspace is preserved in commit c1430b2. Do not restart Phase 0
or treat the older NAS migration plan as the current product roadmap.

## Work resumed

The tree already contained album identity and tests, provider/staged-file
verification, import duplicate reporting, and collection-id/count IPC wiring.
Those changes remain uncommitted. This continuation changed only
`src/main/download-search.ts`, `src/main/streamrip-store/index.ts`, and
`src/main/__tests__/album-identity.test.ts`, plus this checkpoint.

## Findings and fixes

- Name-only album lookup could choose a different edition and then use that
  edition's tracklist as the requested identity. It now requires matching
  artist, title, packaging and recording markers, with one unique collection.
  Missing artist metadata and ambiguous collections return no match. This
  intentionally reduces availability when a name cannot establish an edition;
  select a specific catalogue result in that case.
- The selected row's track count now takes precedence over a later lookup.
- `finishAlbum` previously logged a short import but returned `ok: true` and
  `outcome: imported`. It now returns a failure headed “Album import incomplete”
  with the completion counts and retry guidance. Successfully imported tracks
  remain in the library.
- Regression coverage includes alternate editions, live-only lookup results,
  ambiguity independent of result ordering, missing artist metadata, and a
  complete stage whose import leaves one track missing.

## Verification

- Initial unrestricted baseline: 1,087 tests passed and both typechecks passed.
  The first sandbox run failed four loopback-server tests; rerunning with
  loopback access resolved those environmental failures.
- After changes: `npm run check` passed, 1,088 tests, zero failures.
- `npm run build` passed; existing bundler chunk warnings remain.
- `git diff --check` passed.
- Diagnostic: `diagnostics/vern-20260905-030944.md` (gitignored).

## Remaining checkpoint work

This is a code/check checkpoint, not a live acceptance claim. No new install,
commit, push, version bump, or Mobile edit was performed. Live provider downloads
and the required UI interaction smoke checks were not exercised this turn.
Review an exact bonus-edition download, a name-only ambiguous album refusal,
and the incomplete-import Details state before declaring the phase complete.
Mobile download identity remains explicitly incomplete as recorded by the
album contract; this desktop change does not establish cross-product parity.

After this phase is accepted, the master brief's next step is the Desktop
information architecture, terminology, typography, and structural audit.
