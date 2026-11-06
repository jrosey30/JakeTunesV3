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
  osascript: `#!/bin/bash
echo "osascript $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/pids" ]; then
  # The process table world: quit_state says what the old process turns into.
  [ -e "$JT_FAKE/quit_state" ] && cp "$JT_FAKE/quit_state" "$JT_FAKE/state_4242"
  exit 0
fi
[ -e "$JT_FAKE/refuse_quit" ] || rm -f "$JT_FAKE/running"
exit 0
`,
  pgrep: `#!/bin/bash
echo "pgrep $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/pids" ]; then
  [ -s "$JT_FAKE/pids" ] || exit 1
  cat "$JT_FAKE/pids"
  exit 0
fi
if [ -e "$JT_FAKE/running" ]; then echo 4242; exit 0; fi
exit 1
`,
  ps: `#!/bin/bash
pid=""; fmt=""
while [ $# -gt 0 ]; do case "$1" in -p) pid="$2"; shift ;; -o) fmt="$2"; shift ;; esac; shift; done
if [ "$fmt" = "state=" ]; then cat "$JT_FAKE/state_$pid" 2>/dev/null || echo "S"; exit 0; fi
cat "$JT_FAKE/ps_$pid" 2>/dev/null
exit 0
`,
  codesign: `#!/bin/bash
echo "codesign $*" >> "$JT_FAKE/calls.log"
exit "$(cat "$JT_FAKE/codesign_exit" 2>/dev/null || echo 0)"
`,
  ditto: `#!/bin/bash
echo "ditto $*" >> "$JT_FAKE/calls.log"
[ -e "$JT_FAKE/ditto_fail" ] && exit 1
cp -R "$1" "$2"
`,
  // With the old process still there, open finds it and starts nothing: the case the
  // gate has to wait out (the old instance holds LaunchServices and the single-instance lock).
  open: `#!/bin/bash
echo "open $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/pids" ]; then
  if grep -q '^4242$' "$JT_FAKE/pids"; then echo "open-found-the-old-one" >> "$JT_FAKE/calls.log"; exit 0; fi
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
  run: (args: { sha?: string; note?: string; maxMin?: number }) => Gate
  cleanup: () => void
}

interface Gate {
  child: ChildProcess
  out: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
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
          JT_GATE_WATCH_POLL_S: '0.1',
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
      return { child, out: () => out, exited }
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
      const dittoAt = calls.indexOf(`ditto ${w.stagedApp} ${w.installedApp}`)
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

  it('markers are removed on ABORT — copy failed, previous build restored', async () => {
    const w = makeWorld({ idleS: 10, dittoFail: true, pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      w.writeGo(SHA)
      const r = await finished(g)
      assert.equal(r.code, 1)
      assert.match(g.out(), /COPY FAILED — restoring the previous build/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR, 'the previous build is back in place')
      assert.ok(!existsSync(join(w.home, BK)), 'the backup moved back')
      assert.match(w.calls(), /^lsregister -f /m)
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

  for (const [name, state] of [['trying to exit (E)', 'UE'], ['a zombie (Z)', 'Z']] as const) {
    it(`a process ${name} counts as quit: the install goes on, and the app starts only once the old pid is gone`, async () => {
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

  it('the old pid outlasts the wait: exit 0, "pid pending", and a watcher starts the app when it goes', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: 'UE', goneWaitS: 1, watchS: 20 })
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

  it('…and if it never goes, the watcher gives up and starts nothing', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      await sleep(1800)
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
