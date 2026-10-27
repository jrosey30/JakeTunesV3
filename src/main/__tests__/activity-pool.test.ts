import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockedByOtherIpods, mergeIntoPool, removeFromPool, POOL_MAX } from '../activity-pool.ts'

const never = () => false
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const cands = (ids: number[]) => ids.map((id) => ({ id }))

describe('mergeIntoPool', () => {
  it('dedupes by id and keeps drop order', () => {
    const r = mergeIntoPool([1, 2], [{ id: 2 }, { id: 3 }, { id: 1 }, { id: 4 }], never)
    assert.deepEqual(r.ids, [1, 2, 3, 4])
    assert.equal(r.added, 2)
    assert.equal(r.dupes, 2)
    assert.equal(r.rolledOff, 0)
  })

  it('skips skits on drop and REPORTS the count', () => {
    const r = mergeIntoPool([], [{ id: 1, title: 'Intro' }, { id: 2, title: 'Song' }], (c) => /intro/i.test(c.title || ''))
    assert.deepEqual(r.ids, [2])
    assert.equal(r.skits, 1)
  })

  it('the pool holds 1,000', () => {
    assert.equal(POOL_MAX, 1000)
  })

  it('past the cap, the OLDEST drops roll off to make room — and the count is reported', () => {
    const r = mergeIntoPool([1, 2], [{ id: 3 }, { id: 4 }, { id: 5 }], never, 3)
    assert.deepEqual(r.ids, [3, 4, 5])
    assert.equal(r.added, 3)
    assert.equal(r.rolledOff, 2)
    assert.deepEqual(r.rolledOffIds, [1, 2])
    assert.equal(r.overflow, 0)
  })

  it('a full 1,000 pool + 20 new drops: all 20 land, the 20 oldest roll off', () => {
    const r = mergeIntoPool(range(1, 1000), cands(range(1001, 1020)), never)
    assert.equal(r.ids.length, 1000)
    assert.deepEqual(r.ids, range(21, 1020))
    assert.equal(r.added, 20)
    assert.equal(r.rolledOff, 20)
    assert.deepEqual(r.rolledOffIds, range(1, 20))
  })

  it('under the cap nothing rolls off', () => {
    const r = mergeIntoPool(range(1, 990), cands(range(991, 1000)), never)
    assert.equal(r.ids.length, 1000)
    assert.equal(r.rolledOff, 0)
  })

  it('dupes and skits never cost a pooled song its place', () => {
    const r = mergeIntoPool(range(1, 1000), [{ id: 5 }, { id: 2000, title: 'Intro' }], (c) => /intro/i.test(c.title || ''))
    assert.deepEqual(r.ids, range(1, 1000))
    assert.equal(r.added, 0)
    assert.equal(r.rolledOff, 0)
    assert.equal(r.dupes, 1)
    assert.equal(r.skits, 1)
  })

  it('a song re-dropped in the same batch is never the one rolled off', () => {
    // Pool full; Jake drags an album that includes the oldest song again.
    const r = mergeIntoPool(range(1, 1000), cands([1, 1001]), never)
    assert.equal(r.ids.length, 1000)
    assert.ok(r.ids.includes(1), 'the re-dropped song stays')
    assert.ok(r.ids.includes(1001))
    assert.deepEqual(r.rolledOffIds, [2])
    assert.equal(r.ids[0], 1, 'drop order is kept — a re-drop does not move it')
  })

  it('one drop bigger than the pool: the newest 1,000 of it land, the rest is reported as overflow', () => {
    const r = mergeIntoPool(range(1, 5), cands(range(101, 1300)), never)
    assert.equal(r.ids.length, 1000)
    assert.deepEqual(r.ids, range(301, 1300))
    assert.equal(r.rolledOff, 5)
    assert.equal(r.overflow, 200)
    assert.equal(r.added, 1000)
  })

  it('ignores garbage ids', () => {
    const r = mergeIntoPool([], [{ id: Number.NaN }, { id: 7 }], never)
    assert.deepEqual(r.ids, [7])
  })
})

describe('removeFromPool', () => {
  it('removes only the named ids', () => {
    assert.deepEqual(removeFromPool([1, 2, 3, 4], [2, 4, 9]), [1, 3])
  })
})

describe('pool page', () => {
  const view = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'views', 'ActivityPoolView.tsx'), 'utf8')
  it('"Sync this pool…" checks for an iPod before going to the Device page', () => {
    assert.match(view, /checkIpodMounted\(\)/)
    assert.match(view, /Plug in the iPod, then press Activity Sync/)
    assert.doesNotMatch(view, /requestPoolMode\(/)
  })
  it('no copy says the sync stops and asks you to trim — half and half never trims or stops', () => {
    assert.doesNotMatch(view, /asks you to trim/)
    assert.doesNotMatch(view, /sync stops/)
  })
})

describe('no song rides two iPods (one Pool per iPod, step 2)', () => {
  it('blocks what already lives on another iPod and names it; the rest is allowed, in order', () => {
    const r = blockedByOtherIpods(cands([1, 2, 3, 4, 5]), [{ name: 'Red', ids: [2, 4] }, { name: 'Original', ids: [5] }])
    assert.deepEqual(r.allowed.map((c) => c.id), [1, 3])
    assert.deepEqual(r.blocked, [{ id: 2, by: 'Red' }, { id: 4, by: 'Red' }, { id: 5, by: 'Original' }])
  })
  it('with no other iPod (or empty pools) everything is allowed — today’s behaviour', () => {
    assert.deepEqual(blockedByOtherIpods(cands([1, 2]), []).allowed.map((c) => c.id), [1, 2])
    assert.deepEqual(blockedByOtherIpods(cands([1, 2]), [{ name: 'Red', ids: [] }]).blocked, [])
  })
  it('the first iPod listed owns a song two of them (wrongly) share', () => {
    assert.deepEqual(blockedByOtherIpods(cands([9]), [{ name: 'Red', ids: [9] }, { name: 'Blue', ids: [9] }]).blocked, [{ id: 9, by: 'Red' }])
  })
})
