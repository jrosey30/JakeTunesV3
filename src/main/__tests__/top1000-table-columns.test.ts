// The Top 1000's '#' column (2026-11-25, Jake's screenshot of the page in the
// one song table): the '#' was ~116 px with the rank at its far left, an empty
// speaker column sat between it and Name, and "▲523" / NEW needed that width.
// Now: a narrow '#' (48 px) with the rank right-aligned in tabular digits,
// homemini's movement as one small mark beside it, the speaker in that same
// slot on the playing row, and no speaker column of the table's own.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compactMovement, TOP_1000_RANK_COLUMN_WIDTH } from '../../common/rank-movement.ts'
import { withoutPlayingColumn } from '../../renderer/utils/songTableRules.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const read = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('the Top 1000 # column is narrow', () => {
  test('48 px — room for "1000" and one mark, nothing more', () => {
    assert.equal(TOP_1000_RANK_COLUMN_WIDTH, 48)
    const v = read('views', 'SmartPlaylistView.tsx')
    assert.match(v, /width: TOP_1000_RANK_COLUMN_WIDTH,/)
    assert.doesNotMatch(v, /TOP_1000_RANK_WIDTH = 116/)
  })
  test('the rank is right-aligned, the header too', () => {
    const css = read('styles', 'songs.css')
    assert.match(css, /\.songs-cell--lead\.songs-cell--rank-compact \{\s*justify-content: flex-end;/)
    assert.match(css, /\.songs-header-cell--rank-compact \{ justify-content: flex-end; text-align: right;/)
    assert.match(css, /\.rank-mark \{\s*flex: none;\s*width: 9px;/, 'the mark has a fixed slot, so the digits line up')
  })
})

describe('the movement is one small mark, or nothing', () => {
  const at = '2026-11-20'
  test('no comparison this week (comparedTo null): nothing', () => {
    assert.equal(compactMovement(5, { lastWeekRank: 9 }, null), null)
  })
  test('a song that held, or no word from homemini: nothing', () => {
    assert.equal(compactMovement(5, { lastWeekRank: 5 }, at), null)
    assert.equal(compactMovement(5, undefined, at), null)
  })
  test('up, down, new: one glyph, the places worked out from the ranks', () => {
    assert.deepEqual({ ...compactMovement(5, { lastWeekRank: 528 }, at)!, className: '' }, { glyph: '▲', className: '', title: 'Up 523 places (last week 528)' })
    assert.equal(compactMovement(9, { lastWeekRank: 8 }, at)!.title, 'Down 1 place (last week 8)')
    assert.equal(compactMovement(1000, { lastWeekRank: 1 }, at)!.title, 'Down 999 places (last week 1)')
    assert.equal(compactMovement(9, { isNew: true }, at)!.glyph, '●')
    assert.match(compactMovement(2, { lastWeekRank: 7 }, at)!.className, /rank-arrow--up rank-mark-glyph/, 'keeps the green/red colours')
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'common', 'rank-movement.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function compactMovement'))
    assert.doesNotMatch(fn, /mv\.arrow\b/, 'never parses the arrow text')
  })
  test('the mark and the speaker are named for screen readers; the glyph is 9 px', () => {
    const v = read('views', 'SmartPlaylistView.tsx')
    assert.match(v, /role="img" aria-label=\{mark\.title\}/)
    assert.match(v, /className="rank-playing" role="img" aria-label=\{`Now playing, number \$\{rank\}`\}[^>]*><SpeakerPlayingIcon \/><\/span>/)
    assert.doesNotMatch(read('styles', 'songs.css'), /\.rank-mark svg/, 'the speaker is never squeezed into the 9 px mark slot')
    assert.match(read('styles', 'songs.css'), /\.rank-mark-glyph \{ font-size: 9px;/)
  })
  test('the header # lines up with the digits (4 px in from the edge, like the cell)', () => {
    const css = read('styles', 'songs.css')
    assert.match(css, /\.songs-header-cell--rank-compact \{[^}]*padding-right: 4px;/)
    assert.match(css, /\.songs-cell--lead\.songs-cell--rank-compact \{[^}]*padding: 0 4px 0 2px;/)
  })
})

describe('no empty column beside the #', () => {
  const vis = [{ key: 'playing' }, { key: 'title' }, { key: 'time' }]
  test('a lead that shows the speaker takes the speaker column\'s place', () => {
    assert.deepEqual(withoutPlayingColumn(vis, [24, 240, 50], true), { visible: [{ key: 'title' }, { key: 'time' }], widths: [240, 50] })
  })
  test('every other page keeps its speaker column', () => {
    assert.deepEqual(withoutPlayingColumn(vis, [24, 240, 50], false), { visible: vis, widths: [24, 240, 50] })
  })
  test('the Top 1000 asks for it; the table applies it to header, rows and widths', () => {
    assert.match(read('views', 'SmartPlaylistView.tsx'), /showsPlaying: true,/)
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /withoutPlayingColumn\(columns\.visible, columns\.widths, !!lead\?\.showsPlaying\)/)
    assert.match(t, /visibleCols=\{visibleCols\}/)
    assert.match(t, /\{visibleCols\.map\(\(col, i\) => \(/)
    assert.doesNotMatch(t, /columns\.visible\.map\(/, 'the header draws the same columns as the rows')
  })
})
