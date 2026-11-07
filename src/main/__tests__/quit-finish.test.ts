/**
 * How the app leaves (2026-11-06). The flushes come first because a hard kill skips
 * Chromium's own commit, everything is bounded because a flush that never settles is
 * what this exists to outlast, and the kill itself is run for real against a
 * thread-pool thread that will never come back.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQuitFinish, leaveFor, QUIT_BOUND_MS, QUIT_GRACE_MS } from '../quit-finish.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function harness(over: Partial<Parameters<typeof createQuitFinish>[0]> = {}) {
  const events: string[] = []
  const logs: string[] = []
  let run: () => void = () => {}
  const left = new Promise<void>((resolve) => {
    run = createQuitFinish({
      flushStorage: () => { events.push('storage') },
      flushCookies: async () => { events.push('cookies') },
      librarySaved: async () => { events.push('library') },
      sidecarsFlushed: async () => { events.push('sidecars') },
      leave: () => { events.push('left'); resolve() },
      log: (m) => { logs.push(m) },
      graceMs: 10,
      boundMs: 200,
      ...over,
    })
  })
  return { events, logs, left, finish: () => run() }
}

describe('the quit finish', () => {
  it('flushes storage first, then cookies and the library, and only then leaves, once', async () => {
    const h = harness()
    h.finish()
    await h.left
    assert.equal(h.events[0], 'storage')
    assert.deepEqual(new Set(h.events.slice(1, 4)), new Set(['cookies', 'library', 'sidecars']))
    assert.equal(h.events[h.events.length - 1], 'left')
    assert.equal(h.events.filter((e) => e === 'left').length, 1)
    assert.deepEqual(h.logs, [])
  })

  it('a second Cmd-Q is the same quit: nothing runs twice', async () => {
    const h = harness()
    h.finish()
    h.finish()
    await h.left
    await sleep(30)
    assert.equal(h.events.filter((e) => e === 'storage').length, 1)
    assert.equal(h.events.filter((e) => e === 'left').length, 1)
  })

  it('waits for a library save in flight', async () => {
    let done = false
    const h = harness({ librarySaved: async () => { await sleep(80); done = true } })
    h.finish()
    await h.left
    assert.equal(done, true)
  })

  // Reviewer's finding, 2026-11-06. On a second Cmd-Q will-quit fires at once while the first
  // before-quit's flush still runs, and the kill came about 300 ms later: a 1.5 s flush never finished.
  it('a second quit waits for the sidecar flush the first one started', async () => {
    let done = false
    const h = harness({ sidecarsFlushed: async () => { await sleep(80); done = true } })
    h.finish()
    await h.left
    assert.equal(done, true)
  })

  it('a sidecar flush that never settles does not hold the door', async () => {
    const h = harness({ sidecarsFlushed: () => new Promise(() => {}) })
    h.finish()
    await h.left
    assert.match(h.logs.join('\n'), /did not settle/)
  })

  it('a library save that never settles does not hold the door: leaves at the bound, and says so', async () => {
    const started = Date.now()
    const h = harness({ librarySaved: () => new Promise(() => {}) })
    h.finish()
    await h.left
    assert.ok(Date.now() - started >= 190, 'held to the bound')
    assert.match(h.logs.join('\n'), /did not settle within 200 ms/)
  })

  it('a cookie flush that never settles does not hold the door either', async () => {
    const h = harness({ flushCookies: () => new Promise(() => {}) })
    h.finish()
    await h.left
    assert.match(h.logs.join('\n'), /did not settle/)
  })

  it('a flush that throws or rejects is logged, and the app still leaves after the rest settled', async () => {
    const h = harness({
      flushStorage: () => { throw new Error('session gone') },
      flushCookies: async () => { throw new Error('no store') },
      librarySaved: async () => { throw new Error('disk full') },
    })
    h.finish()
    await h.left
    const all = h.logs.join('\n')
    for (const word of ['session gone', 'no store', 'disk full']) assert.match(all, new RegExp(word))
    assert.doesNotMatch(all, /did not settle/)
  })

  it('the grace holds even when everything settles at once: flushStorageData can\'t say when it is done', async () => {
    const started = Date.now()
    const h = harness({ graceMs: 120 })
    h.finish()
    await h.left
    assert.ok(Date.now() - started >= 110)
  })

  it('the numbers leave room for a real flush and are still a bound', () => {
    assert.ok(QUIT_GRACE_MS >= 100 && QUIT_GRACE_MS < QUIT_BOUND_MS)
    assert.ok(QUIT_BOUND_MS <= 10_000)
  })
})

// Reviewer's finding, 2026-11-06. The iPod engine copies straight to the final name, so the hard kill
// could leave a torn song on the card (SIGKILL left 80 MB of a 900 MB copy; a normal exit wrote it whole).
describe('how the app leaves', () => {
  const run = (syncInFlight: boolean): string[] => {
    const did: string[] = []
    leaveFor({ syncInFlight: () => syncInFlight, exitNormally: () => did.push('normal'), kill: () => did.push('kill') })()
    return did
  }
  it('an iPod sync running: the normal exit, so the copy in flight finishes', () => {
    assert.deepEqual(run(true), ['normal'])
  })
  it('no sync: the hard kill, so a stuck file call can\'t hold the quit', () => {
    assert.deepEqual(run(false), ['kill'])
  })
  it('it asks when it leaves, because a sync can start during the flushes', () => {
    let inFlight = false
    const did: string[] = []
    const leave = leaveFor({ syncInFlight: () => inFlight, exitNormally: () => did.push('normal'), kill: () => did.push('kill') })
    inFlight = true
    leave()
    assert.deepEqual(did, ['normal'])
  })
  it('the app is wired that way, with the sidecar flush and a log line that outlives the kill', () => {
    const index = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
    const wiring = index.slice(index.indexOf('const finishQuit = createQuitFinish('))
    assert.match(wiring, /leave: leaveFor\(\{ syncInFlight: \(\) => syncEngine\.isSyncInFlight\(\), exitNormally: \(\) => app\.exit\(0\), kill: hardExit \}\)/)
    assert.match(wiring, /sidecarsFlushed: \(\) => sidecarFlush/)
    assert.match(wiring, /log: \(m\) => flightRecorder\.recordNow\(/)
    assert.match(index, /const flush = flushAllCaches\(\[[^\]]*\], 2000\)\n\s+sidecarFlush = flush\n/)
  })
})

// Reviewer's finding, 2026-11-06. The one record of a stuck quit never reached main.log: it left
// through the recorder's queue and the kill came in the same tick, 6 runs of 6.
describe('the bound line, for real', () => {
  it('is in main.log after the kill that follows it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-boundline-'))
    try {
      const logPath = join(root, 'main.log')
      const script = join(root, 'child.mjs')
      writeFileSync(script, `
import { initFlightRecorder } from ${JSON.stringify(join(repoRoot, 'src/main/flight-recorder.ts'))}
import { createQuitFinish, hardExit } from ${JSON.stringify(join(repoRoot, 'src/main/quit-finish.ts'))}
const rec = initFlightRecorder({ logPath: () => ${JSON.stringify(logPath)} })
createQuitFinish({
  flushStorage: () => {}, flushCookies: async () => {}, sidecarsFlushed: async () => {},
  librarySaved: () => new Promise(() => {}),
  leave: hardExit,
  log: (m) => rec.recordNow('warn', 'quit', { msg: m }),
  graceMs: 1, boundMs: 50,
})()
setInterval(() => {}, 1000)
`)
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { stdio: 'ignore' })
      const signal = await new Promise((resolve) => child.on('exit', (_c, s) => resolve(s)))
      assert.equal(signal, 'SIGKILL')
      const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
      assert.equal(line.level, 'warn')
      assert.equal(line.tag, 'quit')
      assert.match(line.detail.msg, /did not settle within 50 ms/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('hardExit, for real', () => {
  it('a process with a thread stuck in a file call is gone at once, by SIGKILL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-hardexit-'))
    try {
      const fifo = join(root, 'stuck.fifo')
      execFileSync('/usr/bin/mkfifo', [fifo])
      const script = join(root, 'child.mjs')
      writeFileSync(script, `
import { open } from 'node:fs'
import { hardExit } from ${JSON.stringify(join(repoRoot, 'src/main/quit-finish.ts'))}
open(${JSON.stringify(fifo)}, 'r', () => {})   // parks one pool thread for good: nobody writes this fifo
setTimeout(() => { console.log('leaving'); hardExit() }, 100)
`)
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      const started = Date.now()
      const gone = await new Promise<{ signal: NodeJS.Signals | null }>((resolve, reject) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('still alive after 20 s')) }, 20_000)
        child.on('exit', (_code, signal) => { clearTimeout(t); resolve({ signal }) })
      })
      assert.equal(gone.signal, 'SIGKILL')
      assert.match(out, /leaving/)
      assert.ok(Date.now() - started < 15_000)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('wiring', () => {
  const src = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')

  it('will-quit holds the default teardown and hands over to the finish, with the real flushes', () => {
    assert.match(src, /app\.on\('will-quit', \(e\) => \{ e\.preventDefault\(\); finishQuit\(\) \}\)/)
    assert.match(src, /librarySaved: \(\) => librarySaveChain,/)
    assert.match(src, /leave: leaveFor\(\{[^\n]*kill: hardExit \}\),/)
    assert.match(src, /s\.flushStorageData\(\)/)
    assert.match(src, /s\.cookies\.flushStore\(\)/)
  })

  it('both sessions that hold anything are flushed: the app\'s and the Bandcamp login', () => {
    assert.match(src, /\[session\.defaultSession, session\.fromPartition\(BANDCAMP_PARTITION\)\]/)
  })

  it('before ready there is no session to ask (a second instance quits that early)', () => {
    assert.match(src, /app\.isReady\(\) \? \[session\.defaultSession/)
  })

  it('the sync child is not signalled at quit: it is detached by design and a signal can cut a publish', () => {
    const fn = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('will-quit'"))
    assert.doesNotMatch(fn, /stopSyncOrchestrator|process\.kill/)
  })
})
