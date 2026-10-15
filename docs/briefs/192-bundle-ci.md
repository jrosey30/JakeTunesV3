# Brief 192 — Kill the stale root bundle's disguise (bundle/CI half)

## Scope note

The provenance module + startup log half of Brief 192 already
shipped as a chain-B handoff patch (`src/main/build-provenance.ts` —
reads `build-info.json` {sha, builtAt} beside the bundled main,
degrades to version + "dev"). This PR is the other half: delete the
stale bundle, generate the `build-info.json` that module consumes,
and lock the door behind it. The provenance module itself is NOT
re-done here.

## Source / evidence

- Proposed briefs 160+, Brief 192: repo-root `index.js` is an 808 KB
  esbuild bundle of an old main process (last committed 2026-08-04)
  presenting as the app; the real entry point is the TypeScript
  build.
- Verified against main @ 12bb43b: root `index.js` exists (808 KB
  esbuild output); `package.json` `"main": "out/main/index.js"`;
  electron-builder `files` covers `out/**/*` + `core/**/*` only;
  code search for root-bundle references across scripts, the builder
  config, docs, and CI returned nothing load-bearing — nothing
  references the root file. (Per the brief's case split, that is the
  delete case, not the stop case.)

## What changes

- **Deleted:** repo-root `index.js`.
- **`scripts/write-build-info.mjs`** (new): writes
  `out/main/build-info.json` = {sha, commit, builtAt, version} —
  `sha`/`builtAt` are exactly the fields the chain-B
  `build-provenance.ts` consumes (`commit` is the same SHA under the
  plainer name). Never fails a build: no git checkout → sha
  "unknown".
- **package.json wiring:** `build` appends the stamper; `dist`,
  `dist:mac`, `dist:win`, `dist:dmg`, `release` now route through
  `npm run build` so every packaged build is stamped, not just
  `npm run build` callers. New script `check:root-bundle`; the root
  check is appended to `check` (the repo gate).
- **`scripts/check-no-root-bundle.mjs`** (new): exits 1 if any
  `index.js` exists at the repo root — there is no legitimate root
  bundle, stamped or otherwise, so presence is the regression.
- **CI step — PREPARED, NOT APPLIED (permission blocker):** the
  automation's GitHub App gets `403 Resource not accessible by
  integration` on `.github/workflows/` (no workflow scope), so the
  step could not be pushed from here. The check IS wired into
  `npm run check`. Manual step: add this step to
  `.github/workflows/check.yml` after "Setup Node 22" —
  ```yaml
      - name: No stale root bundle (Brief 192)
        run: node scripts/check-no-root-bundle.mjs
  ```
- **README:** entry-point pointer under "Building a distributable
  app" — the real entry, the deleted bundle, the build stamp.
- **`src/main/__tests__/root-bundle-check.test.ts`** (new): runs the
  real check script against fixture roots (clean → 0; bundle → 1).

## What does NOT change

- No version bump. No app code. The chain-B provenance patch is
  untouched and un-duplicated.
- electron-vite output layout (`out/`) unchanged; the stamp lands
  beside the bundled main where its reader looks for it.

## Tests

- Fixture run of `write-build-info.mjs` in a scratch git repo:
  stamps full SHA + ISO time + version; the output was run through
  the chain-B patch's `parseBuildInfo` logic → yields the 12-char
  build SHA + builtAt (not the "dev" degradation).
- `check-no-root-bundle.mjs` fixture runs: clean tree → exit 0;
  root index.js present → exit 1 with the Brief 192 message.
- `root-bundle-check.test.ts` (node --test): 2/2 pass.
- package.json diff verified line-by-line: only the script lines
  above change.
- NOT run here: full `npm run check` / CI (needs the repo checkout /
  GitHub) — manual step below.

## Manual steps

1. On the Mac: `npm run check`, then `npm run build` and confirm
   `out/main/build-info.json` appears; with the chain-B provenance
   patch applied, the startup log prints
   `JakeTunes 6.0.0 (build <sha12>, built <time>)`.
2. Add the CI step above to `.github/workflows/check.yml` by hand
   (the App cannot edit workflows).
3. Delete any root `index.js` copies in other checkouts/worktrees —
   they were never load-bearing.
