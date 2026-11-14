/**
 * Setting up a new iPod — the HANDLERS (ipc/ipod-onboarding-ipc.ts), driven the
 * way the app drives them, against folders in the temp dir standing in for
 * iPods. The Mac's own answers (which drive is this, what's on USB, is another
 * iPod plugged in) come from the test, so a drive can be swapped under a path.
 *
 * Every test here failed before the fix it pins (review of PR 414, 2026-11-14).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { mkdtemp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { registerIpodOnboardingIpc, type IpodOnboardingHost } from '../ipc/ipod-onboarding-ipc.ts'
import type { IpcRegistrar } from '../ipc-register.ts'
import { identifyIpod, registerIpod, resolveIpodState, setIpodSyncHealthGate } from '../ipod-identity.ts'
import { CARD_TEST_DIR, readOnboardingRecords } from '../ipod-onboarding.ts'
import { buildBlankCatalog } from '../ipod-blank-catalog.ts'
import { driveIdFromDiskutil } from '../ipod-onboarding-system.ts'
import { cardPlugged, flushCardProof, resetCardProof } from '../ipod-card-proof.ts'
import { confirmWriteOnCard } from '../ipod-sync-card.ts'
import type { IpodSetupLook, IpodUsbFacts } from '../../common/ipod-onboarding.ts'

const CORE = resolve(import.meta.dirname, '../../../core')
const EIGHTIES = '5e7f7a64-f770-48bd-a3dc-58bca2a6b716'
const Y2K = '842f4c4f-14f2-45b4-9c5d-32c1295604da'
const SYS_MINI = 'BoardHwName: iPod Q22B\nModelNumStr: M9803\nvisibleBuildID: 0x01418000 (1.4.1)\niPodFamily: 3\n'
const LISTS = [
  { id: EIGHTIES, name: "1980's", purpose: 'VH1 best of the 80s', cap: 1000, ids: [1, 2, 3], adds: [], removed: [], updatedAt: '2026-11-13T00:00:00.000Z', brain: { enabled: false, perDay: 0 }, model: '3g' },
  { id: Y2K, name: 'Y2K', purpose: null, cap: 1000, ids: [4, 5], adds: [], removed: [], updatedAt: '2026-11-13T00:00:00.000Z', brain: { enabled: false, perDay: 0 }, model: 'mini' },
]

interface Drive { id: string | null; usb: IpodUsbFacts | null; fs: string }
type Look = Extract<IpodSetupLook, { ok: true }>

/** A formatted card that has started up once in an iPod. */
async function card(dir: string, sysInfo: string | null = SYS_MINI): Promise<void> {
  await mkdir(join(dir, 'iPod_Control', 'iTunes'), { recursive: true })
  await writeFile(join(dir, 'iPod_Control', 'iTunes', 'iTunesPrefs'), Buffer.alloc(64))
  if (sysInfo !== null) {
    await mkdir(join(dir, 'iPod_Control', 'Device'), { recursive: true })
    await writeFile(join(dir, 'iPod_Control', 'Device', 'SysInfo'), sysInfo)
  }
}

async function snapshot(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out[`${r}/`] = 0; await walk(join(d, e.name), r) } else out[r] = e.isSymbolicLink() ? -1 : (await stat(join(d, e.name))).size
    }
  }
  await walk(dir, '')
  return out
}

/** The handlers, registered for real, with the Mac's answers supplied here. */
async function rig(over: { replica?: () => Promise<boolean> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jt-ipod-ipc-'))
  const mount = join(root, 'IPOD')
  const stateDir = join(root, 'state')
  await mkdir(stateDir)
  await card(mount)
  const drive: Drive = { id: 'AAAA1111-0000-0000-0000-000000000001|249500000000', usb: { vendor: 'Apple Inc.', productId: 0x1205, serial: '000A27001234ABCD' }, fs: 'msdos' }
  const state = { mounted: true as boolean, others: 0, sync: false, noTable: false, driveIdCalls: 0, driveIdAfter: null as { calls: number; id: string } | null, patches: [] as unknown[], changed: 0 }
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const ipc = { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handlers.set(ch, fn) } } as unknown as IpcRegistrar
  const host: IpodOnboardingHost = {
    stateDir,
    getMount: () => (state.mounted ? mount : null),
    followMount: () => undefined,
    isSyncInFlight: () => state.sync,
    onDeviceChanged: () => { state.changed++ },
    baseUrl: () => 'http://homemini.test:3000',
    libraryTracks: async () => [1, 2, 3, 4, 5].map((id) => ({ id, fileSize: 30_000_000 })),
    isReplica: over.replica ?? (async () => false),
    sleep: async () => undefined,
    system: {
      mountTable: async () => (state.noTable ? '' : `/dev/disk9s2 on ${mount} (${drive.fs}, local, nodev)\n`),
      driveId: async () => {
        state.driveIdCalls++
        if (state.driveIdAfter && state.driveIdCalls > state.driveIdAfter.calls) return state.driveIdAfter.id
        return drive.id
      },
      usb: async () => drive.usb,
      otherIpods: async () => state.others,
      renameVolume: async () => null,
    },
    fetchImpl: async (url, init) => {
      const u = String(url)
      const method = String((init as { method?: string } | undefined)?.method ?? 'GET')
      if (method === 'PATCH') { state.patches.push(JSON.parse(String((init as { body?: string }).body))); return { status: 200, json: async () => ({}) } }
      if (u.endsWith('/api/ipod-lists')) return { status: 200, json: async () => ({ lists: LISTS }) }
      return { status: 404, json: async () => ({}) }
    },
  }
  registerIpodOnboardingIpc(ipc, host)
  const call = <T = Record<string, unknown>>(ch: string, arg?: unknown): Promise<T> => Promise.resolve(handlers.get(ch)!({}, arg)) as Promise<T>
  const look = async (arg?: unknown): Promise<Look> => {
    const r = await call<IpodSetupLook>('ipod-setup:look', arg)
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    return r as Look
  }
  /** What the strip does when Jake picks a list: look, the test file (its own step), look again. */
  const pick = async (listId: string): Promise<Look> => {
    const first = await look({ listId })
    if (first.step.step === 'checks' && !first.step.blocked) await call('ipod-setup:test', { listId })
    return look({ listId })
  }
  /** Unplug, and plug a different blank card in at the same path, with the same name. */
  const swapCard = async (id: string, serial: string) => {
    await rename(mount, join(root, `OLD-${Date.now()}-${Math.random()}`))
    await card(mount)
    drive.id = id
    drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial }
  }
  return { root, mount, stateDir, drive, state, call, look, pick, swapCard, handlers }
}

/** A real song database on the card, written by the app's own catalog writer. */
async function writeSongs(mount: string, name: string, songs: Array<{ artist: string; path: string }>): Promise<void> {
  const db = join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')
  await writeFile(db, buildBlankCatalog(name))
  const tracks = songs.map((s, i) => ({ id: 500 + i, title: `Song ${i}`, artist: s.artist, album: 'A', genre: 'Rock', path: s.path, duration: 200000, year: 1999, trackNumber: 1, trackCount: 1, discNumber: 1, playCount: 0, fileSize: 10 }))
  for (const s of songs) {
    const file = join(mount, ...s.path.split(':').filter(Boolean))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'audio')
  }
  const r = spawnSync('python3', [join(CORE, 'db_reader.py'), '--write', db, '--template', db, '--ipod-root', mount], { input: JSON.stringify({ tracks, playlists: [], masterName: name }), encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
}
const paths = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `:iPod_Control:Music:F${String(i % 50).padStart(2, '0')}:${tag}${i}.m4a`)

describe('the road, through the handlers', () => {
  test('pick the list → the checks and the test file run by themselves → set up → first sync', async () => {
    const t = await rig()
    assert.equal((await t.look()).step.step, 'choose-list')
    const picked = await t.pick(EIGHTIES)
    assert.equal(picked.step.step, 'prepare', JSON.stringify(picked.step))
    assert.equal(picked.step.step === 'prepare' && picked.step.name, '80sPod')
    assert.equal(picked.cover?.model, 'mini', 'the list is drawn as a 3rd generation; this is a mini')
    assert.equal(await stat(join(t.mount, CARD_TEST_DIR)).then(() => true, () => false), false, 'the test file is gone again')
    const done = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: 'purple', typed: null, matchCover: true })
    assert.equal(done.ok, true, String(done.error))
    assert.deepEqual(t.state.patches, [{ color: 'purple', model: 'mini' }])
    const id = await identifyIpod(t.mount, t.stateDir)
    assert.equal(id.status === 'known' && id.device.id, EIGHTIES)
    assert.equal(id.status === 'known' && id.device.name, '80sPod')
    assert.equal((await t.look()).step.step, 'first-sync')
  })
})

describe('finding 1 + 7 + 9: one gate, and only the MacBook', () => {
  for (const [what, replica] of [['a replica', async () => true], ['a Mac that can’t say whether it is one', async () => { throw new Error('settings unreadable') }]] as const) {
    test(`${what}: every handler is refused, nothing is written to the iPod or to this Mac`, async () => {
      const t = await rig({ replica })
      const before = await snapshot(t.root)
      const seenStep = await t.look({ listId: EIGHTIES })
      assert.equal(seenStep.step.step === 'refused' && seenStep.step.why, 'not-the-hub')
      for (const [ch, arg] of [
        ['ipod-setup:test', { listId: EIGHTIES }], ['ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false }],
        ['ipod-setup:checked', undefined], ['ipod-setup:readopt-original', undefined], ['register-ipod-device', { asOriginal: true }],
      ] as const) {
        const r = await t.call(ch, arg)
        assert.equal(r.ok, false, ch)
        assert.match(String(r.error), /Only the MacBook/, ch)
      }
      assert.deepEqual(await snapshot(t.root), before)
    })
  }
  test('a replica looking at an iPod that is already set up writes no record on its own disk', async () => {
    const t = await rig({ replica: async () => true })
    assert.equal((await registerIpod(t.mount, t.stateDir, { asOriginal: false, name: 'punkPod', id: '0d8fc490-74d1-4232-9a35-1801a66f4fde' })).ok, true)
    await t.look()
    assert.deepEqual(await readOnboardingRecords(t.stateDir), [])
  })
  test('the test file is not written before the format and is-this-an-iPod checks pass', async () => {
    const wrongFormat = await rig()
    wrongFormat.drive.fs = 'exfat'
    const notAnIpod = await rig()
    await rename(join(notAnIpod.mount, 'iPod_Control'), join(notAnIpod.root, 'gone'))
    await mkdir(join(notAnIpod.mount, 'iPod_Control'))
    notAnIpod.drive.usb = null
    const noFormat = await rig()
    noFormat.state.noTable = true
    for (const [t, why] of [[wrongFormat, /The test file was not written/], [notAnIpod, /can’t tell that this drive is an iPod/], [noFormat, /The test file was not written/]] as const) {
      const before = await snapshot(t.mount)
      const looked = await t.look({ listId: EIGHTIES })
      assert.notEqual(looked.step.step, 'prepare')
      const r = await t.call('ipod-setup:test', { listId: EIGHTIES })
      assert.equal(r.ok, false)
      assert.match(String(r.error), why)
      assert.deepEqual(await snapshot(t.mount), before)
    }
  })
  test('the test file is not written with no list picked, or once the iPod is past its checks', async () => {
    const t = await rig()
    const before = await snapshot(t.mount)
    assert.match(String((await t.call('ipod-setup:test', {})).error), /only written while an iPod is being checked/)
    assert.deepEqual(await snapshot(t.mount), before)
  })
  test('the old register handler no longer sets up an iPod without the checks', async () => {
    const t = await rig()
    const before = await snapshot(t.root)
    const r = await t.call('register-ipod-device', { asOriginal: false, name: 'Sneaky', color: 'red' })
    assert.deepEqual(r, { ok: false, error: 'Use “Set up this iPod”. Nothing on the iPod was changed.' })
    assert.deepEqual(await snapshot(t.root), before)
    t.state.others = 1
    assert.match(String((await t.call('register-ipod-device', { asOriginal: true })).error), /Two iPods are plugged in/)
    assert.deepEqual(await snapshot(t.root), before)
  })
})

describe('finding 2 + 3: which drive', () => {
  test('a different blank drive at the same path, same name, after the checks: set-up does not write to it', async () => {
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    await t.swapCard('BBBB2222-0000-0000-0000-000000000002|249500000000', '000A2700FFFF0002')
    // The second card can't pass its own test file: with the first card's results it would be set up.
    await symlink(t.root, join(t.mount, CARD_TEST_DIR))
    const before = await snapshot(t.mount)
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })
    assert.equal(r.ok, false)
    assert.deepEqual(await snapshot(t.mount), before)
    const again = await t.pick(EIGHTIES)
    assert.equal(again.step.step, 'checks')
    assert.ok(again.step.step === 'checks' && again.step.checks.some((c) => c.id === 'write-test' && c.status === 'stop'), 'the first card’s passed test is not this card’s')
  })
  test('unplugged, then another new iPod with the same drive name: it starts from nothing', async () => {
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    t.state.mounted = false
    assert.equal((await t.look()).step.step, 'refused')
    await t.swapCard(t.drive.id!, '000A27001234ABCD')   // even a drive that reports the SAME id: unplugging forgets
    await symlink(t.root, join(t.mount, CARD_TEST_DIR))
    t.state.mounted = true
    const fresh = await t.look({ listId: EIGHTIES })
    assert.ok(fresh.step.step === 'checks' && fresh.step.checks.some((c) => c.id === 'write-test' && c.status === 'unknown'), 'the first iPod’s passed test is forgotten')
    const next = await t.pick(EIGHTIES)
    assert.ok(next.step.step === 'checks' && next.step.blocked)
  })
  test('the drive changes between the look and the first write: refused, untouched', async () => {
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    const before = await snapshot(t.mount)
    // The handler's own look still sees the first drive; the question asked right before writing does not.
    t.state.driveIdAfter = { calls: t.state.driveIdCalls + 1, id: 'CCCC3333-0000-0000-0000-000000000003|249500000000' }
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /isn’t the drive that was checked\. Start the set-up again/)
    assert.deepEqual(await snapshot(t.mount), before)
    assert.deepEqual(await readOnboardingRecords(t.stateDir), [])
  })
  test('the drive changes between two of set-up’s writes: the ID file is never written to the second drive', async () => {
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    t.state.driveIdAfter = { calls: t.state.driveIdCalls + 2, id: 'CCCC3333-0000-0000-0000-000000000003|249500000000' }
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /Already done: the folders are there/)
    assert.equal(await stat(join(t.mount, 'iPod_Control', 'jaketunes-device.json')).then(() => true, () => false), false)
    assert.equal(await stat(join(t.mount, 'iPod_Control', 'iTunes', 'iTunesDB')).then(() => true, () => false), false)
  })
  test('the drive changes right before the ID file (the card already has an empty database): no ID file is written', async () => {
    const t = await rig()
    await writeFile(join(t.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('iPod'))
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    t.state.driveIdAfter = { calls: t.state.driveIdCalls + 2, id: 'CCCC3333-0000-0000-0000-000000000003|249500000000' }
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /isn’t the drive that was checked.*Already done: the folders are there/)
    assert.equal(await stat(join(t.mount, 'iPod_Control', 'jaketunes-device.json')).then(() => true, () => false), false)
    assert.deepEqual(await readOnboardingRecords(t.stateDir), [])
  })
  test('a drive the Mac won’t identify is never written to', async () => {
    const t = await rig()
    t.drive.id = null
    t.drive.usb = null
    const before = await snapshot(t.mount)
    const looked = await t.look({ listId: EIGHTIES })
    assert.ok(looked.step.step === 'checks' && looked.step.checks.some((c) => c.id === 'drive' && c.status === 'stop'))
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, false)
    assert.deepEqual(await snapshot(t.mount), before)
  })
})

describe('finding 4: the Original without its ID file, and what a confirmation shows', () => {
  async function withOriginalOnRecord() {
    const t = await rig()
    const lastSync = paths(40, 'S')
    await writeFile(join(t.stateDir, 'ipod-devices.json'), JSON.stringify({ devices: [{ version: 1, id: 'original-1a2b3c4d', name: 'Original', color: null, purpose: 'My top 1000 songs', primary: true, createdAt: '2026-10-23T00:00:00.000Z' }] }))
    await writeFile(join(t.stateDir, 'last-sync-manifest.json'), JSON.stringify({ sealed: true, tracks: lastSync.map((destPath, id) => ({ id, destPath })) }))
    return { t, lastSync }
  }
  test('30 of its 40 songs are the last sync’s (too few for the automatic recognition): refused as a new iPod, re-adopted on its own button', async () => {
    const { t, lastSync } = await withOriginalOnRecord()
    await writeSongs(t.mount, 'JakeTunes', [...lastSync.slice(0, 30), ...paths(10, 'X')].map((path) => ({ artist: 'Geese', path })))
    assert.equal((await identifyIpod(t.mount, t.stateDir)).status, 'unknown')
    const before = await snapshot(t.mount)
    for (const arg of [undefined, { listId: EIGHTIES }, { listId: 'new', name: 'Mine' }]) {
      const l = await t.look(arg)
      assert.equal(l.step.step === 'refused' && l.step.why, 'looks-like-the-original')
      assert.match(l.step.step === 'refused' ? l.step.line : '', /30 of the songs on it are songs Original’s last sync put there/)
    }
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: 'replace JakeTunes', matchCover: false })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /won’t be set up as another iPod/)
    assert.deepEqual(await snapshot(t.mount), before)
    // The separate, explicit path.
    assert.equal((await t.call('ipod-setup:readopt-original')).ok, true)
    const id = await identifyIpod(t.mount, t.stateDir)
    assert.equal(id.status === 'known' && id.device.id, 'original-1a2b3c4d')
    assert.equal(id.status === 'known' && id.device.primary, true)
  })
  test('an iPod that is not the Original can’t be given the Original’s ID', async () => {
    const { t } = await withOriginalOnRecord()
    const before = await snapshot(t.mount)
    const r = await t.call('ipod-setup:readopt-original')
    assert.deepEqual(r, { ok: false, error: 'JakeTunes doesn’t recognise this iPod as your Original. Nothing on it was changed.' })
    assert.deepEqual(await snapshot(t.mount), before)
  })
  test('songs on a new iPod: the look shows the count, the artists and its old name, and the words to type name the OLD name', async () => {
    const t = await rig()
    await writeSongs(t.mount, 'Daves iPod', [
      ...paths(3, 'A').map((path) => ({ artist: 'Dave Matthews Band', path })), ...paths(2, 'B').map((path) => ({ artist: 'Phish', path })),
    ])
    const l = await t.pick(EIGHTIES)
    assert.equal(l.step.step, 'confirm', JSON.stringify(l.step))
    assert.equal(l.step.step === 'confirm' && l.step.phrase, 'replace Daves iPod')
    assert.deepEqual(l.step.step === 'confirm' && l.step.onIt, ['It calls itself “Daves iPod”.', '5 songs on it.', 'Mostly: Dave Matthews Band, Phish.'])
    // 8a: set-up does not go ahead while the step is "confirm" — not with nothing typed, not with the NEW name typed.
    const before = await snapshot(t.mount)
    for (const typed of [null, 'replace 80sPod', "replace 1980's"]) {
      const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed, matchCover: false })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /Type “replace Daves iPod” to go on/)
    }
    assert.deepEqual(await snapshot(t.mount), before)
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: 'replace Daves iPod', matchCover: false })).ok, true)
    assert.equal(await readFile(join(t.mount, 'iPod_Control', 'Music', 'F00', 'A0.m4a'), 'utf-8'), 'audio', 'set-up itself deletes no song')
  })
  test('8d: an iPod that carries one list is not moved to another without the typed words', async () => {
    const t = await rig()
    assert.equal((await t.pick(Y2K)).step.step, 'prepare')
    assert.equal((await t.call('ipod-setup:prepare', { listId: Y2K, name: null, color: null, typed: null, matchCover: false })).ok, true)
    const r = await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /Type “replace y2kPod” to go on/)
    const id = await identifyIpod(t.mount, t.stateDir)
    assert.equal(id.status === 'known' && id.device.id, Y2K)
  })
  test('8b: the Original is never checked off, set up or tested', async () => {
    const t = await rig()
    await writeFile(join(t.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('Original'))
    assert.equal((await t.call('register-ipod-device', { asOriginal: true })).ok, true)
    await writeFile(join(t.stateDir, 'last-sync-manifest.json'), JSON.stringify({ sealed: true, syncedAt: '2026-11-10T00:00:00.000Z', tracks: [{ id: 1, destPath: ':x' }] }))
    const before = await snapshot(t.mount)
    for (const [ch, arg] of [['ipod-setup:checked', undefined], ['ipod-setup:test', { listId: EIGHTIES }], ['ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: 'replace Original', matchCover: false }]] as const) {
      const r = await t.call(ch, arg)
      assert.equal(r.ok, false, ch)
      assert.match(String(r.error), /your Original/, ch)
    }
    assert.deepEqual(await snapshot(t.mount), before)
    assert.equal((await readOnboardingRecords(t.stateDir)).every((r) => r.sealedAt === null), true)
  })
})

describe('finding 5: a health stop stops the sync', () => {
  async function setUp() {
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, true)
    return t
  }
  const forSync = (t: { mount: string; stateDir: string }) => resolveIpodState(t.mount, t.stateDir, { forSync: true })
  test('a healthy iPod syncs', async () => {
    const t = await setUp()
    assert.equal((await forSync(t)).refusal, null)
  })
  test('the card in a different iPod body: refused with the reason, and never re-bound', async () => {
    const t = await setUp()
    t.drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial: 'FFFF0000EEEE1111' }
    const r = await forSync(t)
    assert.match(r.refusal ?? '', /it is in a different iPod than the one set up on .*The sync was not started\./)
    assert.equal(r.device?.id, EIGHTIES)
    assert.equal((await readOnboardingRecords(t.stateDir))[0].serial, '000A27001234ABCD', 'the record still names the body it was set up in')
    // Asking where its state lives (not a sync) is not refused.
    assert.equal((await resolveIpodState(t.mount, t.stateDir)).refusal, null)
  })
  test('a different card, a drive that is no longer an iPod’s format, a database that can’t be read', async () => {
    const size = await setUp()
    const recs = await readOnboardingRecords(size.stateDir)
    await writeFile(join(size.stateDir, 'ipod-onboarding.json'), JSON.stringify({ version: 1, devices: [{ ...recs[0], capacityBytes: 1000 }] }))
    assert.match((await forSync(size)).refusal ?? '', /That is a different card/)

    const format = await setUp()
    format.drive.fs = 'exfat'
    assert.match((await forSync(format)).refusal ?? '', /no longer formatted the way an iPod needs/)

  })
  test('a database that can’t be read is NOT a dead end: the sync goes ahead as the repair, and the look says why (the Original too)', async () => {
    const torn = await setUp()
    await writeFile(join(torn.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), Buffer.from('not a song database at all'))
    assert.equal((await forSync(torn)).refusal, null)
    const said = (await torn.look()).health?.checks.find((c) => c.id === 'database')
    assert.equal(said?.status, 'warn')
    assert.match(said?.line ?? '', /can’t be read\. The next sync rewrites it, as a full copy\./)

    const original = await rig()
    await writeFile(join(original.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('Original'))
    assert.equal((await original.call('register-ipod-device', { asOriginal: true })).ok, true)
    await writeFile(join(original.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), Buffer.from('torn'))
    assert.equal((await forSync(original)).refusal, null)
  })
  test('the Original is never stopped by a serial or size on record that no longer matches', async () => {
    const t = await rig()
    await writeFile(join(t.mount, 'iPod_Control', 'iTunes', 'iTunesDB'), buildBlankCatalog('Original'))
    assert.equal((await t.call('register-ipod-device', { asOriginal: true })).ok, true)
    await t.look()   // records the Original: serial and size
    const [rec] = await readOnboardingRecords(t.stateDir)
    assert.equal(rec.serial, '000A27001234ABCD')
    await writeFile(join(t.stateDir, 'ipod-onboarding.json'), JSON.stringify({ version: 1, devices: [{ ...rec, capacityBytes: 1000 }] }))
    t.drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial: 'FFFF0000EEEE1111' }
    assert.equal((await forSync(t)).refusal, null)
    assert.equal((await t.look()).sameIpod ?? null, null)
  })
  test('a health check that couldn’t see what it checks does not let the sync go', async () => {
    const usb = await setUp()
    usb.drive.usb = null
    assert.match((await forSync(usb)).refusal ?? '', /couldn’t check 80sPod before syncing: the Mac wouldn’t say which iPod body this is.*The sync was not started\./)
    const table = await setUp()
    table.state.noTable = true
    assert.match((await forSync(table)).refusal ?? '', /the Mac wouldn’t say how the drive is formatted/)
  })
  test('the same iPod with a new body or a new card: old and new shown, the typed words, then the record follows; never by itself', async () => {
    for (const change of ['body', 'card'] as const) {
      const t = await setUp()
      if (change === 'body') t.drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial: 'FFFF0000EEEE1111' }
      else {
        const recs = await readOnboardingRecords(t.stateDir)
        await writeFile(join(t.stateDir, 'ipod-onboarding.json'), JSON.stringify({ version: 1, devices: [{ ...recs[0], capacityBytes: 128e9 }] }))
      }
      assert.notEqual((await forSync(t)).refusal, null)
      const offer = (await t.look()).sameIpod
      assert.equal(offer?.phrase, 'this is 80sPod')
      assert.match(offer?.lines[0] ?? '', change === 'body' ? /When 80sPod was set up: serial 000A27001234ABCD/ : /When 80sPod was set up: serial 000A27001234ABCD, 128 GB/)
      assert.match(offer?.lines[1] ?? '', change === 'body' ? /Plugged in now: serial FFFF0000EEEE1111/ : /Plugged in now: serial 000A27001234ABCD/)
      const before = await readFile(join(t.stateDir, 'ipod-onboarding.json'), 'utf-8')
      for (const typed of [undefined, '', 'yes', 'replace 80sPod', 'this is punkPod']) {
        const r = await t.call('ipod-setup:same-ipod', { typed })
        assert.equal(r.ok, false)
        assert.match(String(r.error), /Type “this is 80sPod” to confirm/)
      }
      assert.equal(await readFile(join(t.stateDir, 'ipod-onboarding.json'), 'utf-8'), before)
      assert.notEqual((await forSync(t)).refusal, null, 'still stopped: nothing re-binds by itself')
      const cardBefore = await snapshot(t.mount)
      assert.equal((await t.call('ipod-setup:same-ipod', { typed: 'this is 80sPod' })).ok, true)
      assert.deepEqual(await snapshot(t.mount), cardBefore, 'the iPod itself is not written')
      assert.equal((await forSync(t)).refusal, null)
      const [rec] = await readOnboardingRecords(t.stateDir)
      assert.equal(rec.history.at(-1)?.event, 'new-card-or-body')
      assert.equal(rec.listId, EIGHTIES)
      if (change === 'body') assert.equal(rec.serial, 'FFFF0000EEEE1111')
      // Nothing left to confirm.
      assert.match(String((await t.call('ipod-setup:same-ipod', { typed: 'this is 80sPod' })).error), /nothing to confirm/)
    }
  })
  test('the sync itself asks with forSync (the one line in the sync engine), so the stop reaches it', async () => {
    const src = await readFile(resolve(import.meta.dirname, '../sync-engine/index.ts'), 'utf-8')
    const asks = src.match(/resolveIpodState\(gateMount, STATE_DIR[^)]*\)/g) ?? []
    assert.deepEqual(asks, ['resolveIpodState(gateMount, STATE_DIR, { forSync: true })'])
  })
  test('a check that itself fails refuses the sync and says so', async () => {
    const t = await setUp()
    setIpodSyncHealthGate(async () => { throw new Error('diskutil timed out') })
    try {
      assert.equal((await forSync(t)).refusal, 'JakeTunes couldn’t check 80sPod before syncing (diskutil timed out). The sync was not started.')
    } finally {
      setIpodSyncHealthGate(null)
    }
  })
})

describe('re-review: a look never writes; a drive with no ID of its own; the card check', () => {
  test('the look writes nothing to the iPod, even with a list picked and every check ready to run', async () => {
    const t = await rig()
    const before = await snapshot(t.mount)
    for (const arg of [undefined, { listId: EIGHTIES }, { listId: EIGHTIES, recheck: true }, { listId: 'new', name: 'Mine' }]) await t.look(arg)
    const l = await t.look({ listId: EIGHTIES })
    assert.ok(l.step.step === 'checks' && !l.step.blocked && l.step.checks.some((c) => c.id === 'write-test' && c.status === 'unknown'))
    assert.deepEqual(await snapshot(t.mount), before)
  })
  test('a volume with the all-zero ID: known by its USB serial and size instead; with neither, it stops', async () => {
    assert.equal(driveIdFromDiskutil('<key>VolumeUUID</key>\n<string>00000000-0000-0000-0000-000000000000</string><key>TotalSize</key><integer>249500000000</integer>'), null)
    assert.equal(driveIdFromDiskutil('<key>TotalSize</key><integer>249500000000</integer>'), null)
    assert.equal(driveIdFromDiskutil('<key>VolumeUUID</key>\n<string>0A1B0000-0000-0000-0000-000000000000</string><key>TotalSize</key><integer>5</integer>'), '0A1B0000-0000-0000-0000-000000000000|5')
    const t = await rig()
    t.drive.id = null   // what the system layer answers for an all-zero or missing UUID
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    // Another iPod body at the same path: not the drive that was checked.
    t.drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial: 'FFFF0000EEEE1111' }
    const before = await snapshot(t.mount)
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, false)
    assert.deepEqual(await snapshot(t.mount), before)
    t.drive.usb = { vendor: 'Apple Inc.', productId: 0x1205, serial: '000A27001234ABCD' }
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, true)
  })
  test('the card check: the first and last songs the first sync wrote are read back after a replug, and decide the seal', async () => {
    resetCardProof()
    const t = await rig()   // registering the handlers turns the collector on for unsealed iPods
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, true)
    cardPlugged()
    // The "sync": 40 songs copied and confirmed the way every engine confirms them.
    const src = join(t.root, 'library')
    await mkdir(src)
    const dsts: string[] = []
    for (let i = 0; i < 40; i++) {
      const from = join(src, `song${i}.m4a`)
      const to = join(t.mount, 'iPod_Control', 'Music', `F${String(i % 50).padStart(2, '0')}`, `S${i}.m4a`)
      await writeFile(from, Buffer.from(`audio of song ${i} `.repeat(200)))
      await writeFile(to, await readFile(from))
      assert.equal((await confirmWriteOnCard(from, to)).ok, true)
      dsts.push(to)
    }
    await mkdir(join(t.stateDir, 'ipod-pools', EIGHTIES), { recursive: true })
    await writeFile(join(t.stateDir, 'ipod-pools', EIGHTIES, 'last-sync-manifest.json'), JSON.stringify({ sealed: true, syncedAt: '2026-11-20T16:30:00.000Z', tracks: dsts.map((_, id) => ({ id })) }))
    assert.equal((await t.look()).step.step, 'proof')
    // Not replugged yet: it says so, and the set-up can't be sealed on it.
    const waiting = await t.call<{ cardProof: { status: string; line: string } }>('ipod-setup:card-proof')
    assert.equal(waiting.cardProof.status, 'waiting')
    assert.match(String((await t.call('ipod-setup:checked')).error), /Unplug the iPod and plug it back in/)
    cardPlugged()
    // A card that wrapped: an EARLY song now holds a late song's bytes (same length).
    const good = await readFile(dsts[2])
    await writeFile(dsts[2], Buffer.from(good.toString().replace(/song 2 /g, 'song 9 ')))
    const failed = await t.call<{ cardProof: { status: string; line: string } }>('ipod-setup:card-proof')
    assert.equal(failed.cardProof.status, 'fail')
    assert.match(failed.cardProof.line, /1 of the 30 songs read back came back different/)
    const refused = await t.call('ipod-setup:checked')
    assert.equal(refused.ok, false)
    assert.equal((await readOnboardingRecords(t.stateDir))[0].sealedAt, null)
    // Sound again: it passes, and only now does "Both are right" seal the set-up.
    await writeFile(dsts[2], good)
    assert.equal((await t.call<{ cardProof: { status: string } }>('ipod-setup:card-proof')).cardProof.status, 'pass')
    assert.equal((await t.call('ipod-setup:checked')).ok, true)
    assert.notEqual((await readOnboardingRecords(t.stateDir))[0].sealedAt, null)
    resetCardProof()
  })
  test('no record of the copy: the card check says it couldn’t run (it does not pass), and the play test stands', async () => {
    resetCardProof()
    const t = await rig()
    assert.equal((await t.pick(EIGHTIES)).step.step, 'prepare')
    assert.equal((await t.call('ipod-setup:prepare', { listId: EIGHTIES, name: null, color: null, typed: null, matchCover: false })).ok, true)
    await mkdir(join(t.stateDir, 'ipod-pools', EIGHTIES), { recursive: true })
    await writeFile(join(t.stateDir, 'ipod-pools', EIGHTIES, 'last-sync-manifest.json'), JSON.stringify({ sealed: true, syncedAt: '2026-11-20T16:30:00.000Z', tracks: [{ id: 1 }] }))
    const r = await t.call<{ cardProof: { status: string; line: string } }>('ipod-setup:card-proof')
    assert.equal(r.cardProof.status, 'none')
    assert.match(r.cardProof.line, /couldn’t run/)
    assert.equal((await t.call('ipod-setup:checked')).ok, true)
    resetCardProof()
  })
  test('a sealed iPod’s ordinary syncs are not sampled', async () => {
    resetCardProof()
    const t = await rig()
    assert.equal((await registerIpod(t.mount, t.stateDir, { asOriginal: false, name: 'punkPod', id: '0d8fc490-74d1-4232-9a35-1801a66f4fde' })).ok, true)
    const from = join(t.root, 'a.m4a')
    const to = join(t.mount, 'iPod_Control', 'Music', 'F00', 'A.m4a')
    await mkdir(dirname(to), { recursive: true })
    await writeFile(from, 'x'); await writeFile(to, 'x')
    assert.equal((await confirmWriteOnCard(from, to)).ok, true)
    await flushCardProof()
    assert.equal(await stat(join(t.stateDir, 'ipod-card-proof.json')).then(() => true, () => false), false)
    resetCardProof()
  })
})

describe('finding 6: the test folder', () => {
  test('a symlink named like the test folder: the look’s own test writes nothing outside the iPod, and the set-up stops', async () => {
    const t = await rig()
    const outside = join(t.root, 'OUTSIDE')
    await mkdir(outside)
    await symlink(outside, join(t.mount, CARD_TEST_DIR))
    const l = await t.pick(EIGHTIES)
    assert.ok(l.step.step === 'checks' && l.step.blocked)
    assert.deepEqual(await readdir(outside), [])
  })
  test('a test folder left by a kill mid-test is cleaned by the next test', async () => {
    const t = await rig()
    await mkdir(join(t.mount, CARD_TEST_DIR))
    await writeFile(join(t.mount, CARD_TEST_DIR, 'jt-test-00000.bin'), Buffer.alloc(5000))
    const l = await t.pick(EIGHTIES)
    assert.equal(l.step.step, 'prepare')
    assert.equal(await stat(join(t.mount, CARD_TEST_DIR)).then(() => true, () => false), false)
  })
})
