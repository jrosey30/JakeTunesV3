// Cynthia deterministic scanner — unit tests. Precision is the whole
// point: the false-positive guards matter as much as the detections.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanAlbum, type CynthiaScanTrack } from '../cynthia-scan.ts'

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
function album(n: number, base?: Partial<CynthiaScanTrack>): CynthiaScanTrack[] {
  return Array.from({ length: n }, (_, i) => mk({ title: `Song ${i + 1}`, trackNumber: i + 1, ...base }))
}

test('clean album produces zero findings and zero flags', () => {
  const r = scanAlbum(album(10))
  assert.equal(r.findings.length, 0)
  assert.equal(r.flags.length, 0)
})

test('trailing/double whitespace is a provable fix', () => {
  const tracks = album(5)
  tracks[2] = mk({ title: 'Run  Like Hell ', trackNumber: 3 })
  const r = scanAlbum(tracks)
  const f = r.findings.find(f => f.field === 'title')
  assert.ok(f)
  assert.equal(f!.newValue, 'Run Like Hell')
  assert.equal(f!.provable, true)
  assert.equal(f!.source, 'internal-consistency')
})

test('blank discCount fills from consistent siblings (provable)', () => {
  const tracks = album(6, { discCount: 2, discNumber: 1 })
  tracks[4] = mk({ ...tracks[4], discCount: '' })
  const r = scanAlbum(tracks)
  const f = r.findings.find(f => f.field === 'discCount')
  assert.ok(f)
  assert.equal(f!.newValue, '2')
  assert.equal(f!.provable, true)
})

test('blank discCount with NO sibling declarations is NOT filled (MB-diff territory)', () => {
  const tracks = album(6, { discCount: '' })
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'discCount').length, 0)
})

test('conflicting sibling discCounts do not fill blanks', () => {
  const tracks = [mk({ discCount: 1 }), mk({ discCount: 2 }), mk({ discCount: '' })]
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'discCount').length, 0)
})

test('blank trackCount fills per-disc from same-disc siblings', () => {
  const d1 = album(4, { discNumber: 1, trackCount: 4, discCount: 2 })
  const d2 = album(5, { discNumber: 2, trackCount: 5, discCount: 2 })
  d2[1] = mk({ ...d2[1], trackCount: '' })
  const r = scanAlbum([...d1, ...d2])
  const f = r.findings.find(f => f.field === 'trackCount')
  assert.ok(f)
  assert.equal(f!.newValue, '5')
  assert.equal(f!.provable, true)
})

test('artist case outlier: majority form wins, judgment not provable', () => {
  const tracks = album(6)
  tracks[3] = mk({ ...tracks[3], artist: 'artist' })
  const r = scanAlbum(tracks)
  const f = r.findings.find(f => f.field === 'artist')
  assert.ok(f)
  assert.equal(f!.oldValue, 'artist')
  assert.equal(f!.newValue, 'Artist')
  assert.equal(f!.provable, false)
})

test('stylized names are untouched when consistent (deadmau5, CHVRCHES)', () => {
  const r1 = scanAlbum(album(8, { artist: 'deadmau5', albumArtist: 'deadmau5' }))
  assert.equal(r1.findings.length, 0)
  const r2 = scanAlbum(album(8, { artist: 'CHVRCHES', albumArtist: 'CHVRCHES' }))
  assert.equal(r2.findings.length, 0)
})

test('DIFFERENT artists on one album (compilation) are not casing variance', () => {
  const tracks = [
    mk({ artist: 'Nas', albumArtist: 'Various Artists' }),
    mk({ artist: 'Mobb Deep', albumArtist: 'Various Artists' }),
    mk({ artist: 'Raekwon', albumArtist: 'Various Artists' }),
  ]
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'artist').length, 0)
})

test('tied casing forms flag instead of guessing', () => {
  const tracks = [mk({ artist: 'Wolf Parade' }), mk({ artist: 'wolf parade' })]
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'artist').length, 0)
  assert.ok(r.flags.some(fl => fl.kind === 'artist-variance'))
})

test('feat variance flags when multiple styles present', () => {
  const tracks = [
    mk({ title: 'One (feat. A)' }),
    mk({ title: 'Two (featuring B)' }),
    mk({ title: 'Three' }),
  ]
  const r = scanAlbum(tracks)
  assert.ok(r.flags.some(fl => fl.kind === 'feat-variance'))
})

test('all-lowercase title outlier among capitalized titles → judgment finding', () => {
  const tracks = album(8)
  tracks[5] = mk({ ...tracks[5], title: 'comfortably numb' })
  const r = scanAlbum(tracks)
  const f = r.findings.find(f => f.field === 'title' && f.oldValue === 'comfortably numb')
  assert.ok(f)
  assert.equal(f!.newValue, 'Comfortably Numb')
  assert.equal(f!.provable, false)
})

test('ALL-CAPS titles are left alone (stylization)', () => {
  const tracks = album(8)
  tracks[5] = mk({ ...tracks[5], title: 'SUNSHOWER' })
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'title').length, 0)
})

test('uniformly lowercase album (intentional style) is untouched', () => {
  const tracks = album(8).map((t, i) => mk({ ...t, title: `song ${i + 1}` }))
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'title').length, 0)
})

test('duplicate + missing track numbers become flags, not fixes', () => {
  const tracks = [
    mk({ trackNumber: 1 }), mk({ trackNumber: 1 }), mk({ trackNumber: '' }),
  ]
  const r = scanAlbum(tracks)
  assert.ok(r.flags.some(fl => fl.kind === 'duplicate-track-number'))
  assert.ok(r.flags.some(fl => fl.kind === 'missing-track-number'))
  assert.equal(r.findings.filter(f => f.field === 'trackNumber').length, 0)
})

test('year + genre variance flag only', () => {
  const tracks = [
    mk({ year: 1994, genre: 'Hip-Hop' }),
    mk({ year: 2005, genre: 'Rap' }),
  ]
  const r = scanAlbum(tracks)
  assert.ok(r.flags.some(fl => fl.kind === 'year-variance'))
  assert.ok(r.flags.some(fl => fl.kind === 'genre-variance'))
  assert.equal(r.findings.filter(f => f.field === 'year' || f.field === 'genre').length, 0)
})

test('empty scope is a no-op', () => {
  const r = scanAlbum([])
  assert.equal(r.findings.length, 0)
  assert.equal(r.flags.length, 0)
})
