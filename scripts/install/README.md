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
   - no iPod sync: the app holding a display blocker (`NoDisplaySleepAssertion`), which
     `sync-keep-awake.ts` is the only one to do, is a hard stop that a click on Install
     doesn't waive. A quit mid-sync leaves part of the new songs on the card. A video wake
     lock reads the same and only delays an install.
   - no JakeTunes audio — the `pmset` "Playing audio" assertion and a
     coreaudiod stream owned by JakeTunes are both hard stops (9/1: an inline
     `||` once let the install kill a song mid-play), and
   - either ≥ 120 s of keyboard/mouse idle (`ioreg` HIDIdleTime) **or** the
     app said "install now" (below).
   The heavier checks run every 15 s; the app's go-file is stat'ed every 2 s.
   `max-wait-min` (default 45) bounds the wait; the pipeline passes 180.
3. Install: `caffeinate`; retire any watcher an earlier gate left (below); quit by bundle
   id and wait up to 30 s for the process to go, where a process on its way out (`ps`
   state E or Z) counts as gone; re-check the asar mtime (another session installing
   mid-way = abort); **copy first**: `ditto` the staged bundle to the hidden
   `~/.jt-incoming-<pid>.app`, strip quarantine, verify the signature there. A failed copy
   or check stops here and the installed build was never touched. An app that started
   during the copy also stops it, because swapping would leave it running from the backup.
   **Then swap**: two renames, the old bundle to `~/<backup-name>` (outside /Applications,
   or LaunchServices keeps launching it) and the copy into place, so nothing can find half
   a build at the path. Then `lsregister -f` and start the app. `open` and `lsregister`
   are held to 30 s each. The last line reports the Mac, version, asar size/mtime, pid and
   where the previous build is. A copy a SIGKILLed gate left behind is removed by the next gate.
4. **The Mac is never left with no app** (2026-11-06). The quit can't be taken back,
   so once it is asked for, the app is started again on every way out: install done,
   any ABORT after that point, a TERM. On 11/5 a quit took 21 minutes: the gate gave up
   after 30 s and nothing started the app when the process finally died.
   - **Measured** on a real bundle held in exit: `ps -p` says `?E` for as long as the
     exit takes, `pgrep -x` and `-f` see nothing from the moment it turns E, launchd
     still holds the job, and `open -a` exits 0 and starts nothing. So the old pid is
     asked about with `ps`, by pid, the app starts when that pid is gone, and only a
     live process proves it started, never `open`'s exit code. A process still alive 5 s
     after the first look proves it. One that dies in that time hasn't started.
   - If the old pid takes more than 30 s, a detached watcher does it, and the last line
     says `pid pending`. The watcher is named `jt-gate-watcher`, so `pgrep -f` can see it,
     and it holds its own `caffeinate`. While the old process is on its way out (state E
     or U) it has no limit at all, and a swap only ever happens over a process in E or Z.
     It only gives up on an old process that is plainly alive 30 minutes later on the wall
     clock and working: `ps -o time=` moved between two looks at least 60 s apart, with no
     look in E or U between them. One plain look isn't enough, because a quit stuck in U can
     read R, S or I once. That app never quit, and a quit by hand later stays a quit. Inside
     the 30 minutes a quit by hand does bring the app back, because one `ps` sample can't
     tell that from a slow quit.
   - A later gate retires the watcher before its own quit, and from then on that gate owes
     the app, even if no old process is left.
   - If no app comes up after three tries of `open`, the watcher keeps asking (every
     6 polls, 10 times at most), the last line says `pid none, the app did not come up,
     still trying`, and the exit is 4.
   - The watcher's output goes nowhere and the gate is gone by then, so it appends when it
     gives up to `~/Library/Logs/jaketunes-install-gate.log`, with the words `NO APP RUNNING`
     when that is the case. That one also goes to the phone, through the topic in
     `~/.config/jaketunes/ntfy-topic` if the Mac has one, because nothing reads that log.
   - A kill between the two renames puts the previous build back first, so what starts is whole.
   - The gate outlives whatever reads its output. SIGPIPE is ignored, and the first write
     that fails points stdout at /dev/null.

Exit codes: `0` installed, and an app stayed up, or `pid pending` · `1` ABORT (a precondition,
the app would not quit, the copy failed or failed its signature check, the app started
during the copy, the asar changed) · `3` the gate never cleared in `max-wait-min` · `4` the
build is installed, but no app has come up yet. Every ABORT leaves the installed build as it
was. A TERM or INT exits 143 or 130.

**Nothing reads these by itself.** The recipes run the gate as `gate | grep -v Terminated`, so
the pipeline's status is `grep`'s and exit 4 used to end in "done". A caller has to keep
`${PIPESTATUS[0]}` or look for `pid none`. The next recipe has to: nothing in this repo runs
the gate. A human reads the last line, and `0` with `pid pending` is not yet an app.

So a recipe says done only on a real pid. On `pid pending` or `pid none` it waits for
`pgrep -x JakeTunes`, looks again 5 s later, and gives that a limit (15 minutes covers the
watcher's 10 tries once the old process has gone). Past the limit it says `NO APP RUNNING on
<Mac>`. The likeliest time for `pid pending` is the first install over an old build, whose
quit is the slow one, so reading only the exit code misses exactly that one.

The app itself leaves within about 4 s since 2026-11-06 (`src/main/quit-finish.ts`);
a long wait now means the old build, or a write already in the kernel.

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

`src/main/__tests__/install-gate.test.ts`, `install-gate-quit.test.ts` and
`install-gate-swap.test.ts` run the shipped script under a temp HOME, with the world in
`install-gate-world.ts`: every Mac-only tool faked on PATH (`pmset`, `ioreg`,
`osascript`, `pgrep`, `pkill`, `codesign`, `ditto`, `open`, `xattr`, `stat`,
`caffeinate`, `scutil`, `ps`, `PlistBuddy`, `lsregister`) and a fake app
bundle as the install target. The overrides it uses — `JT_GATE_APP`,
`JT_GATE_DATA_DIR`, `JT_GATE_LSREGISTER`, `JT_GATE_PLISTBUDDY`,
`JT_GATE_POLL_S`, `JT_GATE_GO_POLL_S`, `JT_GATE_QUIT_WAIT_S`, `JT_GATE_GONE_WAIT_S`,
`JT_GATE_WATCH_S`, `JT_GATE_WATCH_POLL_S`, `JT_GATE_OPEN_RETRY_S`, `JT_GATE_START_WAIT_S`,
`JT_GATE_STAY_S`, `JT_GATE_LS_LIMIT_S` — all default to the real thing and are
not used by the pipeline. `src/main/__tests__/update-ready.test.ts` covers the
app side and locks the wiring. Both run in `npm run check`.
