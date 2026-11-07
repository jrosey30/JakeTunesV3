import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityTrackCanBoard,
  pickReplacementTracks,
  planListOnlyBoarding,
  queueActivityCandidates,
  resolvePickedTracks,
  whyActivityTrackCannotBoard,
} from '../activity-fill.ts'
import { ipodFirmwareWillList, ipodPlayableDestPath, needsIpodAlacTranscode } from '../ipod-reconcile.ts'
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
    assert.equal(activityTrackCanBoard(song({ id: 5, path: ':F00:x.ogg', codec: 'vorbis' })), false)
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
        path: i <= 15 ? `:iPod_Control:Music:F00:t${i}.ogg` : `:iPod_Control:Music:F00:t${i}.m4a`,
        codec: i <= 15 ? 'vorbis' : 'alac',
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
      primary.push(song({ id: i, artist: `Bad${i}`, path: `:F00:t${i}.ogg`, codec: 'vorbis' }))
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
      song({ id: 2, path: ':F00:x.ogg', codec: 'vorbis' }),
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
        path: i <= 15 ? `:iPod_Control:Music:F00:t${i}.ogg` : `:iPod_Control:Music:F00:t${i}.m4a`,
        codec: i <= 15 ? 'vorbis' : 'alac',
      }))
    }
    const r = selectWorkoutSyncSet(tracks, { target: 1000, seed: 1 })
    assert.equal(r.trackIds.length, 1000)
    assert.equal(r.shortfall, 0)
    assert.ok(r.trackIds.every((id) => id > 15), 'unplayable rows must not occupy a 1000 slot')
    assert.ok(r.reserveIds.length > 0, 'leftover eligible tracks become the replacement pool')
  })

  it('surfaces a 15-song shortfall when only 985 tracks can land', () => {
    const tracks: WorkoutTrack[] = []
    for (let i = 1; i <= 985; i++) tracks.push(song({ id: i, artist: `Artist ${i}` }))
    for (let i = 986; i <= 1000; i++) {
      tracks.push(song({
        id: i, artist: `Bad ${i}`, path: `:iPod_Control:Music:F00:t${i}.ogg`, codec: 'vorbis',
      }))
    }
    const r = selectWorkoutSyncSet(tracks, { target: 1000, seed: 1 })
    assert.equal(r.trackIds.length, 985)
    assert.equal(r.shortfall, 15)
    assert.equal(r.requested, 1000)
  })
})

describe('FLAC primaries board (2026-11-07: 74 of iPod EVIL\'s 500 were left off as "unplayable")', () => {
  it('a .flac with codec null boards, and goes to the ALAC conversion as an .m4a on the card', () => {
    const flac = song({ id: 12001, path: ':iPod_Control:Music:F01:imported_12001.flac', codec: null as unknown as string })
    assert.equal(activityTrackCanBoard(flac), true)
    assert.equal(whyActivityTrackCannotBoard(flac), null)
    // the engine's routing: transcode, card name .m4a, which the firmware lists
    assert.equal(needsIpodAlacTranscode(flac.path), true)
    const dest = ipodPlayableDestPath(String(flac.path))
    assert.match(dest, /\.m4a$/)
    assert.equal(ipodFirmwareWillList({ title: flac.title, artist: flac.artist, path: dest }), true)
  })

  it('what truly cannot go on still cannot, with a plain reason', () => {
    assert.match(String(whyActivityTrackCannotBoard(song({ id: 1, path: ':F00:x.ogg' }))), /file type \(\.ogg\)/)
    assert.match(String(whyActivityTrackCannotBoard(song({ id: 2, audioMissing: true }))), /missing/)
    assert.match(String(whyActivityTrackCannotBoard(song({ id: 3, artist: '' }))), /no title or no artist/)
    assert.match(String(whyActivityTrackCannotBoard(song({ id: 4, title: 'HIDE ALL YOUR RECORDS SEGUE', duration: 61107 }))), /skit, intro or segue/)
  })
})

describe('planListOnlyBoarding — a list-only iPod gets its own list and nothing else', () => {
  it('500 on the list with one skit lands 499 and names the one left off', () => {
    const list = []
    for (let i = 0; i < 500; i++) {
      list.push(song({ id: 5000 + i, path: i % 7 === 0 ? `:F01:t${i}.flac` : `:F01:t${i}.m4a` }))
    }
    list[123] = song({ id: 12813, title: 'HIDE ALL YOUR RECORDS SEGUE', duration: 61107, genre: 'Hardcore Punk' })
    const r = planListOnlyBoarding(list, 500)
    assert.equal(r.target, 499)
    assert.equal(r.pool.length, 499)
    assert.deepEqual(r.leftOff.map((l) => l.id), [12813])
    assert.match(r.leftOff[0].why, /segue/)
    assert.ok(r.pool.every((t) => Number(t.id) >= 5000), 'nothing outside the list')
  })

  it('a list bigger than the size keeps its order and stops at the size', () => {
    const list = [1, 2, 3, 4, 5].map((id) => song({ id }))
    const r = planListOnlyBoarding(list, 3)
    assert.deepEqual(r.pool.map((t) => t.id), [1, 2, 3])
    assert.equal(r.leftOff.length, 0)
  })
})

describe('pickReplacementTracks — the Original\'s last resort is most-loved, not lowest id', () => {
  it('ranks starred, then most played; never library (id) order', () => {
    const library = [
      song({ id: 0, rating: 0, playCount: 0 }),
      song({ id: 1, rating: 0, playCount: 2 }),
      song({ id: 2, rating: 0, playCount: 0 }),
      song({ id: 900, rating: 5, playCount: 1 }),
      song({ id: 901, rating: 0, playCount: 40 }),
      song({ id: 902, rating: 5, playCount: 30 }),
    ]
    const picked = pickReplacementTracks(library, new Set(), 3)
    assert.deepEqual(picked.map((t) => t.id), [902, 900, 901])
  })

  it('a FLAC library row is a candidate too', () => {
    const picked = pickReplacementTracks([song({ id: 7, path: ':F00:x.flac', rating: 5 })], new Set(), 1)
    assert.deepEqual(picked.map((t) => t.id), [7])
  })
})
