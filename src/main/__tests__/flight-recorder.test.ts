/**
 * Flight recorder doctrine (reliability program P0):
 *  - every record() lands as one parseable JSON line, in order
 *  - the recorder NEVER throws — a broken log path counts drops and the
 *    next successful append confesses them (droppedBefore)
 *  - rotation caps the file into a single .1 generation
 *  - mirrorConsole records without eating the original console behavior
 *  - appends wait for the readiness gate
 *  - crash payloads from the renderer are bounded and shaped, whatever
 *    arrives on the wire
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initFlightRecorder, serializeDetail, sanitizeCrashPayload } from '../flight-recorder.ts'

const tmp = async () => mkdtemp(join(tmpdir(), 'fr-test-'))
// Poll-until-true, never a fixed sleep: fixed waits flaked the gate the
// first time the suite ran alongside a build (2026-08-22, # fail 1 under
// load). 2s ceiling = load-proof; passes in ~10ms when idle.
const settle = async (done?: () => Promise<boolean>) => {
  const until = Date.now() + 2000
  for (;;) {
    if (done) { try { if (await done()) return } catch { /* keep polling */ } }
    else await new Promise((r) => setTimeout(r, 30))
    if (Date.now() > until || !done) return
    await new Promise((r) => setTimeout(r, 30))
  }
}
const fileHas = (path: string, needle: string) => async (): Promise<boolean> => {
  try { return (await readFile(path, 'utf-8')).includes(needle) } catch { return false }
}

describe('record', () => {
  test('appends ordered, parseable JSON lines', async () => {
    const dir = await tmp()
    const fr = initFlightRecorder({ logPath: () => join(dir, 'main.log'), now: () => 1755800000000 })
    fr.record('info', 'boot.main-start')
    fr.record('warn', 'console', { msg: 'lane failed' })
    fr.record('error', 'renderer.crash', { message: 'boom' })
    await settle(fileHas(join(dir, 'main.log'), 'renderer.crash'))
    const lines = (await readFile(join(dir, 'main.log'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => [l.level, l.tag]), [
      ['info', 'boot.main-start'], ['warn', 'console'], ['error', 'renderer.crash'],
    ])
    assert.equal(lines[0].ts, '2025-08-21T18:13:20.000Z')
    assert.equal(lines[1].detail.msg, 'lane failed')
  })

  test('never throws on a broken path; drops are confessed on recovery', async () => {
    const dir = await tmp()
    let path = join(dir, 'no-such-dir', 'main.log')
    const fr = initFlightRecorder({ logPath: () => path })
    fr.record('info', 'a')
    fr.record('info', 'b')
    await settle(async () => fr.drops() === 2)
    assert.equal(fr.drops(), 2)
    path = join(dir, 'main.log')   // path heals
    fr.record('info', 'c')
    await settle(fileHas(path, '"c"'))
    const line = JSON.parse((await readFile(path, 'utf-8')).trim())
    assert.equal(line.droppedBefore, 2)
    assert.equal(fr.drops(), 0)
  })

  test('waits for the readiness gate; a REJECTED gate still logs', async () => {
    const dir = await tmp()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const fr = initFlightRecorder({ logPath: () => join(dir, 'main.log'), ready: gate })
    fr.record('info', 'early')
    await settle()
    await assert.rejects(stat(join(dir, 'main.log')))   // nothing before ready
    release()
    await settle(fileHas(join(dir, 'main.log'), 'early'))
    assert.ok((await readFile(join(dir, 'main.log'), 'utf-8')).includes('"early"'))

    const fr2 = initFlightRecorder({ logPath: () => join(dir, 'main2.log'), ready: Promise.reject(new Error('boot died')) })
    fr2.record('error', 'still-works')
    await settle(fileHas(join(dir, 'main2.log'), 'still-works'))
    assert.ok((await readFile(join(dir, 'main2.log'), 'utf-8')).includes('still-works'))
  })

  test('rotates into a single .1 generation past maxBytes', async () => {
    const dir = await tmp()
    const p = join(dir, 'main.log')
    await writeFile(p, 'x'.repeat(2000))
    const fr = initFlightRecorder({ logPath: () => p, maxBytes: 1000 })
    for (let i = 0; i < 51; i++) fr.record('info', `t${i}`)   // cross the every-50 check
    await settle(fileHas(p, '"t50"'))
    const rotated = await readFile(p + '.1', 'utf-8')
    assert.ok(rotated.startsWith('xxxx'))
    const fresh = await readFile(p, 'utf-8')
    assert.ok(fresh.length < 6000 && fresh.includes('"t50"'))
  })
})

describe('serializeDetail', () => {
  test('Error keeps message + trimmed stack', () => {
    const d = JSON.parse(serializeDetail(new Error('kaput')))
    assert.equal(d.error, 'kaput')
    assert.ok(typeof d.stack === 'string')
  })
  test('cycles collapse instead of throwing', () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = o
    assert.ok(serializeDetail(o).includes('[cycle]'))
  })
  test('giant payloads are capped', () => {
    const s = serializeDetail({ big: 'y'.repeat(100_000) })
    assert.ok(s.length < 5000)
  })
  test('bigint survives', () => {
    assert.ok(serializeDetail({ n: 10n }).includes('"10"'))
  })
})

describe('mirrorConsole', () => {
  test('console.warn still reaches the original AND the log', async () => {
    const dir = await tmp()
    const fr = initFlightRecorder({ logPath: () => join(dir, 'main.log') })
    const orig = console.warn
    let sawOriginal: unknown[] | null = null
    console.warn = (...args: unknown[]) => { sawOriginal = args }
    try {
      fr.mirrorConsole()
      console.warn('[discover] lane failed:', 'timeout')
      await settle(fileHas(join(dir, 'main.log'), 'lane failed'))
    } finally {
      console.warn = orig
    }
    assert.deepEqual(sawOriginal, ['[discover] lane failed:', 'timeout'])
    const line = JSON.parse((await readFile(join(dir, 'main.log'), 'utf-8')).trim())
    assert.equal(line.tag, 'console')
    assert.equal(line.detail.msg, '[discover] lane failed:')
  })
})

describe('sanitizeCrashPayload', () => {
  test('bounds and shapes whatever arrives', () => {
    const p = sanitizeCrashPayload({ kind: 'window-error', message: 'm'.repeat(9000), stack: 5, extra: 'ignored' })
    assert.equal(p.kind, 'window-error')
    assert.equal(p.message.length, 500)
    assert.equal(p.stack, '5')
    assert.equal(p.source, '')
  })
  test('garbage in, empty shape out', () => {
    assert.equal(sanitizeCrashPayload(null).kind, 'unknown')
    assert.equal(sanitizeCrashPayload('lol').message, '')
  })
})
