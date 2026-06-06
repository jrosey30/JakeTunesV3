import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../normalize.ts'

describe('normalize (twin of core/repair_mismatches.py)', () => {
  it('equates Pt. and Part suffixes', () => {
    const a = normalize('Another Brick in the Wall, Pt. 1')
    const b = normalize('Another Brick in the Wall, Part 1')
    assert.equal(a, b)
  })

  it('strips track-number prefix', () => {
    assert.equal(normalize('01 - Marquee Moon'), 'marquee moon')
  })

  it('strips feat. clause', () => {
    assert.equal(normalize('High Life (feat. Sean Kingston)'), 'high life')
  })

  it('handles roman numerals in part tokens', () => {
    assert.equal(normalize('Movement I'), 'movement i')
    assert.equal(normalize('Part II'), 'part 2')
  })

  it('equates artist names differing only in article/preposition casing', () => {
    const a = normalize('The Presidents of The United States Of America')
    const b = normalize('The Presidents Of the United States of America')
    assert.equal(a, b)
    const c = normalize('Florence and The Machine')
    const d = normalize('Florence And the Machine')
    assert.equal(c, d)
  })
})
