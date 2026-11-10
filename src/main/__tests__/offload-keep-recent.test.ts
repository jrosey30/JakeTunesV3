/**
 * What Jake just got or just played stays on this Mac (2026-11-10).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecentKeep, colonFromAbs, createPlayerTouches, keepWindows, recentReason, whenMs,
  KEEP_ADDED_DAYS, KEEP_PLAYED_DAYS, PLAYER_TOUCH_MS, ROOMY_FREE_BYTES, TIGHT_DAYS,
} from '../offload-keep-recent.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-10T13:18:00.000Z')
const GB = 1024 ** 3
const roomy = keepWindows(251 * GB)

describe('keepWindows', () => {
  it('14 days added / 7 played with room; 2 days each when the disk is nearly full or unknown', () => {
    assert.deepEqual(roomy, { addedMs: KEEP_ADDED_DAYS * DAY, playedMs: KEEP_PLAYED_DAYS * DAY, roomy: true })
    assert.deepEqual(keepWindows(ROOMY_FREE_BYTES), roomy)
    const tight = { addedMs: TIGHT_DAYS * DAY, playedMs: TIGHT_DAYS * DAY, roomy: false }
    assert.deepEqual(keepWindows(ROOMY_FREE_BYTES - 1), tight)
    assert.deepEqual(keepWindows(0), tight)
    assert.deepEqual(keepWindows(Number.NaN), tight)
  })
})

describe('recentReason', () => {
  it('Transistor, imported five minutes before the queue reached it, stays', () => {
    assert.equal(recentReason({ dateAdded: '2026-11-10T13:13:04.643Z', lastPlayedAt: undefined }, NOW, roomy), 'added')
  })
  it('the edges: one ms inside the window stays, the window itself does not', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    assert.equal(recentReason({ dateAdded: iso(NOW - 14 * DAY + 1) }, NOW, roomy), 'added')
    assert.equal(recentReason({ dateAdded: iso(NOW - 14 * DAY) }, NOW, roomy), null)
    assert.equal(recentReason({ dateAdded: iso(NOW - 400 * DAY), lastPlayedAt: NOW - 7 * DAY + 1 }, NOW, roomy), 'played')
    assert.equal(recentReason({ dateAdded: iso(NOW - 400 * DAY), lastPlayedAt: NOW - 7 * DAY }, NOW, roomy), null)
  })
  it('a nearly full disk keeps only the last 2 days', () => {
    const tight = keepWindows(10 * GB)
    assert.equal(recentReason({ dateAdded: new Date(NOW - 3 * DAY).toISOString() }, NOW, tight), null)
    assert.equal(recentReason({ dateAdded: new Date(NOW - 1 * DAY).toISOString() }, NOW, tight), 'added')
    assert.equal(recentReason({ lastPlayedAt: NOW - 3 * DAY }, NOW, tight), null)
  })
  it('no date, a bad date and zero are not recent; a date in the future is', () => {
    for (const t of [{}, { dateAdded: '' }, { dateAdded: 'yesterday-ish' }, { lastPlayedAt: 0 }, { lastPlayedAt: 'x' }, { dateAdded: null, lastPlayedAt: null }]) {
      assert.equal(recentReason(t, NOW, roomy), null, JSON.stringify(t))
    }
    assert.equal(recentReason({ dateAdded: new Date(NOW + DAY).toISOString() }, NOW, roomy), 'added')
  })
  it('reads both shapes the library uses', () => {
    assert.equal(whenMs('2026-11-10T13:13:04.643Z'), Date.parse('2026-11-10T13:13:04.643Z'))
    assert.equal(whenMs(1793502305000), 1793502305000)
    assert.equal(whenMs('1793502305000'), 1793502305000)
    assert.equal(whenMs(-5), null)
  })
})

describe('buildRecentKeep', () => {
  it('names the recent songs by their library path, and nothing else', () => {
    const keep = buildRecentKeep([
      { path: ':iPod_Control:Music:F21:imported_14921.m4a', dateAdded: '2026-11-10T13:13:04.643Z' },
      { path: ':iPod_Control:Music:F01:old.m4a', dateAdded: '2024-01-01T00:00:00.000Z' },
      { path: ':iPod_Control:Music:F02:played.m4a', dateAdded: '2024-01-01T00:00:00.000Z', lastPlayedAt: NOW - DAY },
      { dateAdded: '2026-11-10T13:13:04.643Z' },
      { path: '', dateAdded: '2026-11-10T13:13:04.643Z' },
    ], NOW, roomy)
    assert.deepEqual([...keep], [[':iPod_Control:Music:F21:imported_14921.m4a', 'added'], [':iPod_Control:Music:F02:played.m4a', 'played']])
  })
})

describe('what the player asked for', () => {
  it('a song the player loaded is kept for 6 hours, by its library path', () => {
    const t = createPlayerTouches()
    t.noteAbs('/Users/j/Music2/JakeTunesLibrary/iPod_Control/Music/F21/imported_14921.m4a', NOW)
    const colon = ':iPod_Control:Music:F21:imported_14921.m4a'
    assert.equal(t.has(colon, NOW + PLAYER_TOUCH_MS - 1), true)
    assert.equal(t.has(colon, NOW + PLAYER_TOUCH_MS), false)
    assert.equal(t.has(':iPod_Control:Music:F21:other.m4a', NOW), false)
  })
  it('a path outside the library is ignored, and the memory is bounded', () => {
    const t = createPlayerTouches(PLAYER_TOUCH_MS, 2)
    t.noteAbs('/tmp/play-cache/abc.flac', NOW)
    assert.equal(t.size, 0)
    for (const n of ['a', 'b', 'c']) t.noteAbs(`/m/iPod_Control/Music/F01/${n}.m4a`, NOW)
    assert.equal(t.size, 2)
    assert.equal(t.has(':iPod_Control:Music:F01:a.m4a', NOW), false)
    assert.equal(t.has(':iPod_Control:Music:F01:c.m4a', NOW), true)
    assert.equal(colonFromAbs('C:\\lib\\iPod_Control\\Music\\F01\\a.m4a'), ':iPod_Control:Music:F01:a.m4a')
  })
})
