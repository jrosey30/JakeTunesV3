/**
 * Other spellings of a library artist, from MusicBrainz (2026-10-11).
 *
 * ⚠️ TWIN FIXTURES: SPELLING_FIXTURES is copy-shared VERBATIM with
 * ~/JakeTunesMobile/backend/src/util/__tests__/artistSpellings.test.ts. The
 * MusicBrainz answers are the live ones for Jake's non-Latin artists
 * (trimmed), so both repos read the same spellings off the same data.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pickMbArtist, mbSpellings, musicBrainzSpellings, otherScriptArtists, cachedSpellings, staleSpellingArtists,
  ensureSpellings, SPELLING_TTL_MS, type MbArtistNames, type SpellingCache,
} from '../artist-spellings.ts'
import { markKnownShows } from '../venues.ts'

// ── SPELLING FIXTURES (shared verbatim with the Mobile suite) ─────────────
const SPELLING_FIXTURES: Array<{ name: string; library: string; artists: MbArtistNames[]; spellings: string[] }> = [
  {
    name: 'Molchat Doma: MusicBrainz names them in Latin; the Cyrillic tag is an alias',
    library: 'Молчат Дома',
    artists: [{ id: '11bcbbf4-1252-496a-b747-06942f3d76db', name: 'Molchat Doma', 'sort-name': 'Molchat Doma', score: 100, aliases: [{ name: 'Молчат Дома' }, { name: 'Molchat Doma' }, { name: 'Molchat Doma' }] }],
    spellings: ['Molchat Doma'],
  },
  {
    name: 'Hadag Nahash: the sort name is the transliteration, plus a variant alias',
    library: 'הדג נחש',
    artists: [{ id: '4f4563ac-c437-4bd7-8b93-539121efd071', name: 'הדג נחש', 'sort-name': 'Hadag Nahash', score: 100, aliases: [{ name: 'Hadag Nachash' }, { name: 'Hadag Nahash' }] }],
    spellings: ['Hadag Nahash', 'Hadag Nachash'],
  },
  {
    name: 'Berry Sakharof: a person — "Sakharof, Berry" is put back in order',
    library: 'ברי סחרוף',
    artists: [{ id: '01f94ec3-536a-4461-9621-82628247cd06', name: 'ברי סחרוף', 'sort-name': 'Sakharof, Berry', score: 100, aliases: [{ name: 'Berry Sakharof' }] }],
    spellings: ['Berry Sakharof'],
  },
  {
    name: 'Zikney Tzfat: sort name only, no aliases',
    library: 'זקני צפת',
    artists: [{ id: 'c7f354a6-e5f9-4cb1-8d17-e9cecca71bc2', name: 'זקני צפת', 'sort-name': 'Zikney Tzfat', score: 100, aliases: [] }],
    spellings: ['Zikney Tzfat'],
  },
  {
    name: 'Dag: MusicBrainz has no other spelling — nothing to add',
    library: 'דג',
    artists: [{ id: '5f94ac81-04ae-455c-8dd9-b5b646549539', name: 'דג', 'sort-name': 'דג', score: 100, aliases: [] }],
    spellings: [],
  },
  {
    name: 'two artists under the same name: ambiguous, so no spellings at all',
    library: 'Кино',
    artists: [{ id: 'a', name: 'Кино', 'sort-name': 'Kino', score: 100 }, { id: 'b', name: 'Кино', 'sort-name': 'Kino (film band)', score: 100 }],
    spellings: [],
  },
  {
    name: 'a weak search hit is not the artist',
    library: 'Кино',
    artists: [{ id: 'a', name: 'Кино', 'sort-name': 'Kino', score: 60 }],
    spellings: [],
  },
  {
    name: 'a different artist that merely came back from the search is not the artist',
    library: 'ברי סחרוף',
    artists: [{ id: 'x', name: 'Rockfour', 'sort-name': 'Rockfour', score: 95, aliases: [{ name: 'רוקפור' }] }],
    spellings: [],
  },
]

const spellingsOf = (artists: MbArtistNames[], library: string): string[] => {
  const hit = pickMbArtist(artists, library)
  return hit ? mbSpellings(hit, library) : []
}

describe('reading spellings off MusicBrainz', () => {
  it('parity fixtures', () => {
    for (const f of SPELLING_FIXTURES) assert.deepEqual(spellingsOf(f.artists, f.library), f.spellings, f.name)
  })
  it('a busy MusicBrainz is "ask again later" (null), an unknown artist is a real empty answer', async () => {
    const busy = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch
    assert.equal(await musicBrainzSpellings('הדג נחש', 'ua', busy), null)
    const nobody = (async () => ({ ok: true, json: async () => ({ artists: [] }) })) as unknown as typeof fetch
    assert.deepEqual(await musicBrainzSpellings('הדג נחש', 'ua', nobody), [])
    const live = (async () => ({ ok: true, json: async () => ({ artists: SPELLING_FIXTURES[1].artists }) })) as unknown as typeof fetch
    assert.deepEqual(await musicBrainzSpellings('הדג נחש', 'ua', live), ['Hadag Nahash', 'Hadag Nachash'])
  })
})

describe('which artists, and when', () => {
  it('only names with another script are looked up, once each', () => {
    assert.deepEqual(otherScriptArtists(['Молчат Дома', 'МОЛЧАТ ДОМА', 'Radiohead', 'Sigur Rós', 'הדג נחש', '', '!!!']), ['Молчат Дома', 'הדג נחש'])
  })
  it('looks up only what is missing or stale, through the throttle, and never caches a failure', async () => {
    const now = 1_800_000_000_000
    const cache: SpellingCache = {
      'הדג נחש': { spellings: ['Hadag Nahash'], at: now - 1000 },               // fresh
      'זקני צפת': { spellings: ['Zikney Tzfat'], at: now - SPELLING_TTL_MS - 1 }, // stale
    }
    const asked: string[] = []
    let throttled = 0
    const n = await ensureSpellings(['הדג נחש', 'זקני צפת', 'Молчат Дома', 'דג'], cache, {
      now,
      throttle: async () => { throttled++ },
      fetchSpellings: async (a) => { asked.push(a); return a === 'Молчат Дома' ? ['Molchat Doma'] : a === 'דג' ? null : ['Zikney Tzfat'] },
    })
    assert.deepEqual(asked, ['זקני צפת', 'Молчат Дома', 'דג'])
    assert.equal(throttled, 3)
    assert.equal(n, 2)
    assert.deepEqual(cache['молчат дома'], { spellings: ['Molchat Doma'], at: now })
    assert.equal(cache['דג'], undefined, 'MusicBrainz was busy — asked again next time')
    assert.deepEqual(staleSpellingArtists(cache, ['הדג נחש', 'זקני צפת', 'Молчат Дома', 'דג'], now), ['דג'])
    assert.deepEqual(cachedSpellings(cache, ['Молчат Дома', 'הדג נחש']), ['Molchat Doma', 'Hadag Nahash'])
  })
  it('caps the lookups per call', async () => {
    let asked = 0
    await ensureSpellings(['א', 'ב', 'ג'], {}, { now: 1, maxLookups: 2, throttle: async () => {}, fetchSpellings: async () => { asked++; return [] } })
    assert.equal(asked, 2)
  })
})

describe('venue shows meet the transliteration', () => {
  const tracks = [{ artist: 'Молчат Дома' }, { artist: 'הדג נחש' }]
  it('"Molchat Doma" at a Brooklyn room reads as Jake\'s "Молчат Дома"; a stranger still does not', () => {
    const spellings = [...spellingsOf(SPELLING_FIXTURES[0].artists, 'Молчат Дома'), ...spellingsOf(SPELLING_FIXTURES[1].artists, 'הדג נחש')]
    const shows = [{ artist: 'Molchat Doma' }, { artist: 'HADAG NAHASH' }, { artist: 'Kino' }, { artist: 'Boy Harsher' }]
    assert.deepEqual(markKnownShows(shows, tracks, spellings).map((s) => s.known), [true, true, false, false])
    assert.deepEqual(markKnownShows(shows, tracks).map((s) => s.known), [false, false, false, false], 'without spellings, as before')
  })
  it('index.ts get-venue-shows passes the library spellings', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    assert.match(src, /const spellings = await librarySpellings\(lib\.tracks \|\| \[\], \{ throttle: mbThrottle, userAgent: /)
    assert.match(src, /markKnownShows\(shows, lib\.tracks \|\| \[\], spellings\)\.slice\(0, 120\)/)
  })
})
