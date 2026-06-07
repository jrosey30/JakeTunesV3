import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordLocation, canGoBack, canGoForward, sameLoc } from '../../renderer/nav-history.ts'
import type { NavLocation, NavHistory } from '../../renderer/nav-history.ts'

const L = (view: string, extra: Partial<NavLocation> = {}): NavLocation => ({
  view, playlistId: null, smartPlaylistId: null, artist: null, albumKey: null, ...extra,
})
const start = (loc: NavLocation): NavHistory => ({ history: [loc], index: 0 })

describe('nav-history — recordLocation', () => {
  it('pushes a new location and advances the index', () => {
    let s = start(L('songs'))
    s = recordLocation(s, L('albums'))
    assert.deepEqual(s.history.map((l) => l.view), ['songs', 'albums'])
    assert.equal(s.index, 1)
  })

  it('returns the SAME state object on a repeat of the current location (landing/no-op)', () => {
    const s = start(L('albums'))
    assert.equal(recordLocation(s, L('albums')), s) // identity — no push
  })

  it('distinguishes album-detail entries by albumKey', () => {
    let s = start(L('albums'))
    s = recordLocation(s, L('album-detail', { albumKey: 'a|||x' }))
    s = recordLocation(s, L('album-detail', { albumKey: 'a|||y' }))
    assert.equal(s.history.length, 3)
    assert.equal(s.index, 2)
  })

  it('truncates forward entries when navigating after a back', () => {
    let s = start(L('songs'))
    s = recordLocation(s, L('albums'))
    s = recordLocation(s, L('album-detail', { albumKey: 'k1' }))
    s = { history: s.history, index: 1 } // simulate goBack to albums
    s = recordLocation(s, L('album-detail', { albumKey: 'k2' })) // new nav
    assert.deepEqual(s.history.map((l) => l.albumKey), [null, null, 'k2'])
    assert.equal(s.index, 2) // k1 forward entry dropped
    assert.equal(canGoForward(s), false)
  })

  it('caps the stack length, keeping the newest', () => {
    let s = start(L('v0'))
    for (let i = 1; i < 150; i++) s = recordLocation(s, L('v' + i), 100)
    assert.equal(s.history.length, 100)
    assert.equal(s.history[s.history.length - 1].view, 'v149')
    assert.equal(s.index, 99)
  })
})

describe('nav-history — canGoBack / canGoForward', () => {
  it('reflect index position in the stack', () => {
    const s: NavHistory = { history: [L('a'), L('b'), L('c')], index: 1 }
    assert.equal(canGoBack(s), true)
    assert.equal(canGoForward(s), true)
    assert.equal(canGoBack({ ...s, index: 0 }), false)
    assert.equal(canGoForward({ ...s, index: 2 }), false)
  })
})

describe('nav-history — sameLoc', () => {
  it('compares all fields and handles undefined', () => {
    assert.equal(sameLoc(L('a'), L('a')), true)
    assert.equal(sameLoc(L('a'), L('b')), false)
    assert.equal(sameLoc(L('a', { albumKey: 'x' }), L('a', { albumKey: 'y' })), false)
    assert.equal(sameLoc(undefined, L('a')), false)
  })
})
