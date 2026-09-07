/**
 * Compare editions — the pure comparison. Chocolate Chords (Terry Lee Brown
 * Junior, iTunes 96265705 vs the Bandcamp edition, 2026-09-06) is the
 * regression fixture: 11 of 12 exact, track 4 a runtime mismatch.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRequestedAlbum } from '../album-identity.ts'
import { judgeAlbumTracks, summarizeNearEdition } from '../near-edition.ts'
import { isNearEdition, nearEditionOf } from '../../common/near-edition-detect.ts'
import { downloadsPanelRows } from '../../common/downloads-panel-model.ts'

const ITUNES = [['Straylight', 400], ['The Music', 347], ['Mindless Tides', 409], ['Here We Go', 410], ['If You Open Up', 302], ['Chord Progression', 430], ['Looking Beyond', 423], ['Magic Prison', 354], ['Back to Reception', 344], ["Let's Jazz", 352], ['Dètente', 310], ['Nightshift', 397]] as const
const BANDCAMP = [['Straylight', 400.3], ['The Music', 347.1], ['Mindless Tides', 409.4], ['Here We Go', 483.6], ['If You Open Up', 302.2], ['Chord Progression', 430.0], ['Looking Beyond', 423.5], ['Magic Prison', 354.2], ['Back to Reception', 344.7], ['Let´s Jazz', 352.4], ['Détente', 310.1], ['Nightshift', 397.9]] as const
const req = buildRequestedAlbum({ artist: 'Terry Lee Brown Junior', title: 'Chocolate Chords', trackCount: 12, releaseYear: 1997, collectionId: 96265705, tracks: ITUNES.map(([t, s], i) => ({ title: t, trackNumber: i + 1, durationSec: s })) })
const cand = BANDCAMP.map(([t, s], i) => ({ title: t, trackNumber: i + 1, durationSec: s }))

describe('compare editions — the per-track judge', () => {
  it('Chocolate Chords: 11 of 12 exact, track 4 a runtime mismatch, punctuation and accents fold', () => {
    const rows = judgeAlbumTracks(req, cand)
    assert.equal(rows.length, 12)
    assert.deepEqual(rows.map((r) => r.verdict), ['exact', 'exact', 'exact', 'mismatch', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact'])
    const four = rows[3]
    assert.equal(four.deltaSec, 74)
    assert.equal(four.reason, 'runtime mismatch (8:04 found, 6:50 picked)')
    assert.doesNotMatch(four.reason!, /longer edit|different edit|full-length/i)
    assert.equal(rows[9].verdict, 'exact'); assert.equal(rows[10].verdict, 'exact')
  })
  it('the summary states exact counts and the differing runtimes before any click', () => {
    const s = summarizeNearEdition(judgeAlbumTracks(req, cand), { label: 'iTunes 96265705' }, { label: 'Bandcamp edition', source: 'terryleebrownjunior.bandcamp.com/album/chocolate-chords' })
    assert.equal(s.total, 12); assert.equal(s.exact, 11); assert.equal(s.mismatch, 1); assert.equal(s.unknown, 0)
    assert.deepEqual(s.differing.map((d) => d.n), [4])
    assert.match(s.matchingSentence, /^Acquires 11 of 12 songs, as songs, pinned to the edition you picked \(title, version and runtime\), each verified before import\./)
    assert.match(s.matchingSentence, /Not acquired: 4 “Here We Go” \(6:50\)/)
    // with owned rows the sentence says how many are skipped, and the count to acquire drops
    const rowsOwned = judgeAlbumTracks(req, cand).map((r) => ({ ...r, owned: r.n === 2 || r.n === 7 }))
    const so = summarizeNearEdition(rowsOwned, { label: 'iTunes 96265705' }, { label: 'Bandcamp edition', source: 'z' })
    assert.equal(so.owned, 2); assert.equal(so.toAcquire, 9)
    assert.match(so.matchingSentence, /^Acquires 9 of 12 songs/); assert.match(so.matchingSentence, /2 of the matching tracks are already in your library and are skipped\./)
    assert.match(s.matchingSentence, /Recorded as 11 of 12 of iTunes 96265705 — the record stays incomplete/)
    assert.match(s.editionSentence, /^Acquires all 12 tracks as the Bandcamp edition \(terryleebrownjunior\.bandcamp\.com\/album\/chocolate-chords\), selected by that source and its own tracklist/)
    assert.match(s.editionSentence, /differs from the edition you picked at track 4 \(8:04 vs 6:50\)/)
    assert.match(s.editionSentence, /The edition you picked is not marked as owned\./)
  })
  it('a shorter candidate leaves the tail unknown and never invents matches', () => {
    const rows = judgeAlbumTracks(req, cand.slice(0, 10))
    assert.equal(rows.filter((r) => r.verdict === 'unknown').length, 2)
    assert.equal(summarizeNearEdition(rows, { label: 'x' }, { label: 'y', source: 'z' }).exact, 9)
  })
})

describe('near-edition detection', () => {
  const reason = 'track 4 “Here We Go” runs 8:04; the edition you picked runs 6:50'
  it('a same-count tracklist refusal is a near edition; a count or version refusal is not', () => {
    assert.equal(isNearEdition({ provider: 'bandcamp', desc: 'Chocolate Chords — Terry Lee Brown Junior (12 tracks)', reason }, 12), true)
    assert.equal(isNearEdition({ provider: 'bandcamp', desc: 'Chocolate Chords (9 tracks)', reason: 'has 9 tracks; the edition you picked has 12' }, 12), false)
    assert.equal(isNearEdition({ provider: 'qobuz', desc: 'Chocolate Chords (Live) (12 tracks)', reason: 'is the live version (“Chocolate Chords (Live)”)' }, 12), false)
    assert.equal(isNearEdition({ provider: 'bandcamp', desc: 'x (11 tracks)', reason }, 12), false, 'count from the desc must agree')
    assert.equal(nearEditionOf([{ provider: 'qobuz', desc: 'y (9 tracks)', reason: 'has 9 tracks; the edition you picked has 12' }, { provider: 'bandcamp', desc: 'x (12 tracks)', reason }], 12)?.provider, 'bandcamp')
  })
  it('the Downloads panel offers Compare editions only for a refused album with a near edition', () => {
    const base = { key: 'k', status: 'failed' as const, outcome: 'exact-not-found', primary: 'Exact edition not found', result: { kind: 'query' as const, source: 'qobuz', mediaType: 'album', id: 'q|album|x|y', desc: 'Chocolate Chords — Terry Lee Brown Junior (album)', artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords', collectionId: 96265705, trackCount: 12, releaseYear: 1997 } }
    const near = downloadsPanelRows([{ ...base, alternatives: [{ provider: 'bandcamp', desc: 'Chocolate Chords — Terry Lee Brown Junior (12 tracks)', reason }] }], 0)[0]
    assert.ok(near.actions.includes('nearEdition')); assert.equal(near.nearEdition?.provider, 'bandcamp'); assert.ok(near.actions.includes('chooseEdition'))
    const far = downloadsPanelRows([{ ...base, alternatives: [{ provider: 'qobuz', desc: 'x (9 tracks)', reason: 'has 9 tracks; the edition you picked has 12' }] }], 0)[0]
    assert.ok(!far.actions.includes('nearEdition')); assert.equal(far.nearEdition, null)
  })
  it('the comparison table is read-only: it never imports the queue, the Get path or a prefill', () => {
    const src = readFileSync(join(import.meta.dirname, '../../renderer/components/NearEditionTable.tsx'), 'utf8')
    for (const banned of ['downloadQueue', 'enqueue(', 'startGet', 'jaketunes-download-prefill', 'streamripDownload', 'queueRecoDownload', 'nearEdition.compare']) assert.ok(!src.includes(banned), `table must not reference ${banned}`)
  })
})
