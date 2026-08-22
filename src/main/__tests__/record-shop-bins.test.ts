/**
 * Shop bin doctrine (2026-08-22, the crate reorg): coarse, display-ordered
 * genre dividers — a store has PUNK cards in the crates, not a taxonomy —
 * and the album hook chooser that picks the one 30s sample doing the
 * selling.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SHOP_BINS, binForGenre, pickHookIndex } from '../../common/record-shop-bins.ts'

describe('binForGenre', () => {
  test('the families land where a clerk would file them', () => {
    assert.equal(binForGenre('Punk'), 'Punk')
    assert.equal(binForGenre('Pop Punk'), 'Punk')
    assert.equal(binForGenre('Hardcore'), 'Punk')
    assert.equal(binForGenre('Hip-Hop/Rap'), 'Hip-Hop')
    assert.equal(binForGenre('Alternative'), 'Rock')
    assert.equal(binForGenre('Indie Rock'), 'Rock')
    assert.equal(binForGenre('Metal'), 'Rock')
    assert.equal(binForGenre('House'), 'Electronic')
    assert.equal(binForGenre('Dance'), 'Electronic')
    assert.equal(binForGenre('R&B/Soul'), 'Soul & Funk')
    assert.equal(binForGenre('Jazz'), 'Jazz & Blues')
    assert.equal(binForGenre('Country'), 'Country & Folk')
    assert.equal(binForGenre('Singer/Songwriter'), 'Country & Folk')
    assert.equal(binForGenre('Reggae'), 'World')
    assert.equal(binForGenre('Pop'), 'Pop')
  })
  test('compounds resolve to the specific family, not Pop/Rock', () => {
    assert.equal(binForGenre('Dance Pop'), 'Electronic')
    assert.equal(binForGenre('Country Pop'), 'Country & Folk')
    assert.equal(binForGenre('Pop Rock'), 'Pop')   // pop rule sits before rock
  })
  test('unknown/empty → Misc; Punk leads the display order', () => {
    assert.equal(binForGenre(''), 'Misc')
    assert.equal(binForGenre(undefined), 'Misc')
    assert.equal(binForGenre('Spoken Word'), 'Misc')
    assert.equal(SHOP_BINS[0], 'Punk')
  })
})

describe('pickHookIndex', () => {
  test('highest brain pct WITH a preview wins', () => {
    assert.equal(pickHookIndex([
      { previewUrl: 'a', pct: 70 },
      { previewUrl: 'b', pct: 92 },
      { pct: 99 },                       // no preview — can't be the sample
      { previewUrl: 'd', pct: 80 },
    ]), 1)
  })
  test('no scores → first previewable track (the artist’s own opener)', () => {
    assert.equal(pickHookIndex([{ pct: undefined }, { previewUrl: 'x' }, { previewUrl: 'y' }]), 1)
  })
  test('nothing previewable → -1', () => {
    assert.equal(pickHookIndex([{}, { pct: 90 }]), -1)
  })
})
