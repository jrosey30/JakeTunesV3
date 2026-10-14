# Brief 196 — vern --share: diagnostics that leave the machine

## ⚠️ Premise correction (verified against main @ 12bb43b)

The brief's evidence says vern has a `--json` mode ("`--json` exists;
no redaction pass and no share target"). **It does not.** The vern on
main (449 lines, v0.6) has no `--json` flag and no JSON collection —
its only output is the markdown capture written to
`diagnostics/vern-<timestamp>.md`. This PR therefore implements
`--share` over the collection that actually exists: the standard
markdown capture, redacted. If a JSON mode is ever added, the same
redactor can run over it unchanged (it is format-agnostic text
substitution); nothing here invents a JSON pipeline the codebase
doesn't have.

## What changes

- **`scripts/vern` (v0.6 → v0.7):** new `--share` mode.
  `./scripts/vern --share ["note"]` runs the normal capture, then
  writes a redacted bundle to `diagnostics/vern-share-<timestamp>.md`
  plus the stable copy `diagnostics/vern-share-latest.md` (the
  script's existing diagnostics location/convention), and prints
  one summary line: share path + redaction count + headline counts
  (version, tsc web/node error counts from the same run).
  **Fail-closed:** if the redactor or python3 is unavailable, vern
  exits 1 and writes NO share file — an unredacted copy is never
  the fallback. Non-share invocations are byte-identical in
  behaviour to v0.6.
- **`scripts/vern-redact.py`** (new): the redaction pass. Replaces
  the absolute home path (→ `~`) and repo root (→ `<repo>`) passed
  by vern, anonymizes any other `/Users/<name>` path, and replaces
  token-shaped values: GitHub tokens (ghp_/gho_/github_pat_…), AWS
  keys (AKIA…), sk-/sk-ant- API keys, JWTs, `Bearer <value>`, and
  `key|token|secret|password = value` assignments. Prints the
  redaction count for vern's summary line. Conservative: git SHAs,
  versions and error text are diagnostic value and are kept.
- **`src/main/__tests__/vern-share.test.ts`** (new): runs the real
  redactor over synthetic captures (secrets built by concatenation
  so the test file holds no credential-shaped literals) and the
  fail-closed path end-to-end.

## What does NOT change

- vern stays read-only: it writes only its own diagnostics output,
  as it always has. The unredacted capture never leaves
  `diagnostics/` by any new path — only the redacted bundle is the
  share artifact.
- The capture's contents, sections, and default output path are
  unchanged.

## Tests

- Redactor module fixtures (agent env): fake GitHub token, sk-ant
  key, AWS key, JWT, Bearer header, password assignment, home +
  repo paths → all redacted (8 redactions counted); git SHA and
  version string preserved verbatim.
- End-to-end in a fixture git repo: `vern --share "smoke note"`
  produced the capture + `vern-share-<ts>.md` +
  `vern-share-latest.md` with `**Repo:** <repo>` and the one-line
  summary (`version 6.0.0, tsc web 0 errors, node 0 errors`);
  no absolute home path anywhere in the bundle.
- Fail-closed: redactor removed → exit 1, no share file written.
  Plain `vern "note"` unchanged. `bash -n` clean.
- Repo test: 2/2 pass.

## Manual steps

1. On the Mac: `./scripts/vern --share "post-196 smoke"` and eyeball
   `diagnostics/vern-share-latest.md` once before first real use —
   the redaction list is conservative, and the first bundle that
   leaves the machine deserves one human read.
