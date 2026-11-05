/**
 * A song row with no length asks Apple what the recording runs (2026-11-05).
 *
 * Every Listen List row reached the handler with no length, so each lane judged a file on its
 * tags alone: Tigers Jaw's "Spirit Desire", row album "Spirit Desire - EP", imported the 283.9 s
 * cut from "2008 Tour". Apple lists the EP at 311.4 s. The rows below are Apple's real answers
 * to the handler's own question, saved 2026-11-05, unless a test says otherwise.
 *
 * The walk tests run the real `streamrip:download-by-query` handler. Only the outside world is
 * faked: `rip`, `yt-dlp` and `ffprobe` are small scripts, HOME is a temp folder, and fetch
 * answers for Apple, Qobuz and Bandcamp.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asksAppleForLength, buildRequestedRecording, expectedRuntimes, verifyCandidate, type AppleSongRow } from '../exact-recording.ts'
import { itunesSongRows } from '../download-search.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-applelen-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

const row = (title: string, artist: string, album: string, durationSec: number, extra: Partial<AppleSongRow> = {}): AppleSongRow =>
  ({ title, artist, album, durationSec, ...extra })
const COMP = { compilation: true }
const CLEAN = { cleaned: true }
const lengths = (want: Parameters<typeof expectedRuntimes>[0], rows: AppleSongRow[]): Array<[number, number]> =>
  expectedRuntimes(want, rows).map((r) => [r.sec, r.tolSec])

const SPIRIT_DESIRE = [
  row('Spirit Desire', 'Tigers Jaw', '2008 Tour - Single', 283.9),
  row('Spirit Desire', 'Tigers Jaw', 'Spirit Desire - EP', 311.4),
  row('Spirit Desire', 'Tigers Jaw', 'Spirit Desire - EP', 311.4),
  row('Spirit Desire', 'Tigers Jaw', '2008 Tour - Single', 283.9),
  row('Crystal Vision', 'Tigers Jaw', 'Spirit Desire - EP', 266.7),
]
const THROW = [
  row("Throw (Slam's RTM Remix)", 'Paperclip People', "Throw (Slam's RTM Remix) - Single", 457.0),
  row('Throw', 'Paperclip People', 'Clear and Present - The C2 Sessions', 900.6),
  row('Throw', 'Paperclip People', 'The Secret Tapes of Dr. Eich', 407.5),
  row('Throw', 'Paperclip People', 'Modular Music Volume 2', 884.5, COMP),
  row('Throw', 'Paperclip People', 'Planet E 30', 900.6, COMP),
]
const FEELS_ALRIGHT = [
  row('Feels Alright (feat. Simonne Cooper) [Vocal Mix]', 'Richard F.', 'Feels Alright (feat. Simonne Cooper) - Single', 533.3),
  row('Feels Alright (feat. Simonne Cooper) [Vocal Mix]', 'Richard F.', 'House Top 1000 - The Anthems', 206.0, COMP),
]
const WHEN_YOU_DIE = [
  row('When You Die', 'Midnite String Quartet', 'MSQ Performs MGMT', 174.187),
  row('When You Die', 'MGMT', 'Nova Tunes 3.8', 258.36, COMP),
]
const BOOTS = [
  row("These Boots Are Made for Walkin'", 'Nancy Sinatra', 'Boots (Bonus Tracks Edition)', 167.8),
  row("These Boots Are Made for Walkin'", 'Nancy Sinatra', "Start Walkin' 1965-1976", 166.1),
  row("These Boots Are Made for Walkin'", 'Nancy Sinatra', 'Full Metal Jacket (Original Motion Picture Soundtrack)', 162.9, COMP),
  row("These Boots Are Made for Walkin'", 'Nancy Sinatra', 'Kid Stuff', 163.1),
]
const JAMIROQUAI = [
  row('If I Like It, I Do It', 'Jamiroquai', 'Emergency On Planet Earth', 274.3),
  row('If I Like It, I Do It', 'Jamiroquai', 'Emergency On Planet Earth (Remastered)', 292.7),
  row('Bad Girl', 'USHER', 'Confessions (Expanded Edition)', 261.8),
]
const RIHANNA = [
  row('We Found Love (feat. Calvin Harris)', 'Rihanna', 'Talk That Talk', 215.2),
  row('We Found Love (feat. Calvin Harris) [Calvin Harris Extended Mix]', 'Rihanna', 'Talk That Talk (Deluxe)', 345.7),
  row('We Found Love', 'Glee Cast', 'Glee: The Music, The Complete Season Three', 215.0),
  row('We Found Love (feat. Rihanna)', 'Calvin Harris', '18 Months', 215.5),
  row('We Found Love (Chuckie Extended Remix)', 'Rihanna & Calvin Harris', 'We Found Love (The Remixes)', 357.2),
  row('We Found Love', 'Rihanna & Calvin Harris', 'We Found Love (Extended Version) - Single', 215.2),
  row('We Found Love', 'Rihanna Tribute Band', 'Hits', 233.0),
]
const WHO = [
  row('Who Are You (Live)', 'The Who', 'Quadrophenia: Live In London', 386.7),
  row('Who Are You (Live At Universal Amphitheatre 1989)', 'The Who', 'Greatest Hits Live', 382.5),
  row('Who Are You', 'Carrie Underwood', 'Blown Away', 234.5),
]
const BIG = 'The Notorious B.I.G.'

describe('expectedRuntimes: what Apple lists for this recording', () => {
  test('the row names an album and Apple lists the song there: that album’s length, and no other', () => {
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Spirit Desire - EP' }, SPIRIT_DESIRE), [[311.4, 5]], 'not the 283.9 s from 2008 Tour')
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw', album: '2008 Tour - Single' }, SPIRIT_DESIRE), [[283.9, 5]])
    assert.deepEqual(lengths({ title: 'Throw', artist: 'Paperclip People', album: 'The Secret Tapes of Dr. Eich' }, THROW), [[407.5, 5]])
    assert.deepEqual(lengths({ title: 'Feels Alright (Vocal Mix)', artist: 'Richard F.', album: 'Feels Alright (feat. Simonne Cooper) - Single' }, FEELS_ALRIGHT), [[533.3, 5]], 'not the 206 s edit on a dance comp')
  })

  test('the same album in other packaging is the same album', () => {
    assert.deepEqual(lengths({ title: 'If I Like It, I Do It', artist: 'Jamiroquai', album: 'Emergency On Planet Earth' }, JAMIROQUAI), [[274.3, 5], [292.7, 30]])
    assert.deepEqual(lengths({ title: "These Boots Are Made for Walkin'", artist: 'Nancy Sinatra', album: 'Boots' }, BOOTS), [[167.8, 5]])
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Spirit Desire' }, SPIRIT_DESIRE), [[311.4, 5]], 'no " - EP" on the row')
  })

  test('the row names an album Apple does not list the song on: nobody knows, whatever else Apple lists', () => {
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Some Comp' }, SPIRIT_DESIRE), [])
  })

  test('an album with no letters in its name is still its name', () => {
    const rows = [row('Song', 'Band', '?', 200), row('Song', 'Band', '!!!', 300)]
    assert.deepEqual(lengths({ title: 'Song', artist: 'Band', album: '?' }, rows), [[200, 5]])
  })

  test('a compilation’s row never sets a length: "When You Die" on Little Dark Age runs 263.9 s, on Nova Tunes 258.4 s', () => {
    assert.deepEqual(lengths({ title: 'When You Die', artist: 'MGMT', album: 'Little Dark Age' }, WHEN_YOU_DIE), [])
    assert.deepEqual(lengths({ title: 'When You Die', artist: 'MGMT', album: 'Nova Tunes 3.8' }, WHEN_YOU_DIE), [], 'not even when Apple’s resolver gave the row that album')
    assert.deepEqual(lengths({ title: 'When You Die', artist: 'MGMT' }, WHEN_YOU_DIE), [])
  })

  test('a row that names no album: every length Apple lists for this recording by this artist, and none of another’s', () => {
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw' }, SPIRIT_DESIRE), [[283.9, 5], [311.4, 5]])
    assert.deepEqual(lengths({ title: 'If I Like It, I Do It', artist: 'Jamiroquai' }, JAMIROQUAI), [[274.3, 5], [292.7, 30]])
    assert.deepEqual(lengths({ title: 'We Found Love (feat. Calvin Harris)', artist: 'Rihanna' }, RIHANNA), [[215.2, 5]])
    assert.deepEqual(lengths({ title: "These Boots Are Made for Walkin'", artist: 'Nancy Sinatra' }, BOOTS), [[167.8, 5], [166.1, 5], [163.1, 5]])
    assert.deepEqual(lengths({ title: 'Spirit Desire', artist: 'Tigers Jaw' }, [SPIRIT_DESIRE[1], row('Spirit Desire', 'Tigers Jaw', 'Early Years', 311.4)]), [[311.4, 5]], 'one length on two records is one length')
  })

  test('fails open: no artist, no title, no rows, no row by the artist, only live rows', () => {
    assert.deepEqual(lengths({ title: 'Who Are You', artist: '' }, WHO), [])
    assert.deepEqual(lengths({ title: '', artist: 'The Who' }, WHO), [])
    assert.deepEqual(lengths({ title: 'Who Are You', artist: 'The Who' }, []), [])
    assert.deepEqual(lengths({ title: 'Who Are You', artist: 'Someone Else' }, WHO), [])
    assert.deepEqual(lengths({ title: 'Who Are You', artist: 'The Who' }, WHO), [], 'Apple lists only live cuts of it, so nobody knows the studio length')
    assert.deepEqual(lengths({ title: '', artist: 'Outkast' }, [row('?', 'Outkast', 'Stankonia', 90)]), [], 'no title is not the same name as a title with no letters')
    assert.deepEqual(lengths({ title: 'Song', artist: 'Band' }, [row('Song', 'Band', 'Album', 0)]), [], 'a row that knows no length')
  })

  test('a song on a clean album beats the same title on a live one; if the live one is all there is, nobody knows', () => {
    const rows = [row('Hey', 'Pixies', 'Doolittle', 211), row('Hey', 'Pixies', 'Live in Paris', 250)]
    assert.deepEqual(lengths({ title: 'Hey', artist: 'Pixies' }, rows), [[211, 5]])
    assert.deepEqual(lengths({ title: 'Hey', artist: 'Pixies' }, rows.slice(1)), [])
  })

  test('a live request names no one performance: McCartney has five lengths from 252 to 351', () => {
    assert.deepEqual(lengths({ title: 'Let Me Roll It (Live)', artist: 'Paul McCartney' }, [row('Let Me Roll It (Live)', 'Paul McCartney', 'Back In The World (Live)', 264.3)]), [])
    assert.deepEqual(lengths({ title: 'Hey - Live at the BBC', artist: 'Pixies' }, [row('Hey - Live at the BBC', 'Pixies', 'At the BBC', 200)]), [])
    assert.deepEqual(lengths({ title: 'Live and Let Die', artist: 'Wings' }, [row('Live and Let Die', 'Wings', 'Band on the Run', 192)]), [[192, 5]], 'a song named with the word still has a clock')
    assert.deepEqual(lengths({ title: 'Who Got Da Props', artist: 'Black Moon' }, [row('Who Got Da Props', 'Black Moon', 'Dah Instrumentalz', 293.5)]), [], 'nor does an instrumental album pin the studio take')
  })

  test('a request or an album that says what it is may have that album’s length', () => {
    assert.deepEqual(lengths({ title: 'Song', artist: 'Band', album: 'Live at Leeds' }, [row('Song', 'Band', 'Live at Leeds', 300)]), [[300, 5]], 'the row’s own album is never a word it did not ask for')
  })

  test('the row names the same recording both ways round', () => {
    const rows = [row('Who Are You (Radio Edit)', 'The Who', 'Who Are You', 310), row('Who Are You', 'The Who', 'Who Are You', 378)]
    assert.deepEqual(lengths({ title: 'Who Are You', artist: 'The Who' }, rows), [[378, 5]])
    assert.deepEqual(lengths({ title: 'Who Are You (Radio Edit)', artist: 'The Who' }, rows), [[310, 5]])
    assert.deepEqual(lengths({ title: 'Lady (Radio Edit)', artist: 'Modjo' }, [row('Lady', 'Modjo', 'Modjo', 307.2)]), [], "the album row's length is not the edit's")
    assert.deepEqual(lengths({ title: 'N****s Bleed', artist: BIG }, [row('Niggas Bleed (Radio Edit)', BIG, 'Hits', 200)]), [], 'a masked title reads through a tail, and that tail may be another recording')
    assert.deepEqual(lengths({ title: 'Toxygene', artist: 'The Orb', album: 'U.F.Off: The Best of the Orb' }, [row('Toxygene (7" Edit)', 'The Orb', 'U.F.Off: The Best of the Orb', 211.5), row('Toxygene', 'The Orb', 'Orblivion', 319.7)]), [], 'Apple calls that album’s cut the 7" Edit')
    assert.deepEqual(lengths({ title: 'Countdown', artist: 'King Gizzard & The Lizard Wizard' }, [row('Countdown (feat. Mild High Club)', 'King Gizzard & The Lizard Wizard', 'Sketches of Brunswick East (feat. Mild High Club)', 202.7)]), [], 'a version word in a credit costs the clock, never the download')
  })

  test('an exact title beats a subtitle, so a reprise never widens the song', () => {
    assert.deepEqual(lengths({ title: 'Solo', artist: 'Frank Ocean' }, [row('Solo', 'Frank Ocean', 'Blonde', 257), row('Solo (Reprise)', 'Frank Ocean', 'Blonde', 78)]), [[257, 5]])
    assert.deepEqual(lengths({ title: 'Lady (Hear Me Tonight)', artist: 'Modjo' }, [row('Lady (Hear Me Tonight)', 'Modjo', 'Modjo', 307.2), row('Lady', 'Modjo', 'Modjo', 195.6)]), [[307.2, 5]])
    assert.deepEqual(lengths({ title: 'Lady (Hear Me Tonight)', artist: 'Modjo' }, [row('Lady', 'Modjo', 'Modjo', 307.2)]), [[307.2, 5]], 'a bare row answers a subtitled request')
    assert.deepEqual(lengths({ title: 'Trombone Dixie', artist: 'The Beach Boys' }, [row('Trombone Dixie (Highlights From Tracking Date)', 'The Beach Boys', 'The Pet Sounds Sessions (Deluxe Edition)', 86.4)]), [], 'a row that adds a subtitle says nothing about the song')
    assert.deepEqual(lengths({ title: 'N****s Bleed', artist: BIG }, [row('Niggas Bleed', BIG, 'Life After Death', 291.0)]), [[291.0, 30]], 'Apple masks the request, the row spells it out')
    assert.deepEqual(lengths({ title: 'Niggas Bleed', artist: BIG }, [row('N****s Bleed', BIG, 'Life After Death', 291.0)]), [[291.0, 30]], 'and the other way round')
    assert.deepEqual(lengths({ title: "Till It's Over", artist: '3DDY' }, [row("Dance Till It's Over (ft. 3DDY)", 'ANOTR & 3DDY', 'Withness', 207.6)]), [], 'a title that only contains the request is another song')
  })

  test('a stamped edition gets the wide tolerance: a remaster or a masked title, on either side', () => {
    assert.deepEqual(lengths({ title: 'Save It for Later (2012 Remaster)', artist: 'The English Beat' }, [row('Save It for Later (2012 Remaster)', 'The English Beat', 'Keep The Beat', 213.9)]), [[213.9, 30]])
    assert.deepEqual(lengths({ title: 'N****s Bleed', artist: BIG }, [row('N****s Bleed', BIG, 'Greatest Hits', 291.2)]), [[291.2, 30]])
    assert.deepEqual(lengths({ title: 'Mask Off', artist: 'Future' }, [row('Mask Off', 'Future', 'FUTURE', 204)]), [[204, 5]])
    assert.deepEqual(lengths({ title: 'Mask Off', artist: 'Future', album: 'FUTURE (Remastered)' }, [row('Mask Off', 'Future', 'FUTURE', 204)]), [[204, 30]])
    assert.deepEqual(lengths({ title: 'Mask Off', artist: 'Future' }, [row('Mask Off', 'Future', 'FUTURE (Remastered)', 204)]), [[204, 30]])
    assert.deepEqual(lengths({ title: 'Mask Off (Remastered)', artist: 'Future' }, [row('Mask Off', 'Future', 'FUTURE', 204)]), [[204, 30]])
    assert.deepEqual(lengths({ title: 'Mask Off', artist: 'Future' }, [row('Mask Off (Remastered)', 'Future', 'FUTURE', 204)]), [[204, 30]])
  })

  // 2026-11-04: Apple's public search returns no explicit rows, so a clean row means an explicit
  // cut exists that Apple is not showing. "Respect" is 273.7 s clean, 321.3 s explicit.
  describe('any clean row of the song, and nobody knows its length', () => {
    test('the flag, a stamp on the title, a stamp on the album', () => {
      assert.deepEqual(lengths({ title: 'Respect', artist: BIG }, [row('Respect', BIG, 'Ready To Die the Remaster', 273.7, CLEAN)]), [])
      assert.deepEqual(lengths({ title: 'The Game', artist: 'Jurassic 5' }, [row('The Game (Edited)', 'Jurassic 5', 'Quality Control', 274.4), row('The Game', 'Jurassic 5', 'Stick It (Original Soundtrack)', 247.5)]), [], 'a stamp with no flag')
      assert.deepEqual(lengths({ title: 'Song', artist: 'Artist' }, [row('Song', 'Artist', 'Album [Amended Version]', 200), row('Song', 'Artist', 'Other', 210)]), [], 'only on the album')
      assert.deepEqual(lengths({ title: 'Sugar', artist: 'System Of A Down' }, [row('Sugar (Clean Version)', 'System Of A Down', 'System Of A Down', 153.067, CLEAN)]), [])
    })

    test('the other rows do not get to judge, on or off the row’s album', () => {
      assert.deepEqual(lengths({ title: "God's Plan", artist: 'Drake' }, [row("God's Plan", 'Drake', 'Scorpion', 199.0, CLEAN), row("God's Plan", 'Drake', 'ZERO REGRETS', 123.3)]), [])
      assert.deepEqual(lengths({ title: "God's Plan", artist: 'Drake', album: 'ZERO REGRETS' }, [row("God's Plan", 'Drake', 'Scorpion', 199.0, CLEAN), row("God's Plan", 'Drake', 'ZERO REGRETS', 123.3)]), [])
      assert.deepEqual(lengths({ title: 'Slum Beautiful', artist: 'Outkast' }, [row('Slum Beautiful (feat. Cee-Lo)', 'Outkast', 'Stankonia', 247.7, CLEAN), row('Slum Beautiful', 'Outkast', 'Late Night Tales: Django Django', 247.9)]), [])
    })

    test('a clean row on a compilation still says so', () => {
      assert.deepEqual(lengths({ title: 'Song', artist: 'Band', album: 'Album' }, [row('Song', 'Band', 'Hits', 180, { cleaned: true, compilation: true }), row('Song', 'Band', 'Album', 200)]), [])
    })

    test('the clean row may name the song differently', () => {
      assert.deepEqual(lengths({ title: 'Swimming Pools (Drank)', artist: 'Kendrick Lamar' }, [row('Swimming Pools (Drank) [Extended Version]', 'Kendrick Lamar', 'good kid, m.A.A.d city', 313.7, CLEAN), row('Swimming Pools (Drank)', 'Kendrick Lamar', 'Awards', 247.0)]), [], 'a 247 s row must not judge the 313.7 s album cut')
      assert.deepEqual(lengths({ title: 'Xxplosive', artist: 'Dr. Dre' }, [row('Xxplosive (Instrumental)', 'Dr. Dre', '2001 (Instrumental)', 215.4), row('Xxplosive (feat. Hittman, Six-Two, Nate Dogg & Kurupt)', 'Dr. Dre', '2001', 170.0, CLEAN)]), [])
      assert.deepEqual(lengths({ title: 'Niggas Bleed', artist: BIG }, [row('N****s Bleed', BIG, 'Greatest Hits', 291.2, CLEAN), row('Niggas Bleed', BIG, 'Life After Death', 291.0)]), [], 'nor is a mask a difference')
    })

    test('only a clean row of THIS song by THIS artist: another song, a stranger, a radio edit change nothing', () => {
      const warning = row('Warning', BIG, 'Ready to Die', 219.4)
      assert.deepEqual(lengths({ title: 'Warning', artist: BIG }, [warning, row('Hypnotize', BIG, 'Greatest Hits', 230, CLEAN)]), [[219.4, 5]], 'another song')
      assert.deepEqual(lengths({ title: 'Warning', artist: BIG }, [warning, row('Warning', 'Someone Else', 'Hits', 180, CLEAN)]), [[219.4, 5]], 'a stranger')
      assert.deepEqual(lengths({ title: 'Warning', artist: BIG }, [warning, row('Warning', `${BIG} Tribute Band`, 'Hits', 180, CLEAN)]), [[219.4, 5]], 'a cover act whose name holds the artist')
      assert.deepEqual(lengths({ title: 'Warning', artist: BIG }, [warning, row('Warning', BIG, 'Karaoke Tribute', 180, CLEAN)]), [[219.4, 5]], 'a cover album')
      assert.deepEqual(lengths({ title: 'Warning', artist: BIG }, [warning, row('Warning (Radio Edit)', BIG, 'Singles', 180)]), [[219.4, 5]], 'a radio edit is another recording, not a clean row')
      assert.equal(lengths({ title: '?', artist: 'Outkast' }, [row('?', 'Outkast', 'Stankonia', 90), row('!!!', 'Outkast', 'Hits', 60, CLEAN)]).length > 0, true, 'a title with no letters is not the same name as another')
    })
  })
})

describe('asksAppleForLength: whose length is Apple’s to answer', () => {
  const song = { title: 'Spirit Desire', album: 'Spirit Desire - EP' }
  test('a row with no length of its own', () => {
    assert.equal(asksAppleForLength(song), true)
    assert.equal(asksAppleForLength({ ...song, durationMs: 0 }), true)
    assert.equal(asksAppleForLength({ title: 'Spirit Desire' }), true, 'no album either')
  })
  test('not a row that has one', () => {
    assert.equal(asksAppleForLength({ ...song, durationMs: 311_400 }), false)
  })
  test('not a clean row, by Apple’s flag or a stamp, with or without a length: Apple’s search only shows the clean file’s', () => {
    assert.equal(asksAppleForLength({ ...song, cleanedSource: true }), false)
    assert.equal(asksAppleForLength({ ...song, cleanedSource: true, durationMs: 277_000 }), false)
    assert.equal(asksAppleForLength({ title: "Sky's the Limit (feat. 112) [Amended]" }), false)
    assert.equal(asksAppleForLength({ title: "Sky's the Limit", album: 'Life After Death [Amended Version] (2014 Remaster)' }), false)
  })
  test('not a rescued row: explicit, with its length taken off because the row was clean', () => {
    assert.equal(asksAppleForLength({ ...song, explicitSource: true }), false)
  })
})

describe('the judge, with what Apple lists', () => {
  const qz = (durationSec: number | null, album = 'Spirit Desire') => ({ provider: 'qobuz' as const, title: 'Spirit Desire', artist: 'Tigers Jaw', album, durationSec })
  const req = (runtimes: Array<{ sec: number; tolSec: number }>, over: Parameters<typeof buildRequestedRecording>[0] = {}) =>
    buildRequestedRecording({ artist: 'Tigers Jaw', title: 'Spirit Desire', album: 'Spirit Desire - EP', runtimes, ...over })

  test('a file fits any length, each with its own tolerance', () => {
    const r = req([{ sec: 274.3, tolSec: 5 }, { sec: 292.7, tolSec: 30 }])
    assert.equal(verifyCandidate(r, qz(274.4)).verdict, 'exact')
    assert.equal(verifyCandidate(r, qz(279.3)).verdict, 'exact', 'the end of the first window')
    assert.equal(verifyCandidate(r, qz(292.7)).verdict, 'exact')
    assert.equal(verifyCandidate(r, qz(322.7)).verdict, 'exact', 'the end of the second window')
    const short = verifyCandidate(r, qz(240))
    assert.equal(short.verdict === 'reject' && short.kind, 'duration')
    assert.equal(short.verdict === 'reject' && short.reason, 'runs 4:00, wanted 4:34 or 4:53')
    assert.equal(verifyCandidate(r, qz(323)).verdict, 'reject', 'past the second window')
  })

  test('the evidence names the length it fit', () => {
    const v = verifyCandidate(req([{ sec: 274.3, tolSec: 5 }, { sec: 292.7, tolSec: 30 }]), qz(292.7))
    assert.ok(v.verdict === 'exact' && v.evidence.includes('runs 4:53 (±30s of 4:53)'), JSON.stringify(v))
  })

  test('a file that knows no length is not a mismatch, and a row with none lets everything through on this count', () => {
    assert.equal(verifyCandidate(req([{ sec: 311.4, tolSec: 5 }]), qz(null)).verdict, 'exact')
    assert.equal(verifyCandidate(req([]), qz(283.9)).verdict, 'exact')
  })

  test('the first length stands as the row’s, so anything asking "is there a length" hears yes', () => {
    const r = req([{ sec: 311.4, tolSec: 30 }, { sec: 400, tolSec: 5 }])
    assert.equal(r.durationSec, 311.4)
    assert.equal(r.durationTolSec, 30)
    assert.equal(req([]).durationSec, 0)
    assert.equal(req([]).runtimes, undefined)
  })

  test('the row’s own length beats Apple’s', () => {
    const r = req([{ sec: 283.9, tolSec: 5 }], { durationMs: 311_400 })
    assert.equal(r.durationSec, 311.4)
    assert.equal(r.runtimes, undefined)
    assert.equal(verifyCandidate(r, qz(283.9)).verdict, 'reject')
  })

  test('a clean row’s length never sets a clock, however it got here', () => {
    const r = req([{ sec: 277.1, tolSec: 5 }], { cleanedSource: true })
    assert.equal(r.durationSec, 0)
    assert.equal(r.runtimes, undefined)
    assert.equal(req([{ sec: 277.1, tolSec: 5 }], { title: 'Spirit Desire [Amended]' }).durationSec, 0)
  })

  test('Apple’s length lets another way of writing the credit through: "Oma" for "OMA & SitarNik"', () => {
    const want = { artist: 'OMA & SitarNik', title: 'Rapp Snitch Knishes (Sitar Edition)', album: 'Rapp Snitch Knishes (Sitar Edition) - Single' }
    const file = { provider: 'qobuz' as const, title: 'Rapp Snitch Knishes (Sitar Edition)', artist: 'Oma', album: 'Rapp Snitch Knishes (Sitar Edition)', durationSec: 137 }
    assert.equal(verifyCandidate(buildRequestedRecording(want), file).verdict, 'reject')
    assert.equal(verifyCandidate(buildRequestedRecording({ ...want, runtimes: [{ sec: 137, tolSec: 5 }] }), file).verdict, 'exact')
  })
})

describe('itunesSongRows: Apple’s answer, or no answer', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const answer = (results: unknown[], status = 200): void => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ results }), { status })) as typeof fetch
  }
  const appleRow = (o: Record<string, unknown>): Record<string, unknown> => ({ trackName: 'Spirit Desire', artistName: 'Tigers Jaw', collectionName: 'Spirit Desire - EP', trackTimeMillis: 311_400, trackExplicitness: 'notExplicit', ...o })

  test('reads Apple’s fields, and says which rows are clean or a compilation', async () => {
    answer([
      appleRow({}),
      appleRow({ trackExplicitness: 'cleaned' }),
      appleRow({ trackExplicitness: 'explicit' }),
      appleRow({ collectionName: 'Hits', collectionArtistName: 'Various Artists' }),
      appleRow({ collectionName: 'Big Star', collectionArtistName: 'Tigers Jaw' }),
    ])
    assert.deepEqual(await itunesSongRows('Spirit Desire', 'Tigers Jaw'), [
      { title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Spirit Desire - EP', durationSec: 311.4, cleaned: false, explicit: false, compilation: false },
      { title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Spirit Desire - EP', durationSec: 311.4, cleaned: true, explicit: false, compilation: false },
      { title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Spirit Desire - EP', durationSec: 311.4, cleaned: false, explicit: true, compilation: false },
      { title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Hits', durationSec: 311.4, cleaned: false, explicit: false, compilation: true },
      { title: 'Spirit Desire', artist: 'Tigers Jaw', album: 'Big Star', durationSec: 311.4, cleaned: false, explicit: false, compilation: false },
    ])
  })

  test('asks for the song and the artist, songs only', async () => {
    let asked = ''
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => { asked = String(u); signal = init?.signal; return new Response('{"results":[]}') }) as typeof fetch
    assert.deepEqual(await itunesSongRows('Spirit Desire', 'Tigers Jaw'), [], 'Apple answered, and has nothing')
    assert.ok(signal, 'the one download queue waits on this: it needs a timeout')
    const u = new URL(asked)
    assert.equal(u.origin + u.pathname, 'https://itunes.apple.com/search')
    assert.equal(u.searchParams.get('term'), 'Spirit Desire Tigers Jaw')
    assert.equal(u.searchParams.get('entity'), 'song')
    assert.equal(u.searchParams.get('limit'), '60')
  })

  test('a row with no length, no title or no artist is no row; a 29-second snippet is no song', async () => {
    answer([appleRow({ trackTimeMillis: undefined }), appleRow({ trackTimeMillis: 0 }), appleRow({ trackName: undefined }), appleRow({ artistName: undefined }), appleRow({ trackTimeMillis: 29_000 }), appleRow({ trackName: 'Horn Intro', trackTimeMillis: 29_000 })])
    assert.deepEqual((await itunesSongRows('Spirit Desire', 'Tigers Jaw'))?.map((r) => r.title), ['Horn Intro'])
  })

  test('no answer is not an empty answer: an error, a dropped connection, a body that is not JSON', async () => {
    answer([], 403)
    assert.equal(await itunesSongRows('Spirit Desire', 'Tigers Jaw'), null)
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    assert.equal(await itunesSongRows('Spirit Desire', 'Tigers Jaw'), null)
    globalThis.fetch = (async () => new Response('<html>')) as typeof fetch
    assert.equal(await itunesSongRows('Spirit Desire', 'Tigers Jaw'), null)
  })
})

// ── The real handler, in a fake world ───────────────────────────────────────

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then
  # rip search -o <file> -n <n> <source> <type> <query>
  if [ -f "$FAKE_WORLD/search-$6-$7.json" ]; then cp "$FAKE_WORLD/search-$6-$7.json" "$3"; exit 0; fi
  echo "No search results found for query $8"; exit 0
fi
# rip --folder <dir> --quality 4 --no-db --no-progress id <source> <type> <id>
cp "$FAKE_WORLD/audio.bin" "$2/\${10}-1.flac"
`
const FAKE_YT_DLP = `#!/bin/sh
echo "yt-dlp $*" >> "$FAKE_WORLD/calls.log"
prev=""; tpl=""
for a in "$@"; do [ "$prev" = "-o" ] && tpl="$a"; prev="$a"; done
cp "$FAKE_WORLD/audio.bin" "$(dirname "$tpl")/bandcamp-1.mp3"
`
const FAKE_FFPROBE = `#!/bin/sh
for f; do :; done
b=$(basename "$f"); b=\${b%.*}
cat "$FAKE_WORLD/probe-\${b%-*}.json"
`

interface WalkResult { ok: boolean; outcome?: string; matchDesc?: string; error?: string; detail?: string; alternatives?: Array<{ provider: string; desc: string; reason: string }> }

describe('walked through the real handler', () => {
  const home = mkdtempSync(join(tmpdir(), 'jt-applelen-home-'))
  const appPath = join(home, 'app-path')
  after(() => rmSync(home, { recursive: true, force: true }))
  let world = ''
  let apple: { rows: unknown[] } | 'down' = { rows: [] }
  let appleAsked: string[] = []
  let qobuz: Record<string, unknown> = {}
  let bandcamp: unknown[] = []
  let warned: string[] = []
  const realFetch = globalThis.fetch
  const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

  const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
  const install = (dir: string, name: string, script: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), script)
    chmodSync(join(dir, name), 0o755)
  }
  const calls = (): string[] => existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n') : []
  const ripped = (): string[] => calls().filter((l) => l.startsWith('rip --folder')).map((l) => l.split(' ').at(-1)!)
  const hits = (rows: Array<[id: string, desc: string]>): void =>
    put('search-qobuz-track.json', JSON.stringify(rows.map(([id, desc]) => ({ source: 'qobuz', media_type: 'track', id, desc }))))
  const fileTags = (id: string, t: { title: string; artist: string; album: string; duration: number }): void =>
    put(`probe-${id}.json`, JSON.stringify({ format: { duration: String(t.duration), tags: { title: t.title, artist: t.artist, album: t.album } } }))
  /** Apple's rows, as its search answers them. */
  const appleRow = (title: string, artist: string, album: string, sec: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ trackName: title, artistName: artist, collectionName: album, trackTimeMillis: Math.round(sec * 1000), trackExplicitness: 'notExplicit', ...extra })

  function store() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const imported: string[] = []
    registerStreamripStore({
      ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
      getMainWindow: () => null,
      importDownloaded: async (paths: string[]) => { imported.push(...paths); return paths.map(() => ({ title: 'x' })) },
      mbThrottle: async () => {},
      mbUserAgent: 'jt-applelen-test',
    } as never)
    return {
      importedIds: (): string[] => imported.map((p) => p.split('/').at(-1)!.replace(/-\d+\.\w+$/, '')),
      walk: async (opts: Record<string, unknown>): Promise<WalkResult> => {
        const r = await handlers.get('streamrip:download-by-query')!({}, opts) as WalkResult
        assert.deepEqual(readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith('jaketunes-')), [], 'staging must not outlive the walk')
        return r
      },
    }
  }

  before(() => {
    install(join(home, '.local', 'bin'), 'rip', FAKE_RIP)
    install(join(home, '.local', 'bin'), 'yt-dlp', FAKE_YT_DLP)
    install(appPath, 'ffprobe', FAKE_FFPROBE)
    const cfg = join(home, 'Library', 'Application Support', 'streamrip')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'config.toml'), '[qobuz]\nuse_auth_token = true\npassword_or_token = "NOT-A-TOKEN"\napp_id = "APP1"\n')
    const warm = { env: { ...process.env, FAKE_WORLD: home }, timeout: 120_000, stdio: 'ignore' as const }
    execFileSync(join(home, '.local', 'bin', 'rip'), ['--version'], warm)
    writeFileSync(join(home, 'probe-warm.json'), '{}')
    execFileSync(join(appPath, 'ffprobe'), [join(home, 'warm-1.flac')], warm)
    writeFileSync(join(home, 'audio.bin'), '')
    execFileSync(join(home, '.local', 'bin', 'yt-dlp'), ['-o', join(home, 'x'), 'u'], warm)
  })

  beforeEach(() => {
    world = mkdtempSync(join(tmpdir(), 'jt-applelen-'))
    mkdirSync(join(world, 'tmp'))
    process.env.HOME = home
    process.env.PATH = `${appPath}:/usr/bin:/bin`
    process.env.TMPDIR = join(world, 'tmp')
    process.env.FAKE_WORLD = world
    put('audio.bin', new Uint8Array(100 * 1024))
    apple = { rows: [] }
    appleAsked = []
    qobuz = {}
    bandcamp = []
    warned = []
    mock.method(console, 'warn', (...args: unknown[]) => { warned.push(args.join(' ')) })
    mock.method(console, 'log', () => {})
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (u.includes('itunes.apple.com')) {
        appleAsked.push(u)
        return apple === 'down' ? new Response('', { status: 403 }) : json({ results: apple.rows })
      }
      if (u.includes('qobuz.com/api.json')) {
        const id = decodeURIComponent(/_id=([^&]+)/.exec(u)?.[1] ?? '')
        return qobuz[id] === undefined ? json({ status: 'error' }, 500) : json(qobuz[id])
      }
      if (u.includes('bandcamp.com/api')) return json({ auto: { results: bandcamp } })
      return json({}, 404)
    }) as typeof fetch
  })

  afterEach(() => {
    mock.restoreAll()
    globalThis.fetch = realFetch
    process.env.HOME = savedEnv.HOME
    process.env.PATH = savedEnv.PATH
    if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedEnv.TMPDIR
    rmSync(world, { recursive: true, force: true })
  })

  // The real row, Qobuz's two real hits, and Bandcamp's real page for the EP.
  const SPIRIT_ROW = { artist: 'Tigers Jaw', title: 'Spirit Desire', album: 'Spirit Desire - EP' }
  const SPIRIT_APPLE = [
    appleRow('Spirit Desire', 'Tigers Jaw', '2008 Tour - Single', 283.9),
    appleRow('Spirit Desire', 'Tigers Jaw', 'Spirit Desire - EP', 311.4),
  ]
  const tourCopy = (): void => {
    hits([['83168035', 'Spirit Desire by Tigers Jaw'], ['187259764', 'Spirit Desire by Tigers Jaw']])
    qobuz['83168035'] = { title: 'Spirit Desire', duration: 283, parental_warning: false, album: { title: '2008 Tour' } }
    qobuz['187259764'] = { title: 'Spirit Desire', duration: 283, parental_warning: false, album: { title: '2008 Tour' } }
    fileTags('83168035', { title: 'Spirit Desire', artist: 'Tigers Jaw', album: '2008 Tour', duration: 283 })
    fileTags('187259764', { title: 'Spirit Desire', artist: 'Tigers Jaw', album: '2008 Tour', duration: 283 })
  }
  const epPage = (): void => {
    bandcamp = [{ type: 't', name: 'Spirit Desire', band_name: 'tigers jaw', item_url_path: 'https://tigersjaw.bandcamp.com/track/spirit-desire-2' }]
    fileTags('bandcamp', { title: 'Spirit Desire', artist: 'tigers jaw', album: 'Spirit Desire ep', duration: 311.4 })
  }

  test('Spirit Desire: Qobuz’s 283 s from another record costs no fetch, and the EP’s page lands', async () => {
    apple = { rows: SPIRIT_APPLE }
    tourCopy()
    epPage()
    const { walk, importedIds } = store()
    const r = await walk(SPIRIT_ROW)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(ripped(), [], 'refused on what Qobuz says, before a byte')
    assert.deepEqual(importedIds(), ['bandcamp'])
    assert.equal(r.matchDesc, 'Spirit Desire — tigers jaw (Bandcamp stream)')
  })

  test('nowhere else to land: nothing is imported, and the verdict says what ran how long', async () => {
    apple = { rows: SPIRIT_APPLE }
    tourCopy()
    const { walk, importedIds } = store()
    const r = await walk(SPIRIT_ROW)
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(importedIds(), [])
    assert.ok(r.alternatives?.some((a) => a.reason === 'runs 4:43, wanted 5:11'), JSON.stringify(r.alternatives))
  })

  test('the row asks with the song’s plain name and its artist', async () => {
    apple = { rows: [] }
    tourCopy()
    await store().walk({ artist: 'Rihanna', title: 'We Found Love (feat. Calvin Harris)', album: 'Talk That Talk' })
    assert.equal(appleAsked.length, 1)
    assert.equal(new URL(appleAsked[0]).searchParams.get('term'), 'We Found Love Rihanna')
  })

  test('Apple down or knowing nothing: the guard stays out of it, not the download', async () => {
    for (const a of ['down', { rows: [] }, { rows: [appleRow('Other Song', 'Tigers Jaw', 'Spirit Desire - EP', 266.7)] }] as const) {
      apple = a
      tourCopy()
      rmSync(join(world, 'calls.log'), { force: true })
      const { walk, importedIds } = store()
      const r = await walk(SPIRIT_ROW)
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['83168035'], JSON.stringify(a))
    }
  })

  test('a row with its own length, a clean row, a rescued row, a row with no artist never ask', async () => {
    tourCopy()
    for (const row of [
      { ...SPIRIT_ROW, durationMs: 283_900 },
      { ...SPIRIT_ROW, cleanedSource: true },
      { ...SPIRIT_ROW, cleanedSource: true, durationMs: 283_900 },
      { ...SPIRIT_ROW, explicitSource: true },
      { ...SPIRIT_ROW, title: 'Spirit Desire [Amended]' },
      { ...SPIRIT_ROW, album: 'Spirit Desire [Amended Version]' },
      { title: 'Spirit Desire' },
      { artist: 'Tigers Jaw', song: '' },
    ]) {
      await store().walk(row)
      assert.deepEqual(appleAsked, [], JSON.stringify(row))
    }
  })

  test('a whole album has its own lookups, and does not ask for a song by the album’s name', async () => {
    await store().walk({ artist: 'Tigers Jaw', album: 'Spirit Desire - EP' })
    assert.ok(appleAsked.length > 0, 'it did look the album up')
    assert.deepEqual(appleAsked.filter((u) => u.includes('entity=song') && u.includes('/search')), [])
  })

  test('main.log says what Apple said, on a walk that failed', async () => {
    tourCopy()
    delete qobuz['83168035']
    delete qobuz['187259764']
    const trace = (): string => warned.find((l) => l.startsWith('[download] trace')) ?? ''
    apple = { rows: SPIRIT_APPLE }
    await store().walk(SPIRIT_ROW)
    assert.match(trace(), /apple lists 5:11 ±5/)
    warned = []
    apple = 'down'
    rmSync(join(world, 'search-qobuz-track.json'))
    await store().walk(SPIRIT_ROW)
    assert.match(trace(), /apple: no answer, so no length/)
    warned = []
    apple = { rows: [SPIRIT_APPLE[0]] }
    await store().walk(SPIRIT_ROW)
    assert.match(trace(), /apple: no length for this recording/)
  })

  test('a file the row’s album does not run is refused on its tags too, when Qobuz would not say', async () => {
    apple = { rows: SPIRIT_APPLE }
    tourCopy()
    delete qobuz['83168035']
    delete qobuz['187259764']
    const { walk, importedIds } = store()
    const r = await walk(SPIRIT_ROW)
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(ripped(), ['83168035', '187259764'], 'no answer from Qobuz goes on unjudged, and the file is judged')
    assert.deepEqual(importedIds(), [])
  })

  test('Girls and Boys: a row naming Parklife takes none of the 259 s edits off compilations, whatever else Apple lists', async () => {
    // homemini, 2026-11-05: "Apple lists “Girls and Boys” at 291.2s ±5, 258.8s ±5", and the edit off 90's Rock Anthems came in.
    apple = { rows: [appleRow('Girls and Boys', 'Blur', 'Parklife', 291.2), appleRow('Girls and Boys', 'Blur', 'The Best Of', 258.8)] }
    hits([['175845990', 'Girls and Boys by Blur'], ['177701023', 'Girls and Boys by Blur'], ['372418388', 'Girls and Boys by Blur']])
    qobuz['175845990'] = { title: 'Girls and Boys', duration: 259, parental_warning: false, album: { title: "90's Rock Anthems", parental_warning: true } }
    qobuz['177701023'] = { title: 'Girls and Boys', duration: 259, parental_warning: false, album: { title: "Girls & Boys...The 90's!", parental_warning: true } }
    qobuz['372418388'] = { title: 'Girls and Boys', duration: 259, parental_warning: false, album: { title: 'Britpop Bangers', parental_warning: true } }
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Blur', title: 'Girls and Boys', album: 'Parklife' })
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(ripped(), [])
    assert.deepEqual(importedIds(), [])
  })

  test('Bittersweet: "Bittersweet Memories" by Top Fuel is flagged explicit, and can no longer vouch for anything', async () => {
    // On main its flag threw out the three copies by Fuel, and it came in itself.
    apple = { rows: [appleRow('Bittersweet', 'Fuel', 'Sunburn', 232.1), appleRow('Bittersweet', 'Fuel', 'The Best of Fuel', 232.1), appleRow('Bittersweet', 'Fuel', 'Sunburn', 231.9)] }
    hits([['53641', 'Bittersweet by Fuel'], ['2719068', 'Bittersweet by Fuel'], ['46975444', 'Bittersweet by Fuel'], ['410331614', 'Bittersweet Memories by Top Fuel']])
    qobuz['53641'] = { title: 'Bittersweet', version: 'Album Version', duration: 232, parental_warning: false, album: { title: 'Sunburn', parental_warning: false } }
    qobuz['2719068'] = { title: 'Bittersweet', version: 'Album Version', duration: 231, parental_warning: false, album: { title: 'The Best of Fuel', parental_warning: false } }
    qobuz['46975444'] = { title: 'Bittersweet', version: 'Album Version', duration: 231, parental_warning: false, album: { title: 'Sunburn', parental_warning: false } }
    qobuz['410331614'] = { title: 'Bittersweet Memories', duration: 263, parental_warning: true, album: { title: 'Conquer Your Mind', parental_warning: true } }
    fileTags('53641', { title: 'Bittersweet (Album Version)', artist: 'Fuel', album: 'Sunburn', duration: 232.1 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Fuel', title: 'Bittersweet', album: 'Sunburn' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(importedIds(), ['53641'])
    assert.deepEqual(ripped(), ['53641'])
  })

  test('Feels Alright: the 206 s edit on a dance comp is passed over, and the album door finds the 533 s single', async () => {
    apple = { rows: [
      appleRow('Feels Alright (feat. Simonne Cooper) [Vocal Mix]', 'Richard F.', 'Feels Alright (feat. Simonne Cooper) - Single', 533.3),
      appleRow('Feels Alright (feat. Simonne Cooper) [Vocal Mix]', 'Richard F.', 'House Top 1000 - The Anthems', 206.0, { collectionArtistName: 'Various Artists' }),
    ] }
    hits([['378182936', 'Feels Alright by F. Richard']])
    qobuz['378182936'] = { title: 'Feels Alright', version: 'Vocal Mix', duration: 206, parental_warning: false, album: { title: 'House Top 1000 - The Anthems', parental_warning: true } }
    put('search-qobuz-album.json', JSON.stringify([{ source: 'qobuz', media_type: 'album', id: 'tf3lzfa373xsz', desc: 'Feels Alright by F. Richard' }]))
    qobuz.tf3lzfa373xsz = { title: 'Feels Alright', artist: { name: 'F. Richard' }, parental_warning: false, tracks: { items: [
      { id: 378125759, title: 'Feels Alright', version: 'Vocal Mix', duration: 533, parental_warning: false, streamable: true, performer: { name: 'F. Richard' } },
      { id: 378125760, title: 'Feels Alright', version: 'Dub Mix', duration: 355, parental_warning: false, streamable: true, performer: { name: 'F. Richard' } },
    ] } }
    fileTags('378125759', { title: 'Feels Alright (Vocal Mix)', artist: 'F. Richard', album: 'Feels Alright', duration: 533.3 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Richard F.', title: 'Feels Alright (Vocal Mix)', album: 'Feels Alright (feat. Simonne Cooper) - Single' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(importedIds(), ['378125759'])
    assert.deepEqual(ripped(), ['378125759'], 'the edit cost no fetch')
  })

  test('Army of Me: with a length, Björk’s own page goes before the bootlegs that answer first', async () => {
    apple = { rows: [appleRow('Army of Me', 'Björk', 'Post', 234.3), appleRow('Army of Me', 'Björk', "Björk's Greatest Hits", 235.5)] }
    bandcamp = [
      { type: 't', name: 'Army of Me', band_name: 'Björk', album_name: '2001‐12‐19∶ Laugardalshöll, Reykjavík, Iceland', item_url_path: 'https://bjrkbootlegrecords.bandcamp.com/track/army-of-me-18' },
      { type: 't', name: 'Army of Me', band_name: 'Björk', album_name: '2001‐10‐12∶ Wang, Boston, MA, USA', item_url_path: 'https://bjrkbootlegrecords.bandcamp.com/track/army-of-me-16' },
      { type: 't', name: 'Army Of Me', band_name: 'Björk', album_name: 'Post', item_url_path: 'https://bjork.bandcamp.com/track/army-of-me' },
    ]
    fileTags('bandcamp', { title: 'Army Of Me', artist: 'Björk', album: 'Post', duration: 234.1 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Björk', title: 'Army of Me', album: 'Post' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(importedIds(), ['bandcamp'])
    const fetched = calls().filter((l) => l.startsWith('yt-dlp '))
    assert.equal(fetched.length, 1, 'the bootlegs cost no try')
    assert.match(fetched[0], /bjork\.bandcamp\.com/)
  })

  test('Bandcamp still gets two tries, doubtful pages or not', async () => {
    apple = { rows: [appleRow('Army of Me', 'Björk', 'Post', 234.3)] }
    bandcamp = ['army-of-me-18', 'army-of-me-16', 'army-of-me-19'].map((slug) => ({ type: 't', name: 'Army of Me', band_name: 'Björk', album_name: 'A show', item_url_path: `https://bjrkbootlegrecords.bandcamp.com/track/${slug}` }))
    fileTags('bandcamp', { title: 'Army of Me', artist: 'Björk', album: 'A show', duration: 250 })
    await store().walk({ artist: 'Björk', title: 'Army of Me', album: 'Post' })
    assert.equal(calls().filter((l) => l.startsWith('yt-dlp ')).length, 2)
  })

  test('Pocket Full Of Cash: Apple’s length lets a real label’s page through, which a row with no length leaves alone', async () => {
    bandcamp = [{ type: 't', name: 'Pocket Full Of Cash', band_name: 'Ruckus', album_name: 'ST 12"', item_url_path: 'https://drunkensailorrecords.bandcamp.com/track/pocket-full-of-cash' }]
    fileTags('bandcamp', { title: 'Pocket Full Of Cash', artist: 'Ruckus', album: 'ST 12"', duration: 173.4 })
    const row = { artist: 'Ruckus', title: 'Pocket Full of Cash', album: 'Ruckus - EP' }
    const withLength = store()
    apple = { rows: [appleRow('Pocket Full of Cash', 'Ruckus', 'Ruckus - EP', 173.4)] }
    assert.equal((await withLength.walk(row)).outcome, 'imported')
    assert.deepEqual(withLength.importedIds(), ['bandcamp'])
    const noLength = store()
    apple = { rows: [] }
    const r = await noLength.walk(row)
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(noLength.importedIds(), [])
    assert.match(r.detail!, /drunkensailorrecords\.bandcamp\.com\/track\/pocket-full-of-cash, left alone/)
  })

  test('with a length, a doubtful page that fails the clock is refused, not left alone', async () => {
    apple = { rows: [appleRow('Army of Me', 'Björk', 'Post', 234.3)] }
    bandcamp = [{ type: 't', name: 'Army of Me', band_name: 'Björk', album_name: '2001‐12‐19∶ Laugardalshöll, Reykjavík, Iceland', item_url_path: 'https://bjrkbootlegrecords.bandcamp.com/track/army-of-me-18' }]
    fileTags('bandcamp', { title: 'Army of Me', artist: 'Björk', album: '2001‐12‐19∶ Laugardalshöll, Reykjavík, Iceland', duration: 250 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Björk', title: 'Army of Me', album: 'Post' })
    assert.deepEqual(importedIds(), [])
    assert.equal(r.outcome, 'exact-not-found')
    assert.ok(r.alternatives?.some((a) => a.provider === 'bandcamp' && a.reason === 'runs 4:10, wanted 3:54'), JSON.stringify(r.alternatives))
    assert.doesNotMatch(r.detail!, /left alone/)
  })

  test('OMA & SitarNik: Apple’s length lets "Oma" through, ranked and judged', async () => {
    const OMA = { artist: 'OMA & SitarNik', title: 'Rapp Snitch Knishes (Sitar Edition)', album: 'Rapp Snitch Knishes (Sitar Edition) - Single' }
    apple = { rows: [appleRow('Rapp Snitch Knishes (Sitar Edition)', 'OMA & SitarNik', 'Rapp Snitch Knishes (Sitar Edition) - Single', 137.0)] }
    hits([['9', 'Rapp Snitch Knishes (Sitar Edition) by Oma']])
    fileTags('9', { title: 'Rapp Snitch Knishes (Sitar Edition)', artist: 'Oma', album: 'Rapp Snitch Knishes (Sitar Edition)', duration: 137 })
    const { walk, importedIds } = store()
    const r = await walk(OMA)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(importedIds(), ['9'])
  })
})
