/**
 * The install gate's protocol with the app, and what it always did (2026-10-30). Runs the shipped
 * script in a temp world: install-gate-world.ts. What these prove:
 *  - the "update ready" protocol: update-ready.json is written the moment
 *    the wait begins; update-go with OUR sha clears the gate without idle
 *    and with no heavy check due; a go-file for another sha is ignored and
 *    deleted; the audio hard stop still blocks with a go-file present
 *  - both markers are removed on success, on every ABORT, on timeout and
 *    on a TERM kill
 *  - the pre-protocol behaviour is unchanged: messages, exit codes, the
 *    idle path, the no-sha call, the dev-machine (no data folder) call
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { BK, finished, makeWorld, NEW_ASAR, NOTE, OLD_ASAR, readMarker, SHA, sleep } from './install-gate-world.ts'
import { waitFor } from './wait-for.ts'

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

  // Reviewer's finding, 2026-11-06. Nothing stopped a quit during an iPod sync: a 1000-song Activity
  // Sync takes 25 minutes, and with no audio and 2 minutes idle the gate quit the app mid-copy.
  it('an iPod sync blocks the install, with or without a click on Install, and it goes ahead when the sync is done', async () => {
    const w = makeWorld({ idleS: 130, audio: 'sync', pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      await waitFor(() => /waiting: an iPod sync is running/.test(g.out()), 'the sync block line')
      w.writeGo(SHA)
      await sleep(700)
      assert.equal(g.child.exitCode, null, 'still waiting while the sync runs')
      assert.doesNotMatch(w.calls(), /osascript/)
      assert.equal(readFileSync(w.installedAsar, 'utf8'), OLD_ASAR)

      w.setAudio('none')
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.equal(readFileSync(w.installedAsar, 'utf8'), NEW_ASAR)
    } finally { w.cleanup() }
  })

  it('what the app holds every day isn\'t a sync: no wait', async () => {
    const w = makeWorld({ idleS: 130, audio: 'everyday', pollS: 30 })
    try {
      const g = w.run({ sha: SHA })
      const r = await finished(g)
      assert.equal(r.code, 0, g.out())
      assert.doesNotMatch(g.out(), /iPod sync/)
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
