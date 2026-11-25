/**
 * Record Shop Phase 4, as Jake approved the picture (2026-11-24): when the
 * exact edition isn't on Qobuz, a plain banner right away — "The Deluxe of
 * Animals isn’t on Qobuz. The Standard (5 songs) is." — and one button, "Save
 * the Standard". Nothing is taken until it is pressed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { offerBanner, offerButton, offerLine, type ShopOffer } from '../../common/closest-edition.ts'
import { shopBanner, bannerIsForPage, refusalKey, BANNER_WINDOW_MS } from '../../common/shop-banner.ts'
import { recordName } from '../../common/shop-card-edition.ts'
import { retiredNamesIn } from '../../common/shop-names.ts'

const SRC = join(import.meta.dirname, '..', '..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const standard = (n: number): Extract<ShopOffer, { kind: 'edition' }> => ({ kind: 'edition', edition: { collectionId: 77, name: 'Animals', label: 'Standard', trackCount: n, releaseYear: 1977 }, diff: { missing: [], added: [], lengths: [] } })
const song = (title: string, trackNumber: number) => ({ title, trackNumber })

describe('the banner’s words', () => {
  it('the picture, word for word', () => {
    const o = standard(5)
    assert.equal(offerBanner(o, { album: 'Animals', asked: 'Deluxe', askedCount: 7 }), 'The Deluxe of Animals isn’t on Qobuz. The Standard (5 songs) is.')
    assert.equal(offerButton(o, { asked: 'Deluxe' }), 'Save the Standard')
  })
  it('names the record whatever the edition was called, and asks nothing (the button is the question)', () => {
    assert.equal(offerBanner(standard(12), { album: 'Manning Fireworks', asked: 'Standard', askedCount: 9 }), 'The 9-song edition of Manning Fireworks isn’t on Qobuz. The 12-song edition is.', 'the size once')
    assert.equal(offerBanner({ ...standard(14), edition: { ...standard(14).edition, label: 'Clean' }, clean: true }, { album: 'Ready to Die', asked: 'Standard', askedCount: 14 }), 'The explicit edition of Ready to Die isn’t on Qobuz. The clean edition (14 songs) is.')
    assert.equal(offerBanner(standard(5), { album: 'Animals' }), 'This edition of Animals isn’t on Qobuz. The 5-song edition is.')
    for (const line of [offerBanner(standard(5), { album: 'Animals', asked: 'Deluxe' })]) assert.doesNotMatch(line, /\?/)
  })
  it('part of an album, Bandcamp only, or a transfer that came back short', () => {
    const part: ShopOffer = { kind: 'songs', have: [song('a', 1), song('b', 2)], missing: [song('c', 3)], owned: 1, of: 4 }
    assert.equal(offerBanner(part, { album: 'Pink Flag' }), 'Qobuz has 3 of the 4 songs on Pink Flag. The other one would go on your Listening List.', 'nothing happens before a press')
    assert.equal(offerBanner({ ...part, missing: [song('c', 3), song('d', 4)], owned: 0, of: 4 }, { album: 'Pink Flag' }), 'Qobuz has 2 of the 4 songs on Pink Flag. The other 2 would go on your Listening List.')
    assert.equal(offerBanner({ kind: 'songs', have: [song('a', 1), song('b', 2)], missing: [], owned: 0, of: 2, from: 3 }, { album: 'X' }), 'Qobuz has every song of X, on a 3-song edition.')
    assert.equal(offerBanner({ kind: 'bandcamp', url: 'u', name: 'n', band: 'b' }, { album: 'Damaged' }), 'Damaged isn’t on Qobuz. Bandcamp has it, as a lossy MP3.')
    assert.equal(offerBanner({ kind: 'songs-each', of: 9 }, { album: 'Damaged' }), 'Damaged didn’t save as a whole album. Save its songs one at a time?', 'true whether or not anything downloaded')
    assert.deepEqual(retiredNamesIn(offerBanner(part, { album: 'Pink Flag' })), [])
  })
  it('the question elsewhere (Downloads, the album page) is unchanged', () => {
    assert.equal(offerLine(standard(11), { asked: 'Deluxe', askedCount: 19 }), 'The Deluxe isn’t on Qobuz. The Standard (11 songs) is. Save that?')
  })
})

const NOW = Date.parse('2026-11-24T20:00:00Z')
const refused = (key: string, o: { album?: string; surface?: string; mediaType?: string; endedAt?: number; offers?: ShopOffer[]; offerTaken?: 'edition' } = {}) => ({
  key,
  status: 'failed' as const,
  outcome: 'exact-not-found',
  primary: 'Not on Qobuz as asked',
  endedAt: o.endedAt ?? NOW - 5_000,
  result: { kind: 'query' as const, source: 'qobuz', mediaType: o.mediaType ?? 'album', id: key, desc: key, artist: 'Pink Floyd', album: o.album ?? 'Animals', trackCount: 7, surface: o.surface ?? 'search' },
  preflightAnswer: { answer: 'no' as const, why: 'edition-differs' as const, offers: o.offers ?? [standard(5)], asked: 'Deluxe', askedCount: 7 },
  ...(o.offerTaken ? { offerTaken: o.offerTaken } : {}),
})

describe('which refusal the banner shows', () => {
  it('an album saved from Search, refused a moment ago, with an offer: at once', () => {
    const b = shopBanner([refused('a')], NOW)
    assert.ok(b)
    assert.equal(b.key, 'a')
    assert.equal(b.line, 'The Deluxe of Animals isn’t on Qobuz. The Standard (5 songs) is.')
    assert.equal(b.button, 'Save the Standard')
    assert.equal(b.offer.kind, 'edition')
  })
  it('the newest of several', () => {
    const b = shopBanner([refused('old', { album: 'Meddle', endedAt: NOW - 60_000 }), refused('new', { album: 'Animals', endedAt: NOW - 1_000 })], NOW)
    assert.equal(b?.key, 'new')
  })
  it('never for another surface, a song, an old refusal, an offer taken, one waved away, or one with nothing to offer', () => {
    assert.equal(shopBanner([refused('a', { surface: 'for-you' })], NOW), null, 'For You and the list show their offers on the card')
    assert.equal(shopBanner([refused('a', { mediaType: 'track' })], NOW), null)
    assert.equal(shopBanner([refused('a', { endedAt: NOW - BANNER_WINDOW_MS - 1 })], NOW), null)
    assert.ok(shopBanner([refused('a', { endedAt: NOW - BANNER_WINDOW_MS })], NOW))
    assert.equal(shopBanner([refused('a', { offerTaken: 'edition' })], NOW), null)
    assert.equal(shopBanner([refused('a')], NOW, new Set([refusalKey('a', NOW - 5_000)])), null)
    assert.equal(shopBanner([refused('a', { offers: [] })], NOW), null)
    assert.equal(shopBanner([{ ...refused('a'), status: 'done' as const }], NOW), null)
  })
})

describe('review of #496', () => {
  it('the record by its own name: Apple’s edition words are not said twice', () => {
    const b = shopBanner([refused('a', { album: 'Animals (Deluxe Edition)' })], NOW)
    assert.equal(b?.line, 'The Deluxe of Animals isn’t on Qobuz. The Standard (5 songs) is.')
    assert.equal(recordName('Animals (Deluxe Edition)'), 'Animals')
    assert.equal(recordName('Wish You Were Here - 2011 Remaster'), 'Wish You Were Here')
    assert.equal(recordName('Sorry - Single'), 'Sorry')
    assert.equal(recordName('Enter the Wu-Tang (36 Chambers)'), 'Enter the Wu-Tang (36 Chambers)', 'a bracket that is the name stays')
  })
  it('✕ waves away that refusal only: the same edition refused again later shows', () => {
    const first = refused('a', { endedAt: NOW - 60_000 })
    const gone = new Set([refusalKey('a', NOW - 60_000)])
    assert.equal(shopBanner([first], NOW, gone), null)
    assert.ok(shopBanner([{ ...first, endedAt: NOW - 1_000 }], NOW, gone), 'refused again after a Retry')
  })
  it('a reload doesn’t bring back a banner from before it; the timer ends ten minutes after the refusal', () => {
    assert.equal(shopBanner([refused('a', { endedAt: NOW - 5_000 })], NOW, new Set(), NOW - 1_000), null)
    assert.ok(shopBanner([refused('a', { endedAt: NOW - 500 })], NOW, new Set(), NOW - 1_000))
    assert.equal(shopBanner([refused('a', { endedAt: NOW - 5_000 })], NOW)?.until, NOW - 5_000 + BANNER_WINDOW_MS)
  })
  it('steps aside while that album’s own page (with the same buttons) is open', () => {
    const b = shopBanner([refused('a')], NOW)!
    assert.equal(bannerIsForPage(b, { artist: 'Pink Floyd', name: 'Animals' }), true)
    assert.equal(bannerIsForPage({ ...b, collectionId: 33 }, { artist: 'Pink Floyd', name: 'Animals (Deluxe)', collectionId: 33 }), true)
    assert.equal(bannerIsForPage({ ...b, collectionId: 33 }, { artist: 'Pink Floyd', name: 'Animals', collectionId: 3 }), false, 'another edition’s page')
    assert.equal(bannerIsForPage(b, { artist: 'Pink Floyd', name: 'Meddle' }), false)
    assert.equal(bannerIsForPage(b, null), false)
    assert.match(src('renderer/views/DownloadStore/ShopBanner.tsx'), /if \(!b \|\| bannerIsForPage\(b, openAlbum\)\) return null/)
    assert.match(src('renderer/views/DownloadStore/ShopBanner.tsx'), /dismissed\.add\(b\.refusal\)/)
  })
})

describe('the Search tab', () => {
  it('draws the banner above its results, and the button takes that offer on that job', () => {
    const view = src('renderer/views/DownloadStore/DownloadView.tsx')
    const body = view.indexOf('<div className="dl-body">')
    assert.ok(body > 0 && view.indexOf('<ShopBanner openAlbum=') > body && view.indexOf('<ShopBanner openAlbum=') < view.indexOf('In your library</span><span className="dl-rule"'))
    const banner = src('renderer/views/DownloadStore/ShopBanner.tsx')
    assert.match(banner, /takeOffer\(b\.key, b\.offer\)/)
    assert.match(banner, /shopBanner\(queue, Date\.now\(\), dismissed, LOADED_AT\)/)
  })
})
