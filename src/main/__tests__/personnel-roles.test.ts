// Personnel as a sleeve prints it (common/personnel-roles.ts). The data is
// Abbey Road's MusicBrainz credits exactly as the album page received them
// on 2026-10-30 (Jake: "this is no way to list personnel").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrangePersonnel, personnelPreview, summarizeRoles, ROLES_SHOWN } from '../../common/personnel-roles.ts'

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
  // A drummer who sang one: drums lead, the voice follows.
  const ringo = summarizeRoles(['drums', 'maracas', 'tambourine', 'handclaps', 'background vocals', 'lead vocals', 'percussion', 'anvil', 'effects', 'congas'])
  assert.deepEqual(ringo.shown, ['drums', 'lead vocals', 'percussion'])
  assert.deepEqual(ringo.all, ['drums', 'lead vocals', 'percussion'])
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
  assert.deepEqual(many.all, ['lead vocals', 'guitar', 'bass', 'drums', 'piano', 'violin', 'trumpet'])
  // "recording engineer" is engineering, not an instrument called recording.
  assert.deepEqual(summarizeRoles(['recording engineer', 'mix']).all, ['engineer', 'mixing'])
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
