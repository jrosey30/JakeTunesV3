import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickAddMatches } from '../../renderer/utils/quickAddMatch.ts'
import type { Track } from '../../renderer/types.ts'

const t = (id: number, title: string, artist: string, album = ''): Track => ({ id, title, artist, album } as unknown as Track)
const pool = [
  t(1, 'Move Along', 'The All-American Rejects', 'Move Along'),
  t(2, 'Dirty Little Secret', 'The All-American Rejects', 'Move Along'),
  t(3, 'Along Came Polly', 'Someone Else', 'Soundtrack'),
  t(4, 'Blurry', 'Puddle Of Mudd', 'Come Clean'),
  t(5, 'Café Tacvba Song', 'Café Tacvba', 'Re'),
]

test('quick add: every word must match; title-start hits rank first', () => {
  const r = quickAddMatches(pool, new Set(), 'along')
  assert.deepEqual(r.map(x => x.id), [3, 1, 2])
  assert.deepEqual(quickAddMatches(pool, new Set(), 'move along').map(x => x.id), [1, 2])
})

test('quick add: songs already on the playlist never show; empty query = nothing', () => {
  assert.deepEqual(quickAddMatches(pool, new Set([1]), 'move along').map(x => x.id), [2])
  assert.deepEqual(quickAddMatches(pool, new Set(), '   '), [])
})

test('quick add: accents fold so "cafe" finds Café', () => {
  assert.deepEqual(quickAddMatches(pool, new Set(), 'cafe').map(x => x.id), [5])
})
