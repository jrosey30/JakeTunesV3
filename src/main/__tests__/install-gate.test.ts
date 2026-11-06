/**
 * The install gate, run for real (2026-10-30).
 *
 * scripts/install/jaketunes-install-gate.sh is the script that swaps
 * /Applications/JakeTunes.app on both Macs once nothing is playing and the
 * keyboard has been idle for 120 s. This harness runs the shipped script
 * under a temp HOME with every Mac-only tool faked on PATH (pmset, ioreg,
 * osascript, pgrep, codesign, ditto, open, xattr, stat, caffeinate, scutil,
 * ps, PlistBuddy, lsregister) and the real /usr/bin:/bin for the rest — the
 * same shape as the sync-script and cache-manager harnesses. The install
 * target is a fake app bundle inside the temp dir (JT_GATE_APP), never the
 * real one.
 *
 * What it proves:
 *  - the "update ready" protocol: update-ready.json is written the moment
 *    the wait begins; update-go with OUR sha clears the gate without idle
 *    and with no heavy check due; a go-file for another sha is ignored and
 *    deleted; the audio hard stop still blocks with a go-file present
 *  - both markers are removed on success, on every ABORT, on timeout and
 *    on a TERM kill
 *  - the pre-protocol behaviour is unchanged: messages, exit codes, the
 *    idle path, the no-sha call, the dev-machine (no data folder) call
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HUNG_MS, waitFor } from './wait-for.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'install', 'jaketunes-install-gate.sh')
const DATA_REL = join('Library', 'Application Support', 'JakeTunes')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const NOTE = 'Album page "D" + back pill'
const BK = 'JakeTunes-prev-test.app'
const OLD_ASAR = 'old build asar bytes'
const NEW_ASAR = 'new build asar bytes — longer'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const FAKES: Record<string, string> = {
  pmset: `#!/bin/bash
echo "pmset $*" >> "$JT_FAKE/calls.log"
cat "$JT_FAKE/assertions" 2>/dev/null
exit 0
`,
  ioreg: `#!/bin/bash
echo "ioreg $*" >> "$JT_FAKE/calls.log"
printf '    | |   "HIDIdleTime" = %s\\n' "$(cat "$JT_FAKE/idle_ns")"
`,
  // quit_hold: the quit takes as long as the file stays, so a test can act inside it.
  osascript: `#!/bin/bash
echo "osascript $*" >> "$JT_FAKE/calls.log"
while [ -e "$JT_FAKE/quit_hold" ]; do sleep 0.02; done
if [ -e "$JT_FAKE/pids" ]; then
  # The process table world: quit_state says what the old process turns into.
  [ -e "$JT_FAKE/quit_state" ] && cp "$JT_FAKE/quit_state" "$JT_FAKE/state_4242"
  exit 0
fi
[ -e "$JT_FAKE/refuse_quit" ] || rm -f "$JT_FAKE/running"
exit 0
`,
  // The process table world follows what a real bundle held in exit did (2026-11-06, a
  // throwaway background-only app launched by open and killed). pgrep -x sees nothing
  // from the moment a process turns E, and ps -p still answers for it. The first version
  // of these fakes had pgrep listing it, which is how the gate shipped a bug they agreed with.
  pgrep: `#!/bin/bash
echo "pgrep $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/pids" ]; then
  rc=1
  for p in $(cat "$JT_FAKE/pids"); do
    st=$(cat "$JT_FAKE/state_$p" 2>/dev/null || echo S)
    case "$st" in *E*|*Z*) ;; *) echo "$p"; rc=0 ;; esac
  done
  exit $rc
fi
if [ -e "$JT_FAKE/running" ]; then echo 4242; exit 0; fi
exit 1
`,
  ps: `#!/bin/bash
pid=""; fmt=""; all=""
while [ $# -gt 0 ]; do case "$1" in -p) pid="$2"; shift ;; -o) fmt="$2"; shift ;; -axo) all=1; fmt="$2"; shift ;; esac; shift; done
if [ -n "$all" ]; then
  [ -e "$JT_FAKE/pids" ] || exit 0
  for p in $(cat "$JT_FAKE/pids"); do
    st=$(cat "$JT_FAKE/state_$p" 2>/dev/null || echo S)
    bin=/Applications/JakeTunes.app/Contents/MacOS/JakeTunes; name=JakeTunes
    [ "$p" = 9 ] && { bin="/Applications/JakeTunes.app/Contents/Frameworks/JakeTunes Helper.app/Contents/MacOS/JakeTunes Helper"; name="JakeTunes Helper"; }
    case "$st" in
      '?E') echo "$p $st ($name)" ;;
      *Z*) echo "$p Z <defunct>" ;;
      *) echo "$p $st $bin" ;;
    esac
  done
  exit 0
fi
if [ "$fmt" = "state=" ]; then
  if [ -e "$JT_FAKE/pids" ]; then
    grep -qx "$pid" "$JT_FAKE/pids" || exit 1
  else
    [ -e "$JT_FAKE/running" ] || exit 1
  fi
  cat "$JT_FAKE/state_$pid" 2>/dev/null || echo "S"
  exit 0
fi
cat "$JT_FAKE/ps_$pid" 2>/dev/null
exit 0
`,
  // codesign_exit: the staged app's check. codesign_exit_copy: the check of the copy.
  codesign: `#!/bin/bash
echo "codesign $*" >> "$JT_FAKE/calls.log"
case "\${@: -1}" in
  */.jt-incoming-*) exit "$(cat "$JT_FAKE/codesign_exit_copy" 2>/dev/null || echo 0)" ;;
esac
exit "$(cat "$JT_FAKE/codesign_exit" 2>/dev/null || echo 0)"
`,
  // The real mv, on the record. mv_in_fails and mv_in_hang: the rename of the copy into place.
  mv: `#!/bin/bash
echo "mv $*" >> "$JT_FAKE/calls.log"
case "$*" in
  *.jt-incoming-*)
    [ -e "$JT_FAKE/mv_in_fails" ] && exit 1
    if [ -e "$JT_FAKE/mv_in_hang" ]; then echo $$ > "$JT_FAKE/ditto_pid.tmp"; /bin/mv -f "$JT_FAKE/ditto_pid.tmp" "$JT_FAKE/ditto_pid"; exec sleep 60; fi
    ;;
esac
exec /bin/mv "$@"
`,
  // ditto_hang: a copy still going. It says what it has written so far ("partial" = some
  // of the bundle, empty = nothing yet) and waits to be killed. ditto_starts_app: something
  // else starts the app while it copies.
  ditto: `#!/bin/bash
echo "ditto $*" >> "$JT_FAKE/calls.log"
[ -e "$JT_FAKE/ditto_fail" ] && exit 1
[ -e "$JT_FAKE/ditto_starts_app" ] && echo 7777 >> "$JT_FAKE/pids"
if [ -e "$JT_FAKE/ditto_hang" ]; then
  if [ -s "$JT_FAKE/ditto_hang" ]; then mkdir -p "$2/Contents"; echo partial > "$2/Contents/half-written"; fi
  echo $$ > "$JT_FAKE/ditto_pid.tmp"; /bin/mv -f "$JT_FAKE/ditto_pid.tmp" "$JT_FAKE/ditto_pid"
  exec sleep 60
fi
cp -R "$1" "$2"
`,
  // With the old process still there, in any state but a zombie, open exits 0 and starts
  // nothing: measured on a real process in state E. The case the gate has to wait out.
  // open_fails: how many more times open says no (LaunchServices, right after a swap).
  // open_swallows: how many more times open says yes and nothing starts.
  open: `#!/bin/bash
echo "open $*" >> "$JT_FAKE/calls.log"
countdown() {
  [ -e "$JT_FAKE/$1" ] || return 1
  n=$(cat "$JT_FAKE/$1")
  [ "$n" -gt 0 ] || return 1
  echo $((n - 1)) > "$JT_FAKE/$1.tmp"; mv -f "$JT_FAKE/$1.tmp" "$JT_FAKE/$1"
}
countdown open_fails && exit 1
countdown open_swallows && exit 0
if [ -e "$JT_FAKE/pids" ]; then
  if grep -qx 4242 "$JT_FAKE/pids"; then
    case "$(cat "$JT_FAKE/state_4242" 2>/dev/null || echo S)" in
      *Z*) ;;
      *) echo "open-found-the-old-one" >> "$JT_FAKE/calls.log"; exit 0 ;;
    esac
  fi
  echo 5151 >> "$JT_FAKE/pids"
  exit 0
fi
touch "$JT_FAKE/running"
exit 0
`,
  xattr: `#!/bin/bash
echo "xattr $*" >> "$JT_FAKE/calls.log"
exit 0
`,
  // Only this world's watchers. The real pkill by the gate's own pattern would reach every
  // watcher on this Mac, a real install's among them.
  pkill: `#!/bin/bash
echo "pkill $*" >> "$JT_FAKE/calls.log"
exec /usr/bin/pkill -f "jt-gate-watcher [0-9].*$JT_GATE_APP"
`,
  // date_offset moves the wall clock, the way a closed lid does: the epoch seconds jump,
  // and nothing else about the run changes.
  date: `#!/bin/bash
if [ "$1" = "+%s" ] && [ -e "$JT_FAKE/date_offset" ]; then
  echo $(( $(/bin/date +%s) + $(cat "$JT_FAKE/date_offset") ))
  exit 0
fi
exec /bin/date "$@"
`,
  caffeinate: `#!/bin/bash
echo "caffeinate $*" >> "$JT_FAKE/calls.log"
exec sleep 30
`,
  scutil: `#!/bin/bash
echo "TestMac"
`,
  // BSD stat -f: %m mtime seconds, %z size, %Sm human mtime — the three the gate uses.
  // The "--" matters: without it perl swallows "-f" as its own switch and stat() gets no path.
  stat: `#!/bin/bash
exec perl -e '
  my ($flag, $fmt, $file) = @ARGV;
  my @s = stat($file) or exit 1;
  my $out = $fmt;
  $out =~ s/%Sm/scalar localtime($s[9])/ge;
  $out =~ s/%m/$s[9]/g;
  $out =~ s/%z/$s[7]/g;
  print "$out\\n";
' -- "$@"
`,
  PlistBuddy: `#!/bin/bash
echo "PlistBuddy $*" >> "$JT_FAKE/calls.log"
awk '/CFBundleShortVersionString/{getline; gsub(/.*<string>|<\\/string>.*/, ""); print; exit}' "$3"
`,
  lsregister: `#!/bin/bash
echo "lsregister $*" >> "$JT_FAKE/calls.log"
exit 0
`,
}

// One folder of fakes for the whole file, not one per test. Their state lives in
// $JT_FAKE, so worlds stay apart, and a brand-new executable's first run is the slow
// one: macOS checks it, 277 ms against 5.5 ms for the next run at load ~290
// (2026-11-04). Fourteen of those per test used up the 15 s this file failed on.
const bin = mkdtempSync(join(tmpdir(), 'jt-gate-bin-'))
for (const [name, body] of Object.entries(FAKES)) {
  writeFileSync(join(bin, name), body)
  chmodSync(join(bin, name), 0o755)
}
// The one the gate holds to a limit of its own (alarm 20): never its first run.
execFileSync(join(bin, 'osascript'), { env: { ...process.env, JT_FAKE: bin } })
// A detached watcher (the slow-quit cases) ends within a poll of its test's cleanup. Let
// it, before the fakes' folder goes: it must never find the real tools on PATH.
after(async () => {
  await new Promise((r) => setTimeout(r, 1500))
  rmSync(bin, { recursive: true, force: true })
})

const ASSERTIONS = {
  none: `Assertions status system-wide:
   PreventUserIdleSystemSleep       0
Listed by owning process:
   pid 77(powerd): [0x0000000100000001] 00:00:03 PreventSystemSleep named: "Powerd - Prevent sleep while display is on"
`,
  assertion: `Assertions status system-wide:
   PreventUserIdleSystemSleep       1
Listed by owning process:
   pid 4242(JakeTunes): [0x000000030000a0b1] 00:12:34 PreventUserIdleSystemSleep named: "Playing audio"
`,
  stream: `Assertions status system-wide:
   PreventUserIdleSystemSleep       1
Listed by owning process:
   pid 180(coreaudiod): [0x000000040000c0d2] 00:00:05 PreventUserIdleSystemSleep named: "com.apple.audio.context.preventuseridlesleep"
	Created for PID: 4242.
`,
}

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
	<key>CFBundleIdentifier</key>
	<string>com.jacobrosenbaum.jaketunes</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
</dict></plist>
`
}

interface WorldOpts {
  dataDir?: boolean
  audio?: keyof typeof ASSERTIONS
  idleS?: number
  codesignExit?: number
  dittoFail?: boolean
  stagedMissing?: boolean
  backupExists?: boolean
  /** Heavy-check cadence in seconds (JT_GATE_POLL_S); long = prove the go-file path. */
  pollS?: number
  /** What the old process turns into when asked to quit, in the process-table world. */
  quitState?: string
  /** Start in the process-table world (a pids file) with these pids; '' = no app running. */
  pids?: string
  quitWaitS?: number
  goneWaitS?: number
  watchS?: number
  watchPollS?: number
  /** How many times open says no before it works. */
  openFails?: number
  /** How many times open says yes and nothing starts. */
  openSwallows?: number
  /** Starts with a JakeTunes Helper in this exiting state in the process table. */
  helperDying?: string
  /** Already in this state when the gate starts. */
  oldState?: string
  /** A copy that never finishes: 'partial' has written some of the bundle, 'nothing' has not begun. */
  dittoHang?: 'partial' | 'nothing'
  /** The quit holds until quitDone(). */
  quitHold?: boolean
  /** The check of the copy fails, where the staged app's passed. */
  codesignExitCopy?: number
  /** The rename of the copy into place: refused, or still going when the test kills it. */
  mvIn?: 'fails' | 'hangs'
  /** Something else starts the app while the copy runs. */
  dittoStartsApp?: boolean
}

interface World {
  root: string
  home: string
  dataDir: string
  marker: string
  goFile: string
  installedApp: string
  installedAsar: string
  stagedApp: string
  fake: string
  calls: () => string
  writeGo: (sha: string) => void
  setAudio: (a: keyof typeof ASSERTIONS) => void
  setIdle: (s: number) => void
  /** The old process finally dies. */
  oldGone: () => void
  /** Something else starts the app. */
  newApp: () => void
  pids: () => string
  /** What ps says the old process is now. */
  setOldState: (state: string) => void
  /** The Mac slept: the wall clock is this much further on. */
  clockJumps: (seconds: number) => void
  openWorksNow: () => void
  /** Where this gate copies the build before it swaps. */
  incoming: (g: Gate) => string
  /** What the old process turns into when the next gate asks it to quit. */
  setQuitState: (state: string) => void
  /** From now on a copy never finishes. */
  copyHangs: () => void
  /** A real pgrep, by the name the gate gives its watcher. */
  watcherAlive: () => boolean
  /** It has looked at the process table and gone to sleep, so it won't look again for a poll. */
  watcherAsleep: () => boolean
  /** A TERM to the gate and its copy, the way a kill of the process group lands. */
  termGateAndCopy: (g: Gate) => void
  quitDone: () => void
  run: (args: { sha?: string; note?: string; maxMin?: number }) => Gate
  cleanup: () => void
}

interface Gate {
  child: ChildProcess
  out: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Whatever read the gate's output has gone: its next write has no one to go to. */
  readerGone: () => Promise<void>
}

function makeWorld(o: WorldOpts = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'jt-gate-'))
  const home = join(root, 'home')
  const dataDir = join(home, DATA_REL)
  const fake = join(root, 'fake')
  mkdirSync(home, { recursive: true })
  if (o.dataDir !== false) mkdirSync(dataDir, { recursive: true })
  mkdirSync(fake)
  writeFileSync(join(fake, 'assertions'), ASSERTIONS[o.audio ?? 'none'])
  writeFileSync(join(fake, 'idle_ns'), String((o.idleS ?? 10) * 1_000_000_000))
  writeFileSync(join(fake, 'ps_4242'), 'JakeTunes\n')
  writeFileSync(join(fake, 'running'), '')
  writeFileSync(join(fake, 'calls.log'), '')
  if (o.codesignExit) writeFileSync(join(fake, 'codesign_exit'), String(o.codesignExit))
  if (o.dittoFail) writeFileSync(join(fake, 'ditto_fail'), '')
  if (o.pids !== undefined) writeFileSync(join(fake, 'pids'), o.pids)
  if (o.quitState) writeFileSync(join(fake, 'quit_state'), `${o.quitState}\n`)
  if (o.openFails !== undefined) writeFileSync(join(fake, 'open_fails'), String(o.openFails))
  if (o.openSwallows !== undefined) writeFileSync(join(fake, 'open_swallows'), String(o.openSwallows))
  if (o.helperDying) { writeFileSync(join(fake, 'pids'), `${o.pids ?? ''}9\n`); writeFileSync(join(fake, 'state_9'), `${o.helperDying}\n`) }
  if (o.oldState) writeFileSync(join(fake, 'state_4242'), `${o.oldState}\n`)
  if (o.dittoHang) writeFileSync(join(fake, 'ditto_hang'), o.dittoHang === 'partial' ? 'partial\n' : '')
  if (o.quitHold) writeFileSync(join(fake, 'quit_hold'), '')
  if (o.codesignExitCopy) writeFileSync(join(fake, 'codesign_exit_copy'), String(o.codesignExitCopy))
  if (o.mvIn === 'fails') writeFileSync(join(fake, 'mv_in_fails'), '')
  if (o.mvIn === 'hangs') writeFileSync(join(fake, 'mv_in_hang'), '')
  if (o.dittoStartsApp) writeFileSync(join(fake, 'ditto_starts_app'), '')

  const installedApp = join(root, 'Applications', 'JakeTunes.app')
  mkdirSync(join(installedApp, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(installedApp, 'Contents', 'Resources', 'app.asar'), OLD_ASAR)
  writeFileSync(join(installedApp, 'Contents', 'Info.plist'), plist('5.9.0'))
  const stagedApp = join(root, 'staged', 'JakeTunes.app')
  if (!o.stagedMissing) {
    mkdirSync(join(stagedApp, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(stagedApp, 'Contents', 'Resources', 'app.asar'), NEW_ASAR)
    writeFileSync(join(stagedApp, 'Contents', 'Info.plist'), plist('6.0.0'))
  }
  if (o.backupExists) mkdirSync(join(home, BK))

  const goFile = join(dataDir, 'update-go')
  const spawned: ChildProcess[] = []
  return {
    root, home, dataDir, fake, installedApp, stagedApp, goFile,
    marker: join(dataDir, 'update-ready.json'),
    installedAsar: join(installedApp, 'Contents', 'Resources', 'app.asar'),
    calls: () => readFileSync(join(fake, 'calls.log'), 'utf8'),
    // The app's write: unique temp name, then rename (update-ready.ts).
    writeGo: (sha) => { const tmp = `${goFile}.${process.pid}.tmp`; writeFileSync(tmp, `${sha}\n`); renameSync(tmp, goFile) },
    setAudio: (a) => writeFileSync(join(fake, 'assertions'), ASSERTIONS[a]),
    setIdle: (s) => writeFileSync(join(fake, 'idle_ns'), String(s * 1_000_000_000)),
    // Atomic, like the process table: a reader must never catch this half written.
    oldGone: () => {
      const tmp = join(fake, 'pids.tmp')
      writeFileSync(tmp, readFileSync(join(fake, 'pids'), 'utf8').split('\n').filter((l) => l && l !== '4242').map((l) => `${l}\n`).join(''))
      renameSync(tmp, join(fake, 'pids'))
    },
    newApp: () => {
      const tmp = join(fake, 'pids.tmp')
      writeFileSync(tmp, `${readFileSync(join(fake, 'pids'), 'utf8')}7777\n`)
      renameSync(tmp, join(fake, 'pids'))
    },
    pids: () => readFileSync(join(fake, 'pids'), 'utf8'),
    setOldState: (state) => {
      const tmp = join(fake, 'state.tmp')
      writeFileSync(tmp, `${state}\n`)
      renameSync(tmp, join(fake, 'state_4242'))
    },
    clockJumps: (seconds) => writeFileSync(join(fake, 'date_offset'), String(seconds)),
    // Not the fake open's temp name: two writers on one name, and a watcher mid-countdown
    // took this one's away (ENOENT, once, at load 37, 2026-11-06).
    openWorksNow: () => {
      const tmp = join(fake, 'open_fails.works-now.tmp')
      writeFileSync(tmp, '0')
      renameSync(tmp, join(fake, 'open_fails'))
    },
    quitDone: () => rmSync(join(fake, 'quit_hold'), { force: true }),
    incoming: (g) => join(home, `.jt-incoming-${g.child.pid}.app`),
    setQuitState: (state) => writeFileSync(join(fake, 'quit_state'), `${state}\n`),
    copyHangs: () => writeFileSync(join(fake, 'ditto_hang'), 'partial\n'),
    watcherAlive: () => {
      try {
        execFileSync('/usr/bin/pgrep', ['-f', `jt-gate-watcher [0-9].*${installedApp}`], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    watcherAsleep: () => {
      try {
        const pid = execFileSync('/usr/bin/pgrep', ['-f', `jt-gate-watcher [0-9].*${installedApp}`], { encoding: 'utf8' }).trim().split('\n')[0]
        execFileSync('/usr/bin/pgrep', ['-P', pid, '-x', 'sleep'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    termGateAndCopy: (g) => {
      g.child.kill('SIGTERM')
      process.kill(Number(readFileSync(join(fake, 'ditto_pid'), 'utf8')), 'SIGTERM')
    },
    // Five minutes, not the script's 45: the runner's own limit, so being slow never
    // trips this ABORT, and a gate that outlives its test goes soon after instead of
    // holding a CI run for 45 minutes (2026-10-30).
    run: ({ sha, note, maxMin = 5 }) => {
      const args = [scriptPath, stagedApp, BK, String(maxMin)]
      if (sha !== undefined) args.push(sha)
      if (note !== undefined) args.push(note)
      const child = spawn('/bin/bash', args, {
        env: {
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          LANG: 'en_US.UTF-8',
          JT_FAKE: fake,
          JT_GATE_APP: installedApp,
          JT_GATE_LSREGISTER: join(bin, 'lsregister'),
          JT_GATE_PLISTBUDDY: join(bin, 'PlistBuddy'),
          JT_GATE_POLL_S: String(o.pollS ?? 1),
          JT_GATE_GO_POLL_S: '0.1',
          JT_GATE_QUIT_WAIT_S: String(o.quitWaitS ?? 30),
          JT_GATE_GONE_WAIT_S: String(o.goneWaitS ?? 30),
          // Always bounded here: a watcher that outlives this file's fakes would find the real open.
          JT_GATE_WATCH_S: String(o.watchS ?? 8),
          JT_GATE_WATCH_POLL_S: String(o.watchPollS ?? 0.1),
          JT_GATE_OPEN_RETRY_S: '0.1',
          JT_GATE_START_WAIT_S: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      spawned.push(child)
      let out = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => { out += d })
      child.stderr?.on('data', (d: string) => { out += d })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
      })
      const readerGone = async (): Promise<void> => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        await sleep(100)
      }
      return { child, out: () => out, exited, readerGone }
    },
    // A gate still waiting when a test gives up is killed here: left alone it
    // held the stdio pipes (and node:test) for its whole max-wait (2026-10-30).
    // The pipes go too: a stuck child of the gate outlives the kill and holds them.
    cleanup: () => {
      for (const c of spawned) {
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
        c.stdout?.destroy()
        c.stderr?.destroy()
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function readMarker(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

async function finished(g: Gate, timeoutMs = HUNG_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // The timer is cleared on exit — a live timer this long would keep the test
  // process alive long after the last scenario.
  let handle: ReturnType<typeof setTimeout> | null = null
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => { g.child.kill('SIGKILL'); reject(new Error(`gate did not exit in ${timeoutMs} ms:\n${g.out()}`)) }, timeoutMs)
  })
  try {
    return await Promise.race([g.exited, timer])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

describe('install gate — the update-ready protocol', () => {
  it('writes update-ready.json the moment it starts waiting; a TERM kill removes it', async () => {
    const w = makeWorld({ idleS: 10 })
    try {
      const startedAt = Date.now()
      const g = w.run({ sha: SHA, note: NOTE })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      const m = readMarker(w.marker)
      assert.equal(m['v'], 1)
      assert.equal(m['sha'], SHA)
      assert.equal(m['version'], '6.0.0', 'version comes from the STAGED app\'s Info.plist')
      assert.equal(m['note'], NOTE, 'the note survives JSON escaping of its quotes')
      assert.equal(m['gatePid'], g.child.pid)
      // Between starting the gate and reading its marker; the stamp is whole seconds.
      const stagedAt = Date.parse(String(m['stagedAt']))
      assert.ok(stagedAt >= startedAt - 1_000 && stagedAt <= Date.now(), `stagedAt is now: ${String(m['stagedAt'])}`)
      await waitFor(() => /waiting: in use 10s ago/.test(g.out()), 'the idle wait line')
      assert.match(g.out(), /update-ready\.json written for 0123456789abcdef/)
      assert.doesNotMatch(g.out(), /gate clear/)
      assert.equal(g.child.exitCode, null, 'still waiting')

      g.child.kill('SIGTERM')
      const r = await finished(g)
      assert.equal(r.code, 143, 'a TERM kill exits through the trap')
      assert.ok(!existsSync(w.marker), 'the marker is removed when the gate dies')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'nothing was installed')
      assert.doesNotMatch(w.calls(), /^ditto /m)
    } finally { w.cleanup() }
  })

  it('a go-file with OUR sha clears the gate without idle, with no heavy check due, and installs; both markers are removed', async () => {
    // The first heavy check has run and the next is an hour off: if the 2 s go-file
    // check did not do this on its own, the gate would sit until HUNG_MS fails the test.
    const w = makeWorld({ idleS: 10, pollS: 3600 })
    try {
      const g = w.run({ sha: SHA, note: NOTE })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      await waitFor(() => /waiting: in use 10s ago/.test(g.out()), 'the idle wait line')
      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(install clicked in the app, no audio\)/)
      assert.doesNotMatch(g.out(), /clear \(idle/)

      const calls = w.calls()
      const quitAt = calls.indexOf('osascript -e quit app id "com.jacobrosenbaum.jaketunes"')
      const dittoAt = calls.indexOf(`ditto ${w.stagedApp} ${w.incoming(g)}`)
      assert.ok(quitAt >= 0 && dittoAt > quitAt, `quit before copy:\n${calls}`)
      assert.match(calls, /^lsregister -f /m)
      assert.match(calls, /^open -a /m)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR, 'the staged build is installed')
      assert.equal(readFileSync(join(w.home, BK, 'Contents', 'Resources', 'app.asar'), 'utf8'), OLD_ASAR, 'the previous build is kept outside /Applications')
      assert.match(g.out(), /^TestMac: 6\.0\.0, app\.asar \d+ bytes, .+, pid 4242, previous kept at ~\/JakeTunes-prev-test\.app$/m)
      assert.ok(!existsSync(w.marker), 'update-ready.json removed on success')
      assert.ok(!existsSync(w.goFile), 'update-go removed on success')
    } finally { w.cleanup() }
  })

  it('a go-file for another sha is ignored and deleted; the right one still works after', async () => {
    const w = makeWorld({ idleS: 10, pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      w.writeGo('deadbeefcafe')
      await waitFor(() => /ignoring update-go for another build \(deadbeefcafe\) — removed/.test(g.out()), 'the ignore line')
      assert.ok(!existsSync(w.goFile), 'the foreign go-file is deleted')
      await sleep(400)
      assert.equal(g.child.exitCode, null, 'still waiting')
      assert.doesNotMatch(g.out(), /gate clear/)
      assert.ok(existsSync(w.marker), 'our marker is untouched')

      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(install clicked in the app, no audio\)/)
    } finally { w.cleanup() }
  })

  it('the audio hard stop still blocks with a go-file present ("Playing audio" assertion)', async () => {
    const w = makeWorld({ idleS: 10, audio: 'assertion', pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      w.writeGo(SHA)
      await waitFor(() => /waiting: playing audio/.test(g.out()), 'the audio block line')
      await sleep(700)
      assert.equal(g.child.exitCode, null, 'still waiting while audio plays')
      assert.doesNotMatch(g.out(), /gate clear/)
      assert.ok(existsSync(w.goFile), 'our own go-file is kept while we wait for the music to stop')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)

      w.setAudio('none')
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(install clicked in the app, no audio\)/)
      assert.ok(!existsSync(w.goFile) && !existsSync(w.marker))
    } finally { w.cleanup() }
  })

  it('the second audio signal (a coreaudiod stream owned by JakeTunes) blocks too', async () => {
    const w = makeWorld({ idleS: 10, audio: 'stream', pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      w.writeGo(SHA)
      await waitFor(() => /waiting: JakeTunes holds an audio stream/.test(g.out()), 'the stream block line')
      await sleep(400)
      assert.equal(g.child.exitCode, null)
      g.child.kill('SIGTERM')
      await finished(g)
      assert.ok(!existsSync(w.marker) && !existsSync(w.goFile), 'both markers gone after the kill')
    } finally { w.cleanup() }
  })

  it('markers are removed on ABORT — app.asar changed while waiting', async () => {
    const w = makeWorld({ idleS: 10, pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      // Another install landed mid-wait: the installed asar's mtime moves.
      const past = new Date(Date.now() - 3_600_000)
      utimesSync(w.installedAsar, past, past)
      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /ABORT: app\.asar changed while waiting \(another install\?\)/)
      assert.doesNotMatch(w.calls(), /^osascript /m, 'the app was not quit')
      assert.ok(!existsSync(w.marker) && !existsSync(w.goFile), 'both markers removed on abort')
    } finally { w.cleanup() }
  })

  it('markers are removed on ABORT — copy failed, the installed build never moved', async () => {
    const w = makeWorld({ idleS: 10, dittoFail: true, pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /COPY FAILED — the installed build was not touched/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'the previous build is still in place')
      assert.ok(!existsSync(join(w.home, BK)), 'nothing was moved aside')
      assert.ok(!existsSync(w.incoming(g)), 'no copy left behind')
      assert.match(w.calls(), /^open -a /m)
      assert.ok(!existsSync(w.marker) && !existsSync(w.goFile), 'both markers removed on abort')
    } finally { w.cleanup() }
  })

  it('markers are removed on timeout (exit 3, message unchanged)', async () => {
    const w = makeWorld({ idleS: 10, audio: 'assertion' })
    try {
      const g = w.run({ sha: SHA, maxMin: 0 })
      const r = await finished(g)
      assert.equal(r.code, 3)
      assert.match(g.out(), /ABORT: gate never cleared in 0 min — nothing changed/)
      assert.match(g.out(), /update-ready\.json written for/, 'the marker existed while it waited')
      assert.ok(!existsSync(w.marker), 'update-ready.json removed on timeout')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
    } finally { w.cleanup() }
  })
})

describe('install gate — the pre-protocol behaviour is unchanged', () => {
  it('idle ≥ 120 s with no audio still installs, with the same clear line', async () => {
    const w = makeWorld({ idleS: 130 })
    try {
      const g = w.run({ sha: SHA, note: NOTE })
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(idle 130s, no audio\)/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.ok(!existsSync(w.marker) && !existsSync(w.goFile))
    } finally { w.cleanup() }
  })

  it('called the old way (no sha) it writes no marker and behaves as before', async () => {
    const w = makeWorld({ idleS: 130 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /gate clear \(idle 130s, no audio\)/)
      assert.doesNotMatch(g.out(), /update-ready\.json written/)
      assert.ok(!existsSync(w.marker), 'no marker without a sha')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
    } finally { w.cleanup() }
  })

  it('a Mac without the app\'s data folder (dev machine) skips the markers and still installs', async () => {
    const w = makeWorld({ idleS: 130, dataDir: false })
    try {
      const g = w.run({ sha: SHA, note: NOTE })
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.doesNotMatch(g.out(), /update-ready\.json written|WARN/)
      assert.ok(!existsSync(join(w.home, 'Library')), 'nothing created under ~/Library')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
    } finally { w.cleanup() }
  })

  it('precondition ABORTs keep their messages and exit code 1, and never write a marker', async () => {
    const missing = makeWorld({ stagedMissing: true })
    try {
      const g = missing.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), new RegExp(`ABORT: no staged app at ${missing.stagedApp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      assert.ok(!existsSync(missing.marker))
    } finally { missing.cleanup() }

    const backup = makeWorld({ backupExists: true })
    try {
      const g = backup.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /ABORT: ~\/JakeTunes-prev-test\.app already exists/)
      assert.ok(!existsSync(backup.marker))
    } finally { backup.cleanup() }

    const unsigned = makeWorld({ codesignExit: 1 })
    try {
      const g = unsigned.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /ABORT: staged app signature invalid/)
      assert.ok(!existsSync(unsigned.marker))
      assert.equal(readFileSync(unsigned.installedAsar, 'utf8'), OLD_ASAR)
    } finally { unsigned.cleanup() }
  })
})

// 11/5: a quit took 21 minutes on one in-flight NAS write. The gate gave up after 30 s
// with "did not quit", and when the old process finally died nothing started the app.
describe('install gate — a slow quit never leaves the Mac with no app', () => {
  const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length

  // ?E is what a real process held in exit showed; UE is the same flag with another first letter.
  for (const state of ['?E', 'UE']) {
    it(`a process in state ${state} counts as quit: the install goes on, and the app starts only once the old pid is gone`, async () => {
      const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: state })
      try {
        const g = w.run({})
        await waitFor(() => /is exiting \(no code running\) — that counts as quit/.test(g.out()), 'the exiting line')
        await waitFor(() => w.calls().includes(`lsregister -f ${w.installedApp}`), 'the copy, with the old pid still there')
        assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
        await sleep(400)
        assert.equal(opens(w), 0, 'no open while the old process exists')
        w.oldGone()
        const r = await finished(g)
        assert.equal(r.code, 0, g.out())
        assert.equal(opens(w), 1)
        assert.doesNotMatch(w.calls(), /open-found-the-old-one/)
        assert.doesNotMatch(g.out(), /did not quit/)
        assert.match(g.out(), /, pid 5151, previous kept at/, 'the new process, never the dying one')
      } finally { w.cleanup() }
    })
  }

  it('a zombie has let go of everything: the app starts at once, whoever is slow to reap it', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: 'Z' })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(opens(w), 1)
      assert.doesNotMatch(g.out(), /did not quit|pending/)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  // A re-run of the gate, or an app killed by hand: pgrep can't see it, and open during
  // state E starts nothing. Measured, and the 11/6 retry script only missed it because its
  // build took 13 minutes.
  for (const state of ['?E', 'UE']) {
    it(`a process already in state ${state} when the install starts is waited for too`, async () => {
      const w = makeWorld({ idleS: 130, pids: '4242\n', oldState: state, goneWaitS: 1, watchS: 1 })
      try {
        const g = w.run({})
        const r = await finished(g)
        assert.equal(r.code, 0, g.out())
        assert.match(g.out(), /pid 4242 is exiting/)
        assert.match(g.out(), /, pid pending, /)
        assert.equal(opens(w), 0, 'no open into a process on its way out')
        await sleep(1600)
        w.oldGone()
        await waitFor(() => /5151/.test(w.pids()), 'the app starting')
        assert.doesNotMatch(w.calls(), /open-found-the-old-one/)
      } finally { w.cleanup() }
    })
  }

  for (const state of ['?E', 'UE']) {
    it(`a helper in state ${state} is not the app: nothing waits for it`, async () => {
      const w = makeWorld({ idleS: 130, pids: '', helperDying: state })
      try {
        const g = w.run({})
        const r = await finished(g)
        assert.equal(r.code, 0, g.out())
        assert.match(g.out(), /, pid 5151, previous kept at/)
      } finally { w.cleanup() }
    })
  }

  it('the old pid outlasts the wait: exit 0, "pid pending", and a watcher starts the app when it goes', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 20 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.match(g.out(), /, pid pending, it starts when the old process is gone, previous kept at/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR, 'the install is done')
      await sleep(400)
      assert.equal(opens(w), 0, 'still waiting on the old pid')
      w.oldGone()
      await waitFor(() => /5151/.test(w.pids()), 'the watcher starting the app')
      assert.equal(opens(w), 1)
      assert.doesNotMatch(w.calls(), /open-found-the-old-one/)
    } finally { w.cleanup() }
  })

  it('still alive after the wait: ABORT, install untouched, and when it does go the app comes back', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 20 })
    try {
      const g = w.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /ABORT: JakeTunes did not quit — install untouched/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.doesNotMatch(w.calls(), /^ditto /m)
      assert.ok(!existsSync(w.marker), 'markers removed on this abort too')
      await sleep(400)
      assert.equal(opens(w), 0, 'it is still alive: nothing to start')
      w.oldGone()
      await waitFor(() => /5151/.test(w.pids()), 'the app coming back')
      assert.equal(opens(w), 1)
    } finally { w.cleanup() }
  })

  it('…and if it plainly stays alive past the window, the watcher gives up: the app never quit, and a later quit by hand stays a quit', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      // Not a fixed sleep: 1800 ms failed 3 runs of 5 at load 40-90, with the watcher still on its way.
      await waitFor(() => !w.watcherAlive(), 'the watcher giving up')
      assert.equal(opens(w), 0)
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0, 'the watcher is gone')
    } finally { w.cleanup() }
  })

  it('…and with no bundle left to start, it ends without asking open', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 20 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      rmSync(w.installedApp, { recursive: true, force: true })
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  it('…and if something else started the app meanwhile, the watcher leaves it alone', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 20 })
    try {
      await finished(w.run({}))
      w.newApp()
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  it('killed after the quit was asked for: the app still comes back', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', watchS: 20 })
    try {
      const g = w.run({})
      await waitFor(() => /^osascript /m.test(w.calls()), 'the quit')
      g.child.kill('SIGTERM')
      const r = await finished(g)
      assert.equal(r.code, 143)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      w.oldGone()
      await waitFor(() => opens(w) === 1, 'the app coming back')
    } finally { w.cleanup() }
  })

  it('a TERM before the quit is asked for starts nothing: the app was never told to go', async () => {
    const w = makeWorld({ idleS: 10, pids: '4242\n', watchS: 3 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      g.child.kill('SIGTERM')
      await finished(g)
      w.oldGone()
      await sleep(500)
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  it('no app running at the start: nothing to wait for, it is simply started', async () => {
    const w = makeWorld({ idleS: 130, pids: '' })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(opens(w), 1)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  it('an ABORT after a quit with the old pid gone starts the app at once, as before', async () => {
    const w = makeWorld({ idleS: 130, dittoFail: true })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      assert.equal(opens(w), 1)
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06: the watcher gave up on a wall clock, and looked at the
// clock before it looked at the old process. The first install still quits the old build
// the old way (21 minutes on 11/5), and a closed lid uses up 30 minutes of date +%s
// without anything running. Each of these ended with no app and no one coming.
describe('install gate — the watcher does not give up on the clock', () => {
  const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length
  const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>

  it('the install is done and the old pid goes after the window: the app still starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      await sleep(1600)
      assert.equal(opens(w), 0, 'still waiting on the old pid')
      w.oldGone()
      await started(w)
      assert.doesNotMatch(w.calls(), /open-found-the-old-one/)
    } finally { w.cleanup() }
  })

  for (const state of ['?E', 'UE', 'U']) {
    it(`no install yet, and the old process turns ${state} in the window: it is on its way out, so the watcher stays past the window`, async () => {
      const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 1 })
      try {
        const r = await finished(w.run({}))
        assert.equal(r.code, 1)
        assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
        w.setOldState(state)
        await sleep(1600)
        w.oldGone()
        await started(w)
      } finally { w.cleanup() }
    })
  }

  it('the old process ends as a zombie nobody reaps: it has let go of everything, so the app starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      w.setOldState('Z')
      await started(w)
    } finally { w.cleanup() }
  })

  it('a jump in the wall clock uses up none of the window: the Mac asleep is not the app stuck', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 30 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      await sleep(500) // the watcher is under way: the jump lands inside its window
      w.clockJumps(3600)
      await sleep(600)
      assert.equal(opens(w), 0, 'it is still alive')
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('it looks once more after its last sleep, before it gives up', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 1, watchPollS: 3 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      await sleep(700)
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06: a failed open -a left "pid pending, it starts when the
// old process is gone" with the old process long gone and nothing coming, exit 0.
describe('install gate — open -a can say no', () => {
  const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length
  const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>

  it('it says no once: the gate tries again and reports the real pid', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openFails: 1 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(opens(w), 2)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  it('it keeps saying no: the last line says so, the exit is 4, the build stays, and the app still comes when open works', async () => {
    // A real-sized gap between the watcher's tries: at the fast poll its 10 tries are spent in 6 s,
    // which a busy Mac can use up before this test gets to say open works (load 600, 2026-11-06).
    const w = makeWorld({ idleS: 130, pids: '', openFails: 1000, watchS: 60, watchPollS: 1 })
    try {
      const g = w.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 4, g.out())
      assert.doesNotMatch(g.out(), /pid pending/)
      assert.match(g.out(), /, pid none, the app did not come up, still trying, previous kept at/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR, 'the install itself is done')
      assert.ok(!existsSync(w.marker), 'markers go on this exit too')
      assert.equal(w.pids(), '', 'nothing has started')
      w.openWorksNow()
      await started(w)
    } finally { w.cleanup() }
  })

  it('it says yes and nothing starts: the gate does not believe it, and tries again', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openSwallows: 1 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(opens(w), 2)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  it('it says yes three times and nothing starts: exit 4, and the watcher keeps asking', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openSwallows: 4, watchS: 30 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 4, g.out())
      assert.match(g.out(), /, pid none, the app did not come up, still trying, previous kept at/)
      await started(w)
      assert.equal(opens(w), 5)
    } finally { w.cleanup() }
  })

  it('the watcher\'s own open says no: it tries again', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30, openFails: 2 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      w.oldGone()
      await started(w)
      assert.equal(opens(w), 3)
    } finally { w.cleanup() }
  })

  it('the watcher\'s own open says yes and nothing starts: a live process is what ends it', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30, openSwallows: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      w.oldGone()
      await started(w)
      assert.equal(opens(w), 2)
    } finally { w.cleanup() }
  })

  it('…and it stops asking after a limited number of tries: an app that can\'t start must not throw up crash reports for ever', async () => {
    // 10 polls of watcher here, so one try of its own, after the gate's three.
    const w = makeWorld({ idleS: 130, pids: '', openFails: 100000, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 4)
      await waitFor(() => opens(w) >= 4, 'the watcher\'s try')
      await sleep(1500) // its next try would have been 0.6 s on
      assert.equal(opens(w), 4)
      assert.equal(w.pids(), '')
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06. Gate 1 gave up with "did not quit" and left its watcher, and a
// retry ran inside its window. In 2 of 20 phases the watcher reopened the old build in gate 2's
// look, so gate 2 said "did not quit" too. In 1 it did so just before the swap, and the gate called
// that process the new build. It also opened half copies, and it beat the recipe's retry.
describe('install gate — a retry retires the older watcher', () => {
  const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length
  const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>
  /** Gate 1 gives up on an app that won't quit, and leaves its watcher. */
  async function gaveUp(w: World): Promise<void> {
    const r = await finished(w.run({}))
    assert.equal(r.code, 1)
    await waitFor(() => w.watcherAlive(), 'gate 1\'s watcher')
  }

  it('it goes before the quit: when the old pid dies during the copy, it opens nothing', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 60 })
    try {
      await gaveUp(w)
      w.setQuitState('?E')
      w.copyHangs()
      const g = w.run({})
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'gate 2\'s copy')
      assert.ok(!w.watcherAlive(), 'gate 1\'s watcher is gone')
      assert.match(g.out(), /retired an older install's watcher/)
      const calls = w.calls()
      assert.ok(calls.lastIndexOf('pkill ') < calls.lastIndexOf('osascript '), `retired before the quit:\n${calls}`)
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0, 'nobody opened anything while the copy ran')
      w.termGateAndCopy(g)
      assert.equal((await finished(g)).code, 143)
      await started(w)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
    } finally { w.cleanup() }
  })

  it('a retry that installs ends with the new build and one open', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 60 })
    try {
      await gaveUp(w)
      w.setQuitState('Z')
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.equal(opens(w), 1)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  // Its pid is gone and it hasn't looked yet, so OLD_PIDS comes up empty: only that watcher knew.
  it('it owed the app, so the retry does now: killed right after, the app still comes', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 60, watchPollS: 90 })
    try {
      await gaveUp(w)
      await waitFor(() => w.watcherAsleep(), 'gate 1\'s watcher to look once and sleep')
      w.oldGone()
      w.copyHangs()
      const g = w.run({})
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'gate 2\'s copy')
      assert.ok(!w.watcherAlive(), 'gate 1\'s watcher is gone')
      assert.equal(opens(w), 0, 'it never got to look again')
      w.termGateAndCopy(g)
      assert.equal((await finished(g)).code, 143)
      await started(w)
    } finally { w.cleanup() }
  })

  it('with no older watcher it owes nothing it did not owe before', async () => {
    const w = makeWorld({ idleS: 130, pids: '', dittoHang: 'nothing', watchS: 2 })
    try {
      const g = w.run({})
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'the copy')
      assert.doesNotMatch(g.out(), /retired an older/)
      w.termGateAndCopy(g)
      await finished(g)
      await sleep(400)
      assert.equal(opens(w), 0, 'no app was running and none was due')
    } finally { w.cleanup() }
  })

  it('the watcher is really called that: a real pgrep finds it, and the gate looks for that shape', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 20 })
    try {
      await gaveUp(w)
      const src = readFileSync(scriptPath, 'utf8')
      assert.match(src, /pkill -f 'jt-gate-watcher \[0-9\]'/)
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06. The copy went straight into /Applications, and in a bundle's
// order the executable lands long before Info.plist (line 5 of 298 in ditto -V). A watcher's open,
// a Dock click or the sync on homemini could start half a build (2 of 20 phases on the fakes), and
// a SIGKILL or a power cut left it there with nothing to repair it.
describe('install gate — copy first, swap second', () => {
  const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length

  it('while the copy runs, the path holds the whole old build, and the half copy sits under a hidden name', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', dittoHang: 'partial', watchS: 30 })
    try {
      const g = w.run({})
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'the copy')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(join(w.installedApp, 'Contents', 'half-written')))
      assert.ok(existsSync(join(w.incoming(g), 'Contents', 'half-written')))
      assert.ok(!existsSync(join(w.home, BK)), 'nothing has moved yet')
      w.termGateAndCopy(g)
      await finished(g)
    } finally { w.cleanup() }
  })

  it('in order: copy, check the copy, old build aside, copy into place, tell LaunchServices, start', async () => {
    const w = makeWorld({ idleS: 130, pids: '' })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      const incoming = w.incoming(g)
      const calls = w.calls().split('\n')
      const at = (line: string): number => {
        const i = calls.indexOf(line)
        assert.ok(i >= 0, `${line}\nnot in:\n${calls.join('\n')}`)
        return i
      }
      const steps = [
        `ditto ${w.stagedApp} ${incoming}`,
        `xattr -dr com.apple.quarantine ${incoming}`,
        `codesign --verify --deep --strict ${incoming}`,
        `mv ${w.installedApp} ${join(w.home, BK)}`,
        `mv ${incoming} ${w.installedApp}`,
        `lsregister -f ${w.installedApp}`,
        `open -a ${w.installedApp}`,
      ].map(at)
      assert.deepEqual(steps, [...steps].sort((a, b) => a - b), calls.join('\n'))
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.equal(readFileSync(join(w.home, BK, 'Contents', 'Resources', 'app.asar'), 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(incoming), 'nothing left at the hidden name')
    } finally { w.cleanup() }
  })

  it('the copy fails its signature check: the install stops there, and the old build starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '', codesignExitCopy: 1 })
    try {
      const g = w.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 1, g.out())
      assert.match(g.out(), /ABORT: the copy failed its signature check — the installed build was not touched/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(join(w.home, BK)), 'nothing was moved aside')
      assert.ok(!existsSync(w.incoming(g)), 'the bad copy is gone')
      assert.equal(opens(w), 1)
      assert.ok(!existsSync(w.marker), 'markers go on this exit too')
    } finally { w.cleanup() }
  })

  it('the rename of the copy into place fails: the previous build goes back, and it is what starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '', mvIn: 'fails' })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 1, g.out())
      assert.match(g.out(), /COPY FAILED — restoring the previous build/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(join(w.home, BK)), 'the backup moved back')
      assert.ok(!existsSync(w.incoming(g)), 'the copy is gone')
      assert.equal(opens(w), 1)
    } finally { w.cleanup() }
  })

  // The sync on homemini (pgrep || open -g) or a Dock click. The swap would leave that app running
  // from ~/<backup>, and the gate would call it the new build.
  it('something starts the app while the copy runs: the install stops, the bundle stays, and nothing else is started', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: 'Z', dittoStartsApp: true })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 1, g.out())
      assert.match(g.out(), /ABORT: JakeTunes started again during the copy — install untouched/)
      assert.doesNotMatch(g.out(), /the app starts by itself/, 'there is one running: nothing is owed')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(join(w.home, BK)), 'nothing was moved aside')
      assert.ok(!existsSync(w.incoming(g)), 'the copy is gone')
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  it('a copy a killed gate left behind is removed; one whose gate is alive is not', async () => {
    const w = makeWorld({ idleS: 130, pids: '' })
    try {
      const dead = join(w.home, '.jt-incoming-99999.app')
      const alive = join(w.home, `.jt-incoming-${process.pid}.app`)
      mkdirSync(join(dead, 'Contents'), { recursive: true })
      mkdirSync(join(alive, 'Contents'), { recursive: true })
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.ok(!existsSync(dead), 'no gate 99999 here, so nobody is coming back for it')
      assert.ok(existsSync(alive), 'another install is using this one')
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06. With its reader gone (a client that exits, a pipeline killed
// with it) the gate's next echo got SIGPIPE. Bash ran the EXIT trap, and the trap's own first echo
// died the same way, before it restored anything or left the watcher. Each of these ended at
// rc 141, with no app.
describe('install gate — nobody left to read its output', () => {
  const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>

  it('gone during the quit, with the old process in E past the wait: the build goes in, and the watcher still starts the app', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30, quitHold: true })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => /^osascript /m.test(w.calls()), 'the quit')
      await g.readerGone()
      w.quitDone()
      const r = await finished(g)
      assert.equal(r.code, 0)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.ok(!existsSync(w.marker), 'markers go on this exit too')
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('gone during the quit, and the copy fails: the old build stays, and it is what starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30, quitHold: true, dittoFail: true })
    try {
      const g = w.run({})
      await waitFor(() => /^osascript /m.test(w.calls()), 'the quit')
      await g.readerGone()
      w.quitDone()
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('gone, then killed during the copy: the old build is whole, and it is what starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', dittoHang: 'partial', watchS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'the copy')
      await g.readerGone()
      w.termGateAndCopy(g)
      const r = await finished(g)
      assert.equal(r.code, 143)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
      assert.ok(!existsSync(join(w.installedApp, 'Contents', 'half-written')), 'none of the half copy is left')
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('gone while it waits: nothing is owed yet, and the install still goes ahead when the gate clears', async () => {
    const w = makeWorld({ idleS: 10, pids: '4242\n', quitState: 'Z' })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => /waiting: in use 10s ago/.test(g.out()), 'the idle wait line')
      await g.readerGone()
      w.setIdle(130)
      const r = await finished(g)
      assert.equal(r.code, 0)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      await started(w)
    } finally { w.cleanup() }
  })
})

// Found by the reviewer, in the same promise: a TERM mid-copy skipped the restore, and the
// watcher then opened half a bundle, or found no bundle at all.
describe('install gate — killed during the swap', () => {
  const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>

  for (const hang of ['partial', 'nothing'] as const) {
    it(`killed with ${hang === 'partial' ? 'half the bundle' : 'nothing'} copied: the installed build never moved, and that is what starts`, async () => {
      const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', dittoHang: hang, watchS: 30 })
      try {
        const g = w.run({ sha: SHA })
        await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'the copy')
        w.termGateAndCopy(g)
        const r = await finished(g)
        assert.equal(r.code, 143)
        assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'the previous build is in place')
        assert.ok(!existsSync(join(w.installedApp, 'Contents', 'half-written')), 'none of the half copy is there')
        assert.ok(!existsSync(w.incoming(g)), 'the half copy is gone')
        assert.ok(!existsSync(join(w.home, BK)), 'nothing was moved aside')
        assert.ok(!existsSync(w.marker), 'markers go on this exit too')
        w.oldGone()
        await started(w)
      } finally { w.cleanup() }
    })
  }

  it('killed between the two renames, with nothing at the path: the previous build goes back, and that is what starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', mvIn: 'hangs', watchS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(join(w.fake, 'ditto_pid')), 'the rename of the copy into place')
      assert.ok(!existsSync(w.installedAsar), 'the old bundle is aside')
      w.termGateAndCopy(g)
      const r = await finished(g)
      assert.equal(r.code, 143)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'the previous build is back in place')
      assert.ok(!existsSync(join(w.home, BK)), 'the backup moved back')
      assert.ok(!existsSync(w.incoming(g)), 'the copy is gone')
      assert.match(w.calls(), new RegExp(`^lsregister -f ${w.installedApp}$`, 'm'))
      assert.ok(!existsSync(w.marker), 'markers go on this exit too')
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('killed after the copy finished, waiting on the old pid: the new build stays, and it is what starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', watchS: 1 })
    try {
      const g = w.run({})
      await waitFor(() => w.calls().includes(`lsregister -f ${w.installedApp}`), 'the copy')
      g.child.kill('SIGTERM')
      const r = await finished(g)
      assert.equal(r.code, 143)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
      assert.ok(existsSync(join(w.home, BK)), 'the previous build stays kept')
      await sleep(1600)
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })
})
