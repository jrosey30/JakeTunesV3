/**
 * Listening Memory on the desktop Home = the phone's quote, no stat cards
 * (Jake, 2026-06-09: "no need for those new cards but i like the quote").
 *   - the rule (common/listening-quote.ts, twin of the phone backend);
 *   - homemini's line first (main/listening-quote-hub.ts);
 *   - the Home renders the line and none of the six cards.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listeningQuote, listeningQuoteFacts, hubListeningQuote, type QuoteFacts } from '../../common/listening-quote.ts'
import { createHubListeningQuote, type QuoteFetchLike } from '../listening-quote-hub.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

const DAY = 24 * 60 * 60 * 1000
const base: QuoteFacts = {
  totalLoggedPlays: 50, currentStreakDays: 0, goldenHour: null, goldenMax: 0,
  bingePlays: 0, comebackArtist: null, comebackGapDays: 0, topArtistThisWeek: null,
}

describe('listeningQuote — the phone backend templates, in its order', () => {
  it('says nothing under 10 plays (the phone hides the quote)', () => {
    assert.equal(listeningQuote({ ...base, totalLoggedPlays: 9, topArtistThisWeek: 'Geese' }), null)
  })
  it('comeback first', () => {
    assert.equal(
      listeningQuote({ ...base, comebackArtist: 'The Orb', comebackGapDays: 34, bingePlays: 40, currentStreakDays: 9 }),
      'The Orb, back after 34 days away. Welcome home.',
    )
  })
  it('then binge (15+), golden hour (8+ plays), streak (3+), this week', () => {
    assert.equal(listeningQuote({ ...base, bingePlays: 15, goldenHour: 23, goldenMax: 20 }), "15 spins in one day. That wasn't background music.")
    assert.equal(listeningQuote({ ...base, bingePlays: 14, goldenHour: 23, goldenMax: 8 }), '11 PM is your golden hour. The needle knows.')
    assert.equal(listeningQuote({ ...base, goldenHour: 0, goldenMax: 7, currentStreakDays: 3 }), '3 days straight. The streak is alive.')
    assert.equal(listeningQuote({ ...base, currentStreakDays: 2, topArtistThisWeek: 'Geese' }), 'This week belongs to Geese.')
    assert.equal(listeningQuote(base), null)
  })
})

describe('listeningQuoteFacts — the phone backend definitions', () => {
  const now = new Date(2026, 9, 21, 15, 0, 0)
  const at = (daysAgo: number, hour = 14): number => new Date(2026, 9, 21 - daysAgo, hour, 0, 0).getTime()
  it('counts a streak through today, or through yesterday', () => {
    const f = listeningQuoteFacts([at(0), at(1), at(2), at(4)].map((ms) => ({ ms })), now)
    assert.equal(f.currentStreakDays, 3)
    const g = listeningQuoteFacts([at(1), at(2)].map((ms) => ({ ms })), now)
    assert.equal(g.currentStreakDays, 2)
  })
  it('a comeback is a play in the last 14 days after 21+ days of silence; biggest gap wins', () => {
    const f = listeningQuoteFacts([
      { ms: at(60), artist: 'Nirvana' }, { ms: at(3), artist: 'Nirvana' },
      { ms: at(40), artist: 'Geese' }, { ms: at(10), artist: 'Geese' },
      { ms: at(90), artist: 'Rush' }, { ms: at(20), artist: 'Rush' }, // latest is 20 days ago: not a comeback
    ], now)
    assert.equal(f.comebackArtist, 'Nirvana')
    assert.equal(f.comebackGapDays, 57)
  })
  it('binge = the most plays in one day; golden hour = the busiest hour; this week = 7 days', () => {
    const evs = [
      ...Array.from({ length: 5 }, () => ({ ms: at(2, 23), artist: 'The Orb' })),
      { ms: at(9, 10), artist: 'Geese' },
    ]
    const f = listeningQuoteFacts(evs, now)
    assert.equal(f.bingePlays, 5)
    assert.equal(f.goldenHour, 23)
    assert.equal(f.goldenMax, 5)
    assert.equal(f.topArtistThisWeek, 'The Orb')
    assert.equal(f.totalLoggedPlays, 6)
  })
  it('ignores events with no usable time', () => {
    assert.equal(listeningQuoteFacts([{ ms: Number.NaN }], now).totalLoggedPlays, 0)
  })
})

describe('hubListeningQuote — homemini /api/listening-memory', () => {
  it('reads the observation the phone shows', () => {
    assert.equal(hubListeningQuote({ totalLoggedPlays: 120, observation: ' This week belongs to Geese. ' }), 'This week belongs to Geese.')
  })
  it('null where the phone shows nothing, or for anything that is not the document', () => {
    assert.equal(hubListeningQuote({ totalLoggedPlays: 9, observation: 'The log is young. Keep spinning.' }), null)
    assert.equal(hubListeningQuote({ totalLoggedPlays: 120, observation: null }), null)
    assert.equal(hubListeningQuote('<html>'), null)
    assert.equal(hubListeningQuote(null), null)
  })
})

describe('createHubListeningQuote', () => {
  const reply = (body: unknown, ok = true): ReturnType<QuoteFetchLike> => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body })
  it("homemini's line, reused while fresh; the GET goes to /api/listening-memory", async () => {
    let t = 0
    const urls: string[] = []
    const q = createHubListeningQuote({ baseUrl: 'http://homemini:3000/audio', now: () => t, fetchImpl: (u) => { urls.push(u); return reply({ totalLoggedPlays: 50, observation: 'This week belongs to Geese.' }) } })
    assert.deepEqual(await q.get(), { answered: true, text: 'This week belongs to Geese.' })
    t += 60_000
    assert.deepEqual(await q.get(), { answered: true, text: 'This week belongs to Geese.' })
    assert.deepEqual(urls, ['http://homemini:3000/api/listening-memory'])
  })
  it('"nothing to say" from homemini is an answer — the desktop says nothing too', async () => {
    const q = createHubListeningQuote({ baseUrl: 'http://h', fetchImpl: () => reply({ totalLoggedPlays: 50, observation: null }) })
    assert.deepEqual(await q.get(), { answered: true, text: null })
  })
  it('away: no answer (the caller uses this Mac\'s log); a recent answer outlives a blip, not a day', async () => {
    let t = 0
    let up = true
    const q = createHubListeningQuote({
      baseUrl: 'http://h', now: () => t,
      fetchImpl: () => (up ? reply({ totalLoggedPlays: 50, observation: '3 days straight. The streak is alive.' }) : Promise.reject(new Error('ECONNREFUSED'))),
    })
    up = false
    assert.deepEqual(await q.get(), { answered: false, text: null })
    up = true
    await q.get()
    up = false
    t += 20 * 60_000
    assert.deepEqual(await q.get(), { answered: true, text: '3 days straight. The streak is alive.' })
    t += 25 * 60 * 60_000
    assert.deepEqual(await q.get(), { answered: false, text: null })
  })
  it('a proxy page or an error status never counts as an answer', async () => {
    const q1 = createHubListeningQuote({ baseUrl: 'http://h', fetchImpl: () => reply('<html>') })
    assert.deepEqual(await q1.get(), { answered: false, text: null })
    const q2 = createHubListeningQuote({ baseUrl: 'http://h', fetchImpl: () => reply({ totalLoggedPlays: 50, observation: 'x' }, false) })
    assert.deepEqual(await q2.get(), { answered: false, text: null })
  })
  it('the Home never waits on a slow homemini past waitMs', async () => {
    const q = createHubListeningQuote({ baseUrl: 'http://h', waitMs: 30, timeoutMs: 1000, fetchImpl: () => new Promise((res) => setTimeout(() => res({ ok: true, status: 200, json: async () => ({ totalLoggedPlays: 50, observation: 'late' }) }), 200)) })
    const t0 = Date.now()
    assert.deepEqual(await q.get(), { answered: false, text: null })
    assert.ok(Date.now() - t0 < 150)
    await new Promise((r) => setTimeout(r, 250))
    assert.deepEqual(await q.get(), { answered: true, text: 'late' }, 'the slow GET still lands for next time')
  })
})

describe('the desktop Home shows the quote, not the cards', () => {
  const home = src('views', 'HomeView.tsx')
  const css = src('styles', 'home.css')
  it('renders memory.quote with the Music Man credit', () => {
    assert.match(home, /\{memory\?\.quote && \(/)
    assert.match(home, /— the Music Man/)
  })
  it('none of the six cards Jake turned down', () => {
    for (const label of ['Current Streak', 'Golden Hour', 'Biggest Day', 'Binge Record', 'Comeback', 'home-stats--memory']) {
      assert.doesNotMatch(home, new RegExp(label))
    }
  })
  it('the line is never clamped', () => {
    const rules = css.match(/\.home-memory-obs \{[^}]*\}/g) ?? []
    assert.ok(rules.length > 0)
    for (const r of rules) assert.doesNotMatch(r, /line-clamp|ellipsis/)
  })
  it('main answers with the quote: homemini first, then this Mac', () => {
    const ipc = readFileSync(join(import.meta.dirname, '..', 'ipc', 'library-ipc.ts'), 'utf8')
    assert.match(ipc, /getListeningMemory\(\{ hubQuote: hubQuote\.get \}\)/)
    const lp = readFileSync(join(import.meta.dirname, '..', 'listener-profile.ts'), 'utf8')
    assert.match(lp, /hub\.answered\s*\? hub\.text\s*: listeningQuote\(listeningQuoteFacts\(/)
  })
})
