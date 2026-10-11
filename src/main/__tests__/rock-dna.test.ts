/**
 * Rock DNA (Rocksurgence step 2, 2026-10-11) — the rules from Jake's brief,
 * locked: relative picks, Respect ≠ enjoyment, unfamiliar ≠ dislike, no
 * conclusion without an answer behind it, threads never averaged, the
 * Geese rule, deterministic branching capped at 10 follow-ups.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCREENS, CORE_COUNT, MAX_FOLLOW_UPS, EMPTY_DNA, activeScreens, resumeScreen, nextScreen, progress, retake,
  buildProfile, dnaPromptLine, dislikedArtists, normalizeDnaState, isAnswered, type DnaState,
} from '../../common/rock-dna.ts'

const S = (patch: Partial<DnaState>): DnaState => ({ ...EMPTY_DNA, ...patch })
const pick = (...ids: string[]) => ({ picks: ids, at: '2026-10-11T00:00:00Z' })
const trait = (p: ReturnType<typeof buildProfile>, id: string) => p.dims.flatMap((d) => d.traits).find((t) => t.id === id)!

describe('the question bank', () => {
  it('about 30 core screens, every id unique, every follow-up wired to a real answer', () => {
    assert.ok(CORE_COUNT >= 30 && CORE_COUNT <= 36, `core ${CORE_COUNT}`)
    const ids = SCREENS.map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const s of SCREENS.filter((x) => x.after)) {
      const trigger = SCREENS.find((x) => x.id === s.after)
      assert.ok(trigger, `${s.id} follows a missing screen`)
      for (const p of s.ifPicked ?? []) assert.ok(trigger!.options!.some((o) => o.id === p), `${s.id}: no option ${p}`)
    }
  })
  it('song comparisons offer "I don\'t know these songs well enough"', () => {
    for (const s of SCREENS.filter((x) => x.options?.some((o) => o.song))) assert.ok(s.unsureLabel, s.id)
  })
})

describe('branching', () => {
  it('follow-ups appear only after the answer that triggers them', () => {
    assert.equal(activeScreens(S({})).length, CORE_COUNT)
    const beatles = activeScreens(S({ answers: { 'a-catalog': pick('the-beatles') } })).map((s) => s.id)
    assert.ok(beatles.includes('f-beatles-album'))
    assert.ok(!beatles.includes('f-zeppelin'))
    assert.equal(beatles.indexOf('f-beatles-album'), beatles.indexOf('a-catalog') + 1, 'asked right after')
  })
  it('never more than 10 follow-ups', () => {
    const answers: DnaState['answers'] = {}
    for (const s of SCREENS.filter((x) => x.after)) answers[s.after!] = pick(...(answers[s.after!]?.picks ?? []), ...(s.ifPicked ?? []))
    assert.ok(activeScreens(S({ answers })).length - CORE_COUNT <= MAX_FOLLOW_UPS)
  })
  it('save and resume: picks up at the saved screen, or the first unanswered one', () => {
    const st = S({ answers: { 'a-catalog': pick('pink-floyd') }, position: 'a-live' })
    assert.equal(resumeScreen(st)!.id, 'a-live')
    assert.equal(resumeScreen({ ...st, position: undefined })!.id, 'f-floyd-era')
    assert.equal(nextScreen(st, 'a-catalog')!.id, 'f-floyd-era')
  })
  it('skipping counts as answered — the quiz moves on, no signal recorded', () => {
    const st = S({ answers: { 'a-catalog': { skipped: true } } })
    assert.ok(isAnswered(st, SCREENS[0]))
    assert.equal(progress(st).answered, 1)
    assert.equal(buildProfile(st).traditions.length, 0)
  })
  it('retake starts fresh and keeps the last run', () => {
    const st = S({ answers: { 'a-catalog': pick('led-zeppelin') }, completedAt: 'x' })
    const r = retake(st, 'now')
    assert.deepEqual(r.answers, {})
    assert.equal(r.previous!.answers['a-catalog'].picks![0], 'led-zeppelin')
    assert.equal(retake(r, 'later').previous!.previous, undefined, 'one run back, never a chain')
  })
})

describe('the profile — only what the answers say', () => {
  it('no answers, no conclusions', () => {
    const p = buildProfile(S({}))
    assert.ok(p.dims.flatMap((d) => d.traits).every((t) => t.level === 'none'))
    assert.equal(p.traditions.length, 0)
    assert.equal(dnaPromptLine(p), '', 'discovery behaves exactly as before')
  })
  it('picking one band never counts against the others', () => {
    const p = buildProfile(S({ answers: { 'a-live': pick('black-sabbath') } }))
    assert.deepEqual(p.traditions.map((t) => t.name), ['Heavy riffs'])
    assert.ok(!p.dislikes.length)
  })
  it('Respect is never enjoyment', () => {
    const p = buildProfile(S({ ratings: { 'Greta Van Fleet': 'respect', 'Rival Sons': 'love' } }))
    assert.deepEqual(p.respects, ['Greta Van Fleet'])
    assert.deepEqual(p.traditions[0].artists, ['Rival Sons'], 'respect adds no lineage')
    const line = dnaPromptLine(p)
    assert.match(line, /Respects but does NOT enjoy \(never treat as taste\): Greta Van Fleet/)
    assert.doesNotMatch(line, /Loves: [^.]*Greta/)
  })
  it('"I don\'t know these songs" is not dislike', () => {
    const p = buildProfile(S({ answers: { 'd-now': { unsure: true } } }))
    assert.ok(!p.dislikes.length)
    assert.equal(trait(p, 'riffs').level, 'none')
  })
  it('every line names the answers it came from', () => {
    const p = buildProfile(S({ answers: { 'c-first': pick('riff'), 'd-now': pick('led-zeppelin-black-dog') } }))
    const riffs = trait(p, 'riffs')
    assert.equal(riffs.level, 'strong')
    assert.equal(riffs.from.length, 2)
    assert.ok(riffs.from.some((f) => f.includes('Black Dog')))
  })
  it("heavy and melodic threads sit side by side — never averaged", () => {
    const p = buildProfile(S({ ratings: { 'Black Sabbath': 'love', 'Big Star': 'love' }, answers: { 'b-grunge': pick('soundgarden'), 'a-prefer': pick('the-kinks') } }))
    const names = p.traditions.map((t) => t.name)
    assert.ok(names.includes('Heavy riffs') && names.includes('Power pop') && names.includes('British Invasion & 60s pop'))
  })
  it("Jake's corrections win over the answers", () => {
    const p = buildProfile(S({ answers: { 'c-first': pick('riff') }, traitEdits: { riffs: 'low' } }))
    assert.equal(trait(p, 'riffs').level, 'low')
    assert.ok(trait(p, 'riffs').edited)
  })
  it('an exception carries why it is loved — and never opens its genre', () => {
    const st = S({ answers: { 'e-angine': pick('musicianship', 'rhythm') } })
    const p = buildProfile(st, [{ artist: 'Angine de Poitrine', genre: 'math rock' }])
    assert.deepEqual(p.exceptions[0].why, ['Their extraordinary musicianship', 'Their rhythmic inventiveness'])
    assert.match(dnaPromptLine(p), /Angine de Poitrine is loved despite math rock .* not a door to that genre/)
  })
  it('the Geese rule is always in the prompt line', () => {
    assert.match(dnaPromptLine(buildProfile(S({ answers: { 'c-first': pick('melody') } }))), /came around to Geese/)
  })
  it('experimental tolerance: high when it serves the song, excess loses him', () => {
    const p = buildProfile(S({ answers: { 'c-time': pick('serve'), 'c-bothers': pick('excess') } }))
    assert.match(p.dims.find((d) => d.id === 'experiment')!.summary!, /serves the song.*for its own sake/)
  })
  it('a follow-up left behind by a changed answer no longer counts', () => {
    const st = S({ answers: { 'a-catalog': pick('led-zeppelin'), 'f-beatles-album': pick('revolver') } })
    assert.ok(!buildProfile(st).specifics.some((s) => s.answer === 'Revolver'))
  })
})

describe('stored file', () => {
  it('normalizes hand edits: bad ratings and unknown traits are dropped', () => {
    const st = normalizeDnaState({ answers: { 'a-live': { picks: ['queen', 7] } }, ratings: { Rush: 'love', Yes: 'meh' }, traitEdits: { riffs: 'strong', bogus: 'strong' } })
    assert.deepEqual(st.answers['a-live'].picks, ['queen'])
    assert.deepEqual(st.ratings, { Rush: 'love' })
    assert.deepEqual(st.traitEdits, { riffs: 'strong' })
    assert.deepEqual(normalizeDnaState(null).answers, {})
  })
  it('Dislike is the only rating that keeps an artist out of the shop', () => {
    assert.deepEqual(dislikedArtists(S({ ratings: { 'Greta Van Fleet': 'dislike', Rush: 'respect', Yes: 'unfamiliar' } })), ['Greta Van Fleet'])
  })
})
