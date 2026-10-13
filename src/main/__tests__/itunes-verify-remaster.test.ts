/**
 * itunesVerify's canonical-edition preference, remasters included
 * (2026-10-12) — twin of JakeTunesMobile itunesCanonical.test.ts. The phone
 * always preferred "Who Are You" over "Who Are You (Remastered 2015)"; the
 * desktop took whichever Apple listed first, because unwantedVersionOf never
 * flags a remaster (the download guard must not refuse one). Hebrew titles
 * are real iTunes IL titles, as in non-latin-version-markers.test.ts.
 * Offline: fetch is stubbed.
 */
import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { itunesVerify, acceptableHit } from '../discover-feed.ts'
import { addsRemasterStamp, unwantedVersionOf, rankStreamripCandidates } from '../streamrip-match.ts'

const HADAG = 'הדג נחש'            // Hadag Nahash

const song = (trackName: string, artistName: string) => ({
  trackName, artistName, collectionName: 'x', artworkUrl100: 'https://art/100x100bb.jpg', releaseDate: '2000-01-01T00:00:00Z',
})
const album = (collectionName: string, artistName: string) => ({
  collectionName, artistName, artworkUrl100: 'https://art/100x100bb.jpg', releaseDate: '1969-09-26T00:00:00Z',
})
const stub = (results: unknown[]) => {
  mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ results }) }))
}
afterEach(() => mock.restoreAll())

describe('itunesVerify prefers the original over a remaster', () => {
  it('a plain request skips "(Remastered 2015)" listed first', async () => {
    stub([song('Who Are You (Remastered 2015)', 'The Who'), song('Who Are You', 'The Who')])
    assert.equal((await itunesVerify('The Who Who Are You', 'song', { artist: 'The Who', title: 'Who Are You' }))?.title, 'Who Are You')
  })
  it('albums too', async () => {
    stub([album('Abbey Road (Remastered)', 'The Beatles'), album('Abbey Road', 'The Beatles')])
    assert.equal((await itunesVerify('The Beatles Abbey Road', 'album', { artist: 'The Beatles', title: 'Abbey Road' }))?.title, 'Abbey Road')
  })
  it('a Hebrew remastering is a remaster: "[שבלול - רימאסטרינג]" loses to the plain title', async () => {
    stub([song('למה לי לקחת ללב [שבלול - רימאסטרינג]', 'Artist'), song('למה לי לקחת ללב', 'Artist')])
    assert.equal((await itunesVerify('x', 'song', { artist: 'Artist', title: 'למה לי לקחת ללב' }))?.title, 'למה לי לקחת ללב')
  })
  it('a remaster still beats a different recording (live)', async () => {
    stub([song('Who Are You (Live)', 'The Who'), song('Who Are You (Remastered 2015)', 'The Who')])
    assert.equal((await itunesVerify('x', 'song', { artist: 'The Who', title: 'Who Are You' }))?.title, 'Who Are You (Remastered 2015)')
  })
  it('if the remaster is all Apple has, it still wins', async () => {
    stub([song('One (Remastered 2009)', 'Artist')])
    assert.equal((await itunesVerify('x', 'song', { artist: 'Artist', title: 'One' }))?.title, 'One (Remastered 2009)')
  })
  it('the #86 Hebrew live alias reaches itunesVerify: "(הופעה חיה)" loses to the studio cut', async () => {
    stub([song('לזוז (הופעה חיה)', HADAG), song('לזוז', HADAG)])
    assert.equal((await itunesVerify('x', 'song', { artist: HADAG, title: 'לזוז' }))?.title, 'לזוז')
  })
})

describe('addsRemasterStamp', () => {
  it('flags a stamp the request did not carry, in English or Hebrew', () => {
    assert.equal(addsRemasterStamp('Who Are You', 'Who Are You (Remastered 2015)'), true)
    assert.equal(addsRemasterStamp('Who Are You', 'Who Are You - 2015 Remaster'), true)
    assert.equal(addsRemasterStamp('למה לי לקחת ללב', 'למה לי לקחת ללב [שבלול - רימאסטרינג]'), true)
    assert.equal(addsRemasterStamp('Who Are You', 'Who Are You'), false)
    assert.equal(addsRemasterStamp('Who Are You', 'Who Are You (Live)'), false)
  })
  it('a request that names the remaster keeps it, whichever word or language', () => {
    assert.equal(addsRemasterStamp('Who Are You (2015 Remaster)', 'Who Are You (Remastered 2015)'), false)
    assert.equal(addsRemasterStamp('למה לי לקחת ללב Remastered', 'למה לי לקחת ללב [Remastered - רימאסטרינג]'), false)
    assert.equal(addsRemasterStamp('למה לי לקחת ללב רימאסטרינג', 'למה לי לקחת ללב (Remastered)'), false)
  })
})

describe('the download side is unchanged: a remaster is the original recording', () => {
  it('the guard and the discovery gate never refuse a remaster', () => {
    assert.equal(unwantedVersionOf('One', 'One (Remastered 2009)'), null)
    assert.equal(unwantedVersionOf('למה לי לקחת ללב', 'למה לי לקחת ללב [שבלול - רימאסטרינג]'), null)
    assert.equal(acceptableHit({ artist: 'Artist', title: 'One' }, { artist: 'Artist', title: 'One (Remastered 2009)' }), true)
  })
  it('Qobuz ranking keeps the remaster as a candidate', () => {
    const { ranked, rejectedVersions } = rankStreamripCandidates('One', 'Artist', [
      { source: 'qobuz', mediaType: 'track', id: '1', desc: 'One (Remastered 2009) by Artist' },
    ])
    assert.equal(ranked.length, 1)
    assert.deepEqual(rejectedVersions, [])
  })
})
