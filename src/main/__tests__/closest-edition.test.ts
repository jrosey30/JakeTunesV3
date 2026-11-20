/**
 * Brief 257 — Record Shop Phase 4: when the exact edition isn't there.
 * The pure parts: the difference wording, the nearest-edition choice, the
 * partial-album split, the lossy label, the one-week not-found memory and
 * what resets it, and the panel's offers. Then the queue, with main stubbed:
 * the memory answers a new job, a retry asks, and an offer is only ever taken
 * from a tap.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequestedAlbum, type CandidateAlbum } from '../album-identity.ts'
import { askedLabel, chooseEditionOffer, chooseSongsOffer, editionDiff, editionsOfRecord, editionsToCheck, offersFor, pairSongs, type CheckedEdition } from '../closest-edition.ts'
import { differenceWords, lossyNote, offerButton, offerLine, offerTakenEvent, offerTitle, offersToShow, type ShopOffer } from '../../common/closest-edition.ts'
import { NOT_FOUND_CAP, NOT_FOUND_WEEK_MS, forgetNotFound, notFoundKey, noteNotFound, pruneNotFound, rememberable, remembered, rememberedVerdict } from '../../common/not-found-memory.ts'
import { panelRowFor, type PanelQueueItem } from '../../common/downloads-panel-model.ts'
import { albumSaveEvent, type AlbumEdition, type AlbumPreflight } from '../../common/album-preflight.ts'
import { scrubEvent } from '../../common/usage-log.ts'
import { enqueue, getQueue, clearFinished, retry, albumQueryId, trackQueryId, itemForRecommendation, resetQueueForTests, restoreSavedQueue, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { queueAllRecoDownloads, queueRecoDownload, retryRecoDownload, projectRecoStatus } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import { emptyQueueDoc, toSavedJobs, type SavedJob } from '../../common/download-lanes.ts'
import type { Recommendation } from '../../renderer/types.ts'
import { editionOfferJob, offerSongJobs, takeOffer } from '../../renderer/views/DownloadStore/shopOffers.ts'

// ── fixtures ────────────────────────────────────────────────────────────
const NINE = ['Hangover Game', 'Joker Lips', 'Rudolph', 'Wristwatch', 'She’s Leaving You', 'Manning Fireworks', 'Bark at the Moon', 'You Don’t Know the Shape I’m In', 'On My Knees']
const tracks = (titles: string[], secs = 200) => titles.map((title, i) => ({ title, trackNumber: i + 1, discNumber: 1, durationSec: secs + i }))
const reqOf = (title: string, titles: string[], o: { id?: number; explicit?: boolean; clean?: boolean; secs?: number } = {}) => buildRequestedAlbum({
  artist: 'MJ Lenderman', title, trackCount: titles.length, tracks: tracks(titles, o.secs), collectionId: o.id ?? 1, explicitSource: o.explicit, cleanRequested: o.clean,
})
const qobuz = (title: string, titles: string[], o: { parental?: boolean; secs?: number } = {}): CandidateAlbum => ({
  provider: 'qobuz', desc: `${title} by MJ Lenderman`, id: title, title, artist: 'MJ Lenderman', trackCount: titles.length, discCount: 1,
  tracks: tracks(titles, o.secs), ...(o.parental != null ? { parentalWarning: o.parental } : {}),
})
const edition = (id: number, name: string, n: number, o: Partial<AlbumEdition> = {}): AlbumEdition => ({ collectionId: id, name, label: 'Standard', trackCount: n, ...o })
const checked = (e: AlbumEdition, titles: string[], o: { explicit?: boolean; clean?: boolean } = {}): CheckedEdition => ({ edition: e, req: reqOf(e.name, titles, { id: e.collectionId, ...o }) })

describe('the difference, in plain words', () => {
  it('names one or two songs, counts more', () => {
    assert.equal(differenceWords({ missing: ['Rudolph'], added: [], lengths: [] }), 'Without “Rudolph”')
    assert.equal(differenceWords({ missing: ['A', 'B'], added: ['C', 'D', 'E'], lengths: [] }), 'Without “A” and “B” · 3 more songs')
    assert.equal(differenceWords({ missing: ['A', 'B', 'C'], added: ['D'], lengths: [] }), '3 songs missing · adds “D”')
    assert.equal(differenceWords({ missing: [], added: [], lengths: [{ title: 'Rudolph', deltaSec: 40 }] }), '“Rudolph” runs 0:40 longer')
    assert.equal(differenceWords({ missing: [], added: [], lengths: [{ title: 'A', deltaSec: -70 }, { title: 'B', deltaSec: 9 }] }), '2 songs a different length')
  })
  it('a second or two of remaster drift is the same length', () => {
    assert.equal(differenceWords({ missing: [], added: [], lengths: [{ title: 'A', deltaSec: 2 }] }), 'The same songs')
  })
  it('editionDiff pairs songs by title, both ways', () => {
    const d = editionDiff(tracks(NINE), tracks([...NINE.slice(0, 8), 'Bonus Demo', 'Another Demo'], 200))
    assert.deepEqual(d.missing, ['On My Knees'])
    assert.deepEqual(d.added, ['Bonus Demo', 'Another Demo'])
  })
})

describe('the question and the button', () => {
  const std = (n: number, o: Partial<AlbumEdition> = {}): Extract<ShopOffer, { kind: 'edition' }> => ({ kind: 'edition', edition: edition(2, 'X', n, o), diff: { missing: [], added: [], lengths: [] } })
  it('"The Deluxe isn’t on Qobuz. The Standard (11 songs) is."', () => {
    assert.equal(offerLine(std(11), { asked: 'Deluxe', askedCount: 19 }), 'The Deluxe isn’t on Qobuz. The Standard (11 songs) is. Save that?')
    assert.equal(offerButton(std(11), { asked: 'Deluxe' }), 'Save the Standard')
  })
  it('two plain editions are told apart by size', () => {
    assert.equal(offerLine(std(12), { asked: 'Standard', askedCount: 11 }), 'The 11-song edition isn’t on Qobuz. The 12-song edition (12 songs) is. Save that?')
    assert.equal(offerButton(std(12), { asked: 'Standard' }), 'Save the 12-song one')
    assert.equal(offerButton({ ...std(20), edition: edition(2, 'X', 20, { label: 'Deluxe' }) }, { asked: 'Deluxe' }), 'Save the 20-song Deluxe')
  })
  it('a clean edition for an explicit row says clean', () => {
    const o: Extract<ShopOffer, { kind: 'edition' }> = { ...std(14, { label: 'Clean', explicitness: 'cleaned' }), clean: true }
    assert.equal(offerLine(o, { asked: 'Standard', askedCount: 14 }), 'The explicit edition isn’t on Qobuz. The clean edition (14 songs) is. Save that?')
    assert.equal(offerButton(o), 'Save the clean one')
  })
  it('part of an album: "Save the 6 that exist", the rest on the Listen List', () => {
    const o: ShopOffer = { kind: 'songs', have: tracks(NINE.slice(0, 6)), missing: tracks(NINE.slice(6)), owned: 0, of: 9, from: 6 }
    assert.equal(offerLine(o), 'Qobuz has 6 of 9 songs. Save those 6 and keep the other 3 on your Listen List?')
    assert.equal(offerButton(o), 'Save the 6 that exist')
    assert.match(offerTitle(o), /Listen List: “Bark at the Moon”/)
  })
  it('a Bandcamp copy is called lossy before it is taken, and after', () => {
    const o: ShopOffer = { kind: 'bandcamp', url: 'https://x.bandcamp.com/album/y', name: 'Y', band: 'X' }
    assert.match(offerLine(o), /lossy MP3/)
    assert.equal(offerButton(o), 'Save the MP3 (lossy)')
    assert.match(offerTitle(o), /128 kbps MP3/)
    assert.equal(lossyNote('Y — X (Bandcamp)'), 'Lossy MP3 from Bandcamp')
    assert.equal(lossyNote('Y by X (12 tracks)'), null)
  })
  it('one offer per kind, never a songs offer with nothing to save', () => {
    const shown = offersToShow([{ kind: 'songs', have: [], missing: tracks(['a']), owned: 3, of: 4 }, { kind: 'songs-each' }, { kind: 'songs-each' }])
    assert.deepEqual(shown.map((o) => o.kind), ['songs-each'])
  })
})

describe('the nearest edition Qobuz has', () => {
  const deluxe = reqOf('Manning Fireworks (Deluxe)', [...NINE, 'Demo 1', 'Demo 2'], { id: 100 })
  it('the asked label is the packaging word', () => {
    assert.equal(askedLabel(deluxe), 'Deluxe')
    assert.equal(askedLabel(reqOf('Manning Fireworks', NINE)), 'Standard')
  })
  it('offers the Apple edition a Qobuz listing IS, by the identity contract', () => {
    const listings = [qobuz('Manning Fireworks', NINE)]
    const o = chooseEditionOffer(deluxe, listings, [checked(edition(9, 'Manning Fireworks', 9), NINE)])!
    assert.equal(o.edition.collectionId, 9)
    assert.deepEqual(o.diff.missing, ['Demo 1', 'Demo 2'])
    assert.equal(o.clean, undefined)
  })
  it('never an edition no listing verifies, nor the asked one', () => {
    const listings = [qobuz('Manning Fireworks', NINE)]
    // Apple's 9-song tracklist reads differently from Qobuz's: no offer.
    assert.equal(chooseEditionOffer(deluxe, listings, [checked(edition(9, 'Manning Fireworks', 9), [...NINE.slice(0, 8), 'Something Else'])]), null)
    assert.equal(chooseEditionOffer(deluxe, listings, [checked(edition(100, 'Manning Fireworks', 9), NINE)]), null)
  })
  it('the nearest wins: most of the asked songs, then fewest added', () => {
    const asked = reqOf('Manning Fireworks', NINE, { id: 1 })
    const big = [...NINE, 'B1', 'B2', 'B3', 'B4']
    const small = NINE.slice(0, 8)
    const listings = [qobuz('Manning Fireworks', big), qobuz('Manning Fireworks', small)]
    const o = chooseEditionOffer(asked, listings, [checked(edition(3, 'Manning Fireworks (Expanded)', 13), big), checked(edition(4, 'Manning Fireworks', 8), small)])!
    assert.equal(o.edition.collectionId, 3, 'all nine songs beats eight')
  })
  it('an explicit row: the explicit edition over the clean; the clean only alone, and then it says clean', () => {
    const asked = reqOf('Manning Fireworks', NINE, { id: 1, explicit: true })
    const listings = [qobuz('Manning Fireworks', NINE, { parental: false }), qobuz('Manning Fireworks', NINE.slice(0, 8), { parental: true })]
    const cleanE = checked(edition(5, 'Manning Fireworks', 9, { label: 'Clean', explicitness: 'cleaned' }), NINE, { clean: true })
    const explicitE = checked(edition(6, 'Manning Fireworks', 8, { explicitness: 'explicit' }), NINE.slice(0, 8), { explicit: true })
    assert.equal(chooseEditionOffer(asked, listings, [cleanE, explicitE])!.edition.collectionId, 6)
    const alone = chooseEditionOffer(asked, [listings[0]], [cleanE])!
    assert.equal(alone.edition.collectionId, 5)
    assert.equal(alone.clean, true)
  })
  it('an explicit Apple edition is never matched to a Qobuz listing marked clean', () => {
    const asked = reqOf('Manning Fireworks (Deluxe)', [...NINE, 'D'], { id: 1, explicit: true })
    const o = chooseEditionOffer(asked, [qobuz('Manning Fireworks', NINE, { parental: false })], [checked(edition(6, 'Manning Fireworks', 9, { explicitness: 'explicit' }), NINE, { explicit: true })])
    assert.equal(o, null)
  })
  it('only editions the size of a listing of the record are looked up, at most four', () => {
    const asked = reqOf('Manning Fireworks', NINE, { id: 1 })
    const eds = [edition(1, 'Manning Fireworks', 9), edition(2, 'Manning Fireworks (Deluxe)', 13), edition(3, 'Manning Fireworks', 8), edition(4, 'Manning Fireworks (Live)', 8)]
    const got = editionsToCheck(asked, eds, [qobuz('Manning Fireworks', NINE.slice(0, 8)), qobuz('Some Other Record', NINE.slice(0, 3))])
    assert.deepEqual(got.map((e) => e.collectionId), [3, 4])
  })
  it('Apple editions of the record: the artist’s, the title’s, no live record, the clean kept', () => {
    const rows = [
      { collectionId: 1, collectionName: 'Animals', artistName: 'Pink Floyd', trackCount: 5 },
      { collectionId: 2, collectionName: 'Animals (Live)', artistName: 'Pink Floyd', trackCount: 9 },
      { collectionId: 3, collectionName: 'Animals', artistName: 'Tribute Band', trackCount: 5 },
      { collectionId: 4, collectionName: 'Animals', artistName: 'Pink Floyd', trackCount: 5, explicitness: 'cleaned' },
    ]
    assert.deepEqual(editionsOfRecord(rows, 'Pink Floyd', 'Animals').map((e) => e.collectionId), [1, 4])
  })
})

describe('part of an album', () => {
  const asked = reqOf('Manning Fireworks', NINE, { id: 1 })
  it('6 of 9: the six that exist, the three that don’t', () => {
    const o = chooseSongsOffer(asked, [qobuz('Manning Fireworks', NINE.slice(0, 6))])!
    assert.deepEqual(o.have.map((s) => s.title), NINE.slice(0, 6))
    assert.deepEqual(o.missing.map((s) => s.title), NINE.slice(6))
    assert.equal(o.of, 9)
    assert.equal(o.have[0].durationSec, 200, 'pinned to the asked edition’s own length')
  })
  it('songs already in the library are left out of both', () => {
    const o = chooseSongsOffer(asked, [qobuz('Manning Fireworks', NINE.slice(0, 6))], new Set([0, 8]))!
    assert.equal(o.have.length, 5)
    assert.equal(o.missing.length, 2)
    assert.equal(o.owned, 2)
  })
  it('a song of the same title at another length isn’t that song', () => {
    const o = chooseSongsOffer(asked, [qobuz('Manning Fireworks', NINE.slice(0, 6), { secs: 400 })])
    assert.equal(o, null)
  })
  it('an explicit row never takes songs from a listing marked clean', () => {
    const ex = reqOf('Manning Fireworks', NINE, { id: 1, explicit: true })
    assert.equal(chooseSongsOffer(ex, [qobuz('Manning Fireworks', NINE.slice(0, 6), { parental: false })]), null)
  })
  it('a stranger’s record or a live album is never the songs’ source', () => {
    const live = qobuz('Manning Fireworks (Live)', NINE.slice(0, 6))
    const other = { ...qobuz('Manning Fireworks', NINE.slice(0, 6)), artist: 'Somebody Else' }
    assert.equal(chooseSongsOffer(asked, [live, other]), null)
  })
  it('pairSongs is one to one', () => {
    assert.deepEqual(pairSongs([{ title: 'A' }, { title: 'A' }], [{ title: 'A' }]), [0, -1])
  })
})

describe('all the offers for a "no"', () => {
  it('edition, then songs, then the lossy copy', () => {
    const asked = reqOf('Manning Fireworks (Deluxe)', [...NINE, 'Demo'], { id: 1 })
    const listings = [qobuz('Manning Fireworks', NINE)]
    const out = offersFor({ req: asked, listings, checked: [checked(edition(9, 'Manning Fireworks', 9), NINE)], bandcamp: { url: 'u', name: 'n', band: 'b' } })
    assert.deepEqual(out.map((o) => o.kind), ['edition', 'songs', 'bandcamp'])
  })
  it('no songs offer beside an edition that is the very same songs', () => {
    const asked = reqOf('Manning Fireworks (Deluxe)', NINE, { id: 1 })
    const out = offersFor({ req: asked, listings: [qobuz('Manning Fireworks', NINE)], checked: [checked(edition(9, 'Manning Fireworks', 9), NINE)] })
    assert.deepEqual(out.map((o) => o.kind), ['edition'])
  })
})

describe('a song not found anywhere, remembered for a week', () => {
  const song = { mediaType: 'track', artist: 'Zinc Vaccum', title: 'Dollar', album: 'Dollar', durationMs: 201_000 }
  it('the key is the request: another title, artist, album, length or cut is another question', () => {
    const k = notFoundKey(song)
    assert.ok(k)
    assert.equal(notFoundKey({ ...song, title: 'DOLLAR!' }), k, 'spelling noise is the same question')
    for (const change of [{ title: 'Dollars' }, { artist: 'Zinc Vacuum' }, { album: 'Other' }, { durationMs: 230_000 }, { explicitSource: true }]) {
      assert.notEqual(notFoundKey({ ...song, ...change }), k, JSON.stringify(change))
    }
    assert.equal(notFoundKey({ mediaType: 'track', artist: '', title: 'x' }), null)
  })
  it('answers for a week, then asks again', () => {
    const k = notFoundKey(song)
    const mem = noteNotFound({}, k, 'not-found', 1_000)
    assert.ok(remembered(mem, k, 1_000 + NOT_FOUND_WEEK_MS - 1))
    assert.equal(remembered(mem, k, 1_000 + NOT_FOUND_WEEK_MS), null)
    assert.equal(remembered(mem, notFoundKey({ ...song, title: 'Other' }), 2_000), null)
  })
  it('a manual retry forgets it', () => {
    const k = notFoundKey(song)
    assert.equal(remembered(forgetNotFound(noteNotFound({}, k, 'not-found', 1), k), k, 2), null)
  })
  it('only a real answer is remembered', () => {
    assert.equal(rememberable('not-found', 'Nothing resembling it on Qobuz, Bandcamp or SoundCloud.'), true)
    assert.equal(rememberable('exact-not-found', ''), true)
    assert.equal(rememberable('provider-unavailable', ''), false)
    assert.equal(rememberable('provider-failed', ''), false)
    assert.equal(rememberable('canceled', ''), false)
    assert.equal(rememberable('not-found', 'Bandcamp wasn’t searched (HTTP 403), so it may still have this.'), false)
  })
  it('small and pruned: a week, and the newest few hundred', () => {
    let mem = {}
    for (let i = 0; i < NOT_FOUND_CAP + 50; i++) mem = noteNotFound(mem, `k${i}`, 'not-found', 10_000 + i)
    assert.equal(Object.keys(mem).length, NOT_FOUND_CAP)
    assert.ok(!('k0' in mem) && `k${NOT_FOUND_CAP + 49}` in mem)
    assert.equal(Object.keys(pruneNotFound(mem, 10_000 + NOT_FOUND_WEEK_MS + 1000)).length, 0)
  })
  it('the line says when, in plain words', () => {
    const v = rememberedVerdict({ at: 0, outcome: 'not-found' }, 3 * 24 * 3600 * 1000 + 5)
    assert.equal(v.primary, 'Not found 3 days ago')
    assert.match(v.detail, /Retry/)
  })
})

describe('the usage log carries no words', () => {
  it('shop.offer and shop.album-save count kinds, never titles', () => {
    const ev = offerTakenEvent({ kind: 'songs', have: tracks(['Secret Song Title']), missing: [], owned: 0, of: 9 })
    const line = JSON.stringify(scrubEvent({ t: new Date().toISOString(), ...ev }))
    assert.doesNotMatch(line, /Secret Song Title/)
    assert.match(line, /"offer":"songs"/)
    const save = albumSaveEvent({ clickedAt: 0, answeredAt: 5, answer: 'no', why: 'partial', offers: ['edition', 'songs'] })
    assert.equal(save.detail.offer, 'edition+songs')
  })
})

// ── The panel and the queue, main stubbed ───────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const walkCalls: Array<Record<string, unknown>> = []
const listAdds: Array<Record<string, unknown>> = []
const memory = new Map<string, { at: number; outcome: string }>()
const memoryCalls: string[] = []
const preflight = new Map<string, AlbumPreflight>()
const walk = new Map<string, () => Promise<Record<string, unknown>>>()
;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (opts: Record<string, unknown>) => {
      walkCalls.push(opts)
      const w = walk.get(String(opts.title ?? opts.album))
      return w ? w() : { ok: true, imported: 1, dupes: 0 }
    },
    checkQobuzAlbum: async (opts: Record<string, unknown>) => preflight.get(String(opts.album)) ?? { answer: 'found' },
    addRecommendation: async (input: Record<string, unknown>) => { listAdds.push(input); return { ok: true } },
    shopNotFound: {
      check: async (key: string) => { memoryCalls.push(`check ${key}`); return memory.get(key) ?? null },
      note: async (key: string, outcome: string) => { memoryCalls.push(`note ${key}`); memory.set(key, { at: Date.now(), outcome }); return { ok: true } },
      forget: async (key: string) => { memoryCalls.push(`forget ${key}`); memory.delete(key); return { ok: true } },
    },
    usageLog: () => {},
  },
}
const settle = async () => { for (let i = 0; i < 300; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }
const songJob = (title: string, o: Partial<QResult> = {}): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('Zinc Vaccum', title), desc: title, artist: 'Zinc Vaccum', title, ...o })
const albumJob = (name: string, o: Partial<QResult> = {}): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'album', id: albumQueryId('MJ Lenderman', name), desc: name, artist: 'MJ Lenderman', album: name, collectionId: 1, trackCount: 9, surface: 'listen-list', origin: { recommendationIds: ['rec-1'], entryId: 'rec-1', sourceLabel: 'Alex' }, ...o })
const find = (k: string) => getQueue().find((q) => q.key === k)!
/** A quit and a start: the list as saved, brought back by the Phase 5 restore. */
const restart = async (jobs: SavedJob[] = toSavedJobs(getQueue())) => { resetQueueForTests(); await restoreSavedQueue({ ...emptyQueueDoc(), jobs }) }
const recoOf = (id: string, song: string): Recommendation => ({ id, createdAt: '2026-11-20T00:00:00Z', song, artist: 'Zinc Vaccum' })

beforeEach(async () => {
  await settle(); clearFinished()
  walkCalls.length = 0; listAdds.length = 0; memoryCalls.length = 0
  memory.clear(); preflight.clear(); walk.clear()
})

describe('the memory on the scheduler', () => {
  it('a song found nowhere is remembered; a new job for it is answered without a search; Retry asks', async () => {
    walk.set('Dollar', async () => ({ ok: false, outcome: 'not-found', primary: 'Not found', detail: 'Nothing resembling it.' }))
    enqueue(songJob('Dollar'))
    await settle()
    assert.equal(walkCalls.length, 1)
    await sleep(10)
    assert.equal(memory.size, 1, 'remembered')
    // A restart: the failed row is saved and comes back (Phase 5), then a
    // Save from a batch re-arms it. The memory answers; nothing is searched.
    await restart()
    assert.equal(getQueue()[0].status, 'failed', 'the failed row came back')
    enqueue(songJob('Dollar'))
    await settle()
    const it = getQueue()[0]
    assert.equal(walkCalls.length, 1, 'not searched again')
    assert.equal(it.status, 'failed')
    assert.equal(it.primary, 'Not found today')
    const row = panelRowFor(it as PanelQueueItem, Date.now())
    assert.ok(row.actions.includes('retry'), 'Retry is offered')
    // Retry is a manual retry: forgotten and asked.
    retry(it.key)
    await settle()
    assert.equal(walkCalls.length, 2)
    assert.ok(memoryCalls.some((c) => c.startsWith('forget')))
  })
  it('after a restart, Save all answers a failed song from the memory; only the row’s own Retry searches', async () => {
    walk.set('Penny', async () => ({ ok: false, outcome: 'not-found', primary: 'Not found', detail: 'Nothing resembling it.' }))
    const r = recoOf('rec-penny', 'Penny')
    queueRecoDownload(r, { askAgain: true })
    await settle(); await sleep(10)
    assert.equal(walkCalls.length, 1)
    assert.equal(memory.size, 1, 'remembered')
    await restart()
    assert.equal(itemForRecommendation(r.id)?.status, 'failed', 'the failed row came back')
    // The Listen List's Save all: a batch. Asked of the memory, answered from it.
    memoryCalls.length = 0
    assert.equal(queueAllRecoDownloads([r]).queued, 1)
    await settle()
    assert.equal(walkCalls.length, 1, 'no search')
    assert.ok(memoryCalls.some((c) => c.startsWith('check')), 'the memory was asked')
    assert.ok(!memoryCalls.some((c) => c.startsWith('forget')), 'and kept')
    const it = itemForRecommendation(r.id)!
    assert.equal(it.status, 'failed')
    assert.equal(it.fromMemory, true)
    assert.equal(memory.size, 1)
    // The row's own Retry: forgotten and searched.
    retryRecoDownload(r.id)
    await settle()
    assert.equal(walkCalls.length, 2, 'searched')
    assert.ok(memoryCalls.some((c) => c.startsWith('forget')))
  })
  it('a group retry (Retry the N that failed) answers from the memory; a row Retry searches', async () => {
    walk.set('Quarter', async () => ({ ok: false, outcome: 'not-found', primary: 'Not found', detail: 'x' }))
    enqueue(songJob('Quarter'))
    await settle(); await sleep(10)
    assert.equal(walkCalls.length, 1)
    const it = getQueue().find((q) => q.result.title === 'Quarter')!
    memoryCalls.length = 0
    retry(it.key, { askAgain: false })
    await settle()
    assert.equal(walkCalls.length, 1, 'not searched again')
    assert.ok(!memoryCalls.some((c) => c.startsWith('forget')), 'memory kept')
    retry(it.key)
    await settle()
    assert.equal(walkCalls.length, 2, 'a row Retry searches')
  })
  it('the row’s own Save on a failed song searches again', async () => {
    walk.set('Nickel', async () => ({ ok: false, outcome: 'not-found', primary: 'Not found', detail: 'x' }))
    const r = recoOf('rec-nickel', 'Nickel')
    queueRecoDownload(r, { askAgain: true })
    await settle(); await sleep(10)
    await restart()
    queueRecoDownload(r, { askAgain: true })
    await settle()
    assert.equal(walkCalls.length, 2)
  })
  it('a different length is a new question, asked at once', async () => {
    memory.set(notFoundKey({ mediaType: 'track', artist: 'Zinc Vaccum', title: 'Dollar', durationMs: 200_000 })!, { at: Date.now(), outcome: 'not-found' })
    enqueue(songJob('Dollar', { durationMs: 260_000 }))
    await settle()
    assert.equal(walkCalls.length, 1)
  })
  it('provider trouble is never remembered', async () => {
    walk.set('Shaky', async () => ({ ok: false, outcome: 'provider-unavailable', primary: 'Provider unavailable', detail: 'x' }))
    enqueue(songJob('Shaky'))
    await settle(); await sleep(10)
    assert.equal(memory.size, 0)
  })
})

describe('offers on the scheduler: asked, never taken on their own', () => {
  const partial: AlbumPreflight = {
    answer: 'no', why: 'partial', have: 6, of: 9, asked: 'Standard', askedCount: 9,
    offers: [
      { kind: 'edition', edition: edition(9, 'Manning Fireworks (6-Song Edition)', 6, { label: '6-Song Edition' }), diff: { missing: NINE.slice(6), added: [], lengths: [] } },
      { kind: 'songs', have: tracks(NINE.slice(0, 6)), missing: tracks(NINE.slice(6)), owned: 0, of: 9, from: 6 },
    ],
  }
  it('a "no" with offers: nothing downloads until a tap', async () => {
    preflight.set('Manning Fireworks', partial)
    enqueue(albumJob('Manning Fireworks'))
    await settle()
    const key = albumQueryId('MJ Lenderman', 'Manning Fireworks')
    const parent = find(`qobuz|album|${key}`)
    assert.equal(parent.status, 'failed')
    assert.equal(walkCalls.length, 0)
    assert.equal(getQueue().length, 1, 'nothing queued on its own')
    const row = panelRowFor(parent as PanelQueueItem, Date.now())
    assert.deepEqual(row.offers.map((o) => o.kind), ['edition', 'songs'])
    assert.equal(row.offerAsk, 'The 9-song edition isn’t on Qobuz. The 6-Song Edition (6 songs) is. Save that?')
    assert.equal(row.actions[0], 'offer')
  })
  it('"Save the 6 that exist": six song saves under the album, three on the Listen List, the jot untouched', async () => {
    preflight.set('Manning Fireworks', partial)
    enqueue(albumJob('Manning Fireworks'))
    await settle()
    const parent = getQueue()[0]
    const r = await takeOffer(parent.key, partial.offers![1])
    assert.deepEqual(r, { queued: 6, listed: 3 })
    await settle()
    const songs = getQueue().filter((q) => q.result.mediaType === 'track')
    assert.equal(songs.length, 6)
    assert.ok(songs.every((s) => s.result.origin?.group?.parentKey === parent.key && s.result.origin.recommendationIds.length === 0))
    assert.equal(songs[0].result.durationMs, 200_000)
    assert.deepEqual(listAdds.map((a) => a.song), NINE.slice(6))
    assert.ok(listAdds.every((a) => a.kind === 'track' && a.artist === 'MJ Lenderman'))
    assert.equal(panelRowFor(parent as PanelQueueItem, Date.now()).offerTaken, 'Saving the songs that exist')
    // A second tap does nothing.
    assert.deepEqual(await takeOffer(parent.key, partial.offers![1]), { queued: 0, listed: 0 })
  })
  it('the other edition: an ordinary Save album of it, carrying the row', async () => {
    preflight.set('Manning Fireworks', partial)
    enqueue(albumJob('Manning Fireworks'))
    await settle()
    const parent = getQueue()[0]
    const job = editionOfferJob(parent, partial.offers![0] as Extract<ShopOffer, { kind: 'edition' }>, 0)
    assert.equal(job.collectionId, 9)
    assert.equal(job.trackCount, 6)
    assert.notEqual(`${job.source}|${job.mediaType}|${job.id}`, parent.key)
    assert.deepEqual(job.origin?.recommendationIds, ['rec-1'])
  })
  it('an edition named like the refused one still gets its own job', () => {
    const parent = { key: `qobuz|album|${albumQueryId('MJ Lenderman', 'Manning Fireworks')}`, result: albumJob('Manning Fireworks'), status: 'failed' as const }
    const job = editionOfferJob(parent, { kind: 'edition', edition: edition(7, 'Manning Fireworks', 9, { label: 'Clean', explicitness: 'cleaned' }), diff: { missing: [], added: [], lengths: [] }, clean: true }, 0)
    assert.notEqual(`${job.source}|${job.mediaType}|${job.id}`, parent.key)
    assert.equal(job.cleanedSource, true)
  })
  it('the lossy copy: the same album again, allowed Bandcamp, with no preflight', async () => {
    const lossy: AlbumPreflight = { answer: 'no', why: 'not-on-qobuz', offers: [{ kind: 'bandcamp', url: 'https://b.bandcamp.com/album/x', name: 'X', band: 'B' }] }
    preflight.set('Only On Bandcamp', lossy)
    enqueue(albumJob('Only On Bandcamp'))
    await settle()
    assert.equal(walkCalls.length, 0)
    const parent = getQueue()[0]
    await takeOffer(parent.key, lossy.offers![0])
    await settle()
    assert.equal(walkCalls.length, 1, 'the walk ran, unchanged')
    assert.equal(parent.result.lossyOk, true)
  })
  it('an album the walk refused short gets its songs one at a time', () => {
    const q: PanelQueueItem = { key: 'k', status: 'failed', outcome: 'exact-not-found', primary: 'Exact edition not found', detail: 'only 11 of 12 tracks arrived', result: albumJob('Philadelphia', { trackCount: 12 }) }
    const row = panelRowFor(q, 0)
    assert.deepEqual(row.offers, [{ kind: 'songs-each', of: 12 }])
    const gaveUp: PanelQueueItem = { ...q, outcome: 'provider-failed', detail: 'qobuz edition: reject — only 6 of 9 tracks arrived' }
    assert.equal(panelRowFor(gaveUp, 0).offers[0]?.kind, 'songs-each')
    const slow: PanelQueueItem = { ...q, outcome: 'provider-failed', detail: 'The connection was too slow.' }
    assert.equal(panelRowFor(slow, 0).offers.length, 0)
  })
  it('song jobs from an offer fold under the album and carry no jot', () => {
    const parent = { key: 'p', result: albumJob('Manning Fireworks', { explicitSource: true }), status: 'failed' as const }
    const jobs = offerSongJobs(parent, tracks(NINE.slice(0, 2)), { of: 9, notAcquired: tracks(NINE.slice(2, 3)) })
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0].origin?.group?.of, 9)
    assert.equal(jobs[0].origin?.group?.notAcquired[0].reason, 'not on Qobuz')
    assert.equal(jobs[0].origin?.sourceLabel, 'Alex')
    assert.equal(jobs[0].explicitSource, true, 'an explicit row asks for the explicit songs')
  })
})

describe('a clean edition of another size', () => {
  it('names the asked edition and calls the offer clean', () => {
    const o: ShopOffer = { kind: 'edition', edition: edition(2, 'Enter the Wu-Tang (36 Chambers)', 9, { label: 'Clean', explicitness: 'cleaned' }), diff: { missing: [], added: [], lengths: [] }, clean: true }
    assert.equal(offerLine(o, { asked: 'Expanded edition', askedCount: 15 }), 'The Expanded edition isn’t on Qobuz. The clean 9-song edition (9 songs) is. Save that?')
  })
  it('all the songs on an edition of the same size reads "another edition"', () => {
    assert.equal(offerLine({ kind: 'songs', have: tracks(['a', 'b']), missing: [], owned: 0, of: 2, from: 2 }), 'Qobuz has all 2 songs, on another edition. Save those 2?')
  })
})

describe('after a restart the row follows the job Jake queued last', () => {
  it('an interrupted edition job moved to the front still answers for the row, not the refused album', async () => {
    const refused = albumJob('Manning Fireworks')
    const edition = albumJob('Manning Fireworks (6-Song Edition)', { id: albumQueryId('MJ Lenderman', 'Manning Fireworks (6-Song Edition)'), collectionId: 9, trackCount: 6 })
    let release!: () => void
    walk.set('Manning Fireworks (6-Song Edition)', () => new Promise((res) => { release = () => res({ ok: true, imported: 6, dupes: 0 }) }))
    const jobs: SavedJob[] = [
      { key: `qobuz|album|${refused.id}`, result: refused as unknown as SavedJob['result'], status: 'failed', armId: 'arm-a', endedAt: Date.now(), enqueuedAt: Date.now() - 60_000, primary: 'Not on Qobuz' },
      { key: `qobuz|album|${edition.id}`, result: edition as unknown as SavedJob['result'], status: 'downloading', armId: 'arm-b', enqueuedAt: Date.now() - 30_000 },
    ]
    await restart(jobs)
    assert.equal(getQueue()[0].key, `qobuz|album|${edition.id}`, 'the interrupted job is first in the list')
    assert.equal(itemForRecommendation('rec-1')?.key, `qobuz|album|${edition.id}`)
    assert.equal(projectRecoStatus(getQueue(), { id: 'rec-1' }).jobKey, `qobuz|album|${edition.id}`)
    for (let i = 0; i < 100 && !release; i++) await sleep(5)
    release?.()
    await settle()
    assert.equal(projectRecoStatus(getQueue(), { id: 'rec-1' }).state, 'done')
  })
  it('enqueuedAt is saved with the job', () => {
    enqueue(songJob('Saved Clock'))
    const saved = toSavedJobs(getQueue()).find((j) => j.key.endsWith(trackQueryId('Zinc Vaccum', 'Saved Clock')))!
    assert.equal(typeof saved.enqueuedAt, 'number')
  })
})
