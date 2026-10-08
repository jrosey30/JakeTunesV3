import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequestedRecording, verifyCandidate, finalOutcome, describeOutcome, type CandidateEvidence } from '../exact-recording.ts'
import { rankSoundcloudCandidates, requestedVersionMarkers, unwantedVersionOf, searchTitle, isNoResultsMessage } from '../streamrip-match.ts'

// The regression that started 6.0 Phase 1: Jake picked the regular album
// version of "5 Years Time" by Noah and the Whale (3:37 on iTunes) and the
// SoundCloud lane imported "5 Years Time (TopKnot Remix)" — twice.
const fiveYears = () => buildRequestedRecording({
  artist: 'Noah and the Whale', title: '5 Years Time', album: 'Peaceful, the World Lays Me Down',
  durationMs: 217_000, durationTolSec: 5,
})
const sc = (ev: Partial<CandidateEvidence>): CandidateEvidence => ({ provider: 'soundcloud', ...ev })
const qz = (ev: Partial<CandidateEvidence>): CandidateEvidence => ({ provider: 'qobuz', ...ev })

describe('the requested-recording identity contract', () => {
  it('a plain title is a positive request for the studio recording — no markers requested', () => {
    assert.deepEqual(fiveYears().requestedMarkers, [])
    assert.equal(fiveYears().explicit, 'unknown')
    assert.equal(fiveYears().durationSec, 217)
  })

  it('5 Years Time: the SoundCloud remix is refused on its title tag even when its runtime happens to fit', () => {
    const v = verifyCandidate(fiveYears(), sc({ desc: '5 Years Time (TopKnot Remix) by TopKnot', title: '5 Years Time (TopKnot Remix)', artist: 'TopKnot', durationSec: 218 }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'version')
  })

  it('5 Years Time: the remix is refused on runtime when the title is clean', () => {
    const v = verifyCandidate(fiveYears(), sc({ desc: '5 Years Time by Noah and the Whale', title: '5 Years Time', artist: 'Noah and the Whale', durationSec: 357 }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'duration')
  })

  it('5 Years Time: the real upload passes with title + artist + runtime as witnesses', () => {
    const v = verifyCandidate(fiveYears(), sc({ desc: 'Noah And The Whale - 5 Years Time by Noah and the Whale', title: '5 Years Time', artist: 'Noah and the Whale', durationSec: 216 }))
    assert.equal(v.verdict, 'exact')
    assert.ok(v.verdict === 'exact' && v.evidence.length === 3)
  })

  it('SoundCloud: a label as the artist tag is fine when the artist is in the title', () => {
    const req = buildRequestedRecording({ artist: 'Villanova', title: 'Mr Vibe', durationMs: 0, durationTolSec: 5 })
    const v = verifyCandidate(req, sc({ desc: 'Villanova - Mr Vibe [Indie House Records] by Indie House Records', title: 'Villanova - Mr Vibe', artist: 'Indie House Records', durationSec: 300 }))
    assert.equal(v.verdict, 'exact')
  })

  it('SoundCloud: an upload that names neither the artist in its tag nor its title is refused', () => {
    const req = buildRequestedRecording({ artist: 'Villanova', title: 'Mr Vibe', durationMs: 0, durationTolSec: 5 })
    const v = verifyCandidate(req, sc({ desc: 'Mr Vibe by DJ Somebody', title: 'Mr Vibe', artist: 'DJ Somebody', durationSec: 300 }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'artist')
  })

  for (const [label, got] of [
    ['live', 'Hallelujah (Live)'], ['acoustic', 'Hallelujah (Acoustic)'], ['remix', 'Hallelujah (Club Remix)'],
    ['edit', 'Hallelujah (Radio Edit)'], ['cover', 'Hallelujah (Cover)'], ['instrumental', 'Hallelujah (Instrumental)'],
    ['demo', 'Hallelujah (Demo)'], ['karaoke', 'Hallelujah (Karaoke Version)'], ['sped up', 'Hallelujah (Sped Up)'],
    ['slowed', 'Hallelujah (Slowed + Reverb)'], ['extended mix', 'Hallelujah (Extended Mix)'], ['mashup', 'Hallelujah (Mashup)'],
    ['alternate take', 'Hallelujah (Alternate Take)'], ['rehearsal', 'Hallelujah (Rehearsal)'], ['a cappella', 'Hallelujah (Acapella)'],
    ['nightcore', 'Hallelujah (Nightcore)'], ['session', 'Hallelujah (BBC Session)'], ['concert', 'Hallelujah (In Concert)'],
  ] as const) {
    it(`original vs ${label}: the ${label} candidate is refused`, () => {
      const req = buildRequestedRecording({ artist: 'Jeff Buckley', title: 'Hallelujah', durationMs: 414_000, durationTolSec: 5 })
      const v = verifyCandidate(req, qz({ title: got, artist: 'Jeff Buckley', durationSec: 414 }))
      assert.equal(v.verdict, 'reject', got)
    })
  }

  it('an explicitly requested alternate version is honored', () => {
    const req = buildRequestedRecording({ artist: 'Jeff Buckley', title: 'Hallelujah (Live)', durationMs: 0, durationTolSec: 5 })
    assert.deepEqual(req.requestedMarkers, ['live'])
    const v = verifyCandidate(req, qz({ title: 'Hallelujah (Live)', artist: 'Jeff Buckley', durationSec: 450 }))
    assert.equal(v.verdict, 'exact')
    // …and the studio cut is no longer the exact recording for that request.
    const studio = verifyCandidate(req, qz({ title: 'Hallelujah', artist: 'Jeff Buckley', durationSec: 414 }))
    assert.equal(studio.verdict, 'reject')
  })

  it('a remaster is the same recording', () => {
    const req = buildRequestedRecording({ artist: 'Fleetwood Mac', title: 'Dreams', durationMs: 257_000, durationTolSec: 5 })
    const v = verifyCandidate(req, qz({ title: 'Dreams (2004 Remaster)', album: 'Rumours (Deluxe Edition)', artist: 'Fleetwood Mac', durationSec: 257 }))
    assert.equal(v.verdict, 'exact')
  })

  it('"(Original Mix)" is the recording, not a mix of it', () => {
    assert.equal(unwantedVersionOf('Body Funk', 'Body Funk (Original Mix)'), null)
    assert.equal(unwantedVersionOf('Body Funk', 'Body Funk (Extended Mix)'), 'extended')
  })

  it('missing duration still verifies on tags; missing duration AND missing tags is unverifiable, never imported', () => {
    const req = buildRequestedRecording({ artist: 'Noah and the Whale', title: '5 Years Time', durationMs: 0, durationTolSec: 5 })
    const byTags = verifyCandidate(req, sc({ title: '5 Years Time', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(byTags.verdict, 'exact')
    const remixByTags = verifyCandidate(req, sc({ title: '5 Years Time (TopKnot Remix)', artist: 'TopKnot', durationSec: 357 }))
    assert.equal(remixByTags.verdict, 'reject')
    const nothing = verifyCandidate(req, sc({ title: '', artist: '', durationSec: null }))
    assert.equal(nothing.verdict, 'unverifiable')
    assert.equal(finalOutcome({ alternatives: [], ripFailure: null, searchFailure: null, anyMatched: true, unverifiable: true }), 'unverifiable')
  })

  it('incomplete tags: a runtime match alone is a witness', () => {
    const v = verifyCandidate(fiveYears(), qz({ title: '', album: '', artist: '', durationSec: 216 }))
    assert.equal(v.verdict, 'exact')
  })

  it('same title, different artist is a different song', () => {
    const req = buildRequestedRecording({ artist: 'Daft Punk', title: 'Around the World', durationMs: 0, durationTolSec: 5 })
    const v = verifyCandidate(req, qz({ title: 'Around the World', artist: 'Kings of Leon', durationSec: 250 }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'artist')
  })

  it('a different album with the same master is exact but flagged off-album; a live album is refused', () => {
    const v = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album: 'Indie Anthems 2008', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(v.verdict, 'exact')
    assert.equal(v.verdict === 'exact' && v.albumMatches, false)
    const live = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album: 'Live at Glastonbury', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(live.verdict, 'reject')
    const show = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album: 'Later… with Jools Holland', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(show.verdict, 'reject')
    assert.equal(show.verdict === 'reject' && show.kind, 'brand')
  })

  it('explicit selected, provider says clean → refused; a clean pick accepts a clean file', () => {
    const req = buildRequestedRecording({ artist: 'Future', title: 'Mask Off', durationMs: 204_000, durationTolSec: 5, explicitSource: true })
    const v = verifyCandidate(req, qz({ title: 'Mask Off', artist: 'Future', durationSec: 204, parentalWarning: false }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'explicit')
    const clean = buildRequestedRecording({ artist: 'Future', title: 'Mask Off', durationMs: 204_000, durationTolSec: 30, cleanRequested: true })
    assert.equal(verifyCandidate(clean, qz({ title: 'Mask Off', artist: 'Future', durationSec: 204, parentalWarning: false })).verdict, 'exact')
  })

  it('symmetric: a CLEAN request refuses a candidate the provider flags explicit; unknown flags never mismatch', () => {
    const clean = buildRequestedRecording({ artist: 'Future', title: 'Mask Off', durationMs: 204_000, durationTolSec: 30, cleanRequested: true })
    const v = verifyCandidate(clean, qz({ title: 'Mask Off', artist: 'Future', durationSec: 204, parentalWarning: true }))
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'explicit')
    assert.equal(verifyCandidate(clean, qz({ title: 'Mask Off', artist: 'Future', durationSec: 204 })).verdict, 'exact')
    // An Apple listing that merely HAPPENED to be the cleaned edition is not a
    // request for censorship — the ladder prefers the explicit master there.
    const listedClean = buildRequestedRecording({ artist: 'Future', title: 'Mask Off', durationMs: 204_000, durationTolSec: 30, cleanedSource: true })
    assert.equal(listedClean.explicit, 'unknown')
    assert.equal(verifyCandidate(listedClean, qz({ title: 'Mask Off', artist: 'Future', durationSec: 204, parentalWarning: true })).verdict, 'exact')
  })

  it('album evidence is confidence, not identity: single / compilation / deluxe / remaster releases of the same master pass', () => {
    for (const album of ['5 Years Time - Single', 'Now That\'s What I Call Indie 2008', 'Peaceful, the World Lays Me Down (Deluxe Edition)', 'Peaceful, the World Lays Me Down (2018 Remaster)', 'Peaceful, the World Lays Me Down']) {
      const v = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album, artist: 'Noah and the Whale', durationSec: 217 }))
      assert.equal(v.verdict, 'exact', album)
    }
    const canonical = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album: 'Peaceful, the World Lays Me Down', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(canonical.verdict === 'exact' && canonical.albumMatches, true)
    const comp = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album: 'Indie Anthems', artist: 'Noah and the Whale', durationSec: 217 }))
    assert.equal(comp.verdict === 'exact' && comp.albumMatches, false)
    // …while an unrequested RECORDING version on the album side is still the hard rejection.
    for (const album of ['Live at Glastonbury', 'The Acoustic Sessions', 'Remixes']) {
      assert.equal(verifyCandidate(fiveYears(), qz({ title: '5 Years Time', album, artist: 'Noah and the Whale', durationSec: 217 })).verdict, 'reject', album)
    }
  })

  it("Qobuz's own version field is a witness too", () => {
    const v = verifyCandidate(fiveYears(), qz({ title: '5 Years Time', artist: 'Noah and the Whale', durationSec: 217, version: 'Live' }))
    assert.equal(v.verdict, 'reject')
  })

  it('multiple SoundCloud candidates are ranked, not one-shotted, and derivatives never lead', () => {
    const hits = [
      { source: 'soundcloud', mediaType: 'track', id: 'a', desc: '5 Years Time (TopKnot Remix) by TopKnot' },
      { source: 'soundcloud', mediaType: 'track', id: 'b', desc: 'Noah And The Whale - 5 Years Time by Noah and the Whale' },
      { source: 'soundcloud', mediaType: 'track', id: 'c', desc: '5 Years Time - Noah and the Whale (TopKnot 5 Years L' },
      { source: 'soundcloud', mediaType: 'track', id: 'd', desc: '5 Years Time [Noah and the Whale cover] by Somebody' },
    ]
    const ranked = rankSoundcloudCandidates('5 Years Time', 'Noah and the Whale', hits)
    assert.deepEqual(ranked.map((r) => r.id), ['b'])
  })

  it('verdicts: rip failures, provider outages, exact-match failures and nothing-found stay distinct', () => {
    assert.equal(finalOutcome({ alternatives: [], ripFailure: 'exit 1 — connection reset', searchFailure: null, anyMatched: true, unverifiable: false }), 'provider-failed')
    assert.equal(finalOutcome({ alternatives: [], ripFailure: null, searchFailure: 'streamrip: Qobuz login failed', anyMatched: false, unverifiable: false }), 'provider-unavailable')
    assert.equal(finalOutcome({ alternatives: [{ provider: 'soundcloud', desc: 'x', reason: 'is tagged remix' }], ripFailure: null, searchFailure: null, anyMatched: true, unverifiable: false }), 'exact-not-found')
    assert.equal(finalOutcome({ alternatives: [], ripFailure: null, searchFailure: null, anyMatched: false, unverifiable: false }), 'not-found')
    assert.equal(finalOutcome({ alternatives: [], ripFailure: null, searchFailure: null, anyMatched: true, unverifiable: false }), 'exact-not-found')
  })

  // ── The XTC failure (2026-09-04, Jake's first manual test) ─────────────
  // Requested: the ALBUM "Drums and Wires (Bonus Track Version)" by XTC.
  // Qobuz was asked for that literal string, answered "No search results
  // found", and the verdict read "Found … but the download failed" — a
  // search that returned nothing was reported as a failed transfer, and the
  // queue truncated even that.
  it('XTC: "(Bonus Track Version)" is packaging — the catalogue is asked for the album by name', () => {
    assert.equal(searchTitle('Drums and Wires (Bonus Track Version)'), 'Drums and Wires')
    assert.equal(searchTitle('Drums and Wires (Bonus Tracks Edition)'), 'Drums and Wires')
    assert.equal(searchTitle('Drums and Wires (Live Edition)'), 'Drums and Wires (Live Edition)')   // a different recording survives
  })

  it('XTC: an empty search is a catalogue answer, not a provider failure', () => {
    assert.equal(isNoResultsMessage('No search results found for query XTC Drums and Wires (Bonus Track Version)'), true)
    assert.equal(isNoResultsMessage('Qobuz login failed: invalid app id'), false)
    const outcome = finalOutcome({ alternatives: [], ripFailure: null, searchFailure: null, anyMatched: false, unverifiable: false })
    assert.equal(outcome, 'not-found')
    const d = describeOutcome(outcome, { title: 'Drums and Wires (Bonus Track Version)', artist: 'XTC', query: 'XTC Drums and Wires', alternatives: [], wantAlbum: true })
    assert.equal(d.primary, 'Not found')
    assert.ok(!/found .* but the download failed/i.test(d.detail), d.detail)
  })

  it('every outcome has a short primary status and a full detail; the detail is never a one-liner of the primary', () => {
    const base = { title: '5 Years Time', artist: 'Noah and the Whale', query: 'Noah and the Whale 5 Years Time', alternatives: [{ provider: 'soundcloud' as const, desc: '5 Years Time (TopKnot Remix)', reason: 'is tagged “5 Years Time (TopKnot Remix)” (remix)' }] }
    assert.equal(describeOutcome('exact-not-found', base).primary, 'Exact version not found')
    assert.match(describeOutcome('exact-not-found', base).detail, /TopKnot Remix/)
    assert.equal(describeOutcome('provider-failed', { ...base, ripFailure: 'exit 1 — read timed out' }).primary, 'Download failed')
    assert.match(describeOutcome('provider-failed', { ...base, ripFailure: 'exit 1 — read timed out' }).detail, /read timed out/)
    assert.equal(describeOutcome('provider-unavailable', { ...base, searchFailure: 'Qobuz login failed' }).primary, 'Provider unavailable')
    assert.equal(describeOutcome('unverifiable', base).primary, 'Couldn’t verify recording')
    assert.equal(describeOutcome('not-found', base).primary, 'Not found')
  })

  it('requested markers are read off the title Jake clicked', () => {
    assert.deepEqual(requestedVersionMarkers('Layla (Acoustic)'), ['acoustic'])
    assert.deepEqual(requestedVersionMarkers('Live and Let Die'), ['live'])
    assert.deepEqual(requestedVersionMarkers('Layla'), [])
  })
})
