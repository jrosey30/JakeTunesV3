/**
 * Who set each genre (2026-10-28) — the re-filing bug and the audit pass.
 * Every case here is a real one from Jake's library that week.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { genreOwner, parseProvenance, sameSong, emptyProvenance, type ProvenanceDoc } from '../genre-provenance.ts'
import {
  isSettled, unfiledUnits, artistHomes, albumHomes, decideByRules, runFilerSweep, resolveCheckEntry, checkEntryOpen, rewritableIds,
  trustedForHome, trackFingerprint, type FilerTrack, type CheckEntry, type FilerDeps, type GenreWhy,
} from '../genre-filer.ts'
import { runGenreCorrections, MARKER_FILE } from '../genre-corrections.ts'
import { CORRECTIONS, SEEDS, RESTORES } from '../genre-corrections-data.ts'
import { GENRE_NAMES } from '../../common/genre-vocab.ts'

const T = (id: number, artist: string, album: string, genre: string, extra: Partial<FilerTrack> = {}): FilerTrack =>
  ({ id, title: `t${id}`, artist, album, genre, duration: 1000 + id, ...extra })

describe('who set the genre', () => {
  const fp = 'together|the avalanches|198640'
  it('his journaled Get Info choice is his — even off the list (The Avalanches, "Electronic")', () => {
    assert.equal(genreOwner({ genre: 'Electronic', fp, duration: 198640, inOverrides: true, journal: { v: 'Electronic', at: 1, dur: 198640 } }), 'jake')
  })
  it('a journal entry for another song at that id (duration changed) is not his', () => {
    assert.equal(genreOwner({ genre: 'Electronic', fp, duration: 198640, inOverrides: true, journal: { v: 'Electronic', at: 1, dur: 5 } }), 'unknown')
  })
  it("the filer's record counts only for the same word on the same song", () => {
    const prov = { genre: 'Classic Rock', by: 'filer' as const, how: 'artist-home' as const, fp: 'so lonely|the police|289587', at: 'x' }
    assert.equal(genreOwner({ genre: 'Classic Rock', fp: 'so lonely|the police|289587', inOverrides: false, prov }), 'filer')
    assert.equal(genreOwner({ genre: 'Classic Rock', fp: 'so lonely|the police|290001', inOverrides: false, prov }), 'filer', 'a re-measured duration is still the same song')
    assert.equal(genreOwner({ genre: 'New Wave', fp: 'so lonely|the police|289587', inOverrides: true, prov }), 'unknown', 'someone changed it since')
    assert.equal(genreOwner({ genre: 'Classic Rock', fp: 'roxanne|the police|191947', inOverrides: true, prov }), 'unknown', 'id now names another song')
  })
  it('a check-list File is his; a phone genre is his; nobody recorded = unknown; no override = store', () => {
    assert.equal(genreOwner({ genre: 'Punk', fp, inOverrides: true, prov: { genre: 'Punk', by: 'jake', how: 'check-list', fp, at: 'x' } }), 'jake')
    assert.equal(genreOwner({ genre: 'Post-Punk', fp, inOverrides: false, phone: 'Post-Punk' }), 'phone')
    assert.equal(genreOwner({ genre: 'Rock', fp, inOverrides: false, phone: 'Rock' }), 'store', 'a phone catch-all never masks (phoneOverlayFields)')
    assert.equal(genreOwner({ genre: 'Rock', fp, inOverrides: true }), 'unknown')
    assert.equal(genreOwner({ genre: 'Alternatif et Indé', fp, inOverrides: false }), 'store')
  })
  it('the record file parses defensively', () => {
    assert.deepEqual(parseProvenance('nope'), emptyProvenance())
    const d = parseProvenance({ version: 1, tracks: { 5: { genre: 'Punk', by: 'filer', how: 'evidence', fp: 'a|b|1', at: 'x', confidence: 'high' }, bad: { genre: 'x' }, 6: { genre: 'x', by: 'robot', fp: 'a', at: 'x' } } })
    assert.deepEqual(Object.keys(d.tracks), ['5'])
    assert.ok(sameSong('a|b|1', 'a|b|2') && !sameSong('a|b|1', 'a|c|1'))
  })
})

describe('his choices stand', () => {
  it('his off-list Get Info genre is settled — never filed over (Avalanches ×3 on 10/20, Niko Rubio "World" on 10/26)', () => {
    const t = T(1, 'The Avalanches', 'No Bad Memories', 'Electronic', { genreApproved: true, genreBy: 'jake' })
    assert.ok(isSettled(t))
    assert.deepEqual(unfiledUnits([t]), [])
    // without a record the old rule still files a store tag
    assert.equal(unfiledUnits([T(2, 'X', 'Y', 'Electronic')]).length, 1)
  })
  it('a check-list album he set himself is closed, and never rewritten', () => {
    const c: CheckEntry = { key: 'album:niko rubio|late night swim', artist: 'Niko Rubio', album: 'late night swim', ids: [1], tag: 'Latin America', suggested: 'Latin Pop', why: '', at: '' }
    const his = new Map([[1, T(1, 'Niko Rubio', 'late night swim', 'World', { genreApproved: true, genreBy: 'jake' })]])
    assert.equal(checkEntryOpen(c, his), false)
    assert.deepEqual(rewritableIds(c, his), [])
  })
  it("the filer's old suggestion with no filedAs mark is still the filer's: open, and re-judgeable (the 14 albums)", () => {
    const c: CheckEntry = { key: 'album:ford chupik|crashed out', artist: 'Ford Chupik', album: 'Crashed Out', ids: [1], tag: 'Électronique', suggested: 'Tech House', why: '', at: '' }
    const m = new Map([[1, T(1, 'Ford Chupik', 'Crashed Out', 'Tech House', { genreApproved: true, genreBy: 'filer', filerPick: { how: 'suggestion', confidence: 'low' } })]])
    assert.equal(checkEntryOpen(c, m), true)
    assert.deepEqual(rewritableIds(c, m), [1])
  })
})

function deps(lib: FilerTrack[], picks: Record<string, { genre: string; confidence: string }> = {}) {
  const persisted: Array<[number, Record<string, string>, GenreWhy | undefined]> = []
  const logs: string[] = []
  const classified: string[] = []
  let check: CheckEntry[] = []
  const d: FilerDeps = {
    tracks: async () => lib,
    persist: async (t, f, why) => { persisted.push([t.id, f, why]) },
    applied: () => {},
    evidence: async () => ({ artistTags: ['rock'], albumTags: [], press: '' }),
    classify: async (_s, user) => {
      classified.push(user)
      const lines = user.split('\n').filter((l) => l.startsWith('id='))
      return JSON.stringify(lines.map((l) => { const id = l.slice(3, l.indexOf(' ')); const artist = l.split(' | ')[1].split(' — ')[0]; return { id, ...(picks[artist] ?? { genre: 'Indie Rock', confidence: 'high' }), why: 'test' } }))
    },
    loadCheck: async () => check,
    saveCheck: async (c) => { check = c },
    log: (m) => logs.push(m),
    now: () => new Date('2026-10-28T23:37:44Z'),
  }
  return { d, persisted, logs, classified, get check() { return check } }
}

describe('the re-filing bug', () => {
  it("a catch-all the filer wrote whose override vanished is put back, not judged again (The Police, 23:32 → 23:37)", async () => {
    const lib = [
      T(11952, 'The Police', "Outlandos D'Amour", 'Classic Rock', { genreApproved: true, genreBy: 'unknown' }),
      T(13376, 'The Police', "Outlandos D'Amour", 'Classic Rock', { genreApproved: false, genreBy: 'filer', filerPick: { how: 'artist-home', confidence: 'high' }, overrideFpSeen: 'so lonely|the police|0' }),
    ]
    assert.ok(isSettled(lib[1]), 'no longer "an unapproved catch-all"')
    const f = deps(lib)
    const r = await runFilerSweep(f.d)
    assert.equal(r.filed, 0)
    assert.equal(f.classified.length, 0)
    assert.deepEqual(f.persisted, [[13376, { genre: 'Classic Rock' }, { by: 'filer', how: 'artist-home', confidence: 'high' }]])
    assert.match(f.logs.join('\n'), /repaired The Police .*13376.*entry fp "so lonely\|the police\|0"/)
  })
  it('new songs of an album already filed join it (album-sibling) — no lookup, the pick keeps its provenance', async () => {
    const lib = [
      T(13311, 'Father of Peace', 'The Year', 'Rock', { genreApproved: true, genreBy: 'filer', filerPick: { how: 'evidence', confidence: 'medium' } }),
      T(13383, 'Father of Peace', 'The Year', 'Alternatif et Indé'),
      T(13384, 'Father of Peace', 'The Year', 'Alternatif et Indé'),
    ]
    const f = deps(lib)
    await runFilerSweep(f.d)
    assert.equal(f.classified.length, 0)
    assert.deepEqual(f.persisted.map(([id, fl, w]) => [id, fl.genre, w?.how, w?.confidence]), [[13383, 'Rock', 'album-sibling', 'medium'], [13384, 'Rock', 'album-sibling', 'medium']])
  })
  it("new songs of an album already on the check list join its entry under its suggestion (Sam Gellaitry's IV)", async () => {
    const lib = [
      T(13380, 'Sam Gellaitry', 'IV', 'EDM', { genreApproved: true, genreBy: 'filer', filerPick: { how: 'suggestion', confidence: 'low' } }),
      T(13500, 'Sam Gellaitry', 'IV', 'Dance, Électronique'),
    ]
    const f = deps(lib)
    await f.d.saveCheck([{ key: 'album:sam gellaitry|iv', artist: 'Sam Gellaitry', album: 'IV', ids: [13380], tag: 'Dance, Électronique', suggested: 'EDM', filedAs: 'EDM', why: '', at: '', evidence: 2 }])
    await runFilerSweep(f.d)
    assert.deepEqual(f.check[0].ids, [13380, 13500])
    assert.deepEqual(f.persisted, [[13500, { genre: 'EDM' }, { by: 'filer', how: 'suggestion', confidence: 'low' }]])
    assert.equal(f.classified.length, 0)
  })
  it('an evidence pick is recorded as the filer’s with its confidence; a Jake File is recorded as his', async () => {
    const f = deps([T(1, 'Gramme', 'Fascination', 'Alternatif et Indé')], { Gramme: { genre: 'Dance-Punk', confidence: 'high' } })
    await runFilerSweep(f.d)
    assert.deepEqual(f.persisted[0][2], { by: 'filer', how: 'evidence', confidence: 'high' })
    const g = deps([T(1, 'Silica', "Myatt's Song", 'Grunge', { genreApproved: true, genreBy: 'filer', filerPick: { how: 'suggestion' } })])
    await g.d.saveCheck([{ key: 'k', artist: 'Silica', album: "Myatt's Song", ids: [1], tag: 'Rock', why: '', at: '', filedAs: 'Grunge' }])
    await resolveCheckEntry(g.d, 'k', 'Indie Rock')
    assert.deepEqual(g.persisted[0][2], { by: 'jake', how: 'check-list' })
  })
})

describe("artist homes come from trusted shelves only", () => {
  const filer = (id: number, album: string, genre: string, how: string, confidence?: string): FilerTrack =>
    T(id, 'Father of Peace', album, genre, { genreApproved: true, genreBy: 'filer', filerPick: { how, confidence } })
  it('never a filer suggestion, low pick, copy, dumping ground or catch-all', () => {
    assert.equal(trustedForHome(filer(1, 'A', 'Rock', 'evidence', 'high')), false, 'catch-all')
    assert.equal(trustedForHome(filer(1, 'A', 'Experimental', 'evidence', 'high')), false, 'dumping ground')
    assert.equal(trustedForHome(filer(1, 'A', 'Post-Punk', 'suggestion', 'low')), false)
    assert.equal(trustedForHome(filer(1, 'A', 'Post-Punk', 'evidence', 'low')), false)
    assert.equal(trustedForHome(filer(1, 'A', 'Post-Punk', 'artist-home', 'high')), false, 'no chains')
    assert.equal(trustedForHome(filer(1, 'A', 'Post-Punk', 'evidence', 'high')), true)
    assert.equal(trustedForHome(T(1, 'The Police', 'A', 'Classic Rock', { genreApproved: true, genreBy: 'unknown' })), true, 'his own catch-all is a real home')
  })
  it("a new album by an artist whose only shelf is the filer's thin Rock gets its own evidence", async () => {
    const lib = [filer(1, 'Singles', 'Rock', 'evidence', 'medium'), T(2, 'Father of Peace', 'The Year', 'Alternatif et Indé')]
    assert.equal(artistHomes(lib).size, 0)
    const u = unfiledUnits(lib)[0]
    assert.equal(decideByRules(u, artistHomes(lib), albumHomes(lib)), null)
    const f = deps(lib, { 'Father of Peace': { genre: 'Indie Rock', confidence: 'high' } })
    await runFilerSweep(f.d)
    assert.equal(f.classified.length, 1, 'judged on its own evidence')
  })
})

describe('the audit corrections pass', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'genre-audit-'))
    writeFileSync(join(dir, 'metadata-overrides.json'), '{"1":{"fp":"x","fields":{"genre":"Alternative"}}}')
    let prov: ProvenanceDoc = emptyProvenance()
    const lib: FilerTrack[] = [
      // filer-owned (seeded from its log): high → corrected
      T(1, 'Pulp', 'More', 'Alternative', { genreApproved: true, genreBy: 'unknown' }),
      // his (unknown): high → review entry, never written
      T(2, 'Yard Act', 'Where’s My Utopia?', 'Rock', { genreApproved: true, genreBy: 'unknown' }),
      // filer pick: medium → filed as suggestion + check list
      T(3, 'Swim Deep', 'Where the Heaven Are We', 'Dream Pop', { genreApproved: true, genreBy: 'filer', filerPick: { how: 'evidence', confidence: 'high' } }),
      // his journaled Electronic, filed over by the filer → put back
      T(4, 'The Avalanches', 'No Bad Memories', 'Experimental', { genreApproved: true, genreBy: 'unknown' }),
    ]
    const live = (): FilerTrack[] => lib.map((t) => {
      const p = prov.tracks[String(t.id)]
      return p && p.genre === t.genre ? { ...t, genreBy: 'filer', filerPick: { how: p.how, confidence: p.confidence } } : t
    })
    const persisted: Array<[number, Record<string, string>, GenreWhy | undefined]> = []
    let check: CheckEntry[] = []
    const logs: string[] = []
    const d = {
      userData: dir,
      tracks: async () => live(),
      persist: async (t: FilerTrack, f: Record<string, string>, why?: GenreWhy) => { persisted.push([t.id, f, why]); const x = lib.find((y) => y.id === t.id)!; x.genre = f.genre ?? x.genre },
      applied: () => {},
      loadCheck: async () => check,
      saveCheck: async (c: CheckEntry[]) => { check = c },
      log: (m: string) => logs.push(m),
      now: () => new Date('2026-10-29T12:00:00Z'),
      updateProvenance: async (m: (doc: ProvenanceDoc) => void) => { m(prov) },
      table: {
        id: 'test-audit',
        seeds: [{ artist: 'Pulp', album: 'More', genre: 'Alternative', how: 'artist-home' as const }, { artist: 'The Avalanches', album: 'No Bad Memories', genre: 'Experimental', how: 'evidence' as const }],
        restores: [{ id: 4, fp: trackFingerprint(lib[3]), artist: 'The Avalanches', album: 'No Bad Memories', from: 'Experimental', to: 'Electronic' }],
        corrections: [
          { artist: 'Pulp', album: 'More', from: 'Alternative', to: 'Indie Rock', confidence: 'high' as const, evidence: 'MB indie rock; Deezer Alternative; sounds like Indie Rock' },
          { artist: 'Yard Act', album: 'Where’s My Utopia?', from: 'Rock', to: 'Post-Punk', confidence: 'high' as const, evidence: 'MB post-punk; sounds like Post-Punk' },
          { artist: 'Swim Deep', album: 'Where the Heaven Are We', from: 'Dream Pop', to: 'Indie Pop', confidence: 'medium' as const, evidence: 'MB indie pop' },
        ],
      },
    }
    return { dir, d, persisted, logs, lib, get check() { return check }, get prov() { return prov } }
  }
  it('backs up first, seeds, puts his choices back, corrects only what is not his — and runs once', async () => {
    const s = setup()
    const r = await runGenreCorrections(s.d)
    assert.ok(r.ran)
    assert.ok(readdirSync(s.dir).some((f) => f.startsWith('metadata-overrides.json.bak-genre-audit-')), 'backup')
    assert.equal(r.seeded, 2, "Pulp's and the Avalanches' filer picks marked as the filer's")
    assert.deepEqual(s.persisted.find(([id]) => id === 4)?.[1], { genre: 'Electronic' })
    assert.deepEqual(s.persisted.find(([id]) => id === 1), [1, { genre: 'Indie Rock' }, { by: 'filer', how: 'correction', confidence: 'high' }])
    assert.ok(!s.persisted.some(([id]) => id === 2), "his Rock is never written")
    assert.ok(s.check.some((e) => e.review && e.ids[0] === 2 && e.suggested === 'Post-Punk' && e.tag === 'Rock'))
    assert.deepEqual(s.persisted.find(([id]) => id === 3)?.[2], { by: 'filer', how: 'suggestion', confidence: 'low' })
    assert.ok(s.check.some((e) => e.filedAs === 'Indie Pop' && e.ids[0] === 3))
    assert.ok(JSON.parse(readFileSync(join(s.dir, MARKER_FILE), 'utf8')).id === 'test-audit')
    const n = s.persisted.length
    const again = await runGenreCorrections(s.d)
    assert.equal(again.ran, false)
    assert.equal(s.persisted.length, n, 'idempotent')
  })
  it('a review entry stays open while his songs wear the old genre; Keep closes it', () => {
    const e: CheckEntry = { key: 'review:x', artist: 'Yard Act', album: 'U', ids: [2], tag: 'Rock', suggested: 'Post-Punk', why: '', at: '', review: true }
    assert.ok(checkEntryOpen(e, new Map([[2, T(2, 'Yard Act', 'U', 'Rock', { genreBy: 'unknown', genreApproved: true })]])))
    assert.ok(!checkEntryOpen(e, new Map([[2, T(2, 'Yard Act', 'U', 'Post-Punk', { genreBy: 'jake', genreApproved: true })]])))
  })
  it('no backup, no pass', async () => {
    const s = setup()
    const r = await runGenreCorrections({ ...s.d, userData: join(s.dir, 'missing') })
    assert.equal(r.ran, false)
    assert.equal(s.persisted.length, 0)
  })
  it('the shipped table only names list genres and only real moves', () => {
    for (const c of CORRECTIONS) {
      assert.ok(GENRE_NAMES.has(c.to), c.to)
      assert.notEqual(c.from, c.to)
      assert.ok(c.evidence.length > 0)
    }
    for (const s of SEEDS) assert.ok(GENRE_NAMES.has(s.genre), s.genre)
    for (const r of RESTORES) assert.ok(r.to && r.from && r.fp.includes('|'))
  })
})
