/**
 * Shop bin doctrine (2026-08-22, the crate reorg): coarse, display-ordered
 * genre dividers — a store has PUNK cards in the crates, not a taxonomy —
 * and the album hook chooser that picks the one 30s sample doing the
 * selling.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SHOP_BINS, binForGenre, pickHookIndex, applyBinQuotas, MORE_BIN } from '../../common/record-shop-bins.ts'

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

describe('applyBinQuotas — balanced shelves (2026-08-23)', () => {
  const card = (bin: string, pct: number) => ({ bin, brainPct: pct })
  test('fat bins keep their best `cap`, original order preserved', () => {
    const rock = [90, 60, 85, 70, 95, 65, 88, 72].map((p) => card('Rock', p))
    const out = applyBinQuotas([...rock, card('Punk', 80), card('Punk', 70), card('Punk', 75)], { cap: 6, minShelf: 3 })
    const r = out.find((s) => s.bin === 'Rock')!
    assert.equal(r.cards.length, 6)
    assert.ok(!r.cards.some((c) => c.brainPct === 60 || c.brainPct === 65))   // the two weakest dropped
    assert.deepEqual(r.cards.map((c) => c.brainPct), [90, 85, 70, 95, 88, 72]) // original order kept
  })
  test('thin bins fold into More Finds instead of standing alone', () => {
    const out = applyBinQuotas([card('Pop', 80), card('Jazz & Blues', 75), card('Punk', 90), card('Punk', 85), card('Punk', 70)])
    assert.deepEqual(out.map((s) => s.bin), ['Punk', MORE_BIN])
    assert.equal(out.find((s) => s.bin === MORE_BIN)!.cards.length, 2)
  })
  test('shelf order follows SHOP_BINS, More Finds last', () => {
    const cards = [card('Electronic', 70), card('Electronic', 71), card('Electronic', 72), card('Punk', 90), card('Punk', 80), card('Punk', 85), card('Pop', 60)]
    const out = applyBinQuotas(cards)
    assert.deepEqual(out.map((s) => s.bin), ['Punk', 'Electronic', MORE_BIN])
  })
})
