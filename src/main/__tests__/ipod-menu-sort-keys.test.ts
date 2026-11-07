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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPOD_SORT_KEEP_THE_FILE, orderTracksForIpodTitleIndex } from '../ipod-artist-sort.ts'

const coreDir = join(import.meta.dirname, '../../../core')

// Deliberately disagreeing fields: sorting by the wrong one gives a
// different order for every key.
const TRACKS = [
  { title: 'Charlie', album: 'Zed', artist: 'Mango', genre: 'Bravo' },
  { title: 'Alpha', album: 'Yak', artist: 'Kiwi', genre: 'Delta' },
  { title: 'Bravo', album: 'Xray', artist: 'Lime', genre: 'Alpha' },
  { title: 'Delta', album: 'Whiskey', artist: 'Jackfruit', genre: 'Charlie' },
]

function sortIndices(key: number, tracks: unknown[] = TRACKS, home?: string): number[] {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(coreDir)})`,
    'from db_reader import _sort_indices',
    'tracks = json.loads(sys.stdin.read())',
    `print(json.dumps(_sort_indices(tracks, ${key})))`,
  ].join('\n')
  // A temp HOME so a real kill-switch file on this Mac can't change the answer.
  const tmpHome = home ?? mkdtempSync(join(tmpdir(), 'jt-sort-home-'))
  const r = spawnSync('python3', ['-c', script], {
    input: JSON.stringify(tracks),
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpHome },
  })
  if (!home) rmSync(tmpHome, { recursive: true, force: true })
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

// 2026-11-07: Music menus drop a leading The/A/An, like the desktop app.
// The Python tables and the TS twin must put the same songs in the same
// order, or the halves split. Kill switch: ~/.config/jaketunes/ipod-sort-keep-the.
const MIXED = [
  { title: 'The End', artist: 'The Doors', album: 'The Doors', genre: 'Rock' },
  { title: 'Last Nite', artist: 'The Strokes', album: 'Is This It', genre: 'Rock' },
  { title: 'Tiësto Mix', artist: 'Tiësto', album: 'Elements of Life', genre: 'Electronic' },
  { title: 'Dog Eat Dog', artist: 'Entrañas', album: 'Entrañas', genre: 'Rock' },
  { title: 'Taste', artist: 'Sabrina Carpenter', album: 'Short n Sweet', genre: 'Pop' },
  { title: 'Stairway', artist: 'Led Zeppelin', album: 'IV', genre: 'Rock' },
]

test('Songs: Python key-3 table and TS title order agree (The dropped, accents folded)', () => {
  const py = sortIndices(3, MIXED).map((i) => MIXED[i].title)
  const ts = orderTracksForIpodTitleIndex(MIXED, false).map((t) => t.title)
  assert.deepEqual(py, ['Dog Eat Dog', 'The End', 'Last Nite', 'Stairway', 'Taste', 'Tiësto Mix'])
  assert.deepEqual(ts, py)
})

test('Artists: The-bands file under the next word, accented names fold', () => {
  const py = sortIndices(5, MIXED).map((i) => MIXED[i].artist)
  assert.deepEqual(py, ['The Doors', 'Entrañas', 'Led Zeppelin', 'Sabrina Carpenter', 'The Strokes', 'Tiësto'])
})

test('kill switch: both halves keep The under T', () => {
  const home = mkdtempSync(join(tmpdir(), 'jt-keep-the-'))
  try {
    mkdirSync(join(home, '.config', 'jaketunes'), { recursive: true })
    writeFileSync(join(home, IPOD_SORT_KEEP_THE_FILE), '')
    const py = sortIndices(3, MIXED, home).map((i) => MIXED[i].title)
    const ts = orderTracksForIpodTitleIndex(MIXED, true).map((t) => t.title)
    assert.deepEqual(py, ['Dog Eat Dog', 'Last Nite', 'Stairway', 'Taste', 'The End', 'Tiësto Mix'])
    assert.deepEqual(ts, py)
    const artists = sortIndices(5, MIXED, home).map((i) => MIXED[i].artist)
    assert.deepEqual(artists, ['Entrañas', 'Led Zeppelin', 'Sabrina Carpenter', 'The Doors', 'The Strokes', 'Tiësto'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
