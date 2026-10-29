/** iPod plays are never lost (2026-10-28) — archive-before-retire, ingest-before-wipe,
 *  the refusal path, unique tmp names, and archive re-ingest. Fake cards in temp dirs;
 *  no real iPod, no real state. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'fs/promises'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PLAYS_ARCHIVE_DIR,
  applyArchiveReingest,
  archiveIpodScratch,
  listPlaysArchives,
  loadPlaysArchive,
  planArchiveReingest,
  scratchAlreadyArchived,
  securePlaysBeforeSync,
} from '../ipod-plays-archive.ts'
import { retireIpodFirmwareScratch } from '../ipod-sync-card.ts'
import {
  ROUNDTRIP_LEDGER_FILE,
  ROUNDTRIP_STATE_FILE,
  ingestIpodRoundTrip,
  readRoundTripState,
  uniqueTmpPath,
  type RoundTripHost,
} from '../sync-engine/roundtrip.ts'
import { identifyIpod } from '../ipod-identity.ts'

const MAC_EPOCH = 2082844800

function playCounts(entries: Array<{ plays: number; unixS?: number }>): Buffer {
  const headerLen = 96
  const entryLen = 16
  const b = Buffer.alloc(headerLen + entries.length * entryLen)
  b.write('mhdp', 0, 'latin1')
  b.writeUInt32LE(headerLen, 4)
  b.writeUInt32LE(entryLen, 8)
  b.writeUInt32LE(entries.length, 12)
  entries.forEach((e, i) => {
    b.writeUInt32LE(e.plays, headerLen + i * entryLen)
    b.writeUInt32LE(e.unixS ? e.unixS + MAC_EPOCH : 0, headerLen + i * entryLen + 4)
  })
  return b
}

// Same synthetic iTunesDB as ipod-roundtrip.test.ts (catalog paths only).
function db(paths: string[]): Buffer {
  const mhits = paths.map((p) => {
    const str = Buffer.from(p, 'utf16le')
    const m = Buffer.alloc(0x28 + str.length)
    m.write('mhod', 0, 'latin1'); m.writeUInt32LE(0x18, 4); m.writeUInt32LE(m.length, 8)
    m.writeUInt32LE(2, 12); m.writeUInt32LE(str.length, 0x1c); str.copy(m, 0x28)
    const b = Buffer.alloc(156 + m.length)
    b.write('mhit', 0, 'latin1'); b.writeUInt32LE(156, 4); b.writeUInt32LE(b.length, 8); b.writeUInt32LE(1, 12)
    m.copy(b, 156)
    return b
  })
  const tracksLen = mhits.reduce((n, b) => n + b.length, 0)
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(mhits.length, 8)
  const sec1 = Buffer.alloc(96); sec1.write('mhsd', 0, 'latin1'); sec1.writeUInt32LE(96, 4)
  sec1.writeUInt32LE(96 + 92 + tracksLen, 8); sec1.writeUInt32LE(1, 12)
  const head = Buffer.alloc(104); head.write('mhbd', 0, 'latin1'); head.writeUInt32LE(104, 4)
  return Buffer.concat([head, sec1, mhlt, ...mhits])
}

const PATHS = [':iPod_Control:Music:F00:A.m4a', ':iPod_Control:Music:F01:B.m4a', ':iPod_Control:Music:F02:C.m4a']
const IDS = [101, 202, 303]
const manifest = { tracks: PATHS.map((destPath, i) => ({ id: IDS[i], destPath })) }
const exists = (p: string) => stat(p).then(() => true, () => false)

async function fixture(opts: { plays?: number[]; manifest?: unknown; otg?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ipod-plays-'))
  const mount = join(root, 'JAKETUNES')
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  const state = join(root, 'state')
  await mkdir(itunes, { recursive: true })
  await mkdir(state)
  await writeFile(join(itunes, 'iTunesDB'), db(PATHS))
  await writeFile(join(itunes, 'Play Counts'), playCounts((opts.plays ?? [2, 0, 5]).map((plays) => ({ plays, unixS: 1_761_600_000 }))))
  if (opts.otg) {
    const o = Buffer.alloc(20 + 8); o.write('mhpo', 0, 'latin1'); o.writeUInt32LE(20, 4); o.writeUInt32LE(2, 16)
    o.writeUInt32LE(2, 20); o.writeUInt32LE(0, 24)
    await writeFile(join(itunes, 'OTGPlaylistInfo'), o)
  }
  if (opts.manifest !== null) await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(opts.manifest ?? manifest))
  const events: string[] = []
  const sent: unknown[] = []
  const playEvents: Array<{ id: number; count: number }> = []
  const host: RoundTripHost = {
    stateDir: state,
    getLibraryTracks: async () => IDS.map((id) => ({ id, playCount: 10, lastPlayedAt: 0 })),
    appendPlayEvents: async (id, count) => {
      events.push(`play-events:${id}`)
      // Ordering probe: when a play event is written, the card's Play Counts still exists.
      events.push(`playcounts-on-card:${await exists(join(itunes, 'Play Counts'))}`)
      playEvents.push({ id, count })
    },
    sendToRenderer: (_ch, payload) => { sent.push(payload) },
    isSyncInFlight: () => false,
  }
  return { root, mount, itunes, state, host, events, sent, playEvents }
}

describe('archive before retire — a retire with no archive is impossible', () => {
  test('retire copies Play Counts, OTG, iTunesDB and the manifest before deleting', async () => {
    const f = await fixture({ otg: true })
    const pcBytes = await readFile(join(f.itunes, 'Play Counts'))
    const n = await retireIpodFirmwareScratch(f.mount, { stateDir: f.state, reason: 'test' })
    assert.equal(n, 2)
    assert.equal(await exists(join(f.itunes, 'Play Counts')), false)
    assert.equal(await exists(join(f.itunes, 'OTGPlaylistInfo')), false)
    const archives = await listPlaysArchives(f.state)
    assert.equal(archives.length, 1)
    const dir = archives[0].dir
    assert.ok(dir.startsWith(join(f.state, PLAYS_ARCHIVE_DIR)))
    assert.deepEqual(await readFile(join(dir, 'iTunes', 'Play Counts')), pcBytes)
    assert.ok(await exists(join(dir, 'iTunes', 'OTGPlaylistInfo')))
    assert.ok(await exists(join(dir, 'iTunes', 'iTunesDB')))
    assert.ok(await exists(join(dir, 'last-sync-manifest.json')))
    assert.deepEqual(archives[0].meta.card.map((c) => c.name).sort(), ['OTGPlaylistInfo', 'Play Counts', 'iTunesDB'])
  })

  test('when no copy can be made, nothing is deleted', async () => {
    const f = await fixture()
    const blocked = join(f.root, 'not-a-dir')
    await writeFile(blocked, 'a file where the state dir should be')
    const n = await retireIpodFirmwareScratch(f.mount, { stateDir: blocked, reason: 'test' })
    assert.equal(n, 0)
    assert.ok(await exists(join(f.itunes, 'Play Counts')), 'Play Counts must survive a failed archive')
  })

  test('the same bytes are not archived twice; new bytes are', async () => {
    const f = await fixture()
    await archiveIpodScratch(f.mount, f.state, 'gate')
    await retireIpodFirmwareScratch(f.mount, { stateDir: f.state, reason: 'after wipe' })
    assert.equal((await listPlaysArchives(f.state)).length, 1, 'the gate copy covers the retire')
    await writeFile(join(f.itunes, 'Play Counts'), playCounts([{ plays: 9 }]))
    await retireIpodFirmwareScratch(f.mount, { stateDir: f.state, reason: 'mid-sync rewrite' })
    assert.equal((await listPlaysArchives(f.state)).length, 2)
  })

  test('scratchAlreadyArchived is by name AND bytes', () => {
    const archives = [{ dir: '/a', meta: { version: 1 as const, archivedAt: '', reason: '', mount: '', manifest: true, card: [{ name: 'Play Counts', bytes: 1, sha1: 'x' }] } }]
    assert.equal(scratchAlreadyArchived([{ name: 'Play Counts', sha1: 'x' }], archives), '/a')
    assert.equal(scratchAlreadyArchived([{ name: 'Play Counts', sha1: 'y' }], archives), null)
    assert.equal(scratchAlreadyArchived([{ name: 'OTGPlaylistInfo', sha1: 'x' }], archives), null)
  })

  test('every retire call site passes a state dir (no bare retire left)', () => {
    for (const rel of ['../ipod-activity-engine.ts', '../sync-engine/index.ts', '../index.ts']) {
      const src = readFileSync(join(import.meta.dirname, rel), 'utf-8')
      assert.equal(/retireIpodFirmwareScratch\([^,()]+\)/.test(src), false, `${rel} has a one-argument retire`)
    }
  })
})

describe('ingest before wipe', () => {
  test('the gate brings plays home and records the snapshot while Play Counts is still on the card', async () => {
    const f = await fixture()
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, true)
    assert.equal(r.outcome?.kind, 'brought-home')
    assert.deepEqual(f.playEvents, [{ id: 101, count: 2 }, { id: 303, count: 5 }])
    assert.ok(f.events.every((e) => e !== 'playcounts-on-card:false'))
    const state = await readRoundTripState(f.state)
    assert.ok(state?.snapshot)
    assert.deepEqual(state?.ingested, { 101: 2, 303: 5 })
    // Then the "sync" wipes: the plays are already home and a copy is kept.
    await retireIpodFirmwareScratch(f.mount, { stateDir: f.state, reason: 'after wipe' })
    assert.equal((await listPlaysArchives(f.state)).length, 1)
    const ledger = await readFile(join(f.state, ROUNDTRIP_LEDGER_FILE), 'utf-8')
    assert.match(ledger, /"kind":"roundtrip"/)
  })

  test('plug-in then gate: the gate sees nothing new and does not double count', async () => {
    const f = await fixture()
    const first = await ingestIpodRoundTrip(f.mount, f.host)
    assert.equal(first.kind, 'brought-home')
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, true)
    assert.equal(r.outcome?.kind, 'nothing-new')
    assert.equal(f.playEvents.length, 2)
  })

  test('zero plays and no manifest is not a reason to stop', async () => {
    const f = await fixture({ plays: [0, 0, 0], manifest: null })
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, true)
    assert.equal(r.outcome?.kind, 'no-plays')
  })

  test('no scratch on the card: nothing to keep, sync goes ahead', async () => {
    const f = await fixture()
    await retireIpodFirmwareScratch(f.mount, { stateDir: f.state, reason: 'setup' })
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, true)
    assert.equal(r.outcome?.kind, 'nothing-on-card')
  })

  test('every sync path runs the gate before its first card write (source order)', () => {
    const eng = readFileSync(join(import.meta.dirname, '../sync-engine/index.ts'), 'utf-8')
    const body = eng.slice(eng.indexOf('async function runSyncToIpod('))
    const gate = body.indexOf('securePlaysBeforeSync(')
    assert.ok(gate > 0, 'runSyncToIpod must call securePlaysBeforeSync')
    assert.ok(gate < body.indexOf('runActivitySync('), 'gate before the activity engine')
    assert.ok(gate < body.indexOf('retireScratch('), 'gate before any retire')
    assert.ok(gate < body.indexOf('unlink('), 'gate before any delete')
    const idx = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf-8')
    const mirror = idx.slice(idx.indexOf('function scheduleDbRebuild('))
    assert.ok(mirror.indexOf('securePlaysBeforeSync(') > 0)
    assert.ok(mirror.indexOf('securePlaysBeforeSync(') < mirror.indexOf('unlinkFS('), 'delete mirror: gate before delete')
  })
})

describe('refusal path — plays that cannot be mapped stop the sync before the card is touched', () => {
  test('no manifest: stops, says why in plain words, card untouched, copy kept', async () => {
    const f = await fixture({ manifest: null })
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, false)
    assert.ok(!r.ok && /stopped before touching the iPod/.test(r.error))
    assert.ok(!r.ok && /7 plays/.test(r.error))
    assert.ok(!r.ok && /no record of what the last sync put on this iPod/.test(r.error))
    assert.ok(await exists(join(f.itunes, 'Play Counts')))
    assert.ok(r.archiveDir && await exists(join(r.archiveDir, 'iTunes', 'Play Counts')))
    assert.equal(await exists(join(f.state, ROUNDTRIP_STATE_FILE)), false)
  })

  test('unreadable catalog: stops', async () => {
    const f = await fixture()
    await writeFile(join(f.itunes, 'iTunesDB'), Buffer.from('not a catalog at all, really'))
    const r = await securePlaysBeforeSync(f.mount, f.host, 'library sync')
    assert.equal(r.ok, false)
    assert.ok(!r.ok && /song list \(iTunesDB\) can’t be read/.test(r.error))
  })

  test('a stopped sync’s in-flight manifest does not strand the plays: the archived manifest for this catalog maps them', async () => {
    const f = await fixture({ plays: [1, 0, 0] })
    // Sync 1: gate records 1 play and keeps a copy (with the good manifest)…
    assert.equal((await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')).ok, true)
    // …then stops after writing its in-flight manifest (no destPaths). Jake plays more.
    await writeFile(join(f.state, 'last-sync-manifest.json'), JSON.stringify({ status: 'in-flight', tracks: IDS.map((id) => ({ id })) }))
    await writeFile(join(f.itunes, 'Play Counts'), playCounts([{ plays: 3 }, { plays: 0 }, { plays: 4 }]))
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.equal(r.ok, true)
    assert.equal(r.outcome?.kind, 'brought-home')
    assert.deepEqual(f.playEvents.slice(1), [{ id: 101, count: 2 }, { id: 303, count: 4 }])
  })
})

describe('unique tmp names + serialized ID adoption', () => {
  test('uniqueTmpPath never repeats within a process', () => {
    const seen = new Set(Array.from({ length: 200 }, () => uniqueTmpPath('/x/jaketunes-device.json')))
    assert.equal(seen.size, 200)
    for (const p of seen) assert.match(p, new RegExp(`^/x/jaketunes-device\\.json\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`))
  })

  test('two concurrent first looks at the Original adopt it once, and both see it as known', async () => {
    const f = await fixture()
    const [a, b, c] = await Promise.all([
      identifyIpod(f.mount, f.state), identifyIpod(f.mount, f.state), identifyIpod(f.mount, f.state),
    ])
    for (const x of [a, b, c]) assert.equal(x.status, 'known')
    const ids = new Set([a, b, c].map((x) => x.status === 'known' ? x.device.id : ''))
    assert.equal(ids.size, 1, 'one adoption, one ID')
    const onCard = JSON.parse(await readFile(join(f.mount, 'iPod_Control', 'jaketunes-device.json'), 'utf-8'))
    assert.equal(onCard.id, [...ids][0])
    const leftovers = (await readdir(join(f.mount, 'iPod_Control'))).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    const reg = JSON.parse(await readFile(join(f.state, 'ipod-devices.json'), 'utf-8'))
    assert.equal(reg.devices.length, 1)
  })
})

describe('archive re-ingest', () => {
  test('an archive nobody ingested comes home once; the live state is never touched', async () => {
    const f = await fixture()
    const { dir } = await archiveIpodScratch(f.mount, f.state, 'kept by hand')
    // The live state belongs to a newer catalog.
    const live = { generation: 'newer', snapshot: 'other', ingested: { 101: 1 } }
    await writeFile(join(f.state, ROUNDTRIP_STATE_FILE), JSON.stringify(live))

    const a = await loadPlaysArchive(dir)
    const v = planArchiveReingest(a, live, '')
    assert.equal(v.kind, 'plan')
    if (v.kind !== 'plan') return
    assert.deepEqual(v.plan.deltas.map((d) => [d.id, d.delta]), [[101, 2], [303, 5]])

    const out = await applyArchiveReingest(dir, v.plan, f.host)
    assert.equal(out.kind, 'brought-home')
    assert.deepEqual(JSON.parse(await readFile(join(f.state, ROUNDTRIP_STATE_FILE), 'utf-8')), live)
    const ledger = await readFile(join(f.state, ROUNDTRIP_LEDGER_FILE), 'utf-8')
    assert.match(ledger, /"kind":"roundtrip-reingest"/)

    const again = planArchiveReingest(await loadPlaysArchive(dir), live, ledger)
    assert.equal(again.kind, 'already-home')
  })

  test('the gate’s own archive is already home', async () => {
    const f = await fixture()
    const r = await securePlaysBeforeSync(f.mount, f.host, 'Activity Sync')
    assert.ok(r.archiveDir)
    const v = planArchiveReingest(await loadPlaysArchive(r.archiveDir!), await readRoundTripState(f.state), '')
    assert.equal(v.kind, 'already-home')
  })

  test('a ledger line with the snapshot also counts as home', async () => {
    const f = await fixture()
    const { dir } = await archiveIpodScratch(f.mount, f.state, 'kept by hand')
    const a = await loadPlaysArchive(dir)
    const v1 = planArchiveReingest(a, null, '')
    assert.equal(v1.kind, 'plan')
    if (v1.kind !== 'plan') return
    const ledger = JSON.stringify({ kind: 'roundtrip', snapshot: v1.plan.snapshot.slice(0, 12) })
    assert.equal(planArchiveReingest(a, null, ledger).kind, 'already-home')
  })
})
