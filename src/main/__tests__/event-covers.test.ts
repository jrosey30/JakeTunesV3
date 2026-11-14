// Event covers on the desktop (2026-11-13): what homemini's list becomes, and
// what is sent when Jake approves, skips, restores or names an event.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { eventCoverIntro, eventCoverMonth, parseEventCoverList, parseEventCoverProposal } from '../../common/event-covers.ts'
import { createEventCoverClient } from '../event-cover-client.ts'
import { forgetPeriodCover, periodCoverDataUrl, _resetPeriodCoverCache } from '../period-cover-cache.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROW = {
  ym: '2026-06', origin: 'jake', status: 'proposed', why: 'Jake named it', preview: '/api/event-covers/2026-06/preview?v=1',
  event: { title: 'The OG tip-in', number: '1.2', unit: 'seconds left', date: 'June 10', place: 'Madison Square Garden' },
  sources: [{ url: 'https://www.nba.com/news/starting-5-june-11-2026', quote: 'tip-in with 1.2 seconds left' }, { url: 'javascript:alert(1)', quote: 'x' }, { url: 'http://plain.example/x', quote: 'x' }],
}

describe('homemini’s list', () => {
  it('a month playlist has a month; nothing else does', () => {
    assert.equal(eventCoverMonth('month-2026-06'), '2026-06')
    for (const id of ['best-of-year', 'month-2026-13', 'jaketunes-month-2026-06', 'top-25', null, undefined]) assert.equal(eventCoverMonth(id), null, String(id))
  })
  it('a row becomes what the panel shows; only https links survive', () => {
    const p = parseEventCoverProposal(ROW)!
    assert.equal(p.title, 'The OG tip-in')
    assert.equal(p.line, '1.2 seconds left · June 10, Madison Square Garden')
    assert.deepEqual(p.sources.map((s) => [s.url, s.title]), [['https://www.nba.com/news/starting-5-june-11-2026', 'nba.com']])
    assert.equal(p.hasPreview, true)
    assert.equal(p.origin, 'jake')
  })
  it('a row that is not a proposal is dropped, never guessed at', () => {
    for (const bad of [null, {}, { ...ROW, ym: '2026-6' }, { ...ROW, status: 'live' }, { ...ROW, event: {} }]) assert.equal(parseEventCoverProposal(bad), null)
    assert.equal(parseEventCoverList({ proposals: [ROW, { nope: 1 }] })?.length, 1)
    assert.equal(parseEventCoverList({ lists: [] }), null)
  })
  it('the words say who proposed it and that nothing changes without a yes', () => {
    assert.match(eventCoverIntro({ origin: 'ai', status: 'proposed' }), /unless you approve/)
    assert.match(eventCoverIntro({ origin: 'jake', status: 'proposed' }), /You named this/)
    assert.match(eventCoverIntro({ origin: 'jake', status: 'approved' }), /own cover is kept/)
  })
})

describe('what is sent to homemini', () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl = (status: number, body: unknown = {}) => (async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null })
    return { status, json: async () => body, arrayBuffer: async () => new Uint8Array(2000).buffer }
  }) as never
  const client = (status: number, body?: unknown) => createEventCoverClient({ baseUrl: 'http://homemini:3000/', fetchImpl: fetchImpl(status, body), warn: () => undefined })

  it('approve, skip and restore go to that month; anything else is never sent', async () => {
    calls.length = 0
    assert.deepEqual(await client(200).decide('2026-06', 'approve'), { ok: true })
    assert.deepEqual(calls[0], { url: 'http://homemini:3000/api/event-covers/2026-06/decide', method: 'POST', body: { decision: 'approve' } })
    assert.equal((await client(200).decide('2026-06', 'publish')).ok, false)
    assert.equal((await client(200).decide('../x', 'approve')).ok, false)
    assert.equal(calls.length, 1)
  })
  it('homemini’s refusal is shown in its own words; away is away', async () => {
    assert.deepEqual(await client(409, { error: 'that month already wears its normal cover' }).decide('2026-06', 'restore'), { ok: false, away: false, error: 'that month already wears its normal cover' })
    const down = createEventCoverClient({ baseUrl: 'http://homemini:3000', fetchImpl: (async () => { throw new Error('offline') }) as never, warn: () => undefined })
    assert.deepEqual(await down.decide('2026-06', 'approve'), { ok: false, away: true, error: 'homemini is away' })
    assert.equal(await down.list(), null)
    assert.equal(await down.preview('2026-06'), null)
  })
  it('“this month’s cover is…” sends Jake’s words, trimmed; empty is not sent', async () => {
    calls.length = 0
    assert.equal((await client(200).wish('2026-08', '  the   eclipse ')).ok, true)
    assert.deepEqual(calls[0]?.body, { text: 'the eclipse' })
    assert.equal((await client(200).wish('2026-08', '   ')).ok, false)
    assert.equal(calls.length, 1)
  })
  it('the list and the preview are read', async () => {
    assert.equal((await client(200, { proposals: [ROW] }).list())?.[0]?.ym, '2026-06')
    assert.equal((await client(200).preview('2026-06'))?.length, 2000)
    assert.equal(await client(404).preview('2026-06'), null)
  })
})

describe('after Jake decides, the sidebar asks homemini again at once', () => {
  it('a kept cover is asked for again, not half an hour later', async () => {
    _resetPeriodCoverCache()
    const dir = mkdtempSync(join(tmpdir(), 'period-covers-'))
    let asks = 0
    const deps = { stateDir: dir, fetchCover: async () => { asks++; return { bytes: Buffer.alloc(3000, asks) } }, now: () => 5_000 }
    const a = await periodCoverDataUrl(deps, 'jaketunes-month-2026-06')
    assert.equal(await periodCoverDataUrl(deps, 'jaketunes-month-2026-06'), a)
    assert.equal(asks, 1)
    forgetPeriodCover('jaketunes-month-2026-06')
    assert.notEqual(await periodCoverDataUrl(deps, 'jaketunes-month-2026-06'), a)
    assert.equal(asks, 2)
  })
})
