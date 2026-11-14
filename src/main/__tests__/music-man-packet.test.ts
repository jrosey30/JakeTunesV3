/**
 * The facts the Music Man is handed, per page (common/music-man-packet.ts).
 * The album below is Jake's own copy of "The Holy Cross Tigers" as the library
 * and homemini's profile had it on 2026-11-13, the day he couldn't place it.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPacket, factsOnlyAnswer, subjectKey, subjectLabel,
  type PacketArtist, type PacketInput, type PacketSong,
} from '../../common/music-man-packet.ts'
import { isNonAnswer } from '../../common/non-answer.ts'

const TITLES = ['Stalks', 'When We First Met', 'Be An Angel', 'Blue Rose', 'I Spend My Time Crying', 'Blue Flower', 'I Bring',
  'Look In The Mirror', 'Lock And Key', 'Figure It Out', 'Armed With A Vision', 'Every Flower', 'Darker The Night Is The Brighter I See']

const tigers = (): PacketSong[] => TITLES.map((title, i) => ({
  id: 14160 + i, title, artist: 'Twisted Teens', album: 'The Holy Cross Tigers', albumArtist: 'Twisted Teens', year: '2026',
  genre: 'Garage Punk', subgenre: 'Garage/Psych, Garage-Punk Revival', trackNumber: i + 1, durationMs: 150_000 + i * 4000,
  plays: i === 0 ? 2 : i < 4 ? 1 : 0, starred: true, addedAt: i === 0 ? '2026-10-23T00:30:58.682Z' : '2026-11-06T15:43:44.717Z',
  lastPlayedAt: i < 4 ? Date.parse('2026-11-11T12:00:00Z') : undefined, bpm: 129 + i * 2.5, key: 'A major',
  from: i === 0 ? 'streamrip' : 'bandcamp', ipods: ['Best of Bandcamp'],
  sound: i === 0 ? 'Fuzzed-out guitars and a shouted hook over a loose, galloping beat: ragged and joyful.' : undefined,
}))

const TEENS: PacketArtist = {
  name: 'Twisted Teens', oneLiner: 'American rock duo.', place: 'New Orleans, Louisiana', since: '2024',
  facts: [{ label: 'Labels', value: 'Sub Pop' }, { label: 'Sound', value: 'Slacker rock, alternative country, garage punk' }],
}

const album = (over: Partial<PacketInput> = {}): PacketInput => ({
  subject: { kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: '2026' },
  songs: tigers(), artist: TEENS, album: null, today: '2026-11-13', ...over,
})

describe('the packet for an album page', () => {
  const p = buildPacket(album())
  test('says what he is looking at and that Jake owns it', () => {
    assert.match(p.text, /WHAT JAKE IS LOOKING AT: the album "The Holy Cross Tigers" by Twisted Teens \(2026\)\. It is in his library\./)
  })
  test("carries the artist page's checked facts", () => {
    assert.match(p.text, /American rock duo\./)
    assert.match(p.text, /From New Orleans, Louisiana, active since 2024/)
    assert.match(p.text, /Labels: Sub Pop/)
    assert.equal(p.thin, false)
  })
  test('lists every song, in order, with what was measured', () => {
    for (const [i, t] of TITLES.entries()) assert.ok(p.text.includes(`${i + 1}. "${t}"`), t)
    assert.match(p.text, /1\. "Stalks" \(2:30, up-tempo\): Fuzzed-out guitars/)
    // The feel, never the number: handed "162 bpm" he read it out like a meter.
    assert.doesNotMatch(p.text, /bpm|major/)
    assert.match(p.text, /- Overall: mostly up-tempo, from up-tempo to fast/)
    assert.match(p.text, /13 songs in the library, \d+ minutes, filed under Garage Punk/)
    assert.equal(p.hasSound, true)
  })
  test("carries Jake's own history with it", () => {
    assert.match(p.text, /In his library since 2026-10-23 \(the rest by 2026-11-06\), in the last week; the files came from bandcamp/)
    assert.match(p.text, /5 plays here in all\. Most played: "Stalks" \(2\)/)
    assert.match(p.text, /He starred every one of the 13 songs/)
    assert.match(p.text, /On his iPods: Best of Bandcamp \(13 songs\)/)
    // No count of unplayed songs: plays here are only the plays in JakeTunes, and it made every answer a tease.
    assert.doesNotMatch(p.text, /hasn't played/)
  })
  test('stays compact', () => {
    assert.ok(p.text.length < 4500, `${p.text.length} chars`)
  })
  test('with no profile and no history it is thin, and still has the sound and his own data', () => {
    const bare = buildPacket(album({ artist: null }))
    assert.equal(bare.thin, true)
    assert.equal(bare.hasSound, true)
    assert.match(bare.text, /WHAT IT SOUNDS LIKE/)
    assert.match(bare.text, /JAKE AND THIS/)
    assert.doesNotMatch(bare.text, /FACTS ABOUT THE ARTIST/)
  })
  test('the album page facts ride along when the app has them', () => {
    const full = buildPacket(album({ album: { label: 'Sub Pop', released: '2026-10-17', producer: 'Someone', people: ['A (guitar)', 'B (drums)'], history: 'Their first record.' } }))
    assert.match(full.text, /Label: Sub Pop/)
    assert.match(full.text, /Released: 2026-10-17/)
    assert.match(full.text, /Played on it: A \(guitar\); B \(drums\)/)
    assert.match(full.text, /History: Their first record\./)
  })
  test('press is carried, clipped, when the app looked', () => {
    const withPress = buildPacket(album({ artist: null, press: `Twisted Teens signed to Sub Pop. ${'x'.repeat(5000)}` }))
    assert.equal(withPress.thin, false)
    assert.match(withPress.text, /PRESS AND REFERENCE/)
    assert.ok(withPress.text.length < 7500)
  })
})

describe('the packet for the other pages', () => {
  test('an artist page: the facts, the records Jake has, the songs he plays most', () => {
    const p = buildPacket({
      subject: { kind: 'artist', name: 'Twisted Teens' }, songs: tigers(), artist: TEENS,
      records: [{ album: 'The Holy Cross Tigers', year: '2026', songs: 13, plays: 5 }], today: '2026-11-13',
    })
    assert.match(p.text, /WHAT JAKE IS LOOKING AT: the artist Twisted Teens\./)
    assert.match(p.text, /THEIR RECORDS IN HIS LIBRARY\n- "The Holy Cross Tigers" \(2026\): 13 songs, 5 plays/)
    assert.match(p.text, /- "Stalks" by Twisted Teens/)
  })
  test('a song: its place on the record, and that it is the one playing', () => {
    const song = tigers()[0]!
    const p = buildPacket({ subject: { kind: 'song', trackId: song.id }, songs: [song], artist: TEENS, nowPlaying: song, today: '2026-11-13' })
    assert.match(p.text, /the song "Stalks" by Twisted Teens, from "The Holy Cross Tigers"/)
    assert.match(p.text, /It is the song playing right now\./)
    assert.match(p.text, /"Stalks" is track 1 on "The Holy Cross Tigers" \(2026\), filed under Garage Punk/)
    assert.match(p.text, /He starred it/)
  })
  test('a different song playing is named beside the page', () => {
    const p = buildPacket(album({ nowPlaying: { id: 1, title: 'Marquee Moon', artist: 'Television', album: 'Marquee Moon' } }))
    assert.match(p.text, /Playing right now: "Marquee Moon" by Television \(from "Marquee Moon"\)\./)
  })
  test("an iPod list: what it is for, who is on it, the songs he plays most", () => {
    const songs = tigers()
    const p = buildPacket({
      subject: { kind: 'list', what: 'ipod', name: 'Best of Bandcamp', trackIds: songs.map((s) => s.id), purpose: 'Best of Bandcamp' },
      songs, today: '2026-11-13',
    })
    assert.match(p.text, /the iPod list "Best of Bandcamp"/)
    assert.match(p.text, /13 songs, \d+ minutes; what it is for: Best of Bandcamp/)
    assert.match(p.text, /Most songs by: Twisted Teens \(13\)/)
    assert.match(p.text, /Years: 2026 to 2026/)
  })
  test('a long record is named whole, in order, so he never sends Jake to a song that is not there', () => {
    const double: PacketSong[] = Array.from({ length: 24 }, (_, i) => ({ id: i, title: `Track ${i + 1}`, artist: 'De La Soul', album: '3 Feet High And Rising', trackNumber: i + 1, plays: 24 - i, sound: 'x'.repeat(300), mood: 'About something.' }))
    const p = buildPacket({ subject: { kind: 'album', artist: 'De La Soul', album: '3 Feet High And Rising' }, songs: double, today: '2026-11-13' })
    for (let i = 1; i <= 24; i++) assert.ok(p.text.includes(`${i}. "Track ${i}"`), `track ${i}`)
    assert.doesNotMatch(p.text, /About something\./)
    assert.ok(p.text.length < 5200, `${p.text.length} chars`)
  })
  test('an artist\'s records carry the history the album page shows', () => {
    const p = buildPacket({
      subject: { kind: 'artist', name: 'Twisted Teens' }, songs: tigers(), artist: null,
      records: [{ album: 'The Holy Cross Tigers', year: '2026', songs: 13, plays: 5, history: 'A New Orleans punk band fronted by Caspian Hollywell.' }], today: '2026-11-13',
    })
    assert.match(p.text, /"The Holy Cross Tigers" \(2026\): 13 songs, 5 plays\. A New Orleans punk band fronted by Caspian Hollywell\./)
    assert.equal(p.thin, false)
  })
  test('a long list describes only the songs he plays most', () => {
    const many: PacketSong[] = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Song ${i}`, artist: `Band ${i % 9}`, album: 'A', plays: i, bpm: 120 }))
    const p = buildPacket({ subject: { kind: 'list', what: 'playlist', name: 'Everything', trackIds: many.map((s) => s.id) }, songs: many, today: '2026-11-13' })
    assert.match(p.text, /"Song 199"/)
    assert.doesNotMatch(p.text, /"Song 3"/)
    assert.match(p.text, /\(and 186 more\)/)
    assert.ok(p.text.length < 4000)
  })
  test('nothing of it in the library is said plainly', () => {
    const p = buildPacket({ subject: { kind: 'artist', name: 'Nobody' }, songs: [], artist: { name: 'Nobody', oneLiner: 'A band.' }, today: '2026-11-13' })
    assert.match(p.text, /None of it is in his library yet\./)
  })
})

describe('keys and labels', () => {
  test('one key per subject, case and space aside', () => {
    assert.equal(subjectKey({ kind: 'album', artist: ' Twisted Teens ', album: 'THE HOLY CROSS TIGERS' }), 'album|twisted teens|the holy cross tigers')
    assert.equal(subjectKey({ kind: 'artist', name: 'Twisted Teens' }), 'artist|twisted teens')
    assert.equal(subjectKey({ kind: 'song', trackId: 12970 }), 'song|12970')
    assert.equal(subjectKey({ kind: 'list', what: 'ipod', name: 'punkPod', trackIds: [1] }), 'list|ipod|punkpod')
  })
  test('labels read as words', () => {
    assert.equal(subjectLabel({ kind: 'list', what: 'playlist', name: 'Road', trackIds: [1] }), 'the playlist "Road"')
    assert.equal(subjectLabel({ kind: 'song', trackId: 1 }), 'a song')
  })
})

describe('the plain answer when a model twice had none', () => {
  test('says only what is checked, and how it sounds', () => {
    const a = factsOnlyAnswer(album())
    assert.match(a, /^Twisted Teens: American rock duo, out of New Orleans, Louisiana, on Sub Pop\./)
    assert.match(a, /"The Holy Cross Tigers" is 13 songs in \d+ minutes/)
    assert.match(a, /You starred all 13, and "Stalks" is the one you play most\./)
    assert.equal(isNonAnswer(a), false)
  })
  test('with no profile it still has the record and the sound', () => {
    const a = factsOnlyAnswer(album({ artist: null }))
    assert.doesNotMatch(a, /^Twisted Teens:/)
    assert.match(a, /"Stalks": Fuzzed-out guitars/)
    assert.equal(isNonAnswer(a), false)
  })
})
