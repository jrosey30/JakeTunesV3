/**
 * Playback quick wins — the pure halves:
 *   - planStarToggle: ⇧⌘S and the menu's Star/Unstar share one plan, so
 *     starredAt is stamped identically from both.
 *   - getInfoTarget: ⌘I opens the selection, else the now-playing song.
 *   - queueNoticeText: the line after Play Next / Add to Up Next.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isStarred, planStarToggle } from '../../common/star-toggle.ts'
import { getInfoTarget } from '../../common/get-info-target.ts'
import { queueNoticeText } from '../../common/queue-notice.ts'

describe('planStarToggle', () => {
  it('stars an unstarred song and stamps starredAt with the same clock', () => {
    const plan = planStarToggle([{ id: 7, rating: 0 }], 1_700_000_000_000)
    assert.equal(plan.target, 5)
    assert.deepEqual(plan.ratingUpdates, [{ id: 7, field: 'rating', value: '5' }])
    assert.deepEqual(plan.stampUpdates, [{ id: 7, field: 'starredAt', value: '1700000000000' }])
  })

  it('unstars a starred song and leaves starredAt alone', () => {
    const plan = planStarToggle([{ id: 7, rating: 5 }], 123)
    assert.equal(plan.target, 0)
    assert.deepEqual(plan.ratingUpdates, [{ id: 7, field: 'rating', value: '0' }])
    assert.deepEqual(plan.stampUpdates, [])
  })

  it('reads any legacy rating > 0 as starred (binary stars)', () => {
    assert.equal(isStarred({ rating: 3 }), true)
    assert.equal(isStarred({ rating: '1' }), true)
    assert.equal(isStarred({ rating: 0 }), false)
    assert.equal(isStarred({}), false)
    assert.equal(planStarToggle([{ id: 1, rating: 2 }], 1).target, 0)
  })

  it('a mixed selection stars everyone with one shared stamp', () => {
    const plan = planStarToggle([{ id: 1, rating: 5 }, { id: 2 }, { id: 3, rating: 0 }], 42)
    assert.equal(plan.target, 5)
    assert.deepEqual(plan.ratingUpdates.map(u => u.value), ['5', '5', '5'])
    assert.deepEqual(plan.stampUpdates.map(u => [u.id, u.value]), [[1, '42'], [2, '42'], [3, '42']])
  })
})

describe('getInfoTarget', () => {
  const a = { id: 1 }, b = { id: 2 }, c = { id: 3 }
  const list = [a, b, c]

  it('opens the selection in list order, index at the first selected row', () => {
    assert.deepEqual(getInfoTarget(list, new Set([3, 2]), a), { tracks: [b, c], index: 1 })
  })

  it('nothing selected → the now-playing song, indexed into the list when it is there', () => {
    assert.deepEqual(getInfoTarget(list, new Set(), c), { tracks: [c], index: 2 })
  })

  it('a lingering selection the list does not show counts as nothing selected', () => {
    assert.deepEqual(getInfoTarget(list, new Set([99]), b), { tracks: [b], index: 1 })
  })

  it('now-playing song outside the list gets its own one-track list', () => {
    const np = { id: 50 }
    assert.deepEqual(getInfoTarget(list, new Set(), np), { tracks: [np], index: 0, allTracks: [np] })
  })

  it('nothing selected and nothing playing → nothing opens', () => {
    assert.equal(getInfoTarget(list, new Set(), null), null)
    assert.equal(getInfoTarget([], new Set([1]), undefined), null)
  })
})

describe('queueNoticeText', () => {
  it('names a single song with its artist', () => {
    assert.equal(queueNoticeText('next', [{ title: 'Heroes', artist: 'David Bowie' }]), 'Playing next: Heroes — David Bowie')
    assert.equal(queueNoticeText('later', [{ title: 'Heroes', artist: 'David Bowie' }]), 'Added to Up Next: Heroes — David Bowie')
  })

  it('drops a missing artist instead of printing a dangling dash', () => {
    assert.equal(queueNoticeText('next', [{ title: 'Untitled Demo' }]), 'Playing next: Untitled Demo')
    assert.equal(queueNoticeText('later', [{ title: '', artist: '' }]), 'Added to Up Next: Untitled')
  })

  it('counts several songs', () => {
    assert.equal(queueNoticeText('next', [{ title: 'a' }, { title: 'b' }, { title: 'c' }]), 'Playing next: 3 songs')
    assert.equal(queueNoticeText('later', [{ title: 'a' }, { title: 'b' }]), 'Added to Up Next: 2 songs')
  })
})
