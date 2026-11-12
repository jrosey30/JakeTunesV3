/**
 * homemini is asked to keep ready the streamed songs Jake is likely to tap
 * (2026-11-12), and the asking can never make homemini churn (second review of
 * PR 409: 172 GB written an hour).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createWarmKeeper, warmCandidates, BUILD_AGAIN_MS, BUILDS_PER_PASS, NO_ROOM_REST_MS, TOUCH_AGAIN_MS, WARM_MAX, WARM_PLAYED_DAYS,
} from '../stream-keep-warm.ts'
import type { VariantState } from '../flac-variant.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = 500 * DAY
const colon = (n: number, ext = 'm4a'): string => `:iPod_Control:Music:F01:s${n}.${ext}`
const track = (n: number, playedDaysAgo?: number, ext = 'm4a') => ({ id: n, path: colon(n, ext), ...(playedDaysAgo != null ? { lastPlayedAt: NOW - playedDaysAgo * DAY } : {}) })

describe('warmCandidates', () => {
  it('what the player asked for comes first, then what was played, newest first; nothing twice', () => {
    const tracks = [track(1, 6), track(2, 1), track(3), track(4, WARM_PLAYED_DAYS), track(5, 0.5)]
    assert.deepEqual(warmCandidates(tracks, [colon(3), colon(2), ':iPod_Control:Music:F09:gone.m4a'].map((path) => ({ path, at: NOW })), NOW), [colon(3), colon(2), colon(5), colon(1)])
  })
})

function keeper(states: Record<string, VariantState | null>, over: { askFails?: boolean; wantFails?: boolean; wantReply?: Record<string, VariantState> } = {}) {
  const seen = { asks: [] as string[][], wants: [] as string[][] }
  const k = createWarmKeeper({
    ask: async (ids) => { seen.asks.push(ids); if (over.askFails) return null; return new Map(ids.map((id) => [id, states[id] ?? null])) },
    want: async (ids) => {
      seen.wants.push(ids)
      if (over.wantFails) return null
      return new Map(ids.map((id) => [id, over.wantReply?.[id] ?? (states[id] === 'absent' ? 'building' : states[id] ?? 'building')]))
    },
  })
  const tracks = [track(1, 1), track(2, 2), track(3, 3, 'mp3'), track(4, 30), track(5)]
  const run = (now = NOW, extra: { streamed?: number[]; touched?: string[]; tracks?: typeof tracks } = {}) => k.pass({
    tracks: extra.tracks ?? tracks, touched: (extra.touched ?? [colon(5)]).map((path) => ({ path, at: NOW })), now,
    isStreamed: async (p) => (extra.streamed ?? [1, 2, 3, 4, 5]).some((n) => p.includes(`s${n}.`)),
    needsCopy: (p) => p.endsWith('.m4a'),
  })
  return { run, seen }
}

describe('one pass', () => {
  it('asks first without building, then requests only the absent copies, the loaded-ahead song first', async () => {
    const { run, seen } = keeper({ '5': 'absent', '1': 'ready', '2': 'absent' })
    const r = await run()
    assert.deepEqual(seen.asks, [['5', '1', '2']])
    assert.deepEqual(r.built, ['5', '2'])
    assert.deepEqual(r.touched, ['1'])
    assert.deepEqual(seen.wants, [['5', '2', '1']])
  })
  it('a song still on this Mac, an MP3, and one played a month ago are not asked about', async () => {
    const { run, seen } = keeper({ '2': 'absent' })
    await run(NOW, { streamed: [2, 3, 4] })
    assert.deepEqual(seen.asks, [['2']])
  })
  it('nothing to keep warm asks nothing; no answer builds nothing', async () => {
    const none = keeper({})
    await none.run(NOW, { streamed: [] })
    assert.deepEqual(none.seen.asks, [])
    const silent = keeper({ '1': 'absent' }, { askFails: true })
    assert.deepEqual((await silent.run()).built, [])
    assert.deepEqual(silent.seen.wants, [])
  })
  it('a copy being built, or one homemini refused, is not requested again', async () => {
    const { run, seen } = keeper({ '5': 'building', '1': 'failed', '2': 'waiting' })
    await run()
    assert.deepEqual(seen.wants, [])
  })
  it('at most a few builds a pass, and the list is capped', async () => {
    const tracks = Array.from({ length: 40 }, (_, i) => track(i + 1, 1 + i / 100))
    const states = Object.fromEntries(tracks.map((t) => [String(t.id), 'absent' as const]))
    const { run } = keeper(states)
    const r = await run(NOW, { tracks, touched: [], streamed: tracks.map((t) => t.id) })
    assert.equal(r.built.length, BUILDS_PER_PASS)
    assert.deepEqual(r.built, tracks.slice(0, BUILDS_PER_PASS).map((t) => String(t.id)), 'most recently played first')
    assert.ok(WARM_MAX <= 200)
  })
})

describe('it can’t ask twice for what it just asked for', () => {
  it('a build is requested once per song per 6 hours, however often the copy is found absent', async () => {
    const { run, seen } = keeper({ '5': 'absent' })
    await run(NOW, { streamed: [5] })
    for (let i = 1; i < 100; i++) await run(NOW + i * 90_000, { streamed: [5] })
    assert.equal(seen.wants.length, 1, 'loaded ahead once is one reason, not a new one every pass')
    await run(NOW + BUILD_AGAIN_MS, { streamed: [5], touched: [], tracks: [track(5, 0.1)] })
    assert.equal(seen.wants.length, 2)
  })
  it('unless it was played since: then it is worth one more', async () => {
    const { run, seen } = keeper({ '1': 'absent' })
    await run(NOW, { streamed: [1], touched: [] })
    const playedAgain = [{ id: 1, path: colon(1), lastPlayedAt: NOW + 60_000 }]
    await run(NOW + 90_000, { streamed: [1], touched: [], tracks: playedAgain })
    assert.equal(seen.wants.length, 2)
    await run(NOW + 180_000, { streamed: [1], touched: [], tracks: playedAgain })
    assert.equal(seen.wants.length, 2, 'the same play is not a reason twice')
  })
  it('a request homemini never got is not remembered', async () => {
    const { run, seen } = keeper({ '5': 'absent' }, { wantFails: true })
    await run(NOW, { streamed: [5] })
    await run(NOW + 90_000, { streamed: [5] })
    assert.equal(seen.wants.length, 2)
  })
  it('homemini says no-room: nothing is requested for an hour, then it may ask again', async () => {
    const { run, seen } = keeper({ '5': 'absent', '1': 'absent', '2': 'absent', '6': 'absent' }, { wantReply: { '5': 'no-room' } })
    const first = await run()
    assert.equal(first.noRoom, true)
    const tracks = [track(1, 1), track(2, 2), track(5), track(6, 0.2)]
    await run(NOW + 90_000, { tracks, streamed: [1, 2, 5, 6] })
    await run(NOW + NO_ROOM_REST_MS - 1, { tracks, streamed: [1, 2, 5, 6] })
    assert.equal(seen.wants.length, 1, 'not even for a song it has never asked about')
    await run(NOW + NO_ROOM_REST_MS, { tracks, streamed: [1, 2, 5, 6] })
    assert.equal(seen.wants.length, 2)
    assert.deepEqual(seen.wants[1], ['6'], 'and only for the song it had not asked about')
  })
  it('a ready copy is marked as in use once per two hours', async () => {
    const { run, seen } = keeper({ '1': 'ready' })
    for (let i = 0; i < 50; i++) await run(NOW + i * 90_000, { streamed: [1], touched: [] })
    assert.equal(seen.wants.length, 1)
    await run(NOW + TOUCH_AGAIN_MS, { streamed: [1], touched: [], tracks: [track(1, 0.5)] })
    assert.equal(seen.wants.length, 2)
  })
})

/**
 * The reviewer's scene: 150 wanted, a pass every 90 s, and a homemini whose
 * cache holds fewer than that. Two homeminis: the one that was live when the
 * review ran (it builds whenever one more fits after letting the least
 * recently used go), and the one with JakeTunesMobile #775 (a copy asked for
 * lately is never let go for another build; it answers no-room).
 */
function homemini(capacity: number, protects: boolean) {
  const cache = new Map<string, number>()   // id → last used
  let builds = 0
  const stateOf = (id: string): VariantState => (cache.has(id) ? 'ready' : 'absent')
  return {
    builds: () => builds,
    ready: () => cache.size,
    ask: async (ids: string[]) => new Map(ids.map((id) => [id, stateOf(id)])),
    want: (now: number) => async (ids: string[]) => {
      const reply = new Map<string, VariantState>()
      for (const id of ids) {
        if (cache.has(id)) { cache.set(id, now); reply.set(id, 'ready'); continue }
        if (cache.size >= capacity) {
          const oldest = [...cache].sort((a, b) => a[1] - b[1])[0]
          if (protects && now - oldest[1] < 6 * 60 * 60 * 1000) { reply.set(id, 'no-room'); continue }
          cache.delete(oldest[0])
        }
        cache.set(id, now)
        builds++
        reply.set(id, 'building')
      }
      return reply
    },
  }
}

async function warmSim(capacity: number, protects: boolean, hours: number) {
  const h = homemini(capacity, protects)
  let now = NOW
  const keeperUnderTest = createWarmKeeper({ ask: h.ask, want: (ids) => h.want(now)(ids) })
  const tracks = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, path: colon(i + 1), lastPlayedAt: NOW - (i + 1) * 60_000 }))
  const perHour: number[] = []
  for (let hour = 0; hour < hours; hour++) {
    const before = h.builds()
    for (let p = 0; p < 40; p++) {
      now = NOW + hour * 3_600_000 + p * 90_000
      await keeperUnderTest.pass({ tracks, touched: [], now, isStreamed: async () => true, needsCopy: () => true })
    }
    perHour.push(h.builds() - before)
  }
  return { perHour, total: h.builds(), ready: h.ready() }
}

describe('150 wanted against a homemini that holds fewer', () => {
  for (const [label, capacity] of [['1 GB', 20], ['3.8 GB', 76], ['24 GB', 480]] as const) {
    it(`${label} of room, homemini as it is now: each copy that fits is built once, then nothing`, async () => {
      const r = await warmSim(capacity, true, 12)
      assert.ok(r.total <= Math.min(150, capacity), `${r.total} builds where ${Math.min(150, capacity)} fit`)
      assert.equal(r.ready, Math.min(150, capacity))
      assert.deepEqual(r.perHour.slice(2), new Array(10).fill(0), `builds per hour: ${r.perHour.join(',')}`)
    })
    it(`${label} of room, a homemini that still evicts for every ask: the desktop alone keeps it bounded`, async () => {
      const r = await warmSim(capacity, false, 12)
      // One request per song per 6 hours: at most 150 in any 6 hours, where the first version made 3,000 an hour.
      assert.ok(r.total <= 300, `${r.total} builds in 12 hours`)
      assert.ok(Math.max(...r.perHour) <= 150, `builds per hour: ${r.perHour.join(',')}`)
      const quiet = r.perHour.filter((n) => n === 0).length
      assert.ok(quiet >= 8, `only ${quiet} of 12 hours with no build: ${r.perHour.join(',')}`)
    })
  }
})
