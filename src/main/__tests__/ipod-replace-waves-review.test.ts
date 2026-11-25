/**
 * Brief 265: the two failures the independent review of #499 reproduced on the real engine,
 * kept as tests (ported from its review-499.test.ts).
 *   A: a new extension and a later wave with no room: every song the card's catalog names must
 *      still be on the card after the stop.
 *   B: the app dies while a wave's song list is being proven: the next sync resumes, never a wipe.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogSizesByPath, onCardBytes, waveReserveBytes } from '../ipod-replace-waves.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { LANDED_RECORD_FILE } from '../ipod-landed-record.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}
function readCatalogJson(dbPath: string): Promise<{ tracks: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', dbPath])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`db_reader --json ${code}`))))
  })
}


function harness(name: string) {
  const N = 10, MASTER = 1_000_000, DUR = 200_000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = { mirrorBytes: 250_000, codec: 'aac', freeFn: async () => null as number | null, remountHook: null as null | (() => void), events: [] as string[], wavesSeen: 0 }
  const tracks: Array<Record<string, unknown>> = []
  let root = '', lib = '', card = '', state = '', cache = ''
  let host: ActivitySyncHost
  s.sync = () => runActivitySync(host, {
    tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
    requestedTarget: N, listOnly: true, ipodName: 'Nano', convertOptions: { enabled: true, targetKbps: 256, codec: s.codec },
  })
  s.roomFor = async (n: number, bytes: number) => {
    const db = (await stat(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))).size
    return waveReserveBytes(Math.ceil(db * 1.5), 0) + n * onCardBytes(bytes, 4096) + 2048
  }
  s.dropLanded = () => rm(join(state, LANDED_RECORD_FILE), { force: true })
  s.cardFiles = async () => {
    const out = new Map<string, number>()
    const music = join(card, 'iPod_Control', 'Music')
    for (const f of await readdir(music)) for (const n of await readdir(join(music, f))) out.set(`${f}/${n}`, (await stat(join(music, f, n))).size)
    return out
  }
  s.catalogMissing = async () => {
    const db = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const sizes = catalogSizesByPath(db)!
    const missing: string[] = []
    for (const [p, sz] of sizes) {
      const st = await stat(join(card, p.slice(1).split(':').join('/'))).catch(() => null)
      if (!st || st.size !== sz) missing.push(`${p} (${st ? st.size : 'gone'} vs ${sz})`)
    }
    return missing
  }
  s.before = async () => {
    root = await mkdtemp(join(tmpdir(), name))
    lib = join(root, 'lib'); card = join(root, 'card'); state = join(root, 'state'); cache = join(root, 'cache')
    for (const d of [join(card, 'iPod_Control', 'iTunes'), join(card, 'iPod_Control', 'Music'), state, cache]) await mkdir(d, { recursive: true })
    await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
    for (let id = 1; id <= N; id++) {
      const f = `F${String(id % 3).padStart(2, '0')}`
      await mkdir(join(lib, 'iPod_Control', 'Music', f), { recursive: true })
      await writeFile(join(lib, 'iPod_Control', 'Music', f, `M${id}.m4a`), Buffer.alloc(MASTER, id))
      tracks.push({ id, title: `Song ${id}`, artist: `Band ${id}`, album: 'A', genre: 'Rock', duration: DUR, codec: 'alac',
        path: `:iPod_Control:Music:${f}:M${id}.m4a`, audioFingerprint: `sha1:${id.toString(16).padStart(16, '0')}|${DUR}` })
    }
    host = {
      pythonCmd: 'python3', pythonHint: '', coreScript: (rel) => join(REPO, rel), tempDir: root, stateDir: state, pid: process.pid,
      musicDir: join(lib, 'iPod_Control', 'Music'), pathSep: '/', isMac: true,
      sendProgress: (p) => { s.events.push(p.title); if (/^Replacing \d+ songs? beside/.test(p.title)) s.wavesSeen++ },
      isCancelled: () => false, isStreamedTrackFile: async () => false,
      buildAacMirror: async (src, _k, codec) => {
        const ext = codec === 'mp3' ? '.mp3' : '.m4a'
        const out = join(cache, createHash('sha1').update(`${src}|${s.mirrorBytes}|${ext}`).digest('hex').slice(0, 16) + ext)
        await writeFile(out, Buffer.alloc(s.mirrorBytes, s.mirrorBytes % 251))
        return out
      },
      buildIpodSafeAlacMirror: async () => null,
      readIpodDatabase: () => readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')),
      writeJournal: async () => {},
      writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m)) },
      writeSeal: async (x) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(x)) },
      clearSeal: async () => {}, writeReport: async () => {},
      getDetectedMount: () => card, setDetectedMount: () => {},
      probeHomeminiTrack: async () => ({ ok: false, error: 'n/a' }),
      stageTrack: async () => ({ ok: false, error: 'n/a', reason: 'other' } as never),
      freeBytes: async () => 500 * 1024 ** 3,
      remountVolume: async (m: string) => { if (s.remountHook) s.remountHook(); return { ok: true, mountPoint: m } },
      cardFreeBytes: () => s.freeFn(),
      cardCapacityBytes: async () => 8_000_000,
    }
  }
  s.after = () => rm(root, { recursive: true, force: true })
  return s
}

describe('REVIEW A: a new extension (AAC -> MP3) and a later wave that can\'t go on', () => {
  const h = harness('rv499-a-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('wave 1 commits, wave 2 has no room: every song the card\'s catalog names is still on the card', async () => {
    h.codec = 'mp3'; h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    let calls = 0
    h.freeFn = async () => (++calls === 1 ? r3 : 1000)
    h.events.length = 0; h.wavesSeen = 0
    const r = await h.sync()
    assert.equal(h.wavesSeen, 1, 'one wave committed before the stop')
    const missing = await h.catalogMissing()
    assert.deepEqual(missing, [], 'catalog names files that are not on the card')
  })
})

describe('REVIEW B: the app dies after a wave\'s song list is renamed onto the card (during its proof)', () => {
  const h = harness('rv499-b-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('next sync resumes, never a wipe', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    h.events.length = 0; h.wavesSeen = 0
    h.remountHook = () => { if (h.wavesSeen >= 2) { h.remountHook = null; throw new Error('process died (test)') } }
    await assert.rejects(h.sync(), /process died/)
    h.events.length = 0
    const r = await h.sync()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'swap', String(r.fullReason))
    assert.ok(!h.events.some((t: string) => /^Wiping/.test(t)), 'never a wipe')
  })
})
