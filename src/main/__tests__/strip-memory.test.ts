/**
 * Strip memory (2026-10-19, Jake's rules): ✕ → hidden from that playlist for
 * good; refreshed past twice within 90 days → hidden 90 days after the second
 * refresh; added then taken back off → hidden for good. Per playlist.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripMemoryFor, negativeExamples, REFRESH_HIDE_DAYS } from '../../common/strip-memory.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-19T12:00:00Z')
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const row = (verdict: string, trackId: number, daysAgo: number, playlistId = 'pl-1') =>
  ({ ts: at(daysAgo), surface: 'strip', verdict, key: { trackId, playlistId } })

describe('stripMemoryFor', () => {
  it('an explicit ✕ hides the song from that playlist for good — and only that playlist', () => {
    const rows = [row('reject', 5, 400)]
    assert.deepEqual(stripMemoryFor(rows, 'pl-1', new Set(), NOW).get(5), { reason: 'rejected', until: null })
    assert.equal(stripMemoryFor(rows, 'pl-2', new Set(), NOW).size, 0)
  })

  it('two refreshes within 90 days hide it until 90 days after the second', () => {
    const m = stripMemoryFor([row('refresh', 7, 30), row('pass', 7, 10)], 'pl-1', new Set(), NOW)
    assert.equal(m.get(7)?.reason, 'refreshed')
    assert.equal(m.get(7)?.until, NOW - 10 * DAY + REFRESH_HIDE_DAYS * DAY)
  })

  it('one refresh, or two refreshes far apart, or an expired hide, do not hide', () => {
    assert.equal(stripMemoryFor([row('refresh', 7, 3)], 'pl-1', new Set(), NOW).size, 0)
    assert.equal(stripMemoryFor([row('refresh', 7, 200), row('refresh', 7, 5)], 'pl-1', new Set(), NOW).size, 0)
    assert.equal(stripMemoryFor([row('refresh', 7, 120), row('refresh', 7, 100)], 'pl-1', new Set(), NOW).size, 0)
  })

  it('a song added and later taken back off is hidden for good and is a negative example', () => {
    const m = stripMemoryFor([row('accept', 9, 20)], 'pl-1', new Set([1, 2]), NOW)
    assert.deepEqual(m.get(9), { reason: 'taken-back', until: null })
    assert.deepEqual(negativeExamples(m), [9])
  })

  it('a song still on the playlist is never hidden; refreshes before an accept no longer count', () => {
    const rows = [row('refresh', 3, 40), row('refresh', 3, 30), row('accept', 3, 20)]
    assert.equal(stripMemoryFor(rows, 'pl-1', new Set([3]), NOW).size, 0)
  })

  it('refreshed-away songs are hidden but are not negative examples', () => {
    const m = stripMemoryFor([row('refresh', 4, 9), row('refresh', 4, 2)], 'pl-1', new Set(), NOW)
    assert.equal(m.size, 1)
    assert.deepEqual(negativeExamples(m), [])
  })
})
