import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planBrainAdopt, assertNoBrainPush, HOMEMINI_OWNED_BRAIN_FILES } from '../../common/brain-adopt.ts'

const vec = (x: number): Float32Array => new Float32Array([x])
const mapOf = (ids: number[], x = 1): Map<number, Float32Array> => new Map(ids.map((id) => [id, vec(x)]))
const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i)

describe('planBrainAdopt: the laptop adopts the trained brain safely', () => {
  it("adopts the NAS copy and keeps the laptop's vectors for fresh imports", () => {
    const lib = new Set(range(1, 101))
    const nas = mapOf(range(1, 96), 2)                 // trainer has 1..95
    const local = mapOf([...range(1, 101), 999], 1)   // laptop has 1..100 + a deleted song
    const plan = planBrainAdopt(95, nas, local, lib)
    assert.equal(plan.adopt, true)
    assert.equal(plan.keptLocal, 5)                   // 96..100 carried over
    assert.equal(plan.merged!.size, 100)
    assert.equal(plan.merged!.get(10)![0], 2)         // the trained vector wins
    assert.equal(plan.merged!.has(999), false)        // a deleted song is not carried
  })
  it('refuses a truncated read (header count ≠ parsed count)', () => {
    const plan = planBrainAdopt(100, mapOf(range(1, 81)), new Map(), new Set(range(1, 101)))
    assert.equal(plan.adopt, false)
    assert.match(plan.reason, /truncated/)
  })
  it('refuses a NAS copy that covers too little of the library', () => {
    const plan = planBrainAdopt(50, mapOf(range(1, 51)), new Map(), new Set(range(1, 101)))
    assert.equal(plan.adopt, false)
    assert.match(plan.reason, /covers only 50 of 100/)
  })
  it('refuses an empty NAS copy', () => {
    assert.equal(planBrainAdopt(0, new Map(), mapOf([1]), new Set([1])).adopt, false)
  })
})

describe('the desktop never pushes the brain', () => {
  it('assertNoBrainPush throws on either brain file', () => {
    for (const f of HOMEMINI_OWNED_BRAIN_FILES) assert.throws(() => assertNoBrainPush(['library.json', f], 'X'))
    assert.doesNotThrow(() => assertNoBrainPush(['library.json', 'lyrics.json'], 'X'))
  })
  it('STATE_FILE_NAMES in index.ts lists neither brain file', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
    const start = src.indexOf('const STATE_FILE_NAMES = [')
    const end = src.indexOf('] as const', start)
    assert.ok(start > 0 && end > start, 'STATE_FILE_NAMES block not found')
    const block = src.slice(start, end).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    for (const f of HOMEMINI_OWNED_BRAIN_FILES) assert.equal(block.includes(`'${f}'`), false, `${f} is back in STATE_FILE_NAMES`)
  })
})
