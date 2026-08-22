/**
 * Best of <year> doctrine (2026-08-22): year-filtered, stars-then-plays
 * ranked, hard 2-per-album cap, 40 max, seeded mix with an adjacency
 * spread — and the same seed always deals the same order.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestOfYear } from '../../common/best-of-year.ts'

let nextId = 1
const t = (over: Record<string, unknown>) => ({ id: nextId++, year: 2026, rating: 0, playCount: 0, ...over })

describe('pickBestOfYear', () => {
  test('only the requested year makes the list', () => {
    const out = pickBestOfYear([
      t({ year: 2026, playCount: 5 }), t({ year: 2025, playCount: 500 }), t({ year: '2026', playCount: 3 }),
    ], { year: 2026 })
    assert.equal(out.length, 2)
    assert.ok(out.every((x) => Number(x.year) === 2026))
  })

  test('stars dominate plays; plays refine', () => {
    const starred = t({ rating: 5, playCount: 0, title: 'starred' })
    const played = t({ rating: 0, playCount: 40, title: 'played' })
    const both = t({ rating: 5, playCount: 40, title: 'both' })
    const out = pickBestOfYear([played, starred, both], { year: 2026, limit: 2 })
    assert.deepEqual(out.map((x) => x.title).sort(), ['both', 'starred'])
  })

  test('hard cap: never more than 2 per album', () => {
    const alb = (n: number) => t({ artist: 'Band', album: 'The Album', playCount: 50 - n, title: `t${n}` })
    const out = pickBestOfYear([alb(1), alb(2), alb(3), alb(4), t({ artist: 'Other', album: 'B', playCount: 1 })], { year: 2026 })
    const fromAlbum = out.filter((x) => x.album === 'The Album')
    assert.equal(fromAlbum.length, 2)
    assert.equal(out.length, 3)
  })

  test('album-less singles never share a phantom cap', () => {
    const singles = Array.from({ length: 5 }, (_, i) => t({ artist: `A${i}`, album: '', playCount: 10 }))
    assert.equal(pickBestOfYear(singles, { year: 2026 }).length, 5)
  })

  test('limit 40, and the mix is deterministic per seed', () => {
    const pool = Array.from({ length: 120 }, (_, i) => t({ artist: `Artist${i % 30}`, album: `Album${i % 30}`, playCount: (i * 7) % 41, rating: i % 3 ? 0 : 5, title: `s${i}` }))
    const a = pickBestOfYear(pool, { year: 2026 })
    const b = pickBestOfYear(pool, { year: 2026 })
    assert.equal(a.length, 40)
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id))
    // …and it is genuinely MIXED, not score-sorted.
    const scores = a.map((x) => (Number(x.rating) || 0) * 25 + Math.min(Number(x.playCount) || 0, 40))
    const sorted = [...scores].sort((x, y) => y - x)
    assert.notDeepEqual(scores, sorted)
  })

  test('spread pass: no same-album neighbors when avoidable', () => {
    const pool = [
      ...Array.from({ length: 2 }, (_, i) => t({ artist: 'A', album: 'One', playCount: 30, title: `a${i}` })),
      ...Array.from({ length: 2 }, (_, i) => t({ artist: 'B', album: 'Two', playCount: 30, title: `b${i}` })),
      ...Array.from({ length: 2 }, (_, i) => t({ artist: 'C', album: 'Three', playCount: 30, title: `c${i}` })),
      ...Array.from({ length: 6 }, (_, i) => t({ artist: `Solo${i}`, album: '', playCount: 20 })),
    ]
    const out = pickBestOfYear(pool, { year: 2026 })
    for (let i = 1; i < out.length; i++) {
      const same = out[i].album && out[i].album === out[i - 1].album
      assert.ok(!same, `same-album neighbors at ${i}: ${out[i].album}`)
    }
  })
})
