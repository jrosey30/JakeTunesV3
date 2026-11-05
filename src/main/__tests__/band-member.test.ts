// In the band, under whatever name the sleeve credits them. Names from the 2026-11-05 audit
// of every album in the library.
import assert from 'node:assert/strict'
import test from 'node:test'
import { isBandMember, type CreditedPerson } from '../../common/band-member.ts'
import { nameKey } from '../../common/fold-text.ts'
import { isProductionCredit } from '../../common/personnel-roles.ts'

const rules = { nameKey: (s: string) => nameKey(s), isProductionCredit }

/** On `share` of a ten-song record, playing. */
function person(name: string, share = 1, role = 'guitar'): CreditedPerson {
  const tracks = Array.from({ length: Math.round(share * 10) }, (_, i) => i + 1)
  return { name, roles: [role], tracks: tracks.length, credits: [{ role, tracks }] }
}

const member = (name: string, artist: string, members: string[], share = 1, role = 'guitar') =>
  isBandMember(person(name, share, role), { artist, members, trackCount: 10 }, rules)

test('the same name, however it is spelled', () => {
  const cases: Array<[string, string, string[], number?]> = [
    ['David Grohl', 'Nirvana', ['Kurt Cobain', 'Krist Novoselic', 'Dave Grohl']],
    ['Chris Novoselic', 'Nirvana', ['Kurt Cobain', 'Krist Novoselic', 'Dave Grohl']],
    ['Fab Moretti', 'The Strokes', ['Fabrizio Moretti']],
    ['Nicholas Hexum', '311', ['Nick Hexum']],
    ['Timothy J. Mahoney', '311', ['Tim Mahoney']],
    ['Philip Anselmo', 'Pantera', ['Phil Anselmo']],
    ['Diamond Darrell', 'Pantera', ['Dimebag Darrell']],
    ['Michael Starr', 'Alice In Chains', ['Mike Starr']],
    ['Joshua Homme', 'Queens of the Stone Age', ['Josh Homme'], 0.3],
    ['Mikey Shuman', 'Queens of the Stone Age', ['Michael Shuman'], 0.2],
    ['Brad Nowell', 'Sublime', ['Bradley Nowell', 'Jakob Nowell'], 0.4],
    ['Ron Wood', 'The Rolling Stones', ['Ronnie Wood']],
    ['William H Duffy', 'The Cult', ['Billy Duffy']],
    ['Debbie Harry', 'Blondie', ['Deborah Harry'], 0.5],
    ['Marty Crandall', 'The Shins', ['Martin Crandall'], 0.1],
    ['Shanny Wise', 'Fcukers', ['Shannon Wise'], 0.1],
    ['A. Hughes', 'The Orb', ['Andy Hughes'], 0.1],
    ['Graham Goble', 'Little River Band', ['Graeham Goble']],
    ['Rick Formosa', 'Little River Band', ['Ric Formosa'], 0.2],
    ['David Lindqvist', 'Caesars', ['David Lindquist']],
    ['ed vedder', 'Pearl Jam', ['Eddie Vedder']],
    ['Jeffrey Porcaro', 'Toto', ['Mike Porcaro', 'Jeff Porcaro']],
    ['D.J. Homicide', 'Sugar Ray', ['DJ Homicide'], 0.1],
    ['Slim Kid 3', 'The Pharcyde', ['SLIMKID3'], 0.1],
    ['Jack White III', 'The White Stripes', ['Jack White', 'Meg White'], 0.2],
  ]
  for (const [name, artist, members, share] of cases) assert.equal(member(name, artist, members, share ?? 1), true, name)
})

test('a credit that is part of the name, or holds it', () => {
  const cases: Array<[string, string, string[], number?]> = [
    ['Axl', "Guns N' Roses", ['Axl Rose']],
    ['Duff', "Guns N' Roses", ['Duff McKagan']],
    ['Billie Joe', 'Green Day', ['Billie Joe Armstrong'], 0.3],
    ['David Roth', 'Van Halen', ['David Lee Roth']],
    ['Todd Lewis', 'Toadies', ['Vaden Todd Lewis']],
    ['Melle Mel', 'Grandmaster Flash & The Furious Five', ['Grandmaster Melle Mel'], 0.1],
    ['Feist', 'Broken Social Scene', ['Leslie Feist'], 0.1],
    ['Diff', 'Lifehouse', ['Jon "Diff" Palmer']],
    ['Mark “Fish Guts” Hoppus', 'blink-182', ['Mark Hoppus']],
    ['Travis Landon Barker', 'blink-182', ['Travis Barker']],
    ['Terry “Geezer” Butler', 'Black Sabbath', ['Geezer Butler']],
    ["'Fast' Eddie Clarke", 'Motörhead', ['Eddie Clarke']],
    ["Ian 'Lemmy' Kilmister", 'Motörhead', ['Lemmy Kilmister']],
    ['Donald (Buck Dharma) Roeser', 'Blue Öyster Cult', ['Buck Dharma']],
    ['MC Adam Yauch', 'Beastie Boys', ['Adam Yauch']],
    ["Howlin' Pelle Almqvist", 'The Hives', ['Pelle Almqvist']],
    ['His Royal Highness Prince Chris Dangerous', 'The Hives', ['Chris Dangerous']],
  ]
  for (const [name, artist, members, share] of cases) assert.equal(member(name, artist, members, share ?? 1), true, name)
})

test('a one-word member inside a longer credit: quoted, or on half the record', () => {
  assert.equal(member('Rostam Batmanglij', 'Vampire Weekend', ['Rostam']), true)
  assert.equal(member('Chris Baio', 'Vampire Weekend', ['Baio']), true)
  assert.equal(member('Cheryl "Salt" James', 'Salt-N-Pepa', ['Salt'], 0.1), true)
  assert.equal(member('Mike Rostam', 'Vampire Weekend', ['Rostam'], 0.1), false)
})

test('a solo artist under their own name; a band name never makes a member', () => {
  assert.equal(member('Abel "The Weeknd" Tesfaye', 'The Weeknd', []), true)
  assert.equal(member('Prince Rogers Nelson', 'Prince', []), true)
  assert.equal(member('Jack White III', 'Jack White', []), true)
  assert.equal(member('Jan Van Halen', 'Van Halen', ['Eddie Van Halen', 'Alex Van Halen', 'Wolfgang Van Halen'], 0.1), false)
  assert.equal(member('Jan Van Halen', 'Van Halen', ['Eddie Van Halen', 'Alex Van Halen'], 1), false)
})

test('the same surname is not the same person, however much they play', () => {
  const cases: Array<[string, string, string[], number?]> = [
    ['Murry Wilson', 'The Beach Boys', ['Brian Wilson', 'Carl Wilson', 'Dennis Wilson', 'Mike Love', 'Al Jardine'], 0.2],
    ['Murry Wilson', 'The Beach Boys', ['Brian Wilson', 'Carl Wilson', 'Dennis Wilson'], 1],
    ['Hollie Fallon', 'The Gaslight Anthem', ['Brian Fallon']],
    ['Jackie Johnson', 'Primal Scream', ['Denise Johnson']],
    ['Smokey Parsons', 'The Alan Parsons Project', ['Alan Parsons']],
    ['Scott Borland', 'Limp Bizkit', ['Wes Borland'], 0.4],
    ['Matthew McKagan', "Guns N' Roses", ['Duff McKagan'], 0.1],
    ['Linda McCartney', 'The Beatles', ['Paul McCartney', 'John Lennon'], 0.1],
    ['Gail Frusciante', 'Red Hot Chili Peppers', ['John Frusciante'], 0.1],
    ['Violet Grohl', 'Foo Fighters', ['Dave Grohl'], 0.1],
    ['Harry Waters', 'Pink Floyd', ['Roger Waters'], 0.1],
    ['Marty Paich', 'Toto', ['David Paich'], 0.1],
    ['Melanie Crandall', 'The Shins', ['Martin Crandall'], 0.1],
    ['Michelle Nolan', 'Taking Back Sunday', ['John Nolan'], 0.2],
    ['Brody Dalle-Homme', 'Queens of the Stone Age', ['Josh Homme'], 0.1],
    ['Clydie King', 'Lynyrd Skynyrd', ['Ed King'], 0.1],
    ['Bobby Keys', 'Lynyrd Skynyrd', ['Peter Keys'], 0.1],
    ['Patti Smith', 'Blue Öyster Cult', ['Greg Smith'], 0.1],
    ['George Young', 'AC/DC', ['Angus Young', 'Malcolm Young', 'Stevie Young'], 0.1],
    ['Christine Fuemana', 'OMC', ['Chris Fuemana'], 0.1],
  ]
  for (const [name, artist, members, share] of cases) assert.equal(member(name, artist, members, share ?? 1), false, name)
})

test('not one person, or no way to tell: a guest', () => {
  assert.equal(member('Vanda & Young', 'AC/DC', ['Angus Young', 'Malcolm Young']), false)
  assert.equal(member('John Bonham Drum Orchestra', 'Led Zeppelin', ['John Bonham'], 0.1), false)
  assert.equal(member('Grandmaster Melle Mel & The Furious Five', 'Grandmaster Flash & The Furious Five', ['Grandmaster Melle Mel']), false)
  // Stage names with nothing in common: left alone rather than guessed.
  assert.equal(member('Count SA', '311', ['S.A. Martinez']), false)
  assert.equal(member('David Evans', 'U2', ['The Edge', 'Bono']), false)
  // Playing on every track isn't membership: Magdalena Bay's strings, Eno on Remain in Light.
  assert.equal(member('Tove Lund', 'Magdalena Bay', ['Mica Tenenbaum', 'Matthew Lewin']), false)
  assert.equal(member('Brian Eno', 'Talking Heads', ['David Byrne', 'Tina Weymouth', 'Chris Frantz', 'Jerry Harrison']), false)
})

test('only a production credit is never a fuzzy match, and the exact rules stand', () => {
  assert.equal(member('Christopher Walla', 'Death Cab For Cutie', ['Chris Walla'], 1, 'producer'), false)
  assert.equal(member('Chris Walla', 'Death Cab For Cutie', ['Chris Walla'], 1, 'producer'), true, 'an exact member is flagged; the sleeve order then sorts them')
  assert.equal(member('Nirvana', 'Nirvana', []), true)
  assert.equal(member('', 'Nirvana', ['Kurt Cobain']), false)
  // Credited on the release as a whole counts as all of it; older data has no credits at all.
  const release: CreditedPerson = { name: 'Chris Novoselic', roles: ['bass'], tracks: 0, credits: [{ role: 'bass', tracks: [] }] }
  assert.equal(isBandMember(release, { artist: 'Nirvana', members: ['Krist Novoselic'], trackCount: 12 }, rules), true)
  const bare: CreditedPerson = { name: 'Chris Novoselic', roles: ['bass'], tracks: 12 }
  assert.equal(isBandMember(bare, { artist: 'Nirvana', members: ['Krist Novoselic'], trackCount: 12 }, rules), true)
  // First names that don't relate need half the record.
  const barely: CreditedPerson = { name: 'Diamond Darrell', roles: ['guitar'], tracks: 1 }
  assert.equal(isBandMember(barely, { artist: 'Pantera', members: ['Dimebag Darrell'], trackCount: 12 }, rules), false)
  assert.equal(isBandMember({ ...barely, tracks: 6 }, { artist: 'Pantera', members: ['Dimebag Darrell'], trackCount: 12 }, rules), true)
})
