/**
 * The install gate after the quit is asked for: the Mac is never left with no app. Runs the
 * shipped script in a temp world: install-gate-world.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { finished, makeWorld, NEW_ASAR, OLD_ASAR, opens, SHA, sleep, started } from './install-gate-world.ts'
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
