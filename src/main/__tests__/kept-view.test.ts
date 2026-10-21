import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextKeptRoot, isKeptRoot, type KeptRoot } from '../../renderer/keptView.ts'
import { markHistoryNavigation, takeHistoryNavigation } from '../../renderer/navIntent.ts'

/** Walk a navigation path and return the kept root after each step. */
const walk = (views: string[], start: KeptRoot | null = null): Array<KeptRoot | null> => {
  const out: Array<KeptRoot | null> = []
  let kept = start
  for (const v of views) { kept = nextKeptRoot(v, kept); out.push(kept) }
  return out
}

describe('keptView — which browse page survives under a detail page', () => {
  it('a browse grid is kept while you are on it', () => {
    for (const r of ['artists', 'albums']) assert.equal(nextKeptRoot(r, null), r)
  })

  it('Home is never kept (jewel-case reverse + Cover Flow arrow ownership need it to remount)', () => {
    assert.equal(nextKeptRoot('home', null), null)
    assert.equal(nextKeptRoot('home', 'artists'), null)
    assert.deepEqual(walk(['home', 'album-detail', 'home']), [null, null, null])
  })

  it('Artists stays kept through artist → album → back → back', () => {
    assert.deepEqual(
      walk(['artists', 'artist-detail', 'album-detail', 'artist-detail', 'artists']),
      ['artists', 'artists', 'artists', 'artists', 'artists'],
    )
  })

  it('Albums stays kept under its album pages', () => {
    assert.deepEqual(walk(['albums', 'album-detail', 'albums']), ['albums', 'albums', 'albums'])
  })

  it('switching root replaces the kept page (only one is ever kept)', () => {
    assert.deepEqual(walk(['artists', 'artist-detail', 'albums']), ['artists', 'artists', 'albums'])
  })

  it('any other view drops it — the next root mounts fresh', () => {
    assert.deepEqual(walk(['artists', 'artist-detail', 'songs', 'artist-detail']), ['artists', 'artists', null, null])
    assert.equal(nextKeptRoot('musicman', 'albums'), null)
    assert.equal(nextKeptRoot('playlist', 'albums'), null)
  })

  it('a detail page reached with nothing kept keeps nothing', () => {
    assert.equal(nextKeptRoot('album-detail', null), null)
  })

  it('detail pages are never roots themselves (they read their subject from global state)', () => {
    assert.equal(isKeptRoot('artist-detail'), false)
    assert.equal(isKeptRoot('album-detail'), false)
    assert.equal(isKeptRoot('songs'), false)
  })
})

describe('navIntent — back/forward is a return, taken exactly once', () => {
  it('take() is false with no mark, true once after a mark, then false again', () => {
    takeHistoryNavigation()
    assert.equal(takeHistoryNavigation(), false)
    markHistoryNavigation()
    assert.equal(takeHistoryNavigation(), true)
    assert.equal(takeHistoryNavigation(), false)
  })

  it('an untaken mark expires instead of leaking into the next arrival', async () => {
    markHistoryNavigation()
    await new Promise((r) => setTimeout(r, 560))
    assert.equal(takeHistoryNavigation(), false)
  })
})
