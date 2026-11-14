/**
 * One parse of library.json for everyone who asks at once (2026-11-14).
 *
 * The 2026-11-13 crash was N whole-file parses in flight together. Three more
 * places in index.ts had that shape; they now read through one shared reader.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSharedJsonRead } from '../shared-json-read.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function disk(): { mtimeMs: number; text: string; reads: number; slow: number; failNext: boolean } {
  return { mtimeMs: 1000, text: '{"tracks":[{"id":1}]}', reads: 0, slow: 5, failNext: false }
}
function reader(d: ReturnType<typeof disk>, holdMs?: number): ReturnType<typeof createSharedJsonRead<{ tracks: Array<{ id: number }> }>> {
  return createSharedJsonRead<{ tracks: Array<{ id: number }> }>({
    path: () => '/lib/library.json',
    stat: async () => ({ mtimeMs: d.mtimeMs }),
    readFile: async () => { d.reads++; const text = d.text; await sleep(d.slow); if (d.failNext) { d.failNext = false; throw new Error('EIO') } return text },
    holdMs,
  })
}

describe('shared JSON read', () => {
  test('200 callers at once cost one read and one parse, and all get the same object', async () => {
    const d = disk()
    const r = reader(d)
    const all = await Promise.all(Array.from({ length: 200 }, () => r.read()))
    assert.equal(d.reads, 1)
    assert.equal(r.parses(), 1)
    assert.ok(all.every((x) => x.value === all[0].value && x.mtimeMs === 1000))
    assert.deepEqual(all[0].value, { tracks: [{ id: 1 }] })
  })

  test('a caller after that gets the same parse until the file changes; then one more parse for everyone', async () => {
    const d = disk()
    const r = reader(d)
    const first = await r.read()
    assert.equal((await r.read()).value, first.value)
    assert.equal(d.reads, 1)
    d.mtimeMs = 2000; d.text = '{"tracks":[{"id":1},{"id":2}]}'
    const next = await Promise.all(Array.from({ length: 50 }, () => r.read()))
    assert.equal(d.reads, 2)
    assert.equal(next[0].value.tracks.length, 2)
    assert.ok(next.every((x) => x.value === next[0].value && x.mtimeMs === 2000))
  })

  test('a save that lands while a read is running starts its own read: nobody is handed the older file as the newer', async () => {
    const d = disk()
    d.slow = 30
    const r = reader(d)
    const old = r.read()
    await sleep(5)
    d.mtimeMs = 2000; d.text = '{"tracks":[]}'
    const fresh = r.read()
    assert.deepEqual((await old).value.tracks, [{ id: 1 }])
    assert.deepEqual(await fresh, { value: { tracks: [] }, mtimeMs: 2000 })
    assert.equal(d.reads, 2)
  })

  test('a read that fails fails for everyone waiting on it, and the next ask tries again', async () => {
    const d = disk()
    d.failNext = true
    const r = reader(d)
    const all = await Promise.allSettled([r.read(), r.read(), r.read()])
    assert.deepEqual(all.map((x) => x.status), ['rejected', 'rejected', 'rejected'])
    assert.equal(d.reads, 1)
    assert.deepEqual((await r.read()).value, { tracks: [{ id: 1 }] })
    assert.equal(d.reads, 2)
    d.mtimeMs = 3000; d.text = '{not json'
    await assert.rejects(r.read(), SyntaxError)
  })

  test('the parsed file is let go after it has not been asked for, and asking keeps it', async () => {
    const d = disk()
    const r = reader(d, 40)
    await r.read()
    await sleep(25); await r.read()      // asked again inside the hold: kept
    await sleep(25); await r.read()
    assert.equal(d.reads, 1)
    await sleep(70)                      // not asked for: let go
    await r.read()
    assert.equal(d.reads, 2)
  })
})

describe('index.ts: nobody parses library.json per caller', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  const body = (name: string): string => {
    const at = src.indexOf(`async function ${name}(`)
    assert.ok(at > 0, name)
    return src.slice(at, src.indexOf('\n}\n', at))
  }
  for (const name of ['readIdentityLibrary', 'trackIdForAbsPath', 'fingerprintForIpodPath']) {
    test(`${name} reads through the shared reader`, () => {
      const b = body(name)
      assert.match(b, /await libraryOnDisk\.read\(\)/)
      assert.doesNotMatch(b, /readFile\(/)
      assert.doesNotMatch(b, /JSON\.parse\(/)
    })
  }
  test('the shared reader is the library file', () => {
    assert.match(src, /const libraryOnDisk = createSharedJsonRead<\{ tracks\?: unknown\[\] \}>\(\{ path: \(\) => LIBRARY_PATH \}\)/)
  })
})
