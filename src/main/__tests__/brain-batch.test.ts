/**
 * The brain trainer's nightly queue (scripts/brain-batch.mjs): every new add
 * is heard the night it arrives; only the old-library backfill is capped.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickBatch } from '../../../scripts/brain-batch.mjs'

const now = Date.parse('2026-10-12T06:00:00Z')
const day = 86400000
const t = (id: number, daysAgo: number | null, playCount = 0) =>
  ({ id, artist: `A${id}`, title: `T${id}`, playCount, dateAdded: daysAgo === null ? undefined : new Date(now - daysAgo * day).toISOString() })

describe('tonight\'s queue', () => {
  it('takes EVERY unheard new add, newest first, however many arrived (10/12: 377 were waiting behind a 50 cap)', () => {
    const adds = Array.from({ length: 400 }, (_, i) => t(1000 + i, i / 40))
    const q = pickBatch(adds, new Set(), { now, batch: 50 })
    assert.equal(q.length, 400)
    assert.equal(q[0].id, 1000, 'newest first')
  })
  it('caps only the old-library backfill, most-played first, after the new adds', () => {
    const tracks = [t(1, 400, 5), t(2, 400, 90), t(3, null, 40), t(4, 2), t(5, 1)]
    const q = pickBatch(tracks, new Set(), { now, batch: 2 })
    assert.deepEqual(q.map((x: { id: number }) => x.id), [5, 4, 2, 3])
  })
  it('skips what the brain has already heard and rows with no artist or title', () => {
    const q = pickBatch([t(1, 1), t(2, 1), { id: 3, dateAdded: new Date(now).toISOString() }], new Set(['1']), { now, batch: 10 })
    assert.deepEqual(q.map((x: { id: number }) => x.id), [2])
  })
})
