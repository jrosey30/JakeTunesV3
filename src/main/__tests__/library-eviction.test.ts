/**
 * The goodbye is the dangerous part, so every gate gets a test.
 *
 * The failure this module must never cause: a local file trashed whose bytes
 * homemini does NOT hold. Every test that ends in "stays" is one of the
 * gates that prevents it. Real md5s over real temp files — the hashing is
 * part of the contract, not a mockable detail.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sweepOnce, EVICT_GRACE_MS, EVICT_BATCH, type EvictionCandidate, type EvictionDeps } from '../library-eviction.ts'

const NOW = 1_700_000_000_000
const OLD = NOW - EVICT_GRACE_MS - 60_000
const md5 = (b: string | Buffer): string => createHash('md5').update(b).digest('hex')

function makeFile(dir: string, rel: string, content: string, mtimeMs = OLD): EvictionCandidate {
  const abs = join(dir, rel.replace(/\//g, '_'))
  writeFileSync(abs, content)
  return { abs, rel, mtimeMs, sizeBytes: content.length }
}

function harness(files: EvictionCandidate[], opts: {
  alive?: string[]
  remote?: Record<string, string>
} = {}): { deps: EvictionDeps; trashed: string[]; journal: string[] } {
  const trashed: string[] = []
  const journal: string[] = []
  return {
    trashed,
    journal,
    deps: {
      listLocalAudio: async () => files,
      libraryRelPaths: async () => new Set(opts.alive ?? files.map((f) => f.rel)),
      remoteMd5Batch: async (rels) => {
        const m = new Map<string, string>()
        for (const r of rels) if (opts.remote && r in opts.remote) m.set(r, opts.remote[r])
        return m
      },
      trash: async (abs) => { trashed.push(abs) },
      journal: async (line) => { journal.push(line) },
      now: () => NOW,
    },
  }
}

describe('the eviction gates', () => {
  test('a verified, settled, library-alive file is evicted with a receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'iPod_Control/Music/F07/imported_777.m4a', 'song bytes')
    const { deps, trashed, journal } = harness([f], { remote: { [f.rel]: md5('song bytes') } })
    const r = await sweepOnce(deps)
    assert.equal(r.evicted, 1)
    assert.deepEqual(trashed, [f.abs])
    const receipt = JSON.parse(journal[0])
    assert.equal(receipt.rel, f.rel)
    assert.equal(receipt.md5, md5('song bytes'))
  })

  test('younger than the grace period: stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'F01/fresh.m4a', 'x', NOW - 1000)
    const { deps, trashed } = harness([f], { remote: { [f.rel]: md5('x') } })
    const r = await sweepOnce(deps)
    assert.equal(r.tooYoung, 1)
    assert.equal(trashed.length, 0)
  })

  test('not referenced by library.json: stays (orphans are not ours to hide)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'F02/orphan.m4a', 'x')
    const { deps, trashed } = harness([f], { alive: [], remote: { [f.rel]: md5('x') } })
    const r = await sweepOnce(deps)
    assert.equal(r.notInLibrary, 1)
    assert.equal(trashed.length, 0)
  })

  test('homemini has no copy: stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'F03/unsynced.m4a', 'x')
    const { deps, trashed } = harness([f], { remote: {} })
    const r = await sweepOnce(deps)
    assert.equal(r.notOnHomemini, 1)
    assert.equal(trashed.length, 0)
  })

  test('homemini holds DIFFERENT bytes: stays — this is the gate that matters', async () => {
    // A torn NAS write or an in-flight rsync can leave homemini with a
    // partial file at the right path. Existence would say "propagated";
    // only the hash says "the same record".
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'F04/torn.m4a', 'full bytes here')
    const { deps, trashed } = harness([f], { remote: { [f.rel]: md5('partial byt') } })
    const r = await sweepOnce(deps)
    assert.equal(r.hashMismatch, 1)
    assert.equal(trashed.length, 0)
  })

  test('the batch is bounded and oldest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const files: EvictionCandidate[] = []
    const remote: Record<string, string> = {}
    for (let i = 0; i < EVICT_BATCH + 15; i++) {
      const f = makeFile(dir, `F05/imported_${i}.m4a`, `bytes-${i}`, OLD - i * 1000)
      files.push(f)
      remote[f.rel] = md5(`bytes-${i}`)
    }
    const { deps, trashed } = harness(files, { remote })
    const r = await sweepOnce(deps)
    assert.equal(r.evicted, EVICT_BATCH, 'one sweep drains at most one batch')
    // Oldest candidate = highest i (mtime OLD - i*1000): it must be first out.
    assert.ok(trashed[0].includes(`imported_${EVICT_BATCH + 14}`), 'oldest file leads the queue')
  })

  test('a dead remote oracle evicts nothing and reports an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-evict-'))
    const f = makeFile(dir, 'F06/any.m4a', 'x')
    const { trashed, deps } = harness([f])
    deps.remoteMd5Batch = async () => { throw new Error('ssh down') }
    const r = await sweepOnce(deps)
    assert.equal(r.errors, 1)
    assert.equal(trashed.length, 0)
  })
})
