/**
 * The playlists one iPod carries (2026-11-13): the rule, the order, and proof
 * that the database built with them reads back.
 *
 * Jake: "the only playlists each ipod gets are the default and its specific
 * ipod assigned playlists"; "default playlists on top, on the go, then the per
 * ipod playlists in a to z order. same rules as we have for songs, artists
 * albums etc".
 *
 * The round trip at the bottom builds a real iTunesDB with core/db_reader.py
 * (the writer every sync uses), runs the same id-order pass a sync runs, and
 * reads it back with a reader written here from the published iTunesDB layout
 * — not with db_reader's own parser — asserting playlist names, their order
 * and every song in order. When gnupod's tunes2pod.pl is installed (this Mac
 * has it) the same file is also read by gnupod.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BPM_RANGES, DECADE_MIN, SET_PLAYLIST_ID, bpmPlaylists, bpmRangeIndex, builtinDefaultNames, decadeName,
  decadePlaylists, devicePlaylistSet, verifiedBpmFrom, type DevicePlaylist, type DeviceTrack,
} from '../../common/ipod-device-playlists.ts'
import { compareIpodArtistNames } from '../ipod-artist-sort.ts'
import { compareNames } from '../../renderer/utils/artistSort.ts'
import { conformCatalogIdOrder } from '../ipod-catalog-order.ts'
import { createDevicePlaylists, parseAssigned, ASSIGNED_CACHE_FILE, BPM_CACHE_FILE } from '../ipod-device-playlists-run.ts'
import { saveOtgLists, OTG_PLAYLISTS_FILE } from '../ipod-otg-playlists.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const range = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i)
const songs = (ids: number[], year: number): DeviceTrack[] => ids.map((id) => ({ id, year }))
const names = (ps: DevicePlaylist[]): string[] => ps.map((p) => p.name)
const set = (over: Partial<Parameters<typeof devicePlaylistSet>[0]> & { tracks: DeviceTrack[] }) =>
  devicePlaylistSet({ passed: [], year: 2026, verifiedBpm: new Map(), onTheGo: [], assigned: [], compareNames: compareIpodArtistNames, ...over })

describe('decade lists', () => {
  test('named the way an iPod named them', () => {
    assert.deepEqual([1960, 1990, 2000, 2010, 2020].map(decadeName), ["60's Music", "90's Music", "00's Music", "10's Music", "20's Music"])
  })
  test('a decade needs 10 songs; 9 is not a list', () => {
    const t = [...songs(range(DECADE_MIN - 1), 1985), ...songs(range(DECADE_MIN, 100), 1994), ...songs([900, 901], 0)]
    assert.deepEqual(names(decadePlaylists(t)), ["90's Music"])
    assert.deepEqual(decadePlaylists(t)[0].trackIds, range(DECADE_MIN, 100))
  })
  test('oldest decade first; a missing or silly year is in no decade', () => {
    const t = [...songs(range(10, 1), 2003), ...songs(range(10, 20), 1979), { id: 99, year: 'n/a' }, { id: 98, year: 3 }]
    assert.deepEqual(names(decadePlaylists(t)), ["70's Music", "00's Music"])
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
    assert.deepEqual(r.dropped, ['Office Musick', 'Justification II', 'Best of 2019'])
    for (const n of r.dropped) assert.equal(names(r.playlists).includes(n), false)
  })
  test('defaults in one fixed order; empty and nearly-the-whole-iPod ones are left off', () => {
    const r = set({ tracks, passed, verifiedBpm: new Map([[1, 100], [2, 140]]) })
    assert.deepEqual(names(r.playlists), [
      'punkPod', 'Top 25 Most Played', 'Recently Added', 'Best of 2026', "90's Music", "00's Music", 'BPM 090-109', 'BPM 130-149',
    ])
    // Starred was empty; Recently Played was 95 of 100 (the 90% line).
    assert.deepEqual(r.playlists[1].trackIds, [7, 8], 'a song not on the iPod is never referenced')
  })
  test('the iPod’s own list is the whole iPod on purpose', () => {
    assert.equal(set({ tracks, passed }).playlists[0].trackIds.length, 100)
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
    assert.deepEqual(names(r.playlists), ['Y2K', 'Starred', "90's Music", "00's Music", 'On-The-Go 1', 'On-The-Go 2', ...want])
  })
  test('an assigned playlist keeps his order and is never cut for being most of the iPod', () => {
    const r = set({ tracks: songs(range(10), 1990), assigned: [{ id: 'mine', name: 'Mine', trackIds: [9, 1, 9, 77, 3, ...range(10)] }] })
    assert.deepEqual(r.playlists.map((p) => [p.name, p.trackIds]), [['Mine', [9, 1, 3, 2, 4, 5, 6, 7, 8, 10]]])
  })
  test('two playlists can’t share a name on the iPod; the first one stands', () => {
    const r = set({ tracks: songs(range(20), 1990), passed: [{ id: 's', name: 'Starred', trackIds: [1] }], assigned: [{ id: 'x', name: 'starred', trackIds: [2] }] })
    assert.deepEqual(names(r.playlists), ['Starred'])
  })
})

// ── gathering: homemini, the kept copies, On-The-Go ───────────────────────

describe('gathering an iPod’s playlists for a sync', () => {
  const tracks = range(30).map((id) => ({ id, year: id <= 15 ? 1994 : 2004 }))
  const passed = [{ id: SET_PLAYLIST_ID, name: 'punkPod', trackIds: range(30) }, { id: 'lib', name: 'Bops', trackIds: [1] }]
  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body })

  test('homemini answering: BPM lists, his playlists, On-The-Go; On-The-Go is sent up once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    await saveOtgLists(dir, { snapshot: 'a'.repeat(40), lists: [[3, 2]], ipodName: 'punkPod' })
    const calls: string[] = []
    const run = createDevicePlaylists({
      baseUrl: 'http://hub', warn: () => {},
      fetchImpl: async (url, init) => {
        calls.push(`${String((init as { method?: string }).method)} ${url.replace('http://hub', '')}`)
        if (url.includes('/api/bpm-key')) return reply(200, { tracks: { '1': { bpm: 100, bpmStatus: 'verified' }, '2': { bpm: 180, bpmStatus: 'unverified' } } })
        if ((init as { method?: string }).method === 'PUT') return reply(200, { ok: true })
        return reply(200, { playlists: [{ id: 'jake-1', name: 'Skate Night', source: 'jake', trackIds: [9, 8, 400] }] })
      },
    })
    const r = await run.forSync({ passed, tracks, stateDir: dir, deviceKey: 'dev-1' })
    assert.deepEqual(r.playlists.map((p) => [p.name, p.trackIds.length]), [
      ['punkPod', 30], ["90's Music", 15], ["00's Music", 15], ['BPM 090-109', 1], ['On-The-Go 1', 2], ['Skate Night', 2],
    ])
    assert.deepEqual(r.dropped, ['Bops'])
    assert.ok(calls.some((c) => c.startsWith('PUT /api/ipod-playlists/dev-1/otg-aaaaaaaaaaaa-1')))
    assert.ok(existsSync(join(dir, BPM_CACHE_FILE)) && existsSync(join(dir, ASSIGNED_CACHE_FILE)))
  })
  test('homemini away: the copies kept from last time are used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    writeFileSync(join(dir, BPM_CACHE_FILE), JSON.stringify({ bpm: { '4': 150 } }))
    writeFileSync(join(dir, ASSIGNED_CACHE_FILE), JSON.stringify({ playlists: [{ id: 'jake-1', name: 'Skate Night', trackIds: [9] }] }))
    const run = createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => { throw new Error('offline') } })
    const r = await run.forSync({ passed, tracks, stateDir: dir, deviceKey: 'dev-1' })
    assert.deepEqual(names(r.playlists), ['punkPod', "90's Music", "00's Music", 'BPM 150-169', 'Skate Night'])
  })
  test('an older homemini (no such route) and nothing kept: defaults only, no error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    const run = createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => reply(404, null) })
    assert.deepEqual(names((await run.forSync({ passed, tracks, stateDir: dir, deviceKey: 'dev-1' })).playlists), ['punkPod', "90's Music", "00's Music"])
  })
  test('an On-The-Go file that can’t be read stops the sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipod-pl-'))
    writeFileSync(join(dir, OTG_PLAYLISTS_FILE), 'not json')
    const run = createDevicePlaylists({ baseUrl: 'http://hub', warn: () => {}, fetchImpl: async () => reply(404, null) })
    await assert.rejects(run.forSync({ passed, tracks, stateDir: dir, deviceKey: 'dev-1' }))
  })
  test('a body that isn’t playlists is not playlists', () => {
    assert.equal(parseAssigned({ nope: 1 }), null)
    assert.deepEqual(parseAssigned({ playlists: [{ id: 1, name: 'x', trackIds: [] }, { id: 'a', name: 'A', trackIds: [1, 'x', 2] }] }), [{ id: 'a', name: 'A', trackIds: [1, 2] }])
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
      'punkPod', 'Top 25 Most Played', 'Starred', "90's Music", "00's Music",
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
})
