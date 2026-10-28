// Concerts feed rules (src/common/concerts-feed.ts) — Home › Shows and the
// Music Man. Items are shaped like homemini's live GET /api/concerts answer of
// 2026-10-19 (trimmed): parsing, date order + New York City only (2026-10-28), run folding on
// the card, the badge rules (7-day "Just announced", future on-sale only), the
// "You'd like this" reason, the offline fallback's shape, and the Music Man's
// 30-day narrowing.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  asConcertsState, cardBill, cardReason, concertBadges, formatOnSale, formatShowTime, legacyConcertItems,
  cityBorough, compareConcerts, inNyc, listConcerts, localYmd, musicManShows, nyDate, parseConcertItem, parseConcertsReply, pruneToUpcoming, runNightsLine,
  runStamp, ticketUrl, whereLine, DAY_MS, type ConcertItem,
} from '../../common/concerts-feed.ts'

/** Mon Oct 19 2026, noon in Brooklyn. */
const NOW = Date.UTC(2026, 9, 19, 16, 0, 0)
const TODAY = '2026-10-19'

const night = (id: string, date: string, extra: Record<string, unknown> = {}) => ({ id, date, time: '20:00:00', url: `https://tix.example/${id}`, soldOut: false, onSale: null, rsvp: null, runIndex: 1, ...extra })

const THUNDERCAT = {
  id: 'Z7r9jZ1A7J3bP', name: 'Thundercat: Distracted AF Tour', url: 'https://us.atgtickets.com/events/thundercat/kings-theatre-brooklyn',
  date: '2026-10-23', time: '20:00:00', venue: 'Kings Theatre', city: 'Brooklyn', state: 'NY', artists: ['Thundercat', 'TiaCorine'],
  rsvp: null, rank: 1, tier: 3, reason: 'Heavy rotation: 7 plays in 90 days', matchedArtist: 'Thundercat', matchRole: 'headliner', relatedTo: null,
  headliners: ['Thundercat'], support: ['TiaCorine'], onSale: '2026-07-17T14:00:00Z', presale: null, soldOut: false, priceFrom: null,
  justAnnounced: false, firstSeenAt: '2026-10-19T14:02:24.874Z', announcedAt: '2026-07-14T17:00:00Z', neighbourhood: 'Brooklyn', northBrooklyn: false,
  distanceMiles: 4.5, room: null, doors: '19:00', sources: ['bowery', 'ticketmaster', 'bandsintown'],
  links: [{ source: 'bowery', url: 'https://us.atgtickets.com/events/thundercat/kings-theatre-brooklyn' }, { source: 'ticketmaster', url: 'https://www.ticketmaster.com/event/Z7r9jZ1A7J3bP' }],
  altIds: ['bowery:1518397'], runKey: 'kingstheatre|thundercat|2026-10-23', runNights: 1, runDates: ['2026-10-23'], runIndex: 1,
  runShows: [night('Z7r9jZ1A7J3bP', '2026-10-23', { url: 'https://us.atgtickets.com/events/thundercat/kings-theatre-brooklyn', onSale: '2026-07-17T14:00:00Z' })],
}
const ANGINE = {
  ...THUNDERCAT, id: 'ang1', name: 'Angine de Poitrine', url: 'https://tix.example/ang1', date: '2026-11-16', venue: 'Brooklyn Steel', neighbourhood: 'Greenpoint', northBrooklyn: true,
  artists: ['Angine de Poitrine', 'zouz'], headliners: ['Angine de Poitrine'], support: ['zouz'], matchedArtist: 'Angine de Poitrine', rank: 4,
  reason: 'Heavy rotation: 14 plays in 90 days', soldOut: true, onSale: null,
  runNights: 3, runDates: ['2026-11-16', '2026-11-17', '2026-11-18'],
  runShows: [night('ang1', '2026-11-16', { soldOut: true }), night('ang2', '2026-11-17', { soldOut: true }), night('ang3', '2026-11-18', { soldOut: true })],
}
const LCD_STEEL = {
  ...THUNDERCAT, id: 'lcd5', name: 'LCD Soundsystem', url: 'https://tix.example/lcd5', date: '2026-11-30', venue: 'Brooklyn Steel', neighbourhood: 'Greenpoint',
  artists: ['LCD Soundsystem'], headliners: ['LCD Soundsystem'], support: [], matchedArtist: 'LCD Soundsystem', rank: 7, reason: 'Heavy rotation: 6 plays in 90 days',
  onSale: null, runNights: 4, runDates: ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'],
  runShows: [night('lcd5', '2026-11-30'), night('lcd6', '2026-12-01', { soldOut: true }), night('lcd7', '2026-12-02'), night('lcd8', '2026-12-03')],
}
const PROSPA_SUPPORT = {
  ...THUNDERCAT, id: 'bed1', name: 'Bedouin', url: 'https://tix.example/bed1', date: '2026-11-01', venue: 'Brooklyn Storehouse', neighbourhood: 'Brooklyn',
  artists: ['Bedouin', 'Chloé Caillet', 'Prospa'], headliners: ['Bedouin'], support: ['Chloé Caillet', 'Prospa'], matchedArtist: 'Prospa', matchRole: 'support', rank: 17,
  reason: 'Heavy rotation: 18 plays in 90 days (opening for Bedouin)', onSale: null, runNights: 1, runDates: ['2026-11-01'], runShows: [night('bed1', '2026-11-01')],
}
const MAN_WOMAN = {
  ...THUNDERCAT, id: 'dice:mwc', name: 'Man/Woman/Chainsaw', url: 'https://dice.fm/event/mwc', date: '2026-10-30', venue: 'Union Pool', neighbourhood: 'Williamsburg', northBrooklyn: true,
  artists: ['Man/Woman/Chainsaw'], headliners: ['Man/Woman/Chainsaw'], support: [], matchedArtist: 'Man/Woman/Chainsaw', rank: 19, tier: 5,
  reason: 'On your Rocksurgence playlist', soldOut: true, justAnnounced: true, firstSeenAt: '2026-10-17T10:00:00.000Z', onSale: '2026-10-23T14:00:00Z',
  runNights: 1, runDates: ['2026-10-30'], runShows: [night('dice:mwc', '2026-10-30', { url: 'https://dice.fm/event/mwc', soldOut: true, onSale: '2026-10-23T14:00:00Z' })],
}
const FRIKO = {
  ...THUNDERCAT, id: 'fr1', name: 'Friko', url: 'https://tix.example/fr1', date: '2026-10-23', venue: 'Music Hall of Williamsburg', neighbourhood: 'Williamsburg',
  artists: ['Friko', 'Nine Perfect Lives'], headliners: ['Friko'], support: ['Nine Perfect Lives'], matchedArtist: 'Friko', rank: 1, tier: 7,
  relatedTo: ['Cameron Winter', 'Victoryland', 'The Lemon Twigs'], reason: "You'd like this: like Cameron Winter and Victoryland",
  runNights: 1, runDates: ['2026-10-23'], runShows: [night('fr1', '2026-10-23')],
}
const FURY_SUPPORT = {
  ...FRIKO, id: 'fury1', name: 'Fury', date: '2026-10-25', venue: 'Elsewhere', neighbourhood: 'Bushwick', artists: ['Fury', 'Combust'], headliners: ['Fury'], support: ['Combust'],
  matchedArtist: 'Combust', matchRole: 'support', relatedTo: ['CEREMONY'], reason: "You'd like this: like CEREMONY (opening for Fury)", rank: 28,
  runDates: ['2026-10-25'], runShows: [night('fury1', '2026-10-25')],
}

const parse = (raw: unknown) => { const it = parseConcertItem(raw); assert.ok(it, 'parses'); return it }

describe('parsing homemini\'s answer', () => {
  it('reads every field the Shows card uses', () => {
    const t = parse(THUNDERCAT)
    assert.equal(t.venue, 'Kings Theatre')
    assert.equal(t.reason, 'Heavy rotation: 7 plays in 90 days')
    assert.deepEqual(t.headliners, ['Thundercat'])
    assert.deepEqual(t.support, ['TiaCorine'])
    assert.equal(t.neighbourhood, 'Brooklyn')
    assert.equal(t.runNights, 1)
    assert.equal(ticketUrl(t), 'https://us.atgtickets.com/events/thundercat/kings-theatre-brooklyn')
  })

  it('parses in wire order; the rows draw it by date (2026-10-28: "never in date order")', () => {
    // ranks 1, 4, 7, 17, 19 have dates 10-23, 11-16, 11-30, 11-01, 10-30 — an older homemini's taste order.
    const reply = parseConcertsReply({ items: [THUNDERCAT, ANGINE, LCD_STEEL, PROSPA_SUPPORT, MAN_WOMAN], total: 5, discoverTotal: 2, generatedAt: '2026-10-19T14:06:37.315Z', home: { label: 'Williamsburg' } })
    assert.ok(reply)
    assert.deepEqual(reply.items.map((i) => i.rank), [1, 4, 7, 17, 19])
    assert.deepEqual(reply.items.map((i) => i.date), ['2026-10-23', '2026-11-16', '2026-11-30', '2026-11-01', '2026-10-30'])
    assert.equal(reply.home, 'Williamsburg')
    assert.deepEqual(pruneToUpcoming(reply.items, TODAY).map((i) => i.rank), [1, 4, 7, 17, 19], 'pruning alone keeps the order')
    // What the rows and the Music Man draw: soonest first.
    assert.deepEqual(listConcerts(reply.items, TODAY).map((i) => i.date), ['2026-10-23', '2026-10-30', '2026-11-01', '2026-11-16', '2026-11-30'])
    assert.deepEqual(musicManShows(reply.items, NOW, { days: 365 }).map((s) => s.artist), ['Thundercat', 'Man/Woman/Chainsaw', 'Prospa', 'Angine de Poitrine', 'LCD Soundsystem'])
  })

  it('drops an item it cannot draw, not the document', () => {
    const reply = parseConcertsReply({ items: [THUNDERCAT, { id: 'x', date: 'soon', venue: 'V', artists: ['A'] }, { name: 'no id' }, ANGINE] })
    assert.deepEqual(reply?.items.map((i) => i.id), ['Z7r9jZ1A7J3bP', 'ang1'])
  })

  it('is not fooled by the 503 warming-up body, HTML, or nothing', () => {
    assert.equal(parseConcertsReply({ error: 'Concerts are warming up …' }), null)
    assert.equal(parseConcertsReply('<html>proxy</html>'), null)
    assert.equal(parseConcertsReply(null), null)
  })

  it('an older Ticketmaster-only item (no run fields) is a one-night run', () => {
    const it = parse({ id: 'TM1', name: 'Geese', url: 'https://www.ticketmaster.com/event/TM1', date: '2026-12-10', time: '20:00:00', venue: 'Brooklyn Paramount', city: 'Brooklyn', state: 'NY', artists: ['Geese'], rsvp: null })
    assert.equal(it.runNights, 1)
    assert.deepEqual(it.runDates, ['2026-12-10'])
    assert.equal(it.runShows[0].id, 'TM1')
    assert.equal(cardBill(it).artist, 'Geese')
    assert.equal(whereLine(it), 'Brooklyn, NY')
  })

  it('only http(s) links survive', () => {
    const it = parse({ ...THUNDERCAT, url: 'javascript:alert(1)', links: [{ source: 'x', url: 'file:///etc/passwd' }, { source: 'tm', url: 'https://www.ticketmaster.com/event/Z' }] })
    assert.equal(it.url, null)
    assert.equal(ticketUrl(it), 'https://www.ticketmaster.com/event/Z')
  })

  it('a state that crossed IPC is checked before the Home draws it', () => {
    assert.equal(asConcertsState({ source: 'homemini' }), null)
    assert.equal(asConcertsState({ items: [], discover: [], source: 'bogus' })?.source, 'none')
  })
})

describe('run folding on the card', () => {
  it('a one-off is one date', () => {
    assert.deepEqual(runStamp(parse(THUNDERCAT), TODAY), { month: 'OCT', day: '23', nights: 1, year: null })
    assert.equal(runNightsLine(parse(THUNDERCAT)), null)
  })
  it('a run inside a month reads NOV / 16–18 / 3 nights', () => {
    assert.deepEqual(runStamp(parse(ANGINE), TODAY), { month: 'NOV', day: '16–18', nights: 3, year: null })
    assert.equal(runNightsLine(parse(ANGINE)), '3 nights: Nov 16, 17, 18')
  })
  it('a run across a month says both months', () => {
    assert.deepEqual(runStamp(parse(LCD_STEEL), TODAY), { month: 'NOV–DEC', day: '30–3', nights: 4, year: null })
    assert.equal(runNightsLine(parse(LCD_STEEL)), '4 nights: Nov 30, Dec 1, 2, 3')
  })
  it('next year shows its year', () => {
    assert.equal(runStamp(parse({ ...THUNDERCAT, date: '2027-02-11', runDates: ['2027-02-11'], runShows: [night('o', '2027-02-11')] }), TODAY).year, 2027)
  })
  it('a cached run whose first nights passed re-points at the next night', () => {
    const [lcd] = pruneToUpcoming([parse(LCD_STEEL)], '2026-12-02')
    assert.equal(lcd.id, 'lcd7')
    assert.equal(lcd.date, '2026-12-02')
    assert.equal(lcd.url, 'https://tix.example/lcd7')
    assert.equal(lcd.runNights, 2)
    assert.deepEqual(runStamp(lcd, '2026-12-02'), { month: 'DEC', day: '2–3', nights: 2, year: null })
  })
  it('a run whose every night passed is gone; tonight still counts', () => {
    assert.deepEqual(pruneToUpcoming([parse(THUNDERCAT), parse(ANGINE)], '2026-11-01').map((i) => i.id), ['ang1'])
    assert.deepEqual(pruneToUpcoming([parse(THUNDERCAT)], '2026-10-23').map((i) => i.id), ['Z7r9jZ1A7J3bP'])
  })
})

describe('badges', () => {
  const mwc = parse(MAN_WOMAN)
  it('"Just announced" for the 7 days after the collector first saw it', () => {
    const seen = Date.parse(MAN_WOMAN.firstSeenAt)
    assert.equal(concertBadges(mwc, seen + 6 * DAY_MS).justAnnounced, true)
    assert.equal(concertBadges(mwc, seen + 7 * DAY_MS).justAnnounced, false, 'a cached copy loses the badge on day 8')
    assert.equal(concertBadges(mwc, seen - 60_000).justAnnounced, false, 'never before it was seen')
  })
  it('only when the backend said so (its taste gate), and only with a timestamp', () => {
    assert.equal(concertBadges(parse(THUNDERCAT), NOW).justAnnounced, false)
    assert.equal(concertBadges(parse({ ...MAN_WOMAN, firstSeenAt: null }), NOW).justAnnounced, false)
  })
  it('the on-sale time only while it is ahead', () => {
    assert.equal(concertBadges(mwc, NOW).onSaleAt, '2026-10-23T14:00:00Z')
    assert.equal(concertBadges(mwc, Date.parse('2026-10-23T14:00:00Z')).onSaleAt, null, 'at the moment it goes on sale, it is on sale')
    assert.equal(concertBadges(parse(THUNDERCAT), NOW).onSaleAt, null, 'July on-sale is history')
    assert.equal(formatOnSale('2026-10-23T14:00:00Z'), 'On sale Fri, Oct 23, 10 AM')
    assert.equal(formatOnSale('2026-10-23T14:30:00Z'), 'On sale Fri, Oct 23, 10:30 AM')
  })
  it('sold out: a whole run, part of a run, or a one-off', () => {
    assert.equal(concertBadges(parse(ANGINE), NOW).soldOut, 'all')
    assert.equal(concertBadges(parse(LCD_STEEL), NOW).soldOut, 'some')
    assert.equal(concertBadges(mwc, NOW).soldOut, 'all')
    assert.equal(concertBadges(parse(THUNDERCAT), NOW).soldOut, null)
  })
})

describe('who and why', () => {
  it('a support-slot match is about the opener Jake plays', () => {
    const p = parse(PROSPA_SUPPORT)
    assert.deepEqual(cardBill(p), { artist: 'Prospa', openingFor: 'Bedouin' })
    assert.equal(cardReason(p, 'ranked'), 'Heavy rotation: 18 plays in 90 days', 'the card already says who it opens for')
  })
  it('"You\'d like this" reads "Because you play …"', () => {
    assert.equal(cardReason(parse(FRIKO), 'discover'), 'Because you play Cameron Winter and Victoryland')
    assert.equal(cardReason(parse({ ...FRIKO, relatedTo: ['Geese'] }), 'discover'), 'Because you play Geese')
    assert.equal(cardReason(parse({ ...FRIKO, relatedTo: null, reason: "You'd like this: like Geese and Fat Dog" }), 'discover'), 'Because you play Geese and Fat Dog')
    const f = parse(FURY_SUPPORT)
    assert.equal(cardReason(f, 'discover'), 'Because you play CEREMONY')
    assert.deepEqual(cardBill(f), { artist: 'Combust', openingFor: 'Fury' })
  })
  it('times read like a ticket', () => {
    assert.equal(formatShowTime('20:00:00'), '8 PM')
    assert.equal(formatShowTime('19:30'), '7:30 PM')
    assert.equal(formatShowTime('00:15:00'), '12:15 AM')
    assert.equal(formatShowTime(null), null)
  })
})

describe('dates are New York\'s', () => {
  it('a bare date is never shifted by a zone', () => {
    assert.equal(localYmd('2026-10-23'), '2026-10-23')
    assert.equal(localYmd('2026-10-23T20:00:00'), '2026-10-23')
    assert.equal(localYmd('2026-10-24T00:30:00.000Z'), '2026-10-23', '8:30 PM in Brooklyn')
    assert.equal(nyDate(Date.UTC(2026, 9, 20, 3, 0)), '2026-10-19', '11 PM Monday in Brooklyn is still Monday')
  })
})

describe('the offline fallback (Bandsintown + venue calendars) as feed items', () => {
  const tour = [
    // external.ts order: the city first, clubs before arenas, then date.
    { artist: 'Geese', date: '2026-12-11T01:00:00.000Z', venue: 'Brooklyn Paramount', city: 'Brooklyn, NY', url: 'https://bit/1' },
    { artist: 'Geese', date: '2026-12-12T01:00:00.000Z', venue: 'Brooklyn Paramount', city: 'Brooklyn, NY', url: 'https://bit/2' },
    { artist: 'Olivia Rodrigo', date: '2026-10-25T00:00:00.000Z', venue: 'Barclays Center', city: 'Brooklyn, NY', url: 'https://bit/3' },
    { artist: 'Old Show', date: '2026-10-01T00:00:00.000Z', venue: 'Somewhere', city: 'Brooklyn, NY', url: 'https://bit/4' },
  ]
  const venues = [
    { artist: 'Chat Pile', date: '2026-11-10', venue: 'Brooklyn Steel', venueKey: 'brooklyn-steel', city: 'Brooklyn, NY', url: 'https://v/1', known: false },
    { artist: 'Geese', date: '2026-12-10', venue: 'Brooklyn Paramount', venueKey: 'brooklyn-paramount', city: 'Brooklyn, NY', url: 'https://v/2', known: true },
    { artist: 'Ceremony', date: '2026-11-02', venue: 'Warsaw', venueKey: 'warsaw', city: 'Brooklyn, NY', url: 'https://v/3', known: true },
  ]
  const items = legacyConcertItems(tour, venues, NOW)
  it('library shows first in Bandsintown\'s order, then library shows at the rooms, then the rest of the rooms', () => {
    assert.deepEqual(items.map((i) => cardBill(i).artist), ['Geese', 'Olivia Rodrigo', 'Ceremony', 'Chat Pile'])
    assert.deepEqual(items.map((i) => i.reason), ['In your library', 'In your library', 'In your library', 'At one of your rooms'])
    assert.deepEqual(items.map((i) => i.rank), [1, 2, 3, 4])
  })
  it('nights of one act at one room fold into a run, whichever source listed them; past shows are dropped', () => {
    const geese = items[0]
    assert.deepEqual(geese.runDates, ['2026-12-10', '2026-12-11'], 'the venue calendar\'s night and Bandsintown\'s 12-10 8 PM (01:00Z) are the same night')
    assert.equal(geese.runNights, 2)
    assert.equal(geese.date, '2026-12-10')
    assert.ok(!items.some((i) => i.name === 'Old Show'))
  })
  it('nights more than 7 days apart are separate runs, as the backend splits them', () => {
    const lcd = (date: string) => ({ artist: 'LCD Soundsystem', date, venue: 'Knockdown Center', city: 'Maspeth, NY', url: `https://bit/${date}` })
    const got = legacyConcertItems(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13'].map(lcd), [], NOW)
    assert.deepEqual(got.map((i) => [i.date, i.runNights]), [['2026-11-19', 4], ['2026-12-10', 4]], 'not one 8-night "Nov 19 – Dec 13"')
    assert.deepEqual(got.map((i) => runStamp(i, TODAY).day), ['19–22', '10–13'])
    const weekly = legacyConcertItems(['2026-11-03', '2026-11-10', '2026-11-17'].map(lcd), [], NOW)
    assert.equal(weekly.length, 1, 'a weekly residency stays one run')
  })
})

describe('the Music Man hears the top of the feed', () => {
  it('the best-ranked shows in the next 30 days, told soonest first, with why', () => {
    const items = [THUNDERCAT, ANGINE, LCD_STEEL, PROSPA_SUPPORT, MAN_WOMAN].map(parse)
    const shows = musicManShows(items, NOW)
    assert.deepEqual(shows.map((s) => s.artist), ['Thundercat', 'Man/Woman/Chainsaw', 'Prospa', 'Angine de Poitrine'], 'LCD on Nov 30 is past the 30-day horizon (Nov 18); date order')
    assert.deepEqual(shows[0], { artist: 'Thundercat', venue: 'Kings Theatre', city: 'Brooklyn', date: '2026-10-23', url: 'https://us.atgtickets.com/events/thundercat/kings-theatre-brooklyn', reason: 'Heavy rotation: 7 plays in 90 days', nights: 1 })
    assert.deepEqual(musicManShows(items, NOW, { days: 14 }).map((s) => s.date), ['2026-10-23', '2026-10-30', '2026-11-01'], '14 days ends Nov 2')
    // Taste picks WHICH (ranks 1 and 4, not the two soonest), the date orders them.
    assert.deepEqual(musicManShows(items, NOW, { days: 60, limit: 2 }).map((s) => s.artist), ['Thundercat', 'Angine de Poitrine'])
    assert.ok(!musicManShows([...items, parse({ ...THUNDERCAT, id: 'nj', rank: 0, city: 'Newark', state: 'NJ', borough: null })], NOW).some((s) => s.city === 'Newark, NJ'), 'New York City only')
  })
  it('an empty feed is an empty list, not an error', () => {
    assert.deepEqual(musicManShows([] as ConcertItem[], NOW), [])
  })
})

describe('date order and New York City only (2026-10-28)', () => {
  const at = (id: string, date: string, extra: Record<string, unknown> = {}) =>
    parse({ ...THUNDERCAT, id, name: id, headliners: [id], artists: [id], date, runDates: [date], runNights: 1, runShows: [night(id, date)], ...extra })
  it('soonest first; within a date North Brooklyn, then nearer, unknown distance last, then start time, then taste', () => {
    const d = '2026-10-31'
    const out = listConcerts([
      at('later', '2026-11-02', { northBrooklyn: true, distanceMiles: 0.3, rank: 1 }),
      at('lic', d, { northBrooklyn: false, distanceMiles: 2.1, rank: 2 }),
      at('tba', d, { northBrooklyn: false, distanceMiles: null, rank: 3, borough: 'Manhattan' }),
      at('bushwick', d, { northBrooklyn: true, distanceMiles: 2.4, rank: 9 }),
      at('greenpoint', d, { northBrooklyn: true, distanceMiles: 0.8, rank: 8 }),
      at('les-late', d, { northBrooklyn: false, distanceMiles: 1.9, time: '22:00:00', rank: 4 }),
      at('les-early', d, { northBrooklyn: false, distanceMiles: 1.9, time: '19:00:00', rank: 5 }),
    ], TODAY)
    assert.deepEqual(out.map((i) => i.id), ['greenpoint', 'bushwick', 'les-early', 'les-late', 'lic', 'tba', 'later'])
    assert.ok(compareConcerts(out[0], out[out.length - 1]) < 0)
  })
  it('a multi-night run sits at its next upcoming night', () => {
    const run = parse(ANGINE)                       // Brooklyn Steel, Nov 16–18
    const before = at('before', '2026-11-16')
    const after = at('after', '2026-11-18', { northBrooklyn: false })
    // Nov 17: the run's first night has passed; it stands at Nov 17, between the two.
    const out = listConcerts([after, run, before], '2026-11-17')
    assert.deepEqual(out.map((i) => [i.id, i.date, i.runNights]), [['ang2', '2026-11-17', 2], ['after', '2026-11-18', 1]])
    assert.deepEqual(listConcerts([after, run, before], '2026-11-15').map((i) => i.id), ['ang1', 'before', 'after'], 'before its first night it sits at Nov 16')
  })
  it('past shows never appear', () => {
    assert.deepEqual(listConcerts([at('gone', '2026-10-18'), at('tonight', TODAY)], TODAY).map((i) => i.id), ['tonight'])
  })
  it('the five boroughs only — homemini\'s borough, else the city (an older answer, the fallback)', () => {
    const keep = [at('msg', '2026-11-01', { city: 'New York', state: 'NY' }), at('lic', '2026-11-01', { city: 'Long Island City', state: 'NY' }), at('lehman', '2026-11-01', { city: 'Bronx', state: 'NY' })]
    const drop = [
      at('pony', '2026-11-01', { city: 'Asbury Park', state: 'NJ' }), at('loews', '2026-11-01', { city: 'Jersey City', state: 'NJ' }),
      at('ubs', '2026-11-01', { city: 'Belmont Park', state: 'NY' }), at('westbury', '2026-11-01', { city: 'Westbury', state: 'NY' }),
    ]
    assert.deepEqual(listConcerts([...drop, ...keep], TODAY).map((i) => i.id).sort(), ['lehman', 'lic', 'msg'])
    // A null-distance TBA room homemini placed by its city keeps its place.
    const tba = at('tba', '2026-11-01', { city: 'New York', state: 'NY', distanceMiles: null, borough: 'Manhattan', venue: 'TBA - Secret Manhattan Location' })
    assert.equal(inNyc(tba), true)
    assert.equal(tba.distanceMiles, null)
  })
  it('city names, including Bandsintown\'s "City, ST"', () => {
    assert.equal(cityBorough('Brooklyn, NY', null), 'Brooklyn')
    assert.equal(cityBorough('Brooklyn, OH', null), null)
    assert.equal(cityBorough('Maspeth', 'NY'), 'Queens')
    assert.equal(cityBorough('Long Island', 'NY'), null)
    assert.equal(cityBorough('New York', 'NJ'), null)
  })
})
