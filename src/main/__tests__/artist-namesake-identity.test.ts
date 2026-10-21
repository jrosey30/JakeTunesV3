// Artist identity (2026-10-20) — the desktop twin of the phone's Brief 202.
// Jake, on the desktop Geese page: "does geese have albums that ive never
// heard of??!!! what is duck and pop songs???" The resolver had ranked a
// shoegaze Geese above the Brooklyn band on genre tags alone. The
// pickDiscographyArtist fixtures are JakeTunesMobile's
// backend/src/util/__tests__/artistIdentity.test.ts (twin lock); the
// chooseArtistIdentity / guard cases below use MusicBrainz's real Geese
// search results and catalogues from that day.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pickDiscographyArtist,
  chooseArtistIdentity,
  albumTitlesMatch,
  type MbArtistCandidate,
} from '../../common/artist-identity.ts'
import { nameKey } from '../../common/fold-text.ts'
import { identityVerdict } from '../../common/release-gate.ts'
import { normAlbumTitle } from '../../common/artist-identity.ts'

const fold = (s: string | null | undefined, sep = ' ') => nameKey(s, sep)

const BROOKLYN = 'e0c97a4d-c392-41a9-a374-57af3e3eeab3'
const SHOEGAZE = '2df54ba9-49e6-4b90-a880-1205e3f2bf9f'

const brooklynGeese: MbArtistCandidate = {
  id: BROOKLYN, name: 'Geese', score: 100,
  releaseGroups: ['Getting Killed', '3D Country', 'Projector', '4D Country'],
}
const otherGeese: MbArtistCandidate = {
  id: '00000000-0000-0000-0000-000000000002', name: 'Geese', score: 100,
  releaseGroups: ['Fierce Brosnan', 'Something for the Weakened'],
}
const geeseOwned = ['Projector', '3D Country', 'Getting Killed', 'Low Era']

describe('pickDiscographyArtist (twin of phone Brief 202)', () => {
  it('owned-album overlap separates duplicate exact names (Geese)', () => {
    assert.equal(pickDiscographyArtist([otherGeese, brooklynGeese], 'Geese', geeseOwned, fold)?.id, BROOKLYN)
    assert.equal(pickDiscographyArtist([brooklynGeese, otherGeese], 'Geese', geeseOwned, fold)?.id, BROOKLYN)
  })
  it('a single qualifier is picked without needing overlap', () => {
    assert.equal(pickDiscographyArtist([{ id: 'x1', name: 'Cake', score: 100 }], 'Cake', [], fold)?.id, 'x1')
  })
  it('duplicates with no overlap: score breaks the tie', () => {
    const a = { id: 'a', name: 'Goose', score: 92, releaseGroups: ['Unrelated A'] }
    const b = { id: 'b', name: 'Goose', score: 85, releaseGroups: ['Unrelated B'] }
    assert.equal(pickDiscographyArtist([b, a], 'Goose', ['Dripfield'], fold)?.id, 'a')
  })
  it('duplicates tied on overlap and score → refuse (null)', () => {
    const a = { id: 'a', name: 'Goose', score: 90 }
    const b = { id: 'b', name: 'Goose', score: 90 }
    assert.equal(pickDiscographyArtist([a, b], 'Goose', ['Dripfield'], fold), null)
  })
  it('an alias can qualify a candidate', () => {
    const molchat = { id: 'm1', name: 'Молчат Дома', score: 100, aliases: ['Molchat Doma'] }
    assert.equal(pickDiscographyArtist([molchat], 'Molchat Doma', [], fold)?.id, 'm1')
  })
  it('below the score floor, even an exact name does not qualify', () => {
    assert.equal(pickDiscographyArtist([{ id: 'w1', name: 'Geese', score: 79 }], 'Geese', geeseOwned, fold), null)
  })
  it('a high-scored stranger with a different name never qualifies', () => {
    assert.equal(pickDiscographyArtist([{ id: 's1', name: 'Bee Gees', score: 100 }], 'Geese', geeseOwned, fold), null)
  })
})

// MusicBrainz artist search for "Geese", 2026-10-20, in the order the old
// genre ranking put them for a library tagged Rock / Indie Rock / Alternative:
// the shoegaze band's rock + indie rock + alternative rock tags out-scored
// Brooklyn by four points. Its own MB score (79) is under the floor here,
// but the search score moves with the query — the album evidence is what
// must decide, so the fixture lifts it to 86 to prove that.
const CATALOGUES: Record<string, string[]> = {
  [SHOEGAZE]: ['Tea', 'Pop Songs', 'Duck', 'Screens', 'Also Void', 'Close', 'What a Day'],
  [BROOKLYN]: ['EP', 'A Beautiful Memory', 'Bottomless Pink Lagoon', 'Projector', '3D Country', '4D Country', 'Getting Killed'],
  '7c0fa31b-b43a-464d-935f-dc3a772c1c0a': [],
  '16a8a6cc-57d9-4a13-9fb9-c87e359c5abe': ['Geese'],
}
const ranked = () => [
  { id: SHOEGAZE, name: 'Geese', score: 86 },
  { id: BROOKLYN, name: 'Geese', score: 100 },
  { id: '7c0fa31b-b43a-464d-935f-dc3a772c1c0a', name: 'Geese', score: 87 },
  { id: '16a8a6cc-57d9-4a13-9fb9-c87e359c5abe', name: 'Geese', score: 85 },
  { id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Geesey', score: 70 },
]
const jakesGeese = ['Getting Killed', '3D Country', 'Projector', 'A Beautiful Memory', '4D Country']

describe('chooseArtistIdentity — the desktop resolver step', () => {
  it('Geese: the band that owns Jake\'s albums wins over the genre ranking', async () => {
    const fetched: string[] = []
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: ranked(), ownedAlbums: jakesGeese, fold,
      fetchReleaseGroups: async (id) => { fetched.push(id); return CATALOGUES[id] ?? [] },
    })
    assert.equal(r?.candidate.id, BROOKLYN)
    assert.equal(r?.identity, 'confirmed')
    assert.ok(!fetched.includes('aaaaaaaa-0000-0000-0000-000000000000'), 'a non-namesake costs no request')
  })
  it('namesakes the library cannot tell apart → ambiguous, never confirmed', async () => {
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: ranked(), ownedAlbums: ['Some Album Nobody Has'], fold,
      fetchReleaseGroups: async (id) => CATALOGUES[id] ?? [],
    })
    assert.equal(r?.identity, 'ambiguous')
  })
  it('no owned albums to ask → ambiguous without spending a request', async () => {
    let calls = 0
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: ranked(), ownedAlbums: [], fold,
      fetchReleaseGroups: async () => { calls++; return [] },
    })
    assert.equal(r?.identity, 'ambiguous')
    assert.equal(calls, 0)
  })
  it('one namesake → single, no evidence fetch', async () => {
    let calls = 0
    const r = await chooseArtistIdentity({
      name: 'Talking Heads', ranked: [{ id: 'th', name: 'Talking Heads', score: 100 }, { id: 'x', name: 'Talking Heads Tribute', score: 70 }],
      ownedAlbums: ['Remain in Light'], fold,
      fetchReleaseGroups: async () => { calls++; return [] },
    })
    assert.deepEqual([r?.candidate.id, r?.identity, calls], ['th', 'single', 0])
  })
  it('nobody claims the exact name → weak, the ranking\'s first', async () => {
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: [{ id: 'z', name: 'Geesey', score: 70 }], ownedAlbums: jakesGeese, fold,
      fetchReleaseGroups: async () => [],
    })
    assert.deepEqual([r?.candidate.id, r?.identity], ['z', 'weak'])
  })
  it('a failed evidence fetch is missing evidence: ambiguous AND incomplete (never cached)', async () => {
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: ranked(), ownedAlbums: jakesGeese, fold,
      fetchReleaseGroups: async (id) => { if (id === BROOKLYN) throw new Error('503'); return CATALOGUES[id] ?? [] },
    })
    assert.deepEqual([r?.identity, r?.incomplete], ['ambiguous', true])
  })
  it('a clean resolve carries no incomplete flag', async () => {
    const r = await chooseArtistIdentity({
      name: 'Geese', ranked: ranked(), ownedAlbums: jakesGeese, fold,
      fetchReleaseGroups: async (id) => CATALOGUES[id] ?? [],
    })
    assert.equal(r?.incomplete, undefined)
  })
})

// The foreign-catalogue guard lives in the release gate now
// (common/release-gate.ts identityVerdict, which replaced
// catalogueIsSomeoneElses on 2026-10-20 with the same rule).
describe('the foreign-catalogue guard (release-gate identityVerdict)', () => {
  const deps = { normTitle: normAlbumTitle, albumMatch: albumTitlesMatch }
  it('the shoegaze Geese catalogue is not Jake\'s Geese', () => {
    assert.equal(identityVerdict('single', CATALOGUES[SHOEGAZE]!, jakesGeese, deps).ok, false)
  })
  it('the Brooklyn catalogue is', () => {
    assert.equal(identityVerdict('confirmed', CATALOGUES[BROOKLYN]!, jakesGeese, deps).ok, true)
  })
  it('owned titles with no Latin letters cannot testify, so the guard stands down', () => {
    assert.equal(identityVerdict('single', ['Этажи', 'Монумент'], ['Этажи'], deps).ok, true)
  })
  it('deluxe and remaster suffixes still match', () => {
    assert.equal(albumTitlesMatch('3D Country (Deluxe)', '3D Country'), true)
    assert.equal(albumTitlesMatch('Nevermind [Remastered]', 'Nevermind'), true)
  })
})

describe('wiring — the desktop resolver and discography use the rule', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
  it('resolveCanonicalArtist settles namesakes with chooseArtistIdentity', () => {
    const body = src.slice(src.indexOf('async function resolveCanonicalArtist('), src.indexOf('async function getLibraryGenresForArtist('))
    assert.match(body, /chooseArtistIdentity\(/)
    assert.match(body, /getLibraryAlbumsForArtist\(/)
    assert.match(body, /if \(r\.status === 404\) return \[\]/, 'only a real "no such artist" is empty evidence; other failures throw')
    assert.match(body, /if \(!chosen\.incomplete\)/, 'an incomplete resolve is never written to the cache')
  })
  it('fetchArtistDiscography refuses ambiguous identities and foreign catalogues', () => {
    const disco = readFileSync(join(import.meta.dirname, '..', 'artist-discography.ts'), 'utf-8')
    const body = disco.slice(disco.indexOf('export async function fetchArtistDiscography('))
    assert.match(body, /identity === 'ambiguous'/)
    assert.match(body, /canon\.incomplete/)
    assert.match(body, /gateReleaseGroups\(/, 'the release gate judges identity (and the foreign-catalogue guard) for every release')
    assert.match(body, /if \(!gate\.identity\.ok\)/)
  })
  it('index.ts wires the discography module', () => {
    assert.match(src, /initArtistDiscography\(\{/)
  })
})
