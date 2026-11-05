/**
 * Jake, 2026-11-05: "change Megan to Larry", then who Larry is. The rename is
 * enforced here: nothing in live code says the old name except the one file
 * that reads old saved state, and old saved state keeps working.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  LARRY_VOICE_ID, RADIO_SCRIPT_TAGS, currentCastId, currentRadioTag, migrateCallback, migratePicksCache,
  migrateRadioEntries, migrateRememberedScript, migrateSavedState, normalizeHostId,
} from '../../common/cohost.ts'
import { LARRY_CORE, MUSIC_MAN_CORE } from '../personas.ts'
import { RADIO_CAST_BY_ID } from '../cast.ts'
import { TOPIC_ANGLES, buildRadioSegmentPrompt, wholeScriptLines } from '../radio-script-prompt.ts'
import { buildCallerSegmentMode, CALLERS } from '../cast.ts'
import { ARCHETYPES } from '../archetypes.ts'
import { initPersonaMemory, loadMusicManMemory, recentUtterancesBlock } from '../persona-memory.ts'

const SRC = join(import.meta.dirname, '..', '..')
const OLD = ['me', 'gan'].join('')

function liveFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '_archive' ? [] : liveFiles(full)
    return /\.(ts|tsx|css|html|json)$/.test(name) ? [full] : []
  })
}

describe('the rename holds', () => {
  test('no live code says the old name but the file that reads old state', () => {
    const allowed = new Set(['common/cohost.ts', 'main/__tests__/cohost-larry.test.ts'])
    const hits = liveFiles(SRC)
      .filter((f) => !allowed.has(relative(SRC, f)))
      .filter((f) => readFileSync(f, 'utf-8').toLowerCase().includes(OLD))
      .map((f) => relative(SRC, f))
    assert.deepEqual(hits, [])
  })

  test('his voice is one constant, and the old one is gone', () => {
    assert.equal(RADIO_CAST_BY_ID['larry'].voiceId, LARRY_VOICE_ID)
    assert.equal(LARRY_VOICE_ID, 'E84kZYo2dIe6J7R6AtEK')
    const old = ['T7eLpgAAhoX', 'HlrNajG8v'].join('')
    assert.deepEqual(liveFiles(SRC).filter((f) => readFileSync(f, 'utf-8').includes(old)), [])
  })
})

describe('old saved state keeps working', () => {
  test('a saved host', () => {
    assert.equal(normalizeHostId(OLD), 'larry')
    assert.equal(normalizeHostId('larry'), 'larry')
    assert.equal(normalizeHostId('mm'), 'mm')
    assert.equal(normalizeHostId(undefined), 'mm')
    assert.equal(normalizeHostId('anything'), 'mm')
  })

  test('a mixtape deck voice and a script tag', () => {
    assert.equal(currentCastId(OLD), 'larry')
    assert.equal(currentCastId('stephen'), 'stephen')
    assert.equal(currentRadioTag(OLD.toUpperCase()), 'LARRY')
    assert.equal(currentRadioTag('mm'), 'MM')
  })

  test('the script parser still takes the old tag', () => {
    const re = new RegExp(`^\\[(${RADIO_SCRIPT_TAGS})\\]\\s*(.+)`, 'i')
    assert.equal(re.exec(`[${OLD.toUpperCase()}] hello`)?.[2], 'hello')
    assert.equal(re.exec('[LARRY] hello')?.[1], 'LARRY')
    assert.equal(re.exec('[MM] hello')?.[1], 'MM')
  })

  test("ui-state: the week's picks, the saved view, page memory", () => {
    const picks = { v: 2, name: 'Third Week of Fall', trackIds: [1, 2], date: '2026-10-31' }
    const { state, changed } = migrateSavedState({
      [`${OLD}-picks`]: picks,
      activeSmartPlaylist: `${OLD}-picks`,
      currentView: 'smart-playlist',
      scroll: { [`smart:${OLD}-picks`]: 120, songs: 40 },
      order: ['top-25', `${OLD}-picks`],
      note: 'Megan Thee Stallion',
    })
    assert.equal(changed, true)
    assert.deepEqual(state, {
      'larry-picks': picks,
      activeSmartPlaylist: 'larry-picks',
      currentView: 'smart-playlist',
      scroll: { 'smart:larry-picks': 120, songs: 40 },
      order: ['top-25', 'larry-picks'],
      note: 'Megan Thee Stallion',
    })
  })

  test("a newer entry under the new key is never overwritten by the old one", () => {
    const { state } = migrateSavedState({ [`${OLD}-picks`]: { name: 'old' }, 'larry-picks': { name: 'new' } })
    assert.deepEqual(state, { 'larry-picks': { name: 'new' } })
  })

  test('settings: the chosen host', () => {
    const { state } = migrateSavedState({ ai: { aiHost: OLD, musicManVoiceEnabled: true } })
    assert.deepEqual(state, { ai: { aiHost: 'larry', musicManVoiceEnabled: true } })
  })

  test('state with nothing to migrate comes back untouched', () => {
    const before = { ai: { aiHost: 'mm' }, activeSmartPlaylist: 'top-25', members: ['Megan James'] }
    const { state, changed } = migrateSavedState(before)
    assert.equal(changed, false)
    assert.equal(state, before)
  })

  test("picks-cache: Larry inherits the week, no regeneration", () => {
    const entry = { weekStart: '2026-10-30', trackIds: [1] }
    assert.deepEqual(migratePicksCache({ mm: entry, [OLD]: entry }).cache, { mm: entry, larry: entry })
    assert.equal(migratePicksCache({ mm: entry }).changed, false)
    const newer = { weekStart: '2026-11-06', trackIds: [2] }
    assert.deepEqual(migratePicksCache({ [OLD]: entry, larry: newer }).cache, { larry: newer })
  })

  test('radio memory: real saved lines', () => {
    assert.equal(migrateCallback("Nothing. That's my POINT, Megan—"), "Nothing. That's my POINT, Larry—")
    assert.equal(
      migrateCallback('They can BOTH be top five, Megan, it\'s not a competition'),
      "They can BOTH be top five, Larry, it's not a competition",
    )
  })

  test('radio memory: a real artist called Megan stays, a line about her stays', () => {
    const line = 'Megan Thee Stallion and her whole catalog deserve better'
    assert.equal(migrateCallback(line), line)
    assert.equal(migrateCallback('That was Megan James on the vocal'), 'That was Megan James on the vocal')
  })

  test('radio memory: a line whose pronoun could be wrong is dropped, not kept wrong', () => {
    assert.equal(migrateCallback('Megan said she hated it'), null)
  })

  test('radio memory: entries', () => {
    const { entries, changed } = migrateRadioEntries([
      { speakers: ['mm', OLD], angle: 'MEGAN OFF-TOPIC', callbacks: ['Fine, Megan.', 'Megan said she hated it', 'No names here'], slot: 3 },
      { speakers: ['mm', 'larry'], angle: 'BACK-ANNOUNCE', callbacks: ['No names here'], slot: 4 },
    ])
    assert.equal(changed, true)
    assert.deepEqual(entries[0], { speakers: ['mm', 'larry'], angle: 'LARRY OFF-TOPIC', callbacks: ['Fine, Larry.', 'No names here'], slot: 3 })
    assert.equal(entries[1].angle, 'BACK-ANNOUNCE')
  })

  test('persona memory: the scripts every prompt reads as its own', async () => {
    assert.equal(migrateRememberedScript('[MM] Sure.\n\n[MEGAN] [scoffs] Okay, Music Man.'), '[MM] Sure.\n\n[LARRY] [scoffs] Okay, Music Man.')
    assert.equal(migrateRememberedScript("[MM] She's great.\n[MEGAN] No."), null)
    const saved: unknown[][] = []
    initPersonaMemory({
      cache: {
        get: async () => [
          { mode: 'radio', text: '[MM] Fine.\n\n[MEGAN] Is it, Megan says.', at: 1 },
          { mode: 'radio', text: '[MM] Fine.\n\n[MEGAN] She said so.', at: 2 },
          { mode: 'dj', text: 'Nothing to change.', at: 3 },
        ],
        set: (v: unknown[]) => { saved.push(v) },
      },
      userDataDir: '/nonexistent',
    })
    await loadMusicManMemory()
    const block = recentUtterancesBlock()
    assert.match(block, /\[LARRY\] Is it, Larry says\./)
    assert.match(block, /Nothing to change\./)
    assert.doesNotMatch(block, /MEGAN|Megan|She said/)
    assert.equal(saved.length, 1, 'once migrated, it stays migrated')
  })

  test('radio memory that is already current is not rewritten', () => {
    const before = [{ speakers: ['mm', 'larry'], angle: null, callbacks: ['Okay.'] }]
    const { entries, changed } = migrateRadioEntries(before)
    assert.equal(changed, false)
    assert.equal(entries, before)
  })
})

describe('who Larry is', () => {
  const names = ['the Funk Man', 'Funk Man', 'Marty', 'Funkhouser']

  test('he calls the Music Man by the four names; the Music Man is unchanged', () => {
    for (const n of names) assert.ok(LARRY_CORE.includes(n), n)
    assert.doesNotMatch(MUSIC_MAN_CORE, /Funk|Marty|Costanza|Curb/)
  })

  test('the guard rails are in his prompt, and no catchphrase is in a sample', () => {
    assert.match(LARRY_CORE, /never "pretty, pretty good"/)
    const samples = LARRY_CORE.slice(LARRY_CORE.indexOf('HOW LARRY ACTUALLY TALKS'))
    assert.doesNotMatch(samples, /pretty,? pretty good|Costanza|Curb|Seinfeld/i)
  })

  test('he is Larry from the first word', () => {
    assert.match(LARRY_CORE, /^You are Larry, the other host at WJLR/)
  })

  const script = (opts = {}) => buildRadioSegmentPrompt({ hasNextTrack: true, topicAngle: TOPIC_ANGLES[0], now: new Date('2026-11-05T17:00:00'), ...opts }).radioInstructions

  test('the radio prompt writes him as a man, with the names, and only he uses them', () => {
    const text = script()
    assert.match(text, /tag: \[LARRY\]/)
    for (const n of names) assert.ok(text.includes(n), n)
    assert.match(text, /ONLY Larry does\. The announcer, the callers and Stephen all say "Music Man"/)
    assert.doesNotMatch(text, /\b(she|she's|her|hers)\b/i)
  })

  test('the show open still says the Music Man, and names Larry', () => {
    const text = script({ opener: true })
    assert.ok(text.includes("[ANNOUNCER] Here's Larry, and the one, the only, the MUSIC MAN!"))
  })

  test('the formula Jake hated stays out: moves rotate, and the shape varies', () => {
    const text = script()
    assert.match(text, /never the same move two segments running/)
    assert.match(text, /NOT the same little argument every break/)
    assert.doesNotMatch(text, /DISAGREE on something specific every time/)
  })

  test('angles, archetypes and caller reactions write him as a man', () => {
    for (const a of TOPIC_ANGLES) assert.doesNotMatch(a, /\b(she|she's|her)\b/i, a)
    for (const a of Object.values(ARCHETYPES)) {
      if (a.id !== 'lateral-pivot') assert.doesNotMatch(a.shape, /\b(she|she's|her)\b/i, a.id)
    }
    const giovanni = buildCallerSegmentMode('giovanni')
    assert.match(giovanni, /LARRY'S DEFAULT REACTION/)
    assert.equal(Object.values(CALLERS).filter((c) => /[Cc]ritic/.test(c.larryReaction)).length, 0)
  })
})

describe('a script that ran out of room', () => {
  test('drops the cut line', () => {
    assert.equal(wholeScriptLines('[MM] One.\n\n[LARRY] Two.\n\n[MM] Thr'), '[MM] One.\n\n[LARRY] Two.')
  })
  test('drops a line that is only a tag', () => {
    assert.equal(wholeScriptLines('[MM] One.\n[LARRY] [pauses]'), '[MM] One.')
  })
  test('a single line goes as it came', () => {
    assert.equal(wholeScriptLines('[MM] One'), '[MM] One')
  })
})
