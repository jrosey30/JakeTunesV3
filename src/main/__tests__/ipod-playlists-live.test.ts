// Brief 250: an iPod's playlists are asked again while on screen (focus, every
// 5 minutes while visible, the library-version poll), at most once per device
// per 30 s outside mount, with one timer and one set of listeners for all iPods.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createIpodPlaylistsLive, IPOD_PLAYLISTS_MIN_GAP_MS, IPOD_PLAYLISTS_REFRESH_MS,
} from '../../renderer/ipodPlaylistsLive.ts'

function harness() {
  let t = 1_000_000
  let visible = true
  const asked: Array<[string, string]> = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const wakes = new Set<() => void>()
  const moves = new Set<() => void>()
  const live = createIpodPlaylistsLive({
    refresh: (d, n) => { asked.push([d, n]); return Promise.resolve() },
    now: () => t,
    visible: () => visible,
    every: (fn, ms) => { const tm = { fn, ms, live: true }; timers.push(tm); return () => { tm.live = false } },
    onWake: (fn) => { wakes.add(fn); return () => { wakes.delete(fn) } },
    onLibraryMoved: (fn) => { moves.add(fn); return () => { moves.delete(fn) } },
  })
  return {
    live, asked,
    advance: (ms: number) => { t += ms },
    setVisible: (v: boolean) => { visible = v },
    tick: () => { for (const tm of timers) if (tm.live) tm.fn() },
    wake: () => { for (const f of [...wakes]) f() },
    move: () => { for (const f of [...moves]) f() },
    liveTimers: () => timers.filter((x) => x.live),
    wakes, moves,
  }
}

test('mount asks at once, with a 5-minute timer', () => {
  const h = harness()
  h.live.watch('bc', 'Best of Bandcamp')
  assert.deepEqual(h.asked, [['bc', 'Best of Bandcamp']])
  assert.equal(h.liveTimers().length, 1)
  assert.equal(h.liveTimers()[0].ms, IPOD_PLAYLISTS_REFRESH_MS)
})

test('focus, the timer and the library signal each ask again once the gap has passed', () => {
  const h = harness()
  h.live.watch('bc', 'BC')
  h.advance(IPOD_PLAYLISTS_MIN_GAP_MS)
  h.wake()
  assert.equal(h.asked.length, 2)
  h.advance(IPOD_PLAYLISTS_REFRESH_MS)
  h.tick()
  assert.equal(h.asked.length, 3)
  h.advance(IPOD_PLAYLISTS_MIN_GAP_MS)
  h.move()
  assert.equal(h.asked.length, 4)
})

test('within 30 s of the last ask, focus and the library signal ask nothing', () => {
  const h = harness()
  h.live.watch('bc', 'BC')
  h.advance(IPOD_PLAYLISTS_MIN_GAP_MS - 1)
  h.wake(); h.wake(); h.move(); h.tick()
  assert.equal(h.asked.length, 1)
  h.advance(1)
  h.wake(); h.wake()
  assert.equal(h.asked.length, 2)
})

test('a hidden window asks nothing on the timer; becoming visible asks', () => {
  const h = harness()
  h.live.watch('bc', 'BC')
  h.setVisible(false)
  h.advance(IPOD_PLAYLISTS_REFRESH_MS)
  h.tick()
  h.move()
  assert.equal(h.asked.length, 1)
  h.setVisible(true)
  h.wake()
  assert.equal(h.asked.length, 2)
})

test('every iPod on screen is asked, each on its own gap', () => {
  const h = harness()
  h.live.watch('a', 'A')
  h.advance(20_000)
  h.live.watch('b', 'B')
  h.advance(IPOD_PLAYLISTS_MIN_GAP_MS - 20_000)
  h.wake()
  // a's gap has passed, b's hasn't.
  assert.deepEqual(h.asked.map((x) => x[0]), ['a', 'b', 'a'])
})

test('one timer and one set of listeners for all iPods, gone with the last one', () => {
  const h = harness()
  const offA = h.live.watch('a', 'A')
  const offB = h.live.watch('b', 'B')
  const offA2 = h.live.watch('a', 'A') // the page and the sidebar row
  assert.equal(h.liveTimers().length, 1)
  assert.equal(h.wakes.size, 1)
  assert.equal(h.moves.size, 1)
  offA()
  assert.deepEqual(h.live.watching().sort(), ['a', 'b'])
  offA(); // twice is once
  assert.deepEqual(h.live.watching().sort(), ['a', 'b'])
  offA2()
  offB()
  assert.deepEqual(h.live.watching(), [])
  assert.equal(h.liveTimers().length, 0)
  assert.equal(h.wakes.size, 0)
  assert.equal(h.moves.size, 0)
  h.advance(IPOD_PLAYLISTS_REFRESH_MS)
  const before = h.asked.length
  h.tick(); h.wake(); h.move()
  assert.equal(h.asked.length, before)
  // Watching again starts it again.
  h.live.watch('a', 'A')
  assert.equal(h.liveTimers().length, 1)
})

test('the newest name is the one asked with', () => {
  const h = harness()
  h.live.watch('bc', 'Old name')
  h.live.watch('bc', 'New name')
  h.advance(IPOD_PLAYLISTS_MIN_GAP_MS)
  h.wake()
  assert.deepEqual(h.asked.at(-1), ['bc', 'New name'])
})
