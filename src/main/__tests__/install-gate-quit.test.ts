/**
 * The install gate after the quit is asked for: the Mac is never left with no app. Runs the
 * shipped script in a temp world: install-gate-world.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finished, makeWorld, NEW_ASAR, OLD_ASAR, opens, scriptPath, SHA, sleep, started, watcherEnded } from './install-gate-world.ts'
import { waitFor } from './wait-for.ts'

// 11/5: a quit took 21 minutes on one in-flight NAS write. The gate gave up after 30 s
// with "did not quit", and when the old process finally died nothing started the app.
describe('install gate — a slow quit never leaves the Mac with no app', () => {

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
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 120 })
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
      await watcherEnded(w)
      assert.equal(opens(w), 0)
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0, 'the watcher is gone')
    } finally { w.cleanup() }
  })

  it('…and with no bundle left to start, it ends without asking open', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 120 })
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
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 120 })
    try {
      await finished(w.run({}))
      w.newApp()
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  it('killed after the quit was asked for: the app still comes back', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', watchS: 120 })
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
      // On a clock the test moves: with a real 1 s window, a busy Mac used it up before the state changed.
      const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 30 })
      try {
        const r = await finished(w.run({}))
        assert.equal(r.code, 1)
        assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)
        w.setOldState(state)
        w.clockJumps(3600)
        await sleep(600)
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

  // Reviewer's finding, 2026-11-06. The window counted time awake, so a lid shut across days could
  // bring the app back after a quit by hand the next day.
  it('plainly alive once the wall clock has passed the window, however little of it was awake: it stops, and a later quit stays a quit', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 30 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      await waitFor(() => w.watcherAlive() || null, 'the watcher')
      w.clockJumps(3600)
      await waitFor(() => !w.watcherAlive(), 'the watcher stopping')
      w.oldGone()
      await sleep(600)
      assert.equal(opens(w), 0)
    } finally { w.cleanup() }
  })

  for (const state of ['?E', 'U']) {
    it(`in ${state} when the Mac wakes past the window: the wall clock doesn't apply, the app is owed`, async () => {
      const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 30 })
      try {
        const r = await finished(w.run({}))
        assert.equal(r.code, 1)
        w.setOldState(state)
        await sleep(300) // it has looked at the new state
        w.clockJumps(3600)
        await sleep(600)
        assert.ok(w.watcherAlive(), 'still waiting')
        w.oldGone()
        await started(w)
      } finally { w.cleanup() }
    })
  }

  it('the old pid already gone when the Mac wakes: the jump changes nothing, the app starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      w.clockJumps(3600)
      w.oldGone()
      await started(w)
    } finally { w.cleanup() }
  })

  it('it looks once more after its last sleep, before it gives up', async () => {
    // On a clock the test moves: with a real 1 s window a busy Mac could pass it on the first look.
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 30, watchPollS: 3 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      w.oldGone()
      w.clockJumps(3600)
      await started(w)
    } finally { w.cleanup() }
  })
})

// Reviewer's finding, 2026-11-06: a failed open -a left "pid pending, it starts when the
// old process is gone" with the old process long gone and nothing coming, exit 0.
describe('install gate — open -a can say no', () => {

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

  // Reviewer's finding, 2026-11-06. One live look was "started": a build that dies seconds in got
  // exit 0 and "pid 5151". install-both runs its legs in parallel, so a bad build could reach all
  // three Macs with every report saying fine.
  it('what it starts dies right away: not started, it tries again, and reports the one that stayed', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openShortLived: 1 })
    try {
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(opens(w), 2)
      assert.match(g.out(), /, pid 5151, previous kept at/)
    } finally { w.cleanup() }
  })

  it('what it starts keeps dying: exit 4 and "pid none", where it used to say installed, and the watcher keeps asking', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openShortLived: 3, watchS: 60, watchPollS: 0.5 })
    try {
      const g = w.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 4, g.out())
      assert.match(g.out(), /, pid none, the app did not come up, still trying, previous kept at/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR, 'the build stays: no automatic rollback')
      await started(w)
      assert.equal(opens(w), 4, 'the gate\'s three, then the watcher\'s')
    } finally { w.cleanup() }
  })

  it('it waits 5 s before the second look, the time a bad build takes to die', () => {
    assert.match(readFileSync(scriptPath, 'utf8'), /STAY="\$\{JT_GATE_STAY_S:-5\}"/)
  })

  // Reviewer's finding, 2026-11-06. The watcher's output goes to /dev/null and the gate has gone,
  // so when it stopped asking, nobody was told there was no app.
  it('the watcher runs out of tries: it says NO APP RUNNING in a log, because nobody else is left to', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openSwallows: 99, watchS: 1, watchPollS: 0.1 })
    try {
      const r = await finished(w.run({ sha: SHA }))
      assert.equal(r.code, 4)
      await watcherEnded(w)
      assert.match(readFileSync(w.watcherLog, 'utf8'), /NO APP RUNNING: 1 tries of open -a .*JakeTunes\.app/)
    } finally { w.cleanup() }
  })

  it('the watcher stops on an app that never quit: that goes in the log too, as nothing to do', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitWaitS: 1, watchS: 1 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 1)
      await watcherEnded(w)
      const log = readFileSync(w.watcherLog, 'utf8')
      assert.match(log, /pids 4242: still plainly alive after 1s/)
      assert.doesNotMatch(log, /NO APP RUNNING/)
    } finally { w.cleanup() }
  })

  it('a watcher that starts the app says nothing in the log', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30 })
    try {
      await finished(w.run({}))
      w.oldGone()
      await started(w)
      await waitFor(() => !w.watcherAlive(), 'the watcher stopping')
      assert.equal(existsSync(w.watcherLog), false)
    } finally { w.cleanup() }
  })

  // Reviewer's finding, 2026-11-06. The gate's caffeinate ends with the gate, and a Mini with its
  // display asleep could sleep with no app and be off the network until someone touched it.
  it('the watcher holds the Mac awake for itself, for as long as it runs', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30 })
    try {
      await finished(w.run({}))
      await waitFor(() => /caffeinate -i -w \d+/.test(w.calls()) || null, 'the watcher\'s caffeinate')
      const pid = w.calls().match(/caffeinate -i -w (\d+)/)![1]
      assert.equal(execFileSync('/bin/ps', ['-o', 'state=', '-p', pid]).toString().trim().length > 0, true, 'it follows a live pid')
      assert.match(execFileSync('/bin/ps', ['-o', 'command=', '-p', pid]).toString(), /jt-gate-watcher [0-9]/, 'that pid is the watcher')
    } finally { w.cleanup() }
  })

  // Reviewer's finding, 2026-11-06. If LaunchServices stalls, the gate hangs before its last line,
  // and an ssh leg sits until its 3-hour limit.
  it('open never comes back: an alarm ends it, and the next try starts the app', async () => {
    const w = makeWorld({ idleS: 130, pids: '', openHangs: 1, lsLimitS: 5 })
    try {
      const began = Date.now()
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.ok(Date.now() - began < 200_000, 'the fake open sleeps 600 s')
      assert.ok(opens(w) >= 2)
    } finally { w.cleanup() }
  })

  it('lsregister never comes back: an alarm ends it, and the app still starts', async () => {
    const w = makeWorld({ idleS: 130, pids: '', lsregHangs: true, lsLimitS: 5 })
    try {
      const began = Date.now()
      const g = w.run({})
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.ok(Date.now() - began < 200_000, 'the fake lsregister sleeps 600 s')
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
    } finally { w.cleanup() }
  })

  it('open never comes back for the watcher either', async () => {
    const w = makeWorld({ idleS: 130, pids: '4242\n', quitState: '?E', goneWaitS: 1, watchS: 30, watchPollS: 0.1, lsLimitS: 5 })
    try {
      const r = await finished(w.run({}))
      assert.equal(r.code, 0)
      writeFileSync(join(w.fake, 'open_hangs'), '1')
      w.oldGone()
      const began = Date.now()
      await started(w)
      assert.ok(Date.now() - began < 200_000, 'the fake open sleeps 600 s')
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
