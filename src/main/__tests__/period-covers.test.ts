// The month and year covers come from homemini (2026-11-13): which playlists
// ask, what is kept on this Mac, and what shows with homemini away.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPeriodCoverRemoteId, periodCoverRemoteId } from '../../common/period-covers.ts'
import { periodCoverDataUrl, PERIOD_COVER_RECHECK_MS, _resetPeriodCoverCache } from '../period-cover-cache.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'period-covers-'))
const jpegA = Buffer.alloc(4000, 7)
const jpegB = Buffer.alloc(4100, 9)
const ID = 'jaketunes-month-2026-11'

describe('which playlists wear a cover from homemini', () => {
  it('a month and the year map to homemini’s ids; nothing else does', () => {
    assert.equal(periodCoverRemoteId('month-2026-09', 2026), 'jaketunes-month-2026-09')
    assert.equal(periodCoverRemoteId('best-of-year', 2027), 'jaketunes-best-of-2027')
    for (const id of ['top-25', 'month-2026-13', 'month-2026-9', 'month-2026-09/..', 'jaketunes-month-2026-09', '', null, undefined, 7])
      assert.equal(periodCoverRemoteId(id, 2026), null, String(id))
    assert.equal(periodCoverRemoteId('best-of-year', Number.NaN), null)
  })
  it('only those ids ever name a file or a request', () => {
    assert.ok(isPeriodCoverRemoteId('jaketunes-month-2026-09'))
    assert.ok(isPeriodCoverRemoteId('jaketunes-best-of-2026'))
    for (const id of ['jaketunes-month-2026-09.jpg', '../jaketunes-month-2026-09', 'jaketunes-top-1000', 'jaketunes-month-2026-00', null])
      assert.equal(isPeriodCoverRemoteId(id), false, String(id))
  })
})

describe('a month cover from homemini', () => {
  beforeEach(() => _resetPeriodCoverCache())

  it('is fetched once, kept, and not asked for again within the half hour', async () => {
    const dir = tmp()
    const clock = { now: 1_000_000 }
    let asks = 0
    const fetchCover = async (path: string) => { asks++; assert.equal(path, `/api/playlist-cover/${ID}?s=640`); return { bytes: jpegA } }
    const a = await periodCoverDataUrl({ stateDir: dir, fetchCover, now: () => clock.now }, ID)
    assert.ok(a?.startsWith('data:image/jpeg;base64,'))
    assert.deepEqual(readFileSync(join(dir, 'period-covers', `${ID}.jpg`)), jpegA)
    clock.now += PERIOD_COVER_RECHECK_MS - 1
    assert.equal(await periodCoverDataUrl({ stateDir: dir, fetchCover, now: () => clock.now }, ID), a)
    assert.equal(asks, 1)
  })

  it('follows homemini when the month’s cover changes, and writes nothing when it has not', async () => {
    const dir = tmp()
    const clock = { now: 1_000_000 }
    let bytes = jpegA
    const deps = { stateDir: dir, fetchCover: async () => ({ bytes }), now: () => clock.now }
    const a = await periodCoverDataUrl(deps, ID)
    clock.now += PERIOD_COVER_RECHECK_MS
    assert.equal(await periodCoverDataUrl(deps, ID), a)                                   // same bytes
    bytes = jpegB
    clock.now += PERIOD_COVER_RECHECK_MS
    const b = await periodCoverDataUrl(deps, ID)
    assert.notEqual(b, a)
    assert.deepEqual(readFileSync(join(dir, 'period-covers', `${ID}.jpg`)), jpegB)
    assert.deepEqual(readdirSync(join(dir, 'period-covers')), [`${ID}.jpg`])              // no temp file left
  })

  it('with homemini away the kept cover shows, and it is asked again the next time', async () => {
    const dir = tmp()
    const clock = { now: 1_000_000 }
    const a = await periodCoverDataUrl({ stateDir: dir, fetchCover: async () => ({ bytes: jpegA }), now: () => clock.now }, ID)
    _resetPeriodCoverCache()                                                              // the app restarted
    let asks = 0
    const away = { stateDir: dir, fetchCover: async () => { asks++; throw new Error('offline') }, now: () => clock.now }
    assert.equal(await periodCoverDataUrl(away, ID), a)
    assert.equal(await periodCoverDataUrl(away, ID), a)
    assert.equal(asks, 2)
  })

  it('never kept and homemini away is null: the shipped cover shows', async () => {
    const dir = tmp()
    assert.equal(await periodCoverDataUrl({ stateDir: dir, fetchCover: async () => null }, ID), null)
    assert.ok(!existsSync(join(dir, 'period-covers', `${ID}.jpg`)))
  })

  it('an id that is not a month or a year never asks homemini and never touches the disk', async () => {
    const dir = tmp()
    const fetchCover = async () => { throw new Error('must not be asked') }
    for (const id of ['../../etc/passwd', 'jaketunes-top-1000', 'month-2026-11', '', null, 7])
      assert.equal(await periodCoverDataUrl({ stateDir: dir, fetchCover }, id), null)
    assert.ok(!existsSync(join(dir, 'period-covers')))
  })
})
