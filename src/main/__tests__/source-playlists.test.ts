/** Where a song came from → the TikTok / Bandcamp / Savant auto playlists
 *  (Jake 2026-11-01). Newest import first, no cap. ⚠️ TWIN of the Mobile
 *  backend's util/__tests__/sourcePlaylists.test.ts — same cases. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_PLAYLISTS, isFromSource, isSourcePlaylistKey, sourcePlaylistTracks } from '../../common/source-playlists.ts'

const tracks = [
  { id: 1, title: 'old bandcamp', source: 'bandcamp', dateAdded: '2026-04-23' },
  { id: 2, title: 'tiktok today', addedVia: 'tiktok', dateAdded: '2026-11-01T19:32:00.000Z' },
  { id: 3, title: 'savant', addedVia: 'savant', dateAdded: '2026-10-30T12:00:00.000Z' },
  { id: 4, title: 'streamrip store buy', source: 'streamrip', dateAdded: '2026-10-31T19:14:00.000Z' },
  { id: 5, title: 'new bandcamp', source: 'bandcamp', dateAdded: '2026-10-31T23:29:00.000Z' },
  { id: 6, title: 'tiktok, no date', addedVia: 'TikTok ' },
  { id: 7, title: 'bandcamp link shared from the phone', addedVia: 'bandcamp', dateAdded: '2026-11-01T17:53:00.000Z' },
  { id: 8, title: 'instagram', addedVia: 'instagram', dateAdded: '2026-11-01T18:00:00.000Z' },
  { id: 9, title: 'plain import' },
]

describe('source playlists', () => {
  test('three lists, in the sidebar order', () => {
    assert.deepEqual(SOURCE_PLAYLISTS.map((p) => [p.key, p.name]), [['tiktok', 'TikTok'], ['bandcamp', 'Bandcamp'], ['savant', 'Savant']])
    assert.equal(isSourcePlaylistKey('tiktok'), true)
    assert.equal(isSourcePlaylistKey('instagram'), false)
    assert.equal(isSourcePlaylistKey(undefined), false)
  })
  test('TikTok: the phone adds asked for from TikTok, newest first, undated last; case and spaces forgiven', () => {
    assert.deepEqual(sourcePlaylistTracks(tracks, 'tiktok').map((t) => t.id), [2, 6])
  })
  test('Bandcamp: the desktop store purchases (source) and Bandcamp links shared from the phone (addedVia), newest first', () => {
    assert.deepEqual(sourcePlaylistTracks(tracks, 'bandcamp').map((t) => t.id), [7, 5, 1])
    assert.equal(isFromSource({ source: 'streamrip' }, 'bandcamp'), false, 'a Qobuz rip is not a Bandcamp purchase')
  })
  test('Savant: songs Savant recognised; other phone sources (Instagram, search) stay off every list', () => {
    assert.deepEqual(sourcePlaylistTracks(tracks, 'savant').map((t) => t.id), [3])
    const instagram = tracks[7]!
    for (const key of ['tiktok', 'bandcamp', 'savant'] as const) assert.equal(isFromSource(instagram, key), false)
    assert.equal(sourcePlaylistTracks([], 'savant').length, 0)
  })
  test('the input is never reordered or mutated', () => {
    const before = tracks.map((t) => t.id)
    sourcePlaylistTracks(tracks, 'bandcamp')
    assert.deepEqual(tracks.map((t) => t.id), before)
  })
})
