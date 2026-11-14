/**
 * Setting up a new iPod — the half that reads and writes, against folders in
 * the temp dir standing in for an iPod. No real device, no /Volumes.
 *
 * The song database is proven the long way round: the blank one set-up writes
 * is read back by two readers that share no code with its builder
 * (roundtrip.ts's parseCatalogPaths and core/db_reader.py), then handed to the
 * real catalog writer (db_reader.py --write) as its template with three songs,
 * and what THAT writes is read back again.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, copyFile, symlink, lstat } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { buildBlankCatalog, readCatalogSummary } from '../ipod-blank-catalog.ts'
import {
  CARD_TEST_DIR, adoptExistingIpod, cleanLeftoverTest, fsFromMountTable, gatherIpodFacts, guard, noteLastSync, prepareIpod, readOnboardingRecords,
  runCardTest, sealOnboarding, stableReads, testBlock, usbFactsFromProfile, type FactsDeps, type WriteGuard,
} from '../ipod-onboarding.ts'
import { identifyIpod, loadIpodRegistry, registerIpod, resolveIpodState } from '../ipod-identity.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'
import { CARD_HEADROOM_BYTES, detectHardware, onboardingStep, type IpodDeviceFacts } from '../../common/ipod-onboarding.ts'

const CORE = resolve(import.meta.dirname, '../../../core')
const EIGHTIES = '5e7f7a64-f770-48bd-a3dc-58bca2a6b716'
const Y2K = '842f4c4f-14f2-45b4-9c5d-32c1295604da'
const SYS_3G = 'BoardHwName: iPod Q14\npszSerialNumber: JQ3456ZZZZZ\nModelNumStr: M9245\nFirewireGuid: 0x000A270000001111\nvisibleBuildID: 0x02308000 (2.3)\n'
const SYS_MINI = 'BoardHwName: iPod Q22B\nModelNumStr: M9803\nFirewireGuid: 0x000A27001234ABCD\nvisibleBuildID: 0x01418000 (1.4.1)\niPodFamily: 3\n'
const MB = 1024 * 1024

/** A formatted card that has started up once in an iPod: Apple's own file, SysInfo, no song database. */
async function freshCard(sysInfo: string | null = SYS_MINI): Promise<{ root: string; mount: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jt-ipod-setup-'))
  const mount = join(root, 'IPOD')
  const stateDir = join(root, 'state')
  await mkdir(join(mount, 'iPod_Control', 'iTunes'), { recursive: true })
  await mkdir(stateDir)
  await writeFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesPrefs'), Buffer.alloc(64))
  if (sysInfo !== null) {
    await mkdir(join(mount, 'iPod_Control', 'Device'), { recursive: true })
    await writeFile(join(mount, 'iPod_Control', 'Device', 'SysInfo'), sysInfo)
  }
  return { root, mount, stateDir }
}

const deps = (mount: string, over: Partial<FactsDeps> = {}): FactsDeps => ({
  mountTable: async () => `/dev/disk3s1 on / (apfs, sealed, local)\n/dev/disk9s2 on ${mount} (msdos, local, nodev, nosuid, noowners, noatime, fskit)\n`,
  otherIpods: async () => 0,
  driveId: async () => 'A1B2C3D4-0000-1111-2222-333344445555|249500000000',
  syncInFlight: () => false,
  role: 'hub',
  ...over,
})
const guardOf = (f: IpodDeviceFacts): WriteGuard => ({ markerAtChecks: f.marker, otherIpods: async () => 0, syncInFlight: () => false, sameDrive: async () => true })
const passed = { stable: { tried: 8, ok: 8 }, writeTest: { ok: true, bytes: 1 } }
const noProgress = { firstSync: null, listSongs: null, playlists: 'not-built-yet' as const, bpm: null }

/** Every file and folder under a folder, with sizes: "was anything touched?" */
async function snapshot(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out[`${r}/`] = 0; await walk(join(d, e.name), r) } else out[r] = (await stat(join(d, e.name))).size
    }
  }
  await walk(dir, '')
  return out
}

function python(code: string, args: string[]): string {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

describe('reading an iPod without writing to it', () => {
  test('a fresh mini: model, software, format, empty, no ID, and the look leaves no trace', async () => {
    const { mount } = await freshCard()
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount))
    assert.equal(detectHardware(f.sysInfo, f.usb), 'mini-2g')
    assert.equal(f.sysInfo?.firmware, '1.4.1')
    assert.equal(f.fs, 'fat32')
    assert.deepEqual(f.catalog, { present: false, readable: false, songs: null, name: null, artists: [] })
    assert.equal(f.musicFiles, 0)
    assert.equal(f.firmwareFiles, true)
    assert.equal(f.marker, null)
    assert.equal(f.rockbox, false)
    assert.ok((f.totalBytes ?? 0) > 0)
    assert.deepEqual(await snapshot(mount), before)
    assert.equal(onboardingStep({ facts: f, target: null, name: null, typed: null, records: [], progress: noProgress }).step, 'choose-list')
  })
  test('a 3rd generation, a Rockbox folder, songs already on it', async () => {
    const { mount } = await freshCard(SYS_3G)
    await mkdir(join(mount, '.rockbox'))
    await mkdir(join(mount, 'iPod_Control', 'Music', 'F03'), { recursive: true })
    for (const n of ['ABCD.m4a', 'EFGH.mp3', '._ABCD.m4a', 'notes.txt']) await writeFile(join(mount, 'iPod_Control', 'Music', 'F03', n), 'x')
    const f = await gatherIpodFacts(mount, deps(mount))
    assert.equal(detectHardware(f.sysInfo, f.usb), '3g')
    assert.equal(f.sysInfo?.firmware, '2.3')
    assert.equal(f.rockbox, true)
    assert.equal(f.musicFiles, 2)
  })
  test('the mount table: FAT32, Mac format, a network share, and a drive that isn’t in it', () => {
    const table = '/dev/disk9s2 on /Volumes/JT RED (msdos, local, nodev)\n/dev/disk8s2 on /Volumes/OLD (hfs, local, journaled)\n//jake@ds225/JakeShared on /Volumes/JakeShared (smbfs, nodev)\n'
    assert.equal(fsFromMountTable(table, '/Volumes/JT RED'), 'fat32')
    assert.equal(fsFromMountTable(table, '/Volumes/OLD'), 'hfs')
    assert.equal(fsFromMountTable(table, '/Volumes/JakeShared'), 'other')
    assert.equal(fsFromMountTable(table, '/Volumes/JT'), null)
  })
  test('the USB report: the device that carries this disk, wherever it sits in the tree', () => {
    const report = { SPUSBDataType: [{ _name: 'USB31Bus', _items: [
      { _name: 'Hub', _items: [{ _name: 'iPod mini', manufacturer: 'Apple Inc.', product_id: '0x1205', vendor_id: '0x05ac (Apple Inc.)', serial_num: '000A27001234ABCD', Media: [{ bsd_name: 'disk9', _name: 'iPod' }] }] },
      { _name: 'Card Reader', product_id: '0x8406', Media: [{ bsd_name: 'disk7' }] },
    ] }] }
    assert.deepEqual(usbFactsFromProfile(report, 'disk9'), { vendor: 'Apple Inc.', productId: 0x1205, serial: '000A27001234ABCD' })
    assert.equal(usbFactsFromProfile(report, 'disk4'), null)
    assert.equal(usbFactsFromProfile(null, 'disk9'), null)
  })
  test('eight looks at a steady drive are eight answers; a drive that isn’t there answers none', async () => {
    const { mount, root } = await freshCard()
    const naps: number[] = []
    assert.deepEqual(await stableReads(mount, 8, 400, async (ms) => { naps.push(ms) }), { tried: 8, ok: 8 })
    assert.equal(naps.length, 7)
    assert.deepEqual(await stableReads(join(root, 'GONE'), 8, 400, async () => undefined), { tried: 8, ok: 0 })
  })
})

describe('the blank song database', () => {
  test('two readers that share nothing with the builder read it: no songs, the iPod’s name', async () => {
    const { root } = await freshCard()
    const db = buildBlankCatalog("1980's")
    assert.deepEqual(parseCatalogPaths(db), [])
    assert.deepEqual(readCatalogSummary(db), { songs: 0, name: "1980's" })
    assert.equal(db.readUInt32LE(8), db.length, 'the header’s total length is the file’s length')
    const path = join(root, 'iTunesDB')
    await writeFile(path, db)
    const out = python(
      'import sys, json; sys.path.insert(0, sys.argv[1]); import db_reader as d\nprint(json.dumps({"tracks": len(d.parse_tracks(sys.argv[2])), "name": d.parse_master_name(sys.argv[2])}))',
      [CORE, path],
    )
    assert.deepEqual(JSON.parse(out), { tracks: 0, name: "1980's" })
  })
  test('the real catalog writer takes it as its template: three songs go in, three come back, in order', async () => {
    const { root, mount } = await freshCard()
    const template = join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')
    await writeFile(template, buildBlankCatalog('Eighties'))
    const paths = [':iPod_Control:Music:F00:AAAA.m4a', ':iPod_Control:Music:F01:BBBB.m4a', ':iPod_Control:Music:F02:CCCC.mp3']
    const tracks = paths.map((path, i) => ({
      id: 100 + i, title: `Song ${i + 1}`, artist: 'Men At Work', album: 'Business As Usual', genre: 'Rock', path,
      duration: 200000 + i, year: 1981, trackNumber: i + 1, trackCount: 3, discNumber: 1, playCount: 0, fileSize: 1000 + i,
    }))
    for (const [i, p] of paths.entries()) {
      const file = join(mount, ...p.split(':').filter(Boolean))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, Buffer.alloc(2048 + i))
    }
    const out = join(root, 'written-iTunesDB')
    const r = spawnSync('python3', [join(CORE, 'db_reader.py'), '--write', out, '--template', template, '--ipod-root', mount], {
      input: JSON.stringify({ tracks, playlists: [{ name: 'First And Last', trackIds: [100, 102] }], masterName: 'Eighties' }), encoding: 'utf-8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, count: 3 })
    const written = await readFile(out)
    assert.deepEqual(parseCatalogPaths(written), paths)
    assert.deepEqual(readCatalogSummary(written), { songs: 3, name: 'Eighties' })
    // The header the writer kept is the blank's own (its length, its version).
    assert.equal(written.readUInt32LE(4), 244)
    assert.equal(written.readUInt32LE(0x10), 0x73)
    const back = JSON.parse(python(
      'import sys, json; sys.path.insert(0, sys.argv[1]); import db_reader as d\nt = d.parse_tracks(sys.argv[2])\nprint(json.dumps({"titles": [x["title"] for x in t], "name": d.parse_master_name(sys.argv[2])}))',
      [CORE, out],
    )) as { titles: string[]; name: string }
    assert.deepEqual(back, { titles: ['Song 1', 'Song 2', 'Song 3'], name: 'Eighties' })
  })
})

describe('preparing the iPod', () => {
  test('an empty mini takes a list: folders, blank database, the list’s id on the card, the record', async () => {
    const { mount, stateDir } = await freshCard()
    const f = await gatherIpodFacts(mount, deps(mount), passed)
    const r = await prepareIpod(mount, stateDir, guardOf(f), { listId: Y2K, name: 'Y2K', color: 'purple', purpose: 'the 2000s', facts: f, now: '2026-11-20T15:00:00.000Z' })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    assert.deepEqual(r.did, ['the folders are there', 'a blank song database was written', 'the ID file was written', 'the iPod was recorded'])
    assert.equal((await readdir(join(mount, 'iPod_Control', 'Music'))).filter((d) => /^F\d\d$/.test(d)).length, 50)
    assert.deepEqual(readCatalogSummary(await readFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'))), { songs: 0, name: 'Y2K' })
    // The binding: the card carries the LIST's id, and the app now knows the iPod by it.
    const id = await identifyIpod(mount, stateDir)
    assert.equal(id.status === 'known' && id.device.id, Y2K)
    assert.equal(id.status === 'known' && id.device.color, 'purple')
    assert.equal((await resolveIpodState(mount, stateDir)).stateDir, join(stateDir, 'ipod-pools', Y2K))
    const [rec] = await readOnboardingRecords(stateDir)
    assert.equal(rec.listId, Y2K)
    assert.equal(rec.hardware, 'mini-2g')
    assert.equal(rec.firmware, '1.4.1')
    assert.equal(rec.sealedAt, null)
    // And the next look says: first sync.
    const again = await gatherIpodFacts(mount, deps(mount), passed)
    assert.equal(onboardingStep({ facts: again, target: null, name: null, typed: null, records: [rec], progress: { ...noProgress, listSongs: 352 } }).step, 'first-sync')
  })
  test('an iPod with songs on it: the database and every song are left exactly as they were', async () => {
    const { mount, stateDir } = await freshCard()
    const dbPath = join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')
    const theirs = buildBlankCatalog('Somebody Else')
    await writeFile(dbPath, theirs)
    await mkdir(join(mount, 'iPod_Control', 'Music', 'F07'), { recursive: true })
    await writeFile(join(mount, 'iPod_Control', 'Music', 'F07', 'ZZZZ.m4a'), 'their song')
    const f = await gatherIpodFacts(mount, deps(mount), passed)
    const r = await prepareIpod(mount, stateDir, guardOf(f), { listId: Y2K, name: 'Y2K', color: null, purpose: null, facts: f, now: '2026-11-20T15:00:00.000Z' })
    assert.equal(r.ok, true)
    assert.ok(!r.did.includes('a blank song database was written'))
    assert.deepEqual(await readFile(dbPath), theirs)
    assert.equal(await readFile(join(mount, 'iPod_Control', 'Music', 'F07', 'ZZZZ.m4a'), 'utf-8'), 'their song')
  })
  test('the Original is never written to: not by set-up, not by the test file', async () => {
    const { mount, stateDir } = await freshCard()
    await writeFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('Original'))
    assert.equal((await registerIpod(mount, stateDir, { asOriginal: true })).ok, true)
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount), passed)
    // Even with a guard built from facts that never saw the Original's ID file.
    for (const g of [guardOf(f), guardOf({ ...f, marker: null })]) {
      const r = await prepareIpod(mount, stateDir, g, { listId: EIGHTIES, name: 'Eighties', color: null, purpose: null, facts: f, now: '2026-11-20T15:00:00.000Z' })
      assert.equal(r.ok, false)
      assert.match(r.ok ? '' : r.error, /your Original/)
      const t = await runCardTest(mount, g, { quick: true, freeBytes: CARD_HEADROOM_BYTES + 2 * MB })
      assert.equal(t.ok, false)
      assert.match(t.reason ?? '', /your Original/)
    }
    assert.deepEqual(await snapshot(mount), before)
    assert.deepEqual(await readOnboardingRecords(stateDir), [])
  })
  test('a different card since the checks, a second iPod, a sync, a card that left: all refused untouched', async () => {
    const a = await freshCard()
    const b = await freshCard()
    const fa = await gatherIpodFacts(a.mount, deps(a.mount), passed)
    // b was set up as Y2K; the checks ran on a (no ID file).
    const fb = await gatherIpodFacts(b.mount, deps(b.mount), passed)
    assert.equal((await prepareIpod(b.mount, b.stateDir, guardOf(fb), { listId: Y2K, name: 'Y2K', color: null, purpose: null, facts: fb, now: '2026-11-20T15:00:00.000Z' })).ok, true)
    const before = await snapshot(b.mount)
    assert.match(await guard(b.mount, guardOf(fa)) ?? '', /changed since it was checked/)
    const refused = await prepareIpod(b.mount, b.stateDir, guardOf(fa), { listId: EIGHTIES, name: 'Eighties', color: null, purpose: null, facts: fa, now: '2026-11-21T15:00:00.000Z' })
    assert.equal(refused.ok, false)
    assert.match(await guard(a.mount, { ...guardOf(fa), otherIpods: async () => 1 }) ?? '', /Two iPods/)
    assert.match(await guard(a.mount, { ...guardOf(fa), otherIpods: async () => { throw new Error('mount table') } }) ?? '', /Two iPods/, 'a failed look counts as "another iPod might be there"')
    assert.match(await guard(a.mount, { ...guardOf(fa), syncInFlight: () => true }) ?? '', /sync is running/)
    assert.match(await guard(join(a.root, 'GONE'), guardOf(fa)) ?? '', /isn’t there any more/)
    assert.match(await guard(a.mount, { ...guardOf(fa), sameDrive: async () => false }) ?? '', /isn’t the drive that was checked/)
    assert.match(await guard(a.mount, { ...guardOf(fa), sameDrive: async () => { throw new Error('diskutil') } }) ?? '', /isn’t the drive that was checked/, 'a failed look counts as "not the same drive"')
    assert.equal(await guard(a.mount, guardOf(fa)), null)
    assert.deepEqual(await snapshot(b.mount), before)
  })
  test('moving an iPod from one list to another: the old list has no iPod again, the history says so', async () => {
    const { mount, stateDir } = await freshCard()
    const f1 = await gatherIpodFacts(mount, deps(mount), passed)
    assert.equal((await prepareIpod(mount, stateDir, guardOf(f1), { listId: Y2K, name: 'Y2K', color: 'blue', purpose: null, facts: f1, now: '2026-11-20T15:00:00.000Z' })).ok, true)
    const f2 = await gatherIpodFacts(mount, deps(mount), passed)
    assert.equal(f2.marker?.id, Y2K)
    const r = await prepareIpod(mount, stateDir, guardOf(f2), { listId: EIGHTIES, name: 'Eighties', color: 'purple', purpose: null, facts: f2, now: '2026-12-01T15:00:00.000Z' })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    const id = await identifyIpod(mount, stateDir)
    assert.equal(id.status === 'known' && id.device.id, EIGHTIES)
    assert.deepEqual((await loadIpodRegistry(stateDir)).devices.map((d) => d.id), [EIGHTIES])
    const recs = await readOnboardingRecords(stateDir)
    const old = recs.find((x) => x.listId === Y2K)!
    const now = recs.find((x) => x.listId === EIGHTIES)!
    assert.equal(old.released, true)
    assert.equal(old.history.at(-1)?.event, 'released')
    assert.deepEqual(now.history.map((h) => h.event), ['set-up', 'moved-to-another-list'])
  })
  test('a card that doesn’t give the blank database back stops the set-up before the ID file is written', async () => {
    const { mount, stateDir } = await freshCard()
    const f = await gatherIpodFacts(mount, deps(mount), passed)
    const r = await prepareIpod(mount, stateDir, guardOf(f), { listId: Y2K, name: 'y2kPod', color: null, purpose: null, facts: f, now: '2026-11-20T15:00:00.000Z' },
      { readBack: async () => Buffer.alloc(4096) })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /couldn’t write the blank song database \(the blank song database didn’t read back\)\. Already done: the folders are there\./)
    assert.equal(await stat(join(mount, 'iPod_Control', 'jaketunes-device.json')).then(() => true, () => false), false)
    assert.deepEqual(await readOnboardingRecords(stateDir), [])
  })
  test('the drive changes between two of set-up’s writes: it stops there and says what was done', async () => {
    const { mount, stateDir } = await freshCard()
    const f = await gatherIpodFacts(mount, deps(mount), passed)
    let asked = 0
    const g: WriteGuard = { ...guardOf(f), sameDrive: async () => ++asked < 2 }
    const r = await prepareIpod(mount, stateDir, g, { listId: Y2K, name: 'y2kPod', color: null, purpose: null, facts: f, now: '2026-11-20T15:00:00.000Z' })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /isn’t the drive that was checked.*Already done: the folders are there\./)
    assert.equal(await stat(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')).then(() => true, () => false), false)
    assert.equal(await stat(join(mount, 'iPod_Control', 'jaketunes-device.json')).then(() => true, () => false), false)
  })
  test('the Original’s ID file is never overwritten and its id is never given to another iPod', async () => {
    const a = await freshCard()
    await writeFile(join(a.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('Original'))
    const original = await registerIpod(a.mount, a.stateDir, { asOriginal: true })
    assert.equal(original.ok, true)
    const before = await readFile(join(a.mount, 'iPod_Control', 'jaketunes-device.json'), 'utf-8')
    for (const input of [{ asOriginal: false, name: 'Eighties', id: EIGHTIES, replace: true }, { asOriginal: true, replace: true }, { asOriginal: false, name: 'x', replace: true }]) {
      assert.deepEqual(await registerIpod(a.mount, a.stateDir, input), { ok: false, error: 'This iPod is already set up.' })
    }
    assert.equal(await readFile(join(a.mount, 'iPod_Control', 'jaketunes-device.json'), 'utf-8'), before)
    // Another, blank iPod on the same Mac asks for the Original's id.
    const blank = join(a.root, 'OTHER')
    await mkdir(join(blank, 'iPod_Control', 'iTunes'), { recursive: true })
    const taken = await registerIpod(blank, a.stateDir, { asOriginal: false, name: 'Thief', id: original.ok ? original.device.id : '' })
    assert.deepEqual(taken, { ok: false, error: 'That list belongs to your original iPod.' })
    assert.equal(await stat(join(blank, 'iPod_Control', 'jaketunes-device.json')).then(() => true, () => false), false)
    // And "I checked it" is never the Original's.
    assert.match(((await sealOnboarding(a.stateDir, original.ok ? original.device : null!, '2026-11-20T17:00:00.000Z')) as { error: string }).error, /your Original/)
  })
  test('an ID file is never replaced by accident: without the confirmed move, a set-up iPod is "already set up"', async () => {
    const { mount, stateDir } = await freshCard()
    assert.equal((await registerIpod(mount, stateDir, { asOriginal: false, name: 'Y2K', id: Y2K })).ok, true)
    assert.deepEqual(await registerIpod(mount, stateDir, { asOriginal: false, name: 'Eighties', id: EIGHTIES }), { ok: false, error: 'This iPod is already set up.' })
    const id = await identifyIpod(mount, stateDir)
    assert.equal(id.status === 'known' && id.device.id, Y2K)
  })
})

describe('the test file', () => {
  const small = CARD_HEADROOM_BYTES + 3 * MB + 4321   // a test of 3 MB and a bit
  test('written, read back, removed; nothing else on the iPod is touched', async () => {
    const { mount } = await freshCard()
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount))
    const phases = new Set<string>()
    const r = await runCardTest(mount, guardOf(f), { quick: true, freeBytes: small, seed: 7, onProgress: (_d, _t, phase) => phases.add(phase) })
    assert.deepEqual(r, { ok: true, bytes: 3 * MB + 4321 })
    assert.deepEqual([...phases], ['write', 'read'])
    assert.deepEqual(await snapshot(mount), before)
  })
  test('one changed bit is caught, and the test still cleans up after itself', async () => {
    const { mount } = await freshCard()
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount))
    const r = await runCardTest(mount, guardOf(f), {
      quick: true, freeBytes: small, seed: 7,
      between: async (dir) => {
        const p = join(dir, 'jt-test-00000.bin')
        const b = await readFile(p)
        b[2 * MB + 5] ^= 0x01
        await writeFile(p, b)
      },
    })
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /test file 1 of 1 came back different 2 MB in/)
    assert.deepEqual(await snapshot(mount), before)
  })
  test('a card that wraps around (the last file lands on top of the first) is caught', async () => {
    const { mount } = await freshCard()
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount))
    let made: string[] = []
    const r = await runCardTest(mount, guardOf(f), {
      quick: false, freeBytes: CARD_HEADROOM_BYTES + 3 * MB, fileBytes: MB, seed: 9,
      between: async (dir) => {
        made = (await readdir(dir)).sort()
        await copyFile(join(dir, made.at(-1)!), join(dir, made[0]))
      },
    })
    assert.equal(made.length, 3)
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /test file 1 of 3 came back different 0 MB in/)
    assert.equal(await stat(join(mount, CARD_TEST_DIR)).then(() => true, () => false), false)
    assert.deepEqual(await snapshot(mount), before)
  })
  test('a symlink where the test folder goes is never followed: nothing lands outside the iPod', async () => {
    const { mount, root } = await freshCard()
    const outside = join(root, 'OUTSIDE')
    await mkdir(outside)
    await symlink(outside, join(mount, CARD_TEST_DIR))
    const f = await gatherIpodFacts(mount, deps(mount))
    const r = await runCardTest(mount, guardOf(f), { quick: true, freeBytes: small })
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /isn’t JakeTunes’ own test folder, so the test wasn’t written/)
    assert.deepEqual(await readdir(outside), [])
    assert.equal((await lstat(join(mount, CARD_TEST_DIR))).isSymbolicLink(), true, 'and the link itself is left alone')
    assert.equal(await cleanLeftoverTest(mount), 'symlink')
  })
  test('a test folder left by a kill is cleaned; one with someone else’s file in it is left', async () => {
    const { mount } = await freshCard()
    const dir = join(mount, CARD_TEST_DIR)
    await mkdir(dir)
    await writeFile(join(dir, 'jt-test-00000.bin'), Buffer.alloc(1000))
    await writeFile(join(dir, 'jt-test-00001.bin'), Buffer.alloc(1000))
    assert.equal(await cleanLeftoverTest(mount), 'cleaned')
    assert.equal(await stat(dir).then(() => true, () => false), false)
    assert.equal(await cleanLeftoverTest(mount), 'none')
    await mkdir(dir)
    await writeFile(join(dir, 'jt-test-00000.bin'), Buffer.alloc(10))
    await writeFile(join(dir, 'holiday.jpg'), 'theirs')
    assert.equal(await cleanLeftoverTest(mount), 'not-ours')
    assert.deepEqual(await readdir(dir), ['holiday.jpg'])
    const f = await gatherIpodFacts(mount, deps(mount))
    assert.equal((await runCardTest(mount, guardOf(f), { quick: true, freeBytes: small })).ok, false)
    assert.equal(await readFile(join(dir, 'holiday.jpg'), 'utf-8'), 'theirs')
  })
  test('the blocks are the same every time they are asked for, and different from each other', () => {
    assert.ok(testBlock(7, 0, 0).equals(testBlock(7, 0, 0)))
    assert.ok(!testBlock(7, 0, 0).equals(testBlock(7, 0, 1)))
    assert.ok(!testBlock(7, 0, 0).equals(testBlock(7, 1, 0)))
    assert.ok(!testBlock(7, 0, 0).equals(testBlock(8, 0, 0)))
    assert.equal(testBlock(7, 0, 0, 4321).length, 4321)
  })
  test('too little free space is said, and nothing is written', async () => {
    const { mount } = await freshCard()
    const before = await snapshot(mount)
    const f = await gatherIpodFacts(mount, deps(mount))
    const r = await runCardTest(mount, guardOf(f), { quick: true, freeBytes: 10 * MB })
    assert.deepEqual(r, { ok: false, bytes: 0, reason: 'there isn’t enough free space on the iPod to test' })
    assert.deepEqual(await snapshot(mount), before)
  })
})

describe('the record after set-up', () => {
  async function setUp() {
    const card = await freshCard(SYS_3G)
    const f = await gatherIpodFacts(card.mount, deps(card.mount), passed)
    const r = await prepareIpod(card.mount, card.stateDir, guardOf(f), { listId: EIGHTIES, name: "1980's", color: 'white', purpose: null, facts: f, now: '2026-11-20T15:00:00.000Z' })
    assert.equal(r.ok, true)
    const pool = join(card.stateDir, 'ipod-pools', EIGHTIES)
    await mkdir(pool, { recursive: true })
    return { ...card, pool, device: r.ok ? r.device : null! }
  }
  const manifest = (sealed: boolean) => JSON.stringify({ format: 2, syncedAt: '2026-11-20T16:30:00.000Z', status: sealed ? 'sealed' : 'in-flight', sealed, count: 193, tracks: Array.from({ length: 193 }, (_, i) => ({ id: i })) })

  test('"I checked it on the iPod" only counts after a sealed sync', async () => {
    const { stateDir, pool, device } = await setUp()
    assert.deepEqual(await sealOnboarding(stateDir, device, '2026-11-20T16:00:00.000Z'), { ok: false, error: "1980's hasn’t finished a sync yet. Sync it first, then check it." })
    await writeFile(join(pool, 'last-sync-manifest.json'), manifest(false))
    assert.equal((await sealOnboarding(stateDir, device, '2026-11-20T16:00:00.000Z')).ok, false)
    await writeFile(join(pool, 'last-sync-manifest.json'), manifest(true))
    assert.equal((await sealOnboarding(stateDir, device, '2026-11-20T17:00:00.000Z')).ok, true)
    const [rec] = await readOnboardingRecords(stateDir)
    assert.equal(rec.sealedAt, '2026-11-20T17:00:00.000Z')
    assert.equal(rec.lastSyncedAt, '2026-11-20T16:30:00.000Z')
    assert.equal(rec.lastSyncSongs, 193)
    assert.equal(rec.hardware, '3g')
    assert.equal(rec.history.at(-1)?.event, 'checked')
  })
  test('a sealed sync seen at plug-in goes onto the record; an unfinished one doesn’t', async () => {
    const { stateDir, pool, device } = await setUp()
    await writeFile(join(pool, 'last-sync-manifest.json'), manifest(false))
    await noteLastSync(stateDir, device)
    assert.equal((await readOnboardingRecords(stateDir))[0].lastSyncedAt, null)
    await writeFile(join(pool, 'last-sync-manifest.json'), manifest(true))
    await noteLastSync(stateDir, device)
    const [rec] = await readOnboardingRecords(stateDir)
    assert.equal(rec.lastSyncedAt, '2026-11-20T16:30:00.000Z')
    assert.equal(rec.sealedAt, null, 'seeing a sync is not Jake checking the iPod')
  })
  test('an iPod set up before records were kept (punkPod) is recorded as it is, already checked', async () => {
    const { mount, stateDir } = await freshCard()
    const PUNK = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
    assert.equal((await registerIpod(mount, stateDir, { asOriginal: false, name: 'punkPod', color: 'red', id: PUNK })).ok, true)
    await mkdir(join(stateDir, 'ipod-pools', PUNK), { recursive: true })
    await writeFile(join(stateDir, 'ipod-pools', PUNK, 'last-sync-manifest.json'), JSON.stringify({ sealed: true, syncedAt: '2026-11-08T18:00:00.000Z', tracks: Array.from({ length: 829 }, (_, i) => ({ id: i })) }))
    const f = await gatherIpodFacts(mount, deps(mount))
    const rec = await adoptExistingIpod(stateDir, f, '2026-11-13T12:00:00.000Z')
    assert.equal(rec?.name, 'punkPod')
    assert.equal(rec?.sealedAt, '2026-11-08T18:00:00.000Z')
    assert.equal(rec?.lastSyncSongs, 829)
    // Asked again, it changes nothing.
    const before = await readFile(join(stateDir, 'ipod-onboarding.json'), 'utf-8')
    await adoptExistingIpod(stateDir, f, '2026-11-14T12:00:00.000Z')
    assert.equal(await readFile(join(stateDir, 'ipod-onboarding.json'), 'utf-8'), before)
  })
})
