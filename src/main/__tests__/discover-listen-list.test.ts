/**
 * Discover never re-suggests what's on the Listen List (2026-10-11).
 *
 * Discover is where the radar lives now (its Brand New lanes, since the
 * 2026-07-14 rebuild), and it never checked the list: a pick Jake added came
 * back as "+ List" on the next visit. The radar's guard (listenListPredicate)
 * now runs on every feed that leaves main (dropListed), typed so a song card
 * meets listed songs and an album card listed albums.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dropListed, type FeedCard } from '../discover-feed.ts'
import { listenListPredicate } from '../radar-core.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const card = (type: FeedCard['type'], artist: string, title: string, lane = 'fresh-albums'): FeedCard =>
  ({ lane, type, artist, title, why: '' })

// The rows the way Discover's "+ List" saves them: a song card as a song,
// an album card as a songless album row.
const list = [
  { song: 'Good Lies', artist: 'Overmono' },
  { album: 'Rat Saw God (Deluxe Edition)', artist: 'Wednesday' },
  { song: 'Romance', artist: 'Fontaines D.C.' },                  // a title track, saved as a song
  { album: 'Этажи', artist: 'Молчат Дома', kind: 'album' },
]

describe('listenListPredicate — typed', () => {
  const isOnList = listenListPredicate(list)
  it('a song card meets listed songs only', () => {
    assert.equal(isOnList('Overmono', 'Good Lies', 'song'), true)
    assert.equal(isOnList('Wednesday', 'Rat Saw God', 'song'), false)
  })
  it('an album card meets listed albums only — a listed title track is not the record', () => {
    assert.equal(isOnList('Wednesday', 'Rat Saw God', 'album'), true)
    assert.equal(isOnList('Fontaines D.C.', 'Romance', 'album'), false)
  })
  it('untyped (the radar\'s releases) checks both, as before', () => {
    assert.equal(isOnList('Fontaines D.C.', 'Romance'), true)
    assert.equal(isOnList('Wednesday', 'Rat Saw God'), true)
  })
})

describe('dropListed — the feed without what is already on the list', () => {
  const lanes = [
    { id: 'fresh-albums', title: 'Brand New Albums', cards: [
      card('album', 'Wednesday', 'Rat Saw God'),                   // listed (as the Deluxe Edition) → out
      card('album', 'Fontaines D.C.', 'Romance'),                  // only its title track is listed → stays
      card('album', 'Молчат Дома', 'Этажи (Делюкс)'),              // listed, other edition, Cyrillic → out
      card('album', 'Jamie xx', 'In Waves'),
    ] },
    { id: 'songs', title: 'Songs to Try', cards: [
      card('song', 'OVERMONO', 'good lies!', 'songs'),             // listed → out
    ] },
    { id: 'scene', title: 'From the Scene', cards: [
      card('artist', 'Wednesday', 'Wednesday', 'scene'),           // artist cards pass
    ] },
  ]
  const out = dropListed(lanes, listenListPredicate(list))

  it('leaves out listed songs and albums, in any edition or alphabet', () => {
    assert.deepEqual(out.find((l) => l.id === 'fresh-albums')?.cards.map((c) => (c as FeedCard).title), ['Romance', 'In Waves'])
  })
  it('drops a lane the list emptied, and keeps the rest in order', () => {
    assert.deepEqual(out.map((l) => l.id), ['fresh-albums', 'scene'])
  })
  it('lets artist cards through — the guard keys songs and albums', () => {
    assert.equal(out.find((l) => l.id === 'scene')?.cards.length, 1)
  })
  it('never mutates the feed it was handed (the cache stays whole)', () => {
    assert.equal(lanes[0].cards.length, 4)
    assert.equal(lanes.length, 3)
  })
  it('an empty list drops nothing', () => {
    assert.deepEqual(dropListed(lanes, listenListPredicate([])), lanes)
  })
})

describe('wiring (checked at the source)', () => {
  const index = read('main/index.ts')
  it('every feed that leaves main goes through the guard', () => {
    const pushes = [...index.matchAll(/sendToRenderer\('discover-feed-updated', \{ lanes: ([^,]+),/g)].map((m) => m[1])
    assert.equal(pushes.length, 2)
    for (const lanes of pushes) assert.match(lanes, /^await withoutListed\(/)
    const handler = index.slice(index.indexOf("ipc.handle('get-discover-feed'"), index.indexOf("}, { refuse: REFUSED_SENDER })", index.indexOf("ipc.handle('get-discover-feed'")))
    assert.equal(handler.match(/await withoutListed\(/g)?.length, 2, 'cached and freshly built paths')
    assert.doesNotMatch(handler, /lanes: discoverFeedMem\.lanes/)
    assert.match(handler, /if \(!gen\.ok \|\| !gen\.lanes\) return gen\n[\s\S]*return \{ \.\.\.gen, lanes \}\n$/)
  })
  it('the guard reads the Listen List through the radar predicate', () => {
    assert.match(index, /return dropListed\(lanes, listenListPredicate\(await readRecommendationsFile\(\)\)\)/)
  })
  it('the page forgets an added card between visits only once the add succeeded', () => {
    const view = read('renderer/views/NewForYouView.tsx')
    assert.match(view, /if \(res\?\.ok\) \{\n\s+listedIds\.add\(id\)/)
    assert.match(view, /pendingFeed = \{ lanes: withoutListedIds\(p\.lanes\)/)
  })
})
