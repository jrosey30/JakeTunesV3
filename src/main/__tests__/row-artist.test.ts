/**
 * Whether Apple's match of a row is still the artist the row names (JakeTunesMobile Brief 237). The rows
 * are real: seven strangers from the Listen List's own history, three of whose files are in Jake's library,
 * and songs of Jake's jotted by the names on them, where the file says what the right answer is.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/__tests__/rowArtist.test.ts, the same rows on the phone.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { matchNamesRowArtist } from '../../common/artist-credit.ts'
import { recordingSelectionFromJot, resolveRequestFor } from '../../common/record-shop-live.ts'
import { shopSnapshot } from '../../common/record-shop.ts'
import { recoFields, recoToQueueResult } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import type { Recommendation } from '../../renderer/types.ts'

// Real rows: what Jake named, and what Apple's match made of it.
const STRANGERS = [
  // Rows that were on the Listen List.
  { song: "It's Called: Freefall", artist: 'Rainbow Kitten Surprise', matchedTitle: "It's Called: Freefall (8D Audio)", matchedArtist: '8waves', matchedAlbum: '8D Audios of Popular Covers Vol. 7' },
  { song: 'Keasbey Nights', artist: 'Streetlight Manifesto', matchedTitle: 'Keasbey Nights', matchedArtist: 'Catch 22', matchedAlbum: 'Keasbey Nights' },
  { song: 'Drown', artist: 'The Smashing Pumpkins', album: 'El Sonido De Los 90', matchedTitle: 'Drown', matchedArtist: 'Lullaby Baby Trio', matchedAlbum: 'Lullaby Renditions of Smashing Pumpkins' },
  { song: 'Bite the bullet', artist: 'Natek', album: 'In search of ocean', matchedTitle: 'bite the bullet', matchedArtist: 'Jessica Baio', matchedAlbum: 'bite the bullet - Single' },
  { song: "I'm Gonna Get You (Original Remix Version)", artist: 'Bizarre Inc', album: 'Global Basics - Dance Music for the Millennium', matchedTitle: "I'm Gonna Get You", matchedArtist: 'Eddy Raven', matchedAlbum: 'Best of Eddy Raven' },
  { song: 'Good Times', artist: 'Nite Music', album: 'Good Times - Single', matchedArtist: 'Ferry Ultra' },
  { song: 'Floral & Fading', artist: 'Pierce the Veil', album: 'Misadventures', matchedTitle: 'Floral and Fading', matchedArtist: 'Sparrow Sleeps', matchedAlbum: 'Collide With the Night Sky: Lullaby covers of Pierce the Veil songs' },
  // Songs in Jake's library, jotted by the names on them.
  { song: 'Up Up & Away (The Wake & Bake Song)', artist: 'Kid Cudi', matchedTitle: 'Up Up & Away - The Wake & Bake Song (In the style of Kid Cudi) [Karaoke Version with Lead Vocal]', matchedArtist: 'Off the Record Karaoke', matchedAlbum: 'July 2010: Urban Hits (R&B, Hip Hop) [Karaoke]' },
  { song: 'Lately', artist: 'Massive Attack', matchedTitle: 'Lately Girl', matchedArtist: 'Dennis Brown', matchedAlbum: 'Massive Reggae Attack!' },
  { song: 'Dark Hands', artist: 'The Barigozzi Group', matchedTitle: 'Dark Hands', matchedArtist: 'Giancarlo Barigozzi, Oscar Rocchi & Sergio Farina', matchedAlbum: "Woman's Colours" },
  { song: 'Punched In The Head', artist: 'Cowboy Hunters', matchedTitle: 'Punched In The Head', matchedArtist: 'Drunks with Guns', matchedAlbum: 'Fucked Up On Beer & Drugs' },
  { song: 'Pulsar', artist: 'Rayzeh', matchedTitle: 'Pulsar Rays', matchedArtist: 'Dariush Derakhshani', matchedAlbum: 'Pulsar Rays - EP' },
  { song: 'NO SO BAD', artist: 'DJ Young Brown', matchedTitle: 'Down Bad (feat. JID, Bas, J. Cole, EARTHGANG & Young Nudy)', matchedArtist: 'Dreamville', matchedAlbum: "Revenge of the Dreamers III: Director's Cut" },
  { song: "Freedom Isn't Free", artist: 'Trey Parker', matchedTitle: "Freedom Isn't Free (Arr. M. Taylor)", matchedArtist: 'Steve Cramer & United States Army Band', matchedAlbum: 'Greenwood, L: God Bless the Usa / Jenkins, J.W: American Overture / Sousa, J.P: The Stars and Stripes Forever' },
]
const THE_SAME_ACT = [
  { song: 'We Found Love', artist: 'Calvin Harris', matchedTitle: 'We Found Love (feat. Calvin Harris)', matchedArtist: 'Rihanna', matchedAlbum: 'Talk That Talk' },
  { song: 'Greatest Show On Earth', artist: 'Macy Gray', matchedTitle: 'Greatest Show On Earth (feat. Macy Gray)', matchedArtist: 'Outkast', matchedAlbum: 'Idlewild' },
  { song: 'Survivalism (deadmau5 Remix)', artist: 'deadmau5', matchedTitle: 'Survivalism (feat. deadmau5) [deadmau5 Remix]', matchedArtist: 'Nine Inch Nails', matchedAlbum: 'While(1<2)' },
  { song: 'Fill Me In (AFTR:HRS Mixcut)', artist: 'Tiësto', matchedTitle: 'Fill Me In (AFTR:HRS Mixcut)', matchedArtist: 'Loud Luxury & Ryan Shepherd', matchedAlbum: 'AFTR:HRS (Mixed By Tiësto)' },
  { song: 'Desert Rose (Bedouin Remix)', artist: 'Bedouin', matchedTitle: 'Desert Rose (feat. Cheb Mami) [Bedouin Remix]', matchedArtist: 'Sting & Bedouin', matchedAlbum: 'Desert Rose (Reimagined) [feat. Cheb Mami]' },
  { song: 'Forever (Explicit Version)', artist: 'Kanye West', matchedTitle: 'Forever (with Drake, Kanye West & Lil Wayne)', matchedArtist: 'Drake, Kanye West, Lil Wayne & Eminem', matchedAlbum: 'Relapse: Refill' },
  { song: 'Great Southern Land', artist: 'ICEHOUSE', matchedTitle: 'Great Southern Land', matchedArtist: 'Cassian & ICEHOUSE', matchedAlbum: 'Great Southern Land - Single' },
  { song: "It's Time", artist: 'LSD, Diplo, Sia, Labrinth', matchedTitle: "It's Time (feat. Sia, Diplo & Labrinth)", matchedArtist: 'LSD', matchedAlbum: 'LABRINTH, SIA & DIPLO PRESENT... LSD' },
  { song: 'Rak Po (Only Here)', artist: 'הדג נחש', matchedTitle: 'Rak Po (Only Here)', matchedArtist: 'Hadag Nahash', matchedAlbum: 'Chomer Mekomi (Local Material)' },
  { song: 'נאחז בחלום', artist: 'ברי סחרוף', matchedTitle: 'נאחז בחלום', matchedArtist: 'Berry Sakharof', matchedAlbum: 'סולם האהבה' },
  { song: "Bonafied Lovin'", artist: 'Chromio', matchedTitle: "Bonafied Lovin'", matchedArtist: 'Chromeo', matchedAlbum: 'Fancy Footwork' },
  { song: 'Sex Week', artist: 'Coach', matchedTitle: 'Coach', matchedArtist: 'Sex Week', matchedAlbum: 'x' },
]

describe('Apple names another artist than the row does', () => {
  for (const rec of STRANGERS) it(`${rec.artist} is not ${rec.matchedArtist}`, () => assert.equal(matchNamesRowArtist(rec), false))
  for (const rec of THE_SAME_ACT) it(`${rec.artist} is ${rec.matchedArtist}`, () => assert.equal(matchNamesRowArtist(rec), true))

  it('a row that names nobody has nothing to contradict, nor a row with no match', () => {
    assert.equal(matchNamesRowArtist({ song: 'Song', matchedTitle: 'Song', matchedArtist: 'Band' }), true)
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: '   ', matchedTitle: 'Song', matchedArtist: 'Band' }), true)
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: 'Band' }), true)
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: 'Band', matchedArtist: '  ' }), true)
  })
  it('a band with no letters is itself, and nobody else', () => {
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: '!!!', matchedArtist: '!!!' }), true)
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: '!!!', matchedArtist: 'Stranger' }), false)
    assert.equal(matchNamesRowArtist({ song: 'Song', artist: '!!!', matchedArtist: '???' }), false)
  })
  it('a credit on the title has to be the whole name, in a credit', () => {
    const on = (artist: string, matchedTitle: string): boolean => matchNamesRowArtist({ song: 'x', artist, matchedTitle, matchedArtist: 'Someone Else' })
    assert.equal(on('Future', 'Song (feat. Future Islands)'), false, 'another act that starts the same')
    assert.equal(on('Rain', 'Rainbow'), false, 'a word in the title is no credit')
    assert.equal(on('Calvin Harris', 'Calvin Harris'), false, 'nor is a title that happens to be the name')
    assert.equal(on('Sia', 'Song [ft. Sia]'), true, 'square brackets')
    assert.equal(on('Sia', 'Song ft. Sia'), true, 'no brackets at all')
    assert.equal(on('Sia', 'Song featuring Diplo, Sia & Labrinth'), true, 'one of several')
    assert.equal(on('Sia', 'Song (with Diplo and Sia)'), true, '"with", and "and"')
    assert.equal(on('Earth and Fire', 'Song (feat. Earth and Fire)'), true, 'a name with "and" in it')
    assert.equal(on('Sia', 'Dancing with Sia'), false, '"with" outside a bracket is the song')
  })
  it('an album only credits by "mixed by": a tribute names the artist too', () => {
    const on = (artist: string, matchedAlbum: string): boolean => matchNamesRowArtist({ song: 'x', artist, matchedTitle: 'x', matchedArtist: 'Someone Else', matchedAlbum })
    assert.equal(on('Tiësto', 'Club Life (Mixed by Tiësto)'), true)
    assert.equal(on('Tiësto', 'Club Life Mixed By Tiesto'), true)
    assert.equal(on('Tiësto', 'Lullaby Renditions of Tiësto'), false)
    assert.equal(on('Tiësto', 'A Tribute to Tiësto'), false)
    assert.equal(on('Tiësto', 'Tiësto'), false)
  })
  it('another way of writing the credit, either way round', () => {
    const on = (artist: string, matchedArtist: string): boolean => matchNamesRowArtist({ song: 'x', artist, matchedTitle: 'x', matchedArtist })
    assert.equal(on('Richard F.', 'F. Richard'), true)
    assert.equal(on('Sia', 'Diplo, Sia & Labrinth'), true, 'under four letters containment says no')
    assert.equal(on('OMA & SitarNik', 'Oma'), true)
    assert.equal(on('Sly & the Family Stone', 'Sly'), false)
  })
  it('one letter off, on a name long enough for that to say something', () => {
    const on = (artist: string, matchedArtist: string): boolean => matchNamesRowArtist({ song: 'x', artist, matchedTitle: 'x', matchedArtist })
    assert.equal(on('Adele', 'Adela'), true)
    assert.equal(on('Sia', 'Mia'), false)
    assert.equal(on('Beck', 'Bick'), false)
    assert.equal(on('The Doors', 'The Kooks'), false, 'two letters')
  })
  it('two alphabets say nothing, and neither does one with two different names', () => {
    const on = (artist: string, matchedArtist: string): boolean => matchNamesRowArtist({ song: 'x', artist, matchedTitle: 'x', matchedArtist })
    assert.equal(on('Molchat Doma', 'Молчат Дома'), true)
    assert.equal(on('הדג נחש', 'ברי סחרוף'), false)
  })
  it('the other way round takes both names', () => {
    assert.equal(matchNamesRowArtist({ song: 'Sex Week', artist: 'Coach', matchedTitle: 'Other', matchedArtist: 'Sex Week' }), false)
    assert.equal(matchNamesRowArtist({ song: 'Sex Week', artist: 'Coach', matchedTitle: 'Coach', matchedArtist: 'Other' }), false)
    assert.equal(matchNamesRowArtist({ song: 'Bartender', artist: 'Lady', matchedTitle: 'Lady (feat. Akon)', matchedArtist: 'Bartender' }), true, 'a credit is not part of the name')
    assert.equal(matchNamesRowArtist({ artist: 'Coach', matchedTitle: 'Coach', matchedArtist: 'Sex Week' }), false, 'no song, nothing to swap')
  })
})

const row = (over: Partial<Recommendation>): Recommendation => ({ id: 'r', createdAt: '2026-11-05T04:14:15Z', ...over })

describe('what such a row asks a download for', () => {
  const fields = (rec: Partial<Recommendation>) => recoFields(row(rec))
  it('its own words, and nothing of the match: its album is the stranger\'s too', () => {
    assert.deepEqual(fields(STRANGERS[3]!), { title: 'Bite the bullet', artist: 'Natek', album: 'In search of ocean' })
    assert.deepEqual(fields(STRANGERS[6]!), { title: 'Floral & Fading', artist: 'Pierce the Veil', album: 'Misadventures' })
    assert.deepEqual(fields(STRANGERS[4]!), { title: "I'm Gonna Get You (Original Remix Version)", artist: 'Bizarre Inc', album: 'Global Basics - Dance Music for the Millennium' })
    assert.deepEqual(fields(STRANGERS[0]!), { title: "It's Called: Freefall", artist: 'Rainbow Kitten Surprise', album: '' })
    assert.deepEqual(fields(STRANGERS[5]!), { title: 'Good Times', artist: 'Nite Music', album: 'Good Times - Single' }, 'a match with only its artist left')
  })
  it('a right match still names the song and the record', () => {
    assert.deepEqual(fields(THE_SAME_ACT[0]!), { title: 'We Found Love (feat. Calvin Harris)', artist: 'Rihanna', album: 'Talk That Talk' })
    assert.deepEqual(fields(THE_SAME_ACT[8]!), { title: 'Rak Po (Only Here)', artist: 'Hadag Nahash', album: 'Chomer Mekomi (Local Material)' })
    assert.deepEqual(fields(THE_SAME_ACT[10]!), { title: "Bonafied Lovin'", artist: 'Chromeo', album: 'Fancy Footwork' })
    assert.deepEqual(fields(THE_SAME_ACT[11]!), { title: 'Coach', artist: 'Sex Week', album: 'x' })
  })
  it('the job in the queue carries the same names as the row', () => {
    const d = recoToQueueResult(row(STRANGERS[6]!))
    assert.equal(d.kind, 'queue')
    if (d.kind !== 'queue') return
    assert.equal(d.result.artist, 'Pierce the Veil')
    assert.equal(d.result.title, 'Floral & Fading')
    assert.equal(d.result.album, 'Misadventures')
    assert.equal(d.result.askedArtist, 'Pierce the Veil')
    assert.equal(d.result.desc, 'Floral & Fading — Pierce the Veil')
  })
  it('a song row stays a song row, and an album row an album row', () => {
    const album = recoToQueueResult(row({ kind: 'album', album: 'Misadventures', artist: 'Pierce the Veil', matchedArtist: 'Sparrow Sleeps', matchedAlbum: 'Lullabies' }))
    assert.deepEqual(album, { kind: 'select-edition', artist: 'Pierce the Veil', album: 'Misadventures' })
  })
})

describe('the Record Store reads a row the same way', () => {
  const song = shopSnapshot({ itemId: 'legacy-recommendation:r', kind: 'recording' as const, display: { title: 'x' } })
  const record = shopSnapshot({ itemId: 'legacy-recommendation:r', kind: 'release' as const, display: { title: 'x' } })
  const named = (rec: Partial<Recommendation>) => {
    const { artist, title, album } = recordingSelectionFromJot(row(rec))!.request
    return { artist, title, album }
  }
  it('a song row is selected by its own words, and a right match by Apple\'s', () => {
    assert.deepEqual(named(STRANGERS[6]!), { artist: 'Pierce the Veil', title: 'Floral & Fading', album: 'Misadventures' })
    assert.deepEqual(named(THE_SAME_ACT[0]!), { artist: 'Rihanna', title: 'We Found Love (feat. Calvin Harris)', album: 'Talk That Talk' })
  })
  it('it asks main about the row, not the stranger', () => {
    assert.deepEqual(resolveRequestFor(song, row(STRANGERS[3]!)), { kind: 'recording', artist: 'Natek', title: 'Bite the bullet', album: 'In search of ocean', durationSec: undefined })
    const lullabies = row({ kind: 'album', album: 'Misadventures', artist: 'Pierce the Veil', matchedArtist: 'Sparrow Sleeps', matchedAlbum: 'Lullabies' })
    assert.deepEqual(resolveRequestFor(record, lullabies), { kind: 'release', artist: 'Pierce the Veil', album: 'Misadventures', collectionId: undefined, trackCount: undefined, releaseYear: undefined })
  })
  it('a right match still asks main by Apple\'s names', () => {
    assert.deepEqual(resolveRequestFor(song, row(THE_SAME_ACT[0]!)), { kind: 'recording', artist: 'Rihanna', title: 'We Found Love (feat. Calvin Harris)', album: 'Talk That Talk', durationSec: undefined })
  })
})

describe('the wiring', () => {
  const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf-8')
  it('Get on a song in the Record Store takes the Listen List\'s door', () => {
    assert.match(src('../../renderer/record-shop/liveShopCommands.ts'), /const d = queueRecoDownload\(rec\)/)
  })
  it('the list groups a row by the names it will ask for', () => {
    assert.match(src('../../renderer/views/ListenToTheListView.tsx'), /const recoType = \(r: Recommendation\)[^\n]*\n\s+const \{ title: song, album \} = recoFields\(r\)/)
  })
  it('the Listen List shows the row by the names it will ask for', () => {
    assert.match(src('../../renderer/listen-to-the-list/components.tsx'), /export function displayRecoName\(rec: Recommendation\): string \{\n\s+const \{ title, artist \} = recoFields\(rec\)/)
  })
  it('a desktop add keeps no stranger, with homemini or without', () => {
    assert.match(src('../ipc/recommendations-ipc.ts'), /const found = await lookupItunesForRecommendation\(input\)\n[^\n]*\n\s+const enrichment: typeof found = matchNamesRowArtist\(\{ song: input\.song, artist: input\.artist, \.\.\.found \}\) \? found : \{\}/)
  })
  it('both bundles read the one rule', () => {
    assert.match(src('../reco-match.ts'), /export \{ recoArtistMatches, sameArtistName \}/)
    assert.match(src('../streamrip-match.ts'), /export \{ otherCredit \}/)
    assert.match(src('../../renderer/listen-to-the-list/store.ts'), /import \{ recoArtistMatches \} from '..\/..\/common\/artist-credit\.ts'/)
  })
})
