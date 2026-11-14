/**
 * On-The-Go read-back (2026-11-13).
 *
 * The file format is pinned against the two independent readers that exist:
 * libgpod (itdb_itunesdb.c process_OTG_file: header length @4, entry length
 * @8, entry count @12, entries from the header's end, "opmh" = reversed) and
 * gnupod (GNUpod/iTunesDB.pm readOTG: count @12, entries from byte 20). No
 * OTGPlaylistInfo from a real iPod exists on this Mac (every archived plug-in
 * had none), so the fixtures below are built to those two readers' layout.
 *
 * The safety order is pinned too: a list that can't be saved means the plays
 * are NOT marked brought home, so the pre-sync gate stops the sync with the
 * iPod's own On-The-Go files still on the card.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseOtgIndexes, otgFileNames, readRoundTripSnapshot, ingestRoundTripSnapshot, readRoundTripState,
  type RoundTripHost,
} from '../sync-engine/roundtrip.ts'
import { securePlaysBeforeSync } from '../ipod-plays-archive.ts'
import { OTG_PLAYLISTS_FILE, planOtgSave, readOtgPlaylists, saveOtgLists } from '../ipod-otg-playlists.ts'

/** An OTGPlaylistInfo as the firmware writes it (libgpod / gnupod layout). */
function otgFile(indexes: number[], o: { bigEndian?: boolean; headerLen?: number; entryLen?: number; unknown16?: number } = {}): Buffer {
  const headerLen = o.headerLen ?? 0x14
  const entryLen = o.entryLen ?? 4
  const b = Buffer.alloc(headerLen + indexes.length * entryLen)
  const w = (v: number, p: number): void => { if (o.bigEndian) b.writeUInt32BE(v, p); else b.writeUInt32LE(v, p) }
  b.write(o.bigEndian ? 'opmh' : 'mhpo', 0, 'latin1')
  w(headerLen, 4); w(entryLen, 8); w(indexes.length, 12); w(o.unknown16 ?? 0, 16)
  indexes.forEach((v, i) => w(v, headerLen + i * entryLen))
  return b
}

/** gnupod's readOTG, transcribed: count @12, entries from byte 20, 4 bytes each, little-endian. */
function gnupodReadOtg(b: Buffer): number[] {
  const items = b.readUInt32LE(12)
  const out: number[] = []
  for (let i = 0, off = 20; i < items && off + 4 <= b.length; i++, off += 4) out.push(b.readUInt32LE(off))
  return out
}

describe('OTGPlaylistInfo format', () => {
  test('the standard little-endian file: same answer as gnupod’s reader', () => {
    const f = otgFile([5, 0, 999, 12])
    assert.deepEqual(parseOtgIndexes(f), [5, 0, 999, 12])
    assert.deepEqual(parseOtgIndexes(f), gnupodReadOtg(f))
  })
  test('the count is the field at 12, whatever the unknown field at 16 holds', () => {
    assert.deepEqual(parseOtgIndexes(otgFile([7, 8, 9], { unknown16: 0 })), [7, 8, 9])
    assert.deepEqual(parseOtgIndexes(otgFile([7, 8, 9], { unknown16: 5 })), [7, 8, 9])
    // The pre-fix reader took the count from offset 16: a real list read as empty.
    assert.equal(otgFile([7, 8, 9]).readUInt32LE(16), 0)
  })
  test('the reversed (big-endian, "opmh") file reads the same songs', () => {
    assert.deepEqual(parseOtgIndexes(otgFile([5, 0, 999, 70000], { bigEndian: true })), [5, 0, 999, 70000])
  })
  test('a longer header or entry is read by its stated length', () => {
    assert.deepEqual(parseOtgIndexes(otgFile([3, 1, 2], { headerLen: 0x20 })), [3, 1, 2])
    assert.deepEqual(parseOtgIndexes(otgFile([3, 1, 2], { entryLen: 8 })), [3, 1, 2])
  })
  test('an empty list, a cut-off file and a wrong file never invent songs', () => {
    assert.deepEqual(parseOtgIndexes(otgFile([])), [])
    assert.deepEqual(parseOtgIndexes(otgFile([1, 2, 3]).subarray(0, 0x14 + 8)), [1, 2])
    assert.deepEqual(parseOtgIndexes(Buffer.from('mhipnope............')), [])
    assert.deepEqual(parseOtgIndexes(Buffer.alloc(4)), [])
    const short = otgFile([1]); short.writeUInt32LE(8, 4)   // header shorter than 0x14: not a file we know
    assert.deepEqual(parseOtgIndexes(short), [])
  })
  test('every OTG file is read, in the firmware’s order', () => {
    assert.deepEqual(
      otgFileNames(['OTGPlaylistInfo_10', 'Play Counts', 'OTGPlaylistInfo_2', 'OTGPlaylistInfo', 'OTGPlaylistInfo_1', 'OTGPlaylistInfo_DND', 'iTunesDB']),
      ['OTGPlaylistInfo', 'OTGPlaylistInfo_1', 'OTGPlaylistInfo_2', 'OTGPlaylistInfo_10'],
    )
  })
})

describe('saving On-The-Go lists', () => {
  const now = new Date('2026-11-13T15:00:00Z')
  test('numbered up from the last one, named for the iPod, dated', () => {
    const first = planOtgSave([], { snapshot: 'a'.repeat(40), lists: [[3, 1, 2], [9]], ipodName: 'punkPod', now })
    assert.deepEqual(first.map((p) => [p.n, p.deviceName, p.name, p.trackIds]), [
      [1, 'On-The-Go 1', 'On-The-Go 1 — punkPod', [3, 1, 2]],
      [2, 'On-The-Go 2', 'On-The-Go 2 — punkPod', [9]],
    ])
    assert.equal(first[0].createdAt, '2026-11-13T15:00:00.000Z')
    const next = planOtgSave(first, { snapshot: 'b'.repeat(40), lists: [[4, 4, 5]], ipodName: 'punkPod', now })
    assert.deepEqual(next.map((p) => p.deviceName), ['On-The-Go 3'])
    assert.deepEqual(next[0].trackIds, [4, 4, 5], 'his order and his repeats are kept')
  })
  test('the same snapshot saved twice saves nothing new; an empty list is not a playlist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-save-'))
    const a = await saveOtgLists(dir, { snapshot: 'c'.repeat(40), lists: [[1, 2], []], ipodName: 'punkPod', now })
    assert.equal(a.length, 1)
    assert.deepEqual(await saveOtgLists(dir, { snapshot: 'c'.repeat(40), lists: [[1, 2], []], ipodName: 'punkPod', now }), [])
    assert.deepEqual((await readOtgPlaylists(dir)).map((p) => p.deviceName), ['On-The-Go 1'])
  })
  test('a file that can’t be read is an error, never a fresh numbering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-bad-'))
    await writeFile(join(dir, OTG_PLAYLISTS_FILE), '{ not json')
    await assert.rejects(saveOtgLists(dir, { snapshot: 'd'.repeat(40), lists: [[1]], ipodName: 'x', now }))
    assert.equal(await readFile(join(dir, OTG_PLAYLISTS_FILE), 'utf-8'), '{ not json', 'the unreadable file is left alone')
  })
})

// ── the round trip: saved before the plays are marked home ───────────────

function mhit(path: string): Buffer {
  const str = Buffer.from(path, 'utf16le')
  const mhod = Buffer.alloc(0x28 + str.length)
  mhod.write('mhod', 0, 'latin1'); mhod.writeUInt32LE(0x18, 4); mhod.writeUInt32LE(mhod.length, 8)
  mhod.writeUInt32LE(2, 12); mhod.writeUInt32LE(str.length, 0x1c); str.copy(mhod, 0x28)
  const head = Buffer.alloc(0x9c)
  head.write('mhit', 0, 'latin1'); head.writeUInt32LE(0x9c, 4); head.writeUInt32LE(0x9c + mhod.length, 8); head.writeUInt32LE(1, 12)
  return Buffer.concat([head, mhod])
}
function db(paths: string[]): Buffer {
  const mhits = paths.map(mhit)
  const len = mhits.reduce((n, b) => n + b.length, 0)
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(mhits.length, 8)
  const sec1 = Buffer.alloc(96); sec1.write('mhsd', 0, 'latin1'); sec1.writeUInt32LE(96, 4); sec1.writeUInt32LE(96 + 92 + len, 8); sec1.writeUInt32LE(1, 12)
  const head = Buffer.alloc(104); head.write('mhbd', 0, 'latin1'); head.writeUInt32LE(104, 4)
  return Buffer.concat([head, sec1, mhlt, ...mhits])
}
const PATHS = [':iPod_Control:Music:F00:A.m4a', ':iPod_Control:Music:F01:B.m4a', ':iPod_Control:Music:F02:C.m4a']
const IDS = [101, 202, 303]
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

async function card(otg: Record<string, Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'otg-trip-'))
  const mount = join(root, 'PUNKPOD')
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  const state = join(root, 'state')
  await mkdir(itunes, { recursive: true }); await mkdir(state)
  await writeFile(join(itunes, 'iTunesDB'), db(PATHS))
  for (const [name, bytes] of Object.entries(otg)) await writeFile(join(itunes, name), bytes)
  await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify({ tracks: PATHS.map((destPath, i) => ({ id: IDS[i], destPath })) }))
  const host = (save: RoundTripHost['saveOtgLists']): RoundTripHost => ({
    stateDir: state,
    getLibraryTracks: async () => IDS.map((id) => ({ id })),
    appendPlayEvents: async () => {},
    sendToRenderer: () => {},
    isSyncInFlight: () => false,
    saveOtgLists: save,
  })
  const real: RoundTripHost['saveOtgLists'] = async (snapshot, lists) => { await saveOtgLists(state, { snapshot, lists, ipodName: 'punkPod' }) }
  return { mount, itunes, state, host, real }
}

describe('On-The-Go through the round trip', () => {
  test('lists made on the iPod come home as playlists of library songs, in his order', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([2, 0]), OTGPlaylistInfo_1: otgFile([1, 1, 2], { bigEndian: true }) })
    const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
    assert.equal(out.kind, 'brought-home')
    assert.deepEqual((await readOtgPlaylists(c.state)).map((p) => [p.deviceName, p.trackIds]), [
      ['On-The-Go 1', [303, 101]],
      ['On-The-Go 2', [202, 202, 303]],
    ])
    // Plug-in again with the same files: nothing doubles.
    await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
    assert.equal((await readOtgPlaylists(c.state)).length, 2)
  })

  test('a list that can’t be saved: plays are not marked home, the sync stops, the iPod keeps its files', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([2, 0]) })
    const failing: RoundTripHost['saveOtgLists'] = async () => { throw new Error('disk full') }
    const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(failing))
    assert.equal(out.kind, 'failed')
    assert.equal(await readRoundTripState(c.state), null, 'the snapshot is not recorded as brought home')
    const gate = await securePlaysBeforeSync(c.mount, c.host(failing), 'Activity Sync')
    assert.equal(gate.ok, false, 'the pre-sync gate refuses')
    assert.equal(await exists(join(c.itunes, 'OTGPlaylistInfo')), true, 'the iPod’s On-The-Go file is untouched')
    // Saving works again: the same files now pass, and the list is there.
    const again = await securePlaysBeforeSync(c.mount, c.host(c.real), 'Activity Sync')
    assert.equal(again.ok, true)
    assert.deepEqual((await readOtgPlaylists(c.state)).map((p) => p.trackIds), [[303, 101]])
  })

  test('a snapshot recorded before the reader was fixed still gets its lists saved', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([0, 1]) })
    // First pass with no saver (what a pre-fix build did): the snapshot is recorded, the list is not kept.
    await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(undefined))
    assert.deepEqual(await readOtgPlaylists(c.state), [])
    const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
    assert.equal(out.kind, 'nothing-new')
    assert.deepEqual((await readOtgPlaylists(c.state)).map((p) => p.trackIds), [[101, 202]])
  })
})
