import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveShopSelection, libraryRevisionOf } from '../record-shop-resolve.ts'

const LIB = [
  { id: 1, title: 'Born Under Punches (The Heat Goes On)', artist: 'Talking Heads', album: 'Remain in Light', durationSec: 346 },
  { id: 2, title: 'Crosseyed and Painless', artist: 'Talking Heads', album: 'Remain in Light', durationSec: 285 },
  { id: 3, title: 'Helicopter', artist: 'XTC', album: 'Drums and Wires', durationSec: 235 },
]
const tracks = [
  { song: 'Born Under Punches (The Heat Goes On)', trackNumber: 1, durationSecs: 346 },
  { song: 'Crosseyed and Painless', trackNumber: 2, durationSecs: 285 },
  { song: 'The Great Curve', trackNumber: 3, durationSecs: 386 },
]
const deps = (found: boolean) => ({
  albumTracks: async (ref: number | { artist?: string; album: string }) => found
    ? { ok: true, tracks, album: 'Remain in Light', artist: 'Talking Heads', releaseYear: 1980, trackCount: 3, collectionId: typeof ref === 'number' ? ref : 777 }
    : { ok: false, tracks: [] },
  library: async () => LIB,
})

describe('main resolves a shop item: catalogue identity + ownership by recording identity', () => {
  it('a record: the tracklist behind the edition, and 2 of 3 owned by title + runtime', async () => {
    const r = await resolveShopSelection({ kind: 'release', artist: 'Talking Heads', album: 'Remain in Light' }, deps(true))
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.selection.kind, 'release'); assert.equal(r.selection.revision, 'itunes:collection:777')
    assert.equal(r.selection.kind === 'release' && r.selection.request.tracks.length, 3)
    assert.equal(r.ownership.status, 'partial')
    assert.equal(r.ownership.status !== 'unknown' && r.ownership.owned, 2)
    assert.deepEqual(r.ownership.status !== 'unknown' && r.ownership.matches.map((m) => m.libraryTrackId), [1, 2])
    assert.equal(r.libraryRevision, libraryRevisionOf(LIB))
  })
  it('a chosen edition is asked by its id, and the verdict is stamped with that revision', async () => {
    const r = await resolveShopSelection({ kind: 'release', artist: 'Talking Heads', album: 'Remain in Light (Deluxe Version)', collectionId: 9990003 }, deps(true))
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.selection.revision, 'itunes:collection:9990003')
    assert.equal(r.ownership.status !== 'unknown' && r.ownership.selectionRevision, 'itunes:collection:9990003')
  })
  it('no tracklist: an honest error, never a guessed verdict', async () => {
    const r = await resolveShopSelection({ kind: 'release', artist: 'Nobody', album: 'Nothing' }, deps(false))
    assert.deepEqual(r, { ok: false, error: 'tracklist-unavailable' })
  })
  it('a song: unknown without a runtime (a title is only text); owned by identity with one', async () => {
    const noRuntime = await resolveShopSelection({ kind: 'recording', artist: 'XTC', title: 'Helicopter' }, deps(true))
    assert.ok(noRuntime.ok); if (!noRuntime.ok) return
    assert.equal(noRuntime.ownership.status, 'unknown')
    const timed = await resolveShopSelection({ kind: 'recording', artist: 'XTC', title: 'Helicopter', album: 'Drums and Wires', durationSec: 236 }, deps(true))
    assert.ok(timed.ok); if (!timed.ok) return
    assert.equal(timed.ownership.status, 'complete')
    assert.deepEqual(timed.ownership.status !== 'unknown' && timed.ownership.matches, [{ position: 0, libraryTrackId: 3 }])
    const wrongLength = await resolveShopSelection({ kind: 'recording', artist: 'XTC', title: 'Helicopter', durationSec: 300 }, deps(true))
    assert.ok(wrongLength.ok); if (!wrongLength.ok) return
    assert.equal(wrongLength.ownership.status, 'none')
  })
  it('library revision moves when a row is added', () => {
    assert.notEqual(libraryRevisionOf(LIB), libraryRevisionOf([...LIB, { id: 4, title: 'x' }]))
  })
})
