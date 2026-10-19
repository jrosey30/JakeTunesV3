/**
 * Critic picks (2026-10-18) — a TikTok blogger's public album-ratings sheet
 * as a staff-picks wall: 5 new picks a day from the 9s and 10s Jake does not
 * own, 10s first, credited "@jkennmafia · 10/10".
 *
 * Pinned here, all offline (no network, no clock, no Electron):
 *   • the parser — header-by-name, stats panel ignored, junk rows dropped;
 *   • the candidate filter — owned (fold- and article-aware), Disliked,
 *     Not for me, listed, already served;
 *   • the pacing — 5 a day, 10s first, deterministic, nothing ever repeats,
 *     stable across restarts, an outage records nothing;
 *   • NOT A TASTE SIGNAL — the blogger's scores disagree with Jake's ears
 *     (Spearman ≈ −0.03), so the wall must never write a verdict, touch the
 *     feedback file or hand the brain anything to learn from by itself.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CRITIC_PICKS_SOURCE, CRITIC_LANE, CRITIC_RETRY_DAYS, parseCsv, parseCriticSheet, criticCandidates, criticGenre,
  criticRowKey, criticNote, emptyCriticLedger, normalizeCriticLedger, planCriticDay, mergeCriticLedger, localDayKey,
  type CriticAlbum, type CriticRow, type CriticSource,
} from '../../common/critic-picks.ts'
import {
  sameAlbumTitle, criticOwnership, criticExclusions, resolveCriticAlbum, criticPickCards, criticCard,
  looksLikeCriticSheet, CRITIC_LEDGER_FILE, CRITIC_SHEET_FILE,
} from '../critic-picks-feed.ts'
import { applyQualityFloor, assembleLanes, filterFeed, ownedPairKeys, ownershipChecks, normKey, type FeedCard } from '../discover-feed.ts'
import { applyBinQuotas, binForGenre } from '../../common/record-shop-bins.ts'
import { shopItemFromFeed } from '../../common/record-shop-adapters.ts'

// gviz shape: every cell quoted, a stats panel to the right of the six columns.
const SHEET = [
  '"Artist","Genre","Sub-Genre","Score","Title","Year","","Stats","","Album Count"',
  '"2021","Electronic","","5","Like a Paper Plane ","2024","","Genre","","Pre-2020: On Excel"',
  '"Radiohead","Rock","","10","In Rainbows","2007","","Electronic ","231","6.42"',
  '"A Tribe Called Quest","Hip Hop","Jazz","9","People\'s Instinctive Travels (…)","1990","","Jazz ","121","6.75"',
  '"Dead Kennedys","Rock","Hardcore","9","Fresh Fruit for Rotting Vegetables","1980","","",""',
  '"Kanye West","Hip Hop","","10","College Dropout","2004","W","Hip Hop ","283"',
  '"Nas","Hip Hop","Hardcore","10","Illmatic","1994","","",""',
  '"White Stripes","Rock","Garage","10","Elephant","2003","","",""',
  '"Bad Row","Rock","","x","Not A Score","2001","","",""',
  '"","Rock","","9","No Artist","2001","","",""',
  '"Too High","Rock","","11","Eleven","2001","","",""',
  '"Artist","Genre","Sub-Genre","Score","Title","Year","","",""',
  '"Comma, Band","Pop","","9","Title, With ""Quotes""","1999","","",""',
  '"Miles Davis","Jazz","Modal","10","Kind of Blue","1959","","",""',
].join('\n')

const source = (over: Partial<CriticSource> = {}): CriticSource => ({ ...CRITIC_PICKS_SOURCE, ...over })

describe('config', () => {
  test('the wall is credited to @jkennmafia, 9s and up, 5 a day', () => {
    assert.equal(CRITIC_PICKS_SOURCE.id, 'tiktok-album-sheet')
    assert.equal(CRITIC_PICKS_SOURCE.credit, '@jkennmafia')
    assert.equal(CRITIC_PICKS_SOURCE.minScore, 9)
    assert.equal(CRITIC_PICKS_SOURCE.perDay, 5)
    assert.equal(criticNote(CRITIC_PICKS_SOURCE.credit, 10), '@jkennmafia · 10/10')
    assert.equal(criticNote('  ', 10), '', 'no credit, no note — never a made-up name')
  })
})

describe('parseCriticSheet', () => {
  const rows = parseCriticSheet(SHEET)
  test('scored rows only, trimmed, in sheet order; stats panel never read', () => {
    assert.deepEqual(rows.map((r) => `${r.artist}|${r.title}|${r.score}`), [
      '2021|Like a Paper Plane|5',
      'Radiohead|In Rainbows|10',
      "A Tribe Called Quest|People's Instinctive Travels|9",
      'Dead Kennedys|Fresh Fruit for Rotting Vegetables|9',
      'Kanye West|College Dropout|10',
      'Nas|Illmatic|10',
      'White Stripes|Elephant|10',
      'Comma, Band|Title, With "Quotes"|9',
      'Miles Davis|Kind of Blue|10',
    ])
    assert.deepEqual(rows.map((r) => r.row), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  })
  test('junk is dropped: non-numeric / out-of-range scores, no artist, a repeated header', () => {
    assert.ok(!rows.some((r) => ['Bad Row', 'Too High', 'Artist'].includes(r.artist) || r.title === 'No Artist'))
  })
  test('the sheet\'s cut-off mark is noted and stripped; years are numbers', () => {
    const atcq = rows.find((r) => r.artist === 'A Tribe Called Quest')!
    assert.equal(atcq.truncated, true)
    assert.equal(atcq.year, 1990)
    assert.equal(rows.find((r) => r.artist === 'Nas')!.truncated, false)
  })
  test('columns are found by header name, not position', () => {
    const moved = parseCriticSheet('"Title","Score","Artist","Genre"\n"Kid A","10","Radiohead","Electronic"')
    assert.deepEqual(moved.map((r) => [r.artist, r.title, r.score, r.genre]), [['Radiohead', 'Kid A', 10, 'Electronic']])
  })
  test('parseCsv handles quoted newlines and CRLF', () => {
    assert.deepEqual(parseCsv('"a","b\nc"\r\n"d",e'), [['a', 'b\nc'], ['d', 'e']])
  })
  test('a login page or error doc is not the sheet', () => {
    assert.equal(looksLikeCriticSheet('<!doctype html><title>Sign in</title>'), false)
    assert.equal(looksLikeCriticSheet(SHEET), true)
  })
})

describe('criticGenre — filed into the existing bins', () => {
  const bin = (genre: string, subGenre: string): string => binForGenre(criticGenre({ genre, subGenre }))
  test('the blogger\'s Genre leads; Rock\'s punk sub-genres go to Punk; Misc falls to the Sub-Genre', () => {
    assert.equal(bin('Hip Hop', 'Hardcore'), 'Hip-Hop', 'a hardcore RAP record is not punk')
    assert.equal(bin('Rock', 'Hardcore'), 'Punk')
    assert.equal(bin('Rock', 'Pop Punk'), 'Punk')
    assert.equal(bin('Metal', 'Thrash'), 'Rock')
    assert.equal(bin('R&B', ''), 'Soul & Funk')
    assert.equal(bin('Electronic', 'Garage'), 'Electronic')
    assert.equal(bin('Other', 'Jazz'), 'Jazz & Blues')
    assert.equal(bin('', ''), 'Misc')
  })
})

describe('criticCandidates — 9s and up, 10s first, then sheet order', () => {
  test('ordered, filtered, de-duplicated', () => {
    const rows = parseCriticSheet(SHEET + '\n"Radiohead","Rock","","10","In Rainbows","2007"')
    const c = criticCandidates(rows, 9)
    assert.deepEqual(c.map((r) => r.title), [
      'In Rainbows', 'College Dropout', 'Illmatic', 'Elephant', 'Kind of Blue',
      "People's Instinctive Travels", 'Fresh Fruit for Rotting Vegetables', 'Title, With "Quotes"',
    ])
  })
})

// ── Ownership + exclusions ────────────────────────────────────────────

const libTracks = [
  { artist: 'Kanye West', album: 'The College Dropout', title: 'Through the Wire' },
  { artist: 'The White Stripes', album: 'Elephant', title: 'Seven Nation Army' },
  { artist: 'Beyoncé', album: 'Lemonade', title: 'Formation' },
  { artist: 'Kanye West', album: 'My Beautiful Dark Twisted Fantasy', title: 'Power' },
  { artist: 'Led Zeppelin', album: 'Led Zeppelin', title: 'Good Times Bad Times' },
  { artist: 'Led Zeppelin', album: 'Led Zeppelin III', title: 'Immigrant Song' },
  { artist: 'JAY-Z', album: 'The Blueprint', title: 'Izzo' },
]
function ownedSets(tracks: typeof libTracks): { artists: Set<string>; albumKeys: Set<string>; baseKeys: Set<string> } {
  return { artists: new Set(tracks.map((t) => normKey(t.artist))), albumKeys: new Set(ownedPairKeys(tracks)), baseKeys: new Set<string>() }
}

describe('owned — the shop\'s own check, fold- and article-aware', () => {
  const owns = criticOwnership(ownedSets(libTracks), libTracks)
  test('"College Dropout" is owned when "The College Dropout" is', () => {
    assert.equal(owns('Kanye West', 'College Dropout'), true)
    assert.equal(ownershipChecks(ownedSets(libTracks)).ownsAlbum('Kanye West', 'College Dropout'), true,
      'the article bridge lives in the SHARED check the supply lanes use')
  })
  test('artist articles, accents, punctuation', () => {
    assert.equal(owns('White Stripes', 'Elephant'), true)
    assert.equal(owns('Beyonce', 'Lemonade'), true)
    assert.equal(owns('Jay Z', 'The Blue Print'), true)
  })
  test('the sheet\'s shorthand of an owned record is owned', () => {
    assert.equal(owns('Kanye West', 'My Beautiful Dark Twisted'), true)
  })
  test('self-titled and numbered records never borrow each other\'s ownership', () => {
    assert.equal(owns('Led Zeppelin', 'Led Zeppelin'), true)
    assert.equal(owns('Led Zeppelin', 'Led Zeppelin IV'), false, 'owning "Led Zeppelin" is not owning IV')
    assert.equal(owns('Led Zeppelin', 'Led Zeppelin II'), false, 'owning III is not owning II')
    assert.equal(owns('Radiohead', 'In Rainbows'), false)
  })
})

describe('sameAlbumTitle — catalogue identity for hand-typed titles', () => {
  const yes: Array<[string, string, string, boolean?]> = [
    ['Low End Theory', 'The Low End Theory', 'A Tribe Called Quest'],
    ['Court of the Crimson King', 'In the Court of the Crimson King (Expanded & Remastered)', 'King Crimson'],
    ["People's Instinctive Travels", "People's Instinctive Travels and the Paths of Rhythm", 'A Tribe Called Quest', true],
    ['Kill Em All', "Kill 'Em All (Remastered)", 'Metallica'],
    ['Never Mind the Bollocks', "Never Mind The Bollocks, Here's The Sex Pistols", 'Sex Pistols'],
    ['Emotion', 'E•MO•TION', 'Carly Rae Jepsen'],
    ['Led Zeppelin', 'Led Zeppelin (Remaster)', 'Led Zeppelin'],
  ]
  const no: Array<[string, string, string, boolean?]> = [
    ['Led Zeppelin', 'Led Zeppelin IV', 'Led Zeppelin'],
    ['Fleetwood Mac', 'Fleetwood Mac Live', 'Fleetwood Mac'],
    ['Rumours Live', 'Rumours', 'Fleetwood Mac'],
    ['Led Zeppelin II', 'Led Zeppelin III', 'Led Zeppelin'],
    ['Illmatic', 'Illmatic XX', 'Nas'],
    ['Saturation', 'Saturation II', 'Brockhampton'],
    ['Ten', 'Tension', 'Pearl Jam'],
    ['Kid A', 'Kid A Mnesia', 'Radiohead'],
    ['Midnight Mauraders', 'Midnight Marauders', 'A Tribe Called Quest'],
  ]
  for (const [w, g, a, t] of yes) test(`"${w}" = "${g}"`, () => assert.equal(sameAlbumTitle(w, g, a, t), true))
  for (const [w, g, a, t] of no) test(`"${w}" ≠ "${g}"`, () => assert.equal(sameAlbumTitle(w, g, a, t), false))
})

describe('resolveCriticAlbum — no catalogue answer, no card', () => {
  const row = (artist: string, title: string): CriticRow => ({ artist, title, genre: 'Rock', subGenre: '', score: 10, row: 0, truncated: false })
  test('iTunes first: canonical names, art, collection id; edition dressing dropped', async () => {
    const a = await resolveCriticAlbum(row('Carly Rae Jepsen', 'Emotion'), {
      itunes: async () => ({ artist: 'Carly Rae Jepsen', title: 'Emotion (10th Anniversary Edition)', year: '2025', artUrl: 'a', collectionId: 7 }),
      deezer: async () => { throw new Error('not asked') },
    })
    assert.deepEqual(a, { artist: 'Carly Rae Jepsen', title: 'Emotion', year: '2025', artUrl: 'a', collectionId: 7 })
  })
  test('a wrong record from the right artist is refused; Deezer must match too', async () => {
    const a = await resolveCriticAlbum(row('Led Zeppelin', 'Led Zeppelin'), {
      itunes: async () => ({ artist: 'Led Zeppelin', title: 'Led Zeppelin IV', artUrl: 'a', collectionId: 4 }),
      deezer: async () => ({ artist: 'Led Zeppelin', title: 'Mothership', artUrl: 'b' }),
    })
    assert.equal(a, null)
  })
  test('a soundalike artist is refused', async () => {
    const a = await resolveCriticAlbum(row('Rage Against the Machine', 'Evil Empire'), {
      itunes: async () => ({ artist: 'Rage Against the Blues', title: 'Evil Empire', artUrl: 'a' }),
      deezer: async () => null,
    })
    assert.equal(a, null)
  })
  test('Deezer answers what Apple does not carry', async () => {
    const a = await resolveCriticAlbum(row('Disfear', 'Live the Storm'), {
      itunes: async () => null,
      deezer: async () => ({ artist: 'Disfear', title: 'Live The Storm', year: '2008', artUrl: 'z' }),
    })
    assert.equal(a?.title, 'Live The Storm')
    assert.equal(a?.collectionId, undefined)
  })
})

describe('criticExclusions — Disliked, Not for me, listed, owned', () => {
  const r = (artist: string, title: string): CriticRow => ({ artist, title, genre: 'Rock', subGenre: '', score: 10, row: 0, truncated: false })
  const ex = criticExclusions({
    owns: () => false,
    blocks: (c) => c.artist === 'Greta Van Fleet',
    notForMe: { 'run the jewels': { artist: 'Run The Jewels', at: 1 } },
    served: { 'disc|radiohead|kid a': { views: 99 }, 'radiohead|amnesiac': { views: 3 } },
    isOnList: (a, t) => a === 'Burial' && t === 'Untrue',
  })
  test('each gate on its own', () => {
    assert.equal(ex.row(r('Greta Van Fleet', 'Anthem of the Peaceful Army')), true, 'Rock DNA Dislike')
    assert.equal(ex.row(r('Run the Jewels', 'Run the Jewels 4')), true, 'Not for me (artist)')
    assert.equal(ex.row(r('Radiohead', 'Kid A')), true, 'Not for me (card rest, the renderer\'s key)')
    assert.equal(ex.row(r('Burial', 'Untrue')), true, 'already on the Listen List')
    assert.equal(ex.row(r('Radiohead', 'Amnesiac')), false, 'a few views is not a verdict')
  })
  test('the same gates on the catalogue\'s names; owned is its own answer', () => {
    const owned = criticExclusions({ owns: (a) => a === 'X', blocks: () => false, notForMe: {}, served: {}, isOnList: () => false })
    assert.equal(owned.album({ artist: 'X', title: 'Y' }, ''), 'owned')
    assert.equal(ex.album({ artist: 'Greta Van Fleet', title: 'Z' }, 'Rock'), 'excluded')
    assert.equal(ex.album({ artist: 'Burial', title: 'Kindred' }, 'Electronic'), null)
  })
})

// ── Daily pacing ──────────────────────────────────────────────────────

/** 8 tens then 8 nines, in sheet order N0..N15; tens are odd rows so the
 *  score sort (not the sheet order) is what puts them first. */
const paceRows: CriticRow[] = Array.from({ length: 16 }, (_, i) => ({
  artist: `Band ${i}`, title: `Record ${i}`, genre: 'Rock', subGenre: '', score: i % 2 ? 10 : 9, row: i, truncated: false,
}))
const resolveAll = async (r: CriticRow): Promise<CriticAlbum> => ({ artist: r.artist, title: r.title })
const plan = (ledger = emptyCriticLedger('t'), today = '2026-10-18', over: Partial<Parameters<typeof planCriticDay>[0]> = {}) =>
  planCriticDay({ ledger, today, candidates: criticCandidates(paceRows, 9), perDay: 5, excluded: () => false, resolve: resolveAll, excludedAlbum: () => null, ...over })

describe('planCriticDay — 5 a day, 10s first, never repeats', () => {
  test('day one: the first five 10s, in sheet order', async () => {
    const p = await plan()
    assert.equal(p.changed, true)
    assert.deepEqual(p.picks.map((x) => x.sheet.title), ['Record 1', 'Record 3', 'Record 5', 'Record 7', 'Record 9'])
    assert.ok(p.picks.every((x) => x.score === 10))
  })
  test('same day again (a restart): the same five, no lookups', async () => {
    const d1 = await plan()
    let asked = 0
    const again = await plan(d1.ledger, '2026-10-18', { resolve: async (r) => { asked++; return resolveAll(r) } })
    assert.equal(again.changed, false)
    assert.equal(asked, 0)
    assert.deepEqual(again.picks, d1.picks)
  })
  test('the wall moves forward daily and nothing repeats until the sheet runs dry', async () => {
    let ledger = emptyCriticLedger('t')
    const seen: string[] = []
    for (const day of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']) {
      const p = await plan(ledger, day)
      ledger = p.ledger
      seen.push(...p.picks.map((x) => x.sheet.title))
    }
    assert.equal(seen.length, 16, 'three full days and one short day')
    assert.equal(new Set(seen).size, 16, 'no repeats across days')
    assert.deepEqual(seen.slice(5, 10), ['Record 11', 'Record 13', 'Record 15', 'Record 0', 'Record 2'], 'the 10s run out, then the 9s')
    const dry = await plan(ledger, '2026-10-22')
    assert.deepEqual(dry.picks, [], 'an exhausted sheet shows nothing rather than repeating')
  })
  test('deterministic: two independent runs agree', async () => {
    const a = await plan(), b = await plan()
    assert.deepEqual(a.picks, b.picks)
  })
  test('a re-spelled row cannot bring a served record back (catalogue key)', async () => {
    const d1 = await plan()
    const rows = [...paceRows, { ...paceRows[1], title: 'Record 1 (typo fixed)', row: 99 }]
    const p = await planCriticDay({ ledger: d1.ledger, today: '2026-10-19', candidates: criticCandidates(rows, 9), perDay: 5, excluded: () => false,
      resolve: async (r) => ({ artist: r.artist, title: r.title.replace(' (typo fixed)', '') }), excludedAlbum: () => null })
    assert.ok(!p.picks.some((x) => x.album.title === 'Record 1'))
  })
  test('excluded rows are passed over, not recorded; owned-by-catalogue rows rest', async () => {
    const p = await plan(undefined, '2026-10-18', {
      excluded: (r) => r.title === 'Record 1',
      excludedAlbum: (a) => a.title === 'Record 3' ? 'owned' : null,
    })
    assert.deepEqual(p.picks.map((x) => x.sheet.title), ['Record 5', 'Record 7', 'Record 9', 'Record 11', 'Record 13'])
    assert.equal(p.ledger.skipped[criticRowKey(paceRows[1])], undefined, 'an exclusion is re-asked tomorrow (an un-dislike brings it back)')
    assert.equal(p.ledger.skipped[criticRowKey(paceRows[3])]?.why, 'owned')
  })
  test('a catalogue miss rests a few days, then is asked again', async () => {
    const missOne = async (r: CriticRow): Promise<CriticAlbum | null> => r.title === 'Record 1' ? null : resolveAll(r)
    const d1 = await plan(undefined, '2026-10-01', { resolve: missOne })
    assert.equal(d1.ledger.skipped[criticRowKey(paceRows[1])]?.why, 'unverified')
    const soon = await plan(d1.ledger, '2026-10-02')
    assert.ok(!soon.picks.some((x) => x.sheet.title === 'Record 1'))
    const later = new Date(Date.UTC(2026, 9, 1 + CRITIC_RETRY_DAYS.unverified)).toISOString().slice(0, 10)
    const retry = await plan(soon.ledger, later)
    assert.equal(retry.picks[0].sheet.title, 'Record 1')
  })
  test('an outage (every lookup fails) records NOTHING', async () => {
    const p = await plan(undefined, '2026-10-18', { resolve: async () => null })
    assert.equal(p.changed, false)
    assert.deepEqual(p.ledger, emptyCriticLedger('t'))
  })
  test('a short day tops up later; lookups are bounded', async () => {
    let n = 0
    const flaky = async (r: CriticRow): Promise<CriticAlbum | null> => (n++ < 2 ? resolveAll(r) : null)
    const short = await plan(undefined, '2026-10-18', { resolve: flaky, maxLookups: 6 })
    assert.equal(short.picks.length, 2)
    assert.equal(n, 6, 'never more lookups than the bound')
    const topped = await plan(short.ledger, '2026-10-18')
    assert.equal(topped.picks.length, 5)
    assert.deepEqual(topped.picks.slice(0, 2), short.picks, 'the morning\'s picks keep their places')
  })
})

describe('ledger persistence helpers', () => {
  test('merge lands on the FRESH disk copy — its picks keep their order, the day stays at 5', async () => {
    const ours = (await plan()).ledger
    const disk = emptyCriticLedger('t')
    disk.days['2026-10-18'] = [{ ...ours.days['2026-10-18'][4] }]
    disk.days['2026-10-17'] = [{ ...ours.days['2026-10-18'][0], key: 'older' }]
    const m = mergeCriticLedger(disk, ours, 5)
    assert.equal(m.days['2026-10-18'].length, 5)
    assert.equal(m.days['2026-10-18'][0].key, ours.days['2026-10-18'][4].key)
    assert.ok(m.days['2026-10-17'], 'a day only the disk knows survives')
  })
  test('normalize drops junk and a different source\'s ledger', () => {
    assert.deepEqual(normalizeCriticLedger({ sourceId: 'other', days: { '2026-10-18': [{}] } }, 't'), emptyCriticLedger('t'))
    assert.deepEqual(normalizeCriticLedger({ days: { nope: [], '2026-10-18': [{ key: 1 }] }, skipped: { a: { day: 'x', why: 'bad' } } }, 't'), emptyCriticLedger('t'))
  })
  test('the local day, not UTC', () => {
    assert.equal(localDayKey(new Date(2026, 9, 18, 23, 59)), '2026-10-18')
    assert.equal(localDayKey(new Date(2026, 9, 19, 0, 1)), '2026-10-19')
  })
})

// ── End to end, on disk ───────────────────────────────────────────────

function harness(over: Partial<Parameters<typeof criticPickCards>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jt-critic-'))
  let fetches = 0
  const tracks = [{ artist: 'Kanye West', album: 'The College Dropout' }]
  const run = (at: Date, more: Partial<Parameters<typeof criticPickCards>[0]> = {}) => criticPickCards({
    stateDir: dir, tracks, owned: ownedSets(tracks as typeof libTracks), blocks: () => false,
    feedback: async () => ({ notForMe: {}, served: {} }), isOnList: async () => () => false,
    now: at, sleepMs: 0,
    fetchText: async () => { fetches++; return SHEET },
    itunes: async (_q, _e, want) => ({ artist: want.artist, title: want.title, artUrl: `art:${want.title}`, collectionId: 1 }),
    deezer: async () => null,
    ...over, ...more,
  })
  return { dir, run, fetches: () => fetches, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('criticPickCards — the lane index.ts calls', () => {
  test('no credit = no cards and no fetch at all', async () => {
    const h = harness({ source: source({ credit: '' }) })
    assert.deepEqual(await h.run(new Date(2026, 9, 18, 12)), [])
    assert.equal(h.fetches(), 0)
    assert.deepEqual(readdirSync(h.dir), [])
    h.done()
  })
  test('five credited cards, 10s first, owned skipped; the same five after a restart; the next five tomorrow', async () => {
    const h = harness()
    const day1 = await h.run(new Date(2026, 9, 18, 9))
    assert.deepEqual(day1.map((c) => c.title), ['In Rainbows', 'Illmatic', 'Elephant', 'Kind of Blue', "People's Instinctive Travels"],
      '"College Dropout" is owned as "The College Dropout"')
    for (const c of day1) {
      assert.equal(c.lane, CRITIC_LANE)
      assert.equal(c.type, 'album')
      assert.deepEqual(c.source, { kind: 'person', id: 'tiktok-album-sheet', name: '@jkennmafia' })
    }
    assert.equal(day1[0].why, '@jkennmafia · 10/10')
    assert.equal(day1[4].why, '@jkennmafia · 9/10')
    const restart = await h.run(new Date(2026, 9, 18, 21))
    assert.deepEqual(restart, day1, 'stable all day, across restarts')
    assert.equal(h.fetches(), 1, 'the sheet is fetched at most once a day')
    const day2 = await h.run(new Date(2026, 9, 19, 9))
    assert.deepEqual(day2.map((c) => c.title), ['Fresh Fruit for Rotting Vegetables', 'Title, With "Quotes"'])
    assert.equal(h.fetches(), 2)
    h.done()
  })
  test('offline: yesterday\'s cached sheet still stocks the wall', async () => {
    const h = harness()
    await h.run(new Date(2026, 9, 18, 9))
    const off = await h.run(new Date(2026, 9, 19, 9), { fetchText: async () => { throw new Error('offline') } })
    assert.equal(off.length, 2)
    h.done()
  })
  test('a pick he dismisses, Gets or lists leaves today\'s wall and never comes back', async () => {
    const h = harness()
    await h.run(new Date(2026, 9, 18, 9))
    const later = await h.run(new Date(2026, 9, 18, 15), {
      feedback: async () => ({ notForMe: { nas: { artist: 'Nas' } }, served: { 'disc|radiohead|in rainbows': { views: 99 } } }),
      isOnList: async () => (a: string) => a === 'Miles Davis',
    })
    assert.deepEqual(later.map((c) => c.title), ['Elephant', "People's Instinctive Travels"])
    h.done()
  })
  test('an unreadable ledger is never overwritten — the wall stays empty instead of repeating', async () => {
    const h = harness()
    writeFileSync(join(h.dir, CRITIC_LEDGER_FILE), '{ torn')
    assert.deepEqual(await h.run(new Date(2026, 9, 18, 9)), [])
    assert.equal(readFileSync(join(h.dir, CRITIC_LEDGER_FILE), 'utf-8'), '{ torn')
    h.done()
  })
})

// ── Not a taste signal ────────────────────────────────────────────────

describe('the blogger\'s picks never teach the taste model by themselves', () => {
  test('running the wall writes ONLY its own two files — no verdict, no feedback, no rotation', async () => {
    const h = harness()
    const ledgerRow = '{"ts":"2026-10-17T00:00:00Z","surface":"discover","verdict":"accept","key":{},"ctx":{}}\n'
    writeFileSync(join(h.dir, 'taste-ledger.jsonl'), ledgerRow)
    writeFileSync(join(h.dir, 'discovery-feedback.json'), '{"notForMe":{},"served":{}}')
    const fb = Object.freeze({ notForMe: Object.freeze({}), served: Object.freeze({}) })
    await h.run(new Date(2026, 9, 18, 9), { feedback: async () => fb })
    assert.deepEqual(readdirSync(h.dir).sort(), [CRITIC_LEDGER_FILE, CRITIC_SHEET_FILE, 'discovery-feedback.json', 'taste-ledger.jsonl'].sort())
    assert.equal(readFileSync(join(h.dir, 'taste-ledger.jsonl'), 'utf-8'), ledgerRow, 'no verdict appended')
    assert.equal(readFileSync(join(h.dir, 'discovery-feedback.json'), 'utf-8'), '{"notForMe":{},"served":{}}')
    h.done()
  })
  test('a card carries nothing the brain embeds or the bridge claims — the score is a credit line only', () => {
    const c = criticCard({ key: 'k', albumKey: 'k', score: 10, sheet: { artist: 'A', title: 'T', genre: 'Rock', subGenre: '', year: 1999 }, album: { artist: 'A', title: 'T' } }, CRITIC_PICKS_SOURCE)
    assert.equal(c.desc, undefined, 'desc feeds the embedding; a credit is not a sound')
    assert.equal(c.because, undefined, 'the library did not bridge to it — the blogger chose it')
    assert.equal(c.brainPct, undefined)
    assert.equal(c.why, '@jkennmafia · 10/10')
  })
  test('the modules never reach a taste writer', () => {
    for (const f of ['../critic-picks-feed.ts', '../../common/critic-picks.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf-8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      for (const banned of ['taste-ledger', 'tasteLedger', 'TASTE_LEDGER', 'taste-ipc', 'appendFile', 'discoveryFeedbackCache', 'discovery-brain', 'brainMatchCandidates', 'discoverVerdicts', 'embeddings']) {
        assert.ok(!src.includes(banned), `${f} must not touch ${banned}`)
      }
    }
  })
  test('shop model: the recommendation is a PERSON, not the shop\'s AI', () => {
    const card = criticCard({ key: 'k', albumKey: 'k', score: 9, sheet: { artist: 'A', title: 'T', genre: 'Rock', subGenre: '' }, album: { artist: 'A', title: 'T' } }, CRITIC_PICKS_SOURCE)
    const { recommendation } = shopItemFromFeed(card, { itemId: 'i', recommendationId: 'r', receivedAt: 'now' })
    assert.deepEqual(recommendation.source, { kind: 'person', id: 'tiktok-album-sheet', name: '@jkennmafia' })
    assert.equal(recommendation.reason, '@jkennmafia · 9/10')
    const plain = shopItemFromFeed({ type: 'album', artist: 'A', title: 'T', why: 'w', lane: 'scene' }, { itemId: 'i', recommendationId: 'r', receivedAt: 'now' })
    assert.equal(plain.recommendation.source.kind, 'ai', 'every other card is unchanged')
  })
})

describe('the shop passes keep the daily five whole', () => {
  const critic = (n: number, brainPct: number): FeedCard => ({ lane: CRITIC_LANE, type: 'album', artist: `C${n}`, title: `T${n}`, why: '@jkennmafia · 10/10', brainPct, genre: 'Rock' })
  test('the brain floor orders them but never cuts them', () => {
    assert.equal(applyQualityFloor([critic(1, 5), critic(2, 10)]).length, 2)
  })
  test('view rotation never rests them; a Not-for-me rest does', () => {
    const base = { ownedArtists: new Set<string>(), ownedAlbumKeys: new Set<string>(), notForMe: {}, now: 1000 }
    assert.equal(filterFeed([critic(1, 50)], { ...base, served: { 'c1|t1': { views: 10, last: 999 } } }).length, 1)
    assert.equal(filterFeed([critic(1, 50)], { ...base, served: { 'c1|t1': { views: 99, last: 999 } } }).length, 0)
    const scene: FeedCard = { ...critic(1, 50), lane: 'scene' }
    assert.equal(filterFeed([scene], { ...base, served: { 'c1|t1': { views: 10, last: 999 } } }).length, 0, 'other lanes still rotate')
  })
  test('assembleLanes seats them on their own lane, at most perDay', () => {
    const lanes = assembleLanes(Array.from({ length: 8 }, (_, i) => critic(i, i)))
    const l = lanes.find((x) => x.id === CRITIC_LANE)
    assert.equal(l?.cards.length, CRITIC_PICKS_SOURCE.perDay)
  })
  test('pinned in their genre bin — the brain-% cap cannot hide one', () => {
    const rock = Array.from({ length: 8 }, (_, i) => ({ bin: 'Rock', brainPct: 90 + i, lane: 'scene' }))
    const pick = { bin: 'Rock', brainPct: 1, lane: CRITIC_LANE }
    const shelves = applyBinQuotas([...rock, pick], { cap: 6, keep: (c) => c.lane === CRITIC_LANE })
    const r = shelves.find((s) => s.bin === 'Rock')!
    assert.equal(r.cards.length, 6)
    assert.ok(r.cards.includes(pick))
    const unpinned = applyBinQuotas([...rock, pick], { cap: 6 }).find((s) => s.bin === 'Rock')!
    assert.ok(!unpinned.cards.includes(pick), 'without the pin the cap would have dropped it')
  })
})
