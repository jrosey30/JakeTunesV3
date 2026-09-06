/**
 * Record Shop fixtures — the regression set the structure proposal names,
 * built THROUGH the shared model and adapters so every presentation (the
 * regular shop, Step Inside, the Listen List, Downloads) is fed identical
 * values. Data only; nothing here downloads, previews or writes.
 *
 * Each fixture is a real situation the downloader met on 2026-09-05:
 *   1. XTC "Drums and Wires (Bonus Track Version)" — complete, answered
 *      from the library without a rip.
 *   2. Plain "Drums And Wires" (a library card) — the catalogue only lists
 *      the bonus edition, so the name resolves to nothing: select-edition.
 *   3. Little Creatures (Deluxe Version) — partial: 2 of 12 owned, then
 *      "10 imported, 2 already in your library".
 *   4. Little Creatures (standard, 9) — fully owned after the deluxe.
 *   5. Little Creatures (Live at the BBC) — the live variant, refused.
 *   6. A remix variant of a single — refused as a different recording.
 *   7. An exact edition Qobuz does not carry — structured alternatives.
 *   8. An interrupted import — 5 of 7 landed, reported as incomplete.
 *   9. A song with no preview.
 *  10. One recording recommended by two people.
 *  11. An artist-only jot, and an archived concert — browse-only.
 */
import type { RequestedAlbum, RequestedRecording } from './acquisition-identity.ts'
import {
  saveShopItem, draftShopJob, shopSnapshot,
  type ShopItem, type ShopListEntry, type ShopRecommendation, type ShopOwnership, type ShopAcquisitionJob, type ShopSession, type ShopShelf, type Snapshot, type ShopSelection,
} from './record-shop.ts'
import { shopItemFromFeed, shopItemWithSelection, shopResultFromDownload } from './record-shop-adapters.ts'

const T0 = '2026-09-05T20:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString()

function albumRequest(o: { artist: string; title: string; base: string; packaging: string[]; versionMarkers?: string[]; count: number; tracks: Array<[string, number]>; year: number; collectionId?: number }): RequestedAlbum {
  return {
    artist: o.artist, title: o.title, baseTitle: o.base, packaging: o.packaging, versionMarkers: o.versionMarkers ?? [],
    trackCount: o.count, discCount: 1,
    tracks: o.tracks.map(([title, durationSec], i) => ({ title, durationSec, trackNumber: i + 1, discNumber: 1 })),
    releaseYear: o.year, explicit: 'unknown', providerIds: { itunesCollectionId: o.collectionId },
  }
}
function recordingRequest(o: { artist: string; title: string; album: string; durationSec: number; year?: number; markers?: string[] }): RequestedRecording {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return {
    artist: o.artist, title: o.title, album: o.album, artistNorm: norm(o.artist), titleNorm: norm(o.title),
    durationSec: o.durationSec, durationTolSec: 5, releaseYear: o.year, explicit: 'unknown', requestedMarkers: o.markers ?? [], providerIds: {},
  }
}
const release = (request: RequestedAlbum, revision: string): Extract<ShopSelection, { kind: 'release' }> => ({ kind: 'release', revision, request })
const recording = (request: RequestedRecording, revision: string): Extract<ShopSelection, { kind: 'recording' }> => ({ kind: 'recording', revision, request })

const XTC_BONUS: Array<[string, number]> = [
  ['Making Plans for Nigel', 254], ['Helicopter', 235], ['Day In Day Out', 188], ["When You're Near Me I Have Difficulty", 202], ['Ten Feet Tall', 197],
  ['Roads Girdle the Globe', 291], ['Real By Reel', 227], ['Millions', 339], ['That Is the Way', 177], ['Outside World', 161], ['Scissor Man', 240],
  ['Complicated Game', 305], ['Life Begins at the Hop', 229], ['Chain of Command', 154], ['Limelight', 147],
]
const RIL_DELUXE: Array<[string, number]> = [
  ['Born Under Punches (The Heat Goes On)', 346], ['Crosseyed and Painless', 285], ['The Great Curve', 386], ['Once in a Lifetime', 259],
  ['Houses in Motion', 270], ['Seen and Not Seen', 200], ['Listening Wind', 282], ['The Overload', 360],
  ["Fela's Riff (Unfinished Outtake)", 322], ['Unison (Unfinished Outtake)', 272], ['Double Groove (Unfinished Outtake)', 314], ['Right Start (Unfinished Outtake)', 275],
]
const LC_DELUXE: Array<[string, number]> = [
  ['And She Was', 218], ['Give Me Back My Name', 200], ['Creatures of Love', 254], ["The Lady Don't Mind", 239], ['Perfect World', 267], ['Stay Up Late', 222],
  ['Walk It Down', 283], ['Television Man', 370], ['Road to Nowhere', 259], ['Road to Nowhere (Early Version)', 277], ['And She Was (Early Version)', 216], ['Television Man (Extended Mix)', 473],
]

export type ShopFixtureSession = ShopSession

/** The whole fixture set, frozen. Ids are stable so blurbs, focus and
 *  selection can key on them across presentations. */
export function shopFixtureSession(): ShopFixtureSession {
  const items: ShopItem[] = []
  const recommendations: ShopRecommendation[] = []
  const entries: Snapshot<ShopListEntry>[] = []
  const ownership: Record<string, Snapshot<ShopOwnership>> = {}
  const jobs: Record<string, Snapshot<ShopAcquisitionJob>> = {}
  const LIB = 'library@10477'
  const job = (id: string, item: ShopItem, entryId: string, recIds: string[], status: ShopAcquisitionJob['status'], result?: ShopAcquisitionJob['result'], attempt = 1): void => {
    const entry = saveShopItem({ entryId, savedAt: at(1), item, recommendations: recommendations.filter((r) => r.itemId === item.itemId) })
    const draft = draftShopJob(entry, id, at(2))
    if (!draft.ok) throw new Error(`fixture ${id}: ${draft.reason}`)
    jobs[item.itemId] = shopSnapshot({ ...draft.job, recommendationIds: recIds, status, result, attempt })
  }

  // 1. XTC bonus — owned in full; the shop answers from the library.
  {
    const req = albumRequest({ artist: 'XTC', title: 'Drums and Wires (Bonus Track Version)', base: 'Drums and Wires', packaging: ['bonus'], count: 15, tracks: XTC_BONUS, year: 1979, collectionId: 724621207 })
    const base = shopItemFromFeed({ type: 'album', artist: 'XTC', title: 'Drums and Wires (Bonus Track Version)', why: 'Because you play Talking Heads', lane: 'neighbors', because: 'Talking Heads', artUrl: 'fixture://art/xtc-drums-and-wires' }, { itemId: 'fx:xtc-bonus', recommendationId: 'fx:rec:xtc-bonus', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:724621207'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'complete' as const, selectionRevision: 'itunes:collection:724621207', libraryRevision: LIB, expected: 15, owned: 15, matches: XTC_BONUS.map((_, i) => ({ position: i, libraryTrackId: 11365 + i })) })
    job('fx:job:xtc-bonus', item, 'fx:entry:xtc-bonus', ['fx:rec:xtc-bonus'], 'done', shopResultFromDownload({ ok: true, outcome: 'imported', imported: 0, dupes: 15, expected: 15, missing: 0, completion: '15 tracks · 0 imported, 15 already in your library' }))
    entries.push(saveShopItem({ entryId: 'fx:entry:xtc-bonus', savedAt: at(1), item, recommendations: [base.recommendation] }))
  }
  // 2. Plain "Drums And Wires" — no edition could be pinned by name.
  {
    const base = shopItemFromFeed({ type: 'album', artist: 'XTC', title: 'Drums And Wires', why: 'In your library', lane: 'library', artUrl: 'fixture://art/xtc-drums-and-wires' }, { itemId: 'fx:xtc-plain', recommendationId: 'fx:rec:xtc-plain', receivedAt: at(0) })
    items.push(base.item); recommendations.push(base.recommendation)
    ownership[base.item.itemId] = { status: 'unknown' }
    entries.push(saveShopItem({ entryId: 'fx:entry:xtc-plain', savedAt: at(1), item: base.item, recommendations: [base.recommendation] }))
  }
  // 3. Little Creatures Deluxe — imported: 10 new, 2 were already owned. Complete now.
  {
    const req = albumRequest({ artist: 'Talking Heads', title: 'Little Creatures (Deluxe Version)', base: 'Little Creatures', packaging: ['deluxe'], count: 12, tracks: LC_DELUXE, year: 1985, collectionId: 124906778 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Talking Heads', title: 'Little Creatures (Deluxe Version)', why: 'Because you play XTC', lane: 'neighbors', because: 'XTC', artUrl: 'fixture://art/talking-heads-little-creatures', hookPreviewUrl: 'fixture://preview/and-she-was', hookTitle: 'And She Was' }, { itemId: 'fx:lc-deluxe', recommendationId: 'fx:rec:lc-deluxe', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:124906778'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'complete' as const, selectionRevision: 'itunes:collection:124906778', libraryRevision: LIB, expected: 12, owned: 12, matches: LC_DELUXE.map((_, i) => ({ position: i, libraryTrackId: i === 0 ? 8973 : i === 8 ? 8972 : 11600 + i })) })
    job('fx:job:lc-deluxe', item, 'fx:entry:lc-deluxe', ['fx:rec:lc-deluxe'], 'done', shopResultFromDownload({ ok: true, outcome: 'imported', imported: 10, dupes: 2, expected: 12, missing: 0, completion: '12 tracks · 10 imported, 2 already in your library' }))
    entries.push(saveShopItem({ entryId: 'fx:entry:lc-deluxe', savedAt: at(1), item, recommendations: [base.recommendation], note: 'from Sam' }))
  }
  // 3b. Remain in Light Deluxe — BEFORE import: the 8 originals are owned, the 4 bonus tracks are not. Get imports only the missing four.
  {
    const req = albumRequest({ artist: 'Talking Heads', title: 'Remain in Light (Deluxe Version)', base: 'Remain in Light', packaging: ['deluxe'], count: 12, tracks: RIL_DELUXE, year: 1980, collectionId: 9990003 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Talking Heads', title: 'Remain in Light (Deluxe Version)', why: 'You own the original', lane: 'variants', artUrl: 'fixture://art/talking-heads-remain-in-light' }, { itemId: 'fx:ril-deluxe', recommendationId: 'fx:rec:ril-deluxe', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:9990003'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'partial' as const, selectionRevision: 'itunes:collection:9990003', libraryRevision: LIB, expected: 12, owned: 8, matches: RIL_DELUXE.slice(0, 8).map((_, i) => ({ position: i, libraryTrackId: 11620 + i })) })
    entries.push(saveShopItem({ entryId: 'fx:entry:ril-deluxe', savedAt: at(1), item, recommendations: [base.recommendation] }))
  }
  // 4. Little Creatures standard — fully owned after the deluxe, no rip.
  {
    const req = albumRequest({ artist: 'Talking Heads', title: 'Little Creatures', base: 'Little Creatures', packaging: [], count: 9, tracks: LC_DELUXE.slice(0, 9), year: 1985, collectionId: 302136342 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Talking Heads', title: 'Little Creatures', why: 'Because you play XTC', lane: 'neighbors', artUrl: 'fixture://art/talking-heads-little-creatures' }, { itemId: 'fx:lc-standard', recommendationId: 'fx:rec:lc-standard', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:302136342'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'complete' as const, selectionRevision: 'itunes:collection:302136342', libraryRevision: LIB, expected: 9, owned: 9, matches: LC_DELUXE.slice(0, 9).map((_, i) => ({ position: i, libraryTrackId: 11550 + i })) })
    job('fx:job:lc-standard', item, 'fx:entry:lc-standard', ['fx:rec:lc-standard'], 'done', shopResultFromDownload({ ok: true, outcome: 'imported', imported: 0, dupes: 9, expected: 9, missing: 0, completion: '9 tracks · 0 imported, 9 already in your library' }))
  }
  // 5. The live variant — a different recording of the record, refused.
  {
    const req = albumRequest({ artist: 'Talking Heads', title: 'Little Creatures (Live at the BBC)', base: 'Little Creatures', packaging: [], versionMarkers: ['live'], count: 9, tracks: LC_DELUXE.slice(0, 9).map(([t, d]) => [`${t} (Live)`, d + 30]), year: 1986 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Talking Heads', title: 'Little Creatures (Live at the BBC)', why: 'You starred the studio record', lane: 'variants', artUrl: 'fixture://art/talking-heads-live' }, { itemId: 'fx:lc-live', recommendationId: 'fx:rec:lc-live', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:9990001'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'none' as const, selectionRevision: 'itunes:collection:9990001', libraryRevision: LIB, expected: 9, owned: 0, matches: [] })
    job('fx:job:lc-live', item, 'fx:entry:lc-live', ['fx:rec:lc-live'], 'failed', shopResultFromDownload({ ok: false, outcome: 'exact-not-found', primary: 'Exact edition not found', detail: 'Sources answered for “Little Creatures (Live at the BBC)” — Talking Heads, but no edition was the one you picked, so nothing was imported — not even part of another edition.', alternatives: [{ provider: 'qobuz', desc: 'Little Creatures — Talking Heads (9 tracks, 1985)', reason: 'is not the live version that was asked for' }, { provider: 'qobuz', desc: 'Little Creatures (Deluxe Version) — Talking Heads (12 tracks, 1985)', reason: 'has 12 tracks; the edition you picked has 9' }] }))
  }
  // 6. A remix variant of a single — refused as a different recording.
  {
    const req = recordingRequest({ artist: 'Noah and the Whale', title: '5 Years Time', album: 'Peaceful, the World Lays Me Down', durationSec: 217, year: 2008 })
    const base = shopItemFromFeed({ type: 'song', artist: 'Noah and the Whale', title: '5 Years Time', why: 'Because you play Belle and Sebastian', lane: 'neighbors', artUrl: 'fixture://art/noah-and-the-whale', previewUrl: 'fixture://preview/5-years-time' }, { itemId: 'fx:5-years-time', recommendationId: 'fx:rec:5-years-time', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, recording(req, 'itunes:track:5yt'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = { status: 'unknown' }
    job('fx:job:5-years-time', item, 'fx:entry:5-years-time', ['fx:rec:5-years-time'], 'failed', shopResultFromDownload({ ok: false, outcome: 'exact-not-found', primary: 'Exact version not found', detail: 'Sources answered for “5 Years Time” — Noah and the Whale, but nothing was the recording you picked, so nothing was imported.', alternatives: [{ provider: 'soundcloud', desc: '5 Years Time (TopKnot Remix)', reason: 'is tagged “5 Years Time (TopKnot Remix)” (remix)' }] }))
  }
  // 7. An exact edition no source carries — alternatives, nothing imported.
  {
    const req = albumRequest({ artist: 'Simple Plan', title: 'No Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)', base: 'No Pads, No Helmets...Just Balls', packaging: ['anniversary'], count: 18, tracks: Array.from({ length: 18 }, (_, i) => [`Track ${i + 1}`, 200 + i] as [string, number]), year: 2017 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Simple Plan', title: 'No Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)', why: 'Because you play blink-182', lane: 'neighbors' }, { itemId: 'fx:simple-plan-anniv', recommendationId: 'fx:rec:simple-plan-anniv', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:9990002'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'none' as const, selectionRevision: 'itunes:collection:9990002', libraryRevision: LIB, expected: 18, owned: 0, matches: [] })
    job('fx:job:simple-plan-anniv', item, 'fx:entry:simple-plan-anniv', ['fx:rec:simple-plan-anniv'], 'failed', shopResultFromDownload({ ok: false, outcome: 'exact-not-found', primary: 'Exact edition not found', detail: 'Sources answered, but no edition was the one you picked.', alternatives: [{ provider: 'qobuz', desc: 'No Pads, No Helmets...Just Balls — Simple Plan (12 tracks, 2002)', reason: 'has 12 tracks; the edition you picked has 18' }] }))
  }
  // 8. An interrupted import — the right edition, 5 of 7 landed.
  {
    const req = albumRequest({ artist: 'Joy Again', title: 'Piano', base: 'Piano', packaging: [], count: 7, tracks: [["Abaigh's Song", 165], ['Special Secret Medicine', 140], ["I'm Your Dog", 155], ["Couldn't", 132], ['Disorder', 148], ['Country Song', 170], ['Rats', 121]], year: 2019, collectionId: 1881287719 })
    const base = shopItemFromFeed({ type: 'album', artist: 'Joy Again', title: 'Piano', why: 'Because you play TV Girl', lane: 'neighbors', artUrl: 'fixture://art/joy-again-piano' }, { itemId: 'fx:joy-again-piano', recommendationId: 'fx:rec:joy-again-piano', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, release(req, 'itunes:collection:1881287719'))
    items.push(item); recommendations.push(base.recommendation)
    ownership[item.itemId] = shopSnapshot({ status: 'partial' as const, selectionRevision: 'itunes:collection:1881287719', libraryRevision: LIB, expected: 7, owned: 5, matches: [0, 1, 2, 3, 4].map((p) => ({ position: p, libraryTrackId: 11570 + p })) })
    job('fx:job:joy-again-piano', item, 'fx:entry:joy-again-piano', ['fx:rec:joy-again-piano'], 'failed', shopResultFromDownload({ ok: false, outcome: 'provider-failed', imported: 5, dupes: 0, expected: 7, missing: 2, completion: '7 tracks · 5 imported, 2 missing', primary: 'Album import incomplete', detail: '7 tracks · 5 imported, 2 missing. The tracks already imported are in your library. Retry to import the missing tracks.' }), 2)
  }
  // 9. A song with no preview.
  {
    const req = recordingRequest({ artist: 'XTC', title: 'The Mayor of Simpleton', album: 'Oranges & Lemons', durationSec: 210, year: 1989 })
    const base = shopItemFromFeed({ type: 'song', artist: 'XTC', title: 'The Mayor of Simpleton', why: 'from Alex', lane: 'friends' }, { itemId: 'fx:mayor', recommendationId: 'fx:rec:mayor', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, recording(req, 'itunes:track:mayor'))
    items.push(item); recommendations.push({ ...base.recommendation, source: { kind: 'person', name: 'Alex' }, reason: undefined })
    ownership[item.itemId] = shopSnapshot({ status: 'complete' as const, selectionRevision: 'itunes:track:mayor', libraryRevision: LIB, expected: 1, owned: 1, matches: [{ position: 0, libraryTrackId: 11564 }] })
    job('fx:job:mayor', item, 'fx:entry:mayor', ['fx:rec:mayor'], 'done', shopResultFromDownload({ ok: true, outcome: 'imported', imported: 1, dupes: 0 }))
  }
  // 10. One recording, two recommenders.
  {
    const req = recordingRequest({ artist: 'XTC', title: 'King for a Day', album: 'Oranges & Lemons', durationSec: 226, year: 1989 })
    const base = shopItemFromFeed({ type: 'song', artist: 'XTC', title: 'King for a Day', why: 'from Alex', lane: 'friends', artUrl: 'fixture://art/xtc-oranges-and-lemons', previewUrl: 'fixture://preview/king-for-a-day' }, { itemId: 'fx:king', recommendationId: 'fx:rec:king-alex', receivedAt: at(0) })
    const item = shopItemWithSelection(base.item, recording(req, 'itunes:track:king'))
    items.push(item)
    recommendations.push({ ...base.recommendation, source: { kind: 'person', name: 'Alex' }, reason: undefined })
    recommendations.push({ recommendationId: 'fx:rec:king-sam', itemId: item.itemId, source: { kind: 'person', name: 'Sam' }, receivedAt: at(3) })
    ownership[item.itemId] = { status: 'unknown' }
    job('fx:job:king', item, 'fx:entry:king', ['fx:rec:king-alex', 'fx:rec:king-sam'], 'downloading')
    entries.push(saveShopItem({ entryId: 'fx:entry:king', savedAt: at(1), item, recommendations: recommendations.filter((r) => r.itemId === item.itemId), note: 'from Alex · from Sam' }))
  }
  // 11. An artist-only jot and an archived concert — browse-only.
  {
    const artist = shopItemFromFeed({ type: 'artist', artist: 'Talking Heads', title: 'Talking Heads', why: 'Sam said “get into them”', lane: 'friends' }, { itemId: 'fx:artist-th', recommendationId: 'fx:rec:artist-th', receivedAt: at(0) })
    items.push(artist.item); recommendations.push({ ...artist.recommendation, source: { kind: 'person', name: 'Sam' } })
    ownership[artist.item.itemId] = { status: 'unknown' }
    entries.push(saveShopItem({ entryId: 'fx:entry:artist-th', savedAt: at(1), item: artist.item, recommendations: [artist.recommendation] }))
    const concert: ShopItem = { itemId: 'fx:concert-th-1983', kind: 'concert', externalId: 'archive:TalkingHeads1983-08-23', display: { title: 'Live at the Pantages Theatre, 1983', artist: 'Talking Heads' } }
    items.push(concert)
    ownership[concert.itemId] = { status: 'unknown' }
    entries.push(saveShopItem({ entryId: 'fx:entry:concert', savedAt: at(1), item: concert }))
  }

  const shelves: Snapshot<ShopShelf>[] = [
    shopSnapshot({ shelfId: 'fx:shelf:counter', title: 'At the Counter', itemIds: items.map((i) => i.itemId), recommendationIds: recommendations.map((r) => r.recommendationId), source: { kind: 'unknown' as const }, generatedAt: at(0) }),
  ]
  return { items: items.map((i) => shopSnapshot(i)), entries, recommendations: recommendations.map((r) => shopSnapshot(r)), ownership, jobs, shelves }
}
