/** Spotify taste signal — ranked aggregation + the anchors read. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import { aggregateTopArtists, saveSpotifyTaste, loadSpotifyTasteAnchors } from '../spotify-taste.ts'

const t = (artist: string, song = 'x') => ({ song, artist })

describe('aggregateTopArtists', () => {
  test('short-term listening outweighs a like, rank position matters', () => {
    const out = aggregateTopArtists([
      { tracks: [t('Current Obsession'), t('Current Obsession'), t('Also Playing')], weight: 3 },
      { tracks: [t('Old Like')], weight: 1 },
    ], 3)
    assert.equal(out[0], 'Current Obsession')
    assert.ok(out.includes('Also Playing'))
  })

  test('case-insensitive merge keeps the display name', () => {
    const out = aggregateTopArtists([{ tracks: [t('MGMT'), t('mgmt')], weight: 1 }], 2)
    assert.equal(out.length, 1)
  })

  test('caps at max and skips empty artists', () => {
    const tracks = Array.from({ length: 20 }, (_, i) => t(`A${i}`))
    tracks.push(t(''))
    assert.equal(aggregateTopArtists([{ tracks, weight: 1 }], 5).length, 5)
  })
})

describe('taste file round-trip', () => {
  test('save then load anchors; missing file = [] not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staste-'))
    const file = join(dir, 'spotify-taste.json')
    assert.deepEqual(await loadSpotifyTasteAnchors(file), [])
    await saveSpotifyTaste({ topArtists: ['A', 'B', 'C', 'D', 'E'], topTracks: [], likedRecent: [], pulledAt: '2026-08-28' }, file)
    assert.deepEqual(await loadSpotifyTasteAnchors(file, 3), ['A', 'B', 'C'])
  })
})
