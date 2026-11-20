/**
 * Brief 255 — Record Shop Phase 2: albums save in one click, and "no" comes
 * fast. The pure parts: which edition a save takes, the preflight's verdicts
 * (found, not on Qobuz, part of it, another edition, clean only, can't tell),
 * the one plain line the Downloads panel shows, and the usage-log line.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAlbumEditions, editionLabelOf, type ItunesAlbumRow } from '../album-editions.ts'
import { judgeQobuzAlbum, listingCandidate, type PreflightListing } from '../album-preflight.ts'
import { buildRequestedAlbum } from '../album-identity.ts'
import { albumSaveEvent, editionOptionLabel, preflightDetail, preflightLine, preflightVerdict, type AlbumPreflight } from '../../common/album-preflight.ts'
import { scrubEvent } from '../../common/usage-log.ts'

const row = (collectionId: number, collectionName: string, o: Partial<ItunesAlbumRow> = {}): ItunesAlbumRow => ({ collectionId, collectionName, artistName: 'Pink Floyd', trackCount: 5, releaseYear: 1977, ...o })

describe('which edition a one-click save takes', () => {
  it('a plain row takes the plain studio record over the remaster, the deluxe, the live one and the clean edit', () => {
    const rows = [
      row(4, 'Animals (Remastered)', { releaseYear: 2016 }),
      row(3, 'Animals (Deluxe Edition)', { trackCount: 11, releaseYear: 2022 }),
      row(2, 'Animals (Live)', { trackCount: 9 }),
      row(1, 'Animals'),
      row(5, 'Animals (Clean)', { explicitness: 'cleaned' }),
      row(6, 'Animals', { artistName: 'Some Tribute Band' }),
    ]
    const out = chooseAlbumEditions(rows, 'Pink Floyd', 'Animals')
    assert.equal(out.chosenId, 1)
    // the live record isn't an edition of the studio one, nor a clean edit named so, nor a stranger's album
    assert.deepEqual(out.editions.map((e) => e.collectionId).sort(), [1, 3, 4])
    assert.equal(out.editions[0].collectionId, 1, 'the chosen one leads the menu')
  })

  it('the clean edit drops out where Apple also has the explicit one', () => {
    const rows = [
      row(10, 'Life After Death', { artistName: 'The Notorious B.I.G.', explicitness: 'explicit', trackCount: 24 }),
      row(11, 'Life After Death [Amended Version]', { artistName: 'The Notorious B.I.G.', explicitness: 'cleaned', trackCount: 24 }),
    ]
    const out = chooseAlbumEditions(rows, 'The Notorious B.I.G.', 'Life After Death')
    assert.deepEqual(out.editions.map((e) => e.collectionId), [10])
    assert.equal(out.chosenId, 10)
  })

  it('a Deluxe row takes the Deluxe; a row whose labels nothing carries names nothing', () => {
    const rows = [row(1, 'Ants From Up There', { artistName: 'Black Country, New Road', trackCount: 10 }), row(2, 'Ants From Up There (Deluxe)', { artistName: 'Black Country, New Road', trackCount: 19 })]
    assert.equal(chooseAlbumEditions(rows, 'Black Country, New Road', 'Ants From Up There (Deluxe)').chosenId, 2)
    assert.equal(chooseAlbumEditions(rows, 'Black Country, New Road', 'Ants From Up There').chosenId, 1)
    assert.equal(chooseAlbumEditions(rows, 'Black Country, New Road', 'Ants From Up There (Expanded Edition)').chosenId, null)
  })

  it('two plain editions: the name as written, then no remaster stamp, then the earliest', () => {
    const rows = [row(7, 'Damaged (2016 Remaster)', { artistName: 'Black Flag', releaseYear: 2016 }), row(8, 'Damaged', { artistName: 'Black Flag', releaseYear: 1990 }), row(9, 'Damaged', { artistName: 'Black Flag', releaseYear: 1981 })]
    assert.equal(chooseAlbumEditions(rows, 'Black Flag', 'Damaged').chosenId, 9)
    assert.equal(chooseAlbumEditions(rows, 'Black Flag', 'Damaged (2016 Remaster)').chosenId, 7)
  })

  it('labels read as Jake would say them', () => {
    assert.equal(editionLabelOf('Animals'), 'Standard')
    assert.equal(editionLabelOf('Animals (Deluxe Edition)'), 'Deluxe Edition')
    assert.equal(editionLabelOf('Pink Flag (2006 Remastered Version)'), '2006 Remastered Version')
    assert.equal(editionLabelOf('It’s Nearly Over - Single'), 'Standard')
    assert.equal(editionLabelOf('Animals', 'cleaned'), 'Clean')
    assert.equal(editionLabelOf('Animals 50', undefined, 'Animals'), 'Animals 50')
    assert.equal(editionLabelOf('Enter the Wu-Tang (36 Chambers) [Expanded Edition]', undefined, 'Enter the Wu-Tang (36 Chambers)'), 'Expanded Edition')
    const eds = [{ collectionId: 1, name: 'A', label: 'Standard', trackCount: 9, releaseYear: 1993 }, { collectionId: 2, name: 'A', label: 'Standard', trackCount: 13, releaseYear: 2023 }, { collectionId: 3, name: 'A (Deluxe)', label: 'Deluxe', trackCount: 1 }]
    assert.equal(editionOptionLabel(eds[0], eds), 'Standard · 9 songs · 1993')
    assert.equal(editionOptionLabel(eds[2], eds), 'Deluxe · 1 song')
  })

  it('no artist or no title: nothing chosen', () => {
    assert.deepEqual(chooseAlbumEditions([row(1, 'Animals')], '', 'Animals'), { ok: true, editions: [], chosenId: null })
  })
})

// ── The preflight's verdicts ──────────────────────────────────────────────
const nine = ['Manning Fireworks', 'Joker Lips', 'Rudolph', 'Wristwatch', "She's Leaving You", 'Rip Torn', "You Don't Know The Shape I'm In", 'On My Knees', 'Bark At The Moon']
const reqOf = (tracks = nine, o: { title?: string; explicitSource?: boolean } = {}) => buildRequestedAlbum({
  artist: 'MJ Lenderman', title: o.title ?? 'Manning Fireworks', explicitSource: o.explicitSource,
  tracks: tracks.map((t, i) => ({ title: t, trackNumber: i + 1, durationSec: 200 })),
})
const listing = (id: string, title: string, tracks: string[], o: { streamable?: boolean[]; version?: string | null; parental?: boolean; artist?: string } = {}): PreflightListing =>
  listingCandidate({ id, desc: `${title} by ${o.artist ?? 'MJ Lenderman'}` }, {
    title, artist: o.artist ?? 'MJ Lenderman', version: o.version ?? null, tracksCount: tracks.length, parentalWarning: o.parental,
    tracks: tracks.map((t, i) => ({ title: t, trackNumber: i + 1, durationSec: 200, streamable: o.streamable ? o.streamable[i] : true })),
  })

describe('does Qobuz have this edition?', () => {
  it('found: the edition, every song streamable', () => {
    assert.deepEqual(judgeQobuzAlbum(reqOf(), { listings: [listing('a', 'Manning Fireworks', nine)] }), { answer: 'found' })
  })

  it('not on Qobuz: nothing ranked, or only other artists and titles', () => {
    assert.deepEqual(judgeQobuzAlbum(reqOf(), { listings: [] }), { answer: 'no', why: 'not-on-qobuz' })
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('b', 'Manning Fireworks', nine, { artist: 'Someone Else' })] })
    assert.equal(v.answer, 'no'); assert.equal(v.answer === 'no' && v.why, 'not-on-qobuz')
  })

  it('songs Qobuz marks unstreamable are left to the walk, never refused (the walk never reads that flag)', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('a', 'Manning Fireworks', nine, { streamable: [true, true, true, true, true, true, false, false, false] })] })
    assert.deepEqual(v, { answer: 'unknown', why: 'unsure' })
  })

  it('partial: a smaller edition whose every song is on this one', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('a', 'Manning Fireworks', nine.slice(0, 6))] })
    assert.equal(v.answer, 'no')
    assert.equal(v.answer === 'no' && v.why, 'partial')
    assert.equal(v.answer === 'no' && `${v.have}/${v.of}`, '6/9')
    // the refused listing rides along, as the walk's alternatives do
    assert.equal(v.answer === 'no' && v.alternatives?.[0]?.trackCount, 6)
  })

  it('a single of the title track is not part of the album', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('s', 'Manning Fireworks', nine.slice(0, 2))] })
    assert.equal(preflightLine(v), 'Qobuz has a 2-song edition, not this one')
  })

  it('edition differs: only the Deluxe', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('d', 'Manning Fireworks (Deluxe Edition)', [...nine, 'Bonus One', 'Bonus Two'])] })
    assert.equal(preflightLine(v), 'Only the Deluxe is on Qobuz')
    assert.match(preflightDetail(v) || '', /Qobuz has the Deluxe \(11 songs\), not this edition\. Nothing was downloaded\./)
  })

  it('same size as this edition but Apple lists fewer songs: Qobuz has this record, not "only the anniversary"', () => {
    const req = buildRequestedAlbum({ artist: 'MJ Lenderman', title: 'Manning Fireworks', trackCount: 11, tracks: nine.map((t, i) => ({ title: t, trackNumber: i + 1 })) })
    const v = judgeQobuzAlbum(req, { listings: [listing('a', 'Manning Fireworks', [...nine, 'Skit 1', 'Skit 2']), listing('b', 'Manning Fireworks (Anniversary Edition)', [...nine, 'A', 'B', 'C', 'D'])] })
    assert.equal(preflightLine(v), 'Qobuz’s copy differs from this edition')
  })

  it('edition differs: a different count with no label, and a near edition (one song reads differently)', () => {
    const other = [...nine.slice(0, 8), 'Something Else', 'And Another']
    assert.equal(preflightLine(judgeQobuzAlbum(reqOf(), { listings: [listing('x', 'Manning Fireworks', other)] })), 'Qobuz has a 10-song edition, not this one')
    const near = judgeQobuzAlbum(reqOf(), { listings: [listing('n', 'Manning Fireworks', [...nine.slice(0, 8), 'Bark at the Moon (Demo)'])] })
    assert.equal(near.answer === 'no' && near.near, true)
    assert.equal(preflightLine(near), 'Qobuz’s copy differs from this edition')
  })

  it('clean only: an explicit row and nothing but clean copies', () => {
    const v = judgeQobuzAlbum(reqOf(nine, { explicitSource: true }), { listings: [listing('c', 'Manning Fireworks', nine, { parental: false })], explicitSource: true })
    assert.equal(v.answer === 'no' && v.why, 'clean-only')
    assert.equal(preflightLine(v), 'Only the clean edition is on Qobuz')
  })

  it('explicit-first, as the walk: a clean copy is set aside when the explicit one is this edition', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [listing('clean', 'Manning Fireworks', nine.slice(0, 5), { parental: false }), listing('exp', 'Manning Fireworks', nine, { parental: true })] })
    assert.deepEqual(v, { answer: 'found' })
  })

  it('only the first three candidates count, as the walk stages at most three', () => {
    const wrong = (id: string) => listing(id, 'Manning Fireworks', nine.slice(0, 4).concat('X', 'Y', 'Z', 'W', 'V'))
    const v = judgeQobuzAlbum(reqOf(), { listings: [wrong('1'), wrong('2'), wrong('3'), listing('4', 'Manning Fireworks', nine)] })
    assert.equal(v.answer, 'no')
  })

  it('unsure: the walk would reach candidates the listings don’t cover', () => {
    assert.deepEqual(judgeQobuzAlbum(reqOf(), { listings: [listing('1', 'Other', nine)], beyond: true }), { answer: 'unknown', why: 'unsure' })
  })

  it('another version only (a live record) when nothing else ranked', () => {
    const v = judgeQobuzAlbum(reqOf(), { listings: [], rejectedVersions: ['Manning Fireworks (Live) by MJ Lenderman'] })
    assert.equal(preflightLine(v), 'Only the live version is on Qobuz')
  })

  it('a request with no tracklist can’t be refused on one: the walk decides, as before', () => {
    const bare = buildRequestedAlbum({ artist: 'MJ Lenderman', title: 'Manning Fireworks' })
    assert.deepEqual(judgeQobuzAlbum(bare, { listings: [listing('a', 'Manning Fireworks', nine)] }), { answer: 'found' })
  })
})

describe('the panel line and the job verdict', () => {
  it('only a "no" has a line; found and unknown run the walk', () => {
    assert.equal(preflightLine({ answer: 'found' }), null)
    assert.equal(preflightLine({ answer: 'unknown', why: 'timeout' }), null)
    assert.equal(preflightVerdict({ answer: 'unknown', why: 'no-token' }), null)
    assert.equal(preflightVerdict({ answer: 'found' }), null)
  })
  it('lines are plain: no ids, no internal words', () => {
    const cases: AlbumPreflight[] = [
      { answer: 'no', why: 'not-on-qobuz' },
      { answer: 'no', why: 'partial', have: 6, of: 9 },
      { answer: 'no', why: 'partial', have: 0, of: 9 },
      { answer: 'no', why: 'edition-differs', other: 'Deluxe', otherCount: 19 },
      { answer: 'no', why: 'edition-differs', otherCount: 15 },
      { answer: 'no', why: 'edition-differs' },
      { answer: 'no', why: 'clean-only' },
    ]
    assert.deepEqual(cases.map(preflightLine), ['Not on Qobuz', 'Qobuz has 6 of 9 songs', 'Not on Qobuz yet', 'Only the Deluxe is on Qobuz', 'Qobuz has a 15-song edition, not this one', 'Qobuz has a different edition', 'Only the clean edition is on Qobuz'])
    for (const c of cases) {
      const line = `${preflightLine(c)} ${preflightDetail(c)}`
      assert.doesNotMatch(line, /\d{6,}|iTunes|collection|preflight|exact-not-found|outcome|undefined|null/)
    }
  })
  it('the verdict is a refusal the shop already knows: Choose edition, never Retry', () => {
    assert.equal(preflightVerdict({ answer: 'no', why: 'not-on-qobuz' })?.outcome, 'not-found')
    assert.equal(preflightVerdict({ answer: 'no', why: 'partial', have: 1, of: 2 })?.outcome, 'exact-not-found')
    assert.equal(preflightVerdict({ answer: 'no', why: 'edition-differs', other: 'Deluxe' })?.primary, 'Only the Deluxe is on Qobuz')
  })
})

describe('the usage-log line', () => {
  it('click to first answer, fixed words and counts only, nothing dropped as words', () => {
    const ev = albumSaveEvent({ clickedAt: 1000, answeredAt: 4200, answer: 'no', why: 'partial', surface: 'listen-list', edition: 'resolved', have: 6, of: 9 })
    assert.deepEqual(ev, { kind: 'action', name: 'shop.album-save', ms: 3200, ok: false, detail: { answer: 'no', by: 'preflight', why: 'partial', surface: 'listen-list', edition: 'resolved', have: 6, of: 9 } })
    const clean = scrubEvent({ t: new Date(0).toISOString(), ...ev }, 0)
    assert.deepEqual(clean?.detail, ev.detail, 'every key survives the no-words rule')
    assert.equal(albumSaveEvent({ clickedAt: 0, answeredAt: 600000, answer: 'done' }).detail.by, 'walk')
  })
})
