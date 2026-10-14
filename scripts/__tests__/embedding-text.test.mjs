// Brief 181 — byte-equality guard for the single-sourced brain texts.
//
// The reference implementations below are the OLD hand-synced twins,
// mechanically extracted from JakeTunesV3 main 12bb43b (trainer:
// scripts/brain-trainer.mjs; app: src/main/ai/embeddings.ts +
// tempo-energy.ts + mood-index.ts) BEFORE the single-sourcing. They are
// frozen here as the "before" — the canonical module in
// src/common/embedding-text.ts must reproduce them byte-for-byte:
//
//   - vs the old APP implementations: on EVERY fixture, including the
//     untrimmed-field class (whitespace-only album/genre/artist, padded
//     year strings) — the canonical semantics are the app's trim-first ones.
//   - vs the old TRAINER implementations: on every fixture with
//     trimmed-or-absent fields. On the untrimmed class the old twins
//     DISAGREED with each other (that drift is why this brief exists), so
//     no single output could equal both; those cases are asserted against
//     the app only, and counted/listed in the untrimmed test below.
//
// Run: node --test scripts/__tests__/embedding-text.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseText, moodText, tempoEnergy } from '../../src/common/embedding-text.ts'
import { genreWithParents } from '../../src/common/mood-genre-line.ts'


import { oldTrainerBase, oldAppBase, oldTrainerMood, oldAppMood, oldTrainerTempo, oldAppTempo } from './embedding-text-old-impls.mjs'

// ── fixtures ──
// Fixture tracks for the Brief 181 no-op proof. Shapes mirror library.json:
// string fields or absent, year number|string, bpm number, keyConfidence
// number|string|null. The `ws` group is the pathological whitespace-only
// class, kept apart: the OLD twins already disagree there (see proof output).
export const fixtures = [
  // — normal, fully populated —
  { artist: 'The Beatles', title: 'Come Together', album: 'Abbey Road', year: 1969, genre: 'Rock', bpm: 82, keyRoot: 'D', keyMode: 'minor', camelotKey: '7A', keyConfidence: 0.9 },
  { artist: 'Daft Punk', title: 'Get Lucky', album: 'Random Access Memories', year: 2013, genre: 'Electronic', bpm: 116, keyRoot: 'F#', keyMode: 'minor', camelotKey: '11A', keyConfidence: 0.8 },
  { artist: 'Nina Simone', title: 'Feeling Good', album: 'I Put a Spell on You', year: 1965, genre: 'Jazz', bpm: 100, keyRoot: 'G', keyMode: 'minor', camelotKey: '6A', keyConfidence: null },
  // — missing / empty fields —
  { artist: 'Unknown Artist', title: 'Mystery Track' },
  { artist: '', title: '', album: '', year: 0, genre: '', bpm: 0 },
  { title: 'No Artist Song', album: 'Some Album', year: '1999', genre: 'Pop' },
  { artist: 'Solo', title: 'No Album', year: 2001, genre: 'Folk' },
  { artist: 'Solo', title: 'No Year', album: 'Record', genre: 'Folk' },
  { artist: 'Solo', title: 'String Year', album: 'Record', year: ' 2003 ', genre: 'Folk' },
  // — bpm boundaries (tempo bands: <88, <100, <112, <122, <134, >=134) —
  ...[87.9, 88, 99.9, 100, 111.9, 112, 121.9, 122, 133.9, 134, 200].map((bpm, i) => ({
    artist: 'Tempo Tester', title: `BPM ${bpm}`, album: 'T', year: 2020, genre: 'Electronic',
    bpm, keyRoot: 'A', keyMode: i % 2 ? 'major' : 'minor', camelotKey: '8A', keyConfidence: 0.9,
  })),
  // — key confidence edges —
  { artist: 'Keys', title: 'Conf At Floor', bpm: 120, keyRoot: 'C', keyMode: 'major', camelotKey: '8B', keyConfidence: 0.45, genre: 'Pop', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'Conf Below Floor', bpm: 120, keyRoot: 'C', keyMode: 'major', camelotKey: '8B', keyConfidence: 0.44, genre: 'Pop', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'Conf String Low', bpm: 120, keyRoot: 'C', keyMode: 'major', camelotKey: '8B', keyConfidence: '0.3', genre: 'Pop', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'Conf Empty String', bpm: 120, keyRoot: 'C', keyMode: 'major', camelotKey: '8B', keyConfidence: '', genre: 'Pop', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'Mode Weird Case', bpm: 95, keyRoot: 'E', keyMode: 'MINOR', camelotKey: '9A', keyConfidence: 0.99, genre: 'Rock', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'Mode Other', bpm: 95, keyRoot: 'E', keyMode: 'dorian', camelotKey: '9A', keyConfidence: 0.99, genre: 'Rock', album: 'K', year: 2010 },
  { artist: 'Keys', title: 'No Camelot', bpm: 95, keyRoot: 'E', keyMode: 'minor', keyConfidence: 0.99, genre: 'Rock', album: 'K', year: 2010 },
  // — genres: shared genre-line leaves + unknowns —
  { artist: 'Genre', title: 'Synthwave One', genre: 'Synthwave', bpm: 105, album: 'G', year: 2018 },
  { artist: 'Genre', title: 'Midwest', genre: 'Midwest Rap', bpm: 140, album: 'G', year: 2018 },
  { artist: 'Genre', title: 'Unknown Genre', genre: 'Zydeco', bpm: 130, album: 'G', year: 2018 },
  { artist: 'Genre', title: 'No Genre', bpm: 130, album: 'G', year: 2018 },
]
export const descriptors = ['warm analog synths over a driving beat, neon night drive', '', '  ', undefined, 'sparse piano, rain on windows, quiet melancholy']
// Pathological whitespace-only fields — old-vs-old comparison only.
export const wsFixtures = [
  { artist: ' ', title: 'T', album: 'A', year: 2000, genre: 'Rock' },
  { artist: 'A', title: 'T', album: ' ', year: 1999, genre: 'Rock' },
  { artist: 'A', title: 'T', album: 'A', year: 1999, genre: ' ' },
  { artist: 'A', title: 'T', year: ' 1999 ', genre: 'Rock' },
]


const DESCRIPTORS = ['warm analog synths over a driving beat, neon night drive', '', '  ', undefined, 'sparse piano, rain on windows, quiet melancholy']
// Fixtures whose string fields are untrimmed — the class where the old
// twins disagreed. Identified by the padded values themselves.
const isUntrimmed = (t) => [t.artist, t.title, t.album, t.genre, t.year].some(
  (v) => typeof v === 'string' && v !== v.trim())

test('canonical == old app implementations on every fixture (incl. untrimmed)', () => {
  for (const t of [...fixtures, ...wsFixtures]) {
    assert.equal(baseText(t), oldAppBase(t), `baseText ${JSON.stringify(t)}`)
    assert.equal(tempoEnergy(t), oldAppTempo(t), `tempoEnergy ${JSON.stringify(t)}`)
    for (const d of DESCRIPTORS) assert.equal(moodText(t, d), oldAppMood(t, d), `moodText ${JSON.stringify(t)} / ${JSON.stringify(d)}`)
  }
})

test('canonical == old trainer implementations on all trimmed-field fixtures', () => {
  const trimmed = fixtures.filter((t) => !isUntrimmed(t))
  assert.ok(trimmed.length >= 25)
  for (const t of trimmed) {
    assert.equal(baseText(t), oldTrainerBase(t), `baseText ${JSON.stringify(t)}`)
    assert.equal(tempoEnergy(t), oldTrainerTempo(t), `tempoEnergy ${JSON.stringify(t)}`)
    for (const d of DESCRIPTORS) assert.equal(moodText(t, d), oldTrainerMood(t, d), `moodText ${JSON.stringify(t)} / ${JSON.stringify(d)}`)
  }
})

test('the untrimmed class is exactly where the old twins had drifted', () => {
  const drifted = [...fixtures, ...wsFixtures].filter((t) => isUntrimmed(t) && oldTrainerBase(t) !== oldAppBase(t))
  assert.ok(drifted.length >= 5, `expected the known drift cases, got ${drifted.length}`)
  // and on that class the canonical output follows the app, byte-for-byte
  for (const t of drifted) assert.equal(baseText(t), oldAppBase(t))
})

test('the trainer no longer defines the twins locally', () => {
  const trainer = readFileSync(join(import.meta.dirname, '..', 'brain-trainer.mjs'), 'utf8')
  assert.match(trainer, /from '\.\.\/src\/common\/embedding-text\.ts'/)
  for (const fn of ['function baseText(t)', 'function moodText(t, d)', 'function tempoEnergy(t)']) {
    assert.equal(trainer.includes(fn), false, `trainer still defines ${fn}`)
  }
})
