// Lifetime library stats (src/renderer/utils/libraryStats.ts) — the Home's
// old stats strip, now drawn in Settings › Library. Same numbers as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { libraryStats } from '../../renderer/utils/libraryStats.ts'

test('totals, top artist and top genre (plays + 1 per track), hours label tiers', () => {
  const s = libraryStats([
    { playCount: 40, duration: 3_600_000 * 300, albumArtist: 'Geese', artist: 'Geese', genre: 'Rock' },
    { playCount: '5', duration: 3_600_000 * 2, artist: 'Steely Dan', genre: 'Jazz Rock' },
    { playCount: null, duration: null, artist: 'Steely Dan', genre: 'Jazz Rock' },
    { playCount: 0, duration: 0, albumArtist: 'Various Artists', artist: 'Someone' },
  ])
  assert.equal(s.totalPlays, 45)
  assert.equal(s.topArtist, 'Geese')
  assert.equal(s.topGenre, 'Rock')
  assert.equal(s.hoursLabel, '302 hrs')
  assert.equal(libraryStats([{ duration: 3_600_000 * 1500 }]).hoursLabel, '1.5k hrs')
  assert.equal(libraryStats([{ duration: 3_600_000 * 12.5 }]).hoursLabel, '12.5 hrs')
})

test('an empty library says nothing it can’t back up', () => {
  assert.deepEqual(libraryStats([]), { totalPlays: 0, hoursLabel: '0.0 hrs', topArtist: '', topGenre: '' })
})
