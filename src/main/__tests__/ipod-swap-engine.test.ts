/**
 * Swap-only sync, end to end on a FAKE card in a temp folder (2026-11-07).
 * The real activity engine, the real core/db_reader.py writer, the real
 * conform/contiguity passes and the real itdb_verify.py validator; only the
 * cold remount is stubbed (a temp folder has no device node — and the real
 * one would unmount the Mac's own disk). Never touches an iPod.
 *
 * Jake: "with that sync, it shouldnt wipe the ipod and start the 1000 from
 * scratch, it should just swap out the songs that they are being replaced with".
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { onCardByRecord, readCardState, runActivitySync, type ActivitySyncHost, type ActivitySyncResult } from '../ipod-activity-engine.ts'
import { catalogIdsAscend } from '../ipod-swap-sync.ts'
import { parseCatalogPaths, ROUNDTRIP_STATE_FILE, type RoundTripHost } from '../sync-engine/roundtrip.ts'
import { securePlaysBeforeSync } from '../ipod-plays-archive.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const N = 20
const SONG_BYTES = 250_000    // 250 KB over 200 s = 10 kbps: the validator's bitrate floor is 8
const DURATION_MS = 200_000   // shorter reads as a skit and never boards

/** An empty iTunesDB, the shape db_reader accepts as a template (as core/tests does). */
function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

interface Rig {
  root: string
  lib: string
  card: string
  state: string
  host: ActivitySyncHost
  library: Map<number, Record<string, unknown>>
  events: Array<{ phase: string; title: string; mode?: string; summary?: string; total: number }>
  /** Hook run on every progress event (to cancel, or to break the card at a moment). */
  onEvent: (e: { phase: string; title: string }) => void
  cancel: boolean
}

function songName(id: number): string { return `S${String(id).padStart(3, '0')}.m4a` }
const folder = (id: number) => `F${String(id % 5).padStart(2, '0')}`

async function addSong(r: Rig, id: number, bytes = SONG_BYTES, fill = id): Promise<void> {
  const dir = join(r.lib, 'iPod_Control', 'Music', folder(id))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, songName(id)), Buffer.alloc(bytes, fill & 0xff))
  r.library.set(id, {
    id, title: `Song ${id}`, artist: `Band ${String.fromCharCode(65 + (id % 26))}`, album: `Album ${id % 4}`, genre: 'Rock',
    duration: DURATION_MS, codec: 'alac', path: `:iPod_Control:Music:${folder(id)}:${songName(id)}`,
    audioFingerprint: `sha1:${id.toString(16).padStart(8, '0')}|${bytes}`,
  })
}

function readJsonCatalog(card: string): Promise<{ tracks: Array<Record<string, unknown>>; playlists?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', join(card, 'iPod_Control', 'iTunes', 'iTunesDB')])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`db_reader --json exited ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

async function makeRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'jt-swap-engine-'))
  const lib = join(root, 'lib')
  const card = join(root, 'card')
  const state = join(root, 'state')
  await mkdir(join(card, 'iPod_Control', 'iTunes'), { recursive: true })
  await mkdir(join(card, 'iPod_Control', 'Music'), { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
  const r = {
    root, lib, card, state,
    library: new Map(),
    events: [],
    onEvent: () => {},
    cancel: false,
  } as unknown as Rig
  r.host = {
    pythonCmd: 'python3',
    pythonHint: '',
    coreScript: (rel) => join(REPO, rel),
    tempDir: root,
    stateDir: state,
    pid: process.pid,
    musicDir: join(lib, 'iPod_Control', 'Music'),
    pathSep: '/',
    isMac: true,
    sendProgress: (p) => {
      r.events.push({ phase: p.phase, title: p.title, mode: p.mode, summary: p.summary, total: p.total })
      r.onEvent(p)
    },
    isCancelled: () => r.cancel,
    isStreamedTrackFile: async () => false,
    buildAacMirror: async () => null,
    buildIpodSafeAlacMirror: async () => null,
    readIpodDatabase: () => readJsonCatalog(card),
    writeJournal: async () => {},
    writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m, null, 1)) },
    writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s, null, 2)) },
    clearSeal: async () => { await unlink(join(state, 'ipod-activity-tsa-seal.json')).catch(() => {}) },
    writeReport: async () => {},
    getDetectedMount: () => card,
    setDetectedMount: () => {},
    probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
    stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
    freeBytes: async () => 500 * 1024 ** 3,
    remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
  }
  for (let id = 0; id < N; id++) await addSong(r, id)
  return r
}

async function sync(r: Rig, ids: number[], opts: { listOnly?: boolean } = {}): Promise<ActivitySyncResult> {
  r.events = []
  const tracks = ids.map((id) => ({ ...r.library.get(id)! }))
  const playlists = [{ name: 'Top 1000', trackIds: ids }]
  return runActivitySync(r.host, { tracks, playlists, requestedTarget: ids.length, listOnly: opts.listOnly ?? true, ipodName: 'TestPod' })
}

/** Card files: colon path → { size, ino, mtimeMs }. */
async function cardFiles(card: string): Promise<Map<string, { size: number; ino: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; ino: number; mtimeMs: number }>()
  const music = join(card, 'iPod_Control', 'Music')
  for (const f of await readdir(music).catch(() => [] as string[])) {
    for (const n of await readdir(join(music, f)).catch(() => [] as string[])) {
      const st = await stat(join(music, f, n))
      out.set(`:iPod_Control:Music:${f}:${n}`, { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** The card's catalog, as the firmware would see it: paths in record order + id order. */
async function cardCatalog(card: string): Promise<{ paths: string[]; ascend: boolean | null }> {
  const buf = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
  return { paths: parseCatalogPaths(buf) || [], ascend: catalogIdsAscend(buf) }
}

/** The invariant: the catalog on the card names only files that are on the card, at size. */
async function assertCardWhole(r: Rig): Promise<void> {
  const files = await cardFiles(r.card)
  const { paths, ascend } = await cardCatalog(r.card)
  for (const p of paths) assert.ok(files.has(p) && files.get(p)!.size > 0, `the catalog names ${p}, which is not on the card`)
  assert.equal(ascend, true, 'catalog ids must ascend (the firmware binary search)')
}

const pathOf = (id: number) => `:iPod_Control:Music:${folder(id)}:${songName(id)}`
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i)

describe('swap-only sync on a fake card', () => {
  let r: Rig
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('first sync: no record of a last sync, so a full copy, and it says why', async () => {
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), /no record of what the last sync put/)
    assert.equal(res.copied, N)
    assert.ok(r.events.some((e) => /^Wiping/.test(e.title)))
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.format, 2)
    assert.equal(m.status, 'sealed')
    assert.equal(m.tracks.length, N)
    assert.ok(m.tracks.every((t: { size: number; sourceSize: number }) => t.size === SONG_BYTES && t.sourceSize === SONG_BYTES))
    assert.match(String(res.summary), /^Full copy: /)
    await assertCardWhole(r)
  })

  it('unchanged set: no copies, no deletes, the catalog rebuilt and valid', async () => {
    const before = await cardFiles(r.card)
    const dbBefore = await stat(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.equal(res.copied, 0)
    assert.equal(res.kept, N)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N, changed: 0 })
    assert.equal(res.summary, `Nothing to swap: all ${N} stayed.`)
    const after = await cardFiles(r.card)
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    for (const [p, b] of before) {
      assert.equal(after.get(p)!.ino, b.ino, `${p} was rewritten`)
      assert.equal(after.get(p)!.mtimeMs, b.mtimeMs, `${p} was rewritten`)
    }
    assert.ok(!r.events.some((e) => /^(Wiping|Removing)/.test(e.title)), 'nothing to remove, no wipe')
    assert.equal(r.events.filter((e) => e.phase === 'copy').length, 0, 'Copy counts only arrivals — none')
    // Rebuilt in full (the writer only stamps the clock's second, so the bytes
    // can come out identical; the write itself is what this proves).
    const dbAfter = await stat(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    assert.ok(dbAfter.mtimeMs > dbBefore.mtimeMs, 'the catalog was rebuilt')
    assert.ok(r.events.some((e) => e.phase === 'db' && e.title === 'iTunesDB written'))
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), range(0, N).map(pathOf).sort())
    await assertCardWhole(r)
  })

  it('7 swapped: 7 deletes, 7 copies, the staying files untouched, the catalog is exactly the target', async () => {
    for (let id = 100; id < 107; id++) await addSong(r, id)
    const target = [...range(0, 13), ...range(100, 107)]
    const before = await cardFiles(r.card)
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 7, in: 7, stayed: 13, changed: 0 })
    assert.equal(res.summary, 'Swapped 7 songs: 7 out, 7 in. 13 stayed.')
    assert.equal(res.copied, 7)
    const after = await cardFiles(r.card)
    for (const id of range(0, 13)) {
      const p = pathOf(id)
      assert.equal(after.get(p)!.ino, before.get(p)!.ino, `${p} (staying) was rewritten`)
      assert.equal(after.get(p)!.mtimeMs, before.get(p)!.mtimeMs, `${p} (staying) was rewritten`)
    }
    for (const id of range(13, 20)) assert.ok(!after.has(pathOf(id)), `${id} left`)
    for (const id of range(100, 107)) assert.equal(after.get(pathOf(id))?.size, SONG_BYTES, `${id} arrived`)
    assert.equal(after.size, 20)
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), target.map(pathOf).sort())
    await assertCardWhole(r)
    // The strip: Remove (never Wipe), and Copy counts the 7 arrivals only.
    const removing = r.events.filter((e) => /^Removing/.test(e.title))
    assert.ok(removing.length > 0 && removing.every((e) => e.phase === 'copy'))
    assert.ok(!r.events.some((e) => /^Wiping/.test(e.title)))
    assert.ok(r.events.filter((e) => e.phase === 'copy' && !/^Removing/.test(e.title)).every((e) => e.total === 7))
    assert.ok(r.events.some((e) => e.mode === 'swap' && e.summary === res.summary))
    // The backstop's count: one swap that removed 7 songs since the full copy.
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.swapsSinceFull, 1)
    assert.equal(m.bytesRemovedSinceFull, 7 * SONG_BYTES)
    // The ledger says what moved.
    const ledger = (await readFile(join(r.state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))
    const result = ledger.filter((e) => e.kind === 'result').pop()
    assert.equal(result.mode, 'swap')
    assert.deepEqual(result.swap, { out: 7, in: 7, stayed: 13, changed: 0 })
  })

  it('a song whose library file changed is re-copied (leaves and arrives)', async () => {
    const target = [...range(0, 13), ...range(100, 107)]
    await addSong(r, 5, SONG_BYTES + 512, 0x55)    // re-downloaded: new bytes, new size, same id and path
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 1, in: 1, stayed: 19, changed: 1 })
    assert.match(String(res.summary), /^Swapped 1 song: 1 out, 1 in\. 19 stayed\. 1 of them was re-copied because the library file changed\.$/)
    assert.equal((await cardFiles(r.card)).get(pathOf(5))?.size, SONG_BYTES + 512)
    await assertCardWhole(r)
  })
})

describe('the Original (not list-only, fill-to-N) swaps too', () => {
  let r: Rig
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })
  it('full first, then a swap of 3', async () => {
    const first = await sync(r, range(0, N), { listOnly: false })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.mode, 'full')
    for (let id = 400; id < 403; id++) await addSong(r, id)
    const res = await sync(r, [...range(0, N - 3), 400, 401, 402], { listOnly: false })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 3, in: 3, stayed: N - 3, changed: 0 })
    assert.equal(res.summary, `Swapped 3 songs: 3 out, 3 in. ${N - 3} stayed.`)
    await assertCardWhole(r)
  })
})

describe('swap-only sync falls back to a full copy whenever the card can’t be proven', () => {
  let r: Rig
  const target = range(0, N)
  before(async () => {
    r = await makeRig()
    const first = await sync(r, target)
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  const expectFull = async (why: RegExp): Promise<void> => {
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), why)
    assert.match(String(res.summary), /^Full copy: /)
    assert.equal(res.copied, N)
    await assertCardWhole(r)
    // and the run after it is a swap again
    const again = await sync(r, target)
    assert.equal(again.mode, 'swap', again.fullReason)
  }

  it('no seal', async () => {
    await unlink(join(r.state, 'ipod-activity-tsa-seal.json'))
    await expectFull(/no seal/)
  })
  it('the card’s catalog is not the one the last sync wrote', async () => {
    // Another writer's catalog: still valid, one character of the iPod's name differs.
    const db = join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const buf = await readFile(db)
    const at = buf.indexOf(Buffer.from('TestPod', 'utf16le'))
    assert.ok(at > 0)
    buf.write('X', at, 'utf16le')
    await writeFile(db, buf)
    await expectFull(/isn’t the one the last sync wrote/)
  })
  it('a missing file on the card', async () => {
    await unlink(join(r.card, 'iPod_Control', 'Music', folder(3), songName(3)))
    await expectFull(/1 song missing/)
  })
  it('a short file on the card', async () => {
    await truncate(join(r.card, 'iPod_Control', 'Music', folder(4), songName(4)), 100)
    await expectFull(/1 song the wrong size/)
  })
  it('a file the last sync didn’t put there', async () => {
    await mkdir(join(r.card, 'iPod_Control', 'Music', 'F09'), { recursive: true })
    await writeFile(join(r.card, 'iPod_Control', 'Music', 'F09', 'STRAY.m4a'), 'x')
    await expectFull(/1 file the last sync didn’t put there/)
  })
  it('a manifest from an older format', async () => {
    const p = join(r.state, 'last-sync-manifest.json')
    const m = JSON.parse(await readFile(p, 'utf-8'))
    delete m.format
    await writeFile(p, JSON.stringify(m))
    await expectFull(/older JakeTunes/)
  })
  it('a firmware-unsafe catalog (ids out of order), even with a matching record', async () => {
    const db = join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const buf = await readFile(db)
    // Swap the ids of the first two mhit records, then make the record agree.
    const first = buf.indexOf('mhit', 0, 'latin1')
    const second = buf.indexOf('mhit', first + 4, 'latin1')
    const a = buf.readUInt32LE(first + 0x10)
    buf.writeUInt32LE(buf.readUInt32LE(second + 0x10), first + 0x10)
    buf.writeUInt32LE(a, second + 0x10)
    await writeFile(db, buf)
    const p = join(r.state, 'last-sync-manifest.json')
    const m = JSON.parse(await readFile(p, 'utf-8'))
    const { createHash } = await import('crypto')
    m.catalog = { md5: createHash('md5').update(buf).digest('hex'), bytes: buf.length }
    await writeFile(p, JSON.stringify(m))
    await expectFull(/firmware’s id order/)
  })
  it('more than 70% of the set changing', async () => {
    for (let id = 200; id < 215; id++) await addSong(r, id)
    const big = [...range(0, 5), ...range(200, 215)]      // 15 of 20 arrive = 75%
    const res = await sync(r, big)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), /15 of 20 songs are changing, so a full copy is simpler/)
    await assertCardWhole(r)
    const back = await sync(r, target)    // put the fixture's set back (75% again → full)
    assert.equal(back.ok, true, back.error)
  })
})

describe('a swap that fails part-way leaves the card whole', () => {
  let r: Rig
  const base = range(0, N)
  before(async () => {
    r = await makeRig()
    for (let id = 100; id < 107; id++) await addSong(r, id)
    const first = await sync(r, base)
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('cancelled mid-copy after removals: the card lists the songs that stayed, all on it; arrivals taken back', async () => {
    let arrivals = 0
    r.onEvent = (e) => { if (e.phase === 'copy' && /^Song 10\d$/.test(e.title)) { arrivals++; if (arrivals === 5) r.cancel = true } }
    const res = await sync(r, [...range(0, 13), ...range(100, 107)])
    r.onEvent = () => {}; r.cancel = false
    assert.equal(res.ok, false)
    assert.equal(res.cancelled, true)
    await assertCardWhole(r)     // the effect first
    assert.match(String(res.error), /still has a working song list of the 13 songs on it/)
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), range(0, 13).map(pathOf).sort(), 'the interim catalog: the 13 that stay')
    const files = await cardFiles(r.card)
    assert.deepEqual([...files.keys()].sort(), range(0, 13).map(pathOf).sort(), 'arrivals taken back, leavers gone')
    // The round trip can still map the card: the manifest names its catalog (unsealed).
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.status, 'interim')
    assert.equal(m.sealed, false)
    assert.deepEqual(m.tracks.map((t: { destPath: string }) => t.destPath).sort(), range(0, 13).map(pathOf).sort())
    // Next sync can't prove the card: a full copy, and it says why.
    const next = await sync(r, base)
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'full')
    assert.match(String(next.fullReason), /didn’t finish/)
  })

  it('a pure add that fails before any catalog change: nothing on the iPod changed and the next sync still swaps', async () => {
    // List-only iPod grows by 3; the 2nd arrival's library file vanishes mid-copy.
    for (let id = 300; id < 303; id++) await addSong(r, id)
    const before = await cardFiles(r.card)
    const dbBefore = await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const sealBefore = await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8')
    // Hooks run inside sendProgress: synchronous, so the engine's next step sees the change.
    r.onEvent = (e) => {
      if (e.phase === 'copy' && e.title === 'Song 300') unlinkSync(join(r.lib, 'iPod_Control', 'Music', folder(301), songName(301)))
    }
    const res = await sync(r, [...base, 300, 301, 302])
    r.onEvent = () => {}
    assert.equal(res.ok, false)
    assert.match(String(res.error), /nothing on it changed, all 20 songs are still there/)
    assert.deepEqual([...(await cardFiles(r.card)).keys()].sort(), [...before.keys()].sort(), 'the copied arrival was taken back')
    assert.equal(Buffer.compare(await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')), dbBefore), 0, 'the catalog never changed')
    assert.equal(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'), sealBefore, 'the last seal is back')
    await assertCardWhole(r)
    await addSong(r, 301)
    const next = await sync(r, [...base, 300, 301, 302])
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
    assert.deepEqual(next.swap, { out: 0, in: 3, stayed: 20, changed: 0 })
    assert.equal(next.summary, 'Added 3 songs. 20 stayed.')
  })

  it('never catalog a missing file: an arrival that vanishes before the catalog is refused, and the card stays whole', async () => {
    const target = [...range(0, 13), ...range(100, 107)]
    const pre = await sync(r, base)   // back to a sealed 20 first
    assert.equal(pre.ok, true, pre.error)
    let broke = false
    r.onEvent = (e) => {
      if (!broke && e.phase === 'db' && e.title === 'Writing iTunesDB...') {
        broke = true
        unlinkSync(join(r.card, 'iPod_Control', 'Music', folder(104), songName(104)))
      }
    }
    const res = await sync(r, target)
    r.onEvent = () => {}
    assert.equal(broke, true)
    assert.equal(res.ok, false)
    // The effect first: no catalog on the card ever names the vanished file.
    await assertCardWhole(r)
    assert.match(String(res.error), /1 song\(s\) the catalog would list are not on the card/)
    assert.match(String(res.error), /still has a working song list/)
    const { paths } = await cardCatalog(r.card)
    assert.ok(!paths.includes(pathOf(104)), 'the catalog never names the vanished file')
  })
})

describe('a stop before the card is touched keeps the last seal', () => {
  let r: Rig
  before(async () => {
    r = await makeRig()
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })
  it('cancelled during Prepare: nothing touched, the seal stays, and the next Sync swaps', async () => {
    const sealBefore = await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8')
    const manifestBefore = await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')
    r.onEvent = (e) => { if (e.phase === 'preflight' && /^Preparing:/.test(e.title)) r.cancel = true }
    const res = await sync(r, range(0, N))
    r.onEvent = () => {}; r.cancel = false
    assert.equal(res.cancelled, true)
    assert.match(String(res.error), /nothing on the iPod was touched/)
    assert.equal(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'), sealBefore)
    assert.equal(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'), manifestBefore)
    const next = await sync(r, range(0, N))
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
  })
})

describe('the fragmentation backstop, end to end', () => {
  let r: Rig
  before(async () => {
    r = await makeRig()
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (let id = 500; id < 520; id++) await addSong(r, id)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('five swaps that remove songs, then a full copy with a plain reason, then swaps again', async () => {
    let set = range(0, N)
    for (let k = 0; k < 5; k++) {
      set = [...set.filter((id) => id !== k), 500 + k]          // one out, one in
      const res = await sync(r, set)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', `swap ${k + 1}: ${res.fullReason}`)
    }
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.swapsSinceFull, 5)
    assert.equal(m.bytesRemovedSinceFull, 5 * SONG_BYTES)
    // An unchanged sync removes nothing: it still swaps and isn't counted.
    const same = await sync(r, set)
    assert.equal(same.mode, 'swap', same.fullReason)
    assert.equal(JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')).swapsSinceFull, 5)
    set = [...set.filter((id) => id !== 5), 505]
    const sixth = await sync(r, set)
    assert.equal(sixth.ok, true, sixth.error)
    assert.equal(sixth.mode, 'full')
    assert.match(String(sixth.fullReason), /5 swaps since the last full copy/)
    assert.match(String(sixth.summary), /^Full copy: it’s been 5 swaps/)
    await assertCardWhole(r)
    const after6 = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.deepEqual([after6.swapsSinceFull, after6.bytesRemovedSinceFull], [0, 0])
    set = [...set.filter((id) => id !== 6), 506]
    const next = await sync(r, set)
    assert.equal(next.mode, 'swap', next.fullReason)
  })

  it('removals past 15% of the card since the last full copy: a full copy', async () => {
    r.host.cardCapacityBytes = async () => 20 * SONG_BYTES      // 15% = 3 songs' worth
    try {
      const now = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')).tracks.map((t: { id: number }) => t.id) as number[]
      const keep = now.slice(4)
      const res = await sync(r, [...keep, 510, 511, 512, 513])     // 4 out = 20% of this card
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.match(String(res.fullReason), /would have cleared 2\d% of the iPod/)
      await assertCardWhole(r)
    } finally {
      delete r.host.cardCapacityBytes
    }
  })
})

describe('plays when a swap stops on the catalog step (review of #377)', () => {
  let r: Rig
  const playEvents: Array<{ id: number; count: number }> = []
  let rtHost: RoundTripHost
  before(async () => {
    r = await makeRig()
    rtHost = {
      stateDir: r.state,
      getLibraryTracks: async () => [...r.library.values()].map((t) => ({ id: Number(t.id), playCount: 0 })),
      appendPlayEvents: async (id, count) => { playEvents.push({ id, count }) },
      sendToRenderer: () => {},
      isSyncInFlight: () => false,
    }
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  /** The firmware: one entry per catalog record. It appends to a Play Counts
   *  that is still there, and starts a fresh one when it was retired. */
  const play = async (path: string, n: number): Promise<void> => {
    const pc = join(r.card, 'iPod_Control', 'iTunes', 'Play Counts')
    const { paths } = await cardCatalog(r.card)
    const prior = await readFile(pc).catch(() => null)
    const b = prior && prior.length === 96 + paths.length * 16 ? Buffer.from(prior) : Buffer.alloc(96 + paths.length * 16)
    b.write('mhdp', 0, 'latin1'); b.writeUInt32LE(96, 4); b.writeUInt32LE(16, 8); b.writeUInt32LE(paths.length, 12)
    const i = paths.indexOf(path)
    assert.ok(i >= 0)
    b.writeUInt32LE(b.readUInt32LE(96 + i * 16) + n, 96 + i * 16)
    b.writeUInt32LE(3_900_000_000, 96 + i * 16 + 4)
    await writeFile(pc, b)
  }

  it('a pure-add swap that stops on the contiguity step: new plays on a staying song come home exactly once', async () => {
    await play(pathOf(2), 3)
    const gate1 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate1.ok, true, gate1.ok ? '' : gate1.error)
    assert.deepEqual(playEvents.splice(0), [{ id: 2, count: 3 }])

    for (let id = 600; id < 603; id++) await addSong(r, id)
    r.host.ensureContiguousDb = async () => ({ ok: false, preallocContig: false, bytes: 0, md5: '', summary: 'forced', error: 'forced for the test' })
    const res = await sync(r, [...range(0, N), 600, 601, 602])
    delete r.host.ensureContiguousDb
    assert.equal(res.ok, false)
    assert.match(String(res.error), /could not be laid down as one piece/)
    assert.match(String(res.error), /nothing on it changed/)

    await play(pathOf(2), 1)                      // one more listen on the same catalog
    const gate2 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate2.ok, true, gate2.ok ? '' : gate2.error)
    assert.deepEqual(playEvents.splice(0), [{ id: 2, count: 1 }], 'the new listen counts once — not swallowed, not doubled')
  })
})

describe('plays round trip around a swap', () => {
  let r: Rig
  const playEvents: Array<{ id: number; count: number }> = []
  let rtHost: RoundTripHost
  before(async () => {
    r = await makeRig()
    rtHost = {
      stateDir: r.state,
      getLibraryTracks: async () => [...r.library.values()].map((t) => ({ id: Number(t.id), playCount: 0 })),
      appendPlayEvents: async (id, count) => { playEvents.push({ id, count }) },
      sendToRenderer: () => {},
      isSyncInFlight: () => false,
    }
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  /** The firmware's Play Counts: one entry per catalog record, positional. */
  const writePlayCounts = async (playsByPath: Map<string, number>): Promise<void> => {
    const { paths } = await cardCatalog(r.card)
    const b = Buffer.alloc(96 + paths.length * 16)
    b.write('mhdp', 0, 'latin1'); b.writeUInt32LE(96, 4); b.writeUInt32LE(16, 8); b.writeUInt32LE(paths.length, 12)
    paths.forEach((p, i) => {
      b.writeUInt32LE(playsByPath.get(p) || 0, 96 + i * 16)
      b.writeUInt32LE(3_900_000_000, 96 + i * 16 + 4)
    })
    await writeFile(join(r.card, 'iPod_Control', 'iTunes', 'Play Counts'), b)
  }

  it('plays come home before the swap touches anything, and a staying song is never counted twice', async () => {
    // Listening on the iPod: song 2 (stays) 3 plays, song 15 (leaves) 2 plays.
    await writePlayCounts(new Map([[pathOf(2), 3], [pathOf(15), 2]]))
    const gate1 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate1.ok, true, gate1.ok ? '' : gate1.error)
    assert.deepEqual(playEvents.splice(0).sort((a, b) => a.id - b.id), [{ id: 2, count: 3 }, { id: 15, count: 2 }])

    for (let id = 100; id < 107; id++) await addSong(r, id)
    const res = await sync(r, [...range(0, 13), ...range(100, 107)])
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.equal(await stat(join(r.card, 'iPod_Control', 'iTunes', 'Play Counts')).then(() => true, () => false), false, 'Play Counts retired with the new catalog')

    // The firmware starts a fresh Play Counts against the rebuilt catalog:
    // song 2 (stayed, new position) 1 more play, song 103 (arrived) 4.
    await writePlayCounts(new Map([[pathOf(2), 1], [pathOf(103), 4]]))
    const gate2 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate2.ok, true, gate2.ok ? '' : gate2.error)
    assert.deepEqual(playEvents.splice(0).sort((a, b) => a.id - b.id), [{ id: 2, count: 1 }, { id: 103, count: 4 }],
      'exactly the new plays: no double count for the staying song, mapped through the swap’s manifest')
    const st = JSON.parse(await readFile(join(r.state, ROUNDTRIP_STATE_FILE), 'utf-8'))
    assert.deepEqual(st.ingested, { 2: 1, 103: 4 })
  })
})

// A loud guard for the test's own assumption: the fake card is a temp folder.
describe('the rig never touches a real iPod', () => {
  it('every card path is under the OS temp dir', async () => {
    const r = await makeRig()
    try {
      assert.ok(r.card.startsWith(tmpdir()) || r.card.startsWith('/private' + tmpdir()), r.card)
      await appendFile(join(r.root, 'probe'), 'x')
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// ── 2026-11-08, the punkPod on a slow relay: an arrival homemini couldn't send
// stopped a whole swap, and four songs with no fingerprint yet were re-copied. ──

/** Evict a song from the Mac: its bytes live only on "homemini" now. */
async function evict(r: Rig, id: number, homemini: Map<number, Buffer>): Promise<void> {
  const p = join(r.lib, String(r.library.get(id)!.path).slice(1).replace(/:/g, '/'))
  homemini.set(id, await readFile(p))
  await unlink(p)
}

/** A homemini that sends what it has, except the ids in `refuse` (fetch failed). */
function wireHomemini(r: Rig, homemini: Map<number, Buffer>, refuse: Set<number>, onFail?: () => void): { fetched: number[] } {
  const seen = { fetched: [] as number[] }
  r.host.probeHomeminiTrack = async (id) => homemini.has(id) ? { ok: true, bytes: homemini.get(id)!.length } : { ok: false, error: 'homemini 404' }
  r.host.stageTrack = async (_colon, id) => {
    if (refuse.has(id) || !homemini.has(id)) { onFail?.(); return { ok: false, error: 'fetch failed', reason: 'fetch' } }
    seen.fetched.push(id)
    const dir = join(r.root, 'stage'); await mkdir(dir, { recursive: true })
    const abs = join(dir, `${id}.m4a`)
    await writeFile(abs, homemini.get(id)!)
    return { ok: true, abs, staged: true, pulled: true, cleanup: async () => { await unlink(abs).catch(() => {}) } }
  }
  return seen
}

describe('a list-only swap with an arrival homemini can’t send', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => {
    r = await makeRig()
    for (let id = 700; id < 705; id++) await addSong(r, id)
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('leaves that song off, finishes the swap with N-1, sealed, and says why', async () => {
    for (let id = 700; id < 705; id++) await evict(r, id, homemini)
    const dbBefore = await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const filesBefore = await cardFiles(r.card)
    let cardAtFail: { db: Buffer } | null = null
    const seen = wireHomemini(r, homemini, new Set([702]), () => {
      cardAtFail = {
        db: Buffer.from(readFileSync(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))),
      }
    })
    const set = [...range(0, N - 5), ...range(700, 705)]          // 5 out, 5 in, one of them unfetchable
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N - 1)
    assert.deepEqual(res.swap, { out: 5, in: 4, stayed: N - 5, changed: 0 })
    assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[702, "homemini couldn't send its audio file"]])
    // Known before anything on the card changed: the old catalog, the old files.
    assert.ok(cardAtFail, 'the failing fetch happened')
    assert.equal(Buffer.compare(cardAtFail!.db, dbBefore), 0, 'the fetch failed while the card still held the last sync’s catalog')
    assert.deepEqual(seen.fetched.sort(), [700, 701, 703, 704], 'every other arrival was fetched ahead')
    // The card: the stays untouched, the 4 that came, the leavers gone.
    const after = await cardFiles(r.card)
    for (const id of range(0, N - 5)) assert.equal(after.get(pathOf(id))!.ino, filesBefore.get(pathOf(id))!.ino, `${id} (staying) was rewritten`)
    assert.deepEqual([...after.keys()].sort(), [...range(0, N - 5), 700, 701, 703, 704].map(pathOf).sort())
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), [...range(0, N - 5), 700, 701, 703, 704].map(pathOf).sort())
    await assertCardWhole(r)
    // Sealed with N-1, the ledger names the song left off, and the staged copies are gone.
    const seal = JSON.parse(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'))
    assert.equal(seal.target, N - 1)
    const result = (await readFile(join(r.state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'result').pop()
    assert.deepEqual(result.leftOff.map((l: { id: number; why: string }) => [l.id, l.why]), [[702, "homemini couldn't send its audio file"]])
    assert.equal(result.landed, N - 1)
    assert.deepEqual(await readdir(join(r.root, 'stage')), [], 'every staged arrival was released')
    // When homemini can send it, the next Sync adds it as a swap.
    const again = wireHomemini(r, homemini, new Set())
    const next = await sync(r, set)
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
    assert.deepEqual(next.swap, { out: 0, in: 1, stayed: N - 1, changed: 0 })
    assert.deepEqual(again.fetched, [702], 'the evicted songs on the card stay: only the newcomer is fetched')
    await assertCardWhole(r)
  })
})

describe('a list-only full copy with a song homemini can’t send at copy time', () => {
  it('leaves it off and seals N-1 (never a stopped sync)', async () => {
    const r = await makeRig()
    try {
      const homemini = new Map<number, Buffer>()
      await evict(r, 4, homemini)
      wireHomemini(r, homemini, new Set([4]))
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => l.id), [4])
      await assertCardWhole(r)
      assert.ok(!(await cardFiles(r.card)).has(pathOf(4)))
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('songs that stay are not re-copied', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('a song evicted from the Mac since the last sync, unchanged, stays', async () => {
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (const id of [3, 8, 13]) await evict(r, id, homemini)
    const seen = wireHomemini(r, homemini, new Set())
    const before = await cardFiles(r.card)
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N, changed: 0 })
    assert.equal(res.copied, 0)
    assert.deepEqual(seen.fetched, [], 'nothing fetched from homemini')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))!.ino, before.get(pathOf(id))!.ino)
  })

  it('a fresh download with no fingerprint yet (and a card name unlike its library name) stays', async () => {
    // "imported_14505.m4a" rides as "14505.m4a": the 4 Cramps songs, 2026-11-08.
    const ids = [14505, 14506]
    for (const id of ids) {
      const dir = join(r.lib, 'iPod_Control', 'Music', 'F05')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `imported_${id}.m4a`), Buffer.alloc(SONG_BYTES, id & 0xff))
      r.library.set(id, {
        id, title: `Fresh ${id}`, artist: 'The Cramps', album: 'Bad Music for Bad People', genre: 'Rock',
        duration: DURATION_MS, codec: 'alac', path: `:iPod_Control:Music:F05:imported_${id}.m4a`,
      })
    }
    const set = [...range(0, N), ...ids]
    const add = await sync(r, set)
    assert.equal(add.ok, true, add.error)
    assert.deepEqual(add.swap, { out: 0, in: 2, stayed: N, changed: 0 })
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.ok(m.tracks.filter((t: { id: number }) => ids.includes(t.id)).every((t: { identity: string }) => t.identity.startsWith('path:')))
    const before = await cardFiles(r.card)
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N + 2, changed: 0 }, 'no re-copy for a song with no fingerprint')
    // and once the fingerprint pass reaches them, still no re-copy
    for (const id of ids) r.library.get(id)!.audioFingerprint = `sha1:${id}|${SONG_BYTES}`
    const fp = await sync(r, set)
    assert.equal(fp.ok, true, fp.error)
    assert.deepEqual(fp.swap, { out: 0, in: 0, stayed: N + 2, changed: 0 }, 'gaining a fingerprint is not a change')
    const after = await cardFiles(r.card)
    for (const id of ids) {
      const p = `:iPod_Control:Music:F05:${id}.m4a`
      assert.equal(after.get(p)!.ino, before.get(p)!.ino, `${p} was rewritten`)
    }
    // A real change still re-copies: a new master size at the same path.
    await writeFile(join(r.lib, 'iPod_Control', 'Music', 'F05', `imported_${ids[0]}.m4a`), Buffer.alloc(SONG_BYTES + 64, 1))
    r.library.get(ids[0])!.audioFingerprint = `sha1:${ids[0]}|${SONG_BYTES}`   // fingerprint not refreshed yet
    const changed = await sync(r, set)
    assert.equal(changed.ok, true, changed.error)
    assert.deepEqual(changed.swap, { out: 1, in: 1, stayed: N + 1, changed: 1 })
  })
})

describe('the Original swap with an arrival homemini can’t send', () => {
  it('a reserve takes the seat, fetched-ahead failures never touch the card, N still means N', async () => {
    const r = await makeRig()
    try {
      const first = await sync(r, range(0, N), { listOnly: false })
      assert.equal(first.ok, true, first.error)
      const homemini = new Map<number, Buffer>()
      for (let id = 800; id < 804; id++) await addSong(r, id)
      await evict(r, 801, homemini)
      wireHomemini(r, homemini, new Set([801]))
      const tracks = [...range(0, N - 2), 800, 801].map((id) => ({ ...r.library.get(id)! }))
      const reserve = [802, 803].map((id) => ({ ...r.library.get(id)! }))
      const res = await runActivitySync(r.host, {
        tracks, reserve, playlists: [{ name: 'Top 1000', trackIds: tracks.map((t) => t.id) }],
        requestedTarget: N, listOnly: false, ipodName: 'TestPod',
      })
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.equal(res.target, N)
      assert.equal(res.leftOff, undefined)
      const files = await cardFiles(r.card)
      assert.ok(files.has(pathOf(800)) && files.has(pathOf(802)) && !files.has(pathOf(801)))
      assert.equal(files.size, N)
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// ── 2026-11-08, follow-up to #381: the homemini probe ran BEFORE the swap
// plan, so on a slow link a probe miss for an evicted song already on the
// card (one that would stay) still left it off. The plan comes first now. ──

/** Probes homemini answers: ok for the ids in `answers`, a timeout for the rest. Records every id asked. */
function wireProbe(r: Rig, homemini: Map<number, Buffer>, answers: (id: number) => boolean): { asked: number[] } {
  const seen = { asked: [] as number[] }
  r.host.probeHomeminiTrack = async (id) => {
    seen.asked.push(id)
    return answers(id) && homemini.has(id) ? { ok: true, bytes: homemini.get(id)!.length } : { ok: false, error: 'timed out after 8000 ms' }
  }
  return seen
}

describe('a list-only swap on a link where homemini’s probe times out', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => {
    r = await makeRig()
    for (const id of [950, 951, 960]) await addSong(r, id)
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (const id of [3, 8, 13]) await evict(r, id, homemini)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('an evicted song that stays is never probed, stays on the card and in the catalog', async () => {
    wireHomemini(r, homemini, new Set())
    const probe = wireProbe(r, homemini, () => false)
    const before = await cardFiles(r.card)
    const set = [...range(0, N - 2), 950, 951]
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N)
    assert.deepEqual(res.swap, { out: 2, in: 2, stayed: N - 2, changed: 0 })
    assert.ok(!res.leftOff?.length, `nothing left off: ${JSON.stringify(res.leftOff)}`)
    assert.deepEqual(probe.asked, [], 'a song that stays is never asked about')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))?.ino, before.get(pathOf(id))!.ino, `${id} stayed untouched`)
    const { paths } = await cardCatalog(r.card)
    for (const id of [3, 8, 13]) assert.ok(paths.includes(pathOf(id)), `${id} is in the catalog`)
    assert.equal(paths.length, N)
    await assertCardWhole(r)
  })

  it('an evicted song that arrives and can’t be probed is left off with the reason; the stays still stay', async () => {
    await evict(r, 960, homemini)
    wireHomemini(r, homemini, new Set())
    const probe = wireProbe(r, homemini, () => false)
    const before = await cardFiles(r.card)
    const set = [...range(0, N - 3), 950, 951, 960]
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N - 1)
    assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[960, "homemini couldn't send its audio file"]])
    assert.deepEqual(probe.asked, [960], 'only the arrival is asked about')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))?.ino, before.get(pathOf(id))!.ino, `${id} stayed untouched`)
    assert.ok(!after.has(pathOf(960)))
    assert.deepEqual([...after.keys()].sort(), [...range(0, N - 3), 950, 951].map(pathOf).sort())
    await assertCardWhole(r)
  })
})

describe('a full copy probes every song not on this Mac, as before', () => {
  it('no record of a last sync: the miss is asked about up front and left off', async () => {
    const r = await makeRig()
    try {
      const homemini = new Map<number, Buffer>()
      for (const id of [4, 9]) await evict(r, id, homemini)
      wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, (id) => id !== 4)
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[4, "homemini couldn't send its audio file"]])
      assert.deepEqual(probe.asked.sort((a, b) => a - b), [4, 9])
      assert.ok(!(await cardFiles(r.card)).has(pathOf(4)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a provable card that still gets a full copy (too much changing): the record’s songs are asked about too', async () => {
    const r = await makeRig()
    try {
      const first = await sync(r, range(0, N))
      assert.equal(first.ok, true, first.error)
      for (let id = 900; id < 915; id++) await addSong(r, id)
      const homemini = new Map<number, Buffer>()
      for (const id of [0, 1, 2]) await evict(r, id, homemini)
      wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, (id) => id !== 1)
      const res = await sync(r, [...range(0, 5), ...range(900, 915)])   // 75% changing
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[1, "homemini couldn't send its audio file"]])
      assert.deepEqual(probe.asked.sort((a, b) => a - b), [0, 1, 2])
      const files = await cardFiles(r.card)
      assert.ok(files.has(pathOf(0)) && files.has(pathOf(2)) && !files.has(pathOf(1)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// ── 2026-11-08 (after #382): a song not on this Mac that needs converting
// (FLAC, or over the Mini's ceiling) used to be downloaded in full while the
// sync was still planning, even when the last sync's record put it on the card
// and it would stay — and a failed download stopped the sync. A song that
// stays now never needs its bytes. ──

const FLAC_ID = 970
const flacPath = `:iPod_Control:Music:${folder(FLAC_ID)}:S${FLAC_ID}.flac`

async function addFlac(r: Rig): Promise<void> {
  const dir = join(r.lib, 'iPod_Control', 'Music', folder(FLAC_ID))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `S${FLAC_ID}.flac`), Buffer.alloc(SONG_BYTES + 1000, 0x5a))
  r.library.set(FLAC_ID, {
    id: FLAC_ID, title: 'Flac Song', artist: 'Band Z', album: 'Album 0', genre: 'Rock',
    duration: DURATION_MS, codec: 'flac', path: flacPath,
    audioFingerprint: `sha1:${FLAC_ID.toString(16).padStart(8, '0')}|${SONG_BYTES + 1000}`,
  })
  // The ALAC mirror: the same bytes cut to the song size, as a .m4a (the real one is ffmpeg).
  r.host.buildIpodSafeAlacMirror = async (src) => {
    const dir2 = join(r.root, 'mirrors'); await mkdir(dir2, { recursive: true })
    const out = join(dir2, `mirror-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`)
    await writeFile(out, (await readFile(src)).subarray(0, SONG_BYTES))
    return out
  }
}

/** Production stages a song under its own extension (stageFileName): a FLAC stays .flac. */
function stageKeepsExtension(r: Rig, homemini: Map<number, Buffer>, seen: { fetched: number[] }): void {
  r.host.stageTrack = async (colon, id) => {
    if (!homemini.has(id)) return { ok: false, error: 'fetch failed', reason: 'fetch' }
    seen.fetched.push(id)
    const dir = join(r.root, 'stage'); await mkdir(dir, { recursive: true })
    const abs = join(dir, `${id}${colon.slice(colon.lastIndexOf('.'))}`)
    await writeFile(abs, homemini.get(id)!)
    return { ok: true, abs, staged: true, pulled: true, cleanup: async () => { await unlink(abs).catch(() => {}) } }
  }
}

describe('a song not on this Mac that needs converting', () => {
  it('stays on the card without ever being downloaded', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      const set = [...range(0, N - 1), FLAC_ID]
      const first = await sync(r, set)
      assert.equal(first.ok, true, first.error)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      const fetch = wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, () => true)
      const before = await cardFiles(r.card)
      const cardPath = [...before.keys()].find((p) => p.includes(`S${FLAC_ID}`))!
      assert.ok(cardPath, 'the first sync put the mirror on the card')
      const res = await sync(r, set)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.deepEqual(fetch.fetched, [], 'a song that stays is never downloaded')
      assert.deepEqual(probe.asked, [], 'a song that stays is never asked about')
      assert.ok(!res.leftOff?.length, JSON.stringify(res.leftOff))
      const after = await cardFiles(r.card)
      assert.equal(after.get(cardPath)?.ino, before.get(cardPath)!.ino, 'the mirror on the card is untouched')
      assert.ok((await cardCatalog(r.card)).paths.includes(cardPath), 'and in the catalog')
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a staying song whose download would fail no longer stops the sync', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      const set = [...range(0, N - 1), FLAC_ID]
      assert.equal((await sync(r, set)).ok, true)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      wireHomemini(r, homemini, new Set([FLAC_ID]))   // homemini can't send it
      const res = await sync(r, set, { listOnly: false })
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.ok((await cardCatalog(r.card)).paths.some((p) => p.includes(`S${FLAC_ID}`)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('must move after all (a full copy): fetched and converted then, before the card changes', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      assert.equal((await sync(r, [...range(0, N - 1), FLAC_ID])).ok, true)
      for (let id = 900; id < 915; id++) await addSong(r, id)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      const fetch = wireHomemini(r, homemini, new Set())
      wireProbe(r, homemini, () => true)
      stageKeepsExtension(r, homemini, fetch)
      const res = await sync(r, [...range(0, 4), ...range(900, 915), FLAC_ID])   // most of the set changes
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.deepEqual(fetch.fetched, [FLAC_ID], 'fetched once, to convert it')
      const files = await cardFiles(r.card)
      const onCard = [...files.keys()].find((p) => p.includes(`S${FLAC_ID}`))
      assert.ok(onCard && onCard.endsWith('.m4a'), `the mirror is on the card: ${onCard}`)
      assert.equal(files.get(onCard!)!.size, SONG_BYTES)
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('the Device page’s ready check: what is on the card by the record', () => {
  it('a song evicted from this Mac but on the card by the last sync needs nothing; a new one does', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      await addSong(r, 980)
      const set = [...range(0, N - 1), FLAC_ID]
      assert.equal((await sync(r, set)).ok, true)
      const homemini = new Map<number, Buffer>()
      for (const id of [3, FLAC_ID, 980]) await evict(r, id, homemini)
      const readState = async (f: string) => JSON.parse(await readFile(join(r.state, f), 'utf-8'))
      const tracks = [...r.library.values()]
      const onCard = onCardByRecord([3, FLAC_ID, 980], tracks, await readState('last-sync-manifest.json'), await readState('ipod-activity-tsa-seal.json'), await readCardState(r.card))
      assert.deepEqual([...onCard.keys()].sort((a, b) => a - b), [3, FLAC_ID], '980 was never synced: it would have to be fetched')
      // An unsealed record proves nothing.
      assert.equal(onCardByRecord([3], tracks, await readState('last-sync-manifest.json'), null, await readCardState(r.card)).size, 0)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})
