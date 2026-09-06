import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequestedAlbum, verifyAlbumCandidate, matchLibraryOwnership } from '../album-identity.ts'
import { buildRequestedRecording, verifyCandidate } from '../exact-recording.ts'
import { draftShopJob, retryShopJob, saveShopItem, type ShopItem } from '../../common/record-shop.ts'
import { shopEntryFromLegacy, shopItemFromFeed, shopItemWithSelection, shopResultFromDownload } from '../../common/record-shop-adapters.ts'
import { assessShopReleaseOwnership } from '../record-shop-adapters.ts'

const now = '2026-09-05T12:00:00.000Z'
const deluxe = () => buildRequestedAlbum({
  artist: 'Talking Heads', title: 'Little Creatures (Deluxe Version)', collectionId: 124906778,
  trackCount: 12, discCount: 1, tracks: Array.from({ length: 12 }, (_, i) => ({ title: `Track ${i + 1}`, trackNumber: i + 1, discNumber: 1, durationSec: 200 + i })),
})

describe('shared shop handoffs', () => {
  it('feed → selection → save → job preserves the exact edition and attribution, through serialization', () => {
    const feed = shopItemFromFeed({ type: 'album', artist: 'Talking Heads', title: 'Little Creatures', why: 'Because you play art rock', because: 'XTC', lane: 'missing' },
      { itemId: 'item-1', recommendationId: 'rec-1', receivedAt: now })
    assert.deepEqual(draftShopJob(saveShopItem({ entryId: 'list-1', savedAt: now, item: feed.item }), 'job-1', now), { ok: false, reason: 'select-edition' })
    const request = deluxe()
    const item = shopItemWithSelection(feed.item, { kind: 'release', revision: 'selection-1', request })
    const saved = saveShopItem({ entryId: 'list-1', savedAt: now, item, recommendations: [feed.recommendation], note: 'Try the bonus tracks' })
    const draft = draftShopJob(JSON.parse(JSON.stringify(saved)), 'job-1', now)
    assert.ok(draft.ok)
    if (!draft.ok || draft.job.selection.kind !== 'release') throw new Error('Expected release job')
    // JSON omits undefined optional properties; all supplied evidence survives.
    assert.deepEqual(draft.job.selection.request, JSON.parse(JSON.stringify(request)))
    assert.equal(saved.recommendations[0].reason, 'Because you play art rock')
    assert.equal(saved.recommendations[0].becauseArtist, 'XTC')
    assert.deepEqual(draft.job.recommendationIds, ['rec-1'])
    assert.equal(saved.note, 'Try the bonus tracks')
    const standard = verifyAlbumCandidate(structuredClone(draft.job.selection.request), {
      provider: 'qobuz', desc: 'standard', title: 'Little Creatures', artist: 'Talking Heads', trackCount: 9,
    })
    assert.equal(standard.verdict, 'reject')
  })

  it('later display/enrichment mutations cannot rewrite saved tracklists or job identities', () => {
    const request = deluxe()
    const item = shopItemWithSelection({ itemId: 'i', kind: 'release', display: { title: 'Little Creatures' } }, { kind: 'release', revision: 'r1', request })
    const saved = saveShopItem({ entryId: 's', savedAt: now, item })
    request.tracks[0].title = 'Wrong track'
    item.display.title = 'Standard edition'
    if (item.kind === 'release' && item.selection) item.selection.request.trackCount = 9
    const job = draftShopJob(saved, 'j', now)
    assert.ok(job.ok)
    if (!job.ok || job.job.selection.kind !== 'release') throw new Error('Expected release job')
    assert.equal(job.job.selection.request.trackCount, 12)
    assert.equal(job.job.selection.request.tracks[0].title, 'Track 1')
    assert.ok(Object.isFrozen(saved.item.selection))
    assert.ok(Object.isFrozen(job.job.selection.request.tracks[0]))
    assert.equal(saved.item.display.title, 'Little Creatures')
  })

  it('a plain XTC legacy jot remains unresolved even when marked owned', () => {
    const entry = shopEntryFromLegacy({ id: 'existing-uuid', artist: 'XTC', album: 'Drums And Wires', createdAt: now, kind: 'album', owned: true, ownedVia: 'sweep' })
    assert.equal(entry.entryId, 'existing-uuid')
    assert.equal(entry.legacyFulfillment?.owned, true)
    assert.equal(entry.recommendations[0].source.kind, 'unknown')
    assert.deepEqual(draftShopJob(entry, 'j', now), { ok: false, reason: 'select-edition' })
  })

  it('track variants, explicitness, runtime and provider ids survive without a new matcher', () => {
    const request = buildRequestedRecording({ artist: 'Noah and the Whale', title: '5 Years Time', album: 'Peaceful, the World Lays Me Down', durationMs: 187000, durationTolSec: 5, explicitSource: true, itunesTrackId: 123, isrc: 'fixture-isrc' })
    const item = shopItemWithSelection({ itemId: 'song', kind: 'recording', display: { title: '5 Years Time' } }, { kind: 'recording', revision: 'v1', request })
    const draft = draftShopJob(saveShopItem({ entryId: 's', savedAt: now, item }), 'j', now)
    if (!draft.ok || draft.job.selection.kind !== 'recording') throw new Error('Expected recording job')
    assert.deepEqual(draft.job.selection.request, request)
    assert.equal(verifyCandidate(structuredClone(draft.job.selection.request), { provider: 'soundcloud', artist: request.artist, title: '5 Years Time (Remix)', durationSec: 357 }).verdict, 'reject')
  })

  it('artist, note and concert saves stay browse-only and retain legacy data', () => {
    for (const rec of [
      { id: 'a', artist: 'XTC' }, { id: 'n', note: 'from Alex · try this' },
      { id: 'c', kind: 'concert' as const, album: 'Live 1979', externalId: 'archive-item' },
    ]) {
      const saved = shopEntryFromLegacy({ ...rec, createdAt: now })
      assert.deepEqual(draftShopJob(saved, 'j', now), { ok: false, reason: 'browse-only' })
      if (saved.item.kind === 'concert') assert.equal(saved.item.externalId, 'archive-item')
      if (rec.id === 'n') assert.equal(saved.note, rec.note)
    }
  })

  it('two people can recommend one selected item without losing either source', () => {
    const item: ShopItem = { itemId: 'i', kind: 'release', display: { title: 'Little Creatures' }, selection: { kind: 'release', revision: 's1', request: deluxe() } }
    const saved = saveShopItem({ entryId: 'list', savedAt: now, item, recommendations: ['Alex', 'Sam'].map((name) => ({ recommendationId: `rec-${name}`, itemId: 'i', receivedAt: now, source: { kind: 'person', name } })) })
    const draft = draftShopJob(saved, 'j', now)
    assert.ok(draft.ok)
    if (draft.ok) assert.deepEqual(draft.job.recommendationIds, ['rec-Alex', 'rec-Sam'])
    assert.deepEqual(saved.recommendations.map((r) => r.source.name), ['Alex', 'Sam'])
    assert.throws(() => saveShopItem({ entryId: 'wrong', savedAt: now, item, recommendations: [{ recommendationId: 'r', itemId: 'other', receivedAt: now, source: { kind: 'user' } }] }), /another item/)
  })

  it('an album hook preview is distinct from a song and missing preview is allowed', () => {
    const card = { type: 'album' as const, artist: 'XTC', title: 'Drums and Wires', why: '', lane: 'missing', previewUrl: 'https://example.test/not-an-album-preview', hookPreviewUrl: 'https://example.test/hook', hookTitle: 'Making Plans for Nigel' }
    const ids = { itemId: 'i', recommendationId: 'r', receivedAt: now }
    assert.deepEqual(shopItemFromFeed(card, ids).item.display.preview, { url: card.hookPreviewUrl, trackTitle: card.hookTitle })
    assert.equal(shopItemFromFeed({ ...card, hookTitle: undefined }, ids).item.display.preview, undefined)
  })

  it('retry keeps the exact selection and sources, clears the prior outcome and refuses active jobs', () => {
    const saved = saveShopItem({ entryId: 's', savedAt: now, item: shopItemWithSelection({ itemId: 'i', kind: 'release', display: { title: 'Little Creatures' } }, { kind: 'release', revision: 's1', request: deluxe() }) })
    const draft = draftShopJob(saved, 'j', now)
    if (!draft.ok) throw new Error('Expected job')
    assert.throws(() => retryShopJob(draft.job, now), /Only failed or canceled/)
    const retried = retryShopJob({ ...draft.job, status: 'failed', result: { ok: false, outcome: 'provider-failed' } }, '2026-09-06T12:00:00Z')
    assert.deepEqual(retried.selection, draft.job.selection)
    assert.equal(retried.attempt, 2)
    assert.equal(retried.status, 'queued')
    assert.equal(retried.result, undefined)
    assert.equal(retried.entryId, 's')
  })

  it('owned and partial album results preserve track counts separately from a job count', () => {
    assert.deepEqual(shopResultFromDownload({ ok: true, imported: 0, dupes: 15, completion: '15 tracks · 0 imported, 15 already in your library' }).alreadyOwned, 15)
    const partial = shopResultFromDownload({ ok: false, imported: 10, dupes: 1, missing: 1, expected: 12, primary: 'Album import incomplete', detail: '1 missing', outcome: 'provider-failed' })
    assert.equal(partial.ok, false)
    assert.equal(partial.missing, 1)
    assert.equal(partial.detail, '1 missing')
    assert.equal(shopResultFromDownload({ ok: true }).expected, undefined)
    const alternatives = [{ provider: 'qobuz' as const, desc: 'Standard', reason: '9 tracks, expected 12' }]
    const failure = shopResultFromDownload({ ok: false, outcome: 'exact-not-found', alternatives })
    alternatives[0].reason = 'changed'
    assert.equal(failure.alternatives?.[0].reason, '9 tracks, expected 12')
  })

  it('the same ownership contract assesses a saved selection after the handoff', () => {
    const request = deluxe()
    const library = request.tracks.slice(0, 2).map((t, i) => ({ id: i + 1, title: t.title, artist: request.artist, durationSec: t.durationSec }))
    const direct = matchLibraryOwnership(request, library)
    const item = shopItemWithSelection({ itemId: 'i', kind: 'release', display: { title: request.title } }, { kind: 'release', revision: 'r', request })
    const draft = draftShopJob(saveShopItem({ entryId: 's', savedAt: now, item }), 'j', now)
    if (!draft.ok || draft.job.selection.kind !== 'release') throw new Error('Expected album')
    assert.deepEqual(matchLibraryOwnership(structuredClone(draft.job.selection.request), library), direct)
    const assessment = assessShopReleaseOwnership(draft.job.selection, library, 'library-1')
    assert.equal(assessment.status, 'partial')
    if (assessment.status === 'unknown') throw new Error('Expected known ownership')
    assert.equal(assessment.owned, 2)
    assert.equal(assessment.expected, 12)
    assert.deepEqual(assessment.matches, [{ position: 0, libraryTrackId: 1 }, { position: 1, libraryTrackId: 2 }])
    assert.equal(assessment.libraryRevision, 'library-1')
    assert.equal(assessShopReleaseOwnership(draft.job.selection, [], 'library-2').status, 'none')
    const all = request.tracks.map((t, i) => ({ id: i + 1, title: t.title, artist: request.artist, durationSec: t.durationSec }))
    assert.equal(assessShopReleaseOwnership(draft.job.selection, all, 'library-3').status, 'complete')
  })

  it('missing tracklists and library ids never become fully-owned claims', () => {
    const request = deluxe()
    const selection = { kind: 'release' as const, revision: 's1', request }
    assert.equal(assessShopReleaseOwnership({ ...selection, request: { ...request, tracks: [] } }, [], 'v1').status, 'unknown')
    assert.equal(assessShopReleaseOwnership(selection, [{ title: 'Track 1', artist: request.artist, durationSec: 200 }], 'v1').status, 'unknown')
  })
})
