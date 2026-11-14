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
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseOtgIndexes, otgFileNames, readRoundTripSnapshot, ingestRoundTripSnapshot, readRoundTripState,
  type RoundTripHost,
} from '../sync-engine/roundtrip.ts'
import { securePlaysBeforeSync } from '../ipod-plays-archive.ts'
import { OTG_PLAYLISTS_FILE, otgListId, planOtgSave, readOtgPlaylists, readOtgPlaylistsRepairing, saveOtgLists, type OtgIo } from '../ipod-otg-playlists.ts'

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
  const L = (...ids: number[]) => ({ trackIds: ids })
  const base = { ipodName: 'punkPod', deviceKey: 'punk', now }

  test('numbered up from the last one, named for the iPod, dated', () => {
    const first = planOtgSave([], { ...base, snapshot: 'a'.repeat(40), lists: [L(3, 1, 2), L(9)] })
    assert.deepEqual(first.map((p) => [p.n, p.deviceName, p.name, p.trackIds]), [
      [1, 'On-The-Go 1', 'On-The-Go 1 — punkPod', [3, 1, 2]],
      [2, 'On-The-Go 2', 'On-The-Go 2 — punkPod', [9]],
    ])
    assert.equal(first[0].createdAt, '2026-11-13T15:00:00.000Z')
    const next = planOtgSave(first, { ...base, snapshot: 'b'.repeat(40), lists: [L(4, 4, 5)] })
    assert.deepEqual(next.map((p) => p.deviceName), ['On-The-Go 3'])
    assert.deepEqual(next[0].trackIds, [4, 4, 5], 'his order and his repeats are kept')
  })

  test('one list is saved once: the same songs in the same order are the same list, whatever files they came in', () => {
    // Review of PR 412: plug in, play a song, plug in again. The play log changed, so the
    // snapshot changed, and the same list was saved as On-The-Go 1, 2 and 3.
    const one = planOtgSave([], { ...base, snapshot: 'a'.repeat(40), lists: [L(11, 12, 13)] })
    const two = planOtgSave(one, { ...base, snapshot: 'b'.repeat(40), lists: [L(11, 12, 13)] })
    const three = planOtgSave(one, { ...base, snapshot: 'c'.repeat(40), lists: [L(11, 12, 13), L(11, 12, 13)] })
    assert.deepEqual([one.length, two.length, three.length], [1, 0, 0])
    assert.equal(planOtgSave(one, { ...base, snapshot: 'd'.repeat(40), lists: [L(13, 12, 11)] }).length, 1, 'another order is another list')
    assert.equal(otgListId('punk', [11, 12, 13]), one[0].id)
    assert.notEqual(otgListId('y2k', [11, 12, 13]), one[0].id, 'the same songs on another iPod are that iPod’s list')
    assert.equal(/[a-d]{12}/.test(one[0].id), false, 'the id does not come from the snapshot')
  })

  test('saved twice saves nothing new; an empty list is not a playlist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-save-'))
    const a = await saveOtgLists(dir, { ...base, snapshot: 'c'.repeat(40), lists: [L(1, 2), L()] })
    assert.equal(a.length, 1)
    assert.deepEqual(await saveOtgLists(dir, { ...base, snapshot: 'e'.repeat(40), lists: [L(1, 2), L()] }), [])
    assert.deepEqual((await readOtgPlaylists(dir)).map((p) => p.deviceName), ['On-The-Go 1'])
  })

  test('the save is read back: a disk that keeps something else is an error, not a saved list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-back-'))
    const files = new Map<string, string>()
    const lying: OtgIo = {
      readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(p)! },
      // The write "succeeds" and keeps a file without the list (a card or disk that drops writes).
      writeFile: async (p) => { files.set(p, JSON.stringify({ version: 1, playlists: [] })) },
      rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a) },
    }
    await assert.rejects(saveOtgLists(dir, { ...base, snapshot: 'f'.repeat(40), lists: [L(1, 2)] }, lying), /did not read back/)
    const honest: OtgIo = { ...lying, writeFile: async (p, t) => { files.set(p, t) } }
    assert.equal((await saveOtgLists(dir, { ...base, snapshot: 'f'.repeat(40), lists: [L(1, 2)] }, honest)).length, 1)
  })

  test('a damaged file: moved aside whole, a fresh one started, and the words say so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-bad-'))
    await writeFile(join(dir, OTG_PLAYLISTS_FILE), '{ not json')
    const said: string[] = []
    const r = await readOtgPlaylistsRepairing(dir, { now, warn: (m) => said.push(m) })
    assert.deepEqual(r.playlists, [])
    const aside = (await readdir(dir)).filter((f) => f.startsWith(`${OTG_PLAYLISTS_FILE}.corrupt-`))
    assert.equal(aside.length, 1)
    assert.equal(await readFile(join(dir, aside[0]), 'utf-8'), '{ not json', 'every byte of the bad file is kept')
    assert.match(r.repaired!, /unreadable.*moved aside, whole, to .*corrupt-2026-11-13.*nothing in it was deleted/)
    assert.equal(said.length, 1)
    // And saving works again straight away.
    assert.equal((await saveOtgLists(dir, { ...base, snapshot: 'd'.repeat(40), lists: [L(1)] })).length, 1)
  })

  test('one bad row: the readable lists are kept, the file as found is kept aside, numbering goes on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-row-'))
    const good = planOtgSave([], { ...base, snapshot: 'a'.repeat(40), lists: [L(1, 2), L(3)] })
    const found = JSON.stringify({ version: 1, playlists: [good[0], { id: 'otg-x', n: 'three', trackIds: 'oops' }, good[1]] })
    await writeFile(join(dir, OTG_PLAYLISTS_FILE), found)
    const r = await readOtgPlaylistsRepairing(dir, { now, warn: () => {} })
    assert.deepEqual(r.playlists.map((p) => p.deviceName), ['On-The-Go 1', 'On-The-Go 2'])
    assert.match(r.repaired!, /1 saved On-The-Go list\(s\) were unreadable.*the 2 list\(s\) that read were kept/)
    const aside = (await readdir(dir)).find((f) => f.includes('.corrupt-'))!
    assert.equal(await readFile(join(dir, aside), 'utf-8'), found, 'the unparsed row is still there, in the aside file')
    assert.deepEqual((await readOtgPlaylistsRepairing(dir, { now })).repaired, null, 'the rewritten file is clean')
    const next = await saveOtgLists(dir, { ...base, snapshot: 'b'.repeat(40), lists: [L(7)] })
    assert.deepEqual(next.map((p) => p.deviceName), ['On-The-Go 3'])
  })

  test('a damaged file that can’t be moved aside stops, and says which file to move', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otg-stuck-'))
    const stuck: OtgIo = {
      readFile: async () => '{ not json',
      writeFile: async () => { throw new Error('must not write over it') },
      rename: async () => { throw new Error('EPERM') },
    }
    await assert.rejects(
      saveOtgLists(dir, { ...base, snapshot: 'd'.repeat(40), lists: [L(1)] }, stuck),
      /ipod-otg-playlists\.json\) are damaged and couldn’t be moved aside \(EPERM\)\. Nothing was changed\. Move that file out of the folder and sync again/,
    )
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
  const real: RoundTripHost['saveOtgLists'] = async (snapshot, lists) => { await saveOtgLists(state, { snapshot, lists, ipodName: 'punkPod', deviceKey: 'punk' }) }
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
  test('plugged in twice with new plays in between: still one On-The-Go list', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([2, 0, 1]) })
    const plays = (n: number): Buffer => {
      const b = Buffer.alloc(16 + 3 * 16); b.write('mhdp', 0, 'latin1'); b.writeUInt32LE(16, 4); b.writeUInt32LE(16, 8); b.writeUInt32LE(3, 12)
      b.writeUInt32LE(n, 16); b.writeUInt32LE(3_900_000_000, 20)
      return b
    }
    for (const n of [1, 2, 3]) {
      await writeFile(join(c.itunes, 'Play Counts'), plays(n))   // a new play log = a new snapshot each time
      const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
      assert.equal(out.kind, 'brought-home')
    }
    assert.deepEqual((await readOtgPlaylists(c.state)).map((p) => [p.deviceName, p.trackIds]), [['On-The-Go 1', [303, 101, 202]]])
  })

  test('every On-The-Go file on the iPod is read, not only the first four', async () => {
    const files: Record<string, Buffer> = { OTGPlaylistInfo: otgFile([0]) }
    for (let i = 1; i <= 5; i++) files[`OTGPlaylistInfo_${i}`] = otgFile(i % 2 ? [1, 0] : [2, 1, 0].slice(0, 1 + (i % 3)))
    files.OTGPlaylistInfo_5 = otgFile([2, 2, 1])
    const c = await card(files)
    assert.equal((await readRoundTripSnapshot(c.itunes)).otg.length, 6)
    await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
    const saved = await readOtgPlaylists(c.state)
    assert.ok(saved.some((p) => p.trackIds.join() === '303,303,202'), 'the sixth file’s list came home')
  })

  test('songs that can’t be matched: the rest of the list comes home, and it says how many', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([2, 57, 0]) })   // 57 is past the end of a 3-song iPod
    const said: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')) }
    try {
      const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
      assert.equal(out.kind, 'brought-home')
    } finally { console.warn = warn }
    const [p] = await readOtgPlaylists(c.state)
    assert.deepEqual([p.trackIds, p.onIpod], [[303, 101], 3])
    assert.ok(said.some((l) => /On-The-Go list 1, song 2: not brought home — it points at song 58 of the iPod’s list, which has 3/.test(l)), said.join('\n'))
    assert.ok(said.some((l) => /On-The-Go list 1: 2 of 3 songs came home/.test(l)))
  })

  test('a list with NO song that can be matched is never lost: the sync stops and the iPod keeps it — but the plays come home', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([40, 41]) })
    const pc = Buffer.alloc(16 + 3 * 16); pc.write('mhdp', 0, 'latin1'); pc.writeUInt32LE(16, 4); pc.writeUInt32LE(16, 8); pc.writeUInt32LE(3, 12)
    pc.writeUInt32LE(4, 16); pc.writeUInt32LE(3_900_000_000, 20)   // 4 plays of the first song
    await writeFile(join(c.itunes, 'Play Counts'), pc)
    const played: Array<[number, number]> = []
    const host = { ...c.host(c.real), appendPlayEvents: async (id: number, n: number) => { played.push([id, n]) } }

    const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), host)   // plug-in
    assert.deepEqual([out.kind, (out as { list?: number }).list, (out as { songs?: number }).songs], ['otg-unmatched', 1, 2])
    assert.deepEqual(played, [[101, 4]], 'the plays were recorded at plug-in: the list did not hold them back')
    assert.equal((await readRoundTripState(c.state))?.ingested['101'], 4)
    assert.deepEqual(await readOtgPlaylists(c.state), [])

    const gate = await securePlaysBeforeSync(c.mount, host, 'Activity Sync')
    assert.equal(gate.ok, false, 'a sync is still stopped')
    const msg = (gate as { error: string }).error
    assert.match(msg, /On-The-Go list 1 on it \(2 songs\) can’t be matched to your library/)
    assert.match(msg, /it was left on the iPod\. Your plays were recorded\./)
    assert.match(msg, /To sync: on the iPod, go to Playlists → On-The-Go → Clear Playlist, then sync again\.$/)
    assert.equal(/Claude/.test(msg), false)
    assert.equal(await exists(join(c.itunes, 'OTGPlaylistInfo')), true, 'still on the iPod')
    assert.deepEqual(played, [[101, 4]], 'and the plays are not counted twice')

    // Jake clears On-The-Go on the iPod: the sync goes.
    await writeFile(join(c.itunes, 'OTGPlaylistInfo'), otgFile([]))
    assert.equal((await securePlaysBeforeSync(c.mount, host, 'Activity Sync')).ok, true)
    assert.deepEqual(played, [[101, 4]])
  })

  test('a newly set-up iPod with a previous owner’s On-The-Go list: let go with a log line, the first sync is not stopped', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([0, 2, 1]) })
    await rm(join(c.state, 'last-sync-manifest.json'))   // JakeTunes has never synced this iPod
    const said: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')) }
    let gate
    try { gate = await securePlaysBeforeSync(c.mount, c.host(c.real), 'Activity Sync') } finally { console.warn = warn }
    assert.equal(gate.ok, true)
    assert.deepEqual(gate.outcome, { kind: 'otg-leftover-discarded', lists: 1, songs: 3 })
    assert.ok(said.some((l) => /has never been synced by JakeTunes; the 1 On-The-Go list\(s\) on it \(3 song\(s\)\) are from before it was set up/.test(l)), said.join('\n'))
    assert.deepEqual(await readOtgPlaylists(c.state), [], 'nothing of a stranger’s is saved as Jake’s')
    assert.ok(gate.archiveDir && await exists(join(gate.archiveDir, 'iTunes', 'OTGPlaylistInfo')), 'the raw file is still kept in the archive')
  })

  test('an iPod JakeTunes HAS synced is never treated as newly set up: an unreadable manifest still stops', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([0, 2, 1]) })
    await writeFile(join(c.state, 'last-sync-manifest.json'), '{ torn')
    const gate = await securePlaysBeforeSync(c.mount, c.host(c.real), 'Activity Sync')
    assert.equal(gate.ok, false)
    assert.equal(gate.outcome?.kind, 'cannot-map')
  })

  test('one good list and one unmatched list: the sync still stops, so the unmatched one isn’t erased', async () => {
    const c = await card({ OTGPlaylistInfo: otgFile([0, 1]), OTGPlaylistInfo_1: otgFile([99]) })
    const out = await ingestRoundTripSnapshot(await readRoundTripSnapshot(c.itunes), c.host(c.real))
    assert.equal(out.kind, 'otg-unmatched')
    assert.equal((await securePlaysBeforeSync(c.mount, c.host(c.real), 'Activity Sync')).ok, false)
  })
})
