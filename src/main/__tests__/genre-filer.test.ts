/**
 * The genre filer (2026-10-11): new songs land on Jake's list, by his rules,
 * enforced in code — every rule here was learned from a real mistake on 10/11.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  unfiledUnits, artistHomes, decideByRules, enforce, runFilerSweep, resolveCheckEntry, trackFingerprint, parseReply,
  type FilerTrack, type CheckEntry, type FilerDeps,
} from '../genre-filer.ts'
import { GENRES, GENRE_NAMES, phoneOverlayFields } from '../../common/genre-vocab.ts'

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
    assert.ok(f.check.some((c) => c.artist === 'King Gizzard & The Lizard Wizard'), 'the default low pick lands on the check list')
    assert.equal(genreOf(7), undefined, 'unsure songs keep their genre')
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
    f.deps.lookupOrigin = async (a) => { asked.push(a); return a === 'Mystery Band' ? 'Japan' : null }
    const r = await runFilerSweep(f.deps)
    const originOf = (id: number) => f.persisted.find(([tid, fl]) => tid === id && fl.origin)?.[1].origin
    assert.equal(originOf(30), 'United States', 'from his other album — no lookup')
    assert.equal(originOf(32), 'Japan')
    assert.equal(originOf(33), undefined, 'unknown stays blank')
    assert.deepEqual(asked.sort(), ['Mystery Band', 'Nobody Knows'])
    assert.equal(r.origins, 2)
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
  it('his list: 132 genres, every name unique, the shelves he chose', () => {
    assert.equal(GENRES.length, 132)
    assert.equal(GENRE_NAMES.size, 132)
    for (const g of ['Midwest Rap', 'Club Rap', 'Math Rock', 'Electro Swing', 'Space Rock', 'Geordie Jazz', 'Israeli Hip-Hop', 'Indie Sleaze']) assert.ok(GENRE_NAMES.has(g), g)
    for (const g of ['Samba', 'Soul Rock', 'Emo', 'Funk Metal', 'World', 'Electronic', 'Dance', 'Rap', 'Hip-Hop']) assert.ok(!GENRE_NAMES.has(g), `${g} was cut`)
  })
  it('wired: index.ts starts it, App.tsx mirrors it, Settings shows the check list', () => {
    const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
    assert.match(src('main/index.ts'), /registerGenreFilerIpc\(ipc, \{/)
    assert.match(src('renderer/App.tsx'), /onGenreFilerApplied\(\(p\) => \{/)
    assert.match(src('renderer/components/SettingsModal.tsx'), /<GenreCheckList \/>/)
  })
})
