// Personnel as a sleeve prints it (common/personnel-roles.ts). The data is
// Abbey Road's MusicBrainz credits exactly as the album page received them
// on 2026-10-30 (Jake: "this is no way to list personnel"), and — for the
// per-track numbers — the recorded 1969 UK release (fixtures/
// album-personnel-abbey-road-2026-10-30.json; Jake, same day: "i want to
// know which personnel sings on which tracks").
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arrangePersonnel, personnelPreview, summarizeRoles, formatTrackList, partOf, ROLES_SHOWN, WHOLE_RECORD_SHARE, type PersonnelPerson } from '../../common/personnel-roles.ts'
import { peopleFromRelease, releaseTrackCount, type MbReleaseDetail } from '../album-personnel.ts'

const ABBEY_ROAD = [
  { name: 'George Martin', roles: ['conductor', 'hammond organ', 'harpsichord', 'electronic organ', 'producer'], tracks: 17 },
  { name: 'Paul McCartney', roles: ['background vocals', 'electric bass guitar', 'lead vocals', 'piano', 'handclaps', 'moog', 'tubular bells', 'electric guitar', 'acoustic guitar'], tracks: 17, member: true },
  { name: 'George Harrison', roles: ['electric guitar', 'background vocals', 'lead vocals', 'electric bass guitar', 'handclaps', 'acoustic guitar', 'guitar', 'synthesizer', 'moog'], tracks: 16, member: true },
  { name: 'Ringo Starr', roles: ['drums', 'maracas', 'tambourine', 'handclaps', 'background vocals', 'lead vocals', 'percussion', 'anvil', 'effects', 'congas'], tracks: 16, member: true },
  { name: 'John Lennon', roles: ['electric guitar', 'lead vocals', 'background vocals', 'piano', '12 string guitar', 'tambourine', 'electric piano', 'handclaps', 'moog'], tracks: 15, member: true },
  { name: 'Billy Preston', roles: ['hammond organ', 'organ'], tracks: 2 },
  { name: 'Phil McDonald', roles: ['engineer'], tracks: 9 },
  { name: 'Geoff Emerick', roles: ['engineer'], tracks: 14 },
  { name: 'Mal Evans', roles: ['anvil', 'handclaps'], tracks: 1 },
]

test('summarizeRoles: families merge, noise goes, the main credit leads, at most four shown', () => {
  assert.deepEqual(summarizeRoles(['background vocals', 'electric bass guitar', 'lead vocals', 'piano', 'handclaps', 'moog', 'tubular bells', 'electric guitar', 'acoustic guitar']).shown,
    ['lead vocals', 'guitars', 'bass', 'keyboards'])
  // A drummer who sang one: drums lead, the voice follows. The tooltip keeps
  // every credit as MusicBrainz names it (lead vocals first within the voice).
  const ringo = summarizeRoles(['drums', 'maracas', 'tambourine', 'handclaps', 'background vocals', 'lead vocals', 'percussion', 'anvil', 'effects', 'congas'])
  assert.deepEqual(ringo.shown, ['drums', 'lead vocals', 'percussion'])
  assert.deepEqual(ringo.all, ['drums', 'lead vocals', 'background vocals', 'maracas', 'tambourine', 'percussion', 'anvil', 'congas'])
  assert.deepEqual(summarizeRoles(['electric guitar', 'lead vocals', 'background vocals', 'piano', '12 string guitar', 'tambourine', 'electric piano', 'handclaps', 'moog']).shown,
    ['guitars', 'lead vocals', 'keyboards', 'percussion'])
  // One instrument in a family keeps its name; two become the family.
  assert.deepEqual(summarizeRoles(['hammond organ', 'organ']).shown, ['organ'])
  assert.deepEqual(summarizeRoles(['acoustic guitar']).shown, ['acoustic guitar'])
  // Parts played lead by default; the production group puts the credit first.
  assert.deepEqual(summarizeRoles(['conductor', 'hammond organ', 'harpsichord', 'electronic organ', 'producer']).shown, ['keyboards', 'producer', 'conductor'])
  assert.deepEqual(summarizeRoles(['conductor', 'hammond organ', 'harpsichord', 'electronic organ', 'producer'], { productionFirst: true }).shown, ['producer', 'conductor', 'keyboards'])
  // A band member who co-produced: what they played first, then the credit.
  assert.deepEqual(summarizeRoles(['lead vocals', 'guitar', 'producer']).shown, ['lead vocals', 'guitar', 'producer'])
  assert.deepEqual(summarizeRoles(['performer']).all, [])
  assert.deepEqual(summarizeRoles(['handclaps', 'effects']).all, [])
  const many = summarizeRoles(['lead vocals', 'guitar', 'bass guitar', 'drums', 'piano', 'violin', 'trumpet'])
  assert.equal(many.shown.length, ROLES_SHOWN)
  assert.deepEqual(many.shown, ['lead vocals', 'guitar', 'bass', 'drums'])
  assert.deepEqual(many.all, ['lead vocals', 'guitar', 'bass guitar', 'drums', 'piano', 'violin', 'trumpet'])
  // "recording engineer" is engineering, not an instrument called recording.
  assert.deepEqual(summarizeRoles(['recording engineer', 'mix']).shown, ['engineer', 'mixing'])
  assert.deepEqual(summarizeRoles(['recording engineer', 'mix']).all, ['recording engineer', 'mix'])
})

test('arrangePersonnel: the band by songs, then guests, then production — the producer first', () => {
  const lines = arrangePersonnel(ABBEY_ROAD)
  assert.deepEqual(lines.map((l) => `${l.group}:${l.name}`), [
    'band:Paul McCartney', 'band:George Harrison', 'band:Ringo Starr', 'band:John Lennon',
    'guest:Billy Preston', 'guest:Mal Evans',
    'production:George Martin', 'production:Geoff Emerick', 'production:Phil McDonald',
  ])
  // George Martin produced it: production, the credit first, even though he also played.
  assert.deepEqual(lines[6]!.roles, ['producer', 'conductor', 'keyboards'])
  // Mal Evans: the anvil on Maxwell's Silver Hammer is percussion; the handclaps are noise.
  assert.deepEqual(lines[5]!.roles, ['percussion'])
})

test('arrangePersonnel: no member data → players by songs, production last; a member credited only as engineer is production', () => {
  const lines = arrangePersonnel([
    { name: 'A', roles: ['engineer'], tracks: 10, member: true },
    { name: 'B', roles: ['guitar'], tracks: 3 },
    { name: 'C', roles: ['lead vocals'], tracks: 9 },
  ])
  assert.deepEqual(lines.map((l) => `${l.group}:${l.name}`), ['guest:C', 'guest:B', 'production:A'])
})

test('personnelPreview: the band and the producer make the cut before a guest with an anvil', () => {
  const lines = arrangePersonnel(ABBEY_ROAD)
  assert.deepEqual(personnelPreview(lines, 6).map((l) => l.name), ['Paul McCartney', 'George Harrison', 'Ringo Starr', 'John Lennon', 'Billy Preston', 'George Martin'])
  assert.deepEqual(personnelPreview(lines, 4).map((l) => l.name), ['Paul McCartney', 'George Harrison', 'Ringo Starr', 'John Lennon'])
  assert.equal(personnelPreview(lines, 20).length, lines.length)
})

describe('track numbers — which tracks a part is on (Abbey Road, the recorded 1969 UK release)', () => {
  const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'album-personnel-abbey-road-2026-10-30.json'), 'utf-8')) as { release: MbReleaseDetail }
  const BEATLES = new Set(['Paul McCartney', 'George Harrison', 'Ringo Starr', 'John Lennon'])
  const people: PersonnelPerson[] = peopleFromRelease(FIX.release).map((p) => (BEATLES.has(p.name) ? { ...p, member: true } : p))
  const trackCount = releaseTrackCount(FIX.release)
  const lines = arrangePersonnel(people, trackCount)
  const line = (name: string) => lines.find((l) => l.name === name)!

  test('the release has 17 tracks; Octopus\'s Garden is 5', () => {
    assert.equal(trackCount, 17)
    assert.equal(FIX.release.media![0]!.tracks![4]!.title, 'Octopus’s Garden')
  })

  test('Ringo: drums bare (15 of 17 — no drums on Because or Her Majesty), lead vocals on 5 and 15, percussion where he shook something', () => {
    assert.deepEqual(line('Ringo Starr').roles, ['drums', 'lead vocals (5, 15)', 'percussion (1, 3, 6, 9–13)'])
    // The tooltip: every credit as MusicBrainz names it, numbered unless on every track.
    assert.deepEqual(line('Ringo Starr').allRoles, ['drums (1–7, 9–16)', 'lead vocals (5, 15)', 'background vocals (3, 16)', 'maracas (1, 10–13)', 'tambourine (9–13)', 'percussion (12, 13)', 'anvil (3)', 'congas (6)'])
  })

  test('Paul: lead vocals on his ten, guitars on two, bass bare (12 of 17 — George took four), keyboards where he played them', () => {
    assert.deepEqual(line('Paul McCartney').roles, ['lead vocals (3, 4, 8–10, 13–17)', 'guitars (16, 17)', 'bass', 'keyboards (3–5, 9, 14–16)'])
    assert.deepEqual(line('Paul McCartney').allRoles, [
      'lead vocals (3, 4, 8–10, 13–17)', 'background vocals (1–7, 9, 11–13)', 'electric guitar (16)', 'acoustic guitar (17)',
      'electric bass guitar (1, 2, 5–13, 16)', 'piano (3–5, 9, 14–16)', 'moog (3)', 'tubular bells (9)',
    ])
  })

  test('George and John: the merged guitars carry the union of their guitar credits', () => {
    assert.deepEqual(line('George Harrison').roles, ['guitars', 'lead vocals (2, 7, 8, 10, 15)', 'bass (3, 4, 14, 15)', 'synthesizer (7, 8)'])
    assert.deepEqual(line('John Lennon').roles, ['guitars (1, 4–6, 8–13, 16)', 'lead vocals (1, 6, 8, 10–12, 15)', 'keyboards (1, 2, 6, 10, 11)', 'percussion (1)'])
    assert.ok(line('John Lennon').allRoles.includes('12 string guitar (12, 13)'))
  })

  test('George Martin: producer bare (credited on the release itself), the conductor and arranger songs, the keyboards with numbers', () => {
    assert.deepEqual(line('George Martin').roles, ['producer', 'conductor (14, 15)', 'arranger (2, 14)', 'keyboards (3, 8, 10)'])
    assert.deepEqual(line('George Martin').allRoles, ['producer', 'conductor (14, 15)', 'arranger (2, 14)', 'hammond organ (3)', 'harpsichord (8)', 'electronic organ (10)'])
    assert.equal(line('George Martin').group, 'production')
  })

  test('a guest\'s one part names its tracks; the tooltip keeps hammond organ and organ apart', () => {
    assert.deepEqual(line('Billy Preston').roles, ['organ (2, 6)'])
    assert.deepEqual(line('Billy Preston').allRoles, ['hammond organ (2, 6)', 'organ (6)'])
    assert.equal(line('Billy Preston').group, 'guest')
  })

  test('engineers: on every track bare with no tooltip to add; on most, bare on the line but numbered in the tooltip; on a few, numbered', () => {
    assert.deepEqual(line('Phil McDonald').roles, ['engineer'])
    assert.deepEqual(line('Phil McDonald').allRoles, ['engineer'])
    assert.deepEqual(line('Geoff Emerick').roles, ['engineer'])
    assert.deepEqual(line('Geoff Emerick').allRoles, ['engineer (1, 2, 4, 6–16)'])
    assert.deepEqual(line('Barry Sheffield').roles, ['engineer (6)'])
    assert.deepEqual(line('Glyn Johns').roles, ['producer (6)', 'engineer (2, 9)'])
  })

  test('the order: the four by songs, the guest, then production with the producers first', () => {
    assert.deepEqual(lines.map((l) => l.name), [
      'Paul McCartney', 'George Harrison', 'Ringo Starr', 'John Lennon', 'Billy Preston',
      'George Martin', 'Chris Thomas', 'Glyn Johns', 'Phil McDonald', 'Geoff Emerick', 'Jeff Jarratt', 'Barry Sheffield',
    ])
    assert.deepEqual(personnelPreview(lines, 6).map((l) => l.name), ['Paul McCartney', 'George Harrison', 'Ringo Starr', 'John Lennon', 'Billy Preston', 'George Martin'])
  })
})

describe('track numbers — the rules', () => {
  test('formatTrackList: ascending, deduped, runs of three or more collapsed with an en dash, pairs stay apart', () => {
    assert.equal(formatTrackList([11, 7, 4, 3, 2, 1]), '1–4, 7, 11')
    assert.equal(formatTrackList([1, 2]), '1, 2')
    assert.equal(formatTrackList([5, 6, 7]), '5–7')
    assert.equal(formatTrackList([3, 3, 1, 0, -2]), '1, 3')
    assert.equal(formatTrackList([]), '')
    assert.equal(partOf('lead vocals (5, 15)'), 'lead vocals')
    assert.equal(partOf('producer'), 'producer')
  })

  test(`a part on at least two thirds of the record prints bare; under that it carries its tracks (WHOLE_RECORD_SHARE = ${WHOLE_RECORD_SHARE.toFixed(3)})`, () => {
    const on = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    const part = (tracks: number[], trackCount: number) => summarizeRoles(['guitar'], { credits: [{ role: 'guitar', tracks }], trackCount }).shown[0]
    assert.equal(part(on(17), 17), 'guitar')
    assert.equal(part(on(15), 17), 'guitar', '15 of 17: Ringo\'s drums stay bare')
    assert.equal(part(on(12), 17), 'guitar', '12 of 17: Paul\'s bass stays bare')
    assert.equal(part(on(11), 17), 'guitar (1–11)', '11 of 17 is under two thirds')
    assert.equal(part(on(10), 17), 'guitar (1–10)')
    assert.equal(part([1, 2, 3, 4, 5, 6, 7], 10), 'guitar')
    assert.equal(part([1, 2, 3, 4, 5, 6], 10), 'guitar (1–6)')
    assert.equal(part([1, 2], 3), 'guitar', 'two of three is two thirds')
    assert.equal(part([2], 3), 'guitar (2)')
    assert.equal(part([3, 4], 3), 'guitar', 'odd numbers above the count are still two of three')
    assert.equal(WHOLE_RECORD_SHARE, 2 / 3)
  })

  test('a release-level credit (tracks: []) covers the whole record; without credits or a track count, parts print bare', () => {
    assert.deepEqual(summarizeRoles(['producer'], { credits: [{ role: 'producer', tracks: [] }], trackCount: 17 }).shown, ['producer'])
    assert.deepEqual(summarizeRoles(['guitar'], { credits: [{ role: 'guitar', tracks: [2] }] }).shown, ['guitar'], 'no track count')
    assert.deepEqual(summarizeRoles(['guitar'], { trackCount: 17 }).shown, ['guitar'], 'no credits')
    assert.deepEqual(summarizeRoles(['guitar', 'piano'], { credits: [{ role: 'guitar', tracks: [2] }], trackCount: 17 }).shown, ['guitar (2)', 'piano'], 'a role without a credit entry prints bare')
    // Release-level in one credit of a merged family covers the family.
    assert.deepEqual(summarizeRoles(['electric guitar', 'acoustic guitar'], { credits: [{ role: 'electric guitar', tracks: [] }, { role: 'acoustic guitar', tracks: [3] }], trackCount: 12 }).shown, ['guitars'])
  })

  test('lead vocals count only the lead-vocal credits; a voice without a lead credit is "vocals" with the union', () => {
    const ringo = summarizeRoles(['drums', 'background vocals', 'lead vocals'], { credits: [{ role: 'drums', tracks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, { role: 'background vocals', tracks: [3, 9] }, { role: 'lead vocals', tracks: [5] }], trackCount: 10 })
    assert.deepEqual(ringo.shown, ['drums', 'lead vocals (5)'])
    assert.deepEqual(ringo.all, ['drums', 'lead vocals (5)', 'background vocals (3, 9)'])
    const choir = summarizeRoles(['background vocals', 'choir'], { credits: [{ role: 'background vocals', tracks: [1, 2] }, { role: 'choir', tracks: [4] }], trackCount: 10 })
    assert.deepEqual(choir.shown, ['vocals (1, 2, 4)'])
  })

  test('the hand-written data (no credits) still reads as before — parts bare, nothing numbered', () => {
    const lines = arrangePersonnel(ABBEY_ROAD, 17)
    assert.deepEqual(lines.find((l) => l.name === 'Ringo Starr')!.roles, ['drums', 'lead vocals', 'percussion'])
    assert.deepEqual(lines.find((l) => l.name === 'George Martin')!.roles, ['producer', 'conductor', 'keyboards'])
    assert.ok(lines.every((l) => l.allRoles.every((r) => partOf(r) === r)))
  })
})
