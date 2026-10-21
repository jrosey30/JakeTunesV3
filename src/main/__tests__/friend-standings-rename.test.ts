/**
 * Renamed is not deleted (2026-10-21, Jake: "why did jack lose a point").
 *
 * Jack Orlan's credit is the album "Above (Deluxe Edition)" by Mad Season,
 * stored as `abovedeluxeedition|madseason` with n0 = 14. All 14 tracks are
 * still in the library, but a metadata override renamed the album "Above",
 * so the stored key met nothing and the credit scored −1 instead of +5.
 * Standings now match the credited name exactly first, then by the
 * editionless name (radar-core editionlessTitle) on both sides, never across
 * artists, and never rewrite a stored key.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  albumKeyOfStrings, buildLibraryIndex, evaluateCredit, computeStandings, type CreditRecord,
} from '../friend-standings-core.ts'

const MAD_SEASON_TITLES = [
  'Wake Up', 'X-Ray Mind', 'River of Deceit', "I'm Above", 'Artificial Red', 'Lifeless Dead',
  "I Don't Know Anything", 'Long Gone Day', 'November Hotel', 'All Alone', 'Interlude',
  'Locomotive', 'Black Book Of Fear', 'Slip Away',
]
// The live rows: artist and albumArtist are the same string, as on most tracks.
const madSeason = (album: string, titles = MAD_SEASON_TITLES) =>
  titles.map((title) => ({ title, artist: 'Mad Season', albumArtist: 'Mad Season', album }))

// Jack's record, byte for byte as it sits in friend-credits.json.
const JACK: CreditRecord = {
  recoId: 'reco-jack', friend: 'Jack Orlan', kind: 'album',
  label: 'Above (Deluxe Edition) — Mad Season',
  albumKey: 'abovedeluxeedition|madseason', n0: 14,
  creditedAt: '2026-10-05T00:00:00.000Z',
}

const album = (label: string, albumName: string, artist: string, n0: number): CreditRecord => ({
  recoId: `a:${label}`, friend: 'Jack Orlan', kind: 'album', label,
  albumKey: albumKeyOfStrings(albumName, artist)!, n0, creditedAt: '2026-10-05T00:00:00.000Z',
})
const song = (title: string, artist: string): CreditRecord => ({
  recoId: `s:${title}`, friend: 'Lorin Bloom', kind: 'song', label: `${title} — ${artist}`,
  keys: [albumKeyOfStrings(title, artist)!], creditedAt: '2026-10-05T00:00:00.000Z',
})
const score = (r: CreditRecord, tracks: Parameters<typeof buildLibraryIndex>[0]) => {
  const e = evaluateCredit(r, buildLibraryIndex(tracks))
  return [e.status, e.points]
}

describe('Jack Orlan — the album was renamed, not deleted', () => {
  it('the stored key is what the sweep wrote (never rewritten)', () => {
    assert.equal(albumKeyOfStrings('Above (Deluxe Edition)', 'Mad Season'), JACK.albumKey)
  })
  it('14 tracks now filed under "Above" score +5', () => {
    assert.deepEqual(score(JACK, madSeason('Above')), ['kept', 5])
  })
  it('still +5 under the original name (the exact path is unchanged)', () => {
    assert.deepEqual(score(JACK, madSeason('Above (Deluxe Edition)')), ['kept', 5])
  })
  it('renamed AND one track deleted is a partial (+1), against n0', () => {
    assert.deepEqual(score(JACK, madSeason('Above', MAD_SEASON_TITLES.slice(1))), ['partial', 1])
  })
  it('on the board, Jack is +5 and keeps his credit', () => {
    const rows = computeStandings([JACK], { 'jack orlan': { name: 'Jack Orlan', adds: 1 } }, madSeason('Above'))
    assert.deepEqual(rows.map((r) => [r.name, r.points]), [['Jack Orlan', 5]])
  })
})

describe('edition renames, both directions', () => {
  it('an album that GAINED an edition tag still counts', () => {
    const r = album('Above — Mad Season', 'Above', 'Mad Season', 14)
    assert.deepEqual(score(r, madSeason('Above [2011 Remaster]')), ['kept', 5])
    assert.deepEqual(score(r, madSeason('Above - 20th Anniversary Edition')), ['kept', 5])
  })
  it('the edition tags Jake\'s library actually carries all fold away', () => {
    for (const renamed of ['Above (Remastered)', 'Above (Expanded)', 'Above (Bonus Track Version)', 'Above (Super Deluxe Edition)', 'Above – Anniversary Edition']) {
      assert.deepEqual(score(album('Above — Mad Season', 'Above', 'Mad Season', 14), madSeason(renamed)), ['kept', 5], renamed)
    }
  })
  it('a song that lost "(Remastered 2009)" is still +1', () => {
    const r = song('Wouldn\'t It Be Nice (Remastered 2009)', 'The Beach Boys')
    assert.equal(r.keys![0], 'wouldntitbeniceremastered2009|thebeachboys')
    assert.deepEqual(score(r, [{ title: "Wouldn't It Be Nice", artist: 'The Beach Boys' }]), ['kept', 1])
  })
  it('a song that gained " - 2011 Remaster" is still +1', () => {
    const r = song('Moving On and Getting Over', 'John Mayer')
    assert.deepEqual(score(r, [{ title: 'Moving On and Getting Over - 2011 Remaster', artist: 'John Mayer' }]), ['kept', 1])
  })
  it('a label with " — " inside the title still finds its split', () => {
    const r = album('Above — Expanded — Mad Season', 'Above — Expanded', 'Mad Season', 14)
    assert.deepEqual(score(r, madSeason('Above')), ['kept', 5])
  })
})

describe('what must NOT match', () => {
  it('a genuinely deleted album is still −1', () => {
    assert.deepEqual(score(JACK, []), ['deleted', -1])
    assert.deepEqual(score(JACK, madSeason('Live at the Moore', ['Wake Up', 'Lifeless Dead'])), ['deleted', -1])
  })
  it('a genuinely deleted song is still −1', () => {
    assert.deepEqual(score(song('Slip Away (Remastered)', 'Mad Season'), madSeason('Above', ['Wake Up'])), ['deleted', -1])
  })
  it('a similar base title by the same artist is a different album', () => {
    assert.deepEqual(score(JACK, madSeason('Above Ground')), ['deleted', -1])
    assert.deepEqual(score(album('Above Ground (Remastered) — Mad Season', 'Above Ground (Remastered)', 'Mad Season', 14), madSeason('Above')), ['deleted', -1])
  })
  it('another RECORDING of the album is not the album ("(Live)" is not an edition)', () => {
    assert.deepEqual(score(JACK, madSeason('Above (Live)')), ['deleted', -1])
    assert.deepEqual(score(song('Wake Up', 'Mad Season'), [{ title: 'Wake Up (Live)', artist: 'Mad Season' }]), ['deleted', -1])
  })
  it('never across artists', () => {
    const other = MAD_SEASON_TITLES.map((title) => ({ title, artist: 'Pearl Jam', albumArtist: 'Pearl Jam', album: 'Above' }))
    assert.deepEqual(score(JACK, other), ['deleted', -1])
    assert.deepEqual(score(JACK, madSeason('Above').map((t) => ({ ...t, artist: 'Mad Season Tribute', albumArtist: 'Mad Season Tribute' }))), ['deleted', -1])
    assert.deepEqual(score(song('Wake Up (Remastered)', 'Mad Season'), [{ title: 'Wake Up', artist: 'Mark Lanegan' }]), ['deleted', -1])
  })
  it('a label that does not reproduce the stored key gives no fold (fail closed)', () => {
    const r = { ...JACK, label: 'Imported before standings existed' }
    assert.deepEqual(score(r, madSeason('Above')), ['deleted', -1])
  })
  it('a label naming ANOTHER album never re-points the credit at it', () => {
    // The label is evidence only when it is the text the key was made from.
    const r = { ...JACK, label: 'Above Ground — Mad Season' }
    assert.deepEqual(score(r, madSeason('Above Ground')), ['deleted', -1])
  })
  it('…but a key with no edition words is its own fold', () => {
    const r = { ...album('Above — Mad Season', 'Above', 'Mad Season', 14), label: '' }
    assert.deepEqual(score(r, madSeason('Above (Deluxe Edition)')), ['kept', 5])
  })
})

describe('counting', () => {
  it('EXACT FIRST: a half-deleted deluxe cannot borrow tracks from a standard owned beside it', () => {
    // 10 of the 14 deluxe tracks remain under the credited name, and a
    // 10-track standard "Above" sits beside them. Folded together that is
    // 20 ≥ 14 — but the credited album is partial.
    const tracks = [...madSeason('Above (Deluxe Edition)', MAD_SEASON_TITLES.slice(0, 10)), ...madSeason('Above', MAD_SEASON_TITLES.slice(0, 10))]
    assert.deepEqual(score(JACK, tracks), ['partial', 1])
  })
  it('a track whose albumArtist IS its artist counts once (half an album deleted is partial, not intact)', () => {
    assert.deepEqual(score(JACK, madSeason('Above (Deluxe Edition)', MAD_SEASON_TITLES.slice(0, 7))), ['partial', 1])
    assert.deepEqual(score(JACK, madSeason('Above', MAD_SEASON_TITLES.slice(0, 7))), ['partial', 1])
    assert.equal(buildLibraryIndex(madSeason('Above')).albumCounts.get('above|madseason'), 14)
  })
  it('a track under a different albumArtist still indexes under both, once each', () => {
    const lib = buildLibraryIndex([{ title: 'Hunger Strike', artist: 'Temple of the Dog', albumArtist: 'Various Artists', album: 'Grunge Hits (Remastered)' }])
    assert.equal(lib.albumCounts.get('grungehitsremastered|templeofthedog'), 1)
    assert.equal(lib.albumCounts.get('grungehitsremastered|variousartists'), 1)
    assert.equal(lib.editionlessAlbumCounts.get('grungehits|templeofthedog'), 1)
  })
})
