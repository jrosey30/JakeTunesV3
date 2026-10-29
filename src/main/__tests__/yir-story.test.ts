/**
 * Year in Review story slides (src/common/yir-story.ts): every sentence is a
 * fact the review carries; "so far" until December 17, the reveal after.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStory, hour12, isRevealed } from '../../common/yir-story.ts'
import { buildYearInReview } from '../../common/year-in-review.ts'
import { L, listens, y, concerts } from './yir-story-fixture.ts'

const before = buildStory(y, { now: new Date(2026, 9, 12), concerts })
const after = buildStory(y, { now: new Date(2026, 11, 17, 0, 0, 1), concerts })
const big = (slides: typeof before, eyebrow: string): string | undefined => {
  const s = slides.find((x) => 'eyebrow' in x && x.eyebrow === eyebrow)
  return s && 'big' in s ? s.big : undefined
}

describe('the story', () => {
  it('is "so far" until December 17, then the reveal', () => {
    assert.equal(isRevealed(2026, new Date(2026, 11, 16, 23, 59)), false)
    assert.equal(isRevealed(2026, new Date(2026, 11, 17)), true)
    assert.equal(before[0].kind === 'cover' && before[0].line, 'So far, since June 1. None of it rented.')
    assert.equal(after[0].kind === 'cover' && after[0].line, 'Your year, since June 1. None of it rented.')
    assert.match(String(big(before, 'December 17')), /still being written/)
    assert.equal(big(after, 'Happy birthday'), 'That was 2026.')
  })

  it('the song of the year line comes from its own best week', () => {
    const s = before.find((x) => x.kind === 'art' && x.eyebrow === 'Your song of the year')
    assert.ok(s && s.kind === 'art')
    assert.equal(s.line, 'TV Girl · 7 plays. Four in one July week.')
    assert.deepEqual(s.play, { kind: 'song', artist: 'TV Girl', title: 'Pantyhose' })
  })

  it('busiest hour and busiest weekday are stated as two facts, not one peak', () => {
    assert.equal(big(before, 'When you listen'), 'Noon. Mondays.')
  })

  it('live: every show he went to this year, his poster when he recorded it, a few setlist songs', () => {
    assert.deepEqual(y.attended?.map((a) => [a.artist, a.date, a.songs.length]), [['TV Girl', '2026-06-12', 0], ['Geese', '2026-10-03', 4]])
    const live = after.filter((x) => x.eyebrow === 'Live in 2026')
    assert.equal(live.length, 1)
    const c = live[0]
    assert.ok(c.kind === 'number' && c.viz?.kind === 'shows')
    assert.equal(c.big, 'Two shows. You were there.')
    assert.equal(c.line, 'Last: Geese, October 3.')
    // Newest first; Geese's matches his Forest Hills recording (poster), TV Girl gets her photo.
    assert.deepEqual(c.viz.items.map((s) => [s.artist, s.where, s.image.kind, s.songs.length]), [['Geese', 'Forest Hills Stadium · Oct 3', 'concert', 3], ['TV Girl', 'Brooklyn Paramount · Jun 12', 'artist', 0]])
    assert.deepEqual(c.play, { kind: 'song', artist: 'Geese', title: 'Taxes' })
  })

  it('no attended list yet (before Mobile #648): the declared show keeps its poster card', () => {
    const old = buildStory({ ...y, attended: [] }, { now: new Date(2026, 11, 17, 1), concerts })
    const live = old.filter((x) => x.eyebrow === 'Live in 2026')
    assert.equal(live.length, 1)
    assert.ok(live[0].kind === 'art' && live[0].poster)
    assert.equal(live[0].kind === 'art' && live[0].line, 'October 3, 2026. “I was there.”')
  })

  it('a runaway winner is named outright, not called a photo finish', () => {
    assert.equal(big(before, 'Your artist of the year'), 'TV Girl.')
  })

  it('a year whose log starts late has no "Where it started" card (Jake 10/22)', () => {
    // The fixture's history begins June 1: January–May are in no log.
    assert.deepEqual(y.coverage.monthsBeforeHistory, ['01', '02', '03', '04', '05'])
    assert.equal(before.some((x) => 'eyebrow' in x && x.eyebrow === 'Where it started'), false)
    assert.equal(after.some((x) => 'eyebrow' in x && x.eyebrow === 'Where it started'), false)
    assert.match(String(before[0].kind === 'cover' && before[0].line), /since June 1/)
  })

  it('a year logged from January keeps "Where it started"', () => {
    const jan = buildYearInReview({ year: 2026, listens: [L('2026-01-02T15:30:00Z', 'Geese', 'Taxes'), ...listens], library: [] })
    assert.deepEqual(jan.coverage.monthsBeforeHistory, [])
    const slides = buildStory(jan, { now: new Date(2026, 9, 12) })
    const s = slides.find((x) => x.kind === 'art' && x.eyebrow === 'Where it started')
    assert.ok(s && s.kind === 'art')
    assert.equal(s.big, 'Taxes')
    assert.equal(s.line, 'Geese · Friday, January 2 at 10:30 AM')
    assert.equal(slides[0].kind === 'cover' && slides[0].line, 'So far. None of it rented.')
  })

  it('the card list, in order — and no skips card, ever (Jake 10/29: "take skips out")', () => {
    assert.deepEqual(after.map((x) => `${x.kind}:${x.eyebrow}`), [
      'cover:JakeTunes · Year in Review', 'art:Your song of the year', 'list:The rest of the top 3', 'lanes:Your artist of the year',
      'art:Record of the year', 'ipod:Off the grid', 'number:The day it never stopped', 'number:When you listen',
      'number:Longest streak', 'iceberg:How deep you went', 'number:Range', 'number:Live in 2026',
      'number:The Top 1000', 'number:Does it work?', 'number:Who holds a seat', 'champions:Number one, everywhere', 'number:Why it matters',
      'end:Happy birthday',
    ])
    for (const s of [...before, ...after]) assert.doesNotMatch(JSON.stringify(s), /skip rate|real skips|Honest numbers/i)
  })

  it('the iPods count: no device split, just the iPod plays carried home (Jake 10/29)', () => {
    const c = after.find((x) => x.kind === 'ipod')
    assert.ok(c && c.kind === 'ipod')
    assert.equal(c.big, 'Even the iPod counts.')
    assert.equal(c.line, '1 play, no signal, no subscription, all carried home.')
    assert.equal(c.plays, 1)
    assert.deepEqual(c.tiles.map((t) => t.play), [{ kind: 'song', artist: 'Drake', title: 'Hotline Bling' }])
    assert.deepEqual(c.play, { kind: 'song', artist: 'Drake', title: 'Hotline Bling' })
    assert.doesNotMatch(JSON.stringify(after), /workmini|Laptop|devices\./, 'no workmini / laptop / phone split anywhere')
    const none = buildStory({ ...y, ipod: { plays: 0, songs: 0, top: [] } }, { now: new Date(2026, 11, 17, 1), concerts })
    assert.equal(none.some((x) => x.kind === 'ipod'), false, 'no iPod plays, no card')
  })

  it('the Top 1000 chapter is the measured numbers, nothing else', () => {
    const work = after.find((x) => x.eyebrow === 'Does it work?')
    assert.ok(work && work.kind === 'number' && work.viz?.kind === 'gauges')
    assert.equal(work.big, '87% right when it was sure.')   // 1,335 / 1,526
    assert.equal(work.line, 'Plays and stars alone: 56%.')
    assert.deepEqual(work.viz.items.map((g) => [g.pct, g.lead]), [[87, true], [56, false]])
    assert.doesNotMatch(JSON.stringify(after), /overruled/i, 'Jake 10/29: it read as "39% wrong"')
    const seats = after.find((x) => x.eyebrow === 'Who holds a seat')
    assert.ok(seats && seats.kind === 'number' && seats.viz?.kind === 'seats')
    assert.equal(seats.big, '462 artists made the cut.')
    assert.equal(seats.line, 'TV Girl: 16 seats. The Beatles: 56. No monopoly.')
    assert.deepEqual(seats.viz.cells, [0, 0, 1, 2, -1, 0, 2, 1, -1, 0])
    assert.deepEqual(seats.viz.legend.map((l) => [l.name, l.hot]), [['The Beatles', false], ['Red Hot Chili Peppers', false], ['TV Girl', true]])
    const champs = after.find((x) => x.kind === 'champions')
    assert.ok(champs && champs.kind === 'champions')
    assert.equal(champs.big, 'Two genres, two number ones.')
    assert.deepEqual(champs.rows.map((r) => [r.bracket, r.title, r.rank]), [['Classic Rock', 'Jane', 17], ['Rock', 'Au Pays du Cocaine', 3]])
    assert.deepEqual(champs.play, { kind: 'song', artist: 'Jefferson Starship', title: 'Jane' })
    const what = after.find((x) => x.eyebrow === 'The Top 1000')
    assert.ok(what && what.kind === 'number' && what.viz?.kind === 'pipeline')
    assert.deepEqual(what.viz.steps.map((s) => [s.value, s.label]), [['1,772', 'heats'], ['6,987', 'one-on-ones'], ['77', 'genre brackets'], ['Finals', 'champions duel'], ['1,000', 'seats']])
    const why = after.find((x) => x.eyebrow === 'Why it matters')
    assert.ok(why && why.kind === 'number')
    assert.equal(why.line, '92% sure. Nobody paid for a seat.')
  })

  it('word budget: headline ≤ 8 words, one line ≤ 12 (Jake 10/29: "too many words")', () => {
    const words = (s: string): number => s.split(/\s+/).filter(Boolean).length
    for (const s of [...before, ...after]) {
      if ('big' in s) assert.ok(words(s.big) <= 8, `${s.eyebrow}: "${s.big}"`)
      if ('line' in s && s.kind !== 'lanes') assert.ok(words(s.line) <= 12, `${s.eyebrow}: "${s.line}"`)
    }
  })

  it('every card has a picture, and every card about a song plays one', () => {
    for (const s of after) {
      const pictured = s.kind !== 'number' && s.kind !== 'end' ? true : !!s.viz
      assert.ok(pictured || s.eyebrow === 'Range', `${s.eyebrow} has no picture`)
      if (s.kind === 'number' && s.viz && ['mosaic', 'hours', 'calendar', 'pipeline'].includes(s.viz.kind) && s.eyebrow !== 'Range') assert.ok(s.play, `${s.eyebrow} shows songs but plays none`)
    }
    const rec = after.find((x) => x.eyebrow === 'Record of the year')
    assert.ok(rec && rec.kind === 'art' && rec.vinyl)
  })

  it('no chapter without homemini\'s measurement (the nightly file and the NAS copy)', () => {
    const bare = buildStory({ ...y, top1000: undefined }, { now: new Date(2026, 11, 17, 1) })
    assert.equal(bare.some((x) => x.eyebrow === 'The Top 1000' || x.kind === 'stats' || x.kind === 'champions'), false)
  })

  it('formats hours like a person says them', () => {
    assert.deepEqual([0, 2, 12, 23].map(hour12), ['midnight', '2 AM', 'noon', '11 PM'])
  })
})
