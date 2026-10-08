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

  // 2026-08-25 REVISED. This first refused ANY unasked-for version, borrowed
  // wholesale from the download guard — where refusing them is correct, because
  // you asked for a specific file. Discovery is a different question: a live
  // pressing or a radio edit is still the record worth putting on a shelf, and
  // refusing them cost real cards for no quality gain while Jake was watching
  // the shop shrink. Only a genuine artefact is refused now.
  test('refuses an artefact nobody would shelve', () => {
    assert.equal(acceptableHit({ artist: 'GZA', title: 'Liquid Swords' },
      { artist: 'GZA', title: 'Liquid Swords (Instrumental)' }), false)
    assert.equal(acceptableHit({ artist: 'Weezer', title: 'Buddy Holly' },
      { artist: 'Weezer', title: 'Buddy Holly (Karaoke Version)' }), false)
  })

  test('but KEEPS a real pressing — discovery is not the download gate', () => {
    assert.equal(acceptableHit({ artist: 'Underworld', title: 'Born Slippy (Nuxx)' },
      { artist: 'Underworld', title: 'Born Slippy (Nuxx) (Radio Edit)' }), true)
    assert.equal(acceptableHit({ artist: 'Nirvana', title: 'About a Girl' },
      { artist: 'Nirvana', title: 'About a Girl (Live)' }), true)
  })

  test('keeps the version when it is what was ASKED for', () => {
    assert.equal(acceptableHit({ artist: 'Nirvana', title: 'About a Girl (Live)' },
      { artist: 'Nirvana', title: 'About a Girl (Live)' }), true)
  })
})

describe('capOrbits — one band may not own a shelf', () => {
  test('caps cards per anchor (3 — two was starving a healthy shelf)', () => {
    const out = capOrbits([
      { because: 'Red Hot Chili Peppers', artist: 'John Frusciante' },
      { because: 'Red Hot Chili Peppers', artist: 'Josh Klinghoffer' },
      { because: 'Red Hot Chili Peppers', artist: 'Dave Navarro' },
      { because: 'Red Hot Chili Peppers', artist: 'Jack Irons' },
      { because: 'blink-182', artist: 'The Posers' },
    ])
    assert.equal(out.length, 4)
    assert.equal(out.filter((c) => c.because === 'Red Hot Chili Peppers').length, 3)
    // Still capped: one orbit cannot own the shelf.
    assert.ok(out.some((c) => c.because === 'blink-182'))
  })

  test('cards with no anchor are never dropped', () => {
    const out = capOrbits([{ artist: 'A' }, { artist: 'B' }, { artist: 'C' }])
    assert.equal(out.length, 3)
  })
})
