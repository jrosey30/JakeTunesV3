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
