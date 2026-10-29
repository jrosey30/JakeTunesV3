// Going / I went + "What they've been playing" (2026-10-29): the shared
// rules (src/common/concerts-going.ts) and the homemini client
// (src/main/concerts-going-client.ts) against a fake homemini. No network.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  goingAfterTap, latelyDetail, latelyPlayLabel, nextAsk, parseLately, parseRsvps, type RsvpEntry,
} from '../../common/concerts-going.ts'
import { createConcertsGoingClient, type GoingFetch } from '../concerts-going-client.ts'

const show = (date: string, artist = 'Geese') => ({ artist, venue: 'Brooklyn Steel', date })

describe('concerts-going rules', () => {
  it('parseRsvps keeps good rows (with show, attended, ask) and drops junk', () => {
    const got = parseRsvps({ items: [
      { eventId: 'a', status: 'going', at: '2026-10-29T12:00:00.000Z', show: show('2026-10-28'), ask: true },
      { eventId: 'b', status: 'not', at: 'x', attended: 'yes', setlist: { id: 's', url: null, venue: 'X', city: null, songs: [] } },
      { eventId: '', status: 'going' },
      { eventId: 'c', status: 'maybe' },
      { eventId: 'd', status: 'going', show: { artist: 'No venue' } },
      'junk',
    ] })
    assert.deepEqual(got.map((e) => e.eventId), ['a', 'b', 'd'])
    assert.equal(got[0]!.ask, true)
    assert.equal(got[1]!.attended, 'yes')
    assert.equal(got[2]!.show, undefined, 'a half show is no show')
    assert.deepEqual(parseRsvps(null), [])
  })
  it('nextAsk: the oldest unanswered past Going show; answered or not-asked ones never', () => {
    const es: RsvpEntry[] = [
      { eventId: 'late', status: 'going', at: 'x', show: show('2026-10-28'), ask: true },
      { eventId: 'early', status: 'going', at: 'x', show: show('2026-10-20', 'Fat Dog'), ask: true },
      { eventId: 'done', status: 'going', at: 'x', show: show('2026-10-10'), ask: true, attended: 'no' },
      { eventId: 'future', status: 'going', at: 'x', show: show('2026-12-01'), ask: false },
    ]
    assert.equal(nextAsk(es)?.eventId, 'early')
    assert.equal(nextAsk(es.filter((e) => e.eventId !== 'early' && e.eventId !== 'late')), null)
  })
  it('a tap on Going toggles going ↔ cleared', () => {
    assert.equal(goingAfterTap(null), 'going')
    assert.equal(goingAfterTap('not'), 'going')
    assert.equal(goingAfterTap('going'), null)
  })
  it('parseLately: enabled false (no setlist.fm key) or no songs → nothing to draw', () => {
    assert.equal(parseLately({ enabled: false, artist: 'Geese', lately: null }), null)
    assert.equal(parseLately({ enabled: true, artist: 'Geese', lately: null }), null)
    assert.equal(parseLately({ enabled: true, lately: { shows: 3, songs: [] } }), null)
    const l = parseLately({ enabled: true, lately: { shows: 4, from: '2026-10-03', to: '2026-10-24', url: 'https://www.setlist.fm/x',
      songs: [{ name: 'Cobra', count: 4, position: 0.1, cover: null, trackId: '1', title: 'Cobra' }, { name: 'Glue', count: 2, position: 0.9, cover: 'Ramones', trackId: null, title: null }],
      ownedInSetOrder: ['1', 7] } })!
    assert.equal(l.songs.length, 2)
    assert.deepEqual(l.ownedInSetOrder, ['1'])
    assert.equal(latelyDetail(l.songs[0]!, 4), 'Every show · In your library')
    assert.equal(latelyDetail(l.songs[1]!, 4), '2 of 4 shows · Ramones cover · Not in your library')
    assert.equal(latelyPlayLabel(1), 'Play the 1 you own')
    assert.equal(latelyPlayLabel(5), 'Play the 5 you own, in set order')
  })
})

function fakeHomemini(replies: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []
  const f: GoingFetch = async (url, init) => {
    const i = (init ?? {}) as { method?: string; body?: string; headers?: Record<string, string> }
    calls.push({ url, method: i.method ?? 'GET', body: i.body ? JSON.parse(i.body) : null, headers: i.headers ?? {} })
    const path = url.replace('http://homemini:3000', '')
    const r = replies[`${i.method ?? 'GET'} ${path}`] ?? { status: 404 }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }
  }
  return { f, calls }
}

describe('concerts-going client', () => {
  const now = () => Date.UTC(2026, 9, 29, 16, 0, 0)
  it('PUTs going with when it was tapped (latest wins on homemini) and the card\'s show', async () => {
    const { f, calls } = fakeHomemini({ 'PUT /api/rsvps/G5abc': { status: 200, body: {} } })
    const c = createConcertsGoingClient({ baseUrl: 'http://homemini:3000/', fetchImpl: f, now })
    assert.equal(await c.setGoing('G5abc', 'going', show('2026-12-05')), true)
    assert.deepEqual(calls[0]!.body, { status: 'going', at: '2026-10-29T16:00:00.000Z', show: show('2026-12-05') })
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json')
    await c.setGoing('G5abc', null)
    assert.deepEqual(calls[1]!.body, { status: 'clear', at: '2026-10-29T16:00:00.000Z' })
  })
  it('PUTs "Were you there?" to /attended; ids are URL-encoded', async () => {
    const { f, calls } = fakeHomemini({ 'PUT /api/rsvps/dice%3A6a72/attended': { status: 200, body: {} } })
    const c = createConcertsGoingClient({ baseUrl: 'http://homemini:3000', fetchImpl: f, now })
    assert.equal(await c.setAttended('dice:6a72', 'yes'), true)
    assert.deepEqual(calls[0]!.body, { answer: 'yes', at: '2026-10-29T16:00:00.000Z' })
  })
  it('homemini away: false / null, never a throw', async () => {
    const f: GoingFetch = async () => { throw new Error('ECONNREFUSED') }
    const c = createConcertsGoingClient({ baseUrl: 'http://homemini:3000', fetchImpl: f, now })
    assert.equal(await c.setGoing('x', 'going'), false)
    assert.equal(await c.rsvps(), null)
    assert.equal(await c.lately('Geese'), null)
  })
  it('lately: a refusal (not a Going act) or no key is nothing to draw', async () => {
    const { f } = fakeHomemini({
      'GET /api/concerts/lately?artist=Geese': { status: 403, body: { error: 'only for shows you are going to' } },
      'GET /api/concerts/lately?artist=Man%2FWoman%2FChainsaw': { status: 200, body: { enabled: false, artist: 'Man/Woman/Chainsaw', lately: null } },
    })
    const c = createConcertsGoingClient({ baseUrl: 'http://homemini:3000', fetchImpl: f, now })
    assert.equal(await c.lately('Geese'), null)
    assert.equal(await c.lately('Man/Woman/Chainsaw'), null)
  })
})
