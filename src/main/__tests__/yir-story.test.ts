/**
 * Year in Review story slides (src/common/yir-story.ts): every sentence is a
 * fact the review carries; "so far" until December 17, the reveal after.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStory, deviceRows, hour12, isRevealed } from '../../common/yir-story.ts'
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
    assert.equal(before[0].kind === 'cover' && before[0].line, 'So far. None of it rented.')
    assert.equal(after[0].kind === 'cover' && after[0].line, 'Your year in music. None of it rented.')
    assert.match(String(big(before, 'December 17')), /still being written/)
    assert.equal(big(after, 'Happy birthday'), 'That was 2026.')
  })

  it('the song of the year line comes from its own best week', () => {
    const s = before.find((x) => x.kind === 'art' && x.eyebrow === 'Your song of the year')
    assert.ok(s && s.kind === 'art')
    assert.equal(s.line, 'TV Girl · 7 times. Four of them in one week in July.')
    assert.deepEqual(s.play, { kind: 'song', artist: 'TV Girl', title: 'Pantyhose' })
  })

  it('busiest hour and busiest weekday are stated as two facts, not one peak', () => {
    assert.equal(big(before, 'When you listen'), 'Noon. Mondays.')
  })

  it('only shows that happened this year get a live card, with his own note', () => {
    const live = before.filter((x) => x.kind === 'art' && x.eyebrow === 'Live in 2026')
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
    assert.equal(before[0].kind === 'cover' && before[0].note, 'Since June 1, the day JakeTunes started keeping score.')
  })

  it('a year logged from January keeps "Where it started"', () => {
    const jan = buildYearInReview({ year: 2026, listens: [L('2026-01-02T15:30:00Z', 'Geese', 'Taxes'), ...listens], library: [] })
    assert.deepEqual(jan.coverage.monthsBeforeHistory, [])
    const slides = buildStory(jan, { now: new Date(2026, 9, 12) })
    const s = slides.find((x) => x.kind === 'art' && x.eyebrow === 'Where it started')
    assert.ok(s && s.kind === 'art')
    assert.equal(s.big, 'Taxes')
    assert.equal(s.line, 'Geese · Friday, January 2 at 10:30 AM')
    assert.equal(slides[0].kind === 'cover' && slides[0].note, undefined)
  })

  it('the card list, in order — and no skips card, ever (Jake 10/29: "take skips out")', () => {
    assert.deepEqual(after.map((x) => `${x.kind}:${x.eyebrow}`), [
      'cover:JakeTunes · Year in Review', 'art:Your song of the year', 'list:The rest of the top 3', 'lanes:Your artist of the year',
      'art:Record of the year', 'devices:Where the plays happened', 'number:The day it never stopped', 'number:When you listen',
      'number:Longest streak', 'iceberg:How deep you went', 'number:Range', 'art:Live in 2026',
      'number:The Top 1000', 'stats:Does it work?', 'stats:Who holds a seat', 'champions:Number one, everywhere', 'number:Why it matters',
      'end:Happy birthday',
    ])
    for (const s of [...before, ...after]) assert.doesNotMatch(JSON.stringify(s), /skip rate|real skips|Honest numbers/i)
  })

  it('where the plays happened: his own devices, biggest first, whole percents', () => {
    assert.deepEqual(deviceRows({ laptop: 2960, workmini: 5205, phone: 648, ipod: 689 }).map((d) => [d.name, d.plays, d.pct]),
      [['workmini', 5205, 55], ['Laptop', 2960, 31], ['iPods', 689, 7], ['Phone', 648, 7]])
    const d = after.find((x) => x.kind === 'devices')
    assert.ok(d && d.kind === 'devices')
    assert.equal(d.big, 'Three devices. One library you own.')
    assert.equal(d.line, 'Laptop played 64% of it. The iPods logged 1 play with no signal and no subscription.')
  })

  it('the Top 1000 chapter is the measured numbers, nothing else', () => {
    const work = after.find((x) => x.eyebrow === 'Does it work?')
    assert.ok(work && work.kind === 'stats')
    assert.equal(work.big, '87% right when it was sure.')   // 1,335 / 1,526
    assert.deepEqual(work.stats, [['10,611', 'answers you gave'], ['6,122', 'songs judged'], ['63%', 'one-on-ones called before you answered']])
    assert.equal(work.line, 'Plays and stars alone would call 56% of them. You overruled it 3,685 times. It took notes.')
    const seats = after.find((x) => x.eyebrow === 'Who holds a seat')
    assert.ok(seats && seats.kind === 'stats')
    assert.equal(seats.big, '462 artists made the cut.')
    // The artist of the year (TV Girl here) gets the honest share, with the leader beside it.
    assert.equal(seats.line, "Artist of the year TV Girl? 16 seats, 1.6% of the 1,000. The Beatles? 56. Love isn't a monopoly.")
    const champs = after.find((x) => x.kind === 'champions')
    assert.ok(champs && champs.kind === 'champions')
    assert.equal(champs.big, 'Two genres, two number ones.')
    assert.deepEqual(champs.rows.map((r) => [r.bracket, r.title, r.rank]), [['Classic Rock', 'Jane', 17], ['Rock', 'Au Pays du Cocaine', 3]])
    assert.match(String(big(after, 'Why it matters')), /Earned, not placed/)
    assert.match(String(after.find((x) => x.eyebrow === 'Why it matters' && x.kind === 'number')?.line), /92% sure of all 1,000/)
  })

  it('no chapter without homemini\'s measurement (the nightly file and the NAS copy)', () => {
    const bare = buildStory({ ...y, top1000: undefined }, { now: new Date(2026, 11, 17, 1) })
    assert.equal(bare.some((x) => x.eyebrow === 'The Top 1000' || x.kind === 'stats' || x.kind === 'champions'), false)
  })

  it('formats hours like a person says them', () => {
    assert.deepEqual([0, 2, 12, 23].map(hour12), ['midnight', '2 AM', 'noon', '11 PM'])
  })
})
