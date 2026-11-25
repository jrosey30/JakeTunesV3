/**
 * Brief 265 Part 5 (Amendment 2): the landed record keeps a converted song only when every
 * field matches (ipod-landed-record.ts), and the real activity engine keeps converted songs
 * through an emptied convert cache without converting them again.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landedVerdict, parseLandedRecord, recipeFor, LANDED_RECORD_FILE, type LandedEntry, type LandedNow } from '../ipod-landed-record.ts'
import { AAC_MIRROR_TOKEN, IPOD_ALAC_MIRROR_TOKEN, MP3_MIRROR_TOKEN } from '../aac-mirror-recipe.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'

const entry: LandedEntry = {
  rawColon: ':iPod_Control:Music:F27:imported_14677.m4a', destPath: ':iPod_Control:Music:F27:imported_14677.m4a',
  size: 8772033, source: { size: 53419680, mtimeMs: 1795000000000 }, codec: 'aac', kbps: 256, recipe: AAC_MIRROR_TOKEN,
}
const now: LandedNow = { rawColon: entry.rawColon, sourceSize: 53419680, sourceMtimeMs: 1795000000000, codec: 'aac', kbps: 256, cardSize: 8772033 }

describe('landedVerdict: every field must match', () => {
  it('a full match keeps the song', () => assert.equal(landedVerdict(entry, now), 'keep'))
  it('a re-ripped master (size or mtime) is converted again', () => {
    assert.equal(landedVerdict(entry, { ...now, sourceSize: 53419681 }), 'the master changed')
    assert.equal(landedVerdict(entry, { ...now, sourceMtimeMs: 1795000001000 }), 'the master changed')
  })
  it('another bitrate or format', () => {
    assert.equal(landedVerdict(entry, { ...now, kbps: 320 }), 'another bitrate')
    assert.equal(landedVerdict(entry, { ...now, codec: 'mp3', kbps: 256 }), 'another format')
  })
  it('a recipe bump: an entry made by an older recipe is stale', () => {
    assert.equal(landedVerdict({ ...entry, recipe: 'afenc-cbr-44100-2-v3' }, now), 'an older recipe')
  })
  it('the card file missing or another size', () => {
    assert.equal(landedVerdict(entry, { ...now, cardSize: null }), 'not on the card')
    assert.equal(landedVerdict(entry, { ...now, cardSize: 1 }), 'the card file changed')
    assert.equal(landedVerdict(undefined, now), 'no record')
  })
  it('the recipe tokens are the cache keys\' tokens', () => {
    assert.equal(recipeFor('aac'), AAC_MIRROR_TOKEN)
    assert.equal(recipeFor('mp3'), MP3_MIRROR_TOKEN)
    assert.equal(recipeFor('alac-safe'), IPOD_ALAC_MIRROR_TOKEN)
  })
  it('a torn entry is dropped, never trusted', () => {
    const m = parseLandedRecord({ entries: { 1: entry, 2: { ...entry, size: 0 }, 3: { ...entry, codec: 'flac' }, x: entry } })
    assert.deepEqual([...m.keys()], [1])
  })
})

// ── The real engine, on a fake card (the swap-engine rig's shape) ──
const REPO = join(import.meta.dirname, '..', '..', '..')
const N = 12
const MASTER_BYTES = 1_000_000
const MIRROR_BYTES = 250_000
const DURATION_MS = 200_000

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

describe('the real engine: an emptied convert cache converts nothing again', () => {
  let root: string, lib: string, card: string, state: string, mirrors: string
  let host: ActivitySyncHost
  let converts = 0
  let mirrorFails = false
  const tracks: Array<Record<string, unknown>> = []
  const options = { enabled: true, targetKbps: 256 as const, codec: 'aac' as const }
  const sync = () => runActivitySync(host, {
    tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
    requestedTarget: tracks.length, listOnly: true, ipodName: 'Nano', convertOptions: options,
  })
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'b265-landed-'))
    lib = join(root, 'lib'); card = join(root, 'card'); state = join(root, 'state'); mirrors = join(root, 'cache')
    for (const d of [join(card, 'iPod_Control', 'iTunes'), join(card, 'iPod_Control', 'Music'), state, mirrors]) await mkdir(d, { recursive: true })
    await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
    for (let id = 1; id <= N; id++) {
      const f = `F${String(id % 4).padStart(2, '0')}`
      await mkdir(join(lib, 'iPod_Control', 'Music', f), { recursive: true })
      await writeFile(join(lib, 'iPod_Control', 'Music', f, `M${id}.m4a`), Buffer.alloc(MASTER_BYTES, id))
      tracks.push({ id, title: `Song ${id}`, artist: `Band ${id}`, album: 'A', genre: 'Rock', duration: DURATION_MS, codec: 'alac',
        path: `:iPod_Control:Music:${f}:M${id}.m4a`, audioFingerprint: `sha1:${id.toString(16).padStart(16, '0')}|${DURATION_MS}` })
    }
    host = {
      pythonCmd: 'python3', pythonHint: '', coreScript: (rel) => join(REPO, rel), tempDir: root, stateDir: state, pid: process.pid,
      musicDir: join(lib, 'iPod_Control', 'Music'), pathSep: '/', isMac: true, sendProgress: () => {}, isCancelled: () => false,
      isStreamedTrackFile: async () => false,
      // A stand-in for the AAC mirror: a smaller file, made once per master revision, counted.
      buildAacMirror: async (src) => {
        converts++
        if (mirrorFails) return null
        const st = await stat(src)
        const out = join(mirrors, createHash('sha1').update(`${src}|256|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16) + '.m4a')
        await writeFile(out, Buffer.alloc(MIRROR_BYTES + (st.size % 7), 7))
        return out
      },
      buildIpodSafeAlacMirror: async () => null,
      readIpodDatabase: () => readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')),
      writeJournal: async () => {},
      writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m)) },
      writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s)) },
      clearSeal: async () => {},
      writeReport: async () => {},
      getDetectedMount: () => card, setDetectedMount: () => {},
      probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
      stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
      freeBytes: async () => 500 * 1024 ** 3,
      remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
    }
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('first sync converts and copies every song, and records each one', async () => {
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(converts, N)
    assert.equal(res.copied, N)
    const rec = JSON.parse(await readFile(join(state, LANDED_RECORD_FILE), 'utf-8'))
    assert.equal(Object.keys(rec.entries).length, N)
    const e = rec.entries['1']
    assert.equal(e.codec, 'aac'); assert.equal(e.kbps, 256); assert.equal(e.recipe, AAC_MIRROR_TOKEN)
    assert.equal(e.source.size, MASTER_BYTES)
  })

  it('the cache is emptied: the next sync converts nothing and copies nothing', async () => {
    for (const n of await readdir(mirrors)) await rm(join(mirrors, n))
    converts = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', String(res.fullReason))
    assert.equal(converts, 0, 'no mirror rebuilt')
    assert.equal(res.copied, 0)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N, changed: 0 })
  })

  it('a re-ripped master: exactly that song is converted and copied again', async () => {
    const t = tracks[4]
    const p = join(lib, String(t.path).replace(/:/g, '/').replace(/^\//, ''))
    await writeFile(p, Buffer.alloc(MASTER_BYTES + 3, 9))
    converts = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(converts, 1)
    assert.equal(res.copied, 1)
    assert.equal(res.swap?.stayed, N - 1)
  })

  it('a record from another seal is ignored: everything is converted again, nothing kept on its word', async () => {
    const stale = join(root, 'stale-record.json')
    await copyFile(join(state, LANDED_RECORD_FILE), stale)
    const res1 = await sync()                      // seals again: a new record at the new seal's time
    assert.equal(res1.ok, true, res1.error)
    await copyFile(stale, join(state, LANDED_RECORD_FILE))   // as if an old record had survived
    for (const n of await readdir(mirrors)) await rm(join(mirrors, n))
    converts = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(converts, N, 'the stale record kept nothing')
    assert.equal(res.copied, 0, 'and nothing had to move')
  })

  it('the record is gone before the card is touched; if it can\'t be removed, the sync refuses with the card untouched', async () => {
    const src = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    const drop = src.indexOf('await deleteLandedRecord(host.stateDir)')
    assert.ok(drop > 0 && drop < src.indexOf('// ── 3. Remove (swap) or wipe (full) ──'), 'before the remove / wipe / first copy')
    const full = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    assert.ok(full.indexOf('await deleteLandedRecord(syncStateDir)') < full.indexOf('await securePlaysBeforeSync('), 'the full-library sync drops it first too')
    await rm(join(state, LANDED_RECORD_FILE), { force: true })
    await mkdir(join(state, LANDED_RECORD_FILE, 'blocker'), { recursive: true })   // unremovable
    const before = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const res = await sync()
    assert.equal(res.ok, false)
    assert.match(String(res.error), /record of converted songs.*Nothing on the iPod was changed/)
    assert.ok((await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))).equals(before))
    await rm(join(state, LANDED_RECORD_FILE), { recursive: true, force: true })
    const ok = await sync()                        // writes a fresh record
    assert.equal(ok.ok, true, ok.error)
  })

  it('a kept song that must be copied and can\'t be converted again is left off, never copied as its lossless master', async () => {
    // A stranger file on the card: no swap proof, so a full copy, and every kept song must move.
    await writeFile(join(card, 'iPod_Control', 'Music', 'F01', 'STRANGER.m4a'), Buffer.alloc(1000))
    mirrorFails = true
    for (const n of await readdir(mirrors)) await rm(join(mirrors, n))
    const res = await sync()
    mirrorFails = false
    const masterSized: string[] = []
    for (const f of await readdir(join(card, 'iPod_Control', 'Music'))) {
      for (const n of await readdir(join(card, 'iPod_Control', 'Music', f))) {
        if ((await stat(join(card, 'iPod_Control', 'Music', f, n))).size >= MASTER_BYTES) masterSized.push(n)
      }
    }
    assert.deepEqual(masterSized, [], 'no lossless master went on the card')
    assert.ok(!res.ok || (res.leftOff ?? []).length > 0, 'the songs are refused or left off, by name')
  })
})
