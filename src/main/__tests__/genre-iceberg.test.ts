/**
 * Genre Icebergs (10/11): current song tags decide membership; zoom from a
 * family to one genre; depth from confirmed fans only; scene finds need two links.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildScope, familyGenres, placeScope, sceneFinds, layerOf } from '../../common/genre-iceberg.ts'

const canon = (n: string): string => n.replace(/\s+feat\..*$/i, '').trim()
const T = (artist: string, genre: string, extra: Record<string, unknown> = {}) => ({ artist, genre, playCount: 1, ...extra })

describe('who is on the berg', () => {
  const tracks = [
    T('Joy Division', 'Post-Punk'), T('Joy Division', 'Post-Punk'), T('IDLES', 'Post-Punk'), T('IDLES', 'Punk'),
    T('Green Day', 'Pop-Punk'), T('Baby Rose feat. Elmiene', 'Alternative R&B'), T('MESH', 'Post-Punk'), T('Ramones', 'Punk'),
  ]
  it('a family berg gathers every genre in the family; a genre berg is just that genre', () => {
    const fam = buildScope(tracks, canon, 'Punk')
    assert.deepEqual(fam.members.map((m) => m.name).sort(), ['Green Day', 'IDLES', 'Joy Division', 'MESH', 'Ramones'])
    assert.deepEqual(fam.members.find((m) => m.name === 'IDLES')!.tags, [['Post-Punk', 1], ['Punk', 1]])
    assert.deepEqual(buildScope(tracks, canon, 'Punk', 'Post-Punk').members.map((m) => m.name).sort(), ['IDLES', 'Joy Division', 'MESH'])
  })
  it('re-filing a song moves its artist', () => {
    const moved = tracks.map((t) => (t.artist === 'Green Day' ? { ...t, genre: 'Post-Punk' } : t))
    assert.ok(buildScope(moved, canon, 'Punk', 'Post-Punk').members.some((m) => m.name === 'Green Day'))
  })
  it('feat. credits count for the lead artist', () => {
    assert.deepEqual(buildScope(tracks, canon, 'R&B, Soul & Funk').members.map((m) => m.name), ['Baby Rose'])
  })
  it('zoom chips: genres of the family with 3+ artists', () => {
    assert.deepEqual(familyGenres(tracks, canon, 'Punk', 3).map((s) => s.name), ['Post-Punk'])
  })
})

describe('depth', () => {
  it('only confirmed fans place an artist; the rest are listed, not guessed', () => {
    const scope = buildScope([T('Joy Division', 'Post-Punk'), T('MESH', 'Post-Punk'), T('Notekillers', 'Post-Punk')], canon, 'Punk', 'Post-Punk')
    const s = placeScope(scope, { 'Joy Division': 809_310, Notekillers: 17 })
    assert.deepEqual(s.unplaced, ['MESH'])
    assert.equal(s.byLayer[0][0].name, 'Joy Division')
    assert.equal(s.deepest!.name, 'Notekillers')
    assert.equal(s.pctBelowTip, 50)
    assert.equal(layerOf(500_000), 0); assert.equal(layerOf(99_999), 2); assert.equal(layerOf(0), 4)
  })
})

describe('the scene you do not own yet', () => {
  it('needs two of his artists to point at it, and never lists what he owns', () => {
    const finds = sceneFinds(
      [{ name: 'IDLES', dz: 1 }, { name: 'shame', dz: 2 }, { name: 'Yard Act', dz: 3 }],
      { 1: [['Dry Cleaning', 10614], ['Fontaines D.C.', 900000], ['shame', 18000]], 2: [['Dry Cleaning', 10614], ['Opus Kink', 1193]], 3: [['Opus Kink', 1193], ['Dry Cleaning', 10614]] },
      (n) => ['shame', 'IDLES', 'Yard Act'].includes(n),
    )
    assert.deepEqual(finds.map((f) => [f.name, f.via.length]), [['Dry Cleaning', 3], ['Opus Kink', 2]])
  })
})
