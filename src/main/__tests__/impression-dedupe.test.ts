import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeImpressionDedupe } from '../impression-dedupe.ts'

describe('impression dedupe', () => {
  it('drops a repeat impression the same day, keeps verdicts, resets at midnight UTC', () => {
    const dup = makeImpressionDedupe()
    const shown = { surface: 'discover', verdict: 'shown', key: { artist: 'A', title: 'B' } }
    assert.equal(dup(shown, '2026-10-19T10:00:00Z'), false)
    assert.equal(dup(shown, '2026-10-19T11:00:00Z'), true)
    assert.equal(dup({ ...shown, verdict: 'accept' }, '2026-10-19T11:00:00Z'), false)
    assert.equal(dup(shown, '2026-10-20T00:01:00Z'), false)
  })
  it('a new strip batch of the same song is a new impression', () => {
    const dup = makeImpressionDedupe()
    const a = { surface: 'strip', verdict: 'shown', key: { trackId: 1, playlistId: 'p' }, ctx: { batch: 'p:1' } }
    assert.equal(dup(a, '2026-10-19T10:00:00Z'), false)
    assert.equal(dup({ ...a, ctx: { batch: 'p:2' } }, '2026-10-19T10:00:05Z'), false)
  })
})
