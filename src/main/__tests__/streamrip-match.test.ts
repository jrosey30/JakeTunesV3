import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestStreamripMatch } from '../streamrip-match.ts'

function hit(id: string, desc: string) {
  return { source: 'qobuz', mediaType: 'track', id, desc }
}

describe('pickBestStreamripMatch', () => {
  it('picks the artist+title match over a title-only near miss', () => {
    const results = [
      hit('1', 'Around the World by Daft Punk'),
      hit('2', 'Around the World by Kings of Leon'),
    ]
    const pick = pickBestStreamripMatch('Around the World', 'Daft Punk', results)
    assert.equal(pick?.id, '1')
  })

  it('returns null when no title matches', () => {
    const results = [hit('1', 'Creep by Radiohead')]
    assert.equal(pickBestStreamripMatch('Karma Police', 'Radiohead', results), null)
  })
})
