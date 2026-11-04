import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequestedRecording, requestedLength, verifyCandidate, finalOutcome, describeOutcome, EDITION_TOLERANCE_SEC, RUNTIME_TOLERANCE_SEC, type CandidateEvidence } from '../exact-recording.ts'
import { NO_EXPLICIT_WARNING, rankSoundcloudCandidates, requestedVersionMarkers, unwantedVersionOf, searchTitle, isNoResultsMessage } from '../streamrip-match.ts'

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
    assert.equal(v.verdict === 'reject' && v.reason, NO_EXPLICIT_WARNING, 'what Qobuz says, not a claim about the audio')
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

describe('the judge, brought level with the phone (2026-11-03)', () => {
  const beat = (aliases?: string[]) => buildRequestedRecording({ artist: 'The English Beat', artistAliases: aliases, title: 'Save It for Later', durationMs: 213_900, durationTolSec: 30 })

  it('a file tagged with another name MusicBrainz knows the artist by is the artist; compared whole', () => {
    const real = qz({ title: 'Save It for Later (2012 Remaster)', artist: 'The Beat', album: 'Special Beat Service (Expanded)', durationSec: 213.9 })
    assert.equal(verifyCandidate(beat(['The Beat', 'English Beat']), real).verdict, 'exact')
    const without = verifyCandidate(beat(), real)
    assert.equal(without.verdict === 'reject' && without.kind, 'artist')
    const stranger = verifyCandidate(beat(['The Beat']), qz({ title: 'Save It for Later', artist: 'The Beat Happening', durationSec: 213.9 }))
    assert.equal(stranger.verdict === 'reject' && stranger.kind, 'artist')
  })

  it('a cover act is refused though its name holds the artist\'s; on the album too; unless the request asks for one', () => {
    const req = buildRequestedRecording({ artist: 'Rihanna', title: 'We Found Love', durationTolSec: 5 })
    const band = verifyCandidate(req, qz({ title: 'We Found Love', artist: 'Rihanna Cover Band', album: 'Hits' }))
    assert.equal(band.verdict === 'reject' && band.kind, 'version')
    const tribute = verifyCandidate(req, qz({ title: 'We Found Love', artist: 'Rihanna', album: 'We Found Love (Rihanna feat. Calvin Harris Tribute) - Single' }))
    assert.equal(tribute.verdict, 'reject')
    const namedTribute = verifyCandidate(req, qz({ title: 'We Found Love', artist: 'Rihanna', album: 'A Tribute to Rihanna' }))
    assert.equal(namedTribute.verdict === 'reject' && namedTribute.kind, 'version', 'no bracket: only the cover test sees it')
    const karaoke = buildRequestedRecording({ artist: 'Karaoke Hits', title: 'We Found Love (Karaoke Version)', durationTolSec: 5 })
    assert.equal(verifyCandidate(karaoke, qz({ title: 'We Found Love (Karaoke Version)', artist: 'Karaoke Hits', album: 'Karaoke Hits of 2011' })).verdict, 'exact')
  })

  it('an "[Amended]" row is how Apple lists the song, not a request for the clean edit', () => {
    const mo = buildRequestedRecording({ artist: 'The Notorious B.I.G.', title: 'Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]', durationMs: 258_000, durationTolSec: 30 })
    assert.deepEqual(mo.requestedMarkers, [])
    assert.equal(verifyCandidate(mo, qz({ title: 'Mo Money Mo Problems (feat. Puff Daddy & Mase)', artist: 'The Notorious B.I.G.', album: 'Life After Death', durationSec: 257.4 })).verdict, 'exact')
    const hyp = buildRequestedRecording({ artist: 'The Notorious B.I.G.', title: 'Hypnotize [Amended]', durationTolSec: 30 })
    assert.equal(verifyCandidate(hyp, qz({ title: 'Hypnotize (2014 Remaster)', artist: 'The Notorious B.I.G.', album: 'Life After Death' })).verdict, 'exact')
    assert.equal(verifyCandidate(hyp, qz({ title: 'Hypnotize (Clean)', artist: 'The Notorious B.I.G.' })).verdict, 'reject', 'the clean file is still not asked for')
    const live = buildRequestedRecording({ artist: 'The Who', title: 'Who Are You (Live)', durationTolSec: 5 })
    assert.deepEqual(live.requestedMarkers, ['live'], 'a version named on purpose stays named')
  })

  it('a different song that holds the title is not the song; "Artist - Title" is', () => {
    const love = buildRequestedRecording({ artist: 'Lana Del Rey', title: 'Love', durationTolSec: 5 })
    const v = verifyCandidate(love, qz({ title: 'Love Song', artist: 'Lana Del Rey' }))
    assert.equal(v.verdict === 'reject' && v.kind, 'title')
    const vibe = buildRequestedRecording({ artist: 'Villanova', title: 'Mr Vibe', durationTolSec: 5 })
    assert.equal(verifyCandidate(vibe, sc({ title: 'Villanova - Mr Vibe', artist: 'Indie House Records' })).verdict, 'exact')
    const prefix = verifyCandidate(vibe, sc({ title: 'Someone Else - Mr Vibe', artist: 'Villanova' }))
    assert.equal(prefix.verdict === 'reject' && prefix.kind, 'title', 'only when what precedes the dash names the artist')
  })

  it('an album NAMED with a marker word is not a version; one that says it is, is', () => {
    const doll = buildRequestedRecording({ artist: 'Hole', title: 'Doll Parts', durationTolSec: 5 })
    assert.equal(verifyCandidate(doll, qz({ title: 'Doll Parts', artist: 'Hole', album: 'Live Through This' })).verdict, 'exact')
    const help = buildRequestedRecording({ artist: 'The Beatles', title: 'With a Little Help from My Friends', durationTolSec: 5 })
    assert.equal(verifyCandidate(help, qz({ title: 'With a Little Help from My Friends', artist: 'The Beatles', album: "Sgt. Pepper's Lonely Hearts Club Band" })).verdict, 'exact')
    const girl = buildRequestedRecording({ artist: 'Nirvana', title: 'About a Girl', durationTolSec: 5 })
    assert.equal(verifyCandidate(girl, qz({ title: 'About a Girl', artist: 'Nirvana', album: 'MTV Unplugged In New York' })).verdict, 'reject')
  })
})

// 2026-11-04, real rows: Apple's lookup of the clean and explicit editions, Qobuz's own
// listing. Apple's search hides explicit rows, so a clean row is often all Jake can click.
describe('a clean row has no length', () => {
  const BIG = 'The Notorious B.I.G.'
  const AMENDED_ALBUM = 'Life After Death [Amended Version] (2014 Remaster)'
  const big = (ev: Partial<CandidateEvidence>): CandidateEvidence => qz({ artist: BIG, ...ev })
  const sky = () => buildRequestedRecording({ artist: BIG, title: "Sky's the Limit (feat. 112) [Amended]", album: AMENDED_ALBUM, durationMs: 277_000, cleanedSource: true })
  const respect = () => buildRequestedRecording({ artist: BIG, title: 'Respect', album: 'Ready To Die the Remaster', durationMs: 274_000, cleanedSource: true })

  it('"Sky\'s the Limit": the 329.4 s explicit file is the song; 277.1 s was never the only answer', () => {
    assert.equal(sky().durationSec, 0)
    const v = verifyCandidate(sky(), big({ title: "Sky's the Limit (feat. 112) (2014 Remaster)", album: 'Life After Death (2014 Remastered Edition)', durationSec: 329.4, parentalWarning: true }))
    assert.equal(v.verdict, 'exact')
    assert.ok(v.verdict === 'exact' && !v.evidence.some((e) => e.startsWith('runs')), 'no length, so the length is no witness')
  })

  it('"Respect": a flag with no stamp on the row, and the 321.3 s explicit file passes', () => {
    assert.equal(respect().durationSec, 0)
    for (const album of ['Ready to Die', 'Music Inspired By Biggie: I Got A Story To Tell', 'Ready To Die: For The Respect', 'Ready To Die The Remaster (U.S. Explicit Version 94567)']) {
      assert.equal(verifyCandidate(respect(), big({ title: 'Respect (2005 Remaster)', album, durationSec: 321.3 })).verdict, 'exact', album)
    }
  })

  it('each way a row says it is clean takes the length on its own', () => {
    const length = (o: { title: string; album?: string; cleanedSource?: boolean }): number => requestedLength({ durationMs: 200_000, ...o }).durationSec
    assert.equal(length({ title: 'Respect', album: 'Ready to Die', cleanedSource: true }), 0, 'the flag')
    assert.equal(length({ title: 'The Game (Edited)', album: 'Quality Control' }), 0, 'a stamp on the title')
    assert.equal(length({ title: 'Song', album: 'Album [Amended Version]' }), 0, 'a stamp on the album')
    assert.equal(length({ title: 'Respect', album: 'Ready to Die' }), 200, 'no flag and no stamp')
  })

  it('a clean record asked for on purpose keeps its clean length', () => {
    for (const o of [{ title: 'Respect', cleanedSource: true }, { title: 'The Game (Edited)' }, { title: 'Song', album: 'Album [Amended Version]' }]) {
      assert.equal(requestedLength({ durationMs: 200_000, cleanRequested: true, ...o }).durationSec, 200, o.title)
    }
    const req = buildRequestedRecording({ artist: BIG, title: 'Respect', durationMs: 273_700, cleanRequested: true })
    assert.equal(verifyCandidate(req, big({ title: 'Respect', durationSec: 321.3 })).verdict, 'reject')
  })

  it('the wide window stays where it is honest, and only there', () => {
    const tol = (title: string, album = ''): { durationSec: number; durationTolSec: number } => requestedLength({ title, album, durationMs: 200_000 })
    assert.deepEqual(tol('Lady (Hear Me Tonight)', 'Modjo (Remastered)'), { durationSec: 200, durationTolSec: EDITION_TOLERANCE_SEC }, 'a remastered album')
    assert.deepEqual(tol('Hypnotize (2014 Remaster)'), { durationSec: 200, durationTolSec: EDITION_TOLERANCE_SEC }, 'a remastered title')
    assert.deepEqual(tol('N****s Bleed'), { durationSec: 200, durationTolSec: EDITION_TOLERANCE_SEC }, 'a masked title')
    assert.deepEqual(tol('Mo Money Mo Problems (feat. Puff Daddy & Mase)', 'Mo Money Mo Problems'), { durationSec: 200, durationTolSec: RUNTIME_TOLERANCE_SEC }, 'a credit is the same recording')
    assert.deepEqual(tol('Hypnotize'), { durationSec: 200, durationTolSec: RUNTIME_TOLERANCE_SEC }, 'the plain song')
    assert.equal(buildRequestedRecording({ artist: BIG, title: 'Hypnotize', durationMs: 229_800 }).durationTolSec, RUNTIME_TOLERANCE_SEC)
    assert.equal(buildRequestedRecording({ artist: BIG, title: 'Hypnotize (2014 Remaster)', durationMs: 229_800 }).durationTolSec, EDITION_TOLERANCE_SEC)
    assert.equal(buildRequestedRecording({ artist: BIG, title: 'Hypnotize (2014 Remaster)', durationMs: 229_800, durationTolSec: 5 }).durationTolSec, 5, 'a caller may still say')
  })

  it('a word that is only a word is no stamp: the length stays', () => {
    assert.equal(requestedLength({ title: 'Clean', album: '1989', durationMs: 271_000 }).durationSec, 271)
    assert.equal(requestedLength({ title: 'Blurry', album: 'Come Clean', durationMs: 304_000 }).durationSec, 304)
    assert.equal(requestedLength({ title: 'Song (Radio Edit)', durationMs: 200_000 }).durationSec, 200)
    assert.equal(requestedLength({ title: 'Compton', album: 'Compton - A Soundtrack By Dr. Dre (Explicit Version)', durationMs: 200_000 }).durationSec, 200)
  })

  it('a stamp on the row buys a file that says it is clean nothing, on any of its witnesses', () => {
    const stamped = () => buildRequestedRecording({ artist: BIG, title: 'Hypnotize [Amended]', album: AMENDED_ALBUM, durationMs: 237_500, cleanedSource: true })
    const refused = (ev: Partial<CandidateEvidence>): void => {
      const v = verifyCandidate(stamped(), big(ev))
      assert.equal(v.verdict === 'reject' && v.kind, 'version', JSON.stringify(ev))
    }
    refused({ title: 'Hypnotize [Amended]', album: 'Life After Death', durationSec: 237.5 })
    refused({ title: 'Hypnotize', version: 'Amended Version', album: 'Life After Death', durationSec: 237.5 })
    refused({ title: 'Hypnotize', album: 'Life After Death [Amended Version]', durationSec: 237.5 })
    refused({ title: 'Hypnotize (2005 Remaster)', album: 'Ready To Die The Remaster (U.S. Amended Version 94568)', durationSec: 237.5 })
    assert.equal(verifyCandidate(stamped(), { provider: 'qobuz', desc: 'Hypnotize [Amended] by The Notorious B.I.G.' }).verdict, 'reject', 'the desc, with no tags to read')
    assert.equal(verifyCandidate(stamped(), big({ title: 'Hypnotize (2014 Remaster)', album: 'Life After Death', durationSec: 229.8 })).verdict, 'exact')
    const onPurpose = buildRequestedRecording({ artist: BIG, title: 'Hypnotize [Amended]', album: AMENDED_ALBUM, cleanRequested: true })
    assert.equal(verifyCandidate(onPurpose, big({ title: 'Hypnotize [Amended]', album: 'Life After Death [Amended Version]' })).verdict, 'exact', 'unless a clean record was asked for')
  })

  it('with no length the other witnesses still refuse: real cuts of "Sky\'s the Limit"', () => {
    const reject = (ev: Partial<CandidateEvidence>, kind: string): void => {
      const v = verifyCandidate(sky(), big(ev))
      assert.equal(v.verdict === 'reject' && v.kind, kind, JSON.stringify(ev))
    }
    reject({ title: "Sky's the Limit (Instrumental) [2014 Remaster]", album: 'Life After Death', durationSec: 273.7 }, 'version')
    reject({ title: "Sky's the Limit (feat. 112) [Radio Edit] [2014 Remaster]", album: 'Life After Death', durationSec: 253.7 }, 'version')
    reject({ title: "Somebody's Gotta Die", album: 'Life After Death', durationSec: 266.7 }, 'title')
    reject({ title: 'Sky Is The Limit', artist: 'Jennesy', durationSec: 211 }, 'artist')
    reject({ title: "Sky's the Limit", album: 'Live at the Apollo', durationSec: 300 }, 'version')
  })

  it('no length and no tags is unverifiable: a clean row never imports on the clock', () => {
    const v = verifyCandidate(sky(), qz({ title: '', album: '', artist: '', durationSec: 277 }))
    assert.equal(v.verdict, 'unverifiable')
  })

  it('a rescued row: explicit, no length, and Qobuz\'s own clean flag still refuses', () => {
    // The real row for "Respect" reads explicit and points at the explicit edition. The
    // search no longer hands it the clean length (download-search.ts rowSeconds).
    const req = buildRequestedRecording({ artist: BIG, title: 'Respect', album: 'Ready To Die the Remaster', explicitSource: true })
    assert.equal(verifyCandidate(req, big({ title: 'Respect (2005 Remaster)', album: 'Ready to Die', durationSec: 321.3, parentalWarning: true })).verdict, 'exact')
    const clean = verifyCandidate(req, big({ title: 'Respect (2005 Remaster)', album: 'Ready To Die The Remaster', durationSec: 273.7, parentalWarning: false }))
    assert.equal(clean.verdict === 'reject' && clean.kind, 'explicit')
  })

  it('a row with an honest length still holds a file to it', () => {
    const req = buildRequestedRecording({ artist: BIG, title: 'Hypnotize', album: 'Life After Death', durationMs: 229_800, explicitSource: true })
    assert.equal(req.durationSec, 229.8)
    const v = verifyCandidate(req, big({ title: 'Hypnotize', album: 'Hypnotize - EP', durationSec: 243.4 }))
    assert.equal(v.verdict === 'reject' && v.kind, 'duration', 'the 243 s this comment once called explicit is the Club Mix')
  })
})
