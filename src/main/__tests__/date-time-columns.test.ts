/**
 * Date Added and Last Played, as Jake asked on 2026-11-05: 1/2/2004 5:56:02 PM.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatAppDateTime } from '../../renderer/utils/formatDate.ts'
import { DATE_TIME_COLUMN_WIDTH, orderColumnKeys, widenedForDateTime } from '../../renderer/utils/columnState.ts'

describe('formatAppDateTime', () => {
  test('his example', () => {
    assert.equal(formatAppDateTime(new Date(2004, 0, 2, 17, 56, 2)), '1/2/2004 5:56:02 PM')
  })

  test('no leading zero on the month, day or hour; the minutes and seconds keep theirs', () => {
    assert.equal(formatAppDateTime(new Date(2026, 10, 5, 9, 7, 3)), '11/5/2026 9:07:03 AM')
  })

  test('midnight and noon read as 12', () => {
    assert.equal(formatAppDateTime(new Date(2026, 0, 1, 0, 0, 0)), '1/1/2026 12:00:00 AM')
    assert.equal(formatAppDateTime(new Date(2026, 0, 1, 12, 0, 0)), '1/1/2026 12:00:00 PM')
  })

  test('an ISO stamp shows in local time, a millisecond number the same', () => {
    const d = new Date(2026, 10, 5, 21, 37, 0)
    assert.equal(formatAppDateTime(d.toISOString()), '11/5/2026 9:37:00 PM')
    assert.equal(formatAppDateTime(d.getTime()), '11/5/2026 9:37:00 PM')
  })

  test('a row that only stored the day shows the day, never a made-up time, and never the day before', () => {
    assert.equal(formatAppDateTime('2025-11-24'), '11/24/2025')
  })

  test('nothing to show', () => {
    assert.equal(formatAppDateTime(0), '')
    assert.equal(formatAppDateTime(''), '')
    assert.equal(formatAppDateTime(null), '')
    assert.equal(formatAppDateTime(undefined), '')
  })

  test('an unreadable string passes through visibly', () => {
    assert.equal(formatAppDateTime('sometime'), 'sometime')
  })
})

describe('the saved Songs layout', () => {
  test('a save from before the time of day is widened once, and only Date Added', () => {
    const before = { dateAdded: 100, title: 300 }
    assert.deepEqual(widenedForDateTime(before, 4), { dateAdded: DATE_TIME_COLUMN_WIDTH, title: 300 })
    assert.deepEqual(widenedForDateTime(before, undefined), { dateAdded: DATE_TIME_COLUMN_WIDTH, title: 300 })
  })

  test('a width he set afterwards stands, and so does a wide one', () => {
    assert.equal(widenedForDateTime({ dateAdded: 120 }, 5).dateAdded, 120)
    assert.equal(widenedForDateTime({ dateAdded: 200 }, 4).dateAdded, 200)
  })

  test('Last Played lands right after Date Added in a saved order', () => {
    const saved = ['title', 'year', 'dateAdded', 'playCount']
    const defaults = ['title', 'year', 'dateAdded', 'lastPlayedAt', 'playCount']
    assert.deepEqual(orderColumnKeys(saved, defaults), ['title', 'year', 'dateAdded', 'lastPlayedAt', 'playCount'])
  })
})
