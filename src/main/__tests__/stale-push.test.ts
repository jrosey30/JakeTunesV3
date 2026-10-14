import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { libraryPushVerdict } from '../../common/stale-push.ts'

const lib = (n: number, day = 1, start = 1) => ({
  tracks: Array.from({ length: n }, (_, i) => ({ id: start + i, dateAdded: `2026-09-${String(day).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z` })),
})

describe('libraryPushVerdict: a stale machine never overwrites the NAS', () => {
  it('the 10/5 incident: a Sep-4 machine is refused against the real library', () => {
    const stale = lib(100, 4)
    const real = { tracks: [...stale.tracks, ...lib(10, 28, 1000).tracks] }
    const v = libraryPushVerdict(stale, real)
    assert.equal(v.push, false)
    assert.equal(v.nasOnlyNewer, 10)
  })
  it('the up-to-date machine pushes, including after deleting songs', () => {
    const nas = lib(100, 4)
    const local = { tracks: [...nas.tracks.slice(5), ...lib(3, 28, 500).tracks] }  // deleted 5, added 3
    assert.equal(libraryPushVerdict(local, nas).push, true)
  })
  it('pushes when the NAS copy is missing or empty', () => {
    assert.equal(libraryPushVerdict(lib(5), null).push, true)
    assert.equal(libraryPushVerdict(lib(5), { tracks: [] }).push, true)
  })
  it('never pushes an empty local library', () => {
    assert.equal(libraryPushVerdict({ tracks: [] }, lib(5)).push, false)
  })
  it('accepts a bare-array library too', () => {
    assert.equal(libraryPushVerdict(lib(3, 4).tracks, lib(3, 4).tracks).push, true)
  })
})

describe('libraryPushVerdict: Brief 197 — recent ids are protected, not just newer ones', () => {
  const NOW = Date.parse('2026-10-14T23:00:00Z')
  it('refuses a push that would drop a 1-day-old song even when the pusher has newer songs', () => {
    // The Morphine shape: the hub's library holds a phone download added
    // yesterday (id 12740). This machine's lineage never absorbed it but
    // has a song added today, so the old date-only rule (dropped must be
    // NEWER than the pusher's newest) waved the push through and the
    // download vanished from every surface.
    const local = {
      tracks: [
        { id: 1, dateAdded: '2026-08-01T00:00:00Z' },
        { id: 2, title: 'Roadrunner', dateAdded: '2026-10-14T10:00:00Z' },
      ],
    }
    const nas = {
      tracks: [
        ...local.tracks,
        { id: 12740, title: 'Cure for Pain', artist: 'Morphine', dateAdded: '2026-10-13T15:00:00Z' },
      ],
    }
    const v = libraryPushVerdict(local, nas, NOW)
    assert.equal(v.push, false)
    assert.equal(v.nasOnlyNewer, 0, 'the dropped song is NOT newer than the pusher\u2019s newest')
    assert.equal(v.nasOnlyRecent, 1)
    assert.deepEqual(v.droppedRecent, ['Cure for Pain — Morphine'])
    assert.match(v.reason, /Cure for Pain/)
  })
  it('still pushes when the only songs it drops are old (deletions age out of the window)', () => {
    const local = { tracks: [{ id: 1, dateAdded: '2026-10-14T10:00:00Z' }] }
    const nas = {
      tracks: [
        ...local.tracks,
        { id: 9, title: 'Deleted in August', dateAdded: '2026-08-01T00:00:00Z' },
      ],
    }
    const v = libraryPushVerdict(local, nas, NOW)
    assert.equal(v.push, true)
    assert.equal(v.nasOnlyRecent, 0)
  })
  it('an undated NAS-only song does not trip the recent rule (cannot prove it is recent)', () => {
    const local = { tracks: [{ id: 1, dateAdded: '2026-10-14T10:00:00Z' }] }
    const nas = { tracks: [...local.tracks, { id: 9, title: 'No date' }] }
    assert.equal(libraryPushVerdict(local, nas, NOW).push, true)
  })
})
