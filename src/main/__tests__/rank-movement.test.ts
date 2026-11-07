/** The '#' column's weekly movement, shared by Top 25 Most Played and Top 1000
 *  (Jake 2026-11-07: Top 1000 "similarly operates to how top 25 rankings operate"). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  rankMovement, rotateRankSnap, weekKeyOf, isRankedPlaylist, RANK_SNAPSHOT_KEYS, WEEK_MS,
} from '../../common/rank-movement.ts'

describe('rankMovement', () => {
  test('up: a better rank than last week is a green ▲ by the places gained', () => {
    assert.deepEqual(rankMovement(3, 10), { direction: 'up', arrow: '▲7', lwLabel: '(10)', arrowClass: 'rank-arrow rank-arrow--up' })
  })
  test('down: a worse rank is a red ▼ by the places lost', () => {
    assert.deepEqual(rankMovement(412, 400), { direction: 'down', arrow: '▼12', lwLabel: '(400)', arrowClass: 'rank-arrow rank-arrow--down' })
  })
  test('same: the same rank is a grey dash with last week in parens', () => {
    assert.deepEqual(rankMovement(5, 5), { direction: 'same', arrow: '—', lwLabel: '(5)', arrowClass: 'rank-arrow rank-arrow--same' })
  })
  test('new: not on last week\'s list is NEW, no parens', () => {
    assert.deepEqual(rankMovement(1000, undefined), { direction: 'new', arrow: 'NEW', lwLabel: '', arrowClass: 'rank-arrow rank-arrow--new' })
  })
})

describe('rotateRankSnap', () => {
  const wk = weekKeyOf(Date.UTC(2026, 10, 7))
  test('first ever: no last week, so every row is NEW', () => {
    const { next, changed } = rotateRankSnap(undefined, { 1: 1, 2: 2 }, wk)
    assert.deepEqual(next, { weekKey: wk, prev: null, curr: { 1: 1, 2: 2 } })
    assert.equal(changed, true)
  })
  test('same week: prev stays, curr refreshes', () => {
    const saved = { weekKey: wk, prev: { 1: 2, 2: 1 }, curr: { 1: 1, 2: 2 } }
    const { next, changed } = rotateRankSnap(saved, { 1: 2, 2: 1 }, wk)
    assert.deepEqual(next, { weekKey: wk, prev: { 1: 2, 2: 1 }, curr: { 1: 2, 2: 1 } })
    assert.equal(changed, true)
  })
  test('same week, same ranks: nothing to write', () => {
    const saved = { weekKey: wk, prev: { 1: 2 }, curr: { 1: 1 } }
    assert.equal(rotateRankSnap(saved, { 1: 1 }, wk).changed, false)
  })
  test('a new week: last week\'s curr becomes prev', () => {
    const saved = { weekKey: wk, prev: { 1: 9 }, curr: { 1: 1, 2: 2 } }
    const { next } = rotateRankSnap(saved, { 1: 2, 3: 1 }, wk + 1)
    assert.deepEqual(next, { weekKey: wk + 1, prev: { 1: 1, 2: 2 }, curr: { 1: 2, 3: 1 } })
  })
  test('a junk saved value starts fresh', () => {
    assert.deepEqual(rotateRankSnap({ nope: true }, { 1: 1 }, wk).next.prev, null)
  })
  test('weeks are 7-day buckets', () => {
    assert.equal(weekKeyOf(WEEK_MS * 3 + 1), 3)
  })
})

describe('each ranked list keeps its own snapshot', () => {
  test('Top 25 keeps its old key; Top 1000 has its own', () => {
    assert.equal(RANK_SNAPSHOT_KEYS['top-25'], 'topRankSnapshot')
    assert.equal(RANK_SNAPSHOT_KEYS['top-1000'], 'top1000RankSnapshot')
    assert.notEqual(RANK_SNAPSHOT_KEYS['top-25'], RANK_SNAPSHOT_KEYS['top-1000'])
  })
  test('only Top 25 and Top 1000 are ranked', () => {
    assert.equal(isRankedPlaylist('top-25'), true)
    assert.equal(isRankedPlaylist('top-1000'), true)
    assert.equal(isRankedPlaylist('top-rated'), false)
    assert.equal(isRankedPlaylist(null), false)
  })
  test('the view reads and writes the snapshot only by its list\'s key', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/SmartPlaylistView.tsx'), 'utf8')
    assert.match(view, /const key = RANK_SNAPSHOT_KEYS\[playlistId\]/)
    assert.match(view, /rotateRankSnap\(existing\[key\]/)
    assert.match(view, /\[key\]: next/)
    assert.doesNotMatch(view, /topRankSnapshot/, 'no hard-coded snapshot key in the view')
  })
})
