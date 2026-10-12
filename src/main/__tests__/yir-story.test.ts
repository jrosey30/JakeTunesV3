/**
 * Year in Review story slides (src/common/yir-story.ts): every sentence is a
 * fact the review carries; "so far" until December 17, the reveal after.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStory, hour12, isRevealed } from '../../common/yir-story.ts'
import { buildYearInReview } from '../../common/year-in-review.ts'
import type { Listen } from '../../common/listening-history.ts'

const L = (ts: string, artist: string, title: string, extra: Partial<Listen> = {}): Listen =>
  ({ ts, device: 'laptop', kind: 'play', pct: 100, artist, title, album: `${title} LP`, genre: 'Rock', ...extra })

const listens: Listen[] = [
  ...['06-01', '06-02', '06-03', '07-20', '07-21', '07-22', '07-23'].map((d) => L(`2026-${d}T16:00:00Z`, 'TV Girl', 'Pantyhose', { genre: 'Indie Pop' })),
  ...['06-04', '06-05', '06-06'].map((d) => L(`2026-${d}T16:00:00Z`, 'Geese', 'Taxes', { genre: 'Garage Punk' })),
  L('2026-06-07T16:00:00Z', 'Drake', 'Hotline Bling', { genre: 'Hip-Hop' }),
]
const y = buildYearInReview({ year: 2026, listens, library: [] })
const concerts = [
  { albumKey: 'geese|||forest hills', band: 'Geese', show: 'Forest Hills', venue: 'Forest Hills Stadium', date: 'October 3, 2026', notes: 'I was there.' },
  { albumKey: 'grateful dead|||nassau', band: 'Grateful Dead', show: 'Nassau', venue: 'Nassau Coliseum', date: 'May 15-16, 1980' },
]
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
    assert.equal(before[0].kind === 'cover' && before[0].line, 'So far.')
    assert.equal(after[0].kind === 'cover' && after[0].line, 'Your year in music.')
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

  it('formats hours like a person says them', () => {
    assert.deepEqual([0, 2, 12, 23].map(hour12), ['midnight', '2 AM', 'noon', '11 PM'])
  })
})
