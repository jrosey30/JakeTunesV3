import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recoKindForInput, preserveAlbumIdentity } from '../reco-kind-core.ts'

describe('a jot keeps what it is on the way to the hub', () => {
  it('an album jot keeps the artist and album it was written with; enrichment may not rename it or make it a song', () => {
    const enriched = { kind: 'album', artist: 'Sting & Bedouin', album: 'Desert Rose (Reimagined) [feat. Cheb Mami]', song: 'Desert Rose', matchedTitle: 'Desert Rose', artworkUrl: 'x' }
    const kept = preserveAlbumIdentity(enriched, { artist: 'Bedouin', album: 'Desert Rose (Reimagined)' })
    assert.equal(kept.artist, 'Bedouin'); assert.equal(kept.album, 'Desert Rose (Reimagined)'); assert.equal(kept.song, undefined); assert.equal(kept.matchedTitle, undefined); assert.equal(kept.artworkUrl, 'x')
    const track = { kind: 'track', artist: 'Sting', album: 'Brand New Day', song: 'Desert Rose' }
    assert.deepEqual(preserveAlbumIdentity(track, { artist: 'Bedouin' }), track)
  })

  it('an album with no song is an album; a song is a track; an explicit kind wins; artist/note-only stay unkinded', () => {
    assert.equal(recoKindForInput({ album: 'Little Creatures' }), 'album')
    assert.equal(recoKindForInput({ song: 'And She Was', album: 'Little Creatures' }), 'track')
    assert.equal(recoKindForInput({ song: '  ', album: 'Little Creatures' }), 'album')
    assert.equal(recoKindForInput({ album: 'Live at CBGB', kind: 'concert' }), 'concert')
    assert.equal(recoKindForInput({ song: 'x', kind: 'album' }), 'album')
    assert.equal(recoKindForInput({}), undefined)
    assert.equal(recoKindForInput({ song: '', album: '' }), undefined)
  })
})
