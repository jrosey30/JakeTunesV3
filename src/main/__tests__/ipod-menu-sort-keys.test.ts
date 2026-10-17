/**
 * iPod Music-menu sort tables (type-52) use the FIRMWARE's key numbers:
 * 3 = Songs (title), 4 = Albums, 5 = Artists, 7 = Genres.
 *
 * 2026-10-17: db_reader had them rotated (3 album, 4 artist, 5 genre,
 * 7 title). The Mini's Artists screen read "Yeah Yeah Yeahs, Boy Harsher,
 * Twin Tribes, BELLA, DJ Split" — the first-seen artist order of the
 * GENRE-sorted table written under key 5. This runs the real writer
 * function (python3 is already a hard test requirement — see
 * ipod-db-contiguity.test.ts) so a re-rotation fails here, not on the iPod.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const coreDir = join(import.meta.dirname, '../../../core')

// Deliberately disagreeing fields: sorting by the wrong one gives a
// different order for every key.
const TRACKS = [
  { title: 'Charlie', album: 'Zed', artist: 'Mango', genre: 'Bravo' },
  { title: 'Alpha', album: 'Yak', artist: 'Kiwi', genre: 'Delta' },
  { title: 'Bravo', album: 'Xray', artist: 'Lime', genre: 'Alpha' },
  { title: 'Delta', album: 'Whiskey', artist: 'Jackfruit', genre: 'Charlie' },
]

function sortIndices(key: number): number[] {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(coreDir)})`,
    'from db_reader import _sort_indices',
    'tracks = json.loads(sys.stdin.read())',
    `print(json.dumps(_sort_indices(tracks, ${key})))`,
  ].join('\n')
  const r = spawnSync('python3', ['-c', script], { input: JSON.stringify(TRACKS), encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as number[]
}

const order = (field: keyof (typeof TRACKS)[number], idx: number[]): string[] => idx.map((i) => TRACKS[i][field])

test('type-52 key 3 is the Songs table (title order)', () => {
  assert.deepEqual(order('title', sortIndices(3)), ['Alpha', 'Bravo', 'Charlie', 'Delta'])
})

test('type-52 key 4 is the Albums table (album order)', () => {
  assert.deepEqual(order('album', sortIndices(4)), ['Whiskey', 'Xray', 'Yak', 'Zed'])
})

test('type-52 key 5 is the Artists table (artist order)', () => {
  assert.deepEqual(order('artist', sortIndices(5)), ['Jackfruit', 'Kiwi', 'Lime', 'Mango'])
})

test('type-52 key 7 is the Genres table (genre order)', () => {
  assert.deepEqual(order('genre', sortIndices(7)), ['Alpha', 'Bravo', 'Charlie', 'Delta'])
})
