// Release-admission gate (2026-10-20). Jake, on artist pages full of junk:
// "do you know how many phony releases are in my artists. this is a
// disaster" and "you need a safety check but for making sure no junk enters
// the fucking picture here!!!"
//
// ⚠️ TWIN of JakeTunesMobile backend/src/util/__tests__/releaseGate.test.ts.
// Same cases, same fixture file (fixtures/release-gate-2026-10-20.json: real
// MusicBrainz / Deezer / iTunes responses captured by running the gate
// live). Only the lines down to GATE_SOURCE differ between the repos.
import { albumTitlesMatch, normAlbumTitle } from '../../common/artist-identity.ts'
import { nameKey } from '../../common/fold-text.ts'
import * as gate from '../../common/release-gate.ts'
import type { GateDeps, GateInput, GetJson, ReleaseSection, GateVerdict, GateCredit } from '../../common/release-gate.ts'
const GATE_SOURCE = new URL('../../common/release-gate.ts', import.meta.url)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'release-gate-2026-10-20.json'), 'utf-8')) as {
  responses: Record<string, unknown>
  prolific: Record<string, { artist: string; mbid: string; catalogueSize: number; page: unknown }>
}

/// Replays the captured responses. A request the fixture never saw fails the
/// test loudly, so a rule change that asks MusicBrainz something new can't
/// pass on an accidental empty answer.
const replay: GetJson = async (url) => {
  if (!(url in FIXTURE.responses)) throw new Error(`unrecorded request: ${url}`)
  return { ok: true, json: FIXTURE.responses[url] }
}

const match = { fold: nameKey, normTitle: normAlbumTitle, albumMatch: albumTitlesMatch }
const DAFT_PUNK = '056e4f3e-d505-4dad-8ec1-d04f521cbb56'
const GEESE = 'e0c97a4d-c392-41a9-a374-57af3e3eeab3'
const SHOEGAZE_GEESE = '2df54ba9-49e6-4b90-a880-1205e3f2bf9f'
// Jake's library on 2026-10-20 (top-200 artist export).
const JAKES_DAFT_PUNK = ['Random Access Memories', 'Discovery', 'Homework', 'Human After All', 'Alive 2007', 'Alive 2007 (Live Set)']
const JAKES_GEESE = ['Getting Killed', '3D Country', 'Projector', 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)', 'A Beautiful Memory', '4D Country', 'Alive & In Person', 'Baby', 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026) (Live Set)', 'Alive & In Person (Live Set)']
const DESKTOP: ReleaseSection[] = ['album', 'ep']
const PHONE: ReleaseSection[] = ['album']

async function run(input: Omit<GateInput, 'releaseGroups'>, getJson: GetJson = replay, extra: Partial<GateDeps> = {}) {
  const rg = await gate.fetchReleaseGroupsForGate(input.mbid, input.sections, getJson)
  assert.ok(rg.complete, 'the release-group browse is in the fixture')
  const result = await gate.gateReleaseGroups({ ...input, releaseGroups: rg.groups }, { ...match, ...gate.httpGateSources(getJson, input.sections), ...extra })
  const byTitle = new Map<string, GateVerdict>(result.verdicts.map((v) => [v.title, v]))
  const verdict = (title: string): GateVerdict => {
    const v = byTitle.get(title)
    assert.ok(v, `${title} is in MusicBrainz's catalogue`)
    return v
  }
  return { result, verdict, admitted: result.verdicts.filter((v) => v.admitted).map((v) => v.title) }
}

describe('regression fixtures: Daft Punk (phone "More from" listed bootlegs)', () => {
  for (const [label, sections] of [['desktop albums + EPs', DESKTOP], ['phone albums', PHONE]] as const) {
    for (const owned of [JAKES_DAFT_PUNK, []]) {
      const who = owned.length ? "with Jake's library" : 'owning nothing (every check on its own)'
      it(`${label}, ${who}: Leftovers, Extra Credit and Discovery (Beta Version) are rejected`, async () => {
        const { verdict } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections, ownedAlbums: owned })
        for (const t of ['Leftovers', 'Extra Credit', 'Discovery (Beta Version)']) {
          const v = verdict(t)
          assert.equal(v.admitted, false, `${t} must not reach Jake`)
          assert.ok(v.reasons.includes('no-official-release'), `${t}: MusicBrainz has no Official release (${v.reasons.join(', ')})`)
          assert.equal(v.transient, false, `${t} is a fact, not an outage`)
        }
        assert.ok(verdict('Discovery (Beta Version)').reasons.includes('bootleg-title'), 'the old regex still fires as a backstop')
        assert.equal(verdict('Discovery (Beta Version)').owned, false, 'owning "Discovery" does not make the beta leak owned')
      })
      it(`${label}, ${who}: Homework, Discovery, Human After All and Random Access Memories are admitted`, async () => {
        const { verdict, result } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections, ownedAlbums: owned })
        for (const t of ['Homework', 'Discovery', 'Human After All', 'Random Access Memories']) {
          const v = verdict(t)
          assert.equal(v.admitted, true, `${t}: ${v.reasons.join(', ')}`)
          if (!owned.length) {
            assert.deepEqual(v.reasons, [], `${t} passes every check without ownership`)
            assert.ok(v.catalogue, `${t} was found in a store`)
          }
        }
        assert.equal(result.complete, true)
      })
    }
  }
  it('Human After All is proven by iTunes when Deezer only has the Remixes album', async () => {
    const { verdict } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: PHONE, ownedAlbums: [] })
    const v = verdict('Human After All')
    assert.equal(v.catalogue, 'itunes')
    assert.ok(v.notes.some((n) => n === 'itunes: Human After All'))
  })
  it('remixes, compilations, DJ mixes and interviews never reach a studio list; live waits for a live list', async () => {
    const { verdict } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: DESKTOP, ownedAlbums: JAKES_DAFT_PUNK })
    assert.deepEqual(verdict('Daft Club').reasons, ['excluded-type'])
    assert.deepEqual(verdict('Musique, Volume 1: 1993–2005').reasons, ['excluded-type'])
    assert.ok(verdict('Random Access Memories: The Collaborators').reasons.includes('excluded-type'))
    const alive = verdict('Alive 2007')
    assert.equal(alive.section, 'live')
    assert.equal(alive.admitted, false, 'owning a live album does not put it in the album list')
    assert.deepEqual(alive.reasons, ['live-outside-live-list'])
  })
  it('a Soundtrack album is allowed (TRON: Legacy)', async () => {
    const { verdict } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: DESKTOP, ownedAlbums: JAKES_DAFT_PUNK })
    assert.equal(verdict('TRON: Legacy').admitted, true)
  })
  it('a Various Artists compilation is rejected for the credit too', async () => {
    const { verdict } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: DESKTOP, ownedAlbums: [] })
    assert.ok(verdict('One More Virgin: Tracks for Celebration of New Century').reasons.includes('various-artists'))
  })
})

describe('regression fixtures: Geese', () => {
  it('Bottomless Pink Lagoon is out: Jake hid it', async () => {
    const { verdict } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: DESKTOP, ownedAlbums: JAKES_GEESE })
    const v = verdict('Bottomless Pink Lagoon')
    assert.equal(v.admitted, false)
    assert.deepEqual(v.reasons, ['hidden'])
    assert.ok(v.notes.some((n) => n.includes('it isnt anywhere')))
  })
  it('Bottomless Pink Lagoon is out even without the hidden list: no Official release', async () => {
    const { verdict } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: DESKTOP, ownedAlbums: [], hiddenReleases: {} })
    const v = verdict('Bottomless Pink Lagoon')
    assert.equal(v.admitted, false)
    assert.ok(v.reasons.includes('no-official-release'))
  })
  for (const owned of [JAKES_GEESE, []]) {
    it(`Getting Killed, 3D Country and 4D Country (EP) are admitted${owned.length ? '' : ' owning nothing'}`, async () => {
      const { verdict } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: DESKTOP, ownedAlbums: owned })
      for (const t of ['Getting Killed', '3D Country', '4D Country']) assert.equal(verdict(t).admitted, true, `${t}: ${verdict(t).reasons.join(', ')}`)
      assert.equal(verdict('4D Country').section, 'ep')
    })
  }
  it('an EP is not offered to the phone album list (other-section), and the album list keeps the albums', async () => {
    const { admitted } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: PHONE, ownedAlbums: JAKES_GEESE })
    assert.ok(admitted.includes('Getting Killed') && admitted.includes('3D Country'))
    assert.ok(!admitted.includes('4D Country'))
  })
  it('an owned record with no Official release still passes, and says why', async () => {
    const { verdict } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: DESKTOP, ownedAlbums: JAKES_GEESE })
    const v = verdict('A Beautiful Memory')
    assert.equal(v.admitted, true)
    assert.equal(v.owned, true)
    assert.deepEqual(v.reasons, ['no-official-release'])
    assert.ok(v.notes.includes('owned: admitted despite no-official-release'))
  })
  it('the 2018 "EP" nobody carries is rejected as not in a catalogue', async () => {
    const { verdict } = await run({ artist: 'Geese', mbid: GEESE, identity: 'confirmed', sections: DESKTOP, ownedAlbums: JAKES_GEESE })
    assert.deepEqual(verdict('EP').reasons, ['not-in-catalogue'])
  })
})

describe('regression fixtures: the shoegaze Geese (wrong identity)', () => {
  it('Pop Songs and Duck are rejected even when a resolver hands over the wrong MBID', async () => {
    const { result, verdict } = await run({ artist: 'Geese', mbid: SHOEGAZE_GEESE, identity: 'single', sections: DESKTOP, ownedAlbums: JAKES_GEESE })
    assert.equal(result.identity.ok, false)
    for (const t of ['Pop Songs', 'Duck']) assert.deepEqual(verdict(t).reasons, ['identity'])
    assert.equal(result.verdicts.some((v) => v.admitted), false)
    assert.equal(result.complete, true, 'a refusal on evidence is a fact')
  })
  it('an ambiguous identity admits nothing', async () => {
    const { result } = await run({ artist: 'Geese', mbid: GEESE, identity: 'ambiguous', sections: DESKTOP, ownedAlbums: JAKES_GEESE })
    assert.equal(result.verdicts.some((v) => v.admitted), false)
  })
  it('why identity is load-bearing: the stores alone would have let Pop Songs and Duck in', async () => {
    const { admitted } = await run({ artist: 'Geese', mbid: SHOEGAZE_GEESE, identity: 'single', sections: DESKTOP, ownedAlbums: [] })
    assert.ok(admitted.includes('Pop Songs') && admitted.includes('Duck'), 'Deezer has a "Geese" with these records; a name match is not identity')
  })
})

describe('regression fixtures: prolific artists and verified phony releases', () => {
  // An earlier audit stopped its official-release scan at 400 releases and
  // called real albums phony (Bowie, Elton John, Johnny Cash). The gate
  // pages to the end or asks each group directly; nothing is decided by a
  // cut-off. The rejected titles were then verified one group at a time
  // (no Official release at all) and are rejected here beside a real album
  // by the same artist.
  const cases: Array<[string, string[], string[]]> = [
    ['bowie', ['★', 'The Next Day'], []],
    ['elton', ['Peachtree Road'], []],
    ['cash', ['American VI: Ain’t No Grave'], []],
    ['mccartney', ['McCartney III'], ['UK Singles Collection Vol.04']],
    ['zeppelin', ['Physical Graffiti'], ['The Lost Sessions, Vol. 4']],
    ['jcole', [], ['Any Given Sunday #3']],
    ['eminem', ['The Marshall Mathers LP'], ['Shady Beats']],
  ]
  for (const [key, admit, reject] of cases) {
    const p = FIXTURE.prolific[key]!
    const label = [admit.length ? `admits ${admit.join(', ')}` : '', reject.length ? `rejects ${reject.join(', ')}` : ''].filter(Boolean).join('; ')
    it(`${p.artist} (${p.catalogueSize} release groups): ${label}`, async () => {
      const groups = gate.parseReleaseGroupPage(p.page).groups
      const result = await gate.gateReleaseGroups(
        { artist: p.artist, mbid: p.mbid, identity: 'single', sections: DESKTOP, releaseGroups: groups, ownedAlbums: [] },
        { ...match, ...gate.httpGateSources(replay, DESKTOP) },
      )
      for (const t of admit) {
        const v = result.verdicts.find((x) => x.title === t && x.admitted)
        assert.ok(v, `${t} is admitted (${result.verdicts.filter((x) => x.title === t).map((x) => x.reasons.join('+')).join(' / ')})`)
        assert.deepEqual(v.reasons, [])
        assert.ok(v.catalogue, `${t} was found in a store`)
      }
      for (const t of reject) {
        const vs = result.verdicts.filter((x) => x.title === t)
        assert.ok(vs.length > 0, `${t} is in the catalogue`)
        for (const v of vs) {
          assert.equal(v.admitted, false, `${t} must not reach Jake`)
          assert.ok(v.reasons.includes('no-official-release'), `${t}: ${v.reasons.join(', ')}`)
          assert.equal(v.transient, false)
        }
      }
      assert.equal(result.complete, true)
    })
  }
  it('Bowie\'s first official page holds neither album: the gate asks the two groups directly', () => {
    const page0 = Object.keys(FIXTURE.responses).filter((u) => u.includes('5441c29d') && u.includes('status=official'))
    assert.equal(page0.length, 1, 'one artist-wide page, then direct per-group checks')
    assert.equal((FIXTURE.responses[page0[0]!] as { 'release-count': number })['release-count'], 1135)
  })
  it('a letterless title matches itself (★)', () => {
    assert.equal(gate.sameRelease('★', '★', match), true)
    assert.equal(gate.sameRelease('Blackstar', '★', match), false)
  })
})

describe('fail closed', () => {
  const down: GetJson = async (url, source) => (source === 'musicbrainz' ? replay(url, source) : { ok: false, status: 503 })
  it('both stores unreachable: rejected, transient, and the result is incomplete', async () => {
    const { verdict, result } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: PHONE, ownedAlbums: [] }, down)
    const v = verdict('Homework')
    assert.equal(v.admitted, false)
    assert.deepEqual(v.reasons, ['catalogue-unreachable'])
    assert.equal(v.transient, true)
    assert.equal(result.complete, false)
  })
  it('owned releases still pass while the stores are down (they are never asked)', async () => {
    const { verdict, result } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: PHONE, ownedAlbums: JAKES_DAFT_PUNK }, down)
    assert.equal(verdict('Homework').admitted, true)
    assert.equal(verdict('TRON: Legacy').transient, true, 'the unowned soundtrack waits for the stores')
    assert.equal(result.complete, false)
  })
  it('MusicBrainz official scan fails: unowned releases are official-unknown (transient), owned pass', async () => {
    const mbDown: GetJson = async (url, source) => (url.includes('/release?') ? { ok: false, status: 503 } : replay(url, source))
    const { verdict, result } = await run({ artist: 'Daft Punk', mbid: DAFT_PUNK, identity: 'single', sections: PHONE, ownedAlbums: JAKES_DAFT_PUNK }, mbDown)
    assert.deepEqual(verdict('Leftovers').reasons, ['official-unknown'])
    assert.equal(verdict('Leftovers').admitted, false)
    assert.equal(verdict('Leftovers').transient, true)
    assert.equal(verdict('Homework').admitted, true)
    assert.equal(result.complete, false)
  })
  it('Deezer down, iTunes up: iTunes decides', async () => {
    const deezerDown: GetJson = async (url, source) => (source === 'deezer' ? { ok: false, status: null } : replay(url, source))
    const r = await gate.findInCatalogue(['Daft Punk'], 'Human After All', { ...match, ...gate.httpGateSources(deezerDown, PHONE) })
    assert.equal(r.status, 'found')
    assert.equal(r.source, 'itunes')
  })
  it('Deezer answered "no", iTunes down: unreachable, not missing', async () => {
    const r = await gate.findInCatalogue(['Daft Punk'], 'X', {
      ...match,
      deezerAlbums: async () => ({ ok: true, albums: [] }),
      itunesAlbums: async () => ({ ok: false }),
    })
    assert.equal(r.status, 'unreachable')
  })
  it('Deezer reports errors with HTTP 200 and { error }: that is not an answer', () => {
    assert.deepEqual(gate.parseDeezerAlbums({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }), { ok: false })
    assert.deepEqual(gate.parseDeezerAlbums({ data: [] }), { ok: true, albums: [] })
  })
  it('an identity check that failed mid-way refuses, marked transient', async () => {
    const r = await gate.gateReleaseGroups({ artist: 'Geese', mbid: GEESE, identity: 'ambiguous', identityIncomplete: true, sections: DESKTOP, releaseGroups: [], ownedAlbums: JAKES_GEESE }, { ...match, ...gate.httpGateSources(replay, DESKTOP) })
    assert.equal(r.complete, false)
  })
  it('a giant catalogue is paged to the end, then the unresolved are asked directly, never guessed', async () => {
    // 12,000 official releases; the wanted group first appears on page 40.
    const pagesAsked: number[] = []
    const direct: string[] = []
    const r = await gate.officialStatus('x', ['late', 'bootleg'], {
      browseOfficial: async (_m, offset) => { pagesAsked.push(offset); return { ok: true, releaseGroupIds: offset === 3900 ? ['late'] : [`rg${offset}`], releaseCount: 100, total: 12_000 } },
      officialInGroup: async (id) => { direct.push(id); return { ok: true, count: id === 'late' ? 3 : 0 } },
    })
    assert.ok(r.official.has('late'), 'an official album past release 400 is still official')
    assert.ok(!r.official.has('bootleg') && !r.unknown.has('bootleg'), 'a group with no official release is a definite no')
    assert.equal(pagesAsked.length, 1, 'two groups left vs 119 pages: ask them directly instead')
    assert.deepEqual(direct, ['late', 'bootleg'])
  })
  it('a small catalogue is paged to its end and the leftovers are a definite no', async () => {
    let direct = 0
    const r = await gate.officialStatus('x', ['a', 'b', 'c', 'd'], {
      browseOfficial: async (_m, offset) => ({ ok: true, releaseGroupIds: offset === 0 ? ['a'] : ['b'], releaseCount: 100, total: 150 }),
      officialInGroup: async () => { direct++; return { ok: true, count: 1 } },
    })
    assert.deepEqual([...r.official].sort(), ['a', 'b'])
    assert.equal(r.unknown.size, 0, 'c and d were in no page: a definite no')
    assert.equal(direct, 0, 'three unresolved vs one page left: the page is cheaper')
  })
  it('the official scan stops early once every wanted group is found', async () => {
    let calls = 0
    const pages: GateDeps['browseOfficial'] = async (_m, offset) => { calls++; return { ok: true, releaseGroupIds: [`rg${offset}`, `rg${offset + 100}`], releaseCount: 100, total: 10_000 } }
    const r = await gate.officialStatus('x', ['rg0', 'rg100'], { browseOfficial: pages, officialInGroup: async () => ({ ok: false }) })
    assert.equal(r.unknown.size, 0)
    assert.equal(calls, 1)
  })
  it('a failed page or a failed direct check leaves groups unknown (transient), never "no"', async () => {
    const pageDown = await gate.officialStatus('x', ['a'], { browseOfficial: async () => ({ ok: false }), officialInGroup: async () => ({ ok: true, count: 1 }) })
    assert.deepEqual([...pageDown.unknown], ['a'])
    const directDown = await gate.officialStatus('x', ['a', 'b'], {
      browseOfficial: async () => ({ ok: true, releaseGroupIds: [], releaseCount: 100, total: 100_000 }),
      officialInGroup: async () => ({ ok: false }),
    })
    assert.deepEqual([...directDown.unknown].sort(), ['a', 'b'])
  })
})

describe('rules', () => {
  const c = (artistId: string | null, name: string, joinphrase = ''): GateCredit => ({ artistId, name, joinphrase })
  it('credit: lead, collaboration, feat. guest, Various Artists, absent', () => {
    assert.equal(gate.creditRole([c('a', 'Daft Punk')], 'a'), 'principal')
    assert.equal(gate.creditRole([c('j', 'JAY-Z', ' & '), c('k', 'Kanye West')], 'k'), 'principal')
    assert.equal(gate.creditRole([c('x', 'The Weeknd', ' feat. '), c('a', 'Daft Punk')], 'a'), 'guest')
    assert.equal(gate.creditRole([c('x', 'Pharrell', ' ft. '), c('a', 'Daft Punk')], 'a'), 'guest')
    assert.equal(gate.creditRole([c(gate.VARIOUS_ARTISTS_MBID, 'Various Artists')], 'a'), 'various')
    assert.equal(gate.creditRole([c('x', 'Someone Else')], 'a'), 'absent')
    assert.equal(gate.creditRole(null, 'a'), 'absent')
    assert.deepEqual(gate.principalNames([c('j', 'JAY-Z', ' & '), c('k', 'Kanye West', ' feat. '), c('f', 'Frank Ocean')]), ['JAY-Z', 'Kanye West'])
  })
  it('type: sections, soundtrack allowed, the excluded list, unknown secondaries fail closed', () => {
    assert.deepEqual(gate.sectionOf('Album', []), { section: 'album', excluded: null })
    assert.deepEqual(gate.sectionOf('Album', ['Soundtrack']), { section: 'album', excluded: null })
    assert.deepEqual(gate.sectionOf('EP', []), { section: 'ep', excluded: null })
    assert.deepEqual(gate.sectionOf('Single', []), { section: 'single', excluded: null })
    assert.deepEqual(gate.sectionOf('Album', ['Live']), { section: 'live', excluded: null })
    for (const t of ['Compilation', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Interview', 'Spokenword', 'Audiobook', 'Audio drama', 'Field recording', 'Remix']) {
      assert.equal(gate.sectionOf('Album', [t]).section, null, t)
      assert.equal(gate.sectionOf('Album', [t]).excluded, t.toLowerCase(), t)
    }
    assert.equal(gate.sectionOf('Album', ['Something New']).excluded, 'something new')
    assert.deepEqual(gate.sectionOf('Broadcast', []), { section: null, excluded: null })
  })
  it('titles: bracketed words must survive the match', () => {
    assert.equal(gate.sameRelease('Discovery', 'Discovery (Beta Version)', match), false)
    assert.equal(gate.sameRelease('Discovery (Beta Version)', 'Discovery (Beta Version)', match), true)
    assert.equal(gate.sameRelease('Homework (Remastered)', 'Homework', match), true)
    assert.equal(gate.sameRelease('Alive 2007 (Live Set)', 'Alive 2007', match), true)
    assert.equal(gate.storeTitleMatches('Human After All (Remixes)', 'Human After All', match), false)
    assert.equal(gate.sameRelease('The Beatles (The White Album)', 'The Beatles’ Hits', match), false, 'a prefix is not the same record')
    assert.equal(gate.sameRelease('Sgt. Pepper\'s Lonely Hearts Club Band (Remastered)', 'Sgt. Pepper’s Lonely Hearts Club Band', match), true)
    assert.equal(gate.storeTitleMatches('4D Country - EP', '4D Country', match), true)
    assert.equal(gate.storeTitleMatches('40oz. To Freedom', '40 oz. to Freedom', match), true, 'spacing is not a different record')
    assert.equal(gate.storeTitleMatches('The Marshall Mathers LP2 (Deluxe)', 'The Marshall Mathers LP 2', match), true)
  })
  it('owning a record does not make every title containing its words owned', () => {
    assert.equal(gate.ownsRelease('The Alternate A Hard Day\'s Night', ['A Hard Day\'s Night'], match), false)
    assert.equal(gate.ownsRelease('Studio 2 Sessions at Abbey Road, Vol. 4', ['Abbey Road'], match), false)
    assert.equal(gate.ownsRelease('Help! Back To Basics', ['Help!'], match), false)
    assert.equal(gate.ownsRelease('Abbey Road', ['Abbey Road (Super Deluxe Edition)'], match), true)
  })
  it('an owned-excused group loses to a clean group with the same title (the bootleg "The Beatles")', async () => {
    const credit = [{ artistId: 'b', name: 'The Beatles', joinphrase: '' }]
    const groups = [
      { id: 'white', title: 'The Beatles', primaryType: 'Album', secondaryTypes: [], credit },
      { id: 'boot', title: 'The Beatles', primaryType: 'Album', secondaryTypes: [], credit },
    ]
    const r = await gate.gateReleaseGroups({ artist: 'The Beatles', mbid: 'b', identity: 'single', sections: PHONE, releaseGroups: groups, ownedAlbums: ['The Beatles'] }, {
      ...match,
      browseOfficial: async () => ({ ok: true, releaseGroupIds: ['white'], releaseCount: 1, total: 1 }),
      officialInGroup: async () => ({ ok: false }),
      deezerAlbums: async () => ({ ok: false }),
      itunesAlbums: async () => ({ ok: false }),
    })
    const [white, boot] = r.verdicts
    assert.equal(white!.admitted, true)
    assert.equal(boot!.admitted, false)
    assert.deepEqual(boot!.reasons, ['no-official-release', 'duplicate'])
    assert.equal(gate.storeTitleMatches('Random Access Memories (10th Anniversary Edition)', 'Random Access Memories', match), true)
  })
  it('store artist names: fold, optional "The", collaboration members', () => {
    assert.equal(gate.storeArtistMatches('The Beatles', ['Beatles'], nameKey), true)
    assert.equal(gate.storeArtistMatches('JAŸ-Z & Kanye West', ['Kanye West'], nameKey), true)
    assert.equal(gate.storeArtistMatches('Geese Da Goon', ['Geese'], nameKey), false)
  })
  it('identity: confirmed or the only claimant, with the library albums in the catalogue', () => {
    const deps = { normTitle: normAlbumTitle, albumMatch: albumTitlesMatch }
    assert.equal(gate.identityVerdict('weak', ['Homework'], [], deps).ok, false)
    assert.equal(gate.identityVerdict(null, ['Homework'], [], deps).ok, false)
    assert.equal(gate.identityVerdict('ambiguous', ['Homework'], ['Homework'], deps).ok, false)
    assert.equal(gate.identityVerdict('single', ['Homework'], ['Homework'], deps).ok, true)
    assert.equal(gate.identityVerdict('single', ['Pop Songs', 'Duck'], JAKES_GEESE, deps).ok, false)
    assert.equal(gate.identityVerdict('single', ['Этажи'], ['Этажи'], deps).ok, true, 'titles with nothing to normalize cannot testify')
  })
  it('hidden list: exact title, case-folded, per artist', () => {
    assert.equal(gate.isHiddenRelease(GEESE, 'bottomless pink lagoon '), true)
    assert.equal(gate.isHiddenRelease(GEESE, '3D Country'), false)
    assert.equal(gate.isHiddenRelease('someone-else', 'Bottomless Pink Lagoon'), false)
    assert.deepEqual(gate.hiddenReleaseTitles(GEESE), ['Bottomless Pink Lagoon'])
  })
  it('the bootleg regex is the old phone backstop', () => {
    for (const t of ['Discovery (Beta Version)', 'Demos', 'The Bootleg Series', 'Unreleased', 'Leaked', 'Outtakes']) assert.match(t, gate.BOOTLEG_TITLE)
    assert.doesNotMatch('Homework', gate.BOOTLEG_TITLE)
  })
  it('owned excuses only reality checks: never identity, the hidden list or the type', () => {
    assert.ok(!gate.OWNED_MAY_FAIL.includes('identity'))
    assert.ok(!gate.OWNED_MAY_FAIL.includes('hidden'))
    assert.ok(!gate.OWNED_MAY_FAIL.includes('excluded-type'))
    assert.ok(!gate.OWNED_MAY_FAIL.includes('live-outside-live-list'))
  })
  it('requests: the browse types follow the sections', () => {
    assert.equal(gate.mbTypesFor(['album', 'ep']), 'album|ep')
    assert.equal(gate.mbTypesFor(['live']), 'album')
    assert.equal(gate.mbTypesFor(['single', 'album']), 'album|single')
  })
})

describe('twin lock', () => {
  // The body of release-gate.ts / releaseGate.ts (from the first export to
  // the end) must hash to this in BOTH repos. Changing a rule means changing
  // this number here AND in the twin, in the same change set.
  const TWIN_BODY_SHA256 = '39fc73be83727d37fd6a1eb4ce0e173cb4c664f7cf7a642123465d3d40c5d72f'
  it('the gate body matches its twin', () => {
    const src = readFileSync(GATE_SOURCE, 'utf-8')
    const body = src.slice(src.indexOf('export type ReleaseSection'))
    assert.equal(createHash('sha256').update(body).digest('hex'), TWIN_BODY_SHA256)
  })
})
