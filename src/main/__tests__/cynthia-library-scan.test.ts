// Cynthia neat-freak library-wide pass — unit tests. Precision guards
// matter most: ties never guess, distinct names never merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanLibraryConsistency } from '../cynthia-library-scan.ts'
import type { CynthiaScanTrack } from '../cynthia-scan.ts'

let nextId = 1
function mk(overrides: Partial<CynthiaScanTrack>): CynthiaScanTrack {
  return {
    id: nextId++,
    title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist',
    trackNumber: 1, trackCount: 10, discNumber: 1, discCount: 1,
    year: 2000, genre: 'Rock', duration: 200000,
    ...overrides,
  }
}

test('artist case variants collapse to library majority (judgment)', () => {
  const tracks = [
    ...Array.from({ length: 6 }, () => mk({ artist: 'Beastie Boys' })),
    mk({ artist: 'beastie boys' }),
    mk({ artist: 'Beastie boys' }),
  ]
  const f = scanLibraryConsistency(tracks).filter(x => x.field === 'artist')
  assert.equal(f.length, 2)
  assert.ok(f.every(x => x.newValue === 'Beastie Boys'))
  assert.ok(f.every(x => x.provable === false))
})

test('genre punctuation/space variants collapse to majority', () => {
  const tracks = [
    ...Array.from({ length: 5 }, () => mk({ genre: 'Hip-Hop' })),
    mk({ genre: 'Hip Hop' }),
    mk({ genre: 'hip hop' }),
  ]
  const f = scanLibraryConsistency(tracks).filter(x => x.field === 'genre')
  assert.equal(f.length, 2)
  assert.ok(f.every(x => x.newValue === 'Hip-Hop'))
})

test('genuinely different names never merge', () => {
  const tracks = [
    ...Array.from({ length: 5 }, () => mk({ genre: 'Rap' })),
    ...Array.from({ length: 4 }, () => mk({ genre: 'Hip-Hop' })),
  ]
  const f = scanLibraryConsistency(tracks).filter(x => x.field === 'genre')
  assert.equal(f.length, 0)
})

test('ties are skipped, never guessed', () => {
  const tracks = [
    mk({ genre: 'Hip Hop' }), mk({ genre: 'Hip Hop' }),
    mk({ genre: 'Hip-Hop' }), mk({ genre: 'Hip-Hop' }),
  ]
  const f = scanLibraryConsistency(tracks).filter(x => x.field === 'genre')
  assert.equal(f.length, 0)
})

test('uniform vocabulary produces zero findings', () => {
  const tracks = Array.from({ length: 20 }, () => mk({ artist: 'deadmau5', albumArtist: 'deadmau5', genre: 'Electronic' }))
  assert.equal(scanLibraryConsistency(tracks).length, 0)
})

test('small clusters below the minimum are left alone', () => {
  const tracks = [mk({ artist: 'Wolf Parade' }), mk({ artist: 'wolf parade' })]
  const f = scanLibraryConsistency(tracks).filter(x => x.field === 'artist')
  assert.equal(f.length, 0)
})

test('featuring/ft. variants normalize to house feat. (judgment)', () => {
  const tracks = [
    mk({ title: 'One (featuring Nas)' }),
    mk({ title: 'Two (ft. AZ)' }),
    mk({ title: 'Three (feat. Q-Tip)' }),
    mk({ artist: 'Artist featuring Someone' }),
  ]
  const f = scanLibraryConsistency(tracks)
  const t1 = f.find(x => x.oldValue === 'One (featuring Nas)')
  assert.ok(t1)
  assert.equal(t1!.newValue, 'One (feat. Nas)')
  const t2 = f.find(x => x.oldValue === 'Two (ft. AZ)')
  assert.ok(t2)
  assert.equal(t2!.newValue, 'Two (feat. AZ)')
  assert.equal(f.filter(x => x.oldValue === 'Three (feat. Q-Tip)').length, 0)
  const a = f.find(x => x.field === 'artist' && x.oldValue === 'Artist featuring Someone')
  assert.ok(a)
  assert.equal(a!.newValue, 'Artist feat. Someone')
  assert.ok(f.every(x => !x.provable))
})

test('empty library is a no-op', () => {
  assert.equal(scanLibraryConsistency([]).length, 0)
})
