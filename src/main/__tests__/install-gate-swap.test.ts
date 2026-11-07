/**
 * The install gate at the swap: an older watcher, the copy, a reader that goes away, a kill. Runs
 * the shipped script in a temp world: install-gate-world.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BK, finished, makeWorld, NEW_ASAR, OLD_ASAR, opens, scriptPath, SHA, sleep, started, type World } from './install-gate-world.ts'
import { waitFor } from './wait-for.ts'

// Reviewer's finding, 2026-11-06. Gate 1 gave up with "did not quit" and left its watcher, and a
// retry ran inside its window. In 2 of 20 phases the watcher reopened the old build in gate 2's
// look, so gate 2 said "did not quit" too. In 1 it did so just before the swap, and the gate called
// that process the new build. It also opened half copies, and it beat the recipe's retry.
describe('install gate — a retry retires the older watcher', () => {
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
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 120 })
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
