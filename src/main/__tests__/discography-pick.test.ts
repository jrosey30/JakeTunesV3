// Jake, 2026-10-20, on the workmini Geese page: "why is my workmini have 3d
// country like this what a nightmare!!!" The tracklist was an unofficial
// 3-disc bundle (album + covers + live) concatenated. Fixture: MusicBrainz's
// four real 3D Country releases that day, in MusicBrainz's order.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickStandardRelease, isHiddenRelease } from '../../common/discography-pick.ts'

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, position: i + 1 }))
const threeDCountry = [
  { id: 'xw', date: '2023-06-23', status: 'Official', disambiguation: '', media: [{ tracks: tracks(11) }] },
  { id: 'bundle', date: '2023-06-03', status: null, disambiguation: '', media: [{ tracks: tracks(11) }, { tracks: tracks(3) }, { tracks: tracks(9) }] },
  { id: 'hires', date: '2023-06-23', status: 'Official', disambiguation: '24-Bit/44.1 kHz', media: [{ tracks: tracks(11) }] },
  { id: 'cd', date: '2023-06-23', status: 'Official', disambiguation: '', media: [{ tracks: tracks(11) }] },
]

describe('pickStandardRelease', () => {
  it('3D Country: the plain 11-track album, never the 3-disc bundle', () => {
    const r = pickStandardRelease(threeDCountry)
    assert.equal(r?.media?.reduce((n, m) => n + m.tracks.length, 0), 11)
    assert.notEqual(r?.id, 'bundle')
    assert.notEqual(r?.id, 'hires', 'an edition note ("24-Bit") loses a tie to the plain release')
  })
  it('the earliest release is not automatically the album (the bundle was earliest)', () => {
    assert.equal(threeDCountry.reduce((a, b) => (a.date < b.date ? a : b)).id, 'bundle')
  })
  it('deluxe loses to standard among official releases', () => {
    const r = pickStandardRelease([
      { id: 'deluxe', status: 'Official', date: '2020-01-01', media: [{ tracks: tracks(18) }] },
      { id: 'std', status: 'Official', date: '2020-01-01', media: [{ tracks: tracks(12) }] },
    ])
    assert.equal(r?.id, 'std')
  })
  it('a real double album keeps both discs', () => {
    const r = pickStandardRelease([{ id: 'dbl', status: 'Official', media: [{ tracks: tracks(14) }, { tracks: tracks(14) }] }])
    assert.equal(r?.id, 'dbl')
  })
  it('no official release → the smallest one; no tracks anywhere → null', () => {
    assert.equal(pickStandardRelease([{ id: 'a', media: [{ tracks: tracks(9) }] }, { id: 'b', media: [{ tracks: tracks(7) }] }])?.id, 'b')
    assert.equal(pickStandardRelease([{ id: 'e', media: [{ tracks: [] }] }]), null)
    assert.equal(pickStandardRelease(undefined), null)
  })
})

describe('Jake\'s hidden releases', () => {
  it('Bottomless Pink Lagoon is out of Geese ("it isnt anywhere")', () => {
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', 'Bottomless Pink Lagoon'), true)
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', 'bottomless pink lagoon '), true)
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', '3D Country'), false)
    assert.equal(isHiddenRelease('some-other-artist', 'Bottomless Pink Lagoon'), false)
  })
})

describe('wiring', () => {
  const body = (() => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    return src.slice(src.indexOf('async function fetchArtistDiscography('), src.indexOf("ipc.handle('get-artist-discography'"))
  })()
  it('the discography picks the standard edition and honours hidden releases', () => {
    assert.match(body, /pickStandardRelease\(relData\.releases\)/)
    assert.doesNotMatch(body, /relData\.releases\?\.\[0\]/)
    assert.match(body, /isHiddenRelease\(mbid, rg\.title\)/)
  })
})
