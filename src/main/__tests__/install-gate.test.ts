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
 *    and within the 2 s cadence; a go-file for another sha is ignored and
 *    deleted; the audio hard stop still blocks with a go-file present
 *  - both markers are removed on success, on every ABORT, on timeout and
 *    on a TERM kill
 *  - the pre-protocol behaviour is unchanged: messages, exit codes, the
 *    idle path, the no-sha call, the dev-machine (no data folder) call
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'install', 'jaketunes-install-gate.sh')
const DATA_REL = join('Library', 'Application Support', 'JakeTunes')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const NOTE = 'Album page "D" + back pill'
const BK = 'JakeTunes-prev-test.app'
const OLD_ASAR = 'old build asar bytes'
const NEW_ASAR = 'new build asar bytes — longer'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (cond()) return
    await sleep(25)
  }
  assert.fail(`timed out waiting for ${what}`)
}

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
[ -e "$JT_FAKE/refuse_quit" ] || rm -f "$JT_FAKE/running"
exit 0
`,
  pgrep: `#!/bin/bash
echo "pgrep $*" >> "$JT_FAKE/calls.log"
if [ -e "$JT_FAKE/running" ]; then echo 4242; exit 0; fi
exit 1
`,
  ps: `#!/bin/bash
pid=""
while [ $# -gt 0 ]; do case "$1" in -p) pid="$2"; shift ;; esac; shift; done
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
  open: `#!/bin/bash
echo "open $*" >> "$JT_FAKE/calls.log"
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
  const bin = join(root, 'bin')
  mkdirSync(home, { recursive: true })
  if (o.dataDir !== false) mkdirSync(dataDir, { recursive: true })
  mkdirSync(fake)
  mkdirSync(bin)
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(fake, 'assertions'), ASSERTIONS[o.audio ?? 'none'])
  writeFileSync(join(fake, 'idle_ns'), String((o.idleS ?? 10) * 1_000_000_000))
  writeFileSync(join(fake, 'ps_4242'), 'JakeTunes\n')
  writeFileSync(join(fake, 'running'), '')
  writeFileSync(join(fake, 'calls.log'), '')
  if (o.codesignExit) writeFileSync(join(fake, 'codesign_exit'), String(o.codesignExit))
  if (o.dittoFail) writeFileSync(join(fake, 'ditto_fail'), '')

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
    // One minute, not the script's 45: a gate that never clears is a failed
    // test in 60 s, not a 45-minute CI wall (2026-10-30).
    run: ({ sha, note, maxMin = 1 }) => {
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
    cleanup: () => {
      for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function readMarker(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

async function finished(g: Gate, timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // The timer is cleared on exit — a live 15 s timer would keep the test
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
      const g = w.run({ sha: SHA, note: NOTE })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      const m = readMarker(w.marker)
      assert.equal(m['v'], 1)
      assert.equal(m['sha'], SHA)
      assert.equal(m['version'], '6.0.0', 'version comes from the STAGED app\'s Info.plist')
      assert.equal(m['note'], NOTE, 'the note survives JSON escaping of its quotes')
      assert.equal(m['gatePid'], g.child.pid)
      assert.ok(Math.abs(Date.parse(String(m['stagedAt'])) - Date.now()) < 60_000, `stagedAt is now-ish: ${String(m['stagedAt'])}`)
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

  it('a go-file with OUR sha clears the gate without idle, at the 2 s cadence, and installs; both markers are removed', async () => {
    // Heavy checks every 30 s: only the go-file path can clear this in time.
    const w = makeWorld({ idleS: 10, pollS: 30 })
    try {
      const g = w.run({ sha: SHA, note: NOTE })
      await waitFor(() => existsSync(w.marker), 'update-ready.json')
      await waitFor(() => /waiting: in use 10s ago/.test(g.out()), 'the idle wait line')
      const t0 = Date.now()
      w.writeGo(SHA)
      const r = await finished(g)
      const took = Date.now() - t0
      assert.equal(r.code, 0, g.out())
      assert.ok(took < 8_000, `cleared ${took} ms after the go-file — the 2 s check, not the 15 s one`)
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
