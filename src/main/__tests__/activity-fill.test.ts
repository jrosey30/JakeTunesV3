import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityTrackCanBoard,
  pickReplacementTracks,
  queueActivityCandidates,
  resolvePickedTracks,
} from '../activity-fill.ts'
import { selectWorkoutSyncSet, type WorkoutTrack } from '../workout-sync.ts'

function song(partial: Partial<WorkoutTrack> & { id: number }): WorkoutTrack {
  return {
    title: `T${partial.id}`,
    artist: `Artist ${partial.id}`,
    path: `:iPod_Control:Music:F00:t${partial.id}.m4a`,
    duration: 200000,
    genre: 'Electronic',
    bpm: 140,
    playCount: 3,
    ...partial,
  }
}

describe('activityTrackCanBoard', () => {
  it('rejects skits, blanks, missing paths, and firmware-unlistable rows', () => {
    assert.equal(activityTrackCanBoard(song({ id: 1 })), true)
    assert.equal(activityTrackCanBoard(song({ id: 2, title: 'Intro' })), false)
    assert.equal(activityTrackCanBoard(song({ id: 3, title: '' })), false)
    assert.equal(activityTrackCanBoard(song({ id: 4, path: '' })), false)
    assert.equal(activityTrackCanBoard(song({ id: 5, path: ':F00:x.flac', codec: 'flac' })), false)
    assert.equal(activityTrackCanBoard(song({ id: 6, audioMissing: true })), false)
  })
})

describe('fill-to-N — shortfall and replacement counting', () => {
  it('replaces 15 unlistable primary rows from reserve so 1000 still means 1000', () => {
    const primary = []
    const reserve = []
    for (let i = 1; i <= 1000; i++) {
      primary.push(song({
        id: i,
        artist: `A${i}`,
        path: i <= 15 ? `:iPod_Control:Music:F00:t${i}.flac` : `:iPod_Control:Music:F00:t${i}.m4a`,
        codec: i <= 15 ? 'flac' : 'alac',
      }))
    }
    for (let i = 2001; i <= 2040; i++) {
      reserve.push(song({ id: i, artist: `R${i}` }))
    }
    const { queue, shortfall } = queueActivityCandidates({
      requested: 1000,
      primary,
      reserve,
    })
    assert.equal(shortfall, 0)
    assert.ok(queue.length >= 1000, `queue is a copy pool, got ${queue.length}`)
    const boarded = queue.slice(0, 1000)
    assert.equal(boarded.filter((t) => Number(t.id) <= 15).length, 0)
    assert.equal(boarded.filter((t) => Number(t.id) >= 2001).length, 15)
  })

  it('reports a real shortfall when the library has no more eligible tracks', () => {
    const primary = []
    for (let i = 1; i <= 985; i++) primary.push(song({ id: i, artist: `A${i}` }))
    for (let i = 986; i <= 1000; i++) {
      primary.push(song({ id: i, artist: `Bad${i}`, path: `:F00:t${i}.flac`, codec: 'flac' }))
    }
    const { queue, shortfall } = queueActivityCandidates({ requested: 1000, primary })
    assert.equal(queue.length, 985)
    assert.equal(shortfall, 15)
  })

  it('resolves vanished primary ids from reserve (string/number id mismatch)', () => {
    const tracks = [1, 2, 3, 20, 21].map((id) => song({ id, artist: `A${id}` }))
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const r = resolvePickedTracks(['1', '2', '999'], byId, [20, 21], 3)
    assert.deepEqual(r.tracks.map((t) => t.id), [1, 2, 20])
    assert.equal(r.shortfall, 0)
    assert.equal(r.replaced, 1)
  })

  it('pickReplacementTracks skips concert-owned and unlistable library rows', () => {
    const library = [
      song({ id: 1 }),
      song({ id: 2, path: ':F00:x.flac', codec: 'flac' }),
      song({ id: 3 }),
      song({ id: 4 }),
    ]
    const picked = pickReplacementTracks(library, new Set([1]), 2, new Set([3]))
    assert.deepEqual(picked.map((t) => t.id), [4])
  })
})

describe('selectWorkoutSyncSet — unlistable rows cannot eat an N slot', () => {
  it('fills 1000 from a pool that includes 15 firmware-unlistable tracks', () => {
    const tracks: WorkoutTrack[] = []
    for (let i = 1; i <= 1100; i++) {
      tracks.push(song({
        id: i,
        artist: `Artist ${i}`,
        path: i <= 15 ? `:iPod_Control:Music:F00:t${i}.flac` : `:iPod_Control:Music:F00:t${i}.m4a`,
        codec: i <= 15 ? 'flac' : 'alac',
      }))
    }
    const r = selectWorkoutSyncSet(tracks, { target: 1000, seed: 1 })
    assert.equal(r.trackIds.length, 1000)
    assert.equal(r.shortfall, 0)
    assert.ok(r.trackIds.every((id) => id > 15), 'flac rows must not occupy a 1000 slot')
    assert.ok(r.reserveIds.length > 0, 'leftover eligible tracks become the replacement pool')
  })

  it('surfaces a 15-song shortfall when only 985 tracks can land', () => {
    const tracks: WorkoutTrack[] = []
    for (let i = 1; i <= 985; i++) tracks.push(song({ id: i, artist: `Artist ${i}` }))
    for (let i = 986; i <= 1000; i++) {
      tracks.push(song({
        id: i, artist: `Bad ${i}`, path: `:iPod_Control:Music:F00:t${i}.flac`, codec: 'flac',
      }))
    }
    const r = selectWorkoutSyncSet(tracks, { target: 1000, seed: 1 })
    assert.equal(r.trackIds.length, 985)
    assert.equal(r.shortfall, 15)
    assert.equal(r.requested, 1000)
  })
})
