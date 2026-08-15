import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { foldAccents, withinEditDistance, typoBudget } from '../../common/fold-text.ts'
import { recoArtistMatches, recoTitleMatches } from '../reco-match.ts'
import { pickBestStreamripMatch, pickBestSoundcloudMatch, rankStreamripCandidates, unwantedVersionOf , searchTitle, maskedTitleMatches, searchQueryTitle, editionSubstituted, subtitleVariantMatches} from '../streamrip-match.ts'

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
