import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCandidatePool } from '../record-store/candidate-pool.ts'

// A record pulled out of a crate has to start at side A track 1. The library
// hands tracks over in scan order, so without an explicit sort the needle
// drops on an arbitrary cut — Jake, 2026-09-09: "it plays the wrong songs".
const track = (over: Record<string, unknown>) => ({
  id: 0, title: '', artist: 'Talking Heads', album: 'Fear of Music',
  dateAdded: '2026-01-01T00:00:00.000Z', playCount: 1, ...over,
})

describe('an album candidate is in running order', () => {
  it('sorts by disc, then track number, however the library hands them over', () => {
    const scrambled = [
      track({ id: 30, title: 'Life During Wartime', trackNumber: 5, discNumber: 1 }),
      track({ id: 10, title: 'I Zimbra', trackNumber: 1, discNumber: 1 }),
      track({ id: 50, title: 'Bonus Cut', trackNumber: 1, discNumber: 2 }),
      track({ id: 20, title: 'Mind', trackNumber: 2, discNumber: 1 }),
    ]
    const pool = buildCandidatePool({ tracks: scrambled as never, shelfId: 'mm-picks', todayISO: '2026-09-09' })
    const album = pool.find((a) => a.album === 'Fear of Music')
    assert.ok(album, 'album was grouped')
    assert.deepEqual(album.trackIds, [10, 20, 30, 50])
  })

  it('puts un-numbered tracks last instead of letting them open the record', () => {
    const messy = [
      track({ id: 9, title: 'Zed Untagged' }),
      track({ id: 2, title: 'Second', trackNumber: 2 }),
      track({ id: 1, title: 'Opener', trackNumber: 1 }),
      track({ id: 8, title: 'Alpha Untagged' }),
    ]
    const pool = buildCandidatePool({ tracks: messy as never, shelfId: 'mm-picks', todayISO: '2026-09-09' })
    const album = pool.find((a) => a.album === 'Fear of Music')
    assert.ok(album)
    assert.deepEqual(album.trackIds, [1, 2, 8, 9])
  })
})
