/**
 * The genre filer's evidence and judgement (2026-10-28, Jake: "assumptions by
 * sam gellaitry is not updated genre. the scanner needs to be better").
 * Sam Gellaitry's "IV" went to Experimental — a dumping ground — while his
 * library's House / Nu Disco / French House shelves sat right there.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { soundAlikeVote, soundAlikeFor, soundAlikeLeader, soundAlikeText, type ShelfTrack } from '../genre-sound-alike.ts'
import {
  enforce, runFilerSweep, fileableSuggestion, shelfTracks, needsRejudge, rewritableIds, evidenceLine, filerSystemPrompt, EVIDENCE_VERSION,
  type FilerTrack, type CheckEntry, type FilerDeps, type FilerUnit,
} from '../genre-filer.ts'
import { deezerAlbumGenres, discogsAlbumStyles } from '../genre-external-tags.ts'

const vec = (...xs: number[]): Float32Array => { const n = Math.hypot(...xs) || 1; return Float32Array.from(xs.map((x) => x / n)) }
const T = (id: number, artist: string, album: string, genre: string, extra: Partial<FilerTrack> = {}): FilerTrack =>
  ({ id, title: `t${id}`, artist, album, genre, duration: 1000 + id, ...extra })

// A tiny library in 3-d "sound": x = house-ish, y = rock-ish, z = synth-ish.
const SHELF = new Map<number, ShelfTrack>([
  [1, { genre: 'French House', artist: 'Daft Punk' }],
  [2, { genre: 'French House', artist: 'Daft Punk' }],
  [3, { genre: 'French House', artist: 'Daft Punk' }],     // a third Daft Punk song: capped
  [4, { genre: 'French House', artist: 'Modjo' }],
  [5, { genre: 'Nu Disco', artist: 'Poolside' }],
  [6, { genre: 'Indie Rock', artist: 'Telescreens' }],
  [7, { genre: 'Synth-Pop', artist: 'Molchat Doma' }],
])
const AUDIO = new Map<number, Float32Array>([
  [1, vec(1, 0, 0.05)], [2, vec(1, 0, 0.06)], [3, vec(1, 0, 0.07)], [4, vec(1, 0.05, 0)], [5, vec(0.9, 0, 0.3)],
  [6, vec(0, 1, 0)], [7, vec(0, 0.2, 1)],
  [100, vec(1, 0, 0.1)], [101, vec(0.95, 0, 0.15)],   // the new album (Sam Gellaitry)
  [200, vec(0.1, 0.1, 1)],                            // a Rock-tagged album that sounds synthy
])

describe('sound-alike vote: his own shelves as evidence', () => {
  it('counts the shelves of the nearest settled songs, one artist capped', () => {
    const s = soundAlikeVote([100, 101], AUDIO, SHELF, 'audio', { k: 3, perArtist: 2 })!
    assert.equal(s.source, 'audio')
    assert.equal(s.probed, 2)
    // Each song: Daft Punk ×2 (third capped), then Modjo → French House 3 per song.
    assert.deepEqual(s.votes[0], { genre: 'French House', n: 6 })
    assert.equal(s.total, 6)
    assert.equal(soundAlikeLeader(s), 'French House')
    assert.match(soundAlikeText(s), /by audio, 2 songs\): French House 6 of 6/)
  })
  it('the album is never its own neighbour; songs off the shelf never vote', () => {
    const shelf = new Map(SHELF); shelf.set(101, { genre: 'Experimental', artist: 'Sam Gellaitry' })
    const s = soundAlikeVote([100, 101], AUDIO, shelf, 'audio', { k: 10 })!
    assert.ok(!s.votes.some((v) => v.genre === 'Experimental'))
  })
  it('no vector for any album song → no vote (never a guess)', () => {
    assert.equal(soundAlikeVote([999], AUDIO, SHELF, 'audio'), null)
  })
  it('audio first; the mood index only as a fallback, and only when allowed', () => {
    const mood = new Map<number, Float32Array>([[1, vec(1, 0)], [6, vec(0, 1)], [999, vec(0, 1)]])
    assert.equal(soundAlikeFor([100], { audio: AUDIO, mood }, SHELF, true)!.source, 'audio')
    const m = soundAlikeFor([999], { audio: AUDIO, mood }, SHELF, true, { k: 1 })!
    assert.equal(m.source, 'mood')
    assert.equal(m.votes[0].genre, 'Indie Rock')
    assert.match(soundAlikeText(m), /weaker/)
    assert.equal(soundAlikeFor([999], { audio: AUDIO, mood }, SHELF, false), null, 'an album wearing the filer’s own genre: mood would echo it')
  })
  it('a split vote has no leader', () => {
    assert.equal(soundAlikeLeader({ source: 'audio', probed: 1, total: 4, votes: [{ genre: 'House', n: 2 }, { genre: 'Nu Disco', n: 2 }] }), undefined)
    assert.equal(soundAlikeLeader({ source: 'audio', probed: 1, total: 10, votes: [{ genre: 'House', n: 2 }, { genre: 'Nu Disco', n: 1 }] }), undefined, 'under 30%')
  })
  it('his shelves exclude anything still on the check list (Experimental-filed albums do not vote)', () => {
    const lib = [T(1, 'Daft Punk', 'Discovery', 'French House', { genreApproved: true }), T(2, 'Sam Gellaitry', 'IV', 'Experimental', { genreApproved: true }), T(3, 'New', 'X', 'Dance, Électronique')]
    const check: CheckEntry[] = [{ key: 'album:sam gellaitry|iv', artist: 'Sam Gellaitry', album: 'IV', ids: [2], tag: 'Dance, Électronique', suggested: 'Experimental', why: '', at: '', filedAs: 'Experimental' }]
    assert.deepEqual([...shelfTracks(lib, check).keys()], [1])
  })
})

const samUnit: FilerUnit = { key: 'album:sam gellaitry|iv', artist: 'Sam Gellaitry', album: 'IV', comp: false, ids: [100, 101], tag: 'Dance, Électronique' }

describe('no dumping grounds (enforced in code)', () => {
  it('Experimental without evidence that says so is refused — the closest real shelf is offered', () => {
    const d = enforce(samUnit, { genre: 'Experimental', alt: 'French House', confidence: 'medium', why: 'future bass mix' }, { artistTags: [], albumTags: [], press: 'future bass, electronic, synthwave' })
    assert.equal(d.genre, null)
    assert.equal(d.suggested, 'French House')
    assert.match(d.why, /Experimental needs evidence/)
  })
  it('no usable alt → his own shelves’ plurality; none → nothing (never the dumping ground)', () => {
    const sound = soundAlikeVote([100, 101], AUDIO, SHELF, 'audio', { k: 3 })
    assert.equal(enforce(samUnit, { genre: 'Experimental', alt: 'Experimental', confidence: 'high' }, { artistTags: [], albumTags: [], press: '', soundAlike: sound }).suggested, 'French House')
    assert.equal(enforce(samUnit, { genre: 'Experimental', alt: 'Not A Genre', confidence: 'high' }, { artistTags: [], albumTags: [], press: '' }).suggested, undefined)
  })
  it('a shelf name in the sound-alike vote is not evidence for Experimental', () => {
    const vote = { source: 'audio' as const, probed: 1, total: 5, votes: [{ genre: 'Experimental', n: 5 }] }
    assert.equal(enforce(samUnit, { genre: 'Experimental', confidence: 'high' }, { artistTags: [], albumTags: [], press: '', soundAlike: vote }).genre, null)
  })
  it('allowed when the evidence itself says experimental / avant-garde', () => {
    assert.equal(enforce(samUnit, { genre: 'Experimental', confidence: 'high' }, { artistTags: ['experimental', 'electronic'], albumTags: [], press: '' }).genre, 'Experimental')
    assert.equal(enforce(samUnit, { genre: 'Experimental', confidence: 'high' }, { artistTags: [], albumTags: [], press: 'an avant-garde sound collage' }).genre, 'Experimental')
    assert.equal(enforce(samUnit, { genre: 'Experimental', confidence: 'high' }, { artistTags: ['noise pop'], albumTags: [], press: '' }).genre, null, '"noise pop" is a pop tag')
  })
  it('real shelves are untouched by the rule', () => {
    assert.equal(enforce(samUnit, { genre: 'French House', confidence: 'medium' }, { artistTags: [], albumTags: [], press: '' }).genre, 'French House')
  })
  it('the prompt says so, and the reply carries a second choice', () => {
    assert.match(filerSystemPrompt(), /NO DUMPING GROUNDS/)
    assert.match(filerSystemPrompt(), /"alt"/)
  })
})

describe('rock stays rock (with the new evidence)', () => {
  const rockUnit: FilerUnit = { key: 'k', artist: 'Telescreens', album: '7', comp: false, ids: [200], tag: 'Rock' }
  const synthy = soundAlikeVote([200], AUDIO, SHELF, 'audio', { k: 1 })
  it('a synthy-sounding Rock album is never moved off the rock shelves, by pick, alt or vote', () => {
    assert.equal(synthy!.votes[0].genre, 'Synth-Pop')
    const d = enforce(rockUnit, { genre: 'Synth-Pop', alt: 'Darkwave', confidence: 'high' }, { artistTags: [], albumTags: [], press: '', soundAlike: synthy })
    assert.equal(d.genre, null)
    const e = enforce(rockUnit, { genre: 'Experimental', alt: 'Synth-Pop', confidence: 'high' }, { artistTags: [], albumTags: [], press: '', soundAlike: synthy })
    assert.equal(e.genre, null)
    assert.equal(fileableSuggestion('Rock', e.suggested), null, 'neither the alt nor the vote may take it off the rock shelves')
    assert.equal(fileableSuggestion('Rock', d.suggested), null)
  })
  it('a rock alt is fine', () => {
    assert.equal(enforce(rockUnit, { genre: 'Experimental', alt: 'Post-Punk', confidence: 'high' }, { artistTags: [], albumTags: [], press: '' }).suggested, 'Post-Punk')
  })
})

function deps(lib: FilerTrack[], check: CheckEntry[], pick: (artist: string) => Record<string, string>) {
  const persisted: Array<[number, Record<string, string>]> = []
  const prompts: string[] = []
  let saved = check
  const d: FilerDeps = {
    tracks: async () => lib,
    persist: async (t, f) => { persisted.push([t.id, f]) },
    applied: () => {},
    evidence: async () => ({ artistTags: [], albumTags: [], press: 'future bass, electronic', deezer: ['Dance', 'Electro'] }),
    classify: async (_s, user) => {
      prompts.push(user)
      return JSON.stringify(user.split('\n').filter((l) => l.startsWith('id=')).map((l) => ({ id: l.slice(3, l.indexOf(' ')), ...pick(l.split(' | ')[1].split(' — ')[0]) })))
    },
    loadCheck: async () => saved,
    saveCheck: async (c) => { saved = c },
    vectors: async () => ({ audio: AUDIO }),
    now: () => new Date('2026-10-28T23:59:00Z'),
  }
  return { d, persisted, prompts, get check() { return saved } }
}

describe('re-judging what is waiting — once', () => {
  const lib = (): FilerTrack[] => [
    T(1, 'Daft Punk', 'Discovery', 'French House', { genreApproved: true }), T(2, 'Daft Punk', 'Discovery', 'French House', { genreApproved: true }),
    T(4, 'Modjo', 'Modjo', 'French House', { genreApproved: true }), T(5, 'Poolside', 'Pacific Standard Time', 'Nu Disco', { genreApproved: true }),
    T(6, 'Telescreens', '7', 'Indie Rock', { genreApproved: true }),
    T(100, 'Sam Gellaitry', 'IV', 'Experimental', { genreApproved: true }), T(101, 'Sam Gellaitry', 'IV', 'Experimental', { genreApproved: true }),
  ]
  const sam = (): CheckEntry => ({ key: 'album:sam gellaitry|iv', artist: 'Sam Gellaitry', album: 'IV', ids: [100, 101], tag: 'Dance, Électronique', suggested: 'Experimental', why: 'Press: future bass/electronic/synthwave mix; no clean shelf fits', at: '2026-10-28T23:37:44Z', filedAs: 'Experimental' })

  it('an old entry is re-judged on the new evidence: the sound-alike vote reaches the AI, a confident answer is filed and leaves the list', async () => {
    const f = deps(lib(), [sam()], () => ({ genre: 'French House', confidence: 'medium', why: 'his French House neighbours' }))
    const r = await runFilerSweep(f.d)
    assert.equal(r.rejudged, 1)
    assert.match(f.prompts[0], /sounds like Jake's shelves \(by audio, 2 songs\): French House/)
    assert.match(f.prompts[0], /Deezer: Dance, Electro/)
    assert.deepEqual(f.persisted.map(([id, fl]) => [id, fl.genre]), [[100, 'French House'], [101, 'French House']])
    assert.equal(f.check.length, 0)
  })
  it('an unsure re-judgement re-files under the vetted suggestion, stays listed, and is never asked again', async () => {
    const f = deps(lib(), [sam()], () => ({ genre: 'Experimental', alt: 'Nu Disco', confidence: 'medium', why: 'mix' }))
    await runFilerSweep(f.d)
    const c = f.check[0]
    assert.equal(c.filedAs, 'Nu Disco')
    assert.equal(c.evidence, EVIDENCE_VERSION)
    assert.ok(c.rejudgedAt)
    assert.deepEqual(f.persisted.map(([id, fl]) => [id, fl.genre]), [[100, 'Nu Disco'], [101, 'Nu Disco']])
    // The songs now wear Nu Disco; the next sweep must not ask again.
    const lib2 = lib().map((t) => t.id >= 100 ? { ...t, genre: 'Nu Disco' } : t)
    const g = deps(lib2, f.check, () => ({ genre: 'House', confidence: 'high' }))
    const r2 = await runFilerSweep(g.d)
    assert.equal(r2.rejudged, 0)
    assert.equal(g.prompts.length, 0, 'no classify call at all')
    assert.equal(needsRejudge(f.check[0], new Map(lib2.map((t) => [t.id, t]))), false)
  })
  it('no fileable answer: the songs keep what they wear, the entry is stamped and stays', async () => {
    const f = deps(lib(), [sam()], () => ({ genre: 'Experimental', confidence: 'high' }))
    const r = await runFilerSweep(f.d)
    assert.equal(r.rejudged, 1)
    // With no alt, his shelves' plurality is offered — French House leads the vote.
    assert.equal(f.check[0].filedAs, 'French House')
    const f2 = deps(lib(), [sam()], () => ({ genre: 'Not A Genre', confidence: 'high' }))
    await runFilerSweep(f2.d)
    assert.deepEqual(f2.persisted.filter(([, fl]) => fl.genre), [], 'nothing written')
    assert.equal(f2.check[0].filedAs, 'Experimental')
    assert.equal(f2.check[0].evidence, EVIDENCE_VERSION)
  })
  it('no answer from the AI does not spend the one re-judgement', async () => {
    const f = deps(lib(), [sam()], () => ({}))
    f.d.classify = async () => 'overloaded'
    const r = await runFilerSweep(f.d)
    assert.equal(r.rejudged, 0)
    assert.equal(f.check[0].evidence, undefined)
  })
  it('a song Jake set himself is never touched', async () => {
    const l = lib().map((t) => t.id === 101 ? { ...t, genre: 'Deep House' } : t)   // he changed one song
    const byId = new Map(l.map((t) => [t.id, t]))
    assert.deepEqual(rewritableIds(sam(), byId), [100])
    const f = deps(l, [sam()], () => ({ genre: 'French House', confidence: 'high' }))
    await runFilerSweep(f.d)
    assert.deepEqual(f.persisted.map(([id]) => id), [100])
  })
  it('an entry he already settled entirely is not re-judged', async () => {
    const l = lib().map((t) => t.id >= 100 ? { ...t, genre: 'Deep House' } : t)
    const f = deps(l, [sam()], () => ({ genre: 'French House', confidence: 'high' }))
    const r = await runFilerSweep(f.d)
    assert.equal(r.rejudged, 0)
    assert.equal(f.persisted.length, 0)
  })
  it('an old Experimental suggestion is not back-filled before its re-judgement', async () => {
    const l = [T(1, 'Daft Punk', 'Discovery', 'French House', { genreApproved: true }), T(300, '808Murk', 'Abnormal Sounds MOAS', 'Pop, Rock')]
    const murk: CheckEntry = { key: 'album:808murk|abnormal sounds moas', artist: '808Murk', album: 'Abnormal Sounds MOAS', ids: [300], tag: 'Pop, Rock', suggested: 'Experimental', why: '', at: '' }
    const f = deps(l, [murk], () => ({ genre: 'Experimental', confidence: 'low' }))
    const r = await runFilerSweep(f.d)
    assert.equal(r.backfilled, 0)
    assert.deepEqual(f.persisted.filter(([, fl]) => fl.genre === 'Experimental'), [], 'never filed under an unvetted dumping ground')
  })
  it('a Rock-tagged entry re-judged still stays rock', async () => {
    const l = [...lib(), T(200, 'Telescreens', 'Synthy', 'Rock')]
    const rock: CheckEntry = { key: 'album:telescreens|synthy', artist: 'Telescreens', album: 'Synthy', ids: [200], tag: 'Rock', suggested: 'Synth-Pop', why: '', at: '' }
    const f = deps(l, [rock], () => ({ genre: 'Synth-Pop', confidence: 'high' }))
    await runFilerSweep(f.d)
    assert.deepEqual(f.persisted.filter(([, fl]) => fl.genre), [])
    assert.equal(f.check[0].evidence, EVIDENCE_VERSION)
  })
  it('re-judgements share the sweep budget after new albums', async () => {
    const l = [...lib(), T(400, 'Brand New', 'Debut', 'Dance, Électronique'), T(401, 'Other New', 'Debut', 'Pop, Rock')]
    const f = deps(l, [sam()], () => ({ genre: 'House', confidence: 'high' }))
    f.d.maxUnits = 2
    const r = await runFilerSweep(f.d)
    assert.equal(r.rejudged, 0, 'two new albums used the budget')
    f.d.maxUnits = 3
    const r2 = await runFilerSweep(f.d)
    assert.equal(r2.rejudged, 1)
  })
})

describe('evidence lines', () => {
  it('Deezer, Discogs and the vote are evidence lines', () => {
    const line = evidenceLine('0', samUnit, { artistTags: [], albumTags: [], press: '', deezer: ['Dance'], discogs: ['Electronic', 'Future Bass'], soundAlike: soundAlikeVote([100], AUDIO, SHELF, 'audio', { k: 2 }) })
    assert.match(line, /Discogs: Electronic, Future Bass/)
    assert.match(line, /Deezer: Dance/)
    assert.match(line, /sounds like Jake's shelves/)
    assert.doesNotMatch(line, /no evidence found/)
  })
})

describe('outside tags: identity first', () => {
  const fake = (routes: Record<string, unknown>) => (async (url: string) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k))
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  it("Deezer: the album's genres when artist and title match; a namesake's never", async () => {
    const f = fake({ 'search/album': { data: [{ id: 9, title: 'IV', artist: { name: 'Sam Gellaitry' } }] }, 'album/9': { genres: { data: [{ name: 'Dance' }, { name: 'Electro' }] } } })
    assert.deepEqual(await deezerAlbumGenres('Sam Gellaitry', 'IV', f), ['Dance', 'Electro'])
    assert.deepEqual(await deezerAlbumGenres('Sam Gellaitry', 'Something Else', f), [])
    assert.deepEqual(await deezerAlbumGenres('Silica', 'IV', f), [])
  })
  it('Discogs: needs a token, and a matching "Artist - Album" title', async () => {
    const f = fake({ 'database/search': { results: [{ title: 'Sam Gellaitry - IV', genre: ['Electronic'], style: ['Future Bass', 'House'] }] } })
    assert.deepEqual(await discogsAlbumStyles('Sam Gellaitry', 'IV', undefined, f), [])
    assert.deepEqual(await discogsAlbumStyles('Sam Gellaitry', 'IV', 'tok', f), ['Electronic', 'Future Bass', 'House'])
    assert.deepEqual(await discogsAlbumStyles('Other Artist', 'IV', 'tok', f), [])
  })
})
