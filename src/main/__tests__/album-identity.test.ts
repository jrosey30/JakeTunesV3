import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequestedAlbum, verifyAlbumCandidate, reconcileAlbumCompletion, describeCompletion,
  albumAlternativeDesc, orderTracks, packagingMarkersOf, parseCountTag, matchLibraryOwnership, ladderBudgetMs,
  type CandidateAlbum, type RequestedAlbumTrack,
} from '../album-identity.ts'
import { buildRequestedRecording, verifyCandidate, finalOutcome, describeOutcome, type Alternative } from '../exact-recording.ts'
import { pickItunesCollection } from '../download-search.ts'

// The album-level root cause (2026-09-05): the album path had no identity —
// any multi-file stage was stamped "exact: album rip". XTC's bonus edition
// landed only because the ranker put the 15-track listing first.

// ── Fixtures: nothing XTC-specific is hard-coded in the contract; these are
// just the real editions, as iTunes and Qobuz list them.
const XTC_BONUS: RequestedAlbumTrack[] = [
  ['Making Plans for Nigel', 254], ['Helicopter', 235], ['Day In Day Out', 188], ["When You're Near Me I Have Difficulty", 202],
  ['Ten Feet Tall', 197], ['Roads Girdle the Globe', 291], ['Real By Reel', 227], ['Millions', 339], ['That Is the Way', 177],
  ['Outside World', 161], ['Scissor Man', 240], ['Complicated Game', 305], ['Life Begins at the Hop', 229], ['Chain of Command', 154], ['Limelight', 147],
].map(([title, durationSec], i) => ({ title: title as string, durationSec: durationSec as number, trackNumber: i + 1, discNumber: 1 }))

const qobuzTracks = (rows: RequestedAlbumTrack[], titleCase = (s: string) => s) =>
  rows.map((t) => ({ title: titleCase(t.title), trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSec }))
const qobuzCase = (s: string): string => s.replace(/\b(the|by|at|of|in|and)\b/g, (w) => w[0].toUpperCase() + w.slice(1)).replace("Real By Reel", 'Reel By Reel')

const xtcReq = () => buildRequestedAlbum({ artist: 'XTC', title: 'Drums and Wires (Bonus Track Version)', trackCount: 15, tracks: XTC_BONUS, releaseYear: 1979, collectionId: 724621207 })

describe('the requested-album identity contract', () => {
  it('the request reads the edition off the row Jake clicked', () => {
    const req = xtcReq()
    assert.equal(req.baseTitle, 'Drums and Wires')
    assert.deepEqual(req.packaging, ['bonus'])
    assert.deepEqual(req.versionMarkers, [])
    assert.equal(req.trackCount, 15)
    assert.equal(req.discCount, 1)
    assert.equal(req.providerIds.itunesCollectionId, 724621207)
    assert.deepEqual(packagingMarkersOf('No Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)'), ['anniversary'])
    assert.deepEqual(packagingMarkersOf('Album', 'Deluxe Edition'), ['deluxe'])
    assert.deepEqual(packagingMarkersOf('Album (2001 Remaster)'), [])   // same recordings — not an edition label
    assert.deepEqual(packagingMarkersOf('Drums And Wires'), [])
    assert.deepEqual(parseCountTag('2/15'), { n: 2, of: 15 })
    assert.deepEqual(parseCountTag('7'), { n: 7 })
    assert.deepEqual(parseCountTag(''), {})
  })

  it('XTC: the 12-track standard edition is refused, the 15-track bonus edition is exact even though Qobuz titles it plainly', () => {
    const req = xtcReq()
    const standard: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 12, tracks: qobuzTracks(XTC_BONUS.slice(0, 12), qobuzCase), releaseYear: 1979 }
    const s = verifyAlbumCandidate(req, standard)
    assert.equal(s.verdict, 'reject')
    assert.equal(s.verdict === 'reject' && s.kind, 'track-count')
    assert.match(s.verdict === 'reject' ? s.reason : '', /has 12 tracks; the edition you picked has 15/)
    const bonus: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 15, tracks: qobuzTracks(XTC_BONUS, qobuzCase), releaseYear: 1979 }
    const b = verifyAlbumCandidate(req, bonus)
    assert.equal(b.verdict, 'exact', JSON.stringify(b))
    assert.ok(b.verdict === 'exact' && b.evidence.some((e) => /tracklist 15\/15 in order with runtimes/.test(e)))
    // the broadened query changes nothing here: the same judge sees the same listing
    assert.equal(albumAlternativeDesc(standard), 'Drums And Wires — XTC (12 tracks, 1979)')
  })

  it('XTC: one pre-existing matching track + 14 newly imported = complete', () => {
    const req = xtcReq()
    const staged = qobuzTracks(XTC_BONUS, qobuzCase)
    const c = reconcileAlbumCompletion({
      req, staged,
      imported: staged.slice(1).map((t) => ({ title: t.title })),
      dupes: [{ title: 'Making Plans for Nigel', artist: 'XTC', durationSec: 254 }],
    })
    assert.equal(c.expected, 15)
    assert.equal(c.imported, 14)
    assert.equal(c.credited, 1)
    assert.equal(c.missing, 0)
    assert.ok(c.complete)
    assert.equal(describeCompletion(c), '15 tracks · 14 imported, 1 already in your library')
  })

  it('a library duplicate with a different recording identity is not credited', () => {
    const req = xtcReq()
    const staged = qobuzTracks(XTC_BONUS, qobuzCase)
    const c = reconcileAlbumCompletion({
      req, staged,
      imported: staged.slice(1).map((t) => ({ title: t.title })),
      dupes: [{ title: 'Making Plans for Nigel', artist: 'XTC', durationSec: 312 }],   // a live cut in the library, same name
    })
    assert.equal(c.credited, 0)
    assert.equal(c.uncredited.length, 1)
    assert.match(c.uncredited[0].reason, /runs 5:12, this edition's runs 4:14/)
    assert.equal(c.missing, 1)
    assert.ok(!c.complete)
    const wrongName = reconcileAlbumCompletion({ req, staged, imported: [], dupes: [{ title: 'Making Plans for Nigel (Live)', durationSec: 254 }] })
    assert.equal(wrongName.credited, 0)
  })

  it('deluxe versus standard: counts refuse, labels alone accept only when they agree', () => {
    const tracks = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Bonus A', 'Bonus B', 'Bonus C', 'Bonus D'].map((title, i) => ({ title, trackNumber: i + 1 }))
    const deluxe = buildRequestedAlbum({ artist: 'Band', title: 'Record (Deluxe Edition)', trackCount: 16, tracks })
    const standard = buildRequestedAlbum({ artist: 'Band', title: 'Record', trackCount: 12, tracks: tracks.slice(0, 12) })
    // the standard listing against the deluxe request, and vice versa
    assert.equal(verifyAlbumCandidate(deluxe, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', trackCount: 12 }).verdict, 'reject')
    assert.equal(verifyAlbumCandidate(standard, { provider: 'qobuz', desc: 'Record (Deluxe Edition) by Band', title: 'Record (Deluxe Edition)', artist: 'Band', trackCount: 16 }).verdict, 'reject')
    // deluxe listed with its tracklist under a plain title: proven by contents
    assert.equal(verifyAlbumCandidate(deluxe, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', tracks }).verdict, 'exact')
    // count only, labels agree → exact; count only, labels differ → UNPROVEN, refused
    const agree = verifyAlbumCandidate(deluxe, { provider: 'qobuz', desc: 'Record (Deluxe Edition) by Band', title: 'Record (Deluxe Edition)', artist: 'Band', trackCount: 16 })
    assert.equal(agree.verdict, 'exact')
    const differ = verifyAlbumCandidate(deluxe, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', trackCount: 16 })
    assert.equal(differ.verdict, 'unverifiable')
    assert.match(differ.verdict === 'unverifiable' ? differ.reason : '', /labelled “plain” and you picked “deluxe”/)
    // the plain request accepts the plain 12 without a tracklist
    assert.equal(verifyAlbumCandidate(standard, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', trackCount: 12 }).verdict, 'exact')
  })

  it('anniversary versus original: identical contents pass under either label; a demo swapped in does not', () => {
    const tracks = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'].map((title, i) => ({ title, trackNumber: i + 1, durationSec: 200 + i }))
    const original = buildRequestedAlbum({ artist: 'Band', title: 'Record', trackCount: 10, tracks })
    const anniversary20 = buildRequestedAlbum({ artist: 'Band', title: 'Record (25th Anniversary Edition)', trackCount: 20 })
    // a remaster labelled anniversary with the same 10 recordings IS the record
    assert.equal(verifyAlbumCandidate(original, { provider: 'qobuz', desc: 'Record (25th Anniversary Edition) by Band', title: 'Record (25th Anniversary Edition)', artist: 'Band', tracks: tracks.map((t) => ({ ...t, durationSec: t.durationSec + 2 })) }).verdict, 'exact')
    // the same count with a demo in track 10's place is not
    const demo = verifyAlbumCandidate(original, { provider: 'qobuz', desc: 'Record (25th Anniversary Edition) by Band', title: 'Record (25th Anniversary Edition)', artist: 'Band', tracks: [...tracks.slice(0, 9), { title: 'Kappa (Demo)', trackNumber: 10 }] })
    assert.equal(demo.verdict, 'reject')
    assert.match(demo.verdict === 'reject' ? demo.reason : '', /track 10 is the demo version/)
    // the 20-track anniversary request refuses the 10-track original
    const orig = verifyAlbumCandidate(anniversary20, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', trackCount: 10 })
    assert.equal(orig.verdict, 'reject')
    assert.equal(orig.verdict === 'reject' && orig.kind, 'track-count')
  })

  it('multidisc: catalogue order is disc then track; a track on the wrong disc or a single-disc issue is refused', () => {
    const want: RequestedAlbumTrack[] = [
      { title: 'D1T1', discNumber: 1, trackNumber: 1 }, { title: 'D1T2', discNumber: 1, trackNumber: 2 }, { title: 'D1T3', discNumber: 1, trackNumber: 3 },
      { title: 'D2T1', discNumber: 2, trackNumber: 1 }, { title: 'D2T2', discNumber: 2, trackNumber: 2 }, { title: 'D2T3', discNumber: 2, trackNumber: 3 },
    ]
    const req = buildRequestedAlbum({ artist: 'Band', title: 'Double', tracks: want })
    assert.equal(req.discCount, 2)
    const shuffled = [want[4], want[0], want[5], want[2], want[3], want[1]].map((t) => ({ ...t }))
    assert.deepEqual(orderTracks(shuffled).map((t) => t.title), want.map((t) => t.title))
    assert.equal(verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Double by Band', title: 'Double', artist: 'Band', discCount: 2, tracks: shuffled }).verdict, 'exact')
    const wrongDisc = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Double by Band', title: 'Double', artist: 'Band', discCount: 2, tracks: [...want.slice(0, 3).map((t) => ({ ...t })), { title: 'D2T1', discNumber: 1, trackNumber: 4 }, ...want.slice(4).map((t) => ({ ...t }))] })
    assert.equal(wrongDisc.verdict, 'reject')
    assert.equal(wrongDisc.verdict === 'reject' && wrongDisc.kind, 'disc')
    const singleDisc = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Double by Band', title: 'Double', artist: 'Band', discCount: 1, trackCount: 6 })
    assert.equal(singleDisc.verdict, 'reject')
    assert.match(singleDisc.verdict === 'reject' ? singleDisc.reason : '', /is 1 disc; the edition you picked is 2/)
  })

  it('same track count, different tracklist: refused at the first differing position', () => {
    const want = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((title, i) => ({ title: `Song ${title}`, trackNumber: i + 1 }))
    const req = buildRequestedAlbum({ artist: 'Band', title: 'Record', tracks: want })
    const got = want.map((t) => ({ ...t }))
    got[7] = { title: 'Song Z', trackNumber: 8 }
    const v = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', tracks: got })
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'tracklist')
    assert.match(v.verdict === 'reject' ? v.reason : '', /track 8 is “Song Z”; the edition you picked has “Song H”/)
    // a runtime that says "different recording" is refused too
    const longer = want.map((t) => ({ ...t, durationSec: 180 }))
    const reqTimed = buildRequestedAlbum({ artist: 'Band', title: 'Record', tracks: longer })
    const ext = longer.map((t) => ({ ...t })); ext[2] = { ...ext[2], durationSec: 420 }
    const d = verifyAlbumCandidate(reqTimed, { provider: 'qobuz', desc: 'Record by Band', title: 'Record', artist: 'Band', tracks: ext })
    assert.match(d.verdict === 'reject' ? d.reason : '', /track 3 “Song C” runs 7:00; the edition you picked runs 3:00/)
  })

  it('reordered provider results: the verdict depends on the listing, never on its rank', () => {
    const req = xtcReq()
    const std: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', tracks: qobuzTracks(XTC_BONUS.slice(0, 12), qobuzCase) }
    const bonus: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', tracks: qobuzTracks(XTC_BONUS, qobuzCase) }
    const live: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires (Live) by XTC', title: 'Drums And Wires (Live)', artist: 'XTC', tracks: qobuzTracks(XTC_BONUS, qobuzCase) }
    for (const order of [[std, bonus, live], [live, std, bonus], [bonus, live, std]]) {
      const accepted = order.filter((c) => verifyAlbumCandidate(req, c).verdict === 'exact')
      assert.deepEqual(accepted, [bonus])
    }
    // the provider listing the same tracks out of order but numbered still reads as the edition
    const scrambled = { ...bonus, tracks: [...qobuzTracks(XTC_BONUS, qobuzCase)].reverse() }
    assert.equal(verifyAlbumCandidate(req, scrambled).verdict, 'exact')
    // unnumbered and out of order is a different order — the contract says so
    const unnumbered = { ...bonus, tracks: [...qobuzTracks(XTC_BONUS, qobuzCase)].reverse().map((t) => ({ title: t.title, durationSec: t.durationSec })) }
    assert.equal(verifyAlbumCandidate(req, unnumbered).verdict, 'reject')
  })

  it('partial / incomplete download: a short stage is "incomplete", never a smaller edition, and never imports', () => {
    const req = xtcReq()
    const staged: CandidateAlbum = { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', staged: true, tracks: qobuzTracks(XTC_BONUS.slice(0, 13), qobuzCase) }
    const v = verifyAlbumCandidate(req, staged)
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'incomplete')
    assert.match(v.verdict === 'reject' ? v.reason : '', /only 13 of 15 tracks arrived/)
    // the same short count on a LISTING is a smaller edition
    const listing = verifyAlbumCandidate(req, { ...staged, staged: false })
    assert.equal(listing.verdict === 'reject' && listing.kind, 'track-count')
  })

  it('missing provider track-count metadata: unproven is refused, not guessed', () => {
    const req = xtcReq()
    const bare = verifyAlbumCandidate(req, { provider: 'bandcamp', desc: 'Drums and Wires — XTC (Bandcamp stream)', title: 'Drums and Wires', artist: 'XTC' })
    assert.equal(bare.verdict, 'unverifiable')
    assert.match(bare.verdict === 'unverifiable' ? bare.reason : '', /reports no track count or tracklist/)
    // and a request that knows nothing cannot prove anything either
    const blind = buildRequestedAlbum({ artist: 'XTC', title: 'Drums and Wires' })
    const b = verifyAlbumCandidate(blind, { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 15 })
    assert.equal(b.verdict, 'unverifiable')
    assert.match(b.verdict === 'unverifiable' ? b.reason : '', /no known track count or tracklist/)
    // a provider with tracks but no tracks_count derives the count from the list
    assert.equal(verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', tracks: qobuzTracks(XTC_BONUS, qobuzCase) }).verdict, 'exact')
  })

  it('exact edition unavailable: the verdict carries every judged edition as a structured alternative', () => {
    const req = xtcReq()
    const editions: CandidateAlbum[] = [
      { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 12, releaseYear: 1979 },
      { provider: 'qobuz', desc: 'Drums And Wires (Live at the BBC) by XTC', title: 'Drums And Wires (Live at the BBC)', artist: 'XTC', trackCount: 15, releaseYear: 1980 },
      { provider: 'bandcamp', desc: 'Drums and Wires — XTC (Bandcamp stream)', title: 'Drums and Wires', artist: 'XTC' },
    ]
    const alternatives: Alternative[] = []
    let unverifiable = false
    for (const e of editions) {
      const v = verifyAlbumCandidate(req, e)
      assert.notEqual(v.verdict, 'exact')
      if (v.verdict === 'unverifiable') unverifiable = true
      alternatives.push({ provider: e.provider, desc: albumAlternativeDesc(e), reason: v.reason })
    }
    const outcome = finalOutcome({ alternatives, ripFailure: null, searchFailure: null, anyMatched: true, unverifiable })
    assert.equal(outcome, 'exact-not-found')
    const d = describeOutcome(outcome, { title: 'Drums and Wires (Bonus Track Version)', artist: 'XTC', query: 'XTC Drums and Wires', alternatives, wantAlbum: true })
    assert.equal(d.primary, 'Exact edition not found')
    assert.match(d.detail, /not even part of another edition/)
    assert.match(d.detail, /Drums And Wires — XTC \(12 tracks, 1979\) has 12 tracks; the edition you picked has 15/)
    assert.match(d.detail, /Live at the BBC.*is the live version/)
    assert.match(d.detail, /Bandcamp stream.*reports no track count or tracklist/)
  })

  it('small metadata differences are allowed; a different record, artist or explicitness is not', () => {
    const req = buildRequestedAlbum({ artist: 'The Beatles', title: 'Sgt. Pepper’s Lonely Hearts Club Band', trackCount: 13, explicitSource: true })
    assert.equal(verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'x', title: "Sgt. Pepper's Lonely Hearts Club Band (Remastered)", artist: 'Beatles', trackCount: 13 }).verdict, 'exact')
    assert.equal(verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'x', title: 'Abbey Road', artist: 'The Beatles', trackCount: 13 }).verdict, 'reject')
    assert.equal(verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'x', title: 'Sgt. Pepper’s Lonely Hearts Club Band', artist: 'The Rutles', trackCount: 13 }).verdict, 'reject')
    const clean = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'x', title: 'Sgt. Pepper’s Lonely Hearts Club Band', artist: 'The Beatles', trackCount: 13, parentalWarning: false })
    assert.equal(clean.verdict === 'reject' && clean.kind, 'explicit')
    // a live album Jake asked for by name must be the live one
    const liveReq = buildRequestedAlbum({ artist: 'Band', title: 'Record (Live)', trackCount: 10 })
    assert.equal(verifyAlbumCandidate(liveReq, { provider: 'qobuz', desc: 'x', title: 'Record', artist: 'Band', trackCount: 10 }).verdict, 'reject')
    assert.equal(verifyAlbumCandidate(liveReq, { provider: 'qobuz', desc: 'x', title: 'Record', artist: 'Band', version: 'Live', trackCount: 10 }).verdict, 'exact')
  })

  it('an id-less album row resolves only to an unambiguous matching edition', () => {
    const rows = [
      { collectionId: 1, collectionName: 'Little Creatures', artistName: 'Talking Heads', trackCount: 9 },
      { collectionId: 2, collectionName: 'Little Creatures (Deluxe Version)', artistName: 'Talking Heads', trackCount: 12 },
      { collectionId: 3, collectionName: 'Little Creatures (Live)', artistName: 'Talking Heads', trackCount: 9 },
      { collectionId: 9, collectionName: 'Little Creatures', artistName: 'Someone Else', trackCount: 9 },
    ]
    assert.equal(pickItunesCollection(rows, 'Talking Heads', 'Little Creatures')?.collectionId, 1)
    assert.equal(pickItunesCollection(rows, 'Talking Heads', 'Little Creatures (Deluxe Version)')?.collectionId, 2)
    assert.equal(pickItunesCollection(rows, 'Talking Heads', 'Little Creatures (Deluxe Edition)')?.collectionId, 2)   // same label, different wording
    // A sole bonus listing must not redefine a request for the plain record.
    assert.equal(pickItunesCollection([{ collectionId: 7, collectionName: 'Drums and Wires (Bonus Track Version)', artistName: 'XTC', trackCount: 15 }], 'XTC', 'Drums And Wires'), null)
    assert.equal(pickItunesCollection(rows, 'Talking Heads', 'Remain in Light'), null)
    assert.equal(pickItunesCollection(rows.filter((r) => r.collectionId !== 2), 'Talking Heads', 'Little Creatures (Deluxe Edition)'), null)
    assert.equal(pickItunesCollection([rows[2]], 'Talking Heads', 'Little Creatures'), null)
    assert.equal(pickItunesCollection([{ ...rows[0], artistName: undefined }], 'Talking Heads', 'Little Creatures'), null)
    const ambiguous = [rows[0], { ...rows[0], collectionId: 4, trackCount: 10 }]
    for (const order of [ambiguous, [...ambiguous].reverse()]) {
      assert.equal(pickItunesCollection(order, 'Talking Heads', 'Little Creatures'), null)
    }
    assert.equal(pickItunesCollection([rows[0], rows[0]], 'Talking Heads', 'Little Creatures')?.collectionId, 1)
  })

  it('an import error leaves the album incomplete even after the complete edition was staged', () => {
    const req = xtcReq()
    const staged = qobuzTracks(XTC_BONUS)
    const c = reconcileAlbumCompletion({ req, staged, imported: staged.slice(0, 14), dupes: [] })
    assert.equal(c.complete, false)
    assert.equal(c.missing, 1)
    assert.equal(describeCompletion(c), '15 tracks · 14 imported, 1 missing')
  })

  it('live run 2026-09-05: a reissue stamp on every Qobuz track plus a catalogue typo still reads as the same tracklist', () => {
    const req = xtcReq()   // iTunes spells track 7 "Real By Reel"
    const stamped = qobuzTracks(XTC_BONUS, (t) => `${qobuzCase(t)} (2001 Digital Remaster)`)   // Qobuz: "Reel By Reel (2001 Digital Remaster)"
    const v = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 15, tracks: stamped, releaseYear: 1979 })
    assert.equal(v.verdict, 'exact', JSON.stringify(v))
    // the stamp is packaging; a version marker in the same place is still a different recording
    const live = qobuzTracks(XTC_BONUS, (t) => `${qobuzCase(t)} (Live)`)
    const l = verifyAlbumCandidate(req, { provider: 'qobuz', desc: 'Drums And Wires by XTC', title: 'Drums And Wires', artist: 'XTC', trackCount: 15, tracks: live })
    assert.equal(l.verdict, 'reject')
    assert.match(l.verdict === 'reject' ? l.reason : '', /track 1 is the live version/)
  })

  it('live run 2026-09-05: ownership is decided by recording identity, so a complete album is never re-imported', () => {
    const req = xtcReq()
    // the library's copies: no stamps, exact runtimes (as imported the day before)
    const owned = XTC_BONUS.map((t, i) => ({ id: 11366 + i, title: qobuzCase(t.title), artist: 'XTC', album: 'Drums And Wires', durationSec: t.durationSec }))
    const all = matchLibraryOwnership(req, owned)
    assert.equal(all.ownedCount, 15); assert.deepEqual(all.missing, [])
    // the same decision when the LIBRARY carries the stamps and the request does not
    const stamped = owned.map((t) => ({ ...t, title: `${t.title} (2001 Digital Remaster)` }))
    assert.equal(matchLibraryOwnership(req, stamped).ownedCount, 15)
    // partly owned: two tracks → thirteen to fetch, by index
    const two = matchLibraryOwnership(req, [owned[0], owned[8]])
    assert.equal(two.ownedCount, 2); assert.deepEqual(two.owned.map((o) => o.index), [0, 8]); assert.equal(two.missing.length, 13)
    // same name, different recording: a live cut, a longer take, another artist — none owns the request
    assert.equal(matchLibraryOwnership(req, [{ ...owned[0], title: 'Making Plans for Nigel (Live)' }]).ownedCount, 0)
    assert.equal(matchLibraryOwnership(req, [{ ...owned[0], durationSec: 312 }]).ownedCount, 0)
    assert.equal(matchLibraryOwnership(req, [{ ...owned[0], artist: 'The Rutles' }]).ownedCount, 0)
    // a compilation copy of the same master still counts (individual-track doctrine)
    assert.equal(matchLibraryOwnership(req, [{ ...owned[0], album: 'Fossil Fuel: The XTC Singles 1977-92' }]).ownedCount, 1)
    // a live album Jake asked for is not owned by the studio copies
    const liveReq = buildRequestedAlbum({ artist: 'XTC', title: 'Drums and Wires (Live)', tracks: XTC_BONUS.map((t) => ({ ...t, title: `${t.title} (Live)` })) })
    assert.equal(matchLibraryOwnership(liveReq, owned).ownedCount, 0)
    // one library track satisfies at most one requested track
    const twins = buildRequestedAlbum({ artist: 'Band', title: 'Record', tracks: [{ title: 'Song', trackNumber: 1 }, { title: 'Song', trackNumber: 2 }] })
    assert.equal(matchLibraryOwnership(twins, [{ title: 'Song', artist: 'Band' }]).ownedCount, 1)
  })

  it('an album gets a clock sized to its track count; a track keeps the 12-minute ladder', () => {
    assert.equal(ladderBudgetMs(false, 12), 12 * 60 * 1000)
    assert.equal(ladderBudgetMs(true, 12), 20 * 60 * 1000)      // the Deluxe that gave up at 12 min
    assert.equal(ladderBudgetMs(true, 5), 12 * 60 * 1000)       // never below the ladder floor
    assert.equal(ladderBudgetMs(true, 40), 40 * 60 * 1000)      // capped
    assert.equal(ladderBudgetMs(true, undefined), 25 * 60 * 1000) // unknown size assumes a full album
  })

  it('individual-track behaviour is untouched: a studio master on a compilation is still the track', () => {
    const req = buildRequestedRecording({ artist: 'XTC', title: 'Making Plans for Nigel', album: 'Drums and Wires', durationMs: 254000, durationTolSec: 5 })
    const v = verifyCandidate(req, { provider: 'qobuz', title: 'Making Plans for Nigel', artist: 'XTC', album: 'Fossil Fuel: The XTC Singles 1977-92', durationSec: 254 })
    assert.equal(v.verdict, 'exact')
    assert.equal(v.verdict === 'exact' && v.albumMatches, false)
  })
})
