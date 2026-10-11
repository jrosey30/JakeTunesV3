/**
 * The Origin column (2026-10-11): where the artist is from, next to Genre,
 * visible by default, searchable.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { orderColumnKeys, DEFAULT_HIDDEN } from '../../renderer/utils/columnState.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')

describe('a new column lands next to its neighbour', () => {
  const defaults = ['playing', 'title', 'artist', 'album', 'genre', 'origin', 'subgenre', 'year']
  it("Origin appears right after Genre in a saved order that predates it", () => {
    const saved = ['title', 'artist', 'genre', 'album', 'year', 'subgenre', 'playing']
    assert.deepEqual(orderColumnKeys(saved, defaults), ['title', 'artist', 'genre', 'origin', 'album', 'year', 'subgenre', 'playing'])
  })
  it('a saved order is kept exactly; unknown keys drop out', () => {
    const saved = ['origin', 'title', 'rating', 'artist', 'album', 'genre', 'subgenre', 'year', 'playing']
    assert.deepEqual(orderColumnKeys(saved, defaults), ['origin', 'title', 'artist', 'album', 'genre', 'subgenre', 'year', 'playing'])
  })
  it('no saved order = the default layout', () => {
    assert.deepEqual(orderColumnKeys([], defaults), defaults)
  })
})

describe('wired into Song View', () => {
  const view = readFileSync(join(R, 'views', 'SongsView.tsx'), 'utf8')
  it('declared after Genre, rendered, and not hidden by default', () => {
    assert.match(view, /key: 'genre'[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*\{ key: 'origin', label: 'Origin'/)
    assert.match(view, /case 'origin':/)
    assert.ok(!DEFAULT_HIDDEN.includes('origin'), 'he asked for it — visible')
  })
  it('searchable and sortable', () => {
    assert.match(readFileSync(join(R, 'hooks', 'useSortedTracks.ts'), 'utf8'), /t\.origin \|\| ''/)
    assert.match(readFileSync(join(R, 'types.ts'), 'utf8'), /SortColumn = [^\n]*'origin'/)
  })
})
