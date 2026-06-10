import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeRediscovery, type RediscoveryTrack } from '../rediscovery.ts'

const NOW = new Date(2026, 5, 10, 12, 0, 0) // 2026-06-10

function trk(o: Partial<RediscoveryTrack>): RediscoveryTrack {
  return { albumArtist: o.albumArtist, artist: o.artist, album: o.album ?? 'A', genre: o.genre ?? 'Rock', playCount: o.playCount ?? 0, rating: o.rating ?? 0, dateAdded: o.dateAdded ?? '2026-01-01T00:00:00Z' }
}
function many(n: number, o: Partial<RediscoveryTrack>): RediscoveryTrack[] {
  return Array.from({ length: n }, (_, i) => trk({ ...o, album: o.album ?? `Alb${i % 2}` }))
}
const has = (picks: ReturnType<typeof computeRediscovery>, artist: string) => picks.some((p) => p.artist === artist)

test('surfaces an owned-but-unplayed artist', () => {
  const picks = computeRediscovery(many(4, { albumArtist: 'Turnstile', playCount: 0 }), NOW)
  assert.ok(has(picks, 'Turnstile'))
})

test('excludes artists already played enough (avg >= 1 play/track)', () => {
  const picks = computeRediscovery(many(4, { albumArtist: 'Heavy Rotation', playCount: 5 }), NOW)
  assert.equal(has(picks, 'Heavy Rotation'), false)
})

test('needs real ownership — a single unplayed track is not a rediscovery', () => {
  const picks = computeRediscovery([trk({ albumArtist: 'One Off', playCount: 0 })], NOW)
  assert.equal(has(picks, 'One Off'), false)
})

test('a starred-but-unplayed artist outranks a plain unplayed one', () => {
  const tracks = [
    ...many(3, { albumArtist: 'Loved', playCount: 0, rating: 5, genre: 'Soul' }),
    ...many(3, { albumArtist: 'Plain', playCount: 0, rating: 0, genre: 'Soul' }),
  ]
  const picks = computeRediscovery(tracks, NOW)
  const li = picks.findIndex((p) => p.artist === 'Loved')
  const pi = picks.findIndex((p) => p.artist === 'Plain')
  assert.ok(li >= 0 && pi >= 0 && li < pi)
})

test('recently-added-and-unplayed gets boosted over an old unplayed one', () => {
  const tracks = [
    ...many(3, { albumArtist: 'Fresh', playCount: 0, dateAdded: '2026-06-01T00:00:00Z', genre: 'Punk' }),
    ...many(3, { albumArtist: 'Stale', playCount: 0, dateAdded: '2022-01-01T00:00:00Z', genre: 'Punk' }),
  ]
  const picks = computeRediscovery(tracks, NOW)
  assert.ok(picks.findIndex((p) => p.artist === 'Fresh') < picks.findIndex((p) => p.artist === 'Stale'))
})

test('diversifies — no more than 3 picks from one genre', () => {
  const tracks: RediscoveryTrack[] = []
  for (let i = 0; i < 8; i++) tracks.push(...many(3, { albumArtist: `Band${i}`, playCount: 0, genre: 'Indie' }))
  const picks = computeRediscovery(tracks, NOW)
  assert.equal(picks.filter((p) => p.genre === 'Indie').length, 3)
})

test('skips Various Artists / compilations', () => {
  const picks = computeRediscovery(many(6, { albumArtist: 'Various Artists', playCount: 0 }), NOW)
  assert.equal(has(picks, 'Various Artists'), false)
})

test('empty library → no picks, no crash', () => {
  assert.deepEqual(computeRediscovery([], NOW), [])
})

test('pick carries the facts (owned count, plays, representative album)', () => {
  const picks = computeRediscovery(many(5, { albumArtist: 'Soulwax', album: 'Nite Versions', playCount: 0, genre: 'Dance' }), NOW)
  const p = picks.find((x) => x.artist === 'Soulwax')!
  assert.equal(p.ownedTracks, 5)
  assert.equal(p.plays, 0)
  assert.equal(p.album, 'Nite Versions')
  assert.ok(p.reason.length > 0)
})
