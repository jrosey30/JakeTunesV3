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
import { compactMovement, rankMovement, top1000Movement, TOP_1000_RANK_COLUMN_WIDTH } from '../../common/rank-movement.ts'
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
    assert.match(css, /\.songs-header-cell--rank-compact \{ justify-content: flex-end; text-align: right; \}/)
    assert.match(css, /\.rank-mark \{\s*flex: none;\s*width: 9px;/, 'the mark has a fixed slot, so the digits line up')
  })
})

describe('the movement is one small mark, or nothing', () => {
  test('no comparison this week (comparedTo null): nothing', () => {
    assert.equal(compactMovement(top1000Movement(5, { lastWeekRank: 9 }, null)), null)
  })
  test('a song that held: nothing', () => {
    assert.equal(compactMovement(top1000Movement(5, { lastWeekRank: 5 }, '2026-11-20')), null)
  })
  test('up, down, new: one glyph, the places in the tooltip', () => {
    assert.deepEqual(
      { ...compactMovement(top1000Movement(5, { lastWeekRank: 528 }, '2026-11-20'))!, className: '' },
      { glyph: '▲', className: '', title: 'Up 523 places (last week 528)' },
    )
    assert.equal(compactMovement(top1000Movement(9, { lastWeekRank: 8 }, '2026-11-20'))!.title, 'Down 1 place (last week 8)')
    assert.equal(compactMovement(top1000Movement(9, { isNew: true }, '2026-11-20'))!.glyph, '●')
    assert.equal(compactMovement(rankMovement(3, 3)), null)
    assert.match(compactMovement(rankMovement(2, 7))!.className, /rank-arrow--up/, 'keeps the green/red colours')
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
  test('the playing row shows the speaker in the mark slot', () => {
    assert.match(read('views', 'SmartPlaylistView.tsx'), /\{playing \? <SpeakerPlayingIcon \/> : mark && /)
  })
})
