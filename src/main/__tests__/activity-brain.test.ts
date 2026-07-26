import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeActivityBrainFit, percentile } from '../activity-brain.ts'
import { selectWorkoutSyncSet, type WorkoutTrack } from '../workout-sync.ts'

function vec(a: number[]): Float32Array { return Float32Array.from(a) }

describe('computeActivityBrainFit', () => {
  it('scores tracks near Jake’s taste corners higher than strangers', () => {
    const embById = new Map<number, Float32Array>()
    // 25 taste exemplars clustered near [1,0,0,0]
    const exemplarIds: number[] = []
    for (let i = 0; i < 25; i++) {
      const id = 100 + i
      embById.set(id, vec([1, 0.02 * (i % 3), 0, 0]))
      exemplarIds.push(id)
    }
    // eligible: one hugging the taste corner, one orthogonal stranger
    embById.set(1, vec([0.98, 0.05, 0, 0]))   // near taste
    embById.set(2, vec([0, 0, 0, 1]))          // stranger
    const r = computeActivityBrainFit({ eligibleIds: [1, 2], embById, exemplarIds })
    assert.equal(r.usable, true)
    assert.ok((r.tasteById.get(1) ?? 0) > (r.tasteById.get(2) ?? 1), 'near-taste beats stranger')
    assert.ok((r.tasteById.get(1) ?? 0) > 0.8, 'near-taste cosine is high')
  })

  it('is unusable with too few exemplar embeddings (falls back to heuristics)', () => {
    const embById = new Map<number, Float32Array>([[1, vec([1, 0, 0, 0])]])
    const r = computeActivityBrainFit({ eligibleIds: [1], embById, exemplarIds: [] })
    assert.equal(r.usable, false)
    assert.equal(r.fitById.size, 0)
  })

  it('blends the context query when supplied', () => {
    const embById = new Map<number, Float32Array>()
    const exemplarIds: number[] = []
    for (let i = 0; i < 25; i++) { const id = 100 + i; embById.set(id, vec([1, 0, 0, 0])); exemplarIds.push(id) }
    // asymmetric: taste cosine (vs [1,0,0,0]) = 0.6, ctx cosine (vs [0,1,0,0]) = 0.8
    embById.set(1, vec([0.6, 0.8, 0, 0]))
    const withCtx = computeActivityBrainFit({ eligibleIds: [1], embById, exemplarIds, queryVec: vec([0, 1, 0, 0]) })
    const noCtx = computeActivityBrainFit({ eligibleIds: [1], embById, exemplarIds })
    // blend (0.6·0.6 + 0.4·0.8 = 0.68) must differ from taste-only (0.6)
    assert.ok(Math.abs((withCtx.fitById.get(1) ?? 0) - (noCtx.fitById.get(1) ?? 0)) > 0.05)
  })

  it('skips tracks with no embedding rather than flooring them', () => {
    const embById = new Map<number, Float32Array>()
    const exemplarIds: number[] = []
    for (let i = 0; i < 25; i++) { const id = 100 + i; embById.set(id, vec([1, 0, 0, 0])); exemplarIds.push(id) }
    const r = computeActivityBrainFit({ eligibleIds: [1, 2], embById, exemplarIds })  // 1,2 have no vec
    assert.equal(r.tasteById.has(1), false)
    assert.equal(r.fitById.has(1), false)
  })
})

describe('percentile', () => {
  it('returns the p-th value of a sorted list', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 0), 1)
    assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3)
  })
})

describe('selectWorkoutSyncSet — taste floor + brain term', () => {
  const mk = (id: number): WorkoutTrack => ({
    id, title: `T${id}`, artist: `A${id}`, album: `Al${id}`, genre: 'rock', bpm: 120, duration: 200000,
  })

  it('drops bottom-taste tracks from the set when the pool is big enough', () => {
    const tracks: WorkoutTrack[] = []
    const tasteById = new Map<number, number>()
    const brainFitById = new Map<number, number>()
    // 100 tracks: ids 0-79 high taste (0.5), ids 80-99 low taste (0.1)
    for (let i = 0; i < 100; i++) {
      tracks.push(mk(i))
      const t = i < 80 ? 0.5 : 0.1
      tasteById.set(i, t)
      brainFitById.set(i, t)
    }
    const r = selectWorkoutSyncSet(tracks, { target: 50, tasteById, brainFitById, tasteFloorPct: 0.2, seed: 1 })
    assert.equal(r.trackIds.length, 50)
    // none of the low-taste ids (80-99) should be in a 50-of-100 pick with a 20% floor
    const lowPicked = r.trackIds.filter((id) => id >= 80)
    assert.equal(lowPicked.length, 0, 'no bottom-taste tracks selected')
  })

  it('still hits exactly target even if the floor would starve it', () => {
    const tracks: WorkoutTrack[] = []
    const tasteById = new Map<number, number>()
    for (let i = 0; i < 30; i++) { tracks.push(mk(i)); tasteById.set(i, i < 5 ? 0.5 : 0.05) }
    // target 25 but only 5 above a harsh floor → backfill must still reach 25
    const r = selectWorkoutSyncSet(tracks, { target: 25, tasteById, tasteFloorPct: 0.6, seed: 1 })
    assert.equal(r.trackIds.length, 25, 'target guaranteed via backfill')
  })

  it('behaves exactly like before when no brain data is supplied', () => {
    const tracks: WorkoutTrack[] = []
    for (let i = 0; i < 100; i++) tracks.push(mk(i))
    const r = selectWorkoutSyncSet(tracks, { target: 40, seed: 7 })
    assert.equal(r.trackIds.length, 40)
  })
})
