// Launch page "G" document (src/common/home-spotlight-doc.ts): the tolerant,
// never-guessing parser of homemini's /api/home-spotlight, and the offline
// fallback — which album, which artist, who's new — from this Mac's own
// play-events.jsonl + library.json through the shared rulebook.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHomeSpotlight, localSpotlightDoc, parsePlayEvents, spotTracksOf, isEmptySpotlight, NOW_DIGGING_MAX,
} from '../../common/home-spotlight-doc.ts'
import { DAY_MS } from '../../common/home-spotlight.ts'

const NOW = Date.UTC(2026, 9, 18, 22, 0, 0)

describe('parseHomeSpotlight', () => {
  test('an unknown version or a non-object is not a document', () => {
    assert.equal(parseHomeSpotlight(null), null)
    assert.equal(parseHomeSpotlight('<html>'), null)
    assert.equal(parseHomeSpotlight({ version: 2, livingIn: null }), null)
  })

  test('drops what it cannot trust, keeps the rest', () => {
    const d = parseHomeSpotlight({
      version: 1,
      generatedAt: 'not a date',
      livingIn: { artist: 'Geese', album: '', plays: 9 },                 // no album → no living-in
      spotlight: { artist: 'Geese', plays30: '81' },                      // a string count → dropped
      musicMan: { line: '   ' },                                          // nothing to say → hidden
      nowDigging: [{ artist: 'Fat Dog', plays30: 8 }, { plays30: 3 }, 'x'],
    })
    assert.ok(d)
    assert.equal(d.generatedAt, null)
    assert.equal(d.livingIn, null)
    assert.equal(d.spotlight, null)
    assert.equal(d.musicMan, null)
    assert.deepEqual(d.nowDigging.map((x) => x.artist), ['Fat Dog'])
    assert.equal(d.nowDigging[0].debutSource, 'unknown')
    assert.deepEqual(d.nowDigging[0].days, [])
  })

  test('the backend’s shape: topSong objects, an empty artworkHash means none', () => {
    const d = parseHomeSpotlight({
      version: 1,
      generatedAt: '2026-10-18T21:55:00.000Z',
      livingIn: { artist: 'Geese', album: 'Getting Killed', artworkHash: '', plays: 33, windowDays: 14 },
      spotlight: null,
      musicMan: { line: 'You keep coming back to Getting Killed. Tonight we do it properly — front to back.', generatedAt: '2026-10-18T21:55:00.000Z', source: 'fallback' },
      nowDigging: [{ artist: 'ADÉLA', plays30: 9, days: Array.from({ length: 30 }, () => 0), firstHeard: null, topSong: { title: 'Hitachi', plays: 4 }, debutYear: null, debutSource: 'unknown' }],
    })!
    assert.equal(d.livingIn?.artworkHash, null)
    assert.equal(d.musicMan?.source, 'fallback')
    assert.deepEqual(d.nowDigging[0].topSong, { title: 'Hitachi', plays: 4 })
    assert.equal(d.nowDigging[0].days.length, 30)
  })

  test('missing copy is rebuilt with the rulebook, never written fresh', () => {
    const d = parseHomeSpotlight({
      version: 1,
      livingIn: { artist: 'Geese', album: 'Getting Killed', plays: 12, windowDays: 14 },
      spotlight: { artist: 'Geese', plays30: 16, topSong: { title: 'Taxes', plays: 7 }, firstHeard: '2026-08-09T12:00:00Z' },
      nowDigging: [],
    })!
    assert.equal(d.spotlight?.headline, "You can't stop playing Geese.")
    assert.equal(d.spotlight?.statsLine, '16 plays in 30 days · “Taxes” on repeat · with you since Aug 9')
    assert.equal(d.livingIn?.windowDays, 14)
    assert.equal(d.livingIn?.artworkHash, null)
  })

  test('an old bare-string topSong reads as { title, plays: null } and never claims "on repeat"', () => {
    const d = parseHomeSpotlight({ version: 1, spotlight: { artist: 'Geese', plays30: 5, topSong: 'Taxes' }, nowDigging: [] })!
    assert.deepEqual(d.spotlight?.topSong, { title: 'Taxes', plays: null })
    assert.equal(d.spotlight?.statsLine, '5 plays in 30 days')
  })

  test('Now Digging is capped at five; the parse is idempotent (the cache re-reads its own output)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ artist: `Band ${i}`, plays30: 10 - i, topSong: 'Song', debutYear: 2020, debutSource: 'library' }))
    const d = parseHomeSpotlight({ version: 1, livingIn: null, spotlight: null, musicMan: { line: 'Hi.', source: 'weird' }, nowDigging: many })!
    assert.equal(d.nowDigging.length, NOW_DIGGING_MAX)
    assert.equal(d.musicMan?.source, 'fallback')
    assert.deepEqual(parseHomeSpotlight(d), d)
  })
})

describe('the offline fallback — this Mac’s own history', () => {
  // library.json rows as the app stores them; play-events.jsonl lines as appendPlayEvent writes them.
  const library = [
    { id: 1, title: 'Taxes', artist: 'Geese', album: 'Getting Killed', dateAdded: '2026-08-09T12:00:00Z', year: 2025, playCount: 99 },
    { id: 2, title: 'Trinidad', artist: 'Geese', album: 'Getting Killed', dateAdded: '2026-08-09T12:00:00Z', year: 2025 },
    { id: 3, title: 'Do Ya', artist: 'Steely Dan', album: "Can't Buy A Thrill", dateAdded: '2019-02-01T12:00:00Z', year: 1972 },
    { id: 4, title: 'Hitachi', artist: 'ADÉLA', album: 'Hitachi', dateAdded: '2026-09-05T12:00:00Z', year: 2026 },
    { id: 5, title: 'Comp', artist: 'Someone', albumArtist: 'Various Artists', album: 'Now 99', dateAdded: '2026-10-10T12:00:00Z', year: 2026 },
    { title: 'no id' },
  ]
  const line = (id: number, daysAgo: number): string => JSON.stringify({ id, ts: NOW - daysAgo * DAY_MS - 60_000 })
  const events = [
    // Steely Dan: lots of plays, but 20+ days ago — outside the 14-day window.
    ...Array.from({ length: 9 }, () => line(3, 20)),
    // Geese: 6 in the last two weeks — the album you're living in.
    line(1, 1), line(1, 2), line(1, 2), line(2, 3), line(1, 5), line(2, 9),
    // ADÉLA: new to you, 3 plays.
    line(4, 2), line(4, 4), line(4, 6),
    // A compilation never wins, however much it plays.
    ...Array.from({ length: 8 }, () => line(5, 1)),
    '{"id":4,"ts":', // torn last line of an append-only log
  ].join('\n')

  test('parsePlayEvents skips the torn line; spotTracksOf skips rows without an id', () => {
    assert.equal(parsePlayEvents(events).length, 26)
    assert.equal(spotTracksOf(library).length, 5)
  })

  test('the 14-day album beats an older heavy rotation; the compilation never wins', () => {
    const d = localSpotlightDoc(spotTracksOf(library), parsePlayEvents(events), NOW)
    assert.equal(d.livingIn?.artist, 'Geese')
    assert.equal(d.livingIn?.album, 'Getting Killed')
    assert.equal(d.livingIn?.windowDays, 14)
    assert.equal(d.livingIn?.plays, 6)
    assert.equal(d.spotlight?.headline, "Lately, it's Geese.")
    assert.equal(d.spotlight?.statsLine, '6 plays in 30 days · “Taxes” on repeat · with you since Aug 9')
    assert.equal(d.spotlight?.days.length, 30)
    assert.equal(d.musicMan, null)
  })

  test('Now Digging: new + not legacy, ranked by plays; the old favourite stays out', () => {
    const d = localSpotlightDoc(spotTracksOf(library), parsePlayEvents(events), NOW)
    assert.deepEqual(d.nowDigging.map((x) => x.artist), ['Geese', 'ADÉLA'])
    assert.equal(d.nowDigging[0].debutSource, 'library')                // no MusicBrainz offline
    assert.deepEqual(d.nowDigging[1].topSong, { title: 'Hitachi', plays: 3 })
    assert.equal(d.nowDigging[1].firstHeard, '2026-09-05T12:00:00.000Z')
  })

  test('with only the old plays: the 30-day window takes over', () => {
    const old = Array.from({ length: 9 }, () => line(3, 20)).join('\n')
    const d = localSpotlightDoc(spotTracksOf(library), parsePlayEvents(old), NOW)
    assert.equal(d.livingIn?.album, "Can't Buy A Thrill")
    assert.equal(d.livingIn?.windowDays, 30)
    assert.deepEqual(d.nowDigging, [])                                    // Steely Dan is not new
  })

  test('nothing played enough → an empty document the Home hides', () => {
    const d = localSpotlightDoc(spotTracksOf(library), parsePlayEvents([line(1, 1), line(2, 1)].join('\n')), NOW)
    assert.equal(d.livingIn, null)
    assert.equal(d.spotlight, null)
    assert.equal(isEmptySpotlight(d), true)
    assert.equal(isEmptySpotlight(null), true)
  })
})
