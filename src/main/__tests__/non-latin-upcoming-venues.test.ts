/**
 * "On the Horizon" and "At Your Venues" in other alphabets (2026-10-11) —
 * the pattern of non-latin-keys.test.ts.
 *
 * Both folded artist names with [a-z0-9], which erased every Hebrew and
 * Cyrillic name. Both skip an empty key, so these were misses, not
 * collisions: a Hebrew or Cyrillic artist's new record never showed, and a
 * show listed under one never read as "known". In-memory only, nothing stored.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { upcomingFromGroups } from '../external.ts'
import { markKnownShows } from '../venues.ts'

const BERRY = 'ברי סחרוף'          // Berry Sakharof
const HADAG = 'הדג נחש'            // Hadag Nahash
const MOLCHAT = 'Молчат Дома'      // Molchat Doma
const KINO = 'Кино'

const NOW = new Date('2026-10-11T12:00:00Z')
const rg = (id: string, credit: string, artistName = credit, date = '2026-11-20') => ({
  id, title: `Record ${id}`, 'first-release-date': date, 'primary-type': 'Album', 'secondary-types': [],
  'artist-credit': [{ name: credit, artist: { name: artistName, id: `mb-${id}` } }],
})

describe('upcoming releases (upcomingFromGroups)', () => {
  it("an owned Hebrew or Cyrillic artist's new record shows", () => {
    // MusicBrainz credits them in their own script; Molchat Doma's ARTIST name
    // is Latin but the credit on the release group is Cyrillic (checked live).
    const got = upcomingFromGroups([rg('1', HADAG), rg('2', MOLCHAT, 'Molchat Doma')], [HADAG, MOLCHAT, 'Radiohead'], NOW)
    assert.deepEqual(got.map((r) => r.artist), [HADAG, MOLCHAT])
  })
  it("an artist the listener doesn't own still never shows — in any script", () => {
    assert.deepEqual(upcomingFromGroups([rg('1', KINO), rg('2', HADAG)], [BERRY, MOLCHAT], NOW), [])
  })
  it('a joint credit is not the owned artist, in Hebrew as in Latin', () => {
    // [a-z0-9] read "Rockfour & ברי סחרוף" as plain "rockfour" — owned.
    assert.deepEqual(upcomingFromGroups([rg('1', `Rockfour & ${BERRY}`), rg('2', 'Rockfour & Friends')], ['Rockfour'], NOW), [])
  })
  it('Latin folding and every other rule are unchanged', () => {
    assert.deepEqual(upcomingFromGroups([rg('1', 'Sigur Ros')], ['Sigur Rós'], NOW).map((r) => r.mbid), ['1'])
    assert.deepEqual(upcomingFromGroups([rg('1', HADAG, HADAG, '2026')], [HADAG], NOW), [], 'a bare year is a placeholder')
    assert.deepEqual(upcomingFromGroups([rg('1', HADAG, HADAG, '2026-01-10')], [HADAG], NOW), [], 'already out')
    assert.deepEqual(upcomingFromGroups([{ ...rg('1', HADAG), 'secondary-types': ['Live'] }], [HADAG], NOW), [], 'live albums stay out')
  })
})

describe('venue shows (markKnownShows)', () => {
  const tracks = [{ artist: BERRY }, { artist: 'Track Artist', albumArtist: MOLCHAT }, { artist: 'Radiohead' }]
  it('a show listed under a Hebrew or Cyrillic library artist reads as known; another one does not', () => {
    const shows = [{ artist: BERRY }, { artist: HADAG }, { artist: 'МОЛЧАТ ДОМА' }, { artist: 'Radiohead' }]
    assert.deepEqual(markKnownShows(shows, tracks).map((s) => s.known), [true, false, true, true])
  })
  it('a name that folds to nothing is never known', () => {
    assert.deepEqual(markKnownShows([{ artist: '!!!' }], [{ artist: '!!!' }, { artist: '???' }]).map((s) => s.known), [false])
  })
  it('a venue that transliterates ("Molchat Doma") meets the Cyrillic tag only through MusicBrainz spellings (artist-spellings.test.ts)', () => {
    assert.deepEqual(markKnownShows([{ artist: 'Molchat Doma' }], tracks).map((s) => s.known), [false])
    assert.deepEqual(markKnownShows([{ artist: 'Molchat Doma' }], tracks, ['Molchat Doma']).map((s) => s.known), [true])
  })
  it('index.ts get-venue-shows marks through it', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    assert.match(src, /return \{ ok: true, shows: markKnownShows\(shows, lib\.tracks \|\| \[\], spellings\)\.slice\(0, 120\) \}/)
  })
})
