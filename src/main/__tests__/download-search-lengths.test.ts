/**
 * What a search row may say about a song's length (2026-11-04). Real rows: Apple's
 * search and artist lookup for The Notorious B.I.G. The row for "Respect" read explicit
 * at 274 s, the explicit file runs 321.3 s, and the judge refused it: the label hid the
 * clean length from every clean-row check downstream.
 */
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPreviewLengthResult, rowSeconds, searchItunesSuggestions } from '../download-search.ts'

const BIG = 'The Notorious B.I.G.'
const ARTIST_ID = 5499810
const track = (o: Record<string, unknown>): Record<string, unknown> => ({ wrapperType: 'track', kind: 'song', artistId: ARTIST_ID, artistName: BIG, ...o })
const RESPECT_CLEAN = track({ trackName: 'Respect', collectionName: 'Ready To Die the Remaster', collectionId: 204669415, trackExplicitness: 'cleaned', collectionExplicitness: 'cleaned', trackTimeMillis: 273733, trackCount: 19 })
const SKY_AMENDED = track({ trackName: "Sky's the Limit (feat. 112) [Amended]", collectionName: 'Life After Death [Amended Version] (2014 Remaster)', collectionId: 906586710, trackExplicitness: 'cleaned', collectionExplicitness: 'cleaned', trackTimeMillis: 277100, trackCount: 14 })
const SKIT_NOTHING_TO_CENSOR = track({ trackName: 'Skit', collectionName: 'Ready To Die the Remaster', collectionId: 204669415, trackExplicitness: 'notExplicit', collectionExplicitness: 'cleaned', trackTimeMillis: 91300, trackCount: 19 })
const RADIO_MIX = track({ trackName: 'Hypnotize (Radio Mix)', collectionName: 'Hypnotize - EP', collectionId: 901282154, trackExplicitness: 'notExplicit', collectionExplicitness: 'explicit', trackTimeMillis: 246600, trackCount: 4 })
const SNIPPET_CLEAN = track({ trackName: 'Juicy', collectionName: 'Ready To Die the Remaster', collectionId: 204669415, trackExplicitness: 'cleaned', collectionExplicitness: 'cleaned', trackTimeMillis: 29000, trackCount: 19 })
const EXPLICIT_ALBUMS = [
  { wrapperType: 'artist', artistName: BIG, artistId: ARTIST_ID },
  { wrapperType: 'collection', collectionExplicitness: 'explicit', collectionName: 'Ready to Die (The Remaster)', collectionId: 204669326, trackCount: 19 },
  { wrapperType: 'collection', collectionExplicitness: 'explicit', collectionName: 'Life After Death (2014 Remaster)', collectionId: 906888433, trackCount: 24 },
  { wrapperType: 'collection', collectionExplicitness: 'explicit', collectionName: 'Hypnotize - EP', collectionId: 901282154, trackCount: 4 },
]

const realFetch = globalThis.fetch
const json = (results: unknown[]): Response => new Response(JSON.stringify({ results }), { status: 200 })
/** Apple, by URL: the song search, the artist search, the artist's albums, the artist's songs. */
const stubApple = (songs: unknown[], artistSongs: unknown[] = []): void => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('entity=musicArtist')) return json(artistSongs.length ? [{ artistId: ARTIST_ID, artistName: BIG }] : [])
    if (url.includes('/lookup') && url.includes('entity=album')) return json(EXPLICIT_ALBUMS)
    if (url.includes('/lookup') && url.includes('entity=song')) return json(artistSongs)
    return json(songs)
  }) as typeof fetch
}

describe('a search row carries only a length it can stand behind', () => {
  beforeEach(() => { globalThis.fetch = realFetch })
  afterEach(() => { globalThis.fetch = realFetch })

  test('rowSeconds: only a rescued row off a clean track loses its length', () => {
    assert.equal(rowSeconds(RESPECT_CLEAN, true), undefined, 'rescued and flagged clean')
    assert.equal(rowSeconds(RESPECT_CLEAN, false), 274, 'not rescued: the row is the clean edition, and says so')
    assert.equal(rowSeconds(SKIT_NOTHING_TO_CENSOR, true), 91, 'rescued, nothing to censor')
    assert.equal(rowSeconds(track({ trackExplicitness: 'explicit', trackTimeMillis: 321300 }), true), 321, 'an explicit row')
    assert.equal(rowSeconds({}, false), undefined, 'no length at all')
  })

  test('"Respect": the real row points at the explicit edition, labelled explicit, with no length', async () => {
    stubApple([RESPECT_CLEAN])
    const [row] = (await searchItunesSuggestions(`${BIG} Respect`)).results
    assert.equal(row.song, 'Respect')
    assert.equal(row.explicitness, 'explicit')
    assert.equal(row.collectionId, 204669326)
    assert.equal(row.durationSecs, undefined)
  })

  test('a clean row with no explicit edition by that name keeps its length and its flag: main drops it', async () => {
    stubApple([SKY_AMENDED])
    const [row] = (await searchItunesSuggestions(`${BIG} Sky's the Limit`)).results
    assert.equal(row.explicitness, 'cleaned')
    assert.equal(row.collectionId, 906586710)
    assert.equal(row.durationSecs, 277)
  })

  test('rescued with nothing to censor, and an explicit album\'s row: the length is honest', async () => {
    stubApple([SKIT_NOTHING_TO_CENSOR, RADIO_MIX])
    const rows = (await searchItunesSuggestions(`${BIG} Skit`)).results
    assert.equal(rows.find((r) => r.song === 'Skit')?.durationSecs, 91)
    assert.equal(rows.find((r) => r.song === 'Hypnotize (Radio Mix)')?.durationSecs, 247)
  })

  test('the artist path, the same: its rows are rescued too, and the row it upgrades loses the clean length', async () => {
    stubApple([], [RESPECT_CLEAN, SKIT_NOTHING_TO_CENSOR, SKY_AMENDED])
    const rows = (await searchItunesSuggestions(BIG)).results
    const respect = rows.find((r) => r.song === 'Respect')
    assert.equal(respect?.explicitness, 'explicit')
    assert.equal(respect?.collectionId, 204669326)
    assert.equal(respect?.durationSecs, undefined)
    assert.equal(rows.find((r) => r.song === 'Skit')?.durationSecs, 91)
    assert.equal(rows.find((r) => r.song.startsWith("Sky's the Limit"))?.durationSecs, 277)
  })

  test('a 29-second snippet is still no song, rescued or not', async () => {
    assert.equal(isPreviewLengthResult(29, 'Juicy'), true)
    stubApple([SNIPPET_CLEAN, RESPECT_CLEAN])
    const rows = (await searchItunesSuggestions(`${BIG} Juicy`)).results
    assert.deepEqual(rows.map((r) => r.song), ['Respect'])
  })
})
