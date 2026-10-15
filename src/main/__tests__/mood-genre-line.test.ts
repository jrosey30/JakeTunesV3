/**
 * The mood index's genre line (src/common/mood-genre-line.ts): the specific
 * genre AND its broad family/umbrella, so "pop music" still finds Synthwave
 * after the taxonomy (10/13 E3 rejection: "pop music" 0.80 -> 0.44).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { genreWithParents } from '../../common/mood-genre-line.ts'
import { GENRES } from '../../common/genre-vocab.ts'

const root = join(import.meta.dirname, '..', '..', '..')

describe('genre line: leaf + family + umbrella, no repeated words', () => {
  it('adds the broad names the leaf is missing', () => {
    assert.equal(genreWithParents('Synthwave'), 'Synthwave (New Wave & Synth, Pop)')
    assert.equal(genreWithParents('Midwest Rap'), 'Midwest Rap (Hip-Hop)')
    assert.equal(genreWithParents('Heavy Metal'), 'Heavy Metal (Rock)')
    assert.equal(genreWithParents('Tech House'), 'Tech House (Electronic & Dance)')
  })
  it('skips a parent whose words are already there', () => {
    assert.equal(genreWithParents('Synth-Pop'), 'Synth-Pop (New Wave & Synth)')
    assert.equal(genreWithParents('Indie Rock'), 'Indie Rock')
    assert.equal(genreWithParents('Rock'), 'Rock')
  })
  it('leaves off-berg and unknown genres alone, and empty stays empty', () => {
    assert.equal(genreWithParents('Soundtrack'), 'Soundtrack')
    assert.equal(genreWithParents('Some New Genre'), 'Some New Genre')
    assert.equal(genreWithParents('  '), '')
  })
  it('every vocab genre gets a line that still starts with its own name', () => {
    for (const g of GENRES) assert.ok(genreWithParents(g.name).startsWith(g.name), g.name)
  })
})

describe('both mood writers use the ONE shared function', () => {
  // Brief 181 moved both writers' mood text into ONE builder: moodText in
  // src/common/embedding-text.ts. The locks follow it there — same two
  // checks (imports genreWithParents from mood-genre-line.ts; the mood
  // text body calls it) — plus the link proving each writer uses it.
  const shared = readFileSync(join(root, 'src/common/embedding-text.ts'), 'utf8')
  const sharedMoodBody = shared.slice(shared.indexOf('export function moodText('), shared.indexOf('export function moodText(') + 700)
  it('the nightly trainer', () => {
    const src = readFileSync(join(root, 'scripts/brain-trainer.mjs'), 'utf8')
    assert.match(src, /import \{[^}]*\bmoodText\b[^}]*\} from '\.\.\/src\/common\/embedding-text\.ts'/)
    assert.match(shared, /import \{ genreWithParents \} from '\.\/mood-genre-line\.ts'/)
    assert.match(sharedMoodBody, /genreWithParents\(/)
  })
  it('the app', () => {
    const src = readFileSync(join(root, 'src/main/ai/mood-index.ts'), 'utf8')
    assert.match(src, /import \{[^}]*\bmoodText\b[^}]*\} from '\.\.\/\.\.\/common\/embedding-text\.ts'/)
    const body = src.slice(src.indexOf('export function buildMoodText'), src.indexOf('export function buildMoodText') + 700)
    assert.match(body, /\bmoodText\(/)
    assert.match(sharedMoodBody, /genreWithParents\(/)
  })
})
