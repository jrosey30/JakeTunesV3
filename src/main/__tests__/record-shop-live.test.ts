import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shopSessionFromLive, jobFromQueueItem, selectionFromQueueResult, queueResultForSelection, resolveRequestFor,
  recordingSelectionFromJot, isFixtureId, recommendationIdOf, liveItemId, type QueueItemLike,
} from '../../common/record-shop-live.ts'
import { shopSnapshot } from '../../common/record-shop.ts'
import { shopActions } from '../../common/record-shop-commands.ts'

const ids = { track: (a: string, t: string) => `q|track|${a}|${t}`, album: (a: string, b: string) => `q|album|${a}|${b}` }
const NOW = '2026-09-06T03:00:00.000Z'
const songJot = { id: 'r-song', song: 'Once in a Lifetime', artist: 'Talking Heads', album: 'Remain in Light', createdAt: NOW, source: 'user' as const, previewUrl: 'https://p/once.m4a' }
const albumJot = { id: 'r-album', album: 'Remain in Light', artist: 'Talking Heads', kind: 'album' as const, createdAt: NOW, note: 'from Sam · get into them', source: 'user' as const }
const albumJob: QueueItemLike = {
  key: 'qobuz|album|q|album|talkingheads|remaininlightdeluxeversion', status: 'done', imported: 4, dupes: 8, completion: '12 tracks · 4 imported, 8 already in your library', startedAt: Date.parse(NOW),
  result: { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'q|album|talkingheads|remaininlightdeluxeversion', desc: 'Remain in Light (Deluxe Version) — Talking Heads (album)', artist: 'Talking Heads', album: 'Remain in Light (Deluxe Version)', collectionId: 9990003, trackCount: 12, releaseYear: 1980, origin: { recommendationIds: ['r-album'], entryId: 'r-album', sourceKind: 'person', sourceLabel: 'Sam' } },
}

describe('the live Record Shop session', () => {
  it('ids: live items are the list entry; fixture ids are recognisable and never live', () => {
    assert.equal(liveItemId('abc'), 'legacy-recommendation:abc')
    assert.equal(recommendationIdOf('legacy-recommendation:abc'), 'abc')
    assert.equal(recommendationIdOf('fx:lc-deluxe'), null)
    assert.equal(isFixtureId('fx:lc-deluxe'), true)
    assert.equal(isFixtureId('legacy-recommendation:abc'), false)
  })

  it('a queued album job IS the edition Jake chose, by iTunes id', () => {
    const sel = selectionFromQueueResult(albumJob.result)
    assert.equal(sel?.kind, 'release')
    assert.equal(sel?.revision, 'itunes:collection:9990003')
    assert.equal(sel?.kind === 'release' && sel.request.title, 'Remain in Light (Deluxe Version)')
    assert.equal(sel?.kind === 'release' && sel.request.trackCount, 12)
    const trk = selectionFromQueueResult({ kind: 'query', source: 'qobuz', mediaType: 'track', id: 'x', desc: 'd', artist: 'XTC', title: 'Helicopter', album: 'Drums and Wires', durationMs: 235000 })
    assert.equal(trk?.kind, 'recording')
    assert.equal(trk?.kind === 'recording' && trk.request.durationSec, 235)
    assert.equal(selectionFromQueueResult({ kind: 'id', source: 'qobuz', mediaType: 'album', id: '123', desc: 'raw id' }), undefined)
  })

  it('a scheduler job becomes a shop job: same key, its verdict and completion carried', () => {
    const item = shopSnapshot({ itemId: 'legacy-recommendation:r-album', kind: 'release' as const, display: { title: 'Remain in Light', artist: 'Talking Heads' } })
    const done = jobFromQueueItem(albumJob, item, 'r-album', NOW)
    assert.equal(done.jobId, albumJob.key)
    assert.equal(done.status, 'done')
    assert.deepEqual([...done.recommendationIds], ['r-album'])
    assert.equal(done.result?.completion, '12 tracks · 4 imported, 8 already in your library')
    assert.equal(done.result?.alreadyOwned, 8)
    assert.equal(done.attempt, 1)
    const failed = jobFromQueueItem({ ...albumJob, status: 'failed', attempt: 2, outcome: 'exact-not-found', primary: 'Exact edition not found', detail: 'no edition was the one you picked', alternatives: [{ provider: 'qobuz', desc: 'Remain in Light (8 tracks)', reason: 'has 8 tracks' }] }, item, 'r-album', NOW)
    assert.equal(failed.status, 'failed'); assert.equal(failed.attempt, 2)
    assert.equal(failed.result?.outcome, 'exact-not-found'); assert.equal(failed.result?.alternatives?.length, 1)
    const canceled = jobFromQueueItem({ ...albumJob, status: 'canceled' }, item, 'r-album', NOW)
    assert.equal(canceled.result, undefined)
  })

  it('Get on a selected record mirrors the Download view contract: id by the scheduler builders, collection id, count, year, provenance', () => {
    const sel = selectionFromQueueResult(albumJob.result)!
    const item = shopSnapshot({ itemId: 'legacy-recommendation:r-album', kind: 'release' as const, display: { title: 'x' }, selection: sel })
    const r = queueResultForSelection(item, { recommendationIds: ['r-album'], sourceKind: 'person', sourceLabel: 'Sam' }, ids)!
    assert.equal(r.id, 'q|album|Talking Heads|Remain in Light (Deluxe Version)')
    assert.equal(r.mediaType, 'album'); assert.equal(r.kind, 'query')
    assert.equal(r.collectionId, 9990003); assert.equal(r.trackCount, 12); assert.equal(r.releaseYear, 1980)
    assert.deepEqual(r.origin, { recommendationIds: ['r-album'], sourceKind: 'person', sourceLabel: 'Sam' })
    const song = shopSnapshot({ itemId: 'legacy-recommendation:r-song', kind: 'recording' as const, display: { title: 'x' }, selection: recordingSelectionFromJot(songJot)! })
    const t = queueResultForSelection(song, { recommendationIds: ['r-song'] }, ids)!
    assert.equal(t.mediaType, 'track'); assert.equal(t.id, 'q|track|Talking Heads|Once in a Lifetime'); assert.equal(t.album, 'Remain in Light')
  })

  it('composes the session: a song jot is selected by itself; an unselected record offers the choice; a job selects its record', () => {
    const s = shopSessionFromLive({ recs: [songJot, albumJot], queue: [], resolved: {}, now: NOW })
    assert.equal(s.items.length, 2)
    const song = s.items.find((i) => i.itemId === 'legacy-recommendation:r-song')!
    const album = s.items.find((i) => i.itemId === 'legacy-recommendation:r-album')!
    assert.equal(song.kind, 'recording'); assert.equal(song.kind === 'recording' && song.selection?.revision, 'jot:r-song')
    assert.equal(song.display.preview?.url, 'https://p/once.m4a')
    assert.equal(album.kind, 'release'); assert.equal(album.kind === 'release' && album.selection, undefined)
    assert.deepEqual(shopActions(album, s.ownership[album.itemId], s.jobs[album.itemId], true), { verbs: ['inspectSelection', 'chooseEdition'], getBlocked: 'select-edition' })
    assert.deepEqual(shopActions(song, s.ownership[song.itemId], s.jobs[song.itemId], true), { verbs: ['previewItem', 'inspectSelection', 'getSelection'] })
    assert.equal(s.entries.length, 2); assert.equal(s.recommendations.length, 2)

    const withJob = shopSessionFromLive({ recs: [songJot, albumJot], queue: [albumJob], resolved: {}, now: NOW })
    const a2 = withJob.items.find((i) => i.itemId === 'legacy-recommendation:r-album')!
    assert.equal(a2.kind === 'release' && a2.selection?.revision, 'itunes:collection:9990003')
    assert.equal(withJob.jobs[a2.itemId]?.jobId, albumJob.key)
    assert.equal(withJob.jobs['legacy-recommendation:r-song'], undefined)
  })

  it('ownership attaches only for the item\'s CURRENT selection revision — never a verdict about another edition', () => {
    const own = shopSnapshot({ status: 'partial' as const, selectionRevision: 'itunes:collection:9990003', libraryRevision: 'library@10:9', expected: 12, owned: 8, matches: [{ position: 0, libraryTrackId: 5 }] })
    const resolved = { 'legacy-recommendation:r-album': { forRevision: 'itunes:collection:9990003', ownership: own, selection: undefined, libraryRevision: 'library@10:9', at: 1 } }
    const noJob = shopSessionFromLive({ recs: [albumJot], queue: [], resolved, now: NOW })
    assert.equal(noJob.ownership['legacy-recommendation:r-album'].status, 'unknown')   // nothing selected: no verdict shown
    const withJob = shopSessionFromLive({ recs: [albumJot], queue: [albumJob], resolved, now: NOW })
    assert.equal(withJob.ownership['legacy-recommendation:r-album'].status, 'partial')
    const other = shopSessionFromLive({ recs: [albumJot], queue: [{ ...albumJob, result: { ...albumJob.result, collectionId: 1 } }], resolved, now: NOW })
    assert.equal(other.ownership['legacy-recommendation:r-album'].status, 'unknown')
    // the resolved copy of the SAME selection brings the tracklist for Inspect
    const sel = shopSnapshot({ kind: 'release' as const, revision: 'itunes:collection:9990003', request: { artist: 'Talking Heads', title: 'Remain in Light (Deluxe Version)', baseTitle: 'Remain in Light', packaging: ['deluxe'], versionMarkers: [], trackCount: 12, tracks: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, durationSec: 200 })), explicit: 'unknown' as const, providerIds: { itunesCollectionId: 9990003 } } })
    const full = shopSessionFromLive({ recs: [albumJot], queue: [albumJob], resolved: { 'legacy-recommendation:r-album': { forRevision: 'itunes:collection:9990003', ownership: own, selection: sel, libraryRevision: 'x', at: 1 } }, now: NOW })
    const it = full.items[0]
    assert.equal(it.kind === 'release' && it.selection?.request.tracks.length, 12)
    // a song: main's answer is stamped with the revision it was asked for, so the jot's own identity carries the verdict
    const songOwn = shopSnapshot({ status: 'complete' as const, selectionRevision: 'recording:talkingheads:onceinalifetime:0', libraryRevision: 'l', expected: 1, owned: 1, matches: [{ position: 0, libraryTrackId: 9 }] })
    const songSel = shopSnapshot({ kind: 'recording' as const, revision: 'recording:talkingheads:onceinalifetime:0', request: { artist: 'Talking Heads', title: 'Once in a Lifetime', album: 'Remain in Light', artistNorm: 'talkingheads', titleNorm: 'onceinalifetime', durationSec: 259, durationTolSec: 5, explicit: 'unknown' as const, requestedMarkers: [], providerIds: {} } })
    const withSong = shopSessionFromLive({ recs: [songJot], queue: [], resolved: { 'legacy-recommendation:r-song': { forRevision: 'jot:r-song', ownership: songOwn, selection: songSel, libraryRevision: 'l', at: 1 } }, now: NOW })
    const sg = withSong.items[0]
    assert.equal(withSong.ownership[sg.itemId].status, 'complete')
    assert.equal(withSong.ownership[sg.itemId].status !== 'unknown' && withSong.ownership[sg.itemId].selectionRevision, 'jot:r-song')
    assert.equal(sg.kind === 'recording' && sg.selection?.revision, 'jot:r-song')
    assert.equal(sg.kind === 'recording' && sg.selection?.request.durationSec, 259)
    const stale = shopSessionFromLive({ recs: [songJot], queue: [], resolved: { 'legacy-recommendation:r-song': { forRevision: 'queue:old', ownership: songOwn, libraryRevision: 'l', at: 1 } }, now: NOW })
    assert.equal(stale.ownership[stale.items[0].itemId].status, 'unknown')
  })

  it('two recommenders on one job: both items carry the same job id', () => {
    const jot2 = { ...albumJot, id: 'r-album-2', note: 'from Alex' }
    const job = { ...albumJob, result: { ...albumJob.result, origin: { recommendationIds: ['r-album', 'r-album-2'] } } }
    const s = shopSessionFromLive({ recs: [albumJot, jot2], queue: [job], resolved: {}, now: NOW })
    assert.equal(s.jobs['legacy-recommendation:r-album']?.jobId, job.key)
    assert.equal(s.jobs['legacy-recommendation:r-album-2']?.jobId, job.key)
    assert.deepEqual([...s.jobs['legacy-recommendation:r-album'].recommendationIds], ['r-album', 'r-album-2'])
  })

  it('what main is asked: the chosen edition by id when there is one, the name otherwise, a song by its fields', () => {
    const s = shopSessionFromLive({ recs: [songJot, albumJot], queue: [albumJob], resolved: {}, now: NOW })
    const album = s.items.find((i) => i.itemId === 'legacy-recommendation:r-album')!
    assert.deepEqual(resolveRequestFor(album, albumJot), { kind: 'release', artist: 'Talking Heads', album: 'Remain in Light (Deluxe Version)', collectionId: 9990003, trackCount: 12, releaseYear: 1980 })
    const plain = shopSessionFromLive({ recs: [albumJot], queue: [], resolved: {}, now: NOW }).items[0]
    assert.deepEqual(resolveRequestFor(plain, albumJot), { kind: 'release', artist: 'Talking Heads', album: 'Remain in Light', collectionId: undefined, trackCount: undefined, releaseYear: undefined })
    const song = s.items.find((i) => i.itemId === 'legacy-recommendation:r-song')!
    assert.deepEqual(resolveRequestFor(song, songJot), { kind: 'recording', artist: 'Talking Heads', title: 'Once in a Lifetime', album: 'Remain in Light', durationSec: undefined })
    assert.equal(resolveRequestFor(shopSnapshot({ itemId: 'x', kind: 'artist' as const, display: { title: 'Talking Heads' } }), undefined), null)
  })
})
