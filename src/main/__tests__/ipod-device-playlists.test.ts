/**
 * The playlists one iPod carries (2026-11-13; one rule for every iPod, no
 * switch, 2026-11-14): the rule, the order, and proof that the database built
 * with them reads back, and that a library playlist an earlier sync wrote is
 * gone after the next one.
 *
 * Jake: "the only playlists each ipod gets are the default and its specific
 * ipod assigned playlists"; "default playlists on top, on the go, then the per
 * ipod playlists in a to z order. same rules as we have for songs, artists
 * albums etc"; 2026-11-14: "I'm still seeing playlists on the punkPod that
 * don't belong. Including a punkPod playlist. Which doesn't make any sense as
 * it contains the entire punk pod library. The playlists only can be specific
 * to its iPod!!! Plus the defaults!!"
 *
 * The round trips at the bottom build a real iTunesDB with core/db_reader.py
 * (the writer every sync uses), run the same id-order pass a sync runs, and
 * read it back with a reader written here from the published iTunesDB layout
 * — not with db_reader's own parser — asserting playlist names, their order
 * and every song in order. When gnupod's tunes2pod.pl is installed (this Mac
 * has it) the same file is also read by gnupod.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BPM_RANGES, DECADE_MIN, NEARLY_ALL, SET_PLAYLIST_ID, bpmPlaylists, bpmRangeIndex, builtinDefaultNames, decadeName,
  decadePlaylists, devicePlaylistSet, deviceKeyOf, stillAnIpodPlaylist, verifiedBpmFrom, type DevicePlaylist, type DeviceTrack,
} from '../../common/ipod-device-playlists.ts'
import { compareIpodArtistNames } from '../ipod-artist-sort.ts'
import { compareNames } from '../../renderer/utils/artistSort.ts'
import { conformCatalogIdOrder } from '../ipod-catalog-order.ts'
import { applyDevicePlaylists, createDevicePlaylists, parseAssigned, ASSIGNED_CACHE_FILE, BPM_CACHE_FILE } from '../ipod-device-playlists-run.ts'
import { LAST_SYNC_PLAYLISTS_FILE, PLANNED_PLAYLISTS_FILE, describePlaylistPlan, promotePlannedPlaylists, readLastSyncPlaylists } from '../ipod-playlist-rule.ts'
import { saveOtgLists, OTG_PLAYLISTS_FILE } from '../ipod-otg-playlists.ts'
import { playlistsLine } from '../../common/ipod-one-sync-plan.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const range = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i)
const songs = (ids: number[], year: number): DeviceTrack[] => ids.map((id) => ({ id, year }))
const names = (ps: DevicePlaylist[]): string[] => ps.map((p) => p.name)
const set = (over: Partial<Parameters<typeof devicePlaylistSet>[0]> & { tracks: DeviceTrack[] }) =>
  devicePlaylistSet({ passed: [], year: 2026, original: false, verifiedBpm: new Map(), onTheGo: [], assigned: [], compareNames: compareIpodArtistNames, ...over })

describe('decade lists', () => {
  test('named the way an iPod named them', () => {
    assert.deepEqual([1960, 1990, 2000, 2010, 2020].map(decadeName), ["60's Music", "90's Music", "2000's Music", "2010's Music", "2020's Music"])
  })
  test('no two decades share a name: the 1920s and the 2020s are both written', () => {
    const all = Array.from({ length: 20 }, (_, i) => 1900 + i * 10)
    assert.equal(new Set(all.map(decadeName)).size, all.length)
    assert.deepEqual([1920, 2020].map(decadeName), ["20's Music", "2020's Music"])
    const t = [...songs(range(12), 1927), ...songs(range(12, 100), 2024), ...songs(range(12, 200), 1955)]
    assert.deepEqual(set({ tracks: t }).playlists.map((p) => [p.name, p.trackIds.length]), [["20's Music", 12], ["50's Music", 12], ["2020's Music", 12]])
  })
  test('a decade needs 10 songs; 9 is not a list', () => {
    assert.equal(DECADE_MIN, 10)
    assert.equal(NEARLY_ALL, 0.9)
    const t = [...songs(range(9), 1985), ...songs(range(10, 100), 1994), ...songs([900, 901], 0)]
    assert.deepEqual(names(decadePlaylists(t)), ["90's Music"])
    assert.deepEqual(decadePlaylists(t)[0].trackIds, range(10, 100))
    // The floor holds in the set an iPod actually gets, too.
    assert.deepEqual(names(set({ tracks: [...songs(range(9), 1985), ...songs(range(10, 100), 1994), ...songs(range(10, 200), 2004)] }).playlists), ["90's Music", "2000's Music"])
  })
  test('oldest decade first; a missing or silly year is in no decade', () => {
    const t = [...songs(range(10, 1), 2003), ...songs(range(10, 20), 1979), { id: 99, year: 'n/a' }, { id: 98, year: 3 }]
    assert.deepEqual(names(decadePlaylists(t)), ["70's Music", "2000's Music"])
  })
})

describe('BPM lists', () => {
  test('the six ranges, edges included once', () => {
    assert.deepEqual(BPM_RANGES.map((r) => r.name), ['BPM 060-089', 'BPM 090-109', 'BPM 110-129', 'BPM 130-149', 'BPM 150-169', 'BPM 170+'])
    assert.deepEqual([59.9, 60, 89.9, 90, 109.9, 110, 130, 150, 169.9, 170, 216].map(bpmRangeIndex), [null, 0, 0, 1, 1, 2, 3, 4, 4, 5, 5])
    assert.equal(bpmRangeIndex(NaN), null)
  })
  test('only confirmed songs, each in one list, slowest first, empty ranges not written', () => {
    const t = songs([1, 2, 3, 4, 5], 2000)
    const bpm = new Map([[1, 108], [2, 92.5], [3, 177.3], [5, 55]])   // 4 is unconfirmed, 5 is under 60
    const ps = bpmPlaylists(t, bpm)
    assert.deepEqual(ps.map((p) => [p.name, p.trackIds]), [['BPM 090-109', [2, 1]], ['BPM 170+', [3]]])
  })
  test('homemini’s record: verified and resolved count, unverified never does', () => {
    const m = verifiedBpmFrom({
      '1': { bpm: 108, bpmStatus: 'verified' }, '2': { bpm: 177.1, bpmStatus: 'resolved' },
      '3': { bpm: null, bpmStatus: 'unverified', candidates: [88, 176] }, '4': { bpm: 120, bpmStatus: 'unverified' },
      'x': { bpm: 100, bpmStatus: 'verified' }, '5': { bpm: '120', bpmStatus: 'verified' },
    })
    assert.deepEqual([...m.entries()], [[1, 108], [2, 177.1]])
  })
})

describe('what one iPod gets', () => {
  const tracks = [...songs(range(60), 1994), ...songs(range(40, 61), 2004)]   // 100 songs
  const passed = [
    { id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(100) },
    { id: 'pl-1', name: 'Office Musick', trackIds: [1, 2, 3] },
    { id: 'pl-2', name: 'Justification II', trackIds: [4] },
    { id: 'smart-recently-added', name: 'Recently Added', trackIds: [100, 99, 98] },
    { id: 'smart-top', name: 'Top 25 Most Played', trackIds: [7, 8, 5000] },
    { id: 'smart-starred', name: 'Starred', trackIds: [] },
    { id: 'smart-rp', name: 'Recently Played', trackIds: range(95) },
    { id: 'smart-boy', name: 'Best of 2026', trackIds: [9] },
    { id: 'old', name: 'Best of 2019', trackIds: [9] },
  ]

  test('the library’s own playlists are not written; the log is told which', () => {
    const r = set({ tracks, passed })
    assert.deepEqual(r.removed, ['Office Musick', 'Justification II', 'Best of 2019'])
    for (const n of r.removed) assert.equal(names(r.playlists).includes(n), false)
  })
  test('defaults in one fixed order; empty and nearly-the-whole-iPod ones are left off', () => {
    const r = set({ tracks, passed, verifiedBpm: new Map([[1, 100], [2, 140]]) })
    assert.deepEqual(names(r.playlists), [
      'Top 25 Most Played', 'Recently Added', 'Best of 2026', "90's Music", "2000's Music", 'BPM 090-109', 'BPM 130-149',
    ])
    // Starred was empty; Recently Played was 95 of 100 (the 90% line).
    assert.deepEqual(r.playlists[0].trackIds, [7, 8], 'a song not on the iPod is never referenced')
  })
  test('a one-decade iPod gets no decade list', () => {
    assert.deepEqual(names(set({ tracks: songs(range(50), 1991) }).playlists), [])
  })
  test('the built-in names are the ones the app evaluates', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/utils/smartPlaylists.ts'), 'utf-8')
    for (const n of builtinDefaultNames(2026).slice(0, 4)) assert.ok(src.includes(`name: '${n}'`), `${n} is a built-in smart playlist`)
    assert.ok(src.includes('`Best of ${BEST_OF_YEAR}`'))
    assert.ok(readFileSync(join(ROOT, 'src/renderer/utils/workoutIpodSync.ts'), 'utf-8').includes(`id: '${SET_PLAYLIST_ID}'`))
  })
})

describe('order: defaults, On-The-Go, then the rest A to Z', () => {
  // "The", digits, punctuation, accents, case — the fixture the sort twins must agree on.
  const mixed = ['The Zebras', 'apple pie', '10 Fast Ones', '2 Slow Ones', '"Weird" Mix', 'Élan', 'eagle', '...And More', 'A Night Out', 'the ANTS', 'Zed', '¡Hola!']
  const want = ['2 Slow Ones', '10 Fast Ones', '...And More', 'the ANTS', 'apple pie', 'eagle', 'Élan', '¡Hola!', 'A Night Out', '"Weird" Mix', 'The Zebras', 'Zed']

  test('the main-process sort and the app’s compareNames are one rule', () => {
    assert.deepEqual([...mixed].sort(compareNames), want)
    assert.deepEqual([...mixed].sort((a, b) => compareIpodArtistNames(a, b)), want)
  })
  test('on the iPod: defaults, then On-The-Go by number, then everything else A to Z', () => {
    const tracks = [...songs(range(30), 1994), ...songs(range(30, 31), 2004)]
    const r = set({
      tracks,
      passed: [{ id: SET_PLAYLIST_ID, name: 'Y2K', trackIds: range(60) }, { id: 's', name: 'Starred', trackIds: [1, 2] }],
      onTheGo: [{ id: 'otg-a-1', name: 'On-The-Go 1', trackIds: [5, 4] }, { id: 'otg-b-1', name: 'On-The-Go 2', trackIds: [6] }],
      assigned: mixed.map((name, i) => ({ id: `p${i}`, name, trackIds: [i + 1] })),
    })
    assert.deepEqual(names(r.playlists), ['Starred', "90's Music", "2000's Music", 'On-The-Go 1', 'On-The-Go 2', ...want])
  })
  test('an assigned playlist keeps his order and is never cut for being most of the iPod', () => {
    const r = set({ tracks: songs(range(10), 1990), assigned: [{ id: 'mine', name: 'Mine', trackIds: [9, 1, 9, 77, 3, ...range(10)] }] })
    assert.deepEqual(r.playlists.map((p) => [p.name, p.trackIds]), [['Mine', [9, 1, 3, 2, 4, 5, 6, 7, 8, 10]]])
  })
  test('an assigned or On-The-Go playlist with none of its songs on this iPod is never written', () => {
    const r = set({
      tracks: songs(range(20), 1990),
      onTheGo: [{ id: 'otg-x', name: 'On-The-Go 1', trackIds: [500, 501] }, { id: 'otg-y', name: 'On-The-Go 2', trackIds: [] }],
      assigned: [{ id: 'a', name: 'Empty', trackIds: [] }, { id: 'b', name: 'Elsewhere', trackIds: [900] }, { id: 'c', name: 'Here', trackIds: [900, 3] }],
    })
    assert.deepEqual(r.playlists.map((p) => [p.name, p.trackIds]), [['Here', [3]]])
  })
  test('two playlists can’t share a name on the iPod; the first one stands', () => {
    const r = set({ tracks: songs(range(20), 1990), passed: [{ id: 's', name: 'Starred', trackIds: [1] }], assigned: [{ id: 'x', name: 'starred', trackIds: [2] }] })
    assert.deepEqual(names(r.playlists), ['Starred'])
  })
})

// ── the one rule, on every iPod, with no switch (2026-11-14) ─────────────────

describe('every iPod: the defaults, its own, On-The-Go, and nothing else', () => {
  // What the sync really handed punkPod on 2026-11-14 (its last-sync record), cut down:
  // its own list as a playlist, the library's playlists, an old curly-quote "90’s Music".
  const punk = [...songs(range(30), 1994), ...songs(range(30, 31), 2004)]   // 60 songs
  const punkPassed = [
    { id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(60) },
    { id: 'smart-ra', name: 'Recently Added', trackIds: range(20) },
    { id: 'pl-1', name: 'Office Musick', trackIds: [1, 2, 3, 9000] },
    { id: 'pl-2', name: '90’s Music', trackIds: [4] },
    { id: 'pl-3', name: 'Rocksurgence', trackIds: range(30) },
    { id: 'smart-starred', name: 'Starred', trackIds: range(55) },             // 92% of the iPod: just Songs again
    { id: 'pl-4', name: 'Justification II', trackIds: [5] },
  ]
  const punkOwn = {
    verifiedBpm: new Map([[1, 100]]),
    onTheGo: [{ id: 'otg-1', name: 'On-The-Go 1', trackIds: [2, 1] }],
    assigned: [{ id: 'j', name: 'Skate Night', trackIds: [7] }, { id: 'k', name: 'Ska Mornings', trackIds: [8, 9] }],
  }

  test('punkPod: no "punkPod" playlist, no library playlists; defaults, then On-The-Go, then its own A to Z', () => {
    const r = set({ tracks: punk, passed: punkPassed, original: false, ...punkOwn })
    assert.deepEqual(names(r.playlists), ['Recently Added', "90's Music", "2000's Music", 'BPM 090-109', 'On-The-Go 1', 'Ska Mornings', 'Skate Night'])
    assert.equal(r.playlists.some((p) => p.kind === 'set' || p.name === 'punkPod'), false, 'its own list is just Songs')
    assert.deepEqual(r.removed, ['Office Musick', '90’s Music', 'Rocksurgence', 'Justification II'])
    // Every playlist written is one of the three kinds the rule allows.
    assert.deepEqual([...new Set(r.playlists.map((p) => p.kind))], ['default', 'on-the-go', 'assigned'])
  })
  test('the Original keeps "Top 1000", first, in rank order (not id order), whole', () => {
    const ranked = [...range(50, 51), ...range(50)]   // rank order: 51..100, then 1..50
    const top = songs(range(100), 1994).map((t) => ({ ...t, year: t.id <= 50 ? 1985 : 2005 }))
    const r = set({
      tracks: top, original: true,
      passed: [
        { id: SET_PLAYLIST_ID, name: 'Top 1000', trackIds: ranked },
        { id: 'smart-starred', name: 'Starred', trackIds: range(99) },   // 99%: left off, as on the real Original
        { id: 'smart-top', name: 'Top 25 Most Played', trackIds: range(25) },
        { id: 'pl-1', name: 'Office Musick', trackIds: range(40) },
        { id: 'pl-2', name: 'Greenpoint Greatest Hits', trackIds: range(35) },
      ],
      onTheGo: [{ id: 'otg-1', name: 'On-The-Go 1', trackIds: [66] }],
    })
    assert.deepEqual(names(r.playlists), ['Top 1000', 'Top 25 Most Played', "80's Music", "2000's Music", 'On-The-Go 1'])
    assert.deepEqual(r.playlists[0].trackIds, ranked, 'the order is the point')
    assert.equal(r.playlists[0].kind, 'set')
    assert.deepEqual(r.removed, ['Office Musick', 'Greenpoint Greatest Hits'])
  })
  test('only the Original’s own list is ever a playlist, whatever an iPod is called', () => {
    for (const name of ['Top 1000', 'punkPod', 'Y2K']) {
      const p = [{ id: SET_PLAYLIST_ID, name, trackIds: range(20) }]
      assert.deepEqual(names(set({ tracks: songs(range(20), 1990), passed: p, original: false }).playlists), [], name)
      assert.deepEqual(names(set({ tracks: songs(range(20), 1990), passed: p, original: true }).playlists), [name], name)
    }
  })
  test('the 90% line holds for every default: built-ins, decades and BPM alike', () => {
    const t = [...songs(range(91), 1994), ...songs(range(9, 100), 2004)]   // 100 songs, 91 from the 90s
    const r = set({
      tracks: t,
      passed: ['Top 25 Most Played', 'Starred', 'Recently Added', 'Recently Played', 'Best of 2026'].map((name, i) => ({ id: `s${i}`, name, trackIds: i % 2 ? range(90) : range(89) })),
      verifiedBpm: new Map(range(100).map((id) => [id, id <= 95 ? 120 : 100] as [number, number])),
    })
    // 89 of 100 stay; 90 of 100, the 90s decade (91) and BPM 110-129 (91) are just Songs again.
    assert.deepEqual(names(r.playlists), ['Top 25 Most Played', 'Recently Added', 'Best of 2026', 'BPM 090-109'])
  })
  test('nothing in the app reads or writes a per-iPod switch any more', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : /\.(ts|tsx|py|mjs)$/.test(e.name) ? [join(dir, e.name)] : [])
    const mentions = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'core'))]
      .filter((f) => /PLAYLIST_RULE_FILE|onlyOwnPlaylists|playlistRuleApplies|\bonlyOwn\b|wouldRemove/.test(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(ROOT.length + 1))
    assert.deepEqual(mentions, [])
  })
  test('an old switch file left in an iPod’s folder changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-rule-old-'))
    writeFileSync(join(dir, 'ipod-playlists-rule.json'), JSON.stringify({ onlyOwnPlaylists: false }))
    const offline = { baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => { throw new Error('offline') } }
    const r = await createDevicePlaylists(offline).forSync({ passed: punkPassed, tracks: punk, stateDir: dir, deviceKey: 'dev-1', ipodName: 'punkPod', original: false })
    assert.equal(names(r.playlists).some((n) => n === 'punkPod' || r.removed.includes(n)), false)
  })
  test('the log line says what is written and which library playlists are left off', () => {
    const r = set({ tracks: punk, passed: punkPassed, ...punkOwn })
    const line = describePlaylistPlan('punkPod', { ...r, notes: ['homemini didn’t answer.'] })
    assert.match(line, /^punkPod gets 7 playlist\(s\): Recently Added \(20\), 90's Music \(30\)/)
    assert.match(line, /Library playlists left off \(only this iPod's own are written\): Office Musick, 90’s Music, Rocksurgence, Justification II\./)
    assert.match(line, /homemini didn’t answer\.$/)
  })
  test('a record from before the rule: its library playlists and another iPod’s own list are never written again', () => {
    assert.equal(stillAnIpodPlaylist({ kind: 'library', id: 'pl-1' }, true), false)
    assert.equal(stillAnIpodPlaylist({ kind: 'set', id: SET_PLAYLIST_ID }, false), false)
    assert.equal(stillAnIpodPlaylist({ kind: 'set', id: SET_PLAYLIST_ID }, true), true)
    assert.equal(stillAnIpodPlaylist({ kind: undefined, id: 'x' }, true), false)
    for (const kind of ['default', 'on-the-go', 'assigned']) assert.equal(stillAnIpodPlaylist({ kind, id: 'x' }, false), true, kind)
  })
})

describe('every sync goes through the rule, and a failure stops it', () => {
  const device = { id: 'dev-1', name: 'punkPod', primary: false }
  const passed = [{ id: 'lib', name: 'Bops', trackIds: [1] }]
  const never = async (): Promise<never> => { throw new Error('must not be asked') }
  const base = { device, passed, tracks: [{ id: 1 }], stateDir: '/nowhere', deviceKey: 'dev-1' }

  test('no iPod identified: refused, never the playlists handed in', async () => {
    const r = await applyDevicePlaylists({ ...base, device: null, forSync: never })
    assert.equal(r.ok, false)
  })
  test('the iPod’s kind reaches the rule: the Original keeps Top 1000, any other doesn’t', async () => {
    const seen: boolean[] = []
    const spy = async (i: { original: boolean }) => { seen.push(i.original); return { playlists: [], removed: [], notes: [] } }
    await applyDevicePlaylists({ ...base, forSync: spy, log: () => {} })
    await applyDevicePlaylists({ ...base, device: { ...device, primary: true }, forSync: spy, log: () => {} })
    assert.deepEqual(seen, [false, true])
  })
  test('a failure putting the playlists together STOPS the sync: ok false, in plain words', async () => {
    const r = await applyDevicePlaylists({ ...base, forSync: async () => { throw new Error('the saved lists are damaged') }, log: () => {} })
    assert.deepEqual(r, { ok: false, error: 'This iPod’s playlists couldn’t be put together (the saved lists are damaged). Nothing on the iPod was changed.' })
  })
  test('the engine: plays gate (On-The-Go saved) → playlists → stop on failure → the sync, for every origin', () => {
    const engine = readFileSync(join(ROOT, 'src/main/sync-engine/index.ts'), 'utf-8')
    const call = engine.indexOf('const own = await applyDevicePlaylists({')
    const stop = engine.indexOf('if (!own.ok) {', call)
    const refuse = engine.indexOf('return { ok: false, copied: 0, error: own.error }', stop)
    const noMount = engine.indexOf("const error = 'No verified iPod mount detected'", refuse)
    const activity = engine.indexOf('return runActivitySync({', call)
    const full = engine.indexOf('if (syncOpts?.wipeFirst) {', call)
    const gate = engine.indexOf('securePlaysBeforeSync(gateMount')
    assert.ok(gate > 0 && gate < call && call < stop && stop < refuse && refuse < noMount && noMount < activity && activity < full,
      'plays gate → playlists → stop on failure → no mount refused → the activity sync → the whole-library sync')
    assert.equal(/origin/.test(engine.slice(call, stop)), false, 'no origin decides whether the rule applies')
    assert.equal([...engine.matchAll(/host\.devicePlaylists/g)].length, 1, 'the engine never asks for the set any other way')
    assert.equal([...engine.matchAll(/devicePlaylistSet|forSync\(/g)].length, 0)
  })
  test('the engine USES the set it asked for: it is what both syncs are handed, and nothing swaps it back', () => {
    const engine = readFileSync(join(ROOT, 'src/main/sync-engine/index.ts'), 'utf-8')
    const refuse = engine.indexOf('return { ok: false, copied: 0, error: own.error }')
    const run = engine.indexOf('return runActivitySync({', refuse)
    const between = engine.slice(refuse, run)
    assert.match(between, /\n {6}playlists = own\.playlists\n/, 'the set replaces what was handed in')
    assert.equal([...between.matchAll(/\bplaylists\s*=[^=]/g)].length, 1, 'and is assigned exactly once before the sync runs')
    const handed = engine.slice(run, engine.indexOf('if (syncOpts?.wipeFirst)', run))
    assert.match(handed, /\}, \{ tracks, playlists, convertOptions, listOnly: listOnlyIpod, ipodName \}\)/, 'the activity sync is handed that same variable')
    const fullWrite = engine.slice(engine.indexOf('if (syncOpts?.wipeFirst)', run))
    assert.equal([...fullWrite.matchAll(/\bplaylists\s*=[^=]/g)].length, 0, 'the whole-library sync never reassigns it')
    assert.match(fullWrite, /JSON\.stringify\(\{ tracks, playlists, masterName: ipodName \}\)/, 'and writes that same variable')
  })
  test('the record is promoted only by a sync that came back ok', () => {
    const engine = readFileSync(join(ROOT, 'src/main/sync-engine/index.ts'), 'utf-8')
    const ok = engine.indexOf('if ((result as { ok?: boolean })?.ok) {')
    const promote = engine.indexOf('if (playlistsPlanned) await promotePlannedPlaylists(syncStateDir)', ok)
    const otherwise = engine.indexOf('} else {', ok)
    assert.ok(ok > 0 && promote > ok && promote < otherwise, 'inside the ok branch')
    assert.equal([...engine.matchAll(/promotePlannedPlaylists\(/g)].length, 1)
    assert.match(engine, /playlistsPlanned = false\n\s+const result = await runSyncToIpod\(/)
    assert.match(engine, /playlists = own\.playlists\n\s+playlistsPlanned = true\n/)
    const run = readFileSync(join(ROOT, 'src/main/ipod-device-playlists-run.ts'), 'utf-8')
    assert.equal(/writeLastSyncPlaylists|LAST_SYNC_PLAYLISTS_FILE/.test(run), false, 'putting the set together never writes the last-sync record')
  })
  test('the delete mirror rewrites the database with this iPod’s own playlists, never the library’s', () => {
    const main = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf-8')
    const at = main.indexOf("[scriptPath, '--write', ipodDb]")
    assert.ok(at > 0)
    const block = main.slice(main.lastIndexOf('function scheduleDbRebuild', at), main.indexOf('[delete-sync] removed', at))
    assert.equal(/lib\.playlists/.test(block), false, 'the library’s playlists are not handed to the writer')
    assert.match(block, /readLastSyncPlaylists\(ipod\.stateDir\)/)
    assert.match(block, /filter\(\(p\) => stillAnIpodPlaylist\(p, !!ipod\.device\?\.primary\)\)/)
    assert.match(block, /playlists: keepPlaylists/)
  })
  test('the Original’s playlists are kept under top1000, any other iPod’s under its id', () => {
    assert.equal(deviceKeyOf({ id: 'abc', primary: true }), 'top1000')
    assert.equal(deviceKeyOf({ id: 'abc', primary: false }), 'abc')
  })
})

// ── gathering: homemini, the kept copies, On-The-Go ───────────────────────

describe('gathering an iPod’s playlists for a sync', () => {
  const tracks = range(30).map((id) => ({ id, year: id <= 15 ? 1994 : 2004 }))
  const passed = [{ id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(30) }, { id: 'lib', name: 'Bops', trackIds: [1] }]
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body })
  const ask = (dir: string, original = false) => ({ passed, tracks, stateDir: dir, deviceKey: original ? 'top1000' : 'dev-1', ipodName: original ? 'Original' : 'punkPod', original })
  const offline = { baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => { throw new Error('offline') } }
  const home = (assigned: unknown[]) => ({
    baseUrl: 'http://hub', warn: () => {},
    fetchImpl: async (url: string, init?: Record<string, unknown>) => {
      if (url.includes('/api/bpm-key')) return reply(200, { tracks: { '1': { bpm: 100, bpmStatus: 'verified' }, '2': { bpm: 180, bpmStatus: 'unverified' } } })
      if ((init as { method?: string })?.method === 'PUT') return reply(200, { ok: true })
      return reply(200, { playlists: assigned })
    },
  })
  const SKATE = { id: 'jake-1', name: 'Skate Night', source: 'jake', trackIds: [9, 8, 400] }

  test('BPM lists, his playlists, On-The-Go read back and saved; On-The-Go is sent up once; nothing of the library', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    await saveOtgLists(dir, { snapshot: 'a'.repeat(40), lists: [{ trackIds: [3, 2] }], ipodName: 'punkPod', deviceKey: 'dev-1' })
    const calls: string[] = []
    const h = home([SKATE])
    const run = createDevicePlaylists({ ...h, fetchImpl: async (url, init) => { calls.push(`${String((init as { method?: string }).method)} ${url.replace('http://hub', '')}`); return h.fetchImpl(url, init) } })
    const r = await run.forSync(ask(dir))
    assert.deepEqual(r.playlists.map((p) => [p.name, p.trackIds.length]), [
      ["90's Music", 15], ["2000's Music", 15], ['BPM 090-109', 1], ['On-The-Go 1', 2], ['Skate Night', 2],
    ])
    assert.deepEqual(r.removed, ['Bops'])
    assert.ok(calls.some((c) => /^PUT \/api\/ipod-playlists\/dev-1\/otg-[0-9a-f]{16}$/.test(c)), calls.join('\n'))
    assert.ok(existsSync(join(dir, BPM_CACHE_FILE)) && existsSync(join(dir, ASSIGNED_CACHE_FILE)) && existsSync(join(dir, PLANNED_PLAYLISTS_FILE)))
    const rec = JSON.parse(readFileSync(join(dir, PLANNED_PLAYLISTS_FILE), 'utf-8'))
    assert.deepEqual([rec?.ipod, rec?.removed, rec?.playlists?.length], ['punkPod', ['Bops'], 5])
  })
  test('the Original: Top 1000 first, then the same defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    const r = await createDevicePlaylists(home([])).forSync({ ...ask(dir, true), passed: [{ id: SET_PLAYLIST_ID, name: 'Top 1000', trackIds: [...range(30)].reverse() }, ...passed.slice(1)] })
    assert.deepEqual(names(r.playlists), ['Top 1000', "90's Music", "2000's Music", 'BPM 090-109'])
    assert.deepEqual(r.playlists[0].trackIds, [...range(30)].reverse())
  })
  test('homemini away: the copies kept from last time are used, and it says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    writeFileSync(join(dir, BPM_CACHE_FILE), JSON.stringify({ bpm: { '4': 150 } }))
    writeFileSync(join(dir, ASSIGNED_CACHE_FILE), JSON.stringify({ playlists: [{ id: 'jake-1', name: 'Skate Night', trackIds: [9] }] }))
    const r = await createDevicePlaylists(offline).forSync(ask(dir))
    assert.deepEqual(names(r.playlists), ["90's Music", "2000's Music", 'BPM 150-169', 'Skate Night'])
    assert.equal(r.notes.length, 2)
    assert.match(r.notes.join(' '), /the copy kept from last time was used/)
  })
  test('unknown is not empty: away with NO kept copy, the playlists the last sync wrote stay on the iPod', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    const first = await createDevicePlaylists(home([SKATE, { id: 'jake-2', name: 'Apple Pie', source: 'jake', trackIds: [5] }])).forSync(ask(dir))
    const wrote = names(first.playlists)
    assert.deepEqual(wrote, ["90's Music", "2000's Music", 'BPM 090-109', 'Apple Pie', 'Skate Night'])
    assert.equal(await promotePlannedPlaylists(dir), true)   // that sync verified and sealed
    // The kept copies are gone (a cleared cache, a failed write) and homemini can't be reached.
    for (const f of [BPM_CACHE_FILE, ASSIGNED_CACHE_FILE]) writeFileSync(join(dir, f), 'gone')
    const away = await createDevicePlaylists(offline).forSync(ask(dir))
    assert.deepEqual(names(away.playlists), wrote, 'nothing came off the iPod because a list couldn’t be read')
    assert.match(away.notes.join(' '), /so the 2 assigned playlist\(s\) the last sync wrote are written again/)
    assert.match(away.notes.join(' '), /so the 1 BPM playlist\(s\) the last sync wrote are written again/)
    assert.equal(await promotePlannedPlaylists(dir), true)
    assert.deepEqual(names((await createDevicePlaylists(offline).forSync(ask(dir))).playlists), wrote)
  })
  test('a last-sync record from before the rule (library playlists, "punkPod") never brings them back, even with homemini away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    // The shape of punkPod's real record of 2026-11-14.
    writeFileSync(join(dir, LAST_SYNC_PLAYLISTS_FILE), JSON.stringify({
      version: 1, at: '2026-11-14T19:16:23.508Z', ipod: 'punkPod', onlyOwnPlaylists: false, added: [], removed: [], wouldRemove: ['Bops'], notes: [],
      playlists: [
        { id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(30), kind: 'set' },
        { id: 'lib-1', name: 'Rocksurgence', trackIds: [1, 2], kind: 'library' },
        { id: 'default-bpm-170', name: 'BPM 170+', trackIds: [3], kind: 'default' },
        { id: 'lib-2', name: 'Office Musick', trackIds: [4], kind: 'library' },
      ],
    }))
    const r = await createDevicePlaylists(offline).forSync(ask(dir))
    assert.deepEqual(names(r.playlists), ["90's Music", "2000's Music", 'BPM 170+'])
  })
  test('the record of "what the last sync wrote" is only ever a sync that finished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    await createDevicePlaylists(home([SKATE])).forSync(ask(dir))
    assert.equal(existsSync(join(dir, LAST_SYNC_PLAYLISTS_FILE)), false, 'putting the set together is not a finished sync')
    assert.equal(await promotePlannedPlaylists(dir), true)
    assert.equal(existsSync(join(dir, PLANNED_PLAYLISTS_FILE)), false)
    await createDevicePlaylists(home([SKATE, { id: 'jake-2', name: 'Apple Pie', source: 'jake', trackIds: [5] }])).forSync(ask(dir))
    const rec = await readLastSyncPlaylists(dir)
    assert.equal(rec!.playlists.some((p) => p.name === 'Apple Pie'), false, 'the plan of a sync that never ran is not on the record')
    for (const f of [BPM_CACHE_FILE, ASSIGNED_CACHE_FILE]) writeFileSync(join(dir, f), 'gone')
    const away = await createDevicePlaylists(offline).forSync(ask(dir))
    assert.deepEqual(names(away.playlists).filter((n) => n === 'Apple Pie' || n === 'Skate Night'), ['Skate Night'])
    assert.equal(await promotePlannedPlaylists(mkdtempSync(join(tmpdir(), 'ipod-none-'))), false, 'no plan, nothing to promote')
  })
  test('an empty answer from homemini IS empty: a playlist Jake deleted comes off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    await createDevicePlaylists(home([SKATE])).forSync(ask(dir))
    const r = await createDevicePlaylists(home([])).forSync(ask(dir))
    assert.equal(names(r.playlists).includes('Skate Night'), false)
  })
  test('an iPod that never had any, and homemini without the route: defaults only, and it says none were written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    const r = await createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => reply(404, null) }).forSync(ask(dir))
    assert.deepEqual(names(r.playlists), ["90's Music", "2000's Music"])
    assert.match(r.notes.join(' '), /homemini answered 404 for this iPod’s playlists, and this Mac has no record of any from an earlier sync, so none are written this time/)
  })
  test('damaged saved On-The-Go lists: moved aside, the sync goes on, the record says where the file went', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    writeFileSync(join(dir, OTG_PLAYLISTS_FILE), 'not json')
    const r = await createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => reply(404, null) }).forSync(ask(dir))
    assert.match(r.notes[0], /unreadable\. It was moved aside, whole, to .*\.corrupt-/)
    assert.equal(readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1)
    assert.match(JSON.parse(readFileSync(join(dir, PLANNED_PLAYLISTS_FILE), 'utf-8')).notes[0], /moved aside/)
  })
  test('a body that isn’t playlists is not playlists', () => {
    assert.equal(parseAssigned({ nope: 1 }), null)
    assert.deepEqual(parseAssigned({ playlists: [{ id: 1, name: 'x', trackIds: [] }, { id: 'a', name: 'A', trackIds: [1, 'x', 2] }] }), [{ id: 'a', name: 'A', trackIds: [1, 2] }])
  })
})

describe('the plan shows what the next sync writes', () => {
  const tracks = range(30).map((id) => ({ id, year: id <= 15 ? 1994 : 2004 }))
  const passed = [{ id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(30) }, { id: 'lib', name: 'Bops', trackIds: [1] }]
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body })

  test('the preview is the very set a sync writes, and writes nothing: no file, no kept copy, nothing sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-preview-'))
    await saveOtgLists(dir, { snapshot: 'b'.repeat(40), lists: [{ trackIds: [4, 5] }], ipodName: 'punkPod', deviceKey: 'dev-1' })
    const before = readdirSync(dir).sort()
    const methods: string[] = []
    const deps = {
      baseUrl: 'http://hub', warn: () => {},
      fetchImpl: async (url: string, init?: Record<string, unknown>) => {
        methods.push(String((init as { method?: string }).method))
        if (url.includes('/api/bpm-key')) return reply(200, { tracks: { '1': { bpm: 100, bpmStatus: 'verified' } } })
        return reply(200, { playlists: [{ id: 'j', name: 'Skate Night', trackIds: [9] }] })
      },
    }
    const input = { passed, tracks, stateDir: dir, deviceKey: 'dev-1', ipodName: 'punkPod', original: false }
    const p = await createDevicePlaylists(deps).preview(input)
    assert.deepEqual(readdirSync(dir).sort(), before, 'the folder is exactly as it was')
    assert.deepEqual([...new Set(methods)], ['GET'], 'only asked, never sent')
    assert.deepEqual(names(p.playlists), ["90's Music", "2000's Music", 'BPM 090-109', 'On-The-Go 1', 'Skate Night'])
    const s = await createDevicePlaylists(deps).forSync(input)
    assert.deepEqual(names(s.playlists), names(p.playlists), 'the sync writes what the plan showed')
  })
  test('a damaged On-The-Go file is left for the sync to repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-preview-'))
    writeFileSync(join(dir, OTG_PLAYLISTS_FILE), 'not json')
    await createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => reply(404, null) })
      .preview({ passed, tracks, stateDir: dir, deviceKey: 'dev-1', ipodName: 'punkPod', original: false })
    assert.deepEqual(readdirSync(dir), [OTG_PLAYLISTS_FILE])
    assert.equal(readFileSync(join(dir, OTG_PLAYLISTS_FILE), 'utf-8'), 'not json')
  })
  test('the plan carries the list; its line reads in the iPod’s order', () => {
    const plan = { ok: true as const, kind: 'list' as const, ipodName: 'punkPod', color: null, setName: 'punkPod', trackIds: [1], leftOff: [], note: null }
    assert.equal(playlistsLine(plan), null, 'unknown is not "none"')
    assert.equal(playlistsLine({ ...plan, playlists: [] }), 'No playlists, just Songs')
    assert.equal(playlistsLine({ ...plan, playlists: ['Top 25 Most Played', "90's Music", 'On-The-Go 1', 'Skate Night'] }), "Playlists: Top 25 Most Played, 90's Music, On-The-Go 1, Skate Night")
  })
  test('the renderer asks for it with the built-ins only, never the library’s playlists, and DeviceView is untouched by it', () => {
    const util = readFileSync(join(ROOT, 'src/renderer/utils/workoutIpodSync.ts'), 'utf-8')
    assert.match(util, /assembleSyncPlaylists\(rows, \[\], plan\.setName\)/)
    assert.equal(/previewIpodPlaylists/.test(readFileSync(join(ROOT, 'src/renderer/views/DeviceView.tsx'), 'utf-8')), false)
  })
})

// ── the database reads back ───────────────────────────────────────────────

/**
 * An iTunesDB reader written from the published layout (the iPodLinux wiki's
 * "ITunesDB" page, the one libgpod was written from). It walks every record
 * by its own stated lengths and shares no code with core/db_reader.py.
 *   mhbd: header length @4, children @20        mhsd: header @4, total @8, type @12
 *   mhlt/mhlp: header @4, count @8              mhit: header @4, total @8, mhods @12, id @16
 *   mhyp: header @4, total @8, mhods @12, items @16, master flag @20
 *   mhip: header @4, total @8, track id @24     mhod (string): total @8, type @12, length @28, text @40
 */
function readItunesDb(buf: Buffer): { titleById: Map<number, string>; trackOrder: number[]; playlists: Array<{ name: string; master: boolean; ids: number[] }> } {
  const tag = (p: number): string => buf.toString('latin1', p, p + 4)
  const u32 = (p: number): number => buf.readUInt32LE(p)
  const stringMhod = (p: number): { type: number; text: string } => ({ type: u32(p + 12), text: buf.toString('utf16le', p + 40, p + 40 + u32(p + 28)) })
  assert.equal(tag(0), 'mhbd')
  const titleById = new Map<number, string>()
  const trackOrder: number[] = []
  const playlists: Array<{ name: string; master: boolean; ids: number[] }> = []
  let pos = u32(4)
  for (let s = 0; s < u32(20); s++) {
    assert.equal(tag(pos), 'mhsd', `dataset ${s}`)
    const type = u32(pos + 12)
    const list = pos + u32(pos + 4)
    if (type === 1) {
      assert.equal(tag(list), 'mhlt')
      let p = list + u32(list + 4)
      for (let i = 0; i < u32(list + 8); i++) {
        assert.equal(tag(p), 'mhit', `track ${i}`)
        const id = u32(p + 16)
        let m = p + u32(p + 4)
        for (let k = 0; k < u32(p + 12); k++) {
          assert.equal(tag(m), 'mhod')
          const sm = stringMhod(m)
          if (sm.type === 1) titleById.set(id, sm.text)
          m += u32(m + 8)
        }
        assert.equal(m, p + u32(p + 8), 'a track’s parts add up to its stated length')
        trackOrder.push(id)
        p += u32(p + 8)
      }
    } else if (type === 2) {
      assert.equal(tag(list), 'mhlp')
      let p = list + u32(list + 4)
      for (let i = 0; i < u32(list + 8); i++) {
        assert.equal(tag(p), 'mhyp', `playlist ${i}`)
        let name = ''
        let c = p + u32(p + 4)
        for (let k = 0; k < u32(p + 12); k++) {
          assert.equal(tag(c), 'mhod')
          if (u32(c + 12) === 1) name = stringMhod(c).text
          c += u32(c + 8)
        }
        const ids: number[] = []
        for (let k = 0; k < u32(p + 16); k++) {
          assert.equal(tag(c), 'mhip', `${name} item ${k}`)
          ids.push(u32(c + 24))
          c += u32(c + 8)
        }
        assert.equal(c, p + u32(p + 8), `${name}: its parts add up to its stated length`)
        playlists.push({ name, master: (u32(p + 20) & 0xff) === 1, ids })
        p += u32(p + 8)
      }
      assert.equal(p, pos + u32(pos + 8), 'the playlists fill their dataset exactly')
    }
    pos += u32(pos + 8)
  }
  assert.equal(pos, buf.length, 'the datasets fill the file exactly')
  return { titleById, trackOrder, playlists }
}

function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

describe('the iPod database with these playlists reads back', () => {
  const python = ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3'].find((p) => spawnSync(p, ['-c', 'pass']).status === 0)

  test('names, order and every song, read by an independent reader (and by gnupod when installed)', { skip: !python && 'no python3' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-db-pl-'))
    const itunes = join(dir, 'iPod_Control', 'iTunes')
    mkdirSync(itunes, { recursive: true })
    const tpl = join(dir, 'template'); writeFileSync(tpl, emptyTemplate())
    const out = join(itunes, 'iTunesDB')

    // 60 songs across two decades, handed to the writer in an order that is NOT id order.
    const lib = range(60).reverse().map((id) => ({
      id, title: `Song ${id}`, artist: `Band ${id % 7}`, album: `Album ${id % 11}`, genre: 'Punk', year: id <= 30 ? 1994 : 2004,
      path: `:iPod_Control:Music:F${String(id % 20).padStart(2, '0')}:S${id}.m4a`, duration: 180000 + id, codec: 'alac', fileSize: 1000 + id,
    }))
    const want = set({
      tracks: lib,
      passed: [
        { id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: lib.map((t) => t.id) },
        { id: 'a', name: 'Top 25 Most Played', trackIds: [60, 1, 30, 31, 2] },
        { id: 'b', name: 'Starred', trackIds: [5, 4, 3] },
        { id: 'lib', name: 'Office Musick', trackIds: [1, 2, 3] },
      ],
      verifiedBpm: new Map(range(40).map((id) => [id, 60 + id * 3] as [number, number])),
      onTheGo: [{ id: 'otg-1', name: 'On-The-Go 1', trackIds: [44, 2, 44, 17] }],
      assigned: [
        { id: 'k', name: 'The Skate Punk', trackIds: [10, 9, 8] }, { id: 'j', name: 'Åsa’s Mix – Ünïcödé', trackIds: [59, 58] },
        { id: 'm', name: 'Larry’s Deep Cuts', trackIds: range(12, 20) },
      ],
    }).playlists
    assert.deepEqual(names(want), [
      'Top 25 Most Played', 'Starred', "90's Music", "2000's Music",
      'BPM 060-089', 'BPM 090-109', 'BPM 110-129', 'BPM 130-149', 'BPM 150-169', 'BPM 170+',
      'On-The-Go 1', 'Åsa’s Mix – Ünïcödé', 'Larry’s Deep Cuts', 'The Skate Punk',
    ])

    const py = spawnSync(python!, [join(ROOT, 'core/db_reader.py'), '--write', out, '--template', tpl, '--ipod-root', dir], {
      input: JSON.stringify({ tracks: lib, playlists: want, masterName: 'punkPod' }), encoding: 'utf-8',
    })
    assert.equal(py.status, 0, py.stderr)
    const conform = await conformCatalogIdOrder(out)   // the pass every sync runs after the writer
    assert.equal(conform.ok, true, JSON.stringify(conform))

    const db = readItunesDb(readFileSync(out))
    assert.equal(db.trackOrder.length, 60)
    assert.deepEqual([...db.trackOrder].sort((a, b) => a - b), db.trackOrder, 'records ascend by id (the firmware’s binary search)')
    const libId = (dbid: number): number => Number(String(db.titleById.get(dbid)).replace('Song ', ''))
    assert.equal(db.playlists[0].master, true)
    assert.equal(db.playlists[0].name, 'punkPod')
    assert.equal(db.playlists[0].ids.length, 60)
    const rest = db.playlists.slice(1)
    // The writer folds curly quotes and dashes to what the old firmware's font can draw.
    const onDevice = names(want).map((n) => n.replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-'))
    assert.ok(onDevice.includes("Åsa's Mix - Ünïcödé"), 'accents are kept')
    assert.deepEqual(rest.map((p) => p.name), onDevice, 'every playlist, in exactly this order')
    for (let i = 0; i < want.length; i++) {
      assert.equal(rest[i].master, false)
      assert.deepEqual(rest[i].ids.map(libId), want[i].trackIds, `${want[i].name}: the same songs in the same order`)
      for (const id of rest[i].ids) assert.ok(db.titleById.has(id), `${want[i].name} only points at songs in the database`)
    }

    // gnupod (a second, unrelated implementation), where it is installed.
    const tunes2pod = '/opt/local/bin/tunes2pod.pl'
    const perl = '/opt/local/bin/perl5.34'
    if (existsSync(tunes2pod) && existsSync(perl)) {
      mkdirSync(join(dir, 'iPod_Control', '.gnupod'), { recursive: true })
      const g = spawnSync(perl, [tunes2pod, '-m', dir, '--force'], { encoding: 'utf-8' })
      assert.equal(g.status, 0, g.stdout + g.stderr)
      const xml = readFileSync(join(dir, 'iPod_Control', '.gnupod', 'GNUtunesDB.xml'), 'utf-8')
      const gpl = [...xml.matchAll(/<playlist\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/playlist>/g)]
        .map((m) => ({ name: m[1].replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&apos;/g, "'").replace(/&amp;/g, '&'), n: (m[2].match(/<add /g) || []).length }))
      assert.deepEqual(gpl.map((p) => p.name), onDevice, 'gnupod reads the same playlists in the same order')
      assert.deepEqual(gpl.map((p) => p.n), want.map((p) => p.trackIds.length), 'gnupod counts the same songs in each')
    }
  })
  test('a library playlist an earlier sync wrote is GONE after the next sync, and On-The-Go is back on as a playlist', { skip: !python && 'no python3' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-db-removal-'))
    const itunes = join(dir, 'iPod_Control', 'iTunes')
    mkdirSync(itunes, { recursive: true })
    const tpl = join(dir, 'template'); writeFileSync(tpl, emptyTemplate())
    const ipodDb = join(itunes, 'iTunesDB')
    const lib = range(40).map((id) => ({
      id, title: `Song ${id}`, artist: `Band ${id % 5}`, album: `Album ${id % 9}`, genre: 'Punk', year: id <= 20 ? 1994 : 2004,
      path: `:iPod_Control:Music:F${String(id % 20).padStart(2, '0')}:S${id}.m4a`, duration: 180000 + id, codec: 'alac', fileSize: 1000 + id,
    }))
    const write = (playlists: unknown[], template: string): void => {
      const py = spawnSync(python!, [join(ROOT, 'core/db_reader.py'), '--write', ipodDb, '--template', template, '--ipod-root', dir], {
        input: JSON.stringify({ tracks: lib, playlists, masterName: 'punkPod' }), encoding: 'utf-8',
      })
      assert.equal(py.status, 0, py.stderr)
    }
    // Sync 1, before the rule: what punkPod really got on 2026-11-14.
    const old = [
      { id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: lib.map((t) => t.id) },
      { id: 'lib-1', name: 'Rocksurgence', trackIds: [1, 2, 3] },
      { id: 'lib-2', name: 'Office Musick', trackIds: [4, 5] },
      { id: 'lib-3', name: '90’s Music', trackIds: [6] },
      { id: 'smart-ra', name: 'Recently Added', trackIds: [40, 39] },
    ]
    write(old, tpl)
    assert.equal((await conformCatalogIdOrder(ipodDb)).ok, true)
    const before = readItunesDb(readFileSync(ipodDb)).playlists.filter((p) => !p.master).map((p) => p.name)
    assert.deepEqual(before, ['punkPod', 'Rocksurgence', 'Office Musick', "90's Music", 'Recently Added'], 'the old card, as found')

    // Sync 2, under the rule. An On-The-Go list was read back by the plays gate and saved first.
    const state = mkdtempSync(join(tmpdir(), 'ipod-db-removal-state-'))
    await saveOtgLists(state, { snapshot: 'c'.repeat(40), lists: [{ trackIds: [7, 3] }], ipodName: 'punkPod', deviceKey: 'dev-1' })
    const r = await createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tracks: {}, playlists: [{ id: 'j', name: 'Skate Night', trackIds: [9, 8] }] }) }) })
      .forSync({ passed: old, tracks: lib, stateDir: state, deviceKey: 'dev-1', ipodName: 'punkPod', original: false })
    // The new catalog is written over the old one, with the old card's database as the template (as every sync does).
    const oldCard = join(dir, 'old-card'); writeFileSync(oldCard, readFileSync(ipodDb))
    write(r.playlists, oldCard)
    assert.equal((await conformCatalogIdOrder(ipodDb)).ok, true)
    const db = readItunesDb(readFileSync(ipodDb))
    const after = db.playlists.filter((p) => !p.master)
    assert.deepEqual(after.map((p) => p.name), ['Recently Added', "90's Music", "2000's Music", 'On-The-Go 1', 'Skate Night'])
    for (const gone of ['punkPod', 'Rocksurgence', 'Office Musick']) assert.equal(after.some((p) => p.name === gone), false, `${gone} is off the iPod`)
    assert.equal(db.playlists[0].master && db.playlists[0].ids.length, 40, 'every song is still on it, under Songs')
    const libId = (dbid: number): number => Number(String(db.titleById.get(dbid)).replace('Song ', ''))
    assert.deepEqual(after.find((p) => p.name === 'On-The-Go 1')!.ids.map(libId), [7, 3], 'the On-The-Go list is back, in its order')
    assert.deepEqual(after.find((p) => p.name === "90's Music")!.ids.map(libId), range(20), 'the new decade list, not the old fragment of one song')
  })
})
