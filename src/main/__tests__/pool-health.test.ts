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

  // 2026-10-13: [a-z0-9] keyed every all-Hebrew/Cyrillic song '|||', so a
  // dead one was offered whichever unrelated Hebrew song came first.
  it('offers a dead Hebrew or Cyrillic song its own re-added copy, never another song', () => {
    const intl = new Map([
      [10, { id: 10, title: 'שיר', artist: 'ברי סחרוף', path: '/h1' }],
      [11, { id: 11, title: 'למה הים כחול?', artist: 'הדג נחש', path: '/h2' }],       // the re-added copy
      [12, { id: 12, title: 'Кукушка', artist: 'Кино', path: '/c1' }],
      [13, { id: 13, title: 'Группа крови', artist: 'Кино', path: '/c2' }],          // the re-added copy
    ])
    const names = { '70': { a: 'הדג נחש', t: 'למה הים כחול?' }, '71': { a: 'Кино', t: 'Группа крови' }, '72': { a: 'אביב גפן', t: 'שיר אחר' } }
    const h = poolHealth([70, 71, 72], names, intl, new Set())
    assert.deepEqual(h.dead, [
      { id: 70, label: 'הדג נחש — למה הים כחול?', replacement: 11 },
      { id: 71, label: 'Кино — Группа крови', replacement: 13 },
      { id: 72, label: 'אביב גפן — שיר אחר' },
    ])
  })

  it('keys names in other alphabets apart, and a letterless name as itself', () => {
    assert.notEqual(songKey('ברי סחרוף', 'שיר'), songKey('הדג נחש', 'למה הים כחול?'))
    assert.notEqual(songKey('Молчат Дома', 'Судно'), songKey('Кино', 'Группа крови'))
    assert.equal(songKey('Кино', 'Группа Крови!'), songKey('КИНО', 'группа крови'))
    assert.equal(songKey('!!!', 'Wallop'), songKey('!!!', 'wallop'))
    assert.notEqual(songKey('!!!', 'Wallop'), songKey('+/-', 'Wallop'))
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
