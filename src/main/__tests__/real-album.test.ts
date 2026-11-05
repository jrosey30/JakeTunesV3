import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { albumToLookFor, allRecordings, ownedAlbumSpelling, ownedAlbumTest, pickRealAlbum, realAlbumFold, realAlbumQuery, type MbRecording, type RealAlbum } from '../../common/real-album.ts'

// ⚠️ TWIN: JakeTunesMobile backend/src/util/__tests__/realAlbum.test.ts, and the same fixture.
// Real MusicBrainz answers (2026-11-05), every page, cut down to what the rule reads.
const ANSWERS = JSON.parse(readFileSync(new URL('./fixtures/real-album-musicbrainz.json', import.meta.url), 'utf8')) as Record<string, MbRecording[]>

const pick = (key: string, durationsSec: number[] = [], extra: { title?: string; artist?: string; owned?: (album: string) => boolean } = {}): RealAlbum | null => {
  const [artist, title] = key.split(' - ')
  return pickRealAlbum(ANSWERS[key]!, { title: extra.title ?? title!, artist: extra.artist ?? artist!, durationsSec, owned: extra.owned })
}

describe('which album a song is really on, on real answers', () => {
  it('Blur, "Girls and Boys": Parklife, as Parklife prints it', () => {
    const r = pick('Blur - Girls and Boys', [291.2, 258.8])!
    assert.equal(r.album, 'Parklife')
    assert.equal(r.year, 1994)
    assert.equal(r.trackNumber, 1)
    assert.equal(r.trackCount, 16)
    assert.equal(r.title, 'Girls & Boys')
    assert.equal(r.releaseGroupId, '67461c8e-d864-3910-9bf4-39e44357aac9')
    assert.equal(r.confidence, 'high')
  })

  it('The Killers, "Read My Mind" off Direct Hits: Sam\'s Town, in the store\'s spelling, with a number that counts', () => {
    const r = pick('The Killers - Read My Mind', [246])!
    assert.equal(r.album, "Sam's Town", 'MusicBrainz prints a curly apostrophe')
    assert.equal(r.year, 2006)
    assert.equal(r.trackNumber, 6, 'the first pressing calls it B1 or so')
    assert.equal(r.confidence, 'high')
  })

  it('Sick Puppies, "You\'re Going Down" off Rock Workout: Tri-Polar with a plain hyphen', () => {
    const r = pick("Sick Puppies - You're Going Down", [187])!
    assert.equal(r.album, 'Tri-Polar')
    assert.equal(r.title, "You're Going Down")
    assert.equal(r.year, 2009)
  })

  it('Dobie Gray, "Drift Away" off Ultimate Collection: the 1973 album, on page two, not 2004\'s re-recording', () => {
    const r = pick('Dobie Gray - Drift Away', [237])!
    assert.equal(r.album, 'Drift Away')
    assert.equal(r.year, 1973)
    assert.equal(r.trackNumber, 1)
    assert.deepEqual(r.realAlbums, ['Drift Away'], 'the 4:41 take on Other Classics is another recording')
    assert.equal(r.confidence, 'high')
  })

  it('Ray Charles, "Hit the Road Jack" off True Genius: out in 1961, on no album until reissues, so not certain', () => {
    const r = pick('Ray Charles - Hit the Road Jack', [120])!
    assert.equal(r.lateAlbum, true)
    assert.equal(r.confidence, 'low')
  })

  it('Nancy Sinatra: Boots, the album\'s track and not the "(mono)" bonus', () => {
    const r = pick("Nancy Sinatra - These Boots Are Made for Walkin'", [165])!
    assert.equal(r.album, 'Boots')
    assert.equal(r.year, 1966)
    assert.equal(r.trackNumber, 5)
    assert.equal(r.title, "These Boots Are Made for Walkin'")
  })

  it('Rihanna, "We Found Love": Talk That Talk, not the producer\'s 18 Months', () => {
    const r = pick('Rihanna - We Found Love', [215], { title: 'We Found Love (feat. Calvin Harris)' })!
    assert.equal(r.album, 'Talk That Talk')
    assert.equal(r.year, 2011)
    assert.deepEqual(r.realAlbums, ['Talk That Talk'])
  })

  it('Backstreet Boys, "Larger Than Life" off Now 4: Millennium', () => {
    const r = pick('Backstreet Boys - Larger Than Life', [232])!
    assert.equal(r.album, 'Millennium')
    assert.equal(r.year, 1999)
    assert.equal(r.trackNumber, 1)
  })

  it('David Bowie, "Space Oddity": what the pressings call it, and whichever name he owns it under', () => {
    assert.equal(pick('David Bowie - Space Oddity', [315])!.album, 'Space Oddity', 'MusicBrainz files it under "David Bowie"')
    assert.equal(pick('David Bowie - Space Oddity', [315])!.year, 1969)
    assert.equal(pick('David Bowie - Space Oddity', [315], { owned: (a) => a === 'Man of Words/Man of Music' })!.album, 'Man of Words/Man of Music')
    assert.equal(albumToLookFor('Man of Words/Man of Music', pick('David Bowie - Space Oddity', [315]), () => false), 'Man of Words/Man of Music', 'a row on that name stands')
  })

  it('a song a soundtrack had first is a soundtrack song, whatever album it landed on later', () => {
    assert.equal(pick('The Beach Boys - Kokomo', [216]), null, 'Cocktail, 1988, then Still Cruisin\'')
    assert.equal(pick("50 Cent - Hustler's Ambition", [175]), null, 'Get Rich or Die Tryin\', then a bonus track on Curtis')
  })

  it('a title that says it is from a soundtrack has no album to name', () => {
    assert.equal(pick('Blur - Girls and Boys', [], { title: 'Girls and Boys (From "Trainspotting" Soundtrack)' }), null)
  })

  it('an album is dated by its first edition, not the reissue that holds this cut', () => {
    const credit = [{ name: 'A Band', artist: { name: 'A Band' } }]
    const seat = (date: string, length: number, title = 'The Album'): MbRecording => ({
      title: 'A Song', length, 'artist-credit': credit,
      releases: [{ title, status: 'Official', date, 'release-group': { id: 'al', title: 'The Album', 'primary-type': 'Album', 'secondary-types': [] } }],
    })
    const r = pickRealAlbum([seat('2026-01-01', 240_000), seat('2007-06-05', 300_000)], { title: 'A Song', artist: 'A Band', durationsSec: [240] })!
    assert.equal(r.year, 2007)
    assert.equal(r.lateAlbum, false)
  })

  it('a date only as fine as both sides know it: the same year is not before', () => {
    const credit = [{ name: 'A Band', artist: { name: 'A Band' } }]
    const recs = (soundtrack: string): MbRecording[] => [{
      title: 'A Song', length: 240_000, 'artist-credit': credit,
      releases: [
        { title: 'The Film', status: 'Official', date: soundtrack, 'release-group': { id: 'st', title: 'The Film', 'primary-type': 'Album', 'secondary-types': ['Soundtrack'] } },
        { title: 'The Album', status: 'Official', date: '2003-09-16', 'release-group': { id: 'al', title: 'The Album', 'primary-type': 'Album', 'secondary-types': [] } },
      ],
    }]
    const ask = (soundtrack: string) => pickRealAlbum(recs(soundtrack), { title: 'A Song', artist: 'A Band', durationsSec: [240] })?.album
    assert.equal(ask('2003'), 'The Album')
    assert.equal(ask('2003-12-01'), 'The Album', 'the album came first')
    assert.equal(ask('2003-02-25'), undefined, 'the soundtrack came first')
    assert.equal(ask('2001'), undefined)
  })

  it('Eminem, "Lose Yourself": a soundtrack song has no album to name', () => {
    assert.equal(pick('Eminem - Lose Yourself', [326]), null)
    assert.equal(pick('Eminem - Lose Yourself'), null)
  })

  it('Positive K, "I Got a Man": the album a row on Radio Waves of the \'90s should have named', () => {
    assert.equal(pick('Positive K - I Got a Man', [233])!.album, 'The Skills Dat Pay da Bills')
  })

  it('an album called Gold, and an album with Gold in its name, are albums', () => {
    assert.equal(pick('Ryan Adams - New York, New York', [226])!.album, 'Gold')
    assert.equal(pick('Neil Young - Only Love Can Break Your Heart', [186])!.album, 'After the Gold Rush')
  })

  it('the "original studio mix" is the album\'s cut', () => {
    const r = pick('Neil Young - Only Love Can Break Your Heart', [186])!
    assert.equal(r.year, 1970)
    assert.equal(r.trackNumber, 3)
  })

  it('Turnover, "Humming": Peripheral Vision, whatever the single says', () => {
    assert.equal(pick('Turnover - Humming', [238])!.album, 'Peripheral Vision')
  })

  it('no clock is a low answer, and a clock nothing fits is no answer', () => {
    assert.equal(pick('Blur - Girls and Boys')!.album, 'Parklife')
    assert.equal(pick('Blur - Girls and Boys')!.confidence, 'low')
    assert.equal(pick('Blur - Girls and Boys', [100]), null, 'that is some other cut')
  })

  it('the album he owns, when the recording is really on it', () => {
    const owned = (a: string): boolean => a === 'Drift Away and Other Classics'
    assert.equal(pick('Dobie Gray - Drift Away', [], { owned })!.album, 'Drift Away and Other Classics')
    assert.equal(pick('Dobie Gray - Drift Away', [237], { owned })!.album, 'Drift Away', 'but not when the clock says that one is another recording')
  })

  it('someone else\'s recording of the title is nobody\'s real album', () => {
    assert.equal(pick('Blur - Girls and Boys', [], { artist: 'Pet Shop Boys' }), null)
  })

  it('a title that names another recording has no album cut to look for', () => {
    for (const title of ['Girls and Boys (Live)', 'Girls and Boys (Pet Shop Boys Remix)', 'Girls and Boys - Acoustic']) {
      assert.equal(pick('Blur - Girls and Boys', [], { title }), null, title)
    }
  })

  it('a hits package MusicBrainz has typed as an album is no album', () => {
    const credit = [{ name: 'Eddy Raven', artist: { name: 'Eddy Raven' } }]
    const onAlbum = (title: string): MbRecording => ({ title: "I'm Gonna Get You", length: 200_000, 'artist-credit': credit, releases: [{ status: 'Official', date: '1990', 'release-group': { id: title, title, 'primary-type': 'Album', 'secondary-types': [] } }] })
    for (const title of ['Greatest Country Hits', 'Greatest Hits', 'The Best of Eddy Raven', 'The Very Best of Eddy Raven', 'The Essential Eddy Raven', 'Ultimate Collection']) {
      assert.equal(pickRealAlbum([onAlbum(title)], { title: "I'm Gonna Get You", artist: 'Eddy Raven', durationsSec: [200] }), null, title)
    }
    assert.equal(pickRealAlbum([onAlbum('Temporary Sanity')], { title: "I'm Gonna Get You", artist: 'Eddy Raven', durationsSec: [200] })?.album, 'Temporary Sanity')
  })

  it('an early take under the same name doesn\'t make the album late', () => {
    const credit = [{ name: 'A Band', artist: { name: 'A Band' } }]
    const recordings: MbRecording[] = [
      { title: 'A Song', length: 200_000, 'artist-credit': credit, releases: [{ status: 'Official', date: '2008', 'release-group': { id: 'ep', title: 'First EP', 'primary-type': 'EP', 'secondary-types': [] } }] },
      { title: 'A Song', length: 240_000, 'artist-credit': credit, releases: [{ status: 'Official', date: '2012', 'release-group': { id: 'al', title: 'The Album', 'primary-type': 'Album', 'secondary-types': [] } }] },
    ]
    const r = pickRealAlbum(recordings, { title: 'A Song', artist: 'A Band', durationsSec: [240] })!
    assert.equal(r.album, 'The Album')
    assert.equal(r.lateAlbum, false)
    assert.equal(r.confidence, 'high')
    assert.equal(pickRealAlbum(recordings, { title: 'A Song', artist: 'A Band' })!.lateAlbum, true, 'with no clock nobody can tell them apart')
  })

  it('no title or no artist: nothing', () => {
    assert.equal(pickRealAlbum(ANSWERS['Blur - Girls and Boys']!, { title: '', artist: 'Blur' }), null)
    assert.equal(pickRealAlbum(ANSWERS['Blur - Girls and Boys']!, { title: 'Girls and Boys', artist: ' ' }), null)
    assert.equal(pickRealAlbum([], { title: 'Girls and Boys', artist: 'Blur' }), null)
  })
})

describe('the fold and the question', () => {
  it('"&", "and" and "\'n\'" read the same', () => {
    assert.equal(realAlbumFold('Girls & Boys'), realAlbumFold('Girls and Boys'))
    assert.equal(realAlbumFold("Rock 'n' Roll"), realAlbumFold('Rock and Roll'))
    assert.equal(realAlbumFold('Sam’s Town'), realAlbumFold("Sam's Town"))
    assert.equal(realAlbumFold('Tri‐Polar'), realAlbumFold('Tri-Polar'))
    assert.equal(realAlbumFold('Beyoncé'), 'beyonce')
    assert.notEqual(realAlbumFold('Girls & Boys'), realAlbumFold('Boys'))
  })

  it('asks for every way of writing the title, with quotes escaped', () => {
    assert.equal(realAlbumQuery('Girls & Boys', 'Blur'), '(recording:"Girls & Boys" OR recording:"Girls and Boys") AND artist:"Blur" AND status:official AND primarytype:album')
    assert.equal(realAlbumQuery('Girls and Boys', 'Blur'), '(recording:"Girls and Boys" OR recording:"Girls & Boys") AND artist:"Blur" AND status:official AND primarytype:album')
    assert.ok(realAlbumQuery('Say "Hi"', 'Me').includes('recording:"Say \\"Hi\\""'))
    assert.ok(realAlbumQuery('We Found Love (feat. Calvin Harris)', 'Rihanna').startsWith('(recording:"We Found Love")'))
  })
})

describe('reading every page', () => {
  const page = (n: number): MbRecording[] => Array.from({ length: n }, (_, i) => ({ id: String(i) }))

  it('Stops at the short page', async () => {
    const asked: number[] = []
    const all = await allRecordings(async (offset) => { asked.push(offset); return { count: 119, recordings: page(offset === 0 ? 100 : 19) } })
    assert.deepEqual(asked, [0, 100])
    assert.equal(all.length, 119)
  })

  it('One page is one question', async () => {
    const asked: number[] = []
    await allRecordings(async (offset) => { asked.push(offset); return { count: 3, recordings: page(3) } })
    assert.deepEqual(asked, [0])
  })

  it('An exact hundred with a count of a hundred is one question', async () => {
    const asked: number[] = []
    await allRecordings(async (offset) => { asked.push(offset); return { count: 100, recordings: page(100) } })
    assert.deepEqual(asked, [0])
  })

  it('Three pages at most', async () => {
    const asked: number[] = []
    const all = await allRecordings(async (offset) => { asked.push(offset); return { count: 900, recordings: page(100) } })
    assert.deepEqual(asked, [0, 100, 200])
    assert.equal(all.length, 300)
  })

  it('A page that fails fails the answer: half a list would call a later album the first', async () => {
    await assert.rejects(allRecordings(async (offset) => {
      if (offset > 0) throw new Error('503')
      return { count: 119, recordings: page(100) }
    }))
  })
})

describe('what a download looks for', () => {
  const real = (over: Partial<RealAlbum> = {}): RealAlbum => ({
    album: 'Parklife', title: 'Girls & Boys', releaseGroupId: 'x', realAlbums: ['Parklife'], lateAlbum: false, confidence: 'high', ...over,
  })
  const nothingAdded = (): boolean => false

  it('MusicBrainz has nothing: the row', () => {
    assert.equal(albumToLookFor('Parklife', null, nothingAdded), 'Parklife')
    assert.equal(albumToLookFor('', null, nothingAdded), '')
    assert.equal(albumToLookFor('  True Genius ', null, nothingAdded), 'True Genius')
  })

  it('no row: what MusicBrainz has, certain or not', () => {
    assert.equal(albumToLookFor('', real(), nothingAdded), 'Parklife')
    assert.equal(albumToLookFor('', real({ confidence: 'low' }), nothingAdded), 'Parklife')
  })

  it('a row on a compilation or a single: the real album', () => {
    assert.equal(albumToLookFor("90's Rock Anthems", real(), nothingAdded), 'Parklife')
    assert.equal(albumToLookFor('Girls & Boys - Single', real(), nothingAdded), 'Parklife')
  })

  it('a row on the album, however it is written: the row', () => {
    for (const row of ['Parklife', 'Parklife (2012 Remaster)', 'Parklife (Special Edition)', 'Parklife - EP', 'PARKLIFE']) {
      assert.equal(albumToLookFor(row, real(), nothingAdded), row)
    }
  })

  it('a row on another of the recording\'s real albums: the row', () => {
    assert.equal(albumToLookFor('Kid Stuff', real({ album: 'Boots', realAlbums: ['Boots', 'Kid Stuff'] }), nothingAdded), 'Kid Stuff')
  })

  it('a row whose album says it is another recording: the row', () => {
    assert.equal(albumToLookFor('Live at Leeds', real(), (a) => /live/i.test(a)), 'Live at Leeds')
  })

  it('a row against an answer that is not certain: the row', () => {
    assert.equal(albumToLookFor('True Genius', real({ confidence: 'low' }), nothingAdded), 'True Genius')
  })

  it('an album years after the song is never looked for', () => {
    assert.equal(albumToLookFor('True Genius', real({ lateAlbum: true, confidence: 'low' }), nothingAdded), 'True Genius')
    assert.equal(albumToLookFor('', real({ lateAlbum: true, confidence: 'low' }), nothingAdded), '')
  })
})

describe('the album he already has', () => {
  const tracks = [
    { artist: 'Blur', albumArtist: 'Blur', album: 'Parklife (2012 Remaster)' },
    { artist: 'Damon Albarn', albumArtist: 'Blur', album: 'The Great Escape' },
    { artist: 'Oasis', album: 'Parklife' },
    { artist: 'Blur' },
  ]

  it('reads it under his spelling, for this artist only', () => {
    const owned = ownedAlbumTest(tracks, 'Blur')
    assert.equal(owned('Parklife'), true)
    assert.equal(owned('PARKLIFE'), true)
    assert.equal(owned('The Great Escape'), true, 'filed under the album artist')
    assert.equal(owned('Leisure'), false)
    assert.equal(ownedAlbumTest(tracks, 'Elastica')('Parklife'), false)
  })

  it('gives back his spelling and who it is filed under', () => {
    assert.deepEqual(ownedAlbumSpelling(tracks, 'Blur', 'Parklife'), { album: 'Parklife (2012 Remaster)', albumArtist: 'Blur' })
    assert.deepEqual(ownedAlbumSpelling(tracks, 'Blur', 'the great escape'), { album: 'The Great Escape', albumArtist: 'Blur' })
    assert.equal(ownedAlbumSpelling(tracks, 'Blur', 'Leisure'), null)
  })
})
