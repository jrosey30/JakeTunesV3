import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestStreamripMatch, pickBestSoundcloudMatch, rankStreamripCandidates, unwantedVersionOf , searchTitle} from '../streamrip-match.ts'

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
