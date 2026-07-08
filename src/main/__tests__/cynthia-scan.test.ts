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

// ── Neat-freak sibling fills (2026-07-03 pass) ──

test('blank albumArtist fills from declared siblings (provable)', () => {
  const tracks = album(5)
  tracks[2] = mk({ ...tracks[2], albumArtist: '' })
  const r = scanAlbum(tracks)
  const f = r.findings.find(f => f.field === 'albumArtist')
  assert.ok(f)
  assert.equal(f!.newValue, 'Artist')
  assert.equal(f!.provable, true)
})

test('blank albumArtist fills from uniform artist when none declared', () => {
  const tracks = album(5, { albumArtist: '' as unknown as string })
  const r = scanAlbum(tracks)
  const fills = r.findings.filter(f => f.field === 'albumArtist')
  assert.equal(fills.length, 5)
  assert.ok(fills.every(f => f.newValue === 'Artist' && f.provable))
})

test('compilation (varied artists, no declared albumArtist) gets NO albumArtist fill', () => {
  const tracks = [
    mk({ artist: 'Nas', albumArtist: '' }),
    mk({ artist: 'AZ', albumArtist: '' }),
    mk({ artist: 'Cormega', albumArtist: '' }),
  ]
  const r = scanAlbum(tracks)
  assert.equal(r.findings.filter(f => f.field === 'albumArtist').length, 0)
})

test('blank genre fills from unanimous siblings; conflicted siblings do not fill', () => {
  const t1 = album(5, { genre: 'Punk' })
  t1[3] = mk({ ...t1[3], genre: '' })
  const r1 = scanAlbum(t1)
  const g = r1.findings.find(f => f.field === 'genre')
  assert.ok(g)
  assert.equal(g!.newValue, 'Punk')
  assert.equal(g!.provable, true)

  const t2 = [mk({ genre: 'Punk' }), mk({ genre: 'Rock' }), mk({ genre: '' })]
  const r2 = scanAlbum(t2)
  assert.equal(r2.findings.filter(f => f.field === 'genre').length, 0)
})

test('blank year fills from unanimous siblings (provable)', () => {
  const tracks = album(6, { year: 1994 })
  tracks[1] = mk({ ...tracks[1], year: '' })
  const r = scanAlbum(tracks)
  const y = r.findings.find(f => f.field === 'year')
  assert.ok(y)
  assert.equal(y!.newValue, '1994')
  assert.equal(y!.provable, true)
})

test('implausible future year flags — even on a single-track album', () => {
  // Regression: "GIVE UP YOUR LOVE TO ME - Single" shipped tagged 2031
  // and scanned clean — one track, so no variance class could see it.
  const r = scanAlbum([mk({ title: 'GIVE UP YOUR LOVE TO ME', year: 2031 })], 2026)
  const f = r.flags.filter(f => f.kind === 'year-implausible')
  assert.equal(f.length, 1)
  assert.match(f[0].detail, /2031/)
  assert.equal(r.findings.length, 0) // flag only — never a fix
})

test('year bounds: 1899 and nowYear+2 flag; 1900 and nowYear+1 (preorder) do not', () => {
  const implausible = (year: number) =>
    scanAlbum([mk({ year })], 2026).flags.filter(f => f.kind === 'year-implausible').length
  assert.equal(implausible(1899), 1)
  assert.equal(implausible(1900), 0)
  assert.equal(implausible(2027), 0)
  assert.equal(implausible(2028), 1)
})

test('blank year is not implausible', () => {
  const r = scanAlbum([mk({ year: '' })], 2026)
  assert.equal(r.flags.filter(f => f.kind === 'year-implausible').length, 0)
})

test('implausible year never seeds the sibling year fill', () => {
  const tracks = album(3, { year: 2031 })
  tracks[2] = mk({ ...tracks[2], year: '' })
  const r = scanAlbum(tracks, 2026)
  assert.equal(r.findings.filter(f => f.field === 'year').length, 0)
  assert.equal(r.flags.filter(f => f.kind === 'year-implausible').length, 2)
})
