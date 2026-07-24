import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestStreamripMatch, pickBestSoundcloudMatch } from '../streamrip-match.ts'

function hit(id: string, desc: string) {
  return { source: 'qobuz', mediaType: 'track', id, desc }
}
function schit(id: string, desc: string) {
  return { source: 'soundcloud', mediaType: 'track', id, desc }
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

  // Regression (2026-07-24): album downloads always failed because the matcher
  // hard-skipped every non-'track' row. An album query passes wantMediaType
  // 'album' and MUST match album rows (Charli XCX "Music, Fashion, Film").
  it('matches an ALBUM row when asked for an album', () => {
    const results = [{ source: 'qobuz', mediaType: 'album', id: 'wy1feibmvq0fu', desc: 'Music, Fashion, Film by Charli XCX' }]
    const pick = pickBestStreamripMatch('Music, Fashion, Film', 'Charli xcx', results, 'album')
    assert.equal(pick?.id, 'wy1feibmvq0fu')
  })

  it('does NOT match an album row for a track query (default track gate holds)', () => {
    const results = [{ source: 'qobuz', mediaType: 'album', id: 'a1', desc: 'Music, Fashion, Film by Charli XCX' }]
    assert.equal(pickBestStreamripMatch('Music, Fashion, Film', 'Charli xcx', results), null)
  })
})

describe('pickBestSoundcloudMatch (Qobuz-gap fallback)', () => {
  it('matches the real Villanova track SoundCloud returns (artist+title inside the label-uploaded desc)', () => {
    const results = [
      schit('2275039610|url', 'Villanova - Mr Vibe feat. Mike Dunn [Indie House Records] by Indie House Records'),
      schit('2291240129|url', 'Villanova (FR) - Mr Vibe feat. Mike Dunn (Claude Monnet Remix) by Indie House Records'),
    ]
    const pick = pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results)
    // original upload preferred over the longer remix desc
    assert.equal(pick?.id, '2275039610|url')
  })

  it('rejects a title match whose artist is absent (avoids grabbing a random cover)', () => {
    const results = [schit('9', 'Some Kid - Mr Vibe (bedroom cover) by RandomUploader')]
    assert.equal(pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results), null)
  })

  it('returns null when the title is nowhere in the results', () => {
    const results = [schit('9', 'Villanova - Different Song by Indie House Records')]
    assert.equal(pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results), null)
  })
})
