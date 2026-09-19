import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { poolHealth, swapInPool, songKey, isSyncableTrack } from '../../common/pool-health.ts'

const lib = new Map([
  [1, { id: 1, title: 'Life Goes On', artist: 'The Damned', path: '/a' }],
  [2, { id: 2, title: 'Memories', artist: 'beabadoobee', path: '/b' }],
  [3, { id: 3, title: 'Cue', artist: 'Nirvana', path: '/c' }],            // concert-owned
  [4, { id: 4, title: '', artist: 'Nobody', path: '/d' }],                // blank title
  [5, { id: 5, title: 'Gone', artist: 'Ghost', path: '/e', audioMissing: true }],
  [9, { id: 9, title: 'Life Goes On', artist: 'The Damned', path: '/a2' }], // the re-added copy
])
const concert = new Set([3])

describe('poolHealth', () => {
  it('counts exactly what the sync will board, in pool order', () => {
    const h = poolHealth([2, 1, 3, 4, 5, 77], {}, lib, concert)
    assert.deepEqual(h.syncable, [2, 1])
    assert.deepEqual(h.concert, [3])
    assert.deepEqual(h.unsyncable, [4, 5])
    assert.equal(h.dead.length, 1)
    assert.equal(h.dead[0].id, 77)
  })

  it('names a dead id from the pool record and finds its re-added copy', () => {
    const h = poolHealth([77, 2], { '77': { a: 'The Damned', t: 'Life Goes On' } }, lib, concert)
    assert.deepEqual(h.dead, [{ id: 77, label: 'The Damned — Life Goes On', replacement: 1 }])
  })

  it('never offers a copy that is already in the pool', () => {
    const h = poolHealth([77, 1], { '77': { a: 'The Damned', t: 'Life Goes On' } }, lib, concert)
    assert.equal(h.dead[0].replacement, 9)
    const h2 = poolHealth([77, 1, 9], { '77': { a: 'The Damned', t: 'Life Goes On' } }, lib, concert)
    assert.equal(h2.dead[0].replacement, undefined)
  })

  it('labels an unnamed dead id honestly', () => {
    const h = poolHealth([77], undefined, lib, concert)
    assert.deepEqual(h.dead, [{ id: 77, label: 'Song #77' }])
  })

  it('matches across accents, case and punctuation', () => {
    assert.equal(songKey('Beyoncé', "Crazy In Love"), songKey('beyonce', 'crazy in love'))
    assert.equal(songKey('JAŸ-Z', '99 Problems'), songKey('jay z', '99 problems'))
  })

  it('mirrors the sync-side syncable rule', () => {
    assert.equal(isSyncableTrack({ id: 1, title: 'x', artist: 'y' }), true)
    assert.equal(isSyncableTrack({ id: 1, title: 'x', artist: 'y', path: '' }), false)
    assert.equal(isSyncableTrack({ id: 1, title: 'x', artist: 'y', audioMissing: true }), false)
  })
})

describe('swapInPool', () => {
  it('replaces in place and keeps order', () => {
    assert.deepEqual(swapInPool([1, 77, 3], 77, 9), [1, 9, 3])
  })
  it('is a no-op when the old id is absent or the new one is pooled', () => {
    assert.deepEqual(swapInPool([1, 3], 77, 9), [1, 3])
    assert.deepEqual(swapInPool([1, 77, 9], 77, 9), [1, 77, 9])
  })
})
