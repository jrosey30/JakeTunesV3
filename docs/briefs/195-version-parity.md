# Brief 195 — Version parity endpoint + drift surfacing

## Source / evidence

- Proposed briefs 160+, Brief 195: "is every copy current?" took
  per-machine archaeology; the update feed tops out at v5.0.0
  (2026-07-03) while the source is 6.0.0, and version strings can't
  distinguish builds (workmini's two "6.0.0" bundles differ by a
  month and ~8 MB of app.asar).
- Live check while building this (2026-10-14): unauthenticated
  `api.github.com/repos/jrosey30/JakeTunesV3/releases/latest`
  returns **v5.0.0** — the gap the brief describes is still open,
  and the script below flags a 6.0.0 install against it on its
  first real run.

## What changes

- **`scripts/version-parity.mjs`** (new, zero-dependency Node):
  for each candidate install location — defaults
  `/Applications/JakeTunes.app`, `~/Applications/JakeTunes.app`,
  `~/JakeTunes-prev.app`; overridable via positional args or
  `$JT_PARITY_APPS` — it reads:
  - version from `Contents/Info.plist`
    (`CFBundleShortVersionString`, XML-parsed),
  - `app.asar` size + mtime,
  - Brief 192 build provenance: `build-info.json` as a plain file
    at `Contents/Resources/build-info.json`, or
    `out/main/build-info.json` inside `app.asar` via a minimal
    built-in asar reader (the path Brief 192's stamper writes).
  It fetches the latest GitHub Release (public repo,
  unauthenticated, 5 s timeout, graceful failure offline — local
  cross-comparison still runs) and reports **mismatches only**:
  silent exit 0 when every copy matches the newest known build;
  one `MISMATCH <path>: <issue>` line per problem and exit 1
  otherwise. `--json` always emits the full payload.
  Mismatch classes: install missing (reported distinctly),
  Info.plist unreadable, version != newest known, same version
  with different build SHAs across installs, same version with
  provenance on one copy only, and same version + no provenance +
  differing asar sizes (the two-bundles-one-version failure).
  `$JT_PARITY_RELEASE_JSON` (path to a saved releases/latest
  response) is the documented offline/test seam.
- **`src/main/__tests__/version-parity.test.ts`** (new): builds
  fixture .app trees (real-layout asars with stamped build-info)
  and runs the script end-to-end.

## Explicitly NOT this brief

- **Publishing the v6.0.0 GitHub Release** — a manual Mac-side act
  (`npm run release` from the 6.0.0 source). It is the single act
  that makes the armed auto-updater real; this script is what makes
  its absence impossible to miss.
- **Folding the report into the weekly digest** — an ops step
  outside the repo (run with `--json`, surface `mismatches`). The
  coordinator tracks it; nothing here schedules anything.

## Tests

- Fixture .app trees (agent env): matching pair → silent, exit 0;
  stale 5.0.0 → reported, exit 1; missing path → reported
  distinctly; same version + different SHA → reported; `--json`
  payload carries version/asar/provenance per install. Repo test:
  4/4 pass.
- Live run against the real GitHub API (no seam): correctly
  resolves latest release v5.0.0 and flags a 6.0.0 fixture install
  against it.
- NOT verified here: reading a real electron-builder app.asar —
  the asar reader is exercised against a fixture built to the
  documented asar layout; the first run against a real
  `/Applications/JakeTunes.app` is a manual step below.

## Manual steps

1. On the Mac: `node scripts/version-parity.mjs` — expect the
   known drift (6.0.0 installs vs v5.0.0 latest release) until the
   v6.0.0 Release is published by hand; then expect silence.
2. Confirm the provenance line for the real install shows a build
   SHA once a Brief 192-stamped build is installed (validates the
   asar reader against a real bundle).
