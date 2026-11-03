// 2026-11-03 — Jake: "add all LCD soundsystem shows in queens and in brooklyn, same with angine
// in brooklyn. Honestly for anything saying '3 or 4 nights' I should be able to see each night
// as an option. And I want a button to indicate that I am interested in going. And a filter to
// see what I am interested in going, actually going to, keep track of it." Also: "I'd make the
// concert artist photos more 4:3 ratio". common/concerts-feed.ts + concerts-going.ts + HomeShows.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  markedNights, nightCard, nightsByRoom, nightsOf, nightWhen, parseConcertItem, pruneToUpcoming, snapshotCard, type ConcertItem,
} from '../../common/concerts-feed.ts'
import { nightsMarked, parseRsvps, parseRsvpStatus, statusAfterTap, stubLabel, type RsvpStatus } from '../../common/concerts-going.ts'

const night = (id: string, date: string, extra: Record<string, unknown> = {}) => ({ id, date, time: '20:00:00', url: `https://tix.example/${id}`, soldOut: false, onSale: null, rsvp: null, runIndex: 1, ...extra })
const actNight = (id: string, date: string, venue: string, borough: string, extra: Record<string, unknown> = {}) =>
  ({ ...night(id, date), venue, neighbourhood: null, borough, runKey: `${venue}|lcd`, openingFor: null, ...extra })

const LCD_NIGHTS = [
  ...['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d, i) => actNight(`kq${i}`, d, 'Knockdown Center', 'Queens')),
  ...['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'].map((d, i) => actNight(`bs${i}`, d, 'Brooklyn Steel', 'Brooklyn', i === 1 ? { soldOut: true } : {})),
  ...['2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13'].map((d, i) => actNight(`kd${i}`, d, 'Knockdown Center', 'Queens')),
]
const base = {
  name: 'LCD Soundsystem', url: 'https://tix.example/run', time: '20:00:00', city: 'Brooklyn', state: 'NY', artists: ['LCD Soundsystem'], rsvp: null,
  rank: 7, tier: 3, reason: 'Heavy rotation: 28 plays in 90 days', matchedArtist: 'LCD Soundsystem', matchRole: 'headliner', relatedTo: null,
  headliners: ['LCD Soundsystem'], support: [], onSale: null, soldOut: false, justAnnounced: false, firstSeenAt: null, northBrooklyn: false,
  distanceMiles: 3, room: null, links: [{ source: 'bowery', url: 'https://tix.example/run' }],
}
/** The Brooklyn Steel run, as homemini sends it with the act's 12 nights. */
const LCD_STEEL = parseConcertItem({
  ...base, id: 'bs0', date: '2026-11-30', venue: 'Brooklyn Steel', neighbourhood: 'East Williamsburg', borough: 'Brooklyn',
  runNights: 4, runDates: LCD_NIGHTS.slice(4, 8).map((n) => n.date), runShows: LCD_NIGHTS.slice(4, 8).map(({ venue: _v, neighbourhood: _n, borough: _b, runKey: _r, openingFor: _o, ...n }) => n),
  actNights: LCD_NIGHTS,
})!
const GEESE = parseConcertItem({
  ...base, id: 'gz1', name: 'Geese', artists: ['Geese'], headliners: ['Geese'], matchedArtist: 'Geese', date: '2026-12-05', venue: 'Webster Hall',
  neighbourhood: 'East Village', borough: 'Manhattan', rsvp: 'interested', runNights: 1, runDates: ['2026-12-05'], runShows: [night('gz1', '2026-12-05')], actNights: [],
})!

describe('interested, on the wire', () => {
  it('reads interested beside going; anything else this desktop does not know is null, never an error', () => {
    assert.equal(parseRsvpStatus('interested'), 'interested')
    assert.equal(parseRsvpStatus('going'), 'going')
    assert.equal(parseRsvpStatus('maybe-later'), null)
    const entries = parseRsvps({ items: [
      { eventId: 'a', status: 'interested', at: '2026-11-03T10:00:00Z' },
      { eventId: 'b', status: 'going', at: '2026-11-03T10:00:00Z' },
      { eventId: 'c', status: 'someday', at: '2026-11-03T10:00:00Z' },
    ] })
    assert.deepEqual(entries.map((e) => [e.eventId, e.status]), [['a', 'interested'], ['b', 'going']])
    assert.equal(GEESE.rsvp, 'interested')
    assert.equal(parseConcertItem({ ...base, id: 'x', date: '2026-12-01', venue: 'X', rsvp: 'someday' })!.rsvp, null)
  })

  it('a click marks the one clicked or clears it; a night is never going and interested at once', () => {
    assert.equal(statusAfterTap(null, 'interested'), 'interested')
    assert.equal(statusAfterTap('interested', 'interested'), null)
    assert.equal(statusAfterTap('interested', 'going'), 'going')
    assert.equal(statusAfterTap('going', 'interested'), 'interested')
    assert.equal(statusAfterTap('going', 'going'), null)
    assert.deepEqual(nightsMarked([null, 'interested', null]), { interested: true, going: false })
    assert.deepEqual(nightsMarked(['going', 'interested']), { interested: true, going: true })
  })
})

describe('each night as its own option', () => {
  it("LCD Soundsystem's card offers all 12 nights, Queens and Brooklyn, in rooms in date order", () => {
    const nights = nightsOf(LCD_STEEL)
    assert.equal(nights.length, 12)
    const rooms = nightsByRoom(nights)
    assert.deepEqual(rooms.map((r) => [r.venue, r.where, r.nights.length]), [
      ['Knockdown Center', 'Queens', 4], ['Brooklyn Steel', 'Brooklyn', 4], ['Knockdown Center', 'Queens', 4],
    ])
    assert.equal(nightWhen('2026-11-19', '20:00:00'), 'Thu, Nov 19 · 8 PM')
    assert.equal(nightWhen('2026-12-01', null), 'Tue, Dec 1')
  })

  it('an older homemini (no act list) still offers the run\'s own nights; a one-off offers one', () => {
    const run = { ...LCD_STEEL, actNights: [] }
    assert.deepEqual(nightsOf(run).map((n) => [n.id, n.venue]), [['bs0', 'Brooklyn Steel'], ['bs1', 'Brooklyn Steel'], ['bs2', 'Brooklyn Steel'], ['bs3', 'Brooklyn Steel']])
    assert.equal(nightsOf(GEESE).length, 1)
    assert.equal(nightsOf(GEESE)[0]!.rsvp, 'interested', "a one-off's night carries the item's answer")
  })

  it("a night's own card: its id, date, link and room, even when the night is in another room", () => {
    const queens = nightsOf(LCD_STEEL)[0]!
    const card = nightCard(LCD_STEEL, queens)
    assert.equal(card.id, 'kq0')
    assert.equal(card.date, '2026-11-19')
    assert.equal(card.venue, 'Knockdown Center')
    assert.equal(card.borough, 'Queens')
    assert.equal(card.url, 'https://tix.example/kq0')
    assert.equal(card.runNights, 1)
    assert.deepEqual(card.actNights, [])
  })

  it('a cached copy drops the nights that passed from the act list too', () => {
    const pruned = pruneToUpcoming([LCD_STEEL], '2026-12-02')
    assert.deepEqual(pruned[0]!.actNights.map((n) => n.id), ['bs2', 'bs3', 'kd0', 'kd1', 'kd2', 'kd3'])
    assert.deepEqual(pruneToUpcoming([LCD_STEEL], '2026-12-13')[0]?.actNights ?? [], [])
  })
})

describe('the Interested / Going filter', () => {
  const answers: Record<string, RsvpStatus> = { kq1: 'interested', bs2: 'going', kd3: 'interested', gz1: 'interested', past1: 'going', past2: 'interested' }
  const statusOf = (n: { id: string; rsvp?: RsvpStatus | null }) => answers[n.id] ?? n.rsvp ?? null
  const entries = [
    { eventId: 'past1', attended: 'yes' as const, show: { artist: 'Fat Dog', headliners: ['Fat Dog'], support: [], venue: 'Elsewhere', neighbourhood: 'Bushwick', borough: 'Brooklyn', date: '2026-10-20', time: '20:00:00', url: null } },
    { eventId: 'past2', show: { artist: 'Wet Leg', headliners: ['Wet Leg'], support: [], venue: 'Terminal 5', neighbourhood: 'Hell’s Kitchen', borough: 'Manhattan', date: '2026-10-30', time: null, url: 'https://tix.example/past2' } },
    { eventId: 'kq1', show: { artist: 'LCD Soundsystem', venue: 'Knockdown Center', date: '2026-11-20' } },
  ]

  it('lists the marked nights one card each, soonest first, then the ones that passed, newest first', () => {
    const m = markedNights('interested', [[LCD_STEEL, GEESE], []], entries, statusOf, '2026-11-03')
    assert.deepEqual(m.upcoming.map((c) => [c.id, c.date]), [['kq1', '2026-11-20'], ['gz1', '2026-12-05'], ['kd3', '2026-12-13']])
    assert.deepEqual(m.past.map((c) => c.id), ['past2'])
    const g = markedNights('going', [[LCD_STEEL, GEESE], []], entries, statusOf, '2026-11-03')
    assert.deepEqual(g.upcoming.map((c) => c.id), ['bs2'])
    assert.deepEqual(g.past.map((c) => [c.id, c.name, c.venue, c.reason]), [['past1', 'Fat Dog', 'Elsewhere', 'You went']])
  })

  it('a night that has passed has no date stub ("TONIGHT" was for every night up to today)', () => {
    assert.equal(stubLabel('2026-10-20', '2026-11-03'), null)
    assert.equal(stubLabel('2026-11-03', '2026-11-03'), 'TONIGHT')
  })

  it("a night homemini's lists no longer have is drawn from its snapshot, with no reason line", () => {
    const c: ConcertItem = snapshotCard('past2', entries[1]!.show as never, 'interested')
    assert.equal(c.reason, '')
    assert.equal(c.url, 'https://tix.example/past2')
    assert.equal(c.rsvp, 'interested')
    assert.equal(c.runNights, 1)
  })

  it('the click not yet confirmed counts: un-marking a night takes it out at once', () => {
    const mine: Record<string, RsvpStatus | null> = { kq1: null }
    const live = (n: { id: string; rsvp?: RsvpStatus | null }) => (n.id in mine ? mine[n.id] ?? null : statusOf(n))
    const m = markedNights('interested', [[LCD_STEEL, GEESE], []], entries, live, '2026-11-03')
    assert.deepEqual(m.upcoming.map((c) => c.id), ['gz1', 'kd3'])
  })
})

describe('the Home draws it', () => {
  const shows = readFileSync(new URL('../../renderer/components/HomeShows.tsx', import.meta.url), 'utf-8')
  const css = readFileSync(new URL('../../renderer/styles/home.css', import.meta.url), 'utf-8')

  it('an Interested pill beside Going; several nights open "Pick a night"; the filter is saved merged onto a fresh ui-state', () => {
    assert.match(shows, /className=\{`home-concert-interested/)
    assert.match(shows, /several \? going\.openNights\(item\) : going\.mark\(item, own, 'interested'\)/)
    assert.match(shows, /className="home-concert-pick" title=\{`\$\{nights\.length\} nights in New York`\}/)
    assert.match(shows, /<NightsSheet item=\{nightsFor\}/)
    assert.match(shows, /createPortal\(/)
    assert.match(shows, /saveUiState\(\{ \.\.\.\(r\.ok && r\.state \? r\.state : \{\}\), \[FILTER_KEY\]: f \}\)/)
    assert.ok(!/localStorage/.test(shows), 'localStorage is banned in this renderer')
  })

  it('the photo drifts with the rail: no box between it and the rail is a scroll container', () => {
    // overflow:hidden makes a box a scroll container, and view(inline) follows the nearest one:
    // the card's and the photo band's hidden overflow held the drift at 0 since 2026-10-29.
    const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{[^}]*\\}`))?.[0] ?? ''
    for (const sel of ['.home-tour-card', '.home-concert-photo']) {
      assert.match(rule(sel), /overflow: clip;/, `${sel} clips without becoming a scroller`)
      assert.doesNotMatch(rule(sel), /overflow: hidden;/)
    }
    assert.match(css, /animation-timeline: view\(inline\);/)
  })

  it('the photos are 4:3 (272 × 204 on the rail, still 4:3 in See All)', () => {
    assert.match(css, /\.home-concert-photo \{\n  position: relative;\n  flex: 0 0 100%;\n  aspect-ratio: 4 \/ 3;/)
  })
})
