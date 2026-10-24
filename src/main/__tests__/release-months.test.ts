/**
 * This year's releases month by month on the desktop (2026-10-24): parse
 * homemini's document, name the months, order a month's songs, adopt with an
 * ETag; and the JUSTIFICATION grouping of Jake's own playlists.
 * ⚠️ TWIN of JakeTunesMobile backend/src/util/releaseMonths.ts (the document).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monthPlaylistId, monthPlaylistName, monthTrackIds, parseMonthPlaylistId, parseReleaseMonths, yearsOf } from '../../common/release-months.ts'
import { pullReleaseMonthsOnce, currentReleaseMonths, RELEASE_MONTHS_FILE } from '../release-months.ts'
import { isJustificationPlaylist, justificationOrder, sortJustifications } from '../../renderer/utils/justification.ts'

const doc = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, builtAt: '2026-10-24T19:00:00Z', from: 2026, pending: 3,
  months: ['2026-12', '2026-09', '2026-10'],
  tracks: [['8', '2026-09', '2026-09-02', 'added'], ['3', '2026-09', '2026-09-12', 'mb'], ['7', '2026-10', '2026-10-20', 'added'], ['1', '2026-12', '2026-12-04', 'mb'], ['bad'], [9, '2026-12', 'x', 'mb']],
  ...over,
})

describe('release months (desktop)', () => {
  it('parses homemini\'s document, drops bad rows, sorts the months', () => {
    const r = parseReleaseMonths(doc())!
    assert.ok(r)
    assert.deepEqual(r.months, ['2026-09', '2026-10', '2026-12'])
    assert.equal(r.tracks.length, 4)
    assert.equal(r.pending, 3)
    assert.equal(parseReleaseMonths('nope'), null)
    assert.equal(parseReleaseMonths(doc({ v: 2 })), null)
    assert.equal(parseReleaseMonths(doc({ builtAt: 'yesterday' })), null)
  })

  it('ids, names, a month\'s songs in release order, the years', () => {
    const r = parseReleaseMonths(doc())!
    assert.equal(monthPlaylistId('2026-09'), 'month-2026-09')
    assert.equal(parseMonthPlaylistId('month-2026-09'), '2026-09')
    assert.equal(parseMonthPlaylistId('top-25'), null)
    assert.equal(monthPlaylistName('2026-09'), 'September 2026')
    assert.deepEqual(monthTrackIds(r, '2026-09'), [8, 3])
    assert.deepEqual(monthTrackIds(null, '2026-09'), [])
    assert.deepEqual(yearsOf(r), ['2026'])
    assert.deepEqual(yearsOf({ months: ['2027-01', '2026-12'] }), ['2026', '2027'])
    assert.deepEqual(yearsOf(null), [])
  })

  it('pulls with an ETag: 503 logged once, adopt, 304, an older copy ignored, malformed kept out', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'rm-'))
    const logs: string[] = []
    const calls: Array<Record<string, string>> = []
    let reply: () => Response = () => new Response('{"ok":false}', { status: 503 })
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      const o: Record<string, string> = {}
      h.forEach((v, k) => { o[k] = v })
      calls.push(o)
      return reply()
    }) as typeof fetch
    const host = { localDir, hubBase: () => 'http://hub', fetchImpl, log: (m: string) => logs.push(m) }

    assert.equal(await pullReleaseMonthsOnce(host), false)
    assert.equal(await pullReleaseMonthsOnce(host), false)
    assert.equal(logs.filter((l) => l.includes('HTTP 503')).length, 1, 'the same problem is logged once')

    reply = () => new Response(doc(), { status: 200, headers: { etag: '"rm-1"' } })
    assert.equal(await pullReleaseMonthsOnce(host), true)
    assert.equal(currentReleaseMonths()?.months.length, 3)
    assert.ok(existsSync(join(localDir, RELEASE_MONTHS_FILE)))

    reply = () => new Response(null, { status: 304 })
    assert.equal(await pullReleaseMonthsOnce(host), false)
    assert.equal(calls[calls.length - 1]!['if-none-match'], '"rm-1"')

    reply = () => new Response(doc({ builtAt: '2026-10-01T00:00:00Z', months: ['2026-01'], tracks: [] }), { status: 200, headers: { etag: '"rm-0"' } })
    assert.equal(await pullReleaseMonthsOnce(host), false, 'older than the copy in use')
    assert.equal(currentReleaseMonths()?.months.length, 3)

    reply = () => new Response('{"v":1', { status: 200 })
    assert.equal(await pullReleaseMonthsOnce(host), false)
    assert.equal(currentReleaseMonths()?.months.length, 3)
    assert.equal(await pullReleaseMonthsOnce({ ...host, hubBase: () => null }), false, 'no hub: nothing to do')
  })

  it('JUSTIFICATION: the name decides, the numeral orders', () => {
    assert.equal(isJustificationPlaylist('Justification'), true)
    assert.equal(isJustificationPlaylist('JUSTIFICATION IV: A NEW STREAM'), true)
    assert.equal(isJustificationPlaylist('Justifications of a Madman'), false)
    assert.equal(isJustificationPlaylist('My Justification'), false)
    assert.equal(justificationOrder('Justification'), 1)
    assert.equal(justificationOrder('Justification II'), 2)
    assert.equal(justificationOrder('JUSTIFICATION IV: A NEW STREAM'), 4)
    assert.equal(justificationOrder('JUSTIFICATION V: THE INDUSTRY STRIKES BACK'), 5)
    assert.equal(justificationOrder('JUSTIFICATION VI: NOT SURE'), 6)
    assert.equal(justificationOrder('Justification IX'), 9)
    assert.deepEqual(
      sortJustifications([{ name: 'JUSTIFICATION VI: NOT SURE' }, { name: 'Justification IX' }, { name: 'Justification' }, { name: 'JUSTIFICATION IV: A NEW STREAM' }, { name: 'Justification II' }]).map((p) => p.name),
      ['Justification', 'Justification II', 'JUSTIFICATION IV: A NEW STREAM', 'JUSTIFICATION VI: NOT SURE', 'Justification IX'],
    )
  })
})
