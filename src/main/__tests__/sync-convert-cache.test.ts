/**
 * Brief 265 Part 5: the convert cache's upkeep (sync-convert-cache.ts). Off by default;
 * never during a sync; partials only; least recently used first.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCache, isFfmpegAacMirror, listCache, planPrune, pruneToCap, readCapGb, sweepPartials, touchUsed, writeCapGb } from '../sync-convert-cache.ts'

const idle = { syncInFlight: () => false }
const busy = { syncInFlight: () => true }

async function cache(files: Array<[string, number, number]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'b265-cache-'))
  for (const [name, bytes, ageMin] of files) {
    await writeFile(join(dir, name), Buffer.alloc(bytes))
    const t = new Date(Date.now() - ageMin * 60_000)
    await utimes(join(dir, name), t, t)
  }
  return dir
}

describe('leftover partials', () => {
  it('only *.partial.* files ten minutes or older go; mirrors and fresh partials stay', async () => {
    const dir = await cache([['a.m4a', 10, 60], ['a.m4a.partial.wav', 10, 60], ['b.mp3.partial.mp3', 10, 30], ['c.m4a.partial.m4a', 10, 1]])
    const gone = await sweepPartials(dir, idle)
    assert.deepEqual(gone.sort(), ['a.m4a.partial.wav', 'b.mp3.partial.mp3'])
    assert.deepEqual((await readdir(dir)).sort(), ['a.m4a', 'c.m4a.partial.m4a'])
  })
  it('never while a sync runs', async () => {
    const dir = await cache([['a.m4a.partial.wav', 10, 60]])
    assert.deepEqual(await sweepPartials(dir, busy), [])
    assert.deepEqual(await readdir(dir), ['a.m4a.partial.wav'])
  })
})

describe('the size cap', () => {
  it('no cap (the default) deletes nothing, however big the cache', async () => {
    const dir = await cache([['a.m4a', 5000, 600], ['b.m4a', 5000, 1]])
    assert.deepEqual(await pruneToCap(dir, null, idle), { pruned: false, why: 'no cap set' })
    assert.equal((await readdir(dir)).length, 2)
    assert.equal(await readCapGb(join(dir, 'missing.json')), null)
  })
  it('least recently used first, down to the cap; partials never picked', () => {
    const files = [
      { name: 'old.m4a', path: '', size: 400, usedMs: 1, mtimeMs: 1 },
      { name: 'mid.m4a', path: '', size: 400, usedMs: 2, mtimeMs: 2 },
      { name: 'new.m4a', path: '', size: 400, usedMs: 3, mtimeMs: 3 },
      { name: 'x.m4a.partial.wav', path: '', size: 9000, usedMs: 0, mtimeMs: 0 },
    ]
    assert.deepEqual(planPrune(files, 800).map((f) => f.name), ['old.m4a'])
    assert.deepEqual(planPrune(files, 400).map((f) => f.name), ['old.m4a', 'mid.m4a'])
    assert.deepEqual(planPrune(files, 5000), [])
  })
  it('a copy a sync just used is the newest, whatever its modified time', async () => {
    const dir = await cache([['used.m4a', 10, 600], ['other.m4a', 10, 300]])
    await touchUsed(join(dir, 'used.m4a'))
    const files = await listCache(dir)
    assert.deepEqual(planPrune(files, 10).map((f) => f.name), ['other.m4a'])
    const used = files.find((f) => f.name === 'used.m4a')!
    assert.ok(Date.now() - used.mtimeMs > 500 * 60_000, 'its modified time (freshness) is kept')
  })
  it('never while a sync runs; with a cap and no sync it prunes', async () => {
    const dir = await cache([['a.m4a', 600_000_000, 60], ['b.m4a', 600_000_000, 1]])
    assert.deepEqual(await pruneToCap(dir, 1, busy), { pruned: false, why: 'a sync is running' })
    const r = await pruneToCap(dir, 1, idle)
    assert.equal(r.pruned, true)
    assert.deepEqual(await readdir(dir), ['b.m4a'])
  })
  it('the cap is saved and read back; null turns it off', async () => {
    const f = join(await mkdtemp(join(tmpdir(), 'b265-cap-')), 'settings.json')
    await writeCapGb(f, 50)
    assert.equal(await readCapGb(f), 50)
    await writeCapGb(f, null)
    assert.equal(await readCapGb(f), null)
  })
})

describe('clear', () => {
  it('empties the cache; refused while a sync runs', async () => {
    const dir = await cache([['a.m4a', 10, 1], ['b.mp3', 10, 1]])
    assert.equal((await clearCache(dir, busy)).ok, false)
    assert.equal((await readdir(dir)).length, 2)
    const r = await clearCache(dir, idle)
    assert.deepEqual(r, { ok: true, removed: 2, freedBytes: 20 })
    assert.deepEqual(await readdir(dir), [])
  })
})

describe('the obsolete ffmpeg AAC mirrors (the one approved deletion)', () => {
  it('only AAC in an .m4a with ffmpeg\'s encoder tag', () => {
    assert.equal(isFfmpegAacMirror('c0b6efa19af8ad09.m4a', { codec: 'aac', encoder: 'Lavf62.12.102' }), true)
    assert.equal(isFfmpegAacMirror('x.m4a', { codec: 'aac', encoder: '' }), false, 'afconvert writes no encoder tag')
    assert.equal(isFfmpegAacMirror('x.m4a', { codec: 'alac', encoder: 'Lavf62.12.102' }), false, 'iPod-safe ALAC')
    assert.equal(isFfmpegAacMirror('x.mp3', { codec: 'mp3', encoder: 'Lavf62.12.102' }), false, 'Gen 1 MP3')
    assert.equal(isFfmpegAacMirror('x.m4a.partial.m4a', { codec: 'aac', encoder: 'Lavf62' }), false)
  })
  it('nothing in the app calls it: only the script', async () => {
    const { execFileSync } = await import('node:child_process')
    const hits = execFileSync('grep', ['-rl', 'isFfmpegAacMirror(', join(import.meta.dirname, '..'), '--include=*.ts']).toString().trim().split('\n')
      .filter((f) => !f.includes('__tests__') && !f.endsWith('sync-convert-cache.ts'))
    assert.deepEqual(hits, [])
  })
})
