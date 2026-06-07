import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalArtist, isSameArtist, setUserAliases } from '../../renderer/utils/artistAlias.ts'

describe('artist-alias — curated baseline', () => {
  beforeEach(() => setUserAliases({}))

  it('rolls Paul McCartney personas up to Paul McCartney', () => {
    assert.equal(canonicalArtist('Wings'), 'Paul McCartney')
    assert.equal(canonicalArtist('Paul McCartney & Wings'), 'Paul McCartney')
    assert.equal(canonicalArtist('Paul & Linda McCartney'), 'Paul McCartney')
    assert.equal(canonicalArtist('Paul McCartney & Linda McCartney'), 'Paul McCartney')
  })

  it('does NOT merge a peer collaboration', () => {
    assert.equal(canonicalArtist('Paul McCartney & Stevie Wonder'), 'Paul McCartney & Stevie Wonder')
  })

  it('leaves a standalone band whose name has "&" / "/" untouched', () => {
    assert.equal(canonicalArtist('Hall & Oates'), 'Hall & Oates')
    assert.equal(canonicalArtist('AC/DC'), 'AC/DC')
    assert.equal(canonicalArtist('King Gizzard & The Lizard Wizard'), 'King Gizzard & The Lizard Wizard')
  })
})

describe('artist-alias — user/AI override map', () => {
  beforeEach(() => setUserAliases({}))

  it('user map groups arbitrary tags under a primary', () => {
    setUserAliases({ 'The Fireman': 'Paul McCartney' })
    assert.equal(canonicalArtist('The Fireman'), 'Paul McCartney')
    assert.equal(isSameArtist('The Fireman', 'Paul McCartney'), true)
  })

  it('override beats the curated baseline (un-group Wings)', () => {
    setUserAliases({ 'Wings': 'Wings' })
    assert.equal(canonicalArtist('Wings'), 'Wings')
  })

  it('key is case- and leading-"the"-insensitive', () => {
    setUserAliases({ 'the fireman': 'Paul McCartney' })
    assert.equal(canonicalArtist('The Fireman'), 'Paul McCartney')
    assert.equal(canonicalArtist('FIREMAN'), 'Paul McCartney') // "the" stripped + lowercased
  })
})
