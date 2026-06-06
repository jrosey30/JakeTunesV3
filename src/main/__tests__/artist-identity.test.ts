import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../normalize.ts'

/**
 * Renderer artistIdentityKey uses canonicalArtist().toLowerCase().
 * These cases prove the underlying normalize twin already folds the
 * article/preposition casing drift that was splitting artist rows.
 */
describe('artist identity (normalize twin + reco parity)', () => {
  it('Presidents of the USA — of/the casing drift', () => {
    const a = 'The Presidents of The United States Of America'
    const b = 'The Presidents Of the United States of America'
    assert.equal(normalize(a), normalize(b))
  })

  it('Florence and the Machine — and/the casing drift', () => {
    const a = 'Florence and The Machine'
    const b = 'Florence And the Machine'
    assert.equal(normalize(a), normalize(b))
  })
})
