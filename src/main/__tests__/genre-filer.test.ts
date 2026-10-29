/**
 * The genre filer (2026-10-11): new songs land on Jake's list, by his rules,
 * enforced in code — every rule here was learned from a real mistake on 10/11.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  unfiledUnits, artistHomes, decideByRules, enforce, runFilerSweep, resolveCheckEntry, trackFingerprint, parseReply,
  fileableSuggestion, checkEntryOpen,
  type FilerTrack, type CheckEntry, type FilerDeps,
} from '../genre-filer.ts'
import { GENRES, GENRE_NAMES, CATCH_ALL, phoneOverlayFields } from '../../common/genre-vocab.ts'
import { matchMbArtist, confirmedArtist, countryName, musicBrainzCountryById } from '../artist-tags.ts'
import type { OriginLookup } from '../origin-lookup.ts'

const found = (origin: string): OriginLookup => ({ kind: 'found', origin, source: 'mb', mbid: 'test', evidence: 'test' })
const unknown: OriginLookup = { kind: 'unknown', note: 'test' }

const T = (id: number, artist: string, album: string, genre: string, extra: Partial<FilerTrack> = {}): FilerTrack =>
  ({ id, title: `t${id}`, artist, album, genre, duration: 1000 + id, ...extra })

const LIB: FilerTrack[] = [
  T(1, 'Telescreens', '7', 'Indie Rock', { origin: 'United States', genreApproved: true }),
  T(2, 'Telescreens', 'Why the Lights Flicker', 'Alternative'),           // new album, store tag
  T(3, 'Gramme', 'Fascination', 'Alternatif et Indé, Rock, Pop'),         // new artist, junk tag
  T(4, 'Gramme', 'Fascination', 'Alternatif et Indé, Rock, Pop'),
  T(5, 'Charley Crockett', 'Clovis', 'Country'),                          // store tag already on the list
  T(6, 'King Gizzard & The Lizard Wizard', 'Nonagon Infinity', 'Garage Rock', { genreApproved: true }),
  T(7, 'King Gizzard & The Lizard Wizard', 'Infest the Rats Nest', 'Rock'),
  T(8, 'Various Artists', 'Comp', 'Dance', { artist: 'Modjo', albumArtist: 'Various Artists', title: 'Lady' }),
  T(9, 'The Sick Rose', 'Shaking Street', 'Rock'),
]

describe('what needs filing', () => {
  it('songs off the list, one unit per album; compilations per song', () => {
    const u = unfiledUnits(LIB)
    assert.deepEqual(u.map((x) => x.artist).sort(), ['Gramme', 'King Gizzard & The Lizard Wizard', 'Modjo', 'Telescreens', 'The Sick Rose'].sort())
    assert.deepEqual(u.find((x) => x.artist === 'Gramme')!.ids, [3, 4])
    assert.ok(u.find((x) => x.artist === 'Modjo')!.comp)
    assert.ok(!u.some((x) => x.artist === 'Charley Crockett'), 'Country is a specific list genre — nothing to do')
  })
  it("his approved catch-alls stay put; the same word from a store gets filed", () => {
    const geese = T(20, 'Geese', 'Getting Killed', 'Rock', { genreApproved: true })
    const store = T(21, 'New Band', 'Debut', 'Rock')
    assert.deepEqual(unfiledUnits([geese, store]).map((x) => x.artist), ['New Band'])
  })
})

describe('rules that need no lookup', () => {
  const homes = artistHomes(LIB)
  const units = new Map(unfiledUnits(LIB).map((u) => [u.artist, u]))
  it('an artist he already has goes on their shelf, with their origin', () => {
    const d = decideByRules(units.get('Telescreens')!, homes)
    assert.deepEqual([d?.genre, d?.origin, d?.how], ['Indie Rock', 'United States', 'artist-home'])
  })
  it('King Gizzard is judged per album — never pulled to a home shelf', () => {
    assert.equal(decideByRules(units.get('King Gizzard & The Lizard Wizard')!, homes), null)
  })
  it('a new artist with a catch-all or junk tag needs evidence', () => {
    assert.equal(decideByRules(units.get('Gramme')!, homes), null)
    assert.equal(decideByRules(units.get('The Sick Rose')!, homes), null, '"Rock" is a catch-all')
  })
  it('a specific list genre already on the song stands', () => {
    const d = decideByRules({ key: 'k', artist: 'New Band', album: 'A', comp: false, ids: [1], tag: 'Shoegaze' }, new Map())
    assert.equal(d?.genre, 'Shoegaze')
  })
})

describe("the AI's pick, enforced", () => {
  const rockUnit = { key: 'k', artist: 'Telescreens', album: '7', comp: false, ids: [1], tag: 'Rock' }
  it('rock stays rock: Telescreens can never become Synth-Pop', () => {
    const d = enforce(rockUnit, { genre: 'Synth-Pop', confidence: 'high' })
    assert.equal(d.genre, null)
    assert.equal(d.suggested, 'Synth-Pop')
  })
  it('a rock-to-rock move is fine', () => {
    assert.equal(enforce(rockUnit, { genre: 'Garage Rock', confidence: 'medium' }).genre, 'Garage Rock')
  })
  it('only names on his list; unsure goes to the check list', () => {
    assert.equal(enforce({ ...rockUnit, tag: '' }, { genre: 'Punk-Funk', confidence: 'high' }).genre, null)
    assert.equal(enforce({ ...rockUnit, tag: '' }, { genre: 'Dance-Punk', confidence: 'low' }).genre, null)
    assert.equal(enforce({ ...rockUnit, tag: '' }, { genre: 'Dance-Punk', confidence: 'medium' }).genre, 'Dance-Punk')
  })
  it('reads the model reply even with prose around it', () => {
    assert.deepEqual(parseReply('Here you go:\n[{"id": 0, "genre": "Funk", "confidence": "high"}]'), [{ id: '0', genre: 'Funk', confidence: 'high' }])
  })
})

function fakeDeps(lib: FilerTrack[], picks: Record<string, { genre: string; confidence: string }>) {
  const persisted: Array<[number, Record<string, string>]> = []
  const applied: Array<{ trackId: number; field: string; newValue: string }> = []
  let check: CheckEntry[] = []
  const classified: string[] = []
  const deps: FilerDeps = {
    tracks: async () => lib,
    persist: async (t, f) => { persisted.push([t.id, f]) },
    applied: (u) => { applied.push(...u) },
    evidence: async (u) => ({ artistTags: u.artist === 'Gramme' ? [] : ['rock'], albumTags: [], origin: u.artist === 'Gramme' ? 'United Kingdom' : undefined, press: u.artist === 'Gramme' ? 'London punk-funk band (DIY, Time Out)' : '' }),
    classify: async (_s, user) => {
      classified.push(user)
      const lines = user.split('\n').filter((l) => l.startsWith('id='))
      return JSON.stringify(lines.map((l) => { const id = l.slice(3, l.indexOf(' ')); const artist = l.split(' | ')[1].split(' — ')[0]; return { id, ...(picks[artist] ?? { genre: 'Indie Rock', confidence: 'low' }), why: 'test' } }))
    },
    loadCheck: async () => check,
    saveCheck: async (c) => { check = c },
    now: () => new Date('2026-10-11T12:00:00Z'),
  }
  return { deps, persisted, applied, classified, get check() { return check } }
}

describe('a sweep', () => {
  it('files known artists without asking, classifies new ones from evidence, lists the unsure', async () => {
    const f = fakeDeps(LIB, { Gramme: { genre: 'Dance-Punk', confidence: 'high' }, 'The Sick Rose': { genre: 'Garage Rock', confidence: 'medium' } })
    const r = await runFilerSweep(f.deps)
    const genreOf = (id: number) => f.persisted.find(([tid, fl]) => tid === id && fl.genre)?.[1].genre
    assert.equal(genreOf(2), 'Indie Rock', 'Telescreens: artist home, no lookup')
    assert.equal(genreOf(3), 'Dance-Punk'); assert.equal(genreOf(4), 'Dance-Punk')
    assert.equal(f.persisted.find(([tid]) => tid === 3)![1].origin, 'United Kingdom', 'origin from MusicBrainz')
    assert.equal(genreOf(9), 'Garage Rock', 'Rock → a rock shelf is allowed')
    assert.ok(!f.classified.join('\n').includes('Telescreens'), 'a known artist never costs a lookup')
    assert.ok(f.classified.join('\n').includes('press: London punk-funk'), 'press is evidence when MusicBrainz is thin')
    const kg = f.check.find((c) => c.artist === 'King Gizzard & The Lizard Wizard')
    assert.ok(kg, 'the default low pick lands on the check list')
    // 2026-10-28: unsure = filed under the suggestion, and still on the list for Jake.
    assert.equal(genreOf(7), 'Indie Rock', 'an unsure album is filed under its suggestion')
    assert.equal(kg!.filedAs, 'Indie Rock', 'and the entry says what it was filed as')
    assert.ok(f.applied.some((u) => u.trackId === 2 && u.field === 'genre' && u.newValue === 'Indie Rock'), 'the screen is told')
    assert.ok(r.filed >= 3)
  })
  it('a listed album is not asked about again; lookups are capped per sweep', async () => {
    const f = fakeDeps(LIB, {})
    f.deps.maxUnits = 1
    const r1 = await runFilerSweep(f.deps)
    assert.equal(r1.deferred, unfiledUnits(LIB).filter((u) => !decideByRules(u, artistHomes(LIB))).length - 1)
    const asked = f.classified.length
    await runFilerSweep(f.deps)
    assert.ok(f.classified.length <= asked + 1)
    assert.equal(new Set(f.check.map((c) => c.key)).size, f.check.length, 'no duplicates on the check list')
  })
})

describe('origin for settled songs', () => {
  it("copies an artist's known origin with no lookup; looks up the rest; never guesses", async () => {
    const lib: FilerTrack[] = [
      T(30, 'Charley Crockett', 'Clovis', 'Country'),                                   // settled genre, no origin
      T(31, 'Charley Crockett', 'Old Album', 'Country', { origin: 'United States', genreApproved: true }),
      T(32, 'Mystery Band', 'A', 'Indie Rock', { genreApproved: true }),
      T(33, 'Nobody Knows', 'B', 'Indie Rock', { genreApproved: true }),
    ]
    const f = fakeDeps(lib, {})
    const asked: string[] = []
    f.deps.lookupOrigin = async (a) => { asked.push(a); return a === 'Mystery Band' ? found('Japan') : unknown }
    const r = await runFilerSweep(f.deps)
    const originOf = (id: number) => f.persisted.find(([tid, fl]) => tid === id && fl.origin)?.[1].origin
    assert.equal(originOf(30), 'United States', 'from his other album — no lookup')
    assert.equal(originOf(32), 'Japan')
    assert.equal(originOf(33), undefined, 'unknown stays blank')
    assert.deepEqual(asked.sort(), ['Mystery Band', 'Nobody Knows'])
    assert.equal(r.origins, 2)
  })
})

describe('names in other alphabets (Молчат Дома → Israel, 10/11)', () => {
  it('keeps Hebrew and Cyrillic artists apart; Hebrew names are Israeli; Cyrillic is never assumed', async () => {
    const lib: FilerTrack[] = [
      T(40, 'ברי סחרוף', 'א', 'Rock', { origin: 'Israel', genreApproved: true }),
      T(41, 'Молчат Дома', 'Этажи', 'Post-Punk', { genreApproved: true }),
      T(42, 'דג', 'למה הים כחול?', 'Israeli Hip-Hop', { genreApproved: true }),
    ]
    const f = fakeDeps(lib, {})
    const asked: string[] = []
    f.deps.lookupOrigin = async (a) => { asked.push(a); return unknown }
    await runFilerSweep(f.deps)
    const originOf = (id: number) => f.persisted.find(([tid, fl]) => tid === id && fl.origin)?.[1].origin
    assert.equal(originOf(41), undefined, "never another artist's origin, never a guess from Cyrillic")
    assert.equal(originOf(42), 'Israel', "Jake's rule: a Hebrew name is an Israeli artist")
    assert.deepEqual(asked.sort(), ['Молчат Дома', 'דג'].sort(), 'each asked on its own')
  })
  it('gives each non-Latin artist and album its own home', () => {
    const homes = artistHomes([
      T(43, 'ברי סחרוף', 'א', 'Rock', { genreApproved: true }),
      T(44, 'Молчат Дома', 'Этажи', 'Post-Punk', { genreApproved: true }),
    ])
    assert.equal(homes.size, 2)
    const units = unfiledUnits([T(45, 'הדג נחש', 'ב', 'Alternative'), T(46, 'זקני צפת', 'ג', 'Alternative')])
    assert.equal(units.length, 2, 'two different albums, not one blank key')
  })
})

describe('MusicBrainz match by alias', () => {
  it('finds Molchat Doma from the Cyrillic spelling, and never matches a different artist', () => {
    const mb = [
      { name: 'Hadag Nahash', score: 90, aliases: [{ name: 'הדג נחש' }] },
      { name: 'Molchat Doma', score: 100, country: 'BY', area: { name: 'Belarus' }, aliases: [{ name: 'Молчат Дома' }] },
    ]
    assert.equal(matchMbArtist(mb, 'Молчат Дома')?.name, 'Molchat Doma')
    assert.equal(matchMbArtist(mb, 'Molchat Doma')?.name, 'Molchat Doma')
    assert.equal(matchMbArtist(mb, 'ברי סחרוף'), undefined)
    assert.equal(matchMbArtist(mb, '!!!'), undefined, 'an empty key matches nothing')
  })
})

describe('MusicBrainz identity is proven by an album (MESH, 10/11)', () => {
  const bristol = { id: 'mesh-uk', name: 'Mesh', score: 100, country: 'GB', area: { name: 'United Kingdom' }, tags: [{ name: 'synthpop', count: 9 }] }
  it("a namesake's genre and origin never count without one of his albums credited to them", () => {
    assert.equal(confirmedArtist([bristol], []), undefined, 'No Fun At All is not on Bristol Mesh')
    assert.equal(confirmedArtist([bristol], ['mesh-philly']), undefined)
    assert.deepEqual(confirmedArtist([bristol], ['mesh-uk']), { id: 'mesh-uk', tags: ['synthpop'], origin: 'United Kingdom' })
  })
  it('origin comes from the country code, not a region name', () => {
    const floyd = { id: 'pf', name: 'Pink Floyd', score: 100, country: 'GB', area: { name: 'England' } }
    const twigs = { id: 'lt', name: 'The Lemon Twigs', score: 100, country: 'US', area: { name: 'Long Island' } }
    assert.equal(confirmedArtist([floyd], ['pf'])!.origin, 'United Kingdom')
    assert.equal(confirmedArtist([twigs], ['lt'])!.origin, 'United States')
    assert.equal(countryName('XW'), undefined, 'worldwide is not a country')
    assert.equal(countryName(undefined), undefined)
  })
  it('a region-only area still yields the country (Gorillaz: England → GB-ENG)', async () => {
    const lookup = (async () => new Response(JSON.stringify({ area: { name: 'England', 'iso-3166-2-codes': ['GB-ENG'] } }), { status: 200 })) as unknown as typeof fetch
    assert.equal(await musicBrainzCountryById('gorillaz', 'test', lookup), 'United Kingdom')
    const busy = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    assert.equal(await musicBrainzCountryById('gorillaz', 'test', busy), null, 'busy = ask again later')
  })
  it('fillOrigins hands the lookup the albums that prove identity', async () => {
    const lib: FilerTrack[] = [T(50, 'MESH', 'No Fun At All', 'Post-Punk', { genreApproved: true }), T(51, 'MESH', 'No Fun At All', 'Post-Punk', { genreApproved: true })]
    const f = fakeDeps(lib, {})
    const seen: Array<[string, string[]]> = []
    f.deps.lookupOrigin = async (a, albums) => { seen.push([a, albums]); return found('United States') }
    await runFilerSweep(f.deps)
    assert.deepEqual(seen, [['MESH', ['No Fun At All']]])
  })
})

describe('unsure albums are filed under the suggestion (2026-10-28, "genre not updated boooo")', () => {
  it('only a suggestion on his list, and rock stays rock', () => {
    assert.equal(fileableSuggestion('Alternatif et Indé, Rock, Pop', 'Indie Rock'), 'Indie Rock')
    assert.equal(fileableSuggestion('Dance, Électronique', 'Punk-Funk'), null, 'not on the list')
    assert.equal(fileableSuggestion('Rock', 'Alternative R&B'), null, 'a Rock album never leaves the rock shelves')
    assert.equal(fileableSuggestion('Rock', 'Indie Rock'), 'Indie Rock')
    assert.equal(fileableSuggestion('Pop, Rock', undefined), null)
  })
  it('albums already waiting on the check list are filed on the next sweep, and stay listed', async () => {
    const lib = [T(31, 'Silica', "Myatt's Song", 'Alternatif et Indé, Rock, Pop'), T(32, 'Viuta', 'Refer To Judgement', 'Soul, Funk, R&B'), T(33, 'Mine', 'Already', 'Dream Pop', { genreApproved: true })]
    const f = fakeDeps(lib, {})
    await f.deps.saveCheck([
      { key: 'album:silica|myatt s song', artist: 'Silica', album: "Myatt's Song", ids: [31], tag: 'Alternatif et Indé, Rock, Pop', suggested: 'Indie Rock', why: 'press covers Silica Gel', at: '', evidence: 2 },
      { key: 'album:viuta|refer to judgement', artist: 'Viuta', album: 'Refer To Judgement', ids: [32], tag: 'Soul, Funk, R&B', suggested: 'Not A Genre', why: '', at: '', evidence: 2 },
      { key: 'album:mine|already', artist: 'Mine', album: 'Already', ids: [33], tag: 'x', suggested: 'Indie Rock', why: '', at: '', evidence: 2 },
    ])
    const r = await runFilerSweep(f.deps)
    assert.deepEqual(f.persisted.filter(([, fl]) => fl.genre).map(([id, fl]) => [id, fl.genre]), [[31, 'Indie Rock']], 'only the fileable, unsettled one')
    assert.equal(r.backfilled, 1)
    assert.equal(f.check.find((c) => c.artist === 'Silica')!.filedAs, 'Indie Rock')
    assert.equal(f.check.length, 3, 'nothing leaves the list by being filed')
    await runFilerSweep(f.deps)
    assert.equal(f.persisted.filter(([id]) => id === 31).length, 1, 'filed once')
  })
  it('a filed entry stays open until he changes or confirms it', () => {
    const c: CheckEntry = { key: 'k', artist: 'Silica', album: 'x', ids: [1], tag: 'Pop', suggested: 'Indie Rock', why: '', at: '', filedAs: 'Indie Rock' }
    assert.equal(checkEntryOpen(c, new Map([[1, T(1, 'Silica', 'x', 'Indie Rock', { genreApproved: true })]])), true, 'still wears the suggestion')
    assert.equal(checkEntryOpen(c, new Map([[1, T(1, 'Silica', 'x', 'Shoegaze', { genreApproved: true })]])), false, 'he filed it himself')
    assert.equal(checkEntryOpen({ ...c, filedAs: undefined }, new Map([[1, T(1, 'Silica', 'x', 'Pop, Rock')]])), true, 'unfiled + junk tag')
    assert.equal(checkEntryOpen(c, new Map()), false, 'the song is gone')
  })
})

describe('the check list', () => {
  it('his pick is written to every song on the album and the entry leaves', async () => {
    const f = fakeDeps(LIB, {})
    await f.deps.saveCheck([{ key: 'album:gramme|fascination', artist: 'Gramme', album: 'Fascination', ids: [3, 4], tag: 'x', why: '', at: '' }])
    assert.deepEqual(await resolveCheckEntry(f.deps, 'album:gramme|fascination', 'Dance-Punk'), { ok: true })
    assert.deepEqual(f.persisted.map(([id, fl]) => [id, fl.genre]), [[3, 'Dance-Punk'], [4, 'Dance-Punk']])
    assert.equal(f.check.length, 0)
  })
  it('only genres on his list', async () => {
    const f = fakeDeps(LIB, {})
    assert.equal((await resolveCheckEntry(f.deps, 'x', 'Punk-Funk')).ok, false)
  })
})

describe('phone edits', () => {
  it("a phone genre off the list never masks the desktop's shelf; everything else passes", () => {
    assert.deepEqual(phoneOverlayFields({ genre: 'Alternative ', albumArtist: 'X' }), { albumArtist: 'X' })
    assert.deepEqual(phoneOverlayFields({ genre: 'Pop, Rock' }), {})
    assert.deepEqual(phoneOverlayFields({ genre: 'Indie Rock', rating: '5' }), { genre: 'Indie Rock', rating: '5' })
  })
  // ⚠️ TWIN: JakeTunesMobile backend/src/util/genreVocab.ts (GENRE_VOCAB_DIGEST) and
  // backend/src/util/__tests__/genreVocab.test.ts pin the same digest: the phone
  // backend applies this rule with its own copy of the list.
  it('the list the phone backend copies is unchanged (pinned digest: change both repos together)', () => {
    const digest = createHash('sha256')
      .update(JSON.stringify({ names: [...GENRE_NAMES].sort(), catchAll: [...CATCH_ALL].sort() }))
      .digest('hex')
    assert.equal(digest, '92cd8500c59edfd248cea2ab205ea013eeeb1a6ef0bc74ada083e9b6978ace34',
      'genre list changed: copy it to JakeTunesMobile backend/src/util/genreVocab.ts and update the digest in both repos')
  })
  it('applied at load (index.ts) and live (App.tsx)', () => {
    const src = (q: string) => readFileSync(join(import.meta.dirname, '..', '..', q), 'utf8')
    assert.equal((src('main/index.ts').match(/phoneOverlayFields\(entry\.fields\)/g) || []).length, 2)
    assert.match(src('renderer/App.tsx'), /phoneOverlayFields\(entry\.fields/)
  })
})

describe('locks', () => {
  it("the fingerprint matches the app's override check exactly", () => {
    const app = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'App.tsx'), 'utf8')
    assert.ok(app.includes("`${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`"))
    assert.equal(trackFingerprint({ id: 1, title: ' Taxes ', artist: 'Geese', duration: 197000 }), 'taxes|geese|197000')
  })
  it('his list: 133 genres, every name unique, the shelves he chose', () => {
    assert.equal(GENRES.length, 133)
    assert.equal(GENRE_NAMES.size, 133)
    for (const g of ['Midwest Rap', 'Club Rap', 'Math Rock', 'Electro Swing', 'Space Rock', 'Geordie Jazz', 'Israeli Hip-Hop', 'Indie Sleaze', 'Plunderphonics']) assert.ok(GENRE_NAMES.has(g), g)
    for (const g of ['Samba', 'Soul Rock', 'Emo', 'Funk Metal', 'World', 'Electronic', 'Dance', 'Rap', 'Hip-Hop']) assert.ok(!GENRE_NAMES.has(g), `${g} was cut`)
  })
  it('wired: index.ts starts it, App.tsx mirrors it, Settings shows the check list', () => {
    const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
    assert.match(src('main/index.ts'), /registerGenreFilerIpc\(ipc, \{/)
    assert.match(src('renderer/App.tsx'), /onGenreFilerApplied\(\(p\) => \{/)
    assert.match(src('renderer/components/SettingsModal.tsx'), /<GenreCheckList \/>/)
  })
})
