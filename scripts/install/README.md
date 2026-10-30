# scripts/install — the gated desktop install, and "Update ready"

`jaketunes-install-gate.sh` is the script that puts a new JakeTunes build on a
Mac. It is the source of truth for the copies that actually run:

- MacBook: `~/bin/jaketunes-install-gate.sh`
- workmini: `~/install-jt-wait.sh`

After a change merges, copy this file over both (the install pipeline runs
them; nothing in the repo deploys them). Both Macs run the same app build and
the same script — nothing here is machine-specific.

## What the gate does

```
jaketunes-install-gate.sh <staged.app> <backup-name> [max-wait-min] [sha] [note]
```

1. Preconditions: the staged `.app` exists, `~/<backup-name>` does not, the
   staged bundle's signature verifies. Remember the installed `app.asar` mtime.
2. **Wait** until it is safe to swap the app:
   - no JakeTunes audio — the `pmset` "Playing audio" assertion and a
     coreaudiod stream owned by JakeTunes are both hard stops (9/1: an inline
     `||` once let the install kill a song mid-play), and
   - either ≥ 120 s of keyboard/mouse idle (`ioreg` HIDIdleTime) **or** the
     app said "install now" (below).
   The heavier checks run every 15 s; the app's go-file is stat'ed every 2 s.
   `max-wait-min` (default 45) bounds the wait; the pipeline passes 180.
3. Install: `caffeinate`; quit by bundle id and wait for the process (by name,
   `pgrep -x`) to go; re-check the asar mtime (another session installing
   mid-way = abort); move the old bundle to `~/<backup-name>` (outside
   /Applications, or LaunchServices keeps launching it); `ditto` the staged
   bundle in — on failure the previous build is moved back; strip quarantine,
   verify the signature, `lsregister -f`, `open`. The last line reports the
   Mac, version, asar size/mtime, pid and where the previous build is.

Exit codes the pipeline parses: `0` installed · `1` ABORT (a precondition,
the app would not quit, the copy failed, the asar changed) · `3` the gate
never cleared in `max-wait-min`. Every ABORT leaves the installed app as it was.

## "Update ready" — how the gate and the app talk

Jake, 2026-10-30: *"when you update, instead of me pushing it through, there
should be an indication somewhere within jaketunes that it is ready to
update."* Before this, the gate could only wait for him to stop the music and
walk away for two minutes.

Two marker files in the app's data folder, `~/Library/Application
Support/JakeTunes` (Electron's `userData`):

**`update-ready.json`** — written by the gate, atomically (temp file in the
same folder, then `mv`), the moment it starts waiting. Only when a `sha` was
passed and the data folder exists (a dev machine has neither — the gate then
behaves exactly as before).

```json
{ "v": 1,
  "sha": "<the commit the staged build was made from>",
  "version": "<CFBundleShortVersionString of the staged app>",
  "note": "<free text from the pipeline, e.g. the merged PR titles>",
  "stagedAt": "<ISO-8601 UTC>",
  "gatePid": <pid of the waiting gate> }
```

**`update-go`** — written by the app (atomically) when Jake clicks Install;
holds the sha, one line. The gate checks for it every 2 s. When it carries
the gate's own sha, the idle requirement is waived and the install starts as
soon as the audio checks pass (they are never waived). A go-file naming a
different sha is ignored and deleted.

Both files are removed on **every** exit of the gate — install done, any
ABORT, the timeout, a TERM/INT kill — by an `EXIT` trap. The gate removes
only its own marker (its `gatePid`, its sha), so a newer gate's files survive
an older gate's death.

### What the app does (`src/main/update-ready.ts`, `update-ready-core.ts`)

- Watches `update-ready.json` in userData (fs.watch on the folder + a 15 s
  poll, like library.json). A marker counts only when: `v === 1`; `sha` is a
  non-empty string naming a build other than the one running
  (`build-info.json` via `build-provenance.ts`; a dev run with no build sha
  treats every marker as new); `gatePid` is alive (`kill -0`); `stagedAt` is
  within 12 h. A marker whose gate is dead is deleted — the file is litter.
- Pushes `update-ready` to the renderer with `{ sha, version, note }`, or
  `null` when the marker disappears or stops counting. The renderer also
  pulls once on mount (`update-ready:get`).
- The status bar (bottom of every page) shows **Update ready · Install** in
  the text-safe accent orange, with the note as its tooltip. Click → the
  app's ConfirmDialog: *Install the update?* — *JakeTunes will pause, close
  and come back in about 20 seconds.* + the note — **Install** / **Not now**.
- Install → IPC `install-update-now`: main pauses the music through the
  media-key path (the idempotent `pause` action from #305, the same one
  pause-for-calls sends), writes `update-go` with the sha, records a
  flight-recorder row (`update-ready.install-now`). The bar reads
  **Installing — back in a moment** until the gate quits the app.
- On launch the app deletes any leftover `update-go` so a stale yes can
  never greet the next gate.

### Calling it from the pipeline

```sh
# MacBook
~/bin/jaketunes-install-gate.sh "$STAGED" "JakeTunes-prev-$TAG-$SHA.app" 180 "$SHA" "$NOTE"
# workmini (over ssh, after shipping the staged bundle)
~/install-jt-wait.sh "$STAGED" "JakeTunes-prev-$TAG-$SHA.app" 180 "$SHA" "$NOTE"
```

`$SHA` is the main commit the build was made from (the same value
`scripts/write-build-info.mjs` stamps into the bundle, full or 12 chars —
the app compares the first 12). `$NOTE` is what Jake should see: the PR
titles, one line. Without the two new arguments the gate is the pre-protocol
gate (idle only, no markers).

## Tests

`src/main/__tests__/install-gate.test.ts` runs the shipped script under a
temp HOME with every Mac-only tool faked on PATH (`pmset`, `ioreg`,
`osascript`, `pgrep`, `codesign`, `ditto`, `open`, `xattr`, `stat`,
`caffeinate`, `scutil`, `ps`, `PlistBuddy`, `lsregister`) and a fake app
bundle as the install target. The overrides it uses — `JT_GATE_APP`,
`JT_GATE_DATA_DIR`, `JT_GATE_LSREGISTER`, `JT_GATE_PLISTBUDDY`,
`JT_GATE_POLL_S`, `JT_GATE_GO_POLL_S` — all default to the real thing and are
not used by the pipeline. `src/main/__tests__/update-ready.test.ts` covers the
app side and locks the wiring. Both run in `npm run check`.
