/**
 * Brief 162 — playback-state persistence, pure half.
 *
 * The contracts locked here: a malformed or empty snapshot restores
 * NOTHING (never a half-made-up queue), deleted tracks drop out
 * without shifting the playing track's place, and the restored
 * position never lands past the end of its track.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  snapshotPlayback,
  parsePersistedPlayback,
  resolveRestoredQueue,
  type RestorableTrack,
} from '../../renderer/playback-persistence.ts'

const T = (id: number, duration = 200_000): RestorableTrack => ({ id, duration })

describe('snapshotPlayback', () => {
  test('captures ids, index, position, volume', () => {
    const snap = snapshotPlayback({
      queue: [T(1), T(2), T(3)],
      queueIndex: 1,
      nowPlaying: T(2),
      position: 42.5,
      volume: 0.6,
    })
    assert.deepEqual(snap.queueIds, [1, 2, 3])
    assert.equal(snap.queueIndex, 1)
    assert.equal(snap.trackId, 2)
    assert.equal(snap.position, 42.5)
    assert.equal(snap.volume, 0.6)
  })

  test('an idle state snapshots an empty queue (which parses back to nothing)', () => {
    const snap = snapshotPlayback({ queue: [], queueIndex: -1, nowPlaying: null, position: 0, volume: 0.8 })
    assert.equal(parsePersistedPlayback(snap), null)
  })
})

describe('parsePersistedPlayback', () => {
  test('round-trips a snapshot', () => {
    const snap = snapshotPlayback({ queue: [T(9)], queueIndex: 0, nowPlaying: T(9), position: 3, volume: 0.5 })
    const parsed = parsePersistedPlayback(JSON.parse(JSON.stringify(snap)))
    assert.deepEqual(parsed?.queueIds, [9])
    assert.equal(parsed?.trackId, 9)
    assert.equal(parsed?.position, 3)
  })

  test('garbage restores nothing', () => {
    assert.equal(parsePersistedPlayback(null), null)
    assert.equal(parsePersistedPlayback('queueIds'), null)
    assert.equal(parsePersistedPlayback({}), null)
    assert.equal(parsePersistedPlayback({ queueIds: 'nope' }), null)
    assert.equal(parsePersistedPlayback({ queueIds: [] }), null)
  })

  test('junk ids are filtered; volume clamps; a bad position zeroes', () => {
    const parsed = parsePersistedPlayback({
      queueIds: [1, 'x', Number.NaN, 2],
      queueIndex: 1.9,
      trackId: 2,
      position: -5,
      volume: 7,
    })
    assert.deepEqual(parsed?.queueIds, [1, 2])
    assert.equal(parsed?.queueIndex, 1)
    assert.equal(parsed?.position, 0)
    assert.equal(parsed?.volume, 1)
  })
})

describe('resolveRestoredQueue', () => {
  const byId = new Map([[1, T(1)], [2, T(2)], [3, T(3, 60_000)]])

  test('resolves ids to tracks and points at the playing track', () => {
    const p = parsePersistedPlayback({ queueIds: [1, 2, 3], queueIndex: 1, trackId: 2, position: 10, volume: 0.8 })!
    const r = resolveRestoredQueue(p, byId)
    assert.equal(r?.queue.length, 3)
    assert.equal(r?.track.id, 2)
    assert.equal(r?.queueIndex, 1)
    assert.equal(r?.position, 10)
  })

  test('deleted tracks drop out and the index follows the playing track', () => {
    const p = parsePersistedPlayback({ queueIds: [1, 99, 3], queueIndex: 2, trackId: 3, position: 5, volume: 0.8 })!
    const r = resolveRestoredQueue(p, byId)
    assert.deepEqual(r?.queue.map((t) => t.id), [1, 3])
    assert.equal(r?.queueIndex, 1, 'index shifted with the drop, still on track 3')
  })

  test('position clamps to just inside the track end', () => {
    const p = parsePersistedPlayback({ queueIds: [3], queueIndex: 0, trackId: 3, position: 999, volume: 0.8 })!
    const r = resolveRestoredQueue(p, byId)
    assert.equal(r?.position, 59, 'track 3 is 60s; restore lands at 59s, not past the end')
  })

  test('nothing survives → nothing restores', () => {
    const p = parsePersistedPlayback({ queueIds: [77, 78], queueIndex: 0, trackId: 77, position: 0, volume: 0.8 })!
    assert.equal(resolveRestoredQueue(p, byId), null)
  })
})
