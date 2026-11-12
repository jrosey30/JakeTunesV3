/**
 * homemini is asked to keep ready the streamed songs Jake is likely to tap
 * (2026-11-12): what the player asked for lately, then what was played lately.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { keepStreamedWarm, warmCandidates, WARM_MAX, WARM_PLAYED_DAYS } from '../stream-keep-warm.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 500 * DAY
const colon = (n: number, ext = 'm4a'): string => `:iPod_Control:Music:F01:s${n}.${ext}`
const track = (n: number, playedDaysAgo?: number, ext = 'm4a') => ({ id: n, path: colon(n, ext), ...(playedDaysAgo != null ? { lastPlayedAt: NOW - playedDaysAgo * DAY } : {}) })

describe('warmCandidates', () => {
  it('what the player asked for comes first, then what was played, newest first; nothing twice', () => {
    const tracks = [track(1, 6), track(2, 1), track(3), track(4, WARM_PLAYED_DAYS), track(5, 0.5)]
    assert.deepEqual(warmCandidates(tracks, [colon(3), colon(2), ':iPod_Control:Music:F09:gone.m4a'], NOW), [colon(3), colon(2), colon(5), colon(1)])
  })
})

describe('keepStreamedWarm', () => {
  const run = async (over: { streamed?: number[]; max?: number; wantFails?: boolean } = {}) => {
    const wanted: Array<Array<string | number>> = []
    const tracks = [track(1, 1), track(2, 2), track(3, 3, 'mp3'), track(4, 30), track(5)]
    const ids = await keepStreamedWarm({
      tracks, touched: [colon(5)], now: NOW, max: over.max,
      isStreamed: async (p) => (over.streamed ?? [1, 2, 3, 4, 5]).some((n) => p.includes(`s${n}.`)),
      needsCopy: (p) => p.endsWith('.m4a'),
      want: async (list) => { wanted.push(list); if (over.wantFails) throw new Error('net') },
    })
    return { ids, wanted }
  }
  it('asks for the loaded-ahead song and the played ones, in one request', async () => {
    const { ids, wanted } = await run()
    assert.deepEqual(ids, [5, 1, 2])
    assert.deepEqual(wanted, [[5, 1, 2]])
  })
  it('a song still on this Mac is not asked for: homemini’s cache is not spent on it', async () => {
    assert.deepEqual((await run({ streamed: [2] })).ids, [2])
  })
  it('a song this Mac plays as it is (an MP3) and one played a month ago are not asked for', async () => {
    const { ids } = await run()
    assert.equal(ids.includes(3), false)
    assert.equal(ids.includes(4), false)
  })
  it('nothing to keep warm asks nothing; a failed ask is not an error; the list is capped', async () => {
    assert.deepEqual((await run({ streamed: [] })).wanted, [])
    assert.deepEqual((await run({ wantFails: true })).ids, [5, 1, 2])
    assert.deepEqual((await run({ max: 2 })).ids, [5, 1])
    assert.ok(WARM_MAX <= 200)
  })
})
