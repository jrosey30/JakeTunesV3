/**
 * Discovery shelf quality (2026-08-25). Jake: "im still concerned the brain is
 * not as good as we think it is. i see a lack of new music in discovery pretty
 * much always....its glitchy....its not fantastic as it should be."
 *
 * The audit that produced these rules: the gap lane was 24 of 51 cards from 8
 * artists he already owns, and included blink-182 "Studio Outtakes" at 99%,
 * "Spotify Singles", "Shady Beats", a bootleg-shaped "Dark Ages Chronicles -
 * The Red Handle Pandemic PT1", and TRON: Legacy three times.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkRelease, trimGapLane } from '../discover-feed.ts'

describe('isJunkRelease — session leftovers and promo discs are not records', () => {
  test('rejects the things the live feed actually shipped', () => {
    for (const t of ['Studio Outtakes', 'Spotify Singles', 'Shady Beats',
                     'Dark Ages Chronicles - The Red Handle Pandemic PT1',
                     'The Demos', 'Unreleased', 'iTunes Session', 'Interview Disc']) {
      assert.equal(isJunkRelease(t), true, `should reject: ${t}`)
    }
  })

  test('does NOT reject canonical records', () => {
    for (const t of ['Nevermind', 'California', 'American Dream', 'Bleach',
                     'Kamikaze', 'I NEVER LIKED YOU', 'MTV Unplugged in New York']) {
      assert.equal(isJunkRelease(t), false, `should keep: ${t}`)
    }
  })
})

describe('trimGapLane — completion must not dominate the shop', () => {
  test('caps one record per artist', () => {
    const out = trimGapLane([
      { artist: 'blink-182', title: 'California' },
      { artist: 'blink-182', title: 'Dogs Eating Dogs' },
      { artist: 'blink-182', title: 'Wasting Time' },
      { artist: 'Nirvana', title: 'Bleach' },
    ], { perArtist: 1 })
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((c) => c.artist), ['blink-182', 'Nirvana'])
  })

  test('drops junk even when it would fit under the cap', () => {
    const out = trimGapLane([
      { artist: 'blink-182', title: 'Studio Outtakes' },
      { artist: 'blink-182', title: 'California' },
    ], { perArtist: 1 })
    assert.deepEqual(out.map((c) => c.title), ['California'])
  })

  test('collapses the TRON: Legacy hat-trick to one entry', () => {
    const out = trimGapLane([
      { artist: 'Daft Punk', title: 'TRON: Legacy' },
      { artist: 'Daft Punk', title: 'Tron: Legacy Score' },
      { artist: 'Daft Punk', title: 'TRON: Legacy Collector’s Digital EP' },
    ], { perArtist: 3 })
    assert.equal(out.length, 1)
  })
})
