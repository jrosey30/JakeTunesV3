/**
 * Discovery pick-quality doctrine (2026-08-21, "its really the brain picking
 * music for the record shop that isnt very good"):
 *
 *  - baseTitleKey: owning a recording blocks its demo/live/deluxe variants
 *    (the Kitchen Tape Demo reject), without collapsing legit titles.
 *  - filterFeed: base-identity owned-drop, guarded against self-titled
 *    albums (Weezer's five self-titled records all reduce to "weezer").
 *  - applyQualityFloor: no lane ships a card the brain doesn't believe in;
 *    thin lanes back-fill to a minimum but the 40 "no signal" sentinel
 *    never ships.
 *  - buildCandidateText: candidate embeds speak the library's plain voice
 *    (album/year + genre), not a bare name-and-year stub.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  baseTitleKey, filterFeed, applyQualityFloor, cardKey,
  restKeyFor, hasShopIdRests, migrateShopIdRests, isResting, ROTATE_VIEWS, ROTATE_REST_MS,
  BRAIN_FLOOR, BRAIN_HARD_FLOOR, BRAIN_LANE_MIN,
  type FeedCard,
} from '../discover-feed.ts'
import {
  buildCandidateText, adjustedCosine, cosineToPct,
  REJECT_MARGIN, REJECT_WEIGHT,
} from '../discovery-brain.ts'
import { discoverVerdicts, type LedgerRow } from '../discovery-learned.ts'

describe('baseTitleKey — recording identity', () => {
  test('demo variant collapses onto the owned base title', () => {
    assert.equal(
      baseTitleKey('Undone -- The Sweater Song (Kitchen Tape Demo)'),
      baseTitleKey('Undone - The Sweater Song'),
    )
  })
  test('live dash-suffix collapses; plain subtitles survive', () => {
    assert.equal(baseTitleKey('Song 2 - Live at Wembley'), baseTitleKey('Song 2'))
    assert.equal(baseTitleKey('Demolition - Part 1'), 'demolition part 1')
  })
  test('a song NAMED with a marker word never self-destructs', () => {
    assert.equal(baseTitleKey('Live and Let Die'), 'live and let die')
  })
  test('subtitle brackets collapse to the bare title (Lady / Hear Me Tonight)', () => {
    assert.equal(baseTitleKey('Lady (Hear Me Tonight)'), 'lady')
  })
  test('deluxe/expanded album editions collapse onto the base album', () => {
    assert.equal(
      baseTitleKey('Emperor Tomato Ketchup (Expanded Edition)'),
      baseTitleKey('Emperor Tomato Ketchup'),
    )
  })
  test('never returns empty for a real string', () => {
    assert.ok(baseTitleKey('(Untitled)').length > 0)
  })
})

const card = (over: Partial<FeedCard>): FeedCard => ({
  lane: 'songs', type: 'song', artist: 'X', title: 'Y', why: '', ...over,
})
const baseOpts = () => ({
  ownedArtists: new Set<string>(),
  ownedAlbumKeys: new Set<string>(),
  notForMe: {},
  served: {},
  now: 0,
})

describe('filterFeed — base-identity owned drop', () => {
  test('owning the song blocks its decorated variants', () => {
    const owned = new Set([`weezer|${baseTitleKey('Undone - The Sweater Song')}`])
    const out = filterFeed(
      [card({ artist: 'Weezer', title: 'Undone -- The Sweater Song (Kitchen Tape Demo)' })],
      { ...baseOpts(), ownedBaseKeys: owned },
    )
    assert.equal(out.length, 0)
  })
  test('self-titled guard: owning the Blue Album does not block the Green Album', () => {
    // Both "Weezer (Blue Album)" and "Weezer (Green Album)" base-reduce to
    // "weezer" == the artist key, which proves nothing — only exact keys count.
    const owned = new Set<string>()   // builder skips base==artist entries
    const out = filterFeed(
      [card({ type: 'album', artist: 'Weezer', title: 'Weezer (Green Album)' })],
      { ...baseOpts(), ownedBaseKeys: owned },
    )
    assert.equal(out.length, 1)
  })
  test('without ownedBaseKeys behavior is unchanged (back-compat)', () => {
    const out = filterFeed([card({ artist: 'A', title: 'B (Demo)' })], baseOpts())
    assert.equal(out.length, 1)
  })
})

describe('applyQualityFloor', () => {
  const scored = (lane: string, pcts: number[]): FeedCard[] =>
    pcts.map((p, i) => card({ lane, title: `t${i}`, brainPct: p }))

  test(`cards below ${BRAIN_FLOOR} are dropped from a healthy lane`, () => {
    const out = applyQualityFloor(scored('a', [90, 85, 70, 61, 59, 40]))
    assert.deepEqual(out.map((c) => c.brainPct), [90, 85, 70, 61])
  })
  test(`a thin lane back-fills to ${BRAIN_LANE_MIN} with its best ≥${BRAIN_HARD_FLOOR}`, () => {
    const out = applyQualityFloor(scored('a', [88, 57, 55, 53, 40]))
    assert.deepEqual(out.map((c) => c.brainPct).sort((x, y) => (y ?? 0) - (x ?? 0)), [88, 57, 55])
  })
  test('the 40 "no signal" sentinel never ships, even into an empty lane', () => {
    const out = applyQualityFloor(scored('a', [40, 40, 40]))
    assert.equal(out.length, 0)
  })
  test('lanes are floored independently', () => {
    const out = applyQualityFloor([...scored('a', [90, 45]), ...scored('b', [65])])
    assert.deepEqual(out.map((c) => `${c.lane}:${c.brainPct}`), ['a:90', 'b:65'])
  })
})

describe('buildCandidateText — the library voice', () => {
  test('album card carries the album: line and genre, the plain library voice (no sonic desc since 2026-10-10)', () => {
    const text = buildCandidateText({
      artist: 'Can', title: 'Ege Bamyasi', year: '1972', type: 'album',
      genre: 'Krautrock', desc: 'Motorik groove that built the whole genre',
    })
    assert.deepEqual(text.split('\n'), [
      'Can — Ege Bamyasi',
      'album: Ege Bamyasi (1972)',
      'genre: Krautrock',
    ])
  })
  test('song card uses year: line; empty fields add no lines', () => {
    assert.deepEqual(
      buildCandidateText({ artist: 'A', title: 'T', year: '2001', type: 'song' }).split('\n'),
      ['A — T', 'year: 2001'],
    )
    assert.equal(buildCandidateText({ artist: 'A', title: 'T' }), 'A — T')
  })
})

describe('adjustedCosine — rejections push scores down', () => {
  test('a far rejection is a no-op', () => {
    assert.equal(adjustedCosine(0.5, REJECT_MARGIN - 0.01), 0.5)
    assert.equal(adjustedCosine(0.5, 0), 0.5)
  })
  test('penalty scales with proximity past the margin', () => {
    assert.ok(Math.abs(adjustedCosine(0.5, 0.40) - (0.5 - REJECT_WEIGHT * 0.05)) < 1e-9)
  })
  test('sounding like rejected music lands under the quality floor', () => {
    // topK 0.50 would read ~89%; a 0.50-close rejection drags it to ~45%.
    const pct = cosineToPct(adjustedCosine(0.50, 0.50))
    assert.ok(pct < 60, `expected sub-floor, got ${pct}`)
  })
})

describe('discoverVerdicts — the scorer’s view of the ledger', () => {
  const row = (verdict: string, artist: string, title: string, surface = 'discover'): LedgerRow =>
    ({ surface, verdict, key: { artist, title }, ctx: { lane: 'songs', type: 'song' } })

  test('splits accepts and rejects; other surfaces and passes ignored', () => {
    const v = discoverVerdicts([
      row('accept', 'Stereolab', 'Emperor Tomato Ketchup'),
      row('reject', 'Weezer', 'Undone (Kitchen Tape Demo)'),
      row('pass', 'X', 'Y'),
      row('accept', 'Z', 'W', 'strip'),
    ])
    assert.deepEqual(v.accepts.map((a) => a.artist), ['Stereolab'])
    assert.deepEqual(v.rejects.map((r) => r.artist), ['Weezer'])
  })
  test('latest verdict per card wins — a later accept forgives a reject', () => {
    const v = discoverVerdicts([row('reject', 'A', 'T'), row('accept', 'A', 'T')])
    assert.equal(v.rejects.length, 0)
    assert.equal(v.accepts.length, 1)
  })
  test('rows without an artist are dropped', () => {
    const v = discoverVerdicts([{ surface: 'discover', verdict: 'accept', key: { title: 'only' } }])
    assert.equal(v.accepts.length + v.rejects.length, 0)
  })
})

describe('filterFeed — cover factories never get a card, from any lane (2026-09-21)', () => {
  test('Yoyo International Orchestra is dropped; a real band is not', () => {
    const out = filterFeed(
      [
        card({ type: 'album', artist: 'Yoyo International Orchestra', title: 'The Love Songs of the Beatles - Instrumentals Volume 1' }),
        card({ type: 'album', artist: 'Vitamin String Quartet', title: 'VSQ Performs Nirvana' }),
        card({ type: 'album', artist: 'Electric Light Orchestra', title: 'Out of the Blue' }),
      ],
      baseOpts(),
    )
    assert.deepEqual(out.map((c) => c.artist), ['Electric Light Orchestra'])
  })
})

// "Not for me" on a card by an artist Jake owns rests that one card (views 99)
// instead of vetoing the artist. The shop sends its own card id
// (`disc|artist|title`, lowercased — NewForYouView cardId) and main filed the
// rest under it, while filterFeed reads cardKey: the rest was never found and
// the card came back on the next generation (2026-10-18).
describe('filterFeed — a "Not for me" rest on an owned artist lands (2026-10-18)', () => {
  const shopId = (c: { artist: string; title: string }) => `disc|${c.artist}|${c.title}`.toLowerCase()
  const DAY = 24 * 3600 * 1000
  const now = 1_000 * DAY
  const rest = { first: now, last: now, views: 99, vetoed: true as const }
  const heligoland = card({ type: 'album', artist: 'Massive Attack', title: 'Heligoland' })

  test('the shop id itself is not a key filterFeed reads (the bug)', () => {
    const out = filterFeed([heligoland], { ...baseOpts(), now, served: { [shopId(heligoland)]: rest } })
    assert.equal(out.length, 1)
  })

  test('restKeyFor turns the shop id into cardKey, and the rest keeps the card out', () => {
    const k = restKeyFor(heligoland.artist, shopId(heligoland))
    assert.equal(k, cardKey(heligoland))
    assert.equal(k, 'massive attack|heligoland')
    const out = filterFeed([heligoland], { ...baseOpts(), now, served: { [k]: rest } })
    assert.equal(out.length, 0)
  })

  test('punctuation, accents and other scripts come out as the same cardKey', () => {
    for (const c of [
      { artist: 'Diana Ross', title: "I'm Coming Out" },
      { artist: 'andhim', title: "Miles to Go - Soundtrack to andhim's Road Movie" },
      { artist: 'Björk', title: 'Homogenic' },
      { artist: 'Sigur Rós', title: 'Ágætis byrjun' },
      { artist: 'КИНО', title: 'Группа крови' },
      { artist: 'ΟΔΟΣ', title: 'ΣΟΦΙΑ' },
    ]) assert.equal(restKeyFor(c.artist, shopId(c)), cardKey(c), `${c.artist} — ${c.title}`)
  })

  test('a title with a pipe in it still resolves (the artist is known)', () => {
    const c = { artist: 'A', title: 'B | C' }
    assert.equal(restKeyFor(c.artist, shopId(c)), cardKey(c))
  })

  test('an id that is not the shop shape for this artist passes through unchanged', () => {
    assert.equal(restKeyFor('Massive Attack', 'massive attack|heligoland'), 'massive attack|heligoland')
    assert.equal(restKeyFor('Massive Attack', 'disc|portishead|dummy'), 'disc|portishead|dummy')
  })
})

// The veto is for good; rotation keeps its two-week rest (Jake, 2026-10-18).
describe('isResting — a veto is for good, a rotation rest lasts two weeks', () => {
  const DAY = 24 * 3600 * 1000
  const now = 1_000 * DAY

  test('no ledger entry: not resting', () => {
    assert.equal(isResting(undefined, now), false)
  })
  test('a veto holds at any age, whatever its views', () => {
    for (const ageDays of [0, 13, 14, 51, 400]) {
      assert.equal(isResting({ views: 99, last: now - ageDays * DAY, vetoed: true }, now), true, `${ageDays}d`)
    }
    assert.equal(isResting({ views: 0, last: now - 400 * DAY, vetoed: true }, now), true)
  })
  test('rotation: rests from ROTATE_VIEWS views, for ROTATE_REST_MS, then comes back', () => {
    assert.equal(ROTATE_VIEWS, 4)
    assert.equal(ROTATE_REST_MS, 14 * DAY)
    assert.equal(isResting({ views: 3, last: now }, now), false)
    assert.equal(isResting({ views: 4, last: now }, now), true)
    assert.equal(isResting({ views: 4, last: now - 14 * DAY + 1 }, now), true)
    assert.equal(isResting({ views: 4, last: now - 14 * DAY }, now), false)
  })
  test('views 99 without the flag is still only a rotation rest', () => {
    assert.equal(isResting({ views: 99, last: now - 15 * DAY }, now), false)
  })

  test('filterFeed: a vetoed card stays out two months on; a rotation rest has expired', () => {
    const vetoed = card({ type: 'album', artist: 'Massive Attack', title: 'Heligoland' })
    const rotated = card({ type: 'album', artist: 'Geese', title: 'Getting Killed' })
    const out = filterFeed([vetoed, rotated], {
      ...baseOpts(),
      now: now + 60 * DAY,
      served: {
        [cardKey(vetoed)]: { views: 99, last: now, vetoed: true },
        [cardKey(rotated)]: { views: 9, last: now },
      },
    })
    assert.deepEqual(out.map((c) => c.artist), ['Geese'])
  })
})

describe('migrateShopIdRests — the rests already written under the shop id', () => {
  const DAY = 24 * 3600 * 1000
  const now = 1_000 * DAY
  const ledger = () => ({
    // The live ledger's shape on 2026-10-18 (five such keys, all views 99).
    'disc|massive attack|heligoland': { first: now - DAY, last: now - DAY, views: 99 },
    "disc|diana ross|i'm coming out": { first: now - 2 * DAY, last: now - 2 * DAY, views: 99 },
    // Rotation entries for other cards — never touched.
    'geese|getting killed': { first: now - 9 * DAY, last: now - 3 * DAY, views: 4 },
    'wednesday|bleeds': { first: now - 5 * DAY, last: now - 5 * DAY, views: 1 },
  })

  test('moves each disc| rest onto cardKey and drops the old key', () => {
    const out = migrateShopIdRests(ledger())
    assert.deepEqual(Object.keys(out).sort(), [
      'diana ross|i m coming out', 'geese|getting killed', 'massive attack|heligoland', 'wednesday|bleeds',
    ])
    assert.equal(out['massive attack|heligoland'].views, 99)
    assert.equal(out['massive attack|heligoland'].vetoed, true)
    assert.equal(out['diana ross|i m coming out'].vetoed, true)
    assert.equal(hasShopIdRests(out), false)
  })

  test('rotation entries come through byte for byte', () => {
    const before = ledger()
    const out = migrateShopIdRests(before)
    assert.deepEqual(out['geese|getting killed'], before['geese|getting killed'])
    assert.deepEqual(out['wednesday|bleeds'], before['wednesday|bleeds'])
    assert.equal('vetoed' in out['geese|getting killed'], false)
  })

  test('after migration filterFeed keeps the vetoed cards out and the rest in', () => {
    const served = migrateShopIdRests(ledger())
    const out = filterFeed([
      card({ type: 'album', artist: 'Massive Attack', title: 'Heligoland' }),
      card({ type: 'song', artist: 'Diana Ross', title: "I'm Coming Out" }),
      card({ type: 'album', artist: 'Wednesday', title: 'Bleeds' }),
    ], { ...baseOpts(), now, served })
    assert.deepEqual(out.map((c) => c.artist), ['Wednesday'])
  })

  test('the live vetoes were 42-51 days old: migrated, they still keep the cards out', () => {
    const served = migrateShopIdRests({
      'disc|massive attack|heligoland': { first: now - 51 * DAY, last: now - 51 * DAY, views: 99 },
      "disc|diana ross|i'm coming out": { first: now - 42 * DAY, last: now - 42 * DAY, views: 99 },
    })
    const out = filterFeed([
      card({ type: 'album', artist: 'Massive Attack', title: 'Heligoland' }),
      card({ type: 'song', artist: 'Diana Ross', title: "I'm Coming Out" }),
    ], { ...baseOpts(), now, served })
    assert.equal(out.length, 0)
  })

  test('merges with an entry already under cardKey: most views, latest last, earliest first, vetoed', () => {
    const out = migrateShopIdRests({
      'disc|massive attack|heligoland': { first: now - 50 * DAY, last: now - 50 * DAY, views: 99 },
      'massive attack|heligoland': { first: now - 60 * DAY, last: now - DAY, views: 2 },
    })
    assert.deepEqual(out, { 'massive attack|heligoland': { first: now - 60 * DAY, last: now - DAY, views: 99, vetoed: true } })
  })

  test('a key that cannot be split for sure stays where it is — and does not re-trigger', () => {
    const out = migrateShopIdRests({ 'disc|a|b|c': { first: now, last: now, views: 99 } })
    assert.deepEqual(Object.keys(out), ['disc|a|b|c'])
    // Otherwise every generation would rewrite the ledger for nothing.
    assert.equal(hasShopIdRests(out), false)
  })

  test('returns a new ledger and leaves the input alone', () => {
    const before = ledger()
    const snapshot = JSON.parse(JSON.stringify(before))
    const out = migrateShopIdRests(before)
    assert.notEqual(out, before)
    assert.deepEqual(before, snapshot)
  })

  test('hasShopIdRests sees only disc| keys', () => {
    assert.equal(hasShopIdRests(ledger()), true)
    assert.equal(hasShopIdRests({ 'geese|getting killed': {} }), false)
    assert.equal(hasShopIdRests({}), false)
  })
})

describe('WIRING — main writes and reads the rest under cardKey', () => {
  const idx = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf-8')
  const handler = idx.slice(idx.indexOf("ipc.handle('discovery-not-for-me'"), idx.indexOf("ipc.handle('discovery-allow-again'"))

  test('the not-for-me handler files the rest through restKeyFor', () => {
    assert.ok(handler.length > 0, 'discovery-not-for-me handler not found')
    assert.ok(handler.includes('.restKeyFor('), 'the handler no longer turns the shop id into cardKey — owned-artist vetoes go dead again')
    assert.ok(!/served\[String\(cardKey\)\]/.test(handler), 'the handler writes the raw shop id into the served ledger again')
    assert.ok(/served\[restKey\] = \{[^}]*vetoed: true/.test(handler), 'the owned-artist rest is no longer a veto — the card comes back after two weeks')
  })

  test('the radar reads the served ledger through isResting (vetoes hold there too)', () => {
    const radar = idx.slice(idx.indexOf("ipc.handle('get-new-music-radar'"))
    const filter = radar.slice(0, radar.indexOf('brainMatchCandidates'))
    assert.ok(filter.includes('isResting('), 'the radar has its own rest rule again — vetoed cards expire there')
    assert.ok(!/views >= ROTATE_VIEWS/.test(filter), 'the radar re-inlined the rotation check')
  })

  test('feed generation migrates disc| rests before filterFeed reads the ledger', () => {
    const mig = idx.indexOf('.migrateShopIdRests(')
    const filter = idx.indexOf('df.filterFeed(')
    assert.ok(mig > 0, 'feed generation no longer migrates the disc| rests')
    assert.ok(mig < filter, 'the migration must run before filterFeed reads served')
  })
})
