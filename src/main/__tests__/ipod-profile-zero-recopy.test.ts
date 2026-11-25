/**
 * Brief 265 Part 2: an iPod whose profile matches what is on it re-copies nothing.
 *
 * The REAL activity engine plans the sync (its own size calculation: the master's size, or
 * the iPod-safe ALAC mirror's for a FLAC or over-ceiling master), against the card exactly
 * as the Y2KPod's and iBANDCAMP's last syncs left it: every file size, master size, length
 * and extension from their real manifests (fixtures/ipod-alac-manifest-sizes.json, no
 * titles). The card's files are sparse (no bytes written); nothing is copied unless the plan
 * says so, and the test fails if anything is.
 *
 * The profile comes from the real resolution: ALAC, with the Device page's convert toggle ON
 * (the worst case), must turn conversion off.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { conformCatalogIdOrder } from '../ipod-catalog-order.ts'
import { LAST_SYNC_MANIFEST_FILE, SWAP_MANIFEST_FORMAT, TSA_SEAL_FILE } from '../ipod-swap-sync.ts'
import { IBANDCAMP_IPOD_ID, Y2K_IPOD_ID, convertOptionsForIpod } from '../../common/ipod-audio-format.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
type Row = [cardSize: number, masterSize: number, durationMs: number, ext: string, codec: string]
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'ipod-alac-manifest-sizes.json'), 'utf-8')) as { iPods: Record<string, Row[]> }

function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

function runPython(args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', args)
    let err = ''
    py.stderr.on('data', (d: Buffer) => { err += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`db_reader exited ${code}: ${err.slice(-400)}`))))
    py.stdin.end(input)
  })
}

/** The card's catalog read back by the real reader (the engine's final proof counts its tracks). */
function readCatalogJson(dbPath: string): Promise<{ tracks: Array<Record<string, unknown>>; playlists?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', dbPath])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`db_reader --json exited ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

async function sparse(path: string, bytes: number): Promise<void> {
  await writeFile(path, '')
  await truncate(path, bytes)
}

interface Rig { root: string; lib: string; card: string; state: string; mirrors: string; tracks: Array<Record<string, unknown>>; host: ActivitySyncHost; copiedTo: string[] }

/**
 * The card as its last sync left it: sparse files at the manifest's sizes, a catalog written
 * by the real core/db_reader.py (ids conformed as the engine does), and the manifest and seal
 * in the engine's own shape for those exact files.
 */
async function rigFor(name: string, capacityBytes: number): Promise<Rig> {
  const rows = FIX.iPods[name]
  const root = await mkdtemp(join(tmpdir(), `jt-zero-recopy-${name}-`))
  const lib = join(root, 'lib'), card = join(root, 'card'), state = join(root, 'state'), mirrors = join(root, 'mirrors')
  for (const d of [join(card, 'iPod_Control', 'iTunes'), state, mirrors]) await mkdir(d, { recursive: true })
  const mirrorSizeBySrc = new Map<string, number>()
  const tracks: Array<Record<string, unknown>> = []
  const manifestRows: Array<Record<string, unknown>> = []
  for (let i = 0; i < rows.length; i++) {
    const [cardSize, masterSize, durationMs, ext, codec] = rows[i]
    const id = 10_000 + i
    const f = `F${String(i % 50).padStart(2, '0')}`
    const libName = `M${id}.${ext}`
    const cardName = ext === 'flac' ? `M${id}.m4a` : libName   // a FLAC goes on as its iPod-safe ALAC .m4a
    await mkdir(join(lib, 'iPod_Control', 'Music', f), { recursive: true })
    await mkdir(join(card, 'iPod_Control', 'Music', f), { recursive: true })
    const libPath = join(lib, 'iPod_Control', 'Music', f, libName)
    await sparse(libPath, masterSize)
    await sparse(join(card, 'iPod_Control', 'Music', f, cardName), cardSize)
    if (cardSize !== masterSize) mirrorSizeBySrc.set(libPath, cardSize)
    const fp = `sha1:${createHash('sha1').update(`${name}|${i}`).digest('hex').slice(0, 16)}|${durationMs}`
    tracks.push({
      id, title: `Song ${id}`, artist: `Band ${id % 97}`, album: `Album ${id % 31}`, genre: 'Rock',
      duration: durationMs, codec, path: `:iPod_Control:Music:${f}:${libName}`, audioFingerprint: fp, fileSize: masterSize,
    })
    manifestRows.push({ id, destPath: `:iPod_Control:Music:${f}:${cardName}`, identity: `fp:${fp}`, size: cardSize, sourceSize: masterSize })
  }
  // The catalog the last sync wrote: the real writer over the card's paths and sizes.
  const dbPath = join(card, 'iPod_Control', 'iTunes', 'iTunesDB')
  await writeFile(dbPath, emptyTemplate())
  const cardTracks = tracks.map((t, i) => ({ ...t, path: manifestRows[i].destPath, fileSize: manifestRows[i].size }))
  const localDb = join(root, 'catalog.itdb')
  await runPython([join(REPO, 'core', 'db_reader.py'), '--write', localDb, '--template', dbPath, '--ipod-root', card],
    JSON.stringify({ tracks: cardTracks, playlists: [{ name, trackIds: tracks.map((t) => t.id) }], masterName: name }))
  const conform = await conformCatalogIdOrder(localDb)
  assert.ok(conform.ok, 'the fixture catalog conforms')
  const db = await readFile(localDb)
  await writeFile(dbPath, db)
  const sealedAt = '2026-11-22T01:10:04.147Z'
  await writeFile(join(state, LAST_SYNC_MANIFEST_FILE), JSON.stringify({
    format: SWAP_MANIFEST_FORMAT, syncedAt: sealedAt, status: 'sealed', sealed: true, count: manifestRows.length,
    catalog: { md5: createHash('md5').update(db).digest('hex'), bytes: db.length },
    swapsSinceFull: 0, bytesRemovedSinceFull: 0, tracks: manifestRows,
  }))
  await writeFile(join(state, TSA_SEAL_FILE), JSON.stringify({
    version: 1, sealedAt, target: manifestRows.length,
    passengers: manifestRows.map((r) => ({ id: r.id, identity: r.identity, destPath: r.destPath, expectedSize: r.size })),
  }))
  const rig = { root, lib, card, state, mirrors, tracks, copiedTo: [] } as unknown as Rig
  rig.host = {
    pythonCmd: 'python3', pythonHint: '', coreScript: (rel) => join(REPO, rel), tempDir: root, stateDir: state, pid: process.pid,
    musicDir: join(lib, 'iPod_Control', 'Music'), pathSep: '/', isMac: true,
    sendProgress: (p) => { if (p.phase === 'copy' && /^Copying/.test(p.title)) rig.copiedTo.push(p.title) },
    isCancelled: () => false,
    isStreamedTrackFile: async () => false,
    // An AAC mirror would mean a conversion: an ALAC profile must never ask for one.
    buildAacMirror: async (src) => { throw new Error(`asked to convert ${src} to AAC under an ALAC profile`) },
    // The iPod-safe ALAC rescue: the same cached mirror the last sync copied, at its size.
    buildIpodSafeAlacMirror: async (src) => {
      const size = mirrorSizeBySrc.get(src)
      if (size === undefined) throw new Error(`no iPod-safe mirror expected for ${src}`)
      const out = join(mirrors, createHash('sha1').update(src).digest('hex').slice(0, 16) + '.m4a')
      if (!(await stat(out).catch(() => null))) await sparse(out, size)
      return out
    },
    readIpodDatabase: () => readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')),
    writeJournal: async () => {},
    writeManifest: async (m) => { await writeFile(join(state, LAST_SYNC_MANIFEST_FILE), JSON.stringify(m)) },
    writeSeal: async (s) => { await writeFile(join(state, TSA_SEAL_FILE), JSON.stringify(s)) },
    clearSeal: async () => {},
    writeReport: async () => {},
    getDetectedMount: () => card,
    setDetectedMount: () => {},
    probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
    stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
    freeBytes: async () => 500 * 1024 ** 3,
    remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
    cardCapacityBytes: async () => capacityBytes,
  }
  return rig
}

async function cardInodes(card: string): Promise<Map<string, { ino: number; mtimeMs: number; size: number }>> {
  const out = new Map<string, { ino: number; mtimeMs: number; size: number }>()
  const music = join(card, 'iPod_Control', 'Music')
  for (const f of await readdir(music)) {
    for (const n of await readdir(join(music, f))) {
      const st = await stat(join(music, f, n))
      out.set(`${f}/${n}`, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  return out
}

for (const [name, deviceId, capacity, asIs, rescues] of [
  ['Y2KPod', Y2K_IPOD_ID, 40e9, 373, 46],
  ['iBANDCAMP', IBANDCAMP_IPOD_ID, 256e9, 4010, 1415],
] as const) {
  describe(`${name}: an ALAC profile over the card its last sync left re-copies nothing (real engine, real sizes)`, () => {
    let r: Rig
    before(async () => { r = await rigFor(name, capacity) })
    after(async () => { await rm(r.root, { recursive: true, force: true }) })

    it(`the fixture is the real manifest: ${asIs} masters as they are, ${rescues} iPod-safe ALAC rescues`, () => {
      const rows = FIX.iPods[name]
      assert.equal(rows.filter((x) => x[0] === x[1]).length, asIs)
      assert.equal(rows.filter((x) => x[0] !== x[1]).length, rescues)
    })

    it('ALAC with the Device page toggle ON: the plan keeps every song, copies none, removes none', async () => {
      const convertOptions = convertOptionsForIpod(deviceId, { enabled: true, targetKbps: 256 as const })
      assert.equal(convertOptions?.enabled, false)
      const before = await cardInodes(r.card)
      const res = await runActivitySync(r.host, {
        tracks: r.tracks.map((t) => ({ ...t })), playlists: [{ name, trackIds: r.tracks.map((t) => t.id) }],
        requestedTarget: r.tracks.length, listOnly: true, ipodName: name, convertOptions,
      })
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', String(res.fullReason))
      assert.equal(res.copied, 0)
      assert.deepEqual(res.swap, { out: 0, in: 0, stayed: asIs + rescues, changed: 0 })
      assert.deepEqual(r.copiedTo, [])
      const afterSync = await cardInodes(r.card)
      assert.equal(afterSync.size, before.size)
      for (const [p, b] of before) {
        const a = afterSync.get(p)
        assert.ok(a, `${p} left the card`)
        assert.equal(a.ino, b.ino, `${p} was rewritten`)
        assert.equal(a.mtimeMs, b.mtimeMs, `${p} was rewritten`)
      }
    })
  })
}
