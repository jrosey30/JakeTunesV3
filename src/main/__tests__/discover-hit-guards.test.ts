/**
 * Card-level truth guards (2026-08-25, Jake: "ITS STILL not fantastic....but
 * better....must keep improving").
 *
 * Three defects were still visible on the live shop after the rebalance:
 * a soundalike artist ("Rage Against the Blues" credited with "Killing in the
 * Name"), wrong cuts ("Liquid Swords (Instrumental)", "Born Slippy (Radio
 * Edit)"), and one band's orbit taking 6 of 12 cards on a shelf.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptableHit, capOrbits } from '../discover-feed.ts'

describe('acceptableHit — a row must answer what was asked', () => {
  test('rejects a soundalike artist', () => {
    assert.equal(acceptableHit(
      { artist: 'Rage Against the Machine', title: 'Killing in the Name' },
      { artist: 'Rage Against the Blues', title: 'Killing in the Name' }), false)
  })

  test('accepts the real credit, including a reasonable variant', () => {
    assert.equal(acceptableHit(
      { artist: 'Rage Against the Machine', title: 'Killing in the Name' },
      { artist: 'Rage Against The Machine', title: 'Killing In The Name' }), true)
  })

  test('rejects a cut nobody asked for', () => {
    assert.equal(acceptableHit({ artist: 'GZA', title: 'Liquid Swords' },
      { artist: 'GZA', title: 'Liquid Swords (Instrumental)' }), false)
    assert.equal(acceptableHit({ artist: 'Underworld', title: 'Born Slippy (Nuxx)' },
      { artist: 'Underworld', title: 'Born Slippy (Nuxx) (Radio Edit)' }), false)
  })

  test('keeps the version when it is what was ASKED for', () => {
    assert.equal(acceptableHit({ artist: 'Nirvana', title: 'About a Girl (Live)' },
      { artist: 'Nirvana', title: 'About a Girl (Live)' }), true)
  })
})

describe('capOrbits — one band may not own a shelf', () => {
  test('caps cards per anchor at two', () => {
    const out = capOrbits([
      { because: 'Red Hot Chili Peppers', artist: 'John Frusciante' },
      { because: 'Red Hot Chili Peppers', artist: 'Josh Klinghoffer' },
      { because: 'Red Hot Chili Peppers', artist: 'Dave Navarro' },
      { because: 'Red Hot Chili Peppers', artist: 'Jack Irons' },
      { because: 'blink-182', artist: 'The Posers' },
    ])
    assert.equal(out.length, 3)
    assert.equal(out.filter((c) => c.because === 'Red Hot Chili Peppers').length, 2)
  })

  test('cards with no anchor are never dropped', () => {
    const out = capOrbits([{ artist: 'A' }, { artist: 'B' }, { artist: 'C' }])
    assert.equal(out.length, 3)
  })
})
