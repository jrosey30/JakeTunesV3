/**
 * The install gate, run for real (2026-10-30). The world its tests run in.
 *
 * scripts/install/jaketunes-install-gate.sh is the script that swaps
 * /Applications/JakeTunes.app on both Macs once nothing is playing and the
 * keyboard has been idle for 120 s. This harness runs the shipped script
 * under a temp HOME with every Mac-only tool faked on PATH (pmset, ioreg,
 * osascript, pgrep, pkill, codesign, ditto, mv, open, xattr, stat, date, caffeinate,
 * scutil, ps, PlistBuddy, lsregister) and the real /usr/bin:/bin for the rest — the
 * same shape as the sync-script and cache-manager harnesses. The install
 * target is a fake app bundle inside the temp dir (JT_GATE_APP), never the
 * real one.
 *
 * Three test files, because `npm test` caps each file at 300 s: at load 600 this suite ran at
 * 4 s a test and the cap stopped it partway (2026-11-06).
 */
import { after } from 'node:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HUNG_MS, waitFor } from './wait-for.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
export const scriptPath = join(repoRoot, 'scripts', 'install', 'jaketunes-install-gate.sh')
const DATA_REL = join('Library', 'Application Support', 'JakeTunes')
export const SHA = '0123456789abcdef0123456789abcdef01234567'
export const NOTE = 'Album page "D" + back pill'
export const BK = 'JakeTunes-prev-test.app'
export const OLD_ASAR = 'old build asar bytes'
export const NEW_ASAR = 'new build asar bytes — longer'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  // looks_left: how many more looks the app just started lasts. Then it has died.
  pgrep: `#!/bin/bash
echo "pgrep $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/looks_left" ]; then
  n=$(cat "$JT_FAKE/looks_left")
  if [ "$n" -le 0 ]; then
    grep -vx 5151 "$JT_FAKE/pids" > "$JT_FAKE/pids.died"; /bin/mv -f "$JT_FAKE/pids.died" "$JT_FAKE/pids"
    rm -f "$JT_FAKE/looks_left"
  else
    echo $((n - 1)) > "$JT_FAKE/looks_left"
  fi
fi
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
  // open_hangs: how many more times open never comes back.
  // open_short_lived: how many more times what starts is alive for one look and then gone.
  open: `#!/bin/bash
echo "open $*" >> "$JT_FAKE/calls.log"
countdown() {
  [ -e "$JT_FAKE/$1" ] || return 1
  n=$(cat "$JT_FAKE/$1")
  [ "$n" -gt 0 ] || return 1
  echo $((n - 1)) > "$JT_FAKE/$1.tmp"; mv -f "$JT_FAKE/$1.tmp" "$JT_FAKE/$1"
}
countdown open_hangs && exec sleep 40
[ -e "$JT_FAKE/open_works" ] || { countdown open_fails && exit 1; }
countdown open_swallows && exit 0
if [ -e "$JT_FAKE/pids" ]; then
  if grep -qx 4242 "$JT_FAKE/pids"; then
    case "$(cat "$JT_FAKE/state_4242" 2>/dev/null || echo S)" in
      *Z*) ;;
      *) echo "open-found-the-old-one" >> "$JT_FAKE/calls.log"; exit 0 ;;
    esac
  fi
  countdown open_short_lived && echo 1 > "$JT_FAKE/looks_left"
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
[ -e "$JT_FAKE/lsreg_hangs" ] && exec sleep 40
exit 0
`,
}

// One folder of fakes for each test file, not one per test. Their state lives in
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
  // A real Electron blocker, measured 2026-11-06 on a scratch app with its name changed.
  sync: `Assertions status system-wide:
   PreventUserIdleDisplaySleep      1
Listed by owning process:
   pid 4242(JakeTunes): [0x003321b9000592c6] 00:11:00 NoDisplaySleepAssertion named: "Electron"
`,
  // What the app holds every day, and it mustn't look like a sync.
  everyday: `Assertions status system-wide:
   PreventUserIdleSystemSleep       1
Listed by owning process:
   pid 4242(JakeTunes): [0x003321b900059200] 00:11:00 NoIdleSleepAssertion named: "Electron"
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
  /** lsregister never comes back. */
  lsregHangs?: boolean
  /** How many times open never comes back. */
  openHangs?: number
  /** How many times what open starts lasts one look and dies. */
  openShortLived?: number
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

export interface World {
  root: string
  home: string
  dataDir: string
  marker: string
  goFile: string
  installedApp: string
  installedAsar: string
  stagedApp: string
  fake: string
  /** Where the watcher writes a give-up. */
  watcherLog: string
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

export interface Gate {
  child: ChildProcess
  out: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Whatever read the gate's output has gone: its next write has no one to go to. */
  readerGone: () => Promise<void>
}

export function makeWorld(o: WorldOpts = {}): World {
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
  if (o.lsregHangs) writeFileSync(join(fake, 'lsreg_hangs'), '')
  if (o.openHangs !== undefined) writeFileSync(join(fake, 'open_hangs'), String(o.openHangs))
  if (o.openShortLived !== undefined) writeFileSync(join(fake, 'open_short_lived'), String(o.openShortLived))
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
    watcherLog: join(home, 'Library', 'Logs', 'jaketunes-install-gate.log'),
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
    // Its own file, not a write to the fake open's count. Sharing a temp name gave ENOENT (load 37),
    // and with two names an open mid-countdown wrote 999 back over this 0, so the watcher spent its
    // tries on a "no" (load 300, 2026-11-06).
    openWorksNow: () => writeFileSync(join(fake, 'open_works'), ''),
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
          JT_GATE_STAY_S: '0.1',
          JT_GATE_LS_LIMIT_S: '1',
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

export function readMarker(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export async function finished(g: Gate, timeoutMs = HUNG_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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

export const opens = (w: World): number => (w.calls().match(/^open -a /gm) ?? []).length
export const started = (w: World): Promise<true> => waitFor(() => /5151/.test(w.pids()) || null, 'the app starting') as Promise<true>
