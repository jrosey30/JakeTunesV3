import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { foldAccents, withinEditDistance, typoBudget } from '../../common/fold-text.ts'
import { recoArtistMatches, recoTitleMatches } from '../reco-match.ts'
import { pickBestStreamripMatch, pickBestSoundcloudMatch, rankStreamripCandidates, unwantedVersionOf , searchTitle, maskedTitleMatches, searchQueryTitle, editionSubstituted, subtitleVariantMatches, applyExplicitGate, liveBrandMarker, hitsByAnotherName, rankWithArtistAliases, isCoverAct, isMaskedToken, albumVersionOf, titleReads, requestedVersionMarkers } from '../streamrip-match.ts'

function hit(id: string, desc: string) {
  return { source: 'qobuz', mediaType: 'track', id, desc }
}
function schit(id: string, desc: string) {
  return { source: 'soundcloud', mediaType: 'track', id, desc }
}

describe('pickBestStreamripMatch', () => {
  it('picks the artist+title match over a title-only near miss', () => {
    const results = [
      hit('1', 'Around the World by Daft Punk'),
      hit('2', 'Around the World by Kings of Leon'),
    ]
    const pick = pickBestStreamripMatch('Around the World', 'Daft Punk', results)
    assert.equal(pick?.id, '1')
  })

  it('returns null when no title matches', () => {
    const results = [hit('1', 'Creep by Radiohead')]
    assert.equal(pickBestStreamripMatch('Karma Police', 'Radiohead', results), null)
  })

  // Regression (2026-07-24): album downloads always failed because the matcher
  // hard-skipped every non-'track' row. An album query passes wantMediaType
  // 'album' and MUST match album rows (Charli XCX "Music, Fashion, Film").
  it('matches an ALBUM row when asked for an album', () => {
    const results = [{ source: 'qobuz', mediaType: 'album', id: 'wy1feibmvq0fu', desc: 'Music, Fashion, Film by Charli XCX' }]
    const pick = pickBestStreamripMatch('Music, Fashion, Film', 'Charli xcx', results, 'album')
    assert.equal(pick?.id, 'wy1feibmvq0fu')
  })

  it('does NOT match an album row for a track query (default track gate holds)', () => {
    const results = [{ source: 'qobuz', mediaType: 'album', id: 'a1', desc: 'Music, Fashion, Film by Charli XCX' }]
    assert.equal(pickBestStreamripMatch('Music, Fashion, Film', 'Charli xcx', results), null)
  })

  // Regression (2026-08-07, Jake: "IT DOWNLOADED THE RE RECORDED VERSION").
  // Real Qobuz result order that day: the (Rerecorded) cut was result #0 and
  // the loose containment match let it win the first-tie. The original at #2
  // must win, and the re-record must be reported as a rejected version.
  it('never picks a (Rerecorded) cut over the original — Etta James', () => {
    const results = [
      hit('264355606', "Something's Got a Hold on Me (Rerecorded) by Etta James"),
      hit('264355607', 'Tell Mama (Rerecorded) by Etta James'),
      hit('4557684', "Something's Got A Hold On Me by Etta James"),
      hit('9990001', "Something's Got A Hold On Me by Christina Aguilera"),
      hit('264355699', "Something's Got a Hold on Me (Rerecorded) by Etta James"),
    ]
    const { ranked, rejectedVersions } = rankStreamripCandidates("Something's Got a Hold on Me", 'Etta James', results)
    assert.equal(ranked[0]?.id, '4557684')
    assert.equal(rejectedVersions.length, 2)
    // The Christina Aguilera cover must not be in the running AT ALL.
    assert.ok(!ranked.some((r) => r.id === '9990001'))
  })

  it('hard-skips covers instead of scoring them down (no cover on artist miss)', () => {
    // Old behavior scored a mismatched artist −3 but kept it; with the exact-
    // title bonus that would have floated cover bands above "not found".
    const results = [
      hit('c1', 'Your Body Is a Wonderland by John Alagia'),
      hit('c2', 'Your Body Is A Wonderland by Guitar Tribute Players'),
      hit('c3', 'Your Body Is a Wonderland by Boyce Avenue'),
    ]
    assert.equal(pickBestStreamripMatch('Your Body Is a Wonderland', 'John Mayer', results), null)
  })

  it('prefers the undecorated title over a suffixed variant of equal artist', () => {
    const results = [
      hit('v1', 'Dreams (2004 Remaster) by Fleetwood Mac'),
      hit('v2', 'Dreams by Fleetwood Mac'),
    ]
    assert.equal(pickBestStreamripMatch('Dreams', 'Fleetwood Mac', results)?.id, 'v2')
  })

  it('a song legitimately NAMED with a marker word never self-rejects', () => {
    assert.equal(unwantedVersionOf('Live and Let Die', 'Live and Let Die'), null)
    assert.equal(unwantedVersionOf('Live and Let Die', 'Live and Let Die (Live)'), 'live')
    assert.equal(unwantedVersionOf('Stayin’ Alive', 'Stayin’ Alive'), null)
  })

  it('an explicitly requested version keeps matching itself', () => {
    const results = [hit('a1', 'Layla (Acoustic) by Eric Clapton'), hit('a2', 'Layla by Eric Clapton')]
    const { ranked } = rankStreamripCandidates('Layla (Acoustic)', 'Eric Clapton', results)
    assert.equal(ranked[0]?.id, 'a1')
  })

  it('marker guard catches re-recorded spelling variants', () => {
    assert.equal(unwantedVersionOf("Something's Got a Hold on Me", "Something's Got a Hold on Me (Re-Recorded)"), 'rerecorded')
    assert.equal(unwantedVersionOf('Time After Time', 'Time After Time (Live at Wembley)'), 'live')
    assert.equal(unwantedVersionOf('Time After Time', 'Time After Time - Sound-A-Like'), 'soundalike')
  })
})

describe('pickBestSoundcloudMatch (Qobuz-gap fallback)', () => {
  it('matches the real Villanova track SoundCloud returns (artist+title inside the label-uploaded desc)', () => {
    const results = [
      schit('2275039610|url', 'Villanova - Mr Vibe feat. Mike Dunn [Indie House Records] by Indie House Records'),
      schit('2291240129|url', 'Villanova (FR) - Mr Vibe feat. Mike Dunn (Claude Monnet Remix) by Indie House Records'),
    ]
    const pick = pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results)
    // original upload preferred over the longer remix desc
    assert.equal(pick?.id, '2275039610|url')
  })

  it('rejects a title match whose artist is absent (avoids grabbing a random cover)', () => {
    const results = [schit('9', 'Some Kid - Mr Vibe (bedroom cover) by RandomUploader')]
    assert.equal(pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results), null)
  })

  it('returns null when the title is nowhere in the results', () => {
    const results = [schit('9', 'Villanova - Different Song by Indie House Records')]
    assert.equal(pickBestSoundcloudMatch('Mr Vibe', 'Villanova', results), null)
  })
})

describe('searchTitle — edition metadata is not the song’s name', () => {
  it('strips censorship stamps and feature credits (the Life After Death failure)', () => {
    // Jake, 2026-08-09: five tracks refused and Mo Money fetched a radio edit.
    // iTunes only carries that album as the Amended edition.
    assert.equal(searchTitle('Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]'), 'Mo Money Mo Problems')
    assert.equal(searchTitle('Notorious Thugs [Amended]'), 'Notorious Thugs')
    assert.equal(searchTitle("Another (feat. Lil' Kim) [Amendedd]"), 'Another')       // Apple's own typo
    assert.equal(searchTitle('Sky’s the Limit (feat. 112) [Amended]'), 'Sky’s the Limit')
    assert.equal(searchTitle('Life After Death [Amended Version] (2014 Remaster)'), 'Life After Death')
  })

  it('leaves version markers alone — they name a different recording', () => {
    assert.equal(searchTitle('Time After Time (Live at Wembley)'), 'Time After Time (Live at Wembley)')
    assert.equal(searchTitle('Blue Monday (Remix)'), 'Blue Monday (Remix)')
    assert.equal(searchTitle('Layla (Acoustic)'), 'Layla (Acoustic)')
  })

  it('strips Apple’s “- Single” / “- EP” catalog suffix (Love Fiend 2026-08-14)', () => {
    // iTunes names the 1-track release "It's Nearly Over - Single"; Qobuz
    // catalogs it as "It's Nearly Over". Searching the Apple name returned
    // zero album hits and stacked failed Gets on a track that was on Qobuz.
    assert.equal(searchTitle("It's Nearly Over - Single"), "It's Nearly Over")
    assert.equal(searchTitle('Sundowning - EP'), 'Sundowning')
    assert.equal(searchTitle('Bags – Single'), 'Bags')
    // A title that merely CONTAINS the word must not be gutted.
    assert.equal(searchTitle('Single Ladies'), 'Single Ladies')
  })

  it('matches the Qobuz album after stripping Apple’s Single suffix', () => {
    const want = searchTitle("It's Nearly Over - Single")
    const results = [{ source: 'qobuz', mediaType: 'album', id: 'wvbojl9ouvcv3', desc: "It's Nearly Over by Love Fiend" }]
    assert.equal(pickBestStreamripMatch(want, 'Love Fiend', results, 'album')?.id, 'wvbojl9ouvcv3')
    assert.equal(want, "It's Nearly Over")
  })

  it('leaves ordinary titles untouched', () => {
    assert.equal(searchTitle('Hypnotize'), 'Hypnotize')
    assert.equal(searchTitle('Nothing Compares 2 U'), 'Nothing Compares 2 U')
    assert.equal(searchTitle('(Don’t Fear) The Reaper'), '(Don’t Fear) The Reaper')
  })

  it('now MATCHES what Qobuz actually calls the track', () => {
    const want = searchTitle('Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]')
    const results = [{ source: 'qobuz', mediaType: 'track', id: 'q1',
                       desc: 'Mo Money Mo Problems (feat. Puff Daddy & Mase) by The Notorious B.I.G.' }]
    assert.equal(pickBestStreamripMatch(want, 'The Notorious B.I.G.', results)?.id, 'q1')
    // …and the un-sanitised title is exactly what used to fail:
    assert.equal(pickBestStreamripMatch('Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]',
                                        'The Notorious B.I.G.', results), null)
  })

  it('refuses a clean edit when the explicit cut was asked for', () => {
    const results = [
      { source: 'qobuz', mediaType: 'track', id: 'clean', desc: 'Hypnotize (Clean) by The Notorious B.I.G.' },
      { source: 'qobuz', mediaType: 'track', id: 'real', desc: 'Hypnotize by The Notorious B.I.G.' },
    ]
    const { ranked, rejectedVersions } = rankStreamripCandidates('Hypnotize', 'The Notorious B.I.G.', results)
    assert.equal(ranked[0]?.id, 'real')
    assert.ok(!ranked.some((r) => r.id === 'clean'))
    assert.equal(rejectedVersions.length, 1)
  })

  it('does not self-reject a song legitimately named with one of those words', () => {
    assert.equal(unwantedVersionOf('Radio Ga Ga', 'Radio Ga Ga'), null)
    assert.equal(unwantedVersionOf('Radio Ga Ga', 'Radio Ga Ga (Radio Edit)'), 'radio')
    assert.equal(unwantedVersionOf('Clean Up Woman', 'Clean Up Woman'), null)
  })
})

describe('masked titles — Apple asterisks out profanity', () => {
  it('matches a masked title against the real one', () => {
    // Jake, still failing after the Amended fix: "N****s Bleed (2005 Remaster)"
    // sat on Retry. Normalised it is "nsbleed" vs Qobuz's "niggasbleed".
    assert.ok(maskedTitleMatches('N****s Bleed', 'Niggas Bleed'))
    assert.ok(maskedTitleMatches('N****s Bleed', 'Niggas Bleed (2005 Remaster)'))
    assert.ok(maskedTitleMatches('F!*@ You Tonight', 'Fuck You Tonight'))
    assert.ok(!maskedTitleMatches('N****s Bleed', 'Somebody Else Bleed'))
    assert.ok(!maskedTitleMatches('N****s Bleed', 'Hypnotize'))
  })

  it('drops masked tokens from the QUERY but keeps them for matching', () => {
    assert.equal(searchQueryTitle('N****s Bleed (2005 Remaster)'), 'Bleed')
    assert.equal(searchQueryTitle('F!*@ You Tonight (feat. R. Kelly) [Amended]'), 'You Tonight')
    assert.equal(searchTitle('N****s Bleed (2005 Remaster)'), 'N****s Bleed')
    // an unmasked title is unaffected
    assert.equal(searchQueryTitle('I Got a Story to Tell (2005 Remaster)'), 'I Got a Story to Tell')
  })

  it('resolves the track that was stuck on Retry', () => {
    const want = searchTitle('N****s Bleed (2005 Remaster)')
    const results = [
      { source: 'qobuz', mediaType: 'track', id: 'right', desc: 'Niggas Bleed by The Notorious B.I.G.' },
      { source: 'qobuz', mediaType: 'track', id: 'wrong', desc: 'Bleed by Someone Else' },
    ]
    assert.equal(pickBestStreamripMatch(want, 'The Notorious B.I.G.', results)?.id, 'right')
  })
})

describe('editionSubstituted — when the runtime stops being a fingerprint', () => {
  it('is true for censored, masked and remastered rows', () => {
    assert.ok(editionSubstituted('Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]'))
    assert.ok(editionSubstituted('N****s Bleed (2005 Remaster)'))
    assert.ok(editionSubstituted('Hypnotize (2014 Remaster)'))
  })
  it('is FALSE when only feature credits were stripped — same recording', () => {
    assert.equal(editionSubstituted('Mo Money Mo Problems (feat. Puff Daddy & Mase)'), false)
    assert.equal(editionSubstituted('Hypnotize'), false)
  })
})

describe('subtitle variants — catalogues disagree about parentheticals', () => {
  it('bridges "Lady (Hear Me Tonight)" to Qobuz\'s "Lady"', () => {
    assert.ok(subtitleVariantMatches('Lady (Hear Me Tonight)', 'Lady'))
    assert.ok(subtitleVariantMatches('Lady', 'Lady (Hear Me Tonight)'))
  })

  it('refuses to compare two DECORATED titles — that is where wrong matches live', () => {
    assert.equal(subtitleVariantMatches('Lady (Hear Me Tonight)', 'Lady (Radio Edit)'), false)
    assert.equal(subtitleVariantMatches('Lady (Live)', 'Lady (Remix)'), false)
  })

  it('does not match a different song sharing a first word', () => {
    assert.equal(subtitleVariantMatches('Lady (Hear Me Tonight)', 'Lady Marmalade'), false)
    assert.equal(subtitleVariantMatches('Lady (Hear Me Tonight)', 'Ladies Night'), false)
  })

  it('a dash tail is the same decoration as a bracket (2026-11-03)', () => {
    assert.equal(subtitleVariantMatches('Stars', 'Stars - Mono'), true)
    assert.equal(subtitleVariantMatches('Stars - Mono', 'Stars'), true)
    assert.equal(subtitleVariantMatches('Love Song', 'Love - Song'), false, 'not when the words differ')
    assert.equal(titleReads('Stars', 'Stars - Mono'), true)
    assert.deepEqual(rankStreamripCandidates('Stars', 'Hum', [hit('1', 'Stars - Mono by Hum')]).ranked.map((r) => r.id), ['1'])
  })

  it('picks Modjo\'s original over the remix, from the real Qobuz listing', () => {
    const results = [
      { source: 'qobuz', mediaType: 'track', id: 'real',  desc: 'Lady by Modjo' },
      { source: 'qobuz', mediaType: 'track', id: 'remix', desc: 'Lady (Hear Me Tonight) - Remix by Modjo' },
      { source: 'qobuz', mediaType: 'track', id: 'cover', desc: 'Lady (Hear Me Tonight) by Black Caviar' },
    ]
    const { ranked, rejectedVersions } = rankStreamripCandidates('Lady (Hear Me Tonight)', 'Modjo', results)
    assert.equal(ranked[0]?.id, 'real')
    assert.ok(!ranked.some((r) => r.id === 'remix'))
    assert.ok(!ranked.some((r) => r.id === 'cover'))
    assert.equal(rejectedVersions.length, 1)
  })

  it('still prefers the fully-titled row when the catalogue has both', () => {
    const results = [
      { source: 'qobuz', mediaType: 'track', id: 'bare', desc: 'Lady by Modjo' },
      { source: 'qobuz', mediaType: 'track', id: 'full', desc: 'Lady (Hear Me Tonight) by Modjo' },
    ]
    assert.equal(rankStreamripCandidates('Lady (Hear Me Tonight)', 'Modjo', results).ranked[0]?.id, 'full')
  })
})

describe('accent folding — catalogues spell names with letters we were deleting', () => {
  it('folds the names that were being destroyed', () => {
    assert.equal(foldAccents('JAŸ-Z'), 'jaÿ-z'.normalize('NFD').replace(/[̀-ͯ]/g, ''))
    assert.equal(foldAccents('JAŸ-Z').replace(/[^a-z0-9]/g, ''), 'jayz')
    assert.equal(foldAccents('Beyoncé').replace(/[^a-z0-9]/g, ''), 'beyonce')
    assert.equal(foldAccents('Sigur Rós').replace(/[^a-z0-9]/g, ''), 'sigurros')
    assert.equal(foldAccents('Motörhead').replace(/[^a-z0-9]/g, ''), 'motorhead')
    assert.equal(foldAccents('Björk').replace(/[^a-z0-9]/g, ''), 'bjork')
  })

  it('handles letters that have NO decomposition — the half people forget', () => {
    assert.equal(foldAccents('MØ').replace(/[^a-z0-9]/g, ''), 'mo')
    assert.equal(foldAccents('Sigur Rós & Mø').replace(/[^a-z0-9]/g, ''), 'sigurrosmo')
    assert.equal(foldAccents('Blœdhound').replace(/[^a-z0-9]/g, ''), 'bloedhound')
  })

  it('matches JAY-Z as the user types it against JAŸ-Z as iTunes writes it', () => {
    assert.ok(recoArtistMatches('JAY-Z', 'JAŸ-Z'))
    assert.ok(recoArtistMatches('JAŸ-Z', 'Jay-Z'))
    assert.ok(recoTitleMatches('Crazy in Love (feat. JAY-Z)', 'Crazy in Love (feat. JAŸ-Z)'))
  })

  it('still refuses genuinely different artists', () => {
    assert.equal(recoArtistMatches('JAY-Z', 'Jay Chou'), false)
    assert.equal(recoArtistMatches('Beyoncé', 'Beyond'), false)
  })
})

describe('typo tolerance — Apple corrects the spelling, we must not discard it', () => {
  it('accepts a plausible typo', () => {
    assert.ok(withinEditDistance('radiohed', 'radiohead', typoBudget('radiohed'.length)))
    assert.ok(withinEditDistance('turnstyle', 'turnstile', typoBudget('turnstyle'.length)))
    assert.ok(withinEditDistance('zepplin', 'zeppelin', typoBudget('zepplin'.length)))
  })
  it('refuses genuinely different words', () => {
    assert.equal(withinEditDistance('radiohead', 'radiator', typoBudget(9)), false)
    assert.equal(withinEditDistance('jay', 'kay', typoBudget(3)), false)   // 3 chars: no budget
    assert.equal(withinEditDistance('drake', 'blake', typoBudget(5)), false)
  })
})

describe('applyExplicitGate — explicitness is an identity axis', () => {
  const meta = new Map<string, { parentalWarning?: boolean }>([
    ['clean1', { parentalWarning: false }],
    ['explicit1', { parentalWarning: true }],
    ['unknown1', {}],
  ])
  const cands = [{ id: 'clean1' }, { id: 'explicit1' }, { id: 'unknown1' }, { id: 'nometa' }]

  it('explicit wanted: Qobuz-flagged clean candidates are refused', () => {
    const r = applyExplicitGate(cands, meta, true)
    assert.deepEqual(r.kept.map(c => c.id), ['explicit1', 'unknown1', 'nometa'])
    assert.deepEqual(r.refusedClean.map(c => c.id), ['clean1'])
  })

  it('missing metadata passes through unjudged — an API hiccup must not brick downloads', () => {
    const r = applyExplicitGate([{ id: 'nometa' }], new Map(), true)
    assert.deepEqual(r.kept.map(c => c.id), ['nometa'])
  })

  it('all candidates clean: kept is EMPTY so the caller must fail loudly', () => {
    const r = applyExplicitGate([{ id: 'clean1' }], meta, true)
    assert.equal(r.kept.length, 0)
    assert.equal(r.refusedClean.length, 1)
  })

  it('explicit not requested: everything passes untouched', () => {
    const r = applyExplicitGate(cands, meta, false)
    assert.equal(r.kept.length, 4)
    assert.equal(r.refusedClean.length, 0)
  })
})

describe('liveBrandMarker — the Ed Sullivan class (2026-08-22)', () => {
  it('clean title + show-branded album context is flagged', () => {
    assert.equal(
      liveBrandMarker(
        "These Boots Are Made for Walkin'",
        "These Boots Are Made for Walkin' — Nancy Sinatra — The Ed Sullivan Show",
      ),
      'ed sullivan',
    )
  })
  it('a request that NAMES the show is honored (want-side exemption)', () => {
    assert.equal(
      liveBrandMarker('Toppermost The Ed Sullivan Show', 'The Beatles — The Ed Sullivan Show'),
      null,
    )
  })
  it('a song legitimately NAMED after a brand never self-rejects', () => {
    assert.equal(
      liveBrandMarker('The Midnight Special', 'CCR — The Midnight Special — Willy and the Poor Boys'),
      null,
    )
    // …but wanting a DIFFERENT song still flags the TV-show album.
    assert.equal(
      liveBrandMarker('Proud Mary', 'Proud Mary — The Midnight Special 1973'),
      'midnight special',
    )
  })
  it('phrase matching is token-normalized (punctuation, case)', () => {
    assert.equal(liveBrandMarker('Song', 'Song [Live @ KEXP]'), 'kexp')
    assert.equal(liveBrandMarker('Song', "Song — Top Of The Pops '71"), 'top of the pops')
  })
  it('no partial-word hits', () => {
    assert.equal(liveBrandMarker('Song', 'Song — Kexperimental Works'), null)
  })
})

// 2026-08-25 — Jake hit "No search results found for query Simple Plan No
// Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)" while Apple
// showed the album and all 19 tracks right there. EDITION_GROUP was a CLOSED
// list, so any reissue label outside it rode into the Qobuz query and matched
// nothing. Packaging must strip; a different RECORDING must survive.
describe('searchTitle — reissue packaging is not the album’s name', () => {
  it('strips edition / anniversary / reissue labels', () => {
    assert.equal(searchTitle('No Pads, No Helmets...Just Balls (15th Anniversary Tour Edition)'), 'No Pads, No Helmets...Just Balls')
    assert.equal(searchTitle('Nevermind (Deluxe Edition)'), 'Nevermind')       // "deluxe" alone was listed; "Deluxe Edition" was not
    assert.equal(searchTitle('OK Computer (Collector’s Edition)'), 'OK Computer')
    assert.equal(searchTitle('Pet Sounds (50th Anniversary)'), 'Pet Sounds')
    assert.equal(searchTitle('Doolittle (Expanded)'), 'Doolittle')
    assert.equal(searchTitle('Loveless (Reissue)'), 'Loveless')
  })

  it('keeps a different RECORDING — the wrong-version guard depends on it', () => {
    assert.equal(searchTitle('Under the Bridge (Live)'), 'Under the Bridge (Live)')
    assert.equal(searchTitle('Layla (Acoustic)'), 'Layla (Acoustic)')
    assert.equal(searchTitle('Ray of Light (Remix)'), 'Ray of Light (Remix)')
    // VERSION_MARKER is checked before EDITION_GROUP, so this is NOT packaging.
    assert.equal(searchTitle('MTV Unplugged (Live Edition)'), 'MTV Unplugged (Live Edition)')
  })
})

// 2026-11-03: Qobuz files The English Beat as "The Beat", and every hit fell to the
// artist test. ⚠️ TWIN: JakeTunesMobile backend/src/util/__tests__/streamripMatch.test.ts
// holds the same listing (`rip search … "The English Beat Save It for Later"`).
describe('another name for the artist, from MusicBrainz (the phone\'s, 2026-11-03)', () => {
  const beat = [
    hit('234377348', 'Save It for Later (2012 Remaster) by The Beat'),
    hit('236890901', 'Save It for Later by The Beat'),
    hit('400743677', 'Save It For Later by Elias Colt'),
  ]
  const NAMES = ['The Beat', 'English Beat']

  it('without their names no hit survives; with them the real hits do, the plain title first, a cover still out', () => {
    assert.deepEqual(rankStreamripCandidates('Save It for Later', 'The English Beat', beat).ranked, [])
    assert.deepEqual(rankStreamripCandidates('Save It for Later', 'The English Beat', beat, 'track', NAMES).ranked.map((r) => r.id), ['236890901', '234377348'])
  })

  it('an alias is a whole name, never part of one', () => {
    const results = [hit('1', 'Save It for Later by The Beat Happening')]
    assert.deepEqual(rankStreamripCandidates('Save It for Later', 'The English Beat', results, 'track', ['The Beat']).ranked, [])
  })

  it('an alias-only hit is the artist, as good as their own name', () => {
    const results = [hit('contains', 'Song by The English Beat & Friends'), hit('alias', 'Song by The Beat')]
    assert.deepEqual(rankStreamripCandidates('Song', 'The English Beat', results, 'track', ['The Beat']).ranked.map((r) => r.id), ['alias', 'contains'])
  })

  it('looks up only when a hit would have ranked but for its artist', () => {
    assert.equal(hitsByAnotherName('Save It for Later', 'The English Beat', beat), true)
    assert.equal(hitsByAnotherName('Till It\'s Over', '3DDY', [hit('1', 'Till It\'s Over by 3ddy')]), false, 'their own name needs no lookup')
    assert.equal(hitsByAnotherName('Song', '', [hit('1', 'Song by Someone')]), false, 'no artist asked for')
    assert.equal(hitsByAnotherName('Song', 'Artist', [hit('1', 'Song by Karaoke Hits')]), false, 'a cover act is no other name')
    assert.equal(hitsByAnotherName('Song', 'Artist', [hit('1', 'Song (Live) by Someone')]), false, 'a version is no other name')
    assert.equal(hitsByAnotherName('Song', 'Artist', [hit('1', 'Song (The Ed Sullivan Show) by Someone')]), false, 'nor a show brand')
    assert.equal(hitsByAnotherName('Karma Police', 'Artist', [hit('1', 'Creep by Someone')]), false, 'another song')
    assert.equal(hitsByAnotherName('Lady (Hear Me Tonight)', 'Yann Destal', [hit('1', 'Lady by Modjo')]), true, 'a dropped subtitle still reads as the song')
    const album = { source: 'qobuz', mediaType: 'album', id: 'a', desc: 'Special Beat Service by The Beat' }
    assert.equal(hitsByAnotherName('Special Beat Service', 'The English Beat', [album]), false, 'the media type asked for')
    assert.equal(hitsByAnotherName('Special Beat Service', 'The English Beat', [album], 'album'), true)
  })

  it('asks MusicBrainz once, only when needed, and hands the names on for the judge', async () => {
    const asked: string[] = []
    const lookup = async (a: string) => { asked.push(a); return NAMES }
    const found = await rankWithArtistAliases('Save It for Later', 'The English Beat', beat, 'track', lookup)
    assert.deepEqual(asked, ['The English Beat'])
    assert.deepEqual(found.aliases, NAMES)
    assert.deepEqual(found.ranked.map((r) => r.id), ['236890901', '234377348'])

    asked.length = 0
    const own = await rankWithArtistAliases('Save It for Later', 'The Beat', beat, 'track', lookup)
    assert.deepEqual(asked, [], 'the artist has hits under their own name')
    assert.deepEqual(own.aliases, [])
    const other = await rankWithArtistAliases('Karma Police', 'Radiohead', beat, 'track', lookup)
    assert.deepEqual(asked, [], 'nothing reads as the song')
    assert.deepEqual(other.ranked, [])
  })

  it('a busy or empty MusicBrainz leaves the answer as it was, rejected versions included', async () => {
    const results = [hit('live', 'Save It for Later (Live) by The English Beat'), hit('beat', 'Save It for Later by The Beat')]
    const none = await rankWithArtistAliases('Save It for Later', 'The English Beat', results, 'track', async () => [])
    assert.deepEqual(none.ranked, [])
    assert.deepEqual(none.aliases, [])
    assert.deepEqual(none.rejectedVersions, ['Save It for Later (Live)'])
  })
})

describe('cover acts never stand in for the artist (the phone\'s, 2026-11-02)', () => {
  it('the cover band listed first loses to the artist listed second, and is reported as a version', () => {
    const results = [hit('cover', 'We Found Love (feat. Calvin Harris) by Rihanna Cover Band'), hit('real', 'We Found Love (feat. Calvin Harris) by Rihanna')]
    const { ranked, rejectedVersions } = rankStreamripCandidates('We Found Love (feat. Calvin Harris)', 'Rihanna', results)
    assert.deepEqual(ranked.map((r) => r.id), ['real'])
    assert.deepEqual(rejectedVersions, ['We Found Love (feat. Calvin Harris)'])
  })
  it('with only a cover, karaoke or tribute hit there is no match at all', () => {
    for (const d of ['We Found Love by Rihanna Cover Band', 'We Found Love by Rihanna Tribute Band', 'We Found Love (In the Style of Rihanna) by Rihanna Hits']) {
      assert.equal(pickBestStreamripMatch('We Found Love', 'Rihanna', [hit('1', d)]), null, d)
    }
  })
  it('a request that names one still finds one; a real name holding the word is not one', () => {
    assert.equal(pickBestStreamripMatch('We Found Love (Karaoke Version)', 'Karaoke Hits', [hit('1', 'We Found Love (Karaoke Version) by Karaoke Hits')])?.id, '1')
    assert.equal(pickBestStreamripMatch('Under Cover of Darkness', 'The Strokes', [hit('1', 'Under Cover of Darkness by The Strokes')])?.id, '1')
    assert.equal(isCoverAct('Song', 'Discover'), false, 'whole words only')
  })
  it("the artist's own name outranks a name that merely contains it", () => {
    const results = [hit('friends', 'Umbrella by Rihanna & Friends'), hit('real', 'Umbrella by Rihanna')]
    assert.deepEqual(rankStreamripCandidates('Umbrella', 'Rihanna', results).ranked.map((r) => r.id), ['real', 'friends'])
  })
})

describe('what a mask is, and what it is not (2026-11-03)', () => {
  it('a title with no mask is not a masked match: "Love Song" is not "Love"', () => {
    assert.equal(maskedTitleMatches('Lady', 'Lady Marmalade'), false)
    assert.equal(maskedTitleMatches('Love', 'Love Song'), false)
    assert.equal(maskedTitleMatches('Bleed', 'Niggas Bleed'), false)
    assert.deepEqual(rankStreamripCandidates('Love', 'Lana Del Rey', [hit('other', 'Love Song by Lana Del Rey')]).ranked, [])
  })
  it('a word that ends in punctuation is a word, not a mask', () => {
    for (const w of ['Oh!', 'Help!', 'Yeah!!', '100%', '#1', '(Yeah!)', 'Wow,']) assert.equal(isMaskedToken(w), false, w)
    for (const w of ['N****s', 'F!*@', 'S**t', 'F***', 'Sh!t', 'N***as', '(N****s']) assert.equal(isMaskedToken(w), true, w)
    assert.equal(searchQueryTitle('Oh! Darling'), 'Oh! Darling')
    assert.equal(editionSubstituted('Oh! Darling'), false)
  })
  it('a title that differs only in its label outranks a subtitle: a remaster before a reprise', () => {
    const results = [hit('reprise', 'Hello (Reprise) by Adele'), hit('remaster', 'Hello (2009 Remaster) by Adele')]
    assert.deepEqual(rankStreamripCandidates('Hello', 'Adele', results).ranked.map((r) => r.id), ['remaster', 'reprise'])
  })
  it('a label on the hit does not hide a dropped subtitle', () => {
    assert.deepEqual(rankStreamripCandidates('Lady (Hear Me Tonight)', 'Modjo', [hit('1', 'Lady (2012 Remaster) by Modjo')]).ranked.map((r) => r.id), ['1'])
  })
  it('the titles that only passed through the old hole still read', () => {
    for (const t of ['?', ':(', '///']) {
      assert.equal(titleReads(t, t), true, t)
      assert.deepEqual(rankStreamripCandidates(t, 'Outkast', [hit('1', `${t} by Outkast`)]).ranked.map((r) => r.id), ['1'], t)
    }
    assert.equal(titleReads('?', '///'), false, 'nothing is not the same as nothing')
    assert.deepEqual(rankStreamripCandidates('?', 'Outkast', [hit('1', '/// by Outkast')]).ranked, [])
    assert.deepEqual(rankStreamripCandidates('Hello', 'Adele', [hit('1', 'Hello - 2009 Remaster by Adele')]).ranked.map((r) => r.id), ['1'])
    assert.equal(titleReads('Hello', 'Hello - 2009 Remaster'), true)
    assert.equal(titleReads('Hypnotize [Amended]', 'Hypnotize (2014 Remaster)'), true)
    assert.equal(titleReads('Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]', 'Mo Money Mo Problems (feat. Puff Daddy & Mase)'), true)
    assert.equal(titleReads('Love', 'Love Song'), false)
    assert.equal(titleReads('Lady (Hear Me Tonight)', 'Lady (2012 Remaster)'), true, 'a label does not hide a dropped subtitle')
  })
})

describe('markers the phone already refused (2026-11-03)', () => {
  it('refuses them', () => {
    assert.equal(unwantedVersionOf('We Found Love', 'We Found Love (Cahill Club)'), 'club')
    assert.equal(unwantedVersionOf('Song', 'Song (Megamix)'), 'megamix')
    assert.equal(unwantedVersionOf('Song', 'Song (Re-Edit)'), 'reedit')
    assert.equal(unwantedVersionOf('Song', 'Song (Sped-Up)'), 'spedup')
    assert.equal(unwantedVersionOf('Song', 'Song (A Cappella)'), 'acapella')
    assert.equal(unwantedVersionOf('Song', 'Song (Acappella)'), 'acapella')
    assert.equal(unwantedVersionOf('Love Story', "Love Story (Taylor's Version)"), 'rerecord')
    assert.equal(unwantedVersionOf('Love Story', 'Love Story (Taylor’s Version)'), 'rerecord')
    assert.equal(unwantedVersionOf('Song', 'Song (Re-recordings)'), 'rerecordings')
  })
  it('a request that carries them, or a song named with them, stays itself', () => {
    assert.equal(unwantedVersionOf('Club Foot', 'Club Foot'), null)
    assert.equal(unwantedVersionOf("Love Story (Taylor's Version)", 'Love Story (Taylor’s Version)'), null)
    assert.equal(unwantedVersionOf('Song (A Cappella)', 'Song (Acapella)'), null)
    assert.equal(unwantedVersionOf('Song', 'Song (Album Version)'), null, 'an ordinary label is no owner')
    assert.equal(unwantedVersionOf('Song', 'Song (Single Version)'), null)
    assert.deepEqual(requestedVersionMarkers('Club Foot'), ['club'])
  })
})

// ⚠️ TWIN FIXTURES: the same albums in the phone's streamripMatch.test.ts.
describe('albumVersionOf: an album says what it is in its label, or in a few phrases (2026-11-03)', () => {
  it('refuses live, acoustic and remix albums', () => {
    for (const a of ['MTV Unplugged In New York', 'Live at Carnegie Hall', 'Unplugged (Live at the Majestic Theatre)', 'Quadrophenia: Live In London', "Let's Go (Remixes)", 'Don Carlos Remixes', 'Peace Is The Mission: Extended', 'The Acoustic Sessions', 'Greatest Hits Re-Recorded', 'The Concert in Central Park', 'isolation demos - EP', 'Life After Death [Amended Version]', 'The Bootleg Series Vol. 1']) {
      assert.ok(albumVersionOf('Song', a), a)
    }
  })
  it('never refuses an album whose NAME happens to hold the word: real albums from Jake\'s library', () => {
    for (const a of ["Sgt. Pepper's Lonely Hearts Club Band", 'Turn The Radio Off', 'Come Clean', 'LONG.LIVE.A$AP', 'Live Through This', 'Beyond The Mix', 'Gangbusters Melody Club', 'Compton - A Soundtrack By Dr. Dre (Explicit Version)', 'Greatest Hits (International Explicit Version)', 'The Beautiful Letdown (Deluxe Version)', 'Modjo (Remastered)', 'Boots (Bonus Tracks Edition)', 'The Sun Sessions', 'Dark Lane Demo Tapes', 'Dub Housing']) {
      assert.equal(albumVersionOf('Song', a), null, a)
    }
  })
  it('a word the request carries is not a marker, however many places the album says it', () => {
    assert.equal(albumVersionOf('About a Girl MTV Unplugged In New York', 'MTV Unplugged In New York'), null)
    assert.equal(albumVersionOf('Who Are You (Live)', 'Live at Leeds'), null)
    assert.equal(albumVersionOf('Drive My Car (Live)', 'Good Evening New York City (Live At Citi Field, NYC, 2009)'), null)
    assert.equal(albumVersionOf('N.Y. State of Mind (Live)', 'Luv(Sic) Hexalogy [OMA and Shing02 Live at Liquidroom]'), null)
    assert.equal(albumVersionOf('Song (Live)', 'Live at Carnegie Hall (Live Set)'), null, 'an album in Jake\'s library that says it twice')
    assert.equal(albumVersionOf('What You Need (Don Carlos Ambient Mix)', 'Don Carlos Remixes'), null, 'one family, however it is worded')
    assert.equal(albumVersionOf('Song (Live)', 'MTV Unplugged In New York'), null)
    assert.ok(albumVersionOf('Song (Live)', 'Song (Remixes)'), 'a different family is still a different recording')
  })
  it('a bracket of more than five words is a blurb, not a label; a phrase still counts inside one', () => {
    assert.equal(albumVersionOf('Aloha', 'Dancefloor Fever 2016 (The Best of Clubbing Music: Electro, Techno, Deep-House. Including a Special House Mix By Yellow Productions)'), null)
    assert.ok(albumVersionOf('Song', 'Good Evening New York City (Live At Citi Field, NYC, 2009)'))
    assert.ok(albumVersionOf('Song', 'Dah Instrumentalz'), 'the stem, however the record spells it')
  })
})
