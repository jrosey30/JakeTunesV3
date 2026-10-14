# Brief 174 — Verify overrides before publishing them to homemini

> Stacked on Brief 172 (same sync-script file). PR base is the
> Brief 172 branch; merge 172 first.

## Source / evidence

- Proposed briefs 160+, Brief 174: the sync script's library publish
  is the gold standard (upload to `.incoming`, remote verifier refuses
  empty/corrupt/stale, then `os.replace`); the general state push
  rsyncs `--checksum` straight at the state directory, so a locally
  corrupt `metadata-overrides.json` is faithfully propagated over the
  good remote copy.
- Script (main @ 12bb43b): `publish_backend_library` ≈ lines 373-420
  vs `push_homemini_state` ≈ lines 434-483 — verified against the
  repo copy at `Dr. Claude/scripts/jaketunes-homemini-sync.sh`.

## What changes (sync script only)

- New `publish_verified_overrides`, modelled on
  `publish_backend_library`:
  1. Local gate: the file must parse as JSON, be an object, and be
     non-empty — otherwise it is not published at all.
  2. Upload to `.metadata-overrides.json.incoming` in the target
     state dir (the hub folder, or the replica's own folder in
     replica mode — same containment as every other replica file).
  3. Remote verifier (Python over ssh, same idiom as the library
     publish): refuses corrupt (unparseable, not an object, or
     empty) and refuses stale — the remote copy's mtime newer than
     the incoming copy's. `rsync -tz` preserves the source mtime on
     the incoming file, so the comparison is source-age vs
     source-age: the mtime analogue of the library publish's
     dated-track check. On success: `os.replace` over
     `metadata-overrides.json`.
- `push_homemini_state` calls it for `metadata-overrides.json`
  (hub and replica alike) and the bulk `--checksum` rsync now skips
  that one file. `SYNC_FILES` still lists it — the mtime fingerprint
  gate and the contracts lock that reads the array are untouched.

## What does NOT change

- Every other file in the state push: same rsync, same flags, same
  order. The library publish is untouched. Brief 172's star legs are
  untouched (this PR's script diff starts from 172's).
- A refused publish leaves the remote copy exactly as it was and the
  local file unpublished for this cycle; the refusal is logged with
  the same wording pattern as the library publish's refusals.

## Tests

- Verifier logic extracted from the script and run against fixtures:
  good payload (newer) → `published 1`, replaces; empty object →
  `refused-corrupt`; unparseable → `refused-corrupt`; JSON array →
  `refused-corrupt`; remote copy newer → `refused-stale`, current
  untouched in every refusal.
- New repo harness `src/main/__tests__/sync-script-verified-push.test.ts`
  (stub ssh/rsync, same pattern as the replica-push harness): asserts
  overrides upload to `.metadata-overrides.json.incoming`, never ride
  the bulk rsync, the remote verifier runs — and (Brief 172) stars
  upload to `.mobile-stars.json.incoming` with no rsync landing
  directly on `mobile-stars.json`. 2/2 pass.
- Existing harness `sync-script-replica-push.test.ts` against the
  edited script: 8/8 pass. (Its fixture writes a non-JSON placeholder
  into metadata-overrides.json, so the local gate correctly declines
  and the bulk push proceeds without it — no assertion in that
  harness covers overrides either way.)
- `bash -n` clean.

## Manual steps

1. Merge after Brief 172; reinstall the script to `~/bin/` on each
   Mac that runs it.
2. Watch one sync log: expect `overrides publish: published N
   override entries` on a state change; a `REFUSED` line means the
   local sidecar or the remote copy needs a look — do not force it.
