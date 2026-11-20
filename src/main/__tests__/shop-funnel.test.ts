/**
 * Brief 253: the Record Shop's search → save funnel. One `shop.search` line
 * per search Jake looked at, carrying what came of it; never the words.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createShopFunnel, KEYSTROKE_MS } from '../../common/shop-funnel.ts'
import { scrubEvent } from '../../common/usage-log.ts'

function clock() {
  let t = 1_000_000
  return { now: () => t, tick: (ms: number) => { t += ms } }
}
const answer = { len: 10, hits: 42, songs: 30, albums: 8, answerMs: 1480.6, how: 'typed' as const }

describe('shop funnel', () => {
  test('a search ending in two saves is one line with its saves and the first save time', () => {
    const c = clock(); const f = createShopFunnel(c.now)
    assert.equal(f.searched(answer), null, 'nothing before it')
    c.tick(4000); f.saved('song')
    c.tick(3000); f.saved('album')
    c.tick(1000)
    const ev = f.left()
    assert.ok(ev)
    assert.equal(ev.name, 'shop.search')
    assert.equal(ev.ms, 1481)
    assert.deepEqual(ev.detail, { len: 10, hits: 42, songs: 30, albums: 8, how: 'typed', saves: 2, albumSaves: 1, firstSaveMs: 4000, lookedMs: 8000 })
    assert.equal(f.left(), null, 'closed once')
  })

  test('typing through searches writes only the one that was looked at', () => {
    const c = clock(); const f = createShopFunnel(c.now)
    f.searched({ ...answer, len: 3 })
    c.tick(400)
    assert.equal(f.searched({ ...answer, len: 6 }), null, '"pin" → "pink f" in 400 ms is typing')
    c.tick(KEYSTROKE_MS)
    const ev = f.searched({ ...answer, len: 10 })
    assert.equal(ev?.detail.len, 6, 'looked at long enough: written when the next one replaces it')
    assert.equal(ev?.detail.saves, 0)
  })

  test('a quick save still counts, however fast the search was left', () => {
    const c = clock(); const f = createShopFunnel(c.now)
    f.searched({ ...answer, how: 'list' })
    c.tick(200); f.saved('album')
    const ev = f.left()
    assert.equal(ev?.detail.saves, 1)
    assert.equal(ev?.detail.how, 'list')
  })

  test('a save with no search on screen is not a funnel line', () => {
    const c = clock(); const f = createShopFunnel(c.now)
    f.saved('song')
    assert.equal(f.left(), null)
  })

  test('every key survives the usage log scrub (no key reads as words)', () => {
    const c = clock(); const f = createShopFunnel(c.now)
    f.searched(answer); c.tick(2000); f.saved('song')
    const ev = f.left()!
    const clean = scrubEvent({ t: new Date(0).toISOString(), ...ev }, 0)
    assert.deepEqual(clean?.detail, ev.detail)
    assert.equal(clean?.name, 'shop.search')
  })
})

describe('wiring', () => {
  const view = readFileSync(join(import.meta.dirname, '../../renderer/views/DownloadStore/DownloadView.tsx'), 'utf-8')
  test('every save from the search is counted, and the words never go in', () => {
    assert.match(view, /funnel\.saved\(q\.mediaType === 'album' \? 'album' : 'song'\)[\s\S]{0,200}?enqueue\(withOrigin\(q\)/)
    assert.match(view, /len: query\.trim\(\)\.length/)
    assert.ok(!/funnel\.searched\(\{[^}]*\bquery\s*[,}]/.test(view), 'the query itself is never passed')
  })
})
