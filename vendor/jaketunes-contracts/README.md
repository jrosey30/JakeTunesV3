# `@jaketunes/contracts` (vendored)

Private source of truth: https://github.com/jrosey30/jaketunes-contracts

JakeTunesV3 **vendors** `contracts.json` instead of adding an npm git dependency.

Why not `github:jrosey30/jaketunes-contracts`?

- This app repo is public; CI (`npm ci` on `macos-latest`) has no token for that private repo.
- A git dependency would break `npm install` on any machine without access (CI, cloud agents, a fresh clone).
- The homemini sync script is copied to `~/bin/` and cannot import `node_modules` at runtime anyway.

`npm install` / `npm ci` stay unchanged. Sidecar write-identity lists are in-tree.

## Bump

On a machine that can read the private repo (Jake's laptop, or a PAT with `repo` on `jaketunes-contracts`):

```bash
npm run sync:contracts          # fetches main
npm run sync:contracts -- v0.1.0
npm run sync:contracts -- <sha>
```

That script:

1. Fetches `contracts.json` (and records the resolved SHA in `SOURCE`)
2. Regenerates `src/main/sidecar-contracts.ts` from the JSON
3. Rewrites `PHONE_PLAYLIST_SIDECARS` in `Dr. Claude/scripts/jaketunes-homemini-sync.sh` and `Dr. Claude/scripts/jaketunes-workmini-deploy.sh` to match `sidecars.phonePlaylistSidecarsNeverPushFromDesktop`

Then run `npm test` — `src/main/__tests__/phone-playlist-sidecars.test.ts` locks the fences to the shared lists.

Do not hand-edit the lists in `sidecar-contracts.ts` or the bash array; change the contracts repo and re-sync.

If the fetch produces a diff against this snapshot, take the upstream file — that is the whole point of the shared package. V3 push-list membership does not change unless a name moves onto `phonePlaylistSidecarsNeverPushFromDesktop`.
