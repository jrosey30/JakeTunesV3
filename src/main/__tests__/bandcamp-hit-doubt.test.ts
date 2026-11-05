/**
 * Whose Bandcamp page is this? (2026-11-04). Every address, album and length below is a real
 * answer from Bandcamp's search on the app's runtime, for songs on Jake's list or in his library.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bandcampHitDoubt, isBandsOwnAddress } from '../streamrip-match.ts'

const page = (host: string, slug = 'song'): string => `https://${host}.bandcamp.com/track/${slug}`

describe('isBandsOwnAddress: the address names the band', () => {
  for (const [artist, host] of [
    ['Warmduscher', 'warmduscher'],
    ['Tigers Jaw', 'tigersjaw'],
    ['Golf Lexapro', 'golflexapro'],
    ['Pulp', 'pulpmusic'],
    ['Sap', 'sapmusic'],
    ['Hotel Pools', 'hotelpoolsmusic'],
    ['GRUB', 'grub5'],
    ['MESH', 'meshphilly'],
    ['Perennial', 'perennialtheband'],
    ['Jack White', 'officialjackwhite'],
    ['Deep Sea Diver', 'thedeepseadiver'],
    ['The Satisfactory', 'thesatisfactory23'],
    ['The Muckers', 'muckers'],
    ['Lindstrøm', 'lindstrom'],
    ['C.O.F.F.I.N', 'coffin-aus'],
    ['JER', 'jerband'],
    ['DMX', 'dmx'],
    ['Nas', 'nasmusic'],
    ['DMX', 'dmxofficial'],
    ['The Who', 'thewho'],
    ['The Who', 'who'],
    ['Kompromat, Vitalic, Rebeka Warrior', 'kompromat-official'],
    ['Justin Timberlake & Timbaland', 'timbaland'],
  ] as const) {
    test(`${host} is ${artist}'s`, () => assert.equal(isBandsOwnAddress(artist, page(host)), true))
  }

  for (const [artist, host, what] of [
    ['The Notorious B.I.G.', 'bstep', 'the fan upload that started this'],
    ['DMX', 'xrayrecordsdmx', "a label's re-cuts: the name is not at the start"],
    ['Pulp', 'antonofian', 'a second copy of More, on a stranger’s page'],
    ['Paperclip People', 'xxldancerecord', 'a dance comp'],
    ['The Pharcyde', 'craftrecordings', 'a real label, which the album has to vouch for'],
    ['Nas', 'nastyboyrecords', 'a short name gets no room to grow'],
    ['DMX', 'dmxrecordsfan', 'nor does this one'],
    ['Theatre', 'atrecords', 'only a whole "The" comes off a name'],
    ['MUGRE', 'bochademugre', 'the name has to come first: anywhere else, the album has to vouch'],
  ] as const) {
    test(`${host} is not ${artist}'s: ${what}`, () => assert.equal(isBandsOwnAddress(artist, page(host)), false))
  }

  test('a credit with an "and" in its name is one name, and "/" and "+" stay inside theirs', () => {
    assert.equal(isBandsOwnAddress('Noelle & The Deserters', page('noelleandthedeserters')), true)
    assert.equal(isBandsOwnAddress('AC/DC', page('acdc')), true)
    assert.equal(isBandsOwnAddress('C+C Music Factory', page('ccmusicfactory')), true)
  })

  test('a band on its own domain reads the same way, and nonsense is nobody’s', () => {
    assert.equal(isBandsOwnAddress('The Thermals', 'https://thethermals.com/track/here-s-your-future'), true)
    assert.equal(isBandsOwnAddress('The Thermals', 'https://www.thethermals.com/track/here-s-your-future'), true)
    assert.equal(isBandsOwnAddress('The Thermals', 'not a url'), false)
  })
})

describe('bandcampHitDoubt: a row with no length', () => {
  const row = (artist: string, title: string, album: string) => ({ artist, title, album })
  const onPage = (host: string, album: string | null, band = 'Someone') => ({ url: page(host), band, album })

  test('the fan upload: same tags, somebody else’s edition, 82 s short', () => {
    const doubt = bandcampHitDoubt(row('The Notorious B.I.G.', "Sky's the Limit (feat. 112) [Amended]", 'Life After Death [Amended Version] (2014 Remaster)'),
      { url: page('bstep', 'skys-the-limit'), band: 'The Notorious B.I.G.', album: 'Life After Death (Bstep Edition)' })
    assert.equal(doubt, 'is on someone else’s page, on “Life After Death (Bstep Edition)”, and there’s no length to check it against')
  })

  test('a mixtape or a comp on a stranger’s page', () => {
    for (const [artist, title, album, host, got] of [
      ['Paperclip People', 'Throw', 'The Secret Tapes of Dr. Eich', 'xxldancerecord', 'XXL Dance 4 Prt.2'],
      ['Childish Gambino', 'This Is America', 'This Is America - Single', 'experimentsfromj', 'Working With Samples'],
      ['Nas', 'The World Is Yours', 'Illmatic', 'matic', 'Illmatic (The Samples Edition)'],
      ['DMX', 'Party Up', '...And Then There Was X', 'cleopatrarecords', 'Greatest Hits With A Twist - Deluxe'],
    ] as const) {
      assert.ok(bandcampHitDoubt(row(artist, title, album), onPage(host, got, artist)), `${host} ${got}`)
    }
  })

  test('a real label’s page names the row’s album', () => {
    assert.equal(bandcampHitDoubt(row('The Pharcyde', "Passin' Me By", 'Bizarre Ride II The Pharcyde'), onPage('craftrecordings', 'Bizarre Ride II The Pharcyde', 'The Pharcyde')), null)
    assert.equal(bandcampHitDoubt(row('Paperclip People', 'Throw', 'The Secret Tapes of Dr. Eich'), onPage('planetecommunications', 'The Secret Tapes of Dr. Eich', 'Paperclip People')), null)
  })

  test('the same record in other packaging is the same album', () => {
    for (const [want, got] of [
      ['Life After Death [Amended Version] (2014 Remaster)', 'Life After Death'],
      ['Fantastic Planet', 'Fantastic Planet (Remastered)'],
      ['The Pinkprint (Deluxe)', 'The Pinkprint (Tenth Anniversary Deluxe)'],
      ['Some Record', 'Some Record (Deluxe Edition)'],
      ['Spirit Desire - EP', 'Spirit Desire ep'],
      ['Terapia - EP', 'Terapia EP'],
      ['Love Love (Love Love) - Single', 'Love Love (Love Love)'],
    ] as const) {
      assert.equal(bandcampHitDoubt(row('Someone', 'Song', want), onPage('somelabel', got)), null, `${want} / ${got}`)
    }
  })

  test('another record of the same name is not: an edition nobody recognises is somebody’s own', () => {
    for (const got of ['Life After Death (Bstep Edition)', 'Life After Death Instrumentals', 'Life After Death 2']) {
      assert.ok(bandcampHitDoubt(row('Someone', 'Song', 'Life After Death'), onPage('somelabel', got)), got)
    }
  })

  test('on the band’s own address it can sit on any album', () => {
    assert.equal(bandcampHitDoubt(row('Jack White', 'Derecho Demonico', 'G.O.D. And The Broken Ribs'), onPage('officialjackwhite', 'Frozen Charlotte', 'Jack White')), null)
  })

  test('an address that starts with the name is not the band’s under another name', () => {
    assert.ok(bandcampHitDoubt(row('MGMT', 'Future Reflections', 'Oracular Spectacular'), onPage('mgmtcoveralbum', 'R/MGMT 2', 'r/MGMT')))
    assert.ok(bandcampHitDoubt(row('Future', 'Like That', "WE DON'T TRUST YOU"), onPage('futuretalk', 'uncovered', 'future2')))
    assert.ok(bandcampHitDoubt(row('Nelly', 'Intro', 'Country Grammar'), onPage('nellyxarend', 'Irracional', 'Nelly x Arend')))
  })

  test('one credit of a joint band is enough, either way round', () => {
    assert.equal(bandcampHitDoubt(row('Kompromat', 'Das Konterfei', 'Other'), onPage('kompromat-official', 'Traum Und Existenz LP', 'KOMPROMAT, Vitalic, Rebeka Warrior')), null)
    assert.equal(bandcampHitDoubt(row('Kompromat, Vitalic', 'Das Konterfei', 'Other'), onPage('kompromat-official', 'Traum Und Existenz LP', 'Kompromat')), null)
  })

  test('a page with no album stands only for a single: a row whose album is named after the song', () => {
    const single = row('Assaf Michael', 'Montanita', 'Montanita - Single')
    assert.equal(bandcampHitDoubt(single, onPage('maccabihouse', null, 'Assaf Michael')), null)
    const featured = row('Parallelle', 'Moments (feat. Monday Michiru)', 'Moments (feat. Monday Michiru) - Single')
    assert.equal(bandcampHitDoubt(featured, onPage('somelabel', null, 'Parallelle')), null)
    const onAnAlbum = row('Kendrick Lamar', 'The Blacker the Berry', 'To Pimp a Butterfly')
    assert.equal(bandcampHitDoubt(onAnAlbum, onPage('zonaurbanaentertainment', null, 'Kendrick Lamar')), 'is on someone else’s page, and there’s no length to check it against')
  })

  test('a row that names no album has nothing to hold a page to: Apple has never heard of this one', () => {
    assert.equal(bandcampHitDoubt(row('Orbrose', 'Pieces', ''), onPage('somelabel', 'Whatever', 'Orbrose')), null)
  })
})
