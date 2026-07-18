import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreWorkoutTrack,
  selectWorkoutSyncSet,
  isAlacCodec,
  type WorkoutTrack,
} from '../workout-sync.ts'
import { activityScoreHints, formatActivityContextForPrompt, type ActivityBrief } from '../activity-context-core.ts'

function t(partial: Partial<WorkoutTrack> & { id: number }): WorkoutTrack {
  return { title: `T${partial.id}`, artist: 'Artist', ...partial }
}

const runBrief: ActivityBrief = {
  activity: 'run', intensity: 'hard', setting: 'city', place: 'Brooklyn', social: 'solo',
}

describe('isAlacCodec', () => {
  it('recognizes alac variants', () => {
    assert.equal(isAlacCodec('alac'), true)
    assert.equal(isAlacCodec('aac'), false)
  })
})

describe('activityScoreHints', () => {
  it('leans high BPM for hard run; denser genres when cold', () => {
    const hot = activityScoreHints(runBrief, null)
    assert.equal(hot.bpmBias, 'high')
    const cold = activityScoreHints(runBrief, {
      tempF: 28, condition: 'Snow', description: 'light snow', placeLabel: 'Brooklyn',
    })
    assert.ok(cold.genreBoosts.some((g) => /techno|hip-hop|metal|industrial/i.test(g)))
    assert.match(cold.weatherNote, /cold|harsh/i)
  })

  it('bopping around stays mid/mixed — everyday hang / commute energy', () => {
    const bop: ActivityBrief = {
      activity: 'bop', intensity: 'medium', setting: 'city', place: 'Brooklyn', social: 'solo',
    }
    const hints = activityScoreHints(bop, null)
    assert.equal(hints.bpmBias, 'mid')
    assert.ok(hints.genreBoosts.some((g) => /hip-hop|indie|soul|funk/i.test(g)))
  })
})

describe('formatActivityContextForPrompt — bop', () => {
  it('labels Bopping Around for the AI brain', () => {
    const block = formatActivityContextForPrompt({
      brief: {
        activity: 'bop', intensity: 'easy', setting: 'city', place: 'Brooklyn', social: 'solo',
      },
      weather: null,
      updatedAt: new Date().toISOString(),
    })
    assert.match(block, /Bopping Around/)
    assert.match(block, /everyday listening|commuting|hanging/i)
  })
})

describe('formatActivityContextForPrompt', () => {
  it('includes place and weather for the AI brain', () => {
    const block = formatActivityContextForPrompt({
      brief: runBrief,
      weather: { tempF: 42, condition: 'Clouds', description: 'overcast clouds', placeLabel: 'Brooklyn, NY' },
      setName: 'Cold Run Cuts',
      updatedAt: new Date().toISOString(),
    })
    assert.match(block, /ACTIVITY CONTEXT/)
    assert.match(block, /Brooklyn/)
    assert.match(block, /42°F/)
    assert.match(block, /Cold Run Cuts/)
  })
})

describe('scoreWorkoutTrack', () => {
  it('favors running BPM + workout genres over ballads', () => {
    const run = scoreWorkoutTrack(t({ id: 1, genre: 'House', bpm: 155, playCount: 5, codec: 'alac' }), undefined, runBrief)
    const ballad = scoreWorkoutTrack(t({ id: 2, genre: 'Folk', bpm: 70, playCount: 5 }), undefined, runBrief)
    assert.ok(run > ballad)
  })

  it('boosts cold-weather denser genres for ski', () => {
    const ski: ActivityBrief = { activity: 'ski', intensity: 'hard', setting: 'mountain', place: 'Aspen', social: 'friends' }
    const wx = { tempF: 18, condition: 'Snow', description: 'snow', placeLabel: 'Aspen' }
    const techno = scoreWorkoutTrack(t({ id: 1, genre: 'Techno', bpm: 140 }), undefined, ski, wx)
    const folk = scoreWorkoutTrack(t({ id: 2, genre: 'Folk', bpm: 90 }), undefined, ski, wx)
    assert.ok(techno > folk)
  })
})

describe('selectWorkoutSyncSet', () => {
  it('returns up to target with rotation', () => {
    const tracks: WorkoutTrack[] = []
    for (let i = 0; i < 50; i++) {
      tracks.push(t({
        id: i + 1,
        artist: `Artist ${i % 10}`,
        genre: 'Electronic',
        bpm: 140 + (i % 20),
        playCount: 3,
        codec: i % 3 === 0 ? 'alac' : 'aac',
      }))
    }
    const first = selectWorkoutSyncSet(tracks, { target: 10, seed: 1, brief: runBrief })
    const second = selectWorkoutSyncSet(tracks, {
      target: 10, seed: 2, brief: runBrief, previousIds: first.trackIds,
    })
    assert.equal(first.trackIds.length, 10)
    const overlap = second.trackIds.filter((id) => first.trackIds.includes(id)).length
    assert.ok(overlap < 5, `expected rotation, overlap=${overlap}`)
  })
})
