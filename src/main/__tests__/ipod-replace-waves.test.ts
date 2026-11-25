/**
 * Brief 265 Parts 2-3, the final safeguard: a song whose card file changes is replaced beside
 * its original, in waves sized to the card's free space, and the original is deleted only after
 * the catalog naming the replacement is committed (ipod-replace-waves.ts + the activity engine).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogSizesByPath, nextWave, noRoomForReplacement, ownerOfSide, recoverInterruptedWaves, sideName, WAVE_RESERVE_BYTES } from '../ipod-replace-waves.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'
import { LANDED_RECORD_FILE } from '../ipod-landed-record.ts'

describe('wave sizing', () => {
  const items = [{ id: 1, newSize: 400 }, { id: 2, newSize: 400 }, { id: 3, newSize: 400 }]
  it('as many as fit beside their originals, in order, less the reserve', () => {
    assert.deepEqual(nextWave(items, 900, 0).map((w) => w.id), [1, 2])
    assert.deepEqual(nextWave(items, 5000, 0).map((w) => w.id), [1, 2, 3])
    assert.deepEqual(nextWave(items, WAVE_RESERVE_BYTES + 450).map((w) => w.id), [1])
  })
  it('none fits: an empty wave (the sync stops; nothing is deleted to make room)', () => {
    assert.deepEqual(nextWave(items, 399, 0), [])
    assert.match(noRoomForReplacement('Zero', 7_000_000, 1_000_000), /isn't room .*"Zero".*Nothing was deleted/)
  })
  it('side names are hidden, beside the file, and map back', () => {
    const n = sideName('/V/iPod_Control/Music/F27/14677.m4a', 'jtnew')
    assert.equal(n, '/V/iPod_Control/Music/F27/.14677.m4a.jtnew')
    assert.deepEqual(ownerOfSide(n), { owner: '/V/iPod_Control/Music/F27/14677.m4a', tag: 'jtnew' })
    assert.equal(ownerOfSide('/V/iPod_Control/Music/F27/14677.m4a'), null)
  })
})

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

describe('a format change on the real engine: replaced in place, in waves, never a wipe', () => {
  const N = 10
  const MASTER = 1_000_000
  const DUR = 200_000
  let root: string, lib: string, card: string, state: string, cache: string
  let mirrorBytes = 250_000
  let free: number | null = null
  const events: string[] = []
  const tracks: Array<Record<string, unknown>> = []
  let host: ActivitySyncHost
  const sync = () => runActivitySync(host, {
    tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
    requestedTarget: N, listOnly: true, ipodName: 'Nano', convertOptions: { enabled: true, targetKbps: 256, codec: 'aac' },
  })
  const cardFiles = async () => {
    const out = new Map<string, number>()
    const music = join(card, 'iPod_Control', 'Music')
    for (const f of await readdir(music)) for (const n of await readdir(join(music, f))) out.set(`${f}/${n}`, (await stat(join(music, f, n))).size)
    return out
  }
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'b265-waves-'))
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
      sendProgress: (p) => { events.push(p.title) }, isCancelled: () => false, isStreamedTrackFile: async () => false,
      // The "recipe": its output size stands for the encode; a new size = a new format/recipe.
      buildAacMirror: async (src) => {
        const out = join(cache, createHash('sha1').update(`${src}|${mirrorBytes}`).digest('hex').slice(0, 16) + '.m4a')
        await writeFile(out, Buffer.alloc(mirrorBytes, mirrorBytes % 251))
        return out
      },
      buildIpodSafeAlacMirror: async () => null,
      readIpodDatabase: () => readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')),
      writeJournal: async () => {},
      writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m)) },
      writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s)) },
      clearSeal: async () => {}, writeReport: async () => {},
      getDetectedMount: () => card, setDetectedMount: () => {},
      probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
      stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
      freeBytes: async () => 500 * 1024 ** 3,
      remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
      cardFreeBytes: async () => free,
    }
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('first sync puts all 10 on', async () => {
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.copied, N)
  })

  it('a card with no room for even one replacement beside its original: the sync stops, nothing deleted', async () => {
    const before = await cardFiles()
    const dbBefore = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    mirrorBytes = 300_000
    await rm(join(state, LANDED_RECORD_FILE), { force: true })
    free = WAVE_RESERVE_BYTES + 100_000
    events.length = 0
    const res = await sync()
    assert.equal(res.ok, false)
    assert.match(String(res.error), /isn't room .*Nothing was deleted/)
    assert.deepEqual(await cardFiles(), before, 'every original still there, nothing staged left behind')
    assert.ok((await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))).equals(dbBefore))
  })

  it('every song changes (a new format): swap, not a wipe; replaced in place in waves of what fits; originals gone only after the catalog', async () => {
    free = WAVE_RESERVE_BYTES + 3 * 300_000 + 10        // three replacements at a time
    events.length = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', String(res.fullReason))
    assert.ok(!events.some((t) => /^Wiping/.test(t)), 'never a wipe')
    const waves = events.filter((t) => /^Replacing \d+ songs? beside/.test(t))
    assert.ok(waves.length >= 4, `waves of at most three: ${waves.join(' | ')}`)
    const files = await cardFiles()
    assert.equal(files.size, N, 'no side file left, nothing extra')
    for (const [p, size] of files) assert.equal(size, 300_000, `${p} is the new copy`)
    const db = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const paths = parseCatalogPaths(db)!
    assert.equal(paths.length, N)
    const sizes = catalogSizesByPath(db)!
    for (const p of paths) assert.equal(sizes.get(p), 300_000)
  })
})

describe('a wave cut off part-way is put right by the next sync, from the catalog on the card', () => {
  it('not committed: the original goes back; committed: the original goes; an unfinished copy goes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b265-recover-'))
    const music = join(root, 'iPod_Control', 'Music', 'F01')
    await mkdir(music, { recursive: true })
    // A: swapped, catalog still the old one (old size 500) -> restore the original.
    await writeFile(join(music, 'A.m4a'), Buffer.alloc(300))
    await writeFile(join(music, '.A.m4a.jtorig'), Buffer.alloc(500))
    // B: swapped and the catalog committed (new size 300) -> release the original.
    await writeFile(join(music, 'B.m4a'), Buffer.alloc(300))
    await writeFile(join(music, '.B.m4a.jtorig'), Buffer.alloc(500))
    // C: staged, never swapped -> the staged copy goes, the original stays.
    await writeFile(join(music, 'C.m4a'), Buffer.alloc(500))
    await writeFile(join(music, '.C.m4a.jtnew'), Buffer.alloc(300))
    const catalog = new Map([[':iPod_Control:Music:F01:A.m4a', 500], [':iPod_Control:Music:F01:B.m4a', 300], [':iPod_Control:Music:F01:C.m4a', 500]])
    const rep = await recoverInterruptedWaves(join(root, 'iPod_Control', 'Music'), catalog, (abs) => ':' + abs.slice(root.length + 1).split('/').join(':'))
    assert.equal(rep.restored.length, 1)
    assert.equal(rep.released.length, 1)
    assert.equal(rep.staleNew.length, 1)
    const left = (await readdir(music)).sort()
    assert.deepEqual(left, ['A.m4a', 'B.m4a', 'C.m4a'])
    assert.equal((await stat(join(music, 'A.m4a'))).size, 500, 'A is its original again: the catalog describes it')
    assert.equal((await stat(join(music, 'B.m4a'))).size, 300)
    assert.equal((await stat(join(music, 'C.m4a'))).size, 500)
    // Zero catalog entries point at a missing file.
    for (const [p] of catalog) await stat(join(root, p.slice(1).split(':').join('/')))
  })
  it('no catalog to go by: nothing is touched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b265-recover-'))
    const music = join(root, 'iPod_Control', 'Music', 'F01')
    await mkdir(music, { recursive: true })
    await writeFile(join(music, 'A.m4a'), Buffer.alloc(300))
    await writeFile(join(music, '.A.m4a.jtorig'), Buffer.alloc(500))
    const rep = await recoverInterruptedWaves(join(root, 'iPod_Control', 'Music'), null, (abs) => abs)
    assert.deepEqual(rep.kept.length, 1)
    assert.deepEqual((await readdir(music)).sort(), ['.A.m4a.jtorig', 'A.m4a'])
  })
})
