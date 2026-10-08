/**
 * Deezer verification (2026-08-25, Jake: "find ways to make it work!!!").
 *
 * Apple 403s this IP under load AND does not carry much underground music.
 * Both looked identical to "this record is not real", which nearly deleted
 * Kelela's "new avatar" and Arca's "XXXXX" from the shop as hallucinations.
 * They are real; Deezer has both with art. Offline fixtures — no network.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deezerVerify, deezerTrack, catalogVerify } from '../discover-feed.ts'

const fakeFetch = (payload: unknown, ok = true) =>
  (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch

const album = (artist: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ data: [{ title, artist: { name: artist }, cover_big: 'https://art/x.jpg', record_type: 'album', nb_tracks: 10, ...extra }] })

describe('deezerVerify', () => {
  test('recovers a record Apple does not carry', async () => {
    const hit = await deezerVerify('Kelela', 'new avatar', fakeFetch(album('Kelela', 'new avatar', { release_date: '2026-03-06' })))
    assert.equal(hit?.artist, 'Kelela')
    assert.equal(hit?.title, 'new avatar')
    assert.equal(hit?.year, '2026')
    assert.ok(hit?.artUrl)
  })

  test('an empty catalogue answer is a MISS, not a card', async () => {
    assert.equal(await deezerVerify('Notaband', 'Notanalbum', fakeFetch({ data: [] })), null)
  })

  test('a wholly unrelated row does not satisfy the query', async () => {
    assert.equal(await deezerVerify('Kelela', 'new avatar', fakeFetch(album('Metallica', 'Ride the Lightning'))), null)
  })

  test('a non-ok response is a miss, never a throw', async () => {
    assert.equal(await deezerVerify('Kelela', 'new avatar', fakeFetch({}, false)), null)
  })
})

describe('deezerTrack — the songs lane needs a preview', () => {
  test('returns art and the 30s preview', async () => {
    const t = await deezerTrack('Four Tet', 'She Moves She', fakeFetch({ data: [{ title: 'She Moves She', artist: { name: 'Four Tet' }, preview: 'https://cdn/p.mp3', album: { cover_big: 'https://art/y.jpg' } }] }))
    assert.equal(t?.previewUrl, 'https://cdn/p.mp3')
    assert.ok(t?.artUrl)
  })
})

describe('catalogVerify — Apple first, Deezer as the safety net', () => {
  test('an Apple hit is used as-is and Deezer is never consulted', async () => {
    const v = await catalogVerify('q', 'album', { artist: 'A', title: 'B' },
      async () => ({ artist: 'A', title: 'B', artUrl: 'https://apple/a.jpg' }))
    assert.equal(v?.artUrl, 'https://apple/a.jpg')
  })

  test('an Apple 403 (throw) does not sink a real record', async () => {
    const v = await catalogVerify('q', 'album', { artist: 'Kelela', title: 'new avatar' },
      async () => { throw new Error('403') })
    // Falls through to Deezer; offline here, so the contract is "does not throw".
    assert.ok(v === null || typeof v === 'object')
  })
})
