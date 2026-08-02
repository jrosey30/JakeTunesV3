/**
 * JsonFileCache write behaviour.
 *
 * This class is the writer for metadata-overrides.json and friends, and it has
 * already been implicated in one data-loss morning (a racing .set() against an
 * atomic save left the NAS library.json at 0 bytes). So the coalescing added on
 * 2026-08-02 gets tests: collapsing writes is only safe if the surviving write
 * still persists the LATEST state and nothing issued mid-write is swallowed.
 *
 * Write counting works by counting pathFn() calls — it is invoked exactly once
 * per flush task, so it is an honest probe without stubbing fs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileCache } from '../state-cache.ts'

function makeCache<T>(initial?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jt-state-cache-'))
  const file = join(dir, 'state.json')
  if (initial !== undefined) writeFileSync(file, initial, 'utf-8')
  let writes = 0
  const cache = new JsonFileCache<T>(
    () => { writes++; return file },
    () => ({} as T),
    'test',
  )
  return { cache, file, dir, writeCount: () => writes, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf-8'))

test('coalesces a burst of updates into far fewer writes', async () => {
  const h = makeCache<Record<string, number>>()
  try {
    // The bulk shape: many small mutations back to back, as the audio-analysis
    // sweep does once per track.
    for (let i = 0; i < 200; i++) await h.cache.update((c) => { c[`k${i}`] = i; return c })
    await h.cache.flush()

    assert.ok(h.writeCount() < 200, `expected coalescing, got ${h.writeCount()} writes for 200 updates`)
    const onDisk = readJson(h.file)
    assert.equal(Object.keys(onDisk).length, 200, 'every update must survive')
    assert.equal(onDisk.k0, 0)
    assert.equal(onDisk.k199, 199, 'the last update must be on disk')
  } finally { h.cleanup() }
})

test('a collapsed write persists the LATEST state, not the state at schedule time', async () => {
  const h = makeCache<Record<string, string>>()
  try {
    await h.cache.update((c) => { c.v = 'first'; return c })
    await h.cache.update((c) => { c.v = 'second'; return c })
    await h.cache.update((c) => { c.v = 'third'; return c })
    await h.cache.flush()
    assert.equal(readJson(h.file).v, 'third')
  } finally { h.cleanup() }
})

test('an update issued while a write is in flight still reaches disk', async () => {
  const h = makeCache<Record<string, string>>()
  try {
    await h.cache.update((c) => { c.a = '1'; return c })
    // Do NOT await the in-flight write; mutate again immediately. The pending
    // task clears its queued flag before serializing, so this must schedule a
    // fresh write rather than being absorbed and lost.
    const late = h.cache.update((c) => { c.b = '2'; return c })
    await late
    await h.cache.flush()
    const onDisk = readJson(h.file)
    assert.equal(onDisk.a, '1')
    assert.equal(onDisk.b, '2', 'update during an in-flight write was swallowed')
  } finally { h.cleanup() }
})

test('set() replaces wholesale and still lands', async () => {
  const h = makeCache<Record<string, string>>()
  try {
    await h.cache.update((c) => { c.old = 'x'; return c })
    h.cache.set({ fresh: 'y' })
    await h.cache.flush()
    const onDisk = readJson(h.file)
    assert.equal(onDisk.fresh, 'y')
    assert.equal(onDisk.old, undefined, 'set() must replace, not merge')
  } finally { h.cleanup() }
})

test('refuses to overwrite a file it could not parse', async () => {
  const h = makeCache<Record<string, string>>('{ this is not json')
  try {
    await h.cache.get()                       // loads as error-fallback
    await h.cache.update((c) => { c.wiped = 'yes'; return c })
    await h.cache.flush()
    // The unreadable original must still be there — flushing the empty
    // fallback over it would destroy real user data.
    assert.equal(readFileSync(h.file, 'utf-8'), '{ this is not json')
  } finally { h.cleanup() }
})

test('prime() updates memory without writing', async () => {
  const h = makeCache<Record<string, string>>('{"onDisk":"original"}')
  try {
    await h.cache.get()
    h.cache.prime({ onDisk: 'changed' })
    await h.cache.flush()
    assert.equal(readJson(h.file).onDisk, 'original', 'prime() must not write')
    assert.deepEqual(await h.cache.get(), { onDisk: 'changed' })
  } finally { h.cleanup() }
})
