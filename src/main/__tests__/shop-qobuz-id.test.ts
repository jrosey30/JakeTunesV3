/**
 * Brief 261: the shop resolves a row to one Qobuz id (common/shop-qobuz-id.ts).
 * The rules only: which item a row names, and when it names none.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { qobuzHitsOf, type QobuzHit } from '../../common/shop-lossless.ts'
import {
  createRateWindow, deezerIsrc, deezerUpc, downloadPathEvent, explicitSibling, isQobuzId, pickDeezer, planKey, planRowFrom, planRowOfJob, resolvePlan, versionIsAnotherCut,
  type PlanRow,
} from '../../common/shop-qobuz-id.ts'

const track = (id: string, o: Partial<QobuzHit> = {}): QobuzHit => ({ kind: 'track', id, artist: 'Kendrick Lamar', title: 'Money Trees', durationSec: 386, album: 'good kid, m.A.A.d city', albumArtist: 'Kendrick Lamar', explicit: true, ...o })
const album = (id: string, o: Partial<QobuzHit> = {}): QobuzHit => ({ kind: 'album', id, artist: 'Wednesday', title: 'Rat Saw God', tracksCount: 10, explicit: false, ...o })
const SONG: PlanRow = { kind: 'song', artist: 'Kendrick Lamar', title: 'Money Trees', album: 'good kid, m.A.A.d city', durationMs: 386_500, explicit: true }

describe('a song', () => {
  it('the page names it: same title, artist, length within 3 s, the row’s album', () => {
    assert.deepEqual(resolvePlan(SONG, [track('1')]), { id: '1', kind: 'track', how: 'catalog', explicit: true })
  })
  it('another length is another recording: no plan', () => {
    assert.equal(resolvePlan(SONG, [track('1', { durationSec: 392 })]), null)
    assert.equal(resolvePlan({ ...SONG, durationMs: undefined }, [track('1')]), null, 'no length and no ISRC: nothing proves it')
  })
  it('a near title or another artist names nothing', () => {
    assert.equal(resolvePlan(SONG, [track('1', { title: 'Money Trees (Remix)' })]), null)
    assert.equal(resolvePlan(SONG, [track('1', { artist: 'Kendrick Lamar Tribute Band' })]), null)
  })
  it('explicit: an explicit row takes only the explicit copy', () => {
    assert.equal(resolvePlan(SONG, [track('clean', { explicit: false })]), null)
    assert.equal(resolvePlan(SONG, [track('clean', { explicit: false }), track('dirty')])?.id, 'dirty')
  })
  it('explicit wins by default: a row Apple calls not explicit still takes the explicit copy when there is one', () => {
    const row: PlanRow = { ...SONG, explicit: false }
    assert.equal(resolvePlan(row, [track('clean', { explicit: false }), track('dirty')])?.id, 'dirty')
    assert.equal(resolvePlan(row, [track('clean', { explicit: false })])?.id, 'clean', 'a record with no explicit copy is a clean record')
  })
  it('Apple’s cleaned row is never a plan: its length is the clean edit’s', () => {
    assert.equal(resolvePlan({ ...SONG, explicit: false, cleaned: true }, [track('1')]), null)
  })
  it('compilation ISRC: the same recording on a compilation and on its album, the album wins', () => {
    const isrc = 'USUM71210785'
    const hits = [
      track('comp', { album: 'Hip-Hop 50: West Coast', albumArtist: 'Various Artists', isrc }),
      track('real', { isrc }),
      track('other', { isrc: 'USUM79999999' }),
    ]
    assert.equal(resolvePlan(SONG, hits, { isrc })?.id, 'real')
    assert.equal(resolvePlan(SONG, hits, { isrc })?.how, 'isrc')
    assert.equal(resolvePlan({ ...SONG, album: undefined }, hits, { isrc })?.id, 'real', 'no album on the row: the compilation is still not it')
    assert.equal(resolvePlan(SONG, [hits[0]], { isrc }), null, 'only the compilation: the walk weighs that (Brief 231)')
  })
  it('a row on another album than Qobuz’s copy: no plan', () => {
    assert.equal(resolvePlan(SONG, [track('1', { album: 'Section.80' })]), null)
  })
  it('a clean edit by ISRC never lands while an explicit copy is there (Watch the Throne)', () => {
    // Apple's row carries no explicit flag; Deezer's ISRC is the clean edit's. The ISRC search
    // finds only that recording, so main passes the row's catalogue answer as well.
    const row: PlanRow = { kind: 'song', artist: 'JAY-Z', title: 'Niggas In Paris', album: 'Watch The Throne (Deluxe)', durationMs: 219_000 }
    const base = { artist: 'JAY-Z', title: 'Niggas In Paris', album: 'Watch The Throne (Deluxe)', albumArtist: 'JAY-Z', durationSec: 219 }
    const cleanIsrc = 'USUM71111111'
    const clean = track('clean', { ...base, explicit: false, isrc: cleanIsrc, hires: true })
    const dirty = track('dirty', { ...base, explicit: true, isrc: 'USUM72222222' })
    assert.equal(resolvePlan(row, [dirty, clean], { isrc: cleanIsrc }), null, 'the ISRC names the clean edit: walk')
    assert.equal(resolvePlan(row, [clean, dirty])?.id, 'dirty', 'by the page alone: the explicit copy')
    assert.equal(resolvePlan(row, [clean], { isrc: cleanIsrc })?.id, 'clean', 'no explicit copy seen: the clean record is the record')
    assert.equal(explicitSibling(row, [clean, dirty])?.id, 'dirty')
    assert.equal(explicitSibling(row, [clean, track('d2', { ...base, explicit: true, durationSec: 260 })]), null, 'another length is another recording')
    assert.equal(explicitSibling(row, [clean, track('d3', { ...base, explicit: true, albumArtist: 'Various Artists', album: 'Now 80' })]), null, 'a compilation’s flag proves nothing')
  })
  it('a version Qobuz names as another cut is not the song, unless the row asks for it', () => {
    for (const version of ['Live', 'Demo', 'Remix', 'Club Mix', 'Acoustic', 'Instrumental', 'Radio Edit', 'Live at Glastonbury 2019', 'Taylor’s Version']) {
      assert.equal(resolvePlan(SONG, [track('1', { version })]), null, version)
    }
    for (const version of ['Remastered', 'Album Version', 'Explicit', 'Original Mix', '2012 Remaster']) {
      assert.equal(resolvePlan(SONG, [track('1', { version })])?.id, '1', version)
    }
    assert.equal(resolvePlan({ ...SONG, title: 'Money Trees (Live)' }, [track('1', { version: 'Live' })])?.id, '1', 'the row asks for the live cut')
    assert.equal(versionIsAnotherCut('Live and Let Die', 'Live and Let Die', 'Remastered'), false, 'a song named with the word is not another cut')
    assert.equal(versionIsAnotherCut('Live and Let Die', 'Live and Let Die', 'Live'), true, 'but its live take is')
  })
  it('twin ids of one recording on one album: the hi-res one', () => {
    assert.equal(resolvePlan(SONG, [track('a'), track('b', { hires: true })])?.id, 'b')
  })
})

describe('an album', () => {
  const ROW: PlanRow = { kind: 'album', artist: 'Wednesday', title: 'Rat Saw God', trackCount: 10 }
  it('one edition of that name and size: that one', () => {
    assert.deepEqual(resolvePlan(ROW, [album('a'), album('deluxe', { title: 'Rat Saw God', version: 'Deluxe', tracksCount: 14 })]), { id: 'a', kind: 'album', how: 'catalog', explicit: false })
  })
  it('two of that size and no barcode: no plan; the release’s UPC picks', () => {
    const hits = [album('a', { upc: '0656605155122' }), album('b', { upc: '0656605155139' })]
    assert.equal(resolvePlan(ROW, hits), null)
    assert.equal(resolvePlan(ROW, hits, { upc: '656605155139' })?.id, 'b', 'leading zeros aside')
    assert.equal(resolvePlan(ROW, hits, { upc: '656605155139' })?.how, 'upc')
  })
  it('wrong edition by UPC is refused: a barcode never overrules the edition’s size', () => {
    const hits = [album('std', { upc: '1111' }), album('std2', { upc: '2222' }), album('deluxe', { tracksCount: 14, upc: '3333' })]
    assert.equal(resolvePlan(ROW, hits, { upc: '3333' }), null)
  })
  it('the explicit rule holds for records too', () => {
    const hits = [album('clean', { explicit: false }), album('dirty', { explicit: true })]
    assert.equal(resolvePlan({ ...ROW, explicit: true }, [hits[0]]), null)
    assert.equal(resolvePlan(ROW, hits)?.id, 'dirty')
    assert.equal(resolvePlan({ ...ROW, cleaned: true }, hits)?.id, 'dirty', 'Apple’s cleaned edition: the explicit one is the record')
  })
  it('no size on the row: no plan (an edition must be named)', () => {
    assert.equal(resolvePlan({ ...ROW, trackCount: undefined }, [album('a')]), null)
  })
  it('Apple’s " - EP" stamp aside', () => {
    assert.equal(resolvePlan({ ...ROW, title: 'Rat Saw God - EP' }, [album('a')])?.id, 'a')
  })
})

describe('what comes in', () => {
  it('Qobuz’s catalogue answer carries ids, flags, ISRCs and barcodes', () => {
    const hits = qobuzHitsOf({
      albums: { items: [{ id: '0656605155122', title: 'Rat Saw God', artist: { name: 'Wednesday' }, streamable: true, parental_warning: false, upc: '0656605155122', tracks_count: 10 }] },
      tracks: { items: [{ id: 12345, title: 'Money Trees', performer: { name: 'Kendrick Lamar' }, streamable: true, parental_warning: true, duration: 386, isrc: 'usum71210785', album: { title: 'good kid, m.A.A.d city', artist: { name: 'Kendrick Lamar' } } }] },
    })
    assert.equal(hits[0].id, '0656605155122')
    assert.equal(hits[0].tracksCount, 10)
    assert.equal(hits[1].id, '12345')
    assert.equal(hits[1].isrc, 'USUM71210785')
    assert.equal(hits[1].albumArtist, 'Kendrick Lamar')
    assert.equal(qobuzHitsOf({ tracks: { items: [{ id: '../x', title: 'A', performer: { name: 'B' }, streamable: true }] } })[0].id, undefined, 'no path-like id')
  })
  it('a row over IPC: only the fields it may carry', () => {
    assert.equal(planRowFrom({ kind: 'song', artist: '', title: 'x' }), null)
    assert.equal(planRowFrom({ kind: 'playlist', artist: 'a', title: 'x' }), null)
    assert.deepEqual(planRowFrom({ kind: 'song', artist: ' A ', title: 'T', durationMs: 5, trackCount: 1.5, explicit: 'yes', extra: 1 }), { kind: 'song', artist: 'A', title: 'T' })
  })
  it('a queued job’s row; a source edition or a lossy pick is none', () => {
    assert.deepEqual(planRowOfJob({ kind: 'query', mediaType: 'album', artist: 'Wednesday', album: 'Rat Saw God', trackCount: 10, explicitSource: false }), { kind: 'album', artist: 'Wednesday', title: 'Rat Saw God', trackCount: 10 })
    assert.equal(planRowOfJob({ kind: 'query', mediaType: 'album', artist: 'W', album: 'R', lossyOk: true }), null)
    assert.equal(planRowOfJob({ kind: 'query', mediaType: 'album', artist: 'W', album: 'R', sourceEdition: {} }), null)
    assert.equal(planRowOfJob({ kind: 'id', mediaType: 'track', artist: 'W', title: 'R' }), null)
  })
  it('one key per request, whatever the spacing and case', () => {
    assert.equal(planKey({ kind: 'song', artist: 'Pink Floyd', title: 'Money', durationMs: 382_000 }), planKey({ kind: 'song', artist: 'pink floyd ', title: 'money', durationMs: 382_200 }))
    assert.notEqual(planKey({ kind: 'song', artist: 'Pink Floyd', title: 'Money', explicit: true }), planKey({ kind: 'song', artist: 'Pink Floyd', title: 'Money' }))
  })
  it('ids main will hand to rip', () => {
    assert.ok(isQobuzId('alk4osa4lhi6a'))
    assert.ok(isQobuzId('60132045'))
    assert.ok(!isQobuzId('a/b'))
    assert.ok(!isQobuzId(''))
    assert.ok(!isQobuzId(12))
  })
})

describe('Deezer', () => {
  it('a song must run within 3 s of Apple’s length; the row’s album breaks a tie', () => {
    const body = { data: [
      { id: 1, title: 'Money Trees', duration: 400, artist: { name: 'Kendrick Lamar' }, album: { title: 'good kid' } },
      { id: 2, title: 'Money Trees', duration: 386, artist: { name: 'Kendrick Lamar' }, album: { title: 'Hits' } },
      { id: 3, title: 'Money Trees', duration: 387, artist: { name: 'Kendrick Lamar' }, album: { title: 'good kid, m.A.A.d city' } },
    ] }
    assert.equal(pickDeezer(SONG, body), '3')
    assert.equal(pickDeezer({ ...SONG, durationMs: undefined }, body), null)
  })
  it('an album of another size is not it', () => {
    const body = { data: [{ id: 9, title: 'Rat Saw God', nb_tracks: 14, artist: { name: 'Wednesday' } }, { id: 8, title: 'Rat Saw God', nb_tracks: 10, artist: { name: 'Wednesday' } }] }
    assert.equal(pickDeezer({ kind: 'album', artist: 'Wednesday', title: 'Rat Saw God', trackCount: 10 }, body), '8')
  })
  it('ISRC and UPC by shape only', () => {
    assert.equal(deezerIsrc({ isrc: 'usum71210785' }), 'USUM71210785')
    assert.equal(deezerIsrc({ isrc: 'nope' }), null)
    assert.equal(deezerUpc({ upc: '0656605155122' }), '0656605155122')
    assert.equal(deezerUpc({ upc: '12-34' }), null)
  })
  it('never more than the limit in any window', () => {
    let t = 0
    const w = createRateWindow(3, 5000, () => t)
    assert.deepEqual([w.wait(), w.wait(), w.wait(), w.wait()], [0, 0, 0, 5000])
    t = 5000
    assert.deepEqual([w.wait(), w.wait(), w.wait()], [0, 0, 5000], 'the fourth is booked at 5000, so only two more fit before 10000')
  })
})

describe('the usage line', () => {
  it('fixed words only: the lane, by id or walk, and why it walked', () => {
    const ev = downloadPathEvent({ lane: 'song', via: 'walk', how: 'isrc', fellBack: 'judge', ok: true, ms: 1234.4 })
    assert.deepEqual(ev, { kind: 'action', name: 'shop.download-path', ms: 1234, ok: true, detail: { lane: 'song', via: 'walk', how: 'isrc', fell: 'judge' } })
  })
})
