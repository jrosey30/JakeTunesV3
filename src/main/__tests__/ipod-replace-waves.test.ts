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
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogSizesByPath, nextWave, noRoomForReplacement, onCardBytes, ownerOfSide, recoverInterruptedWaves, sideName, waveReserveBytes, WAVE_RESERVE_BYTES } from '../ipod-replace-waves.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'
import { LANDED_RECORD_FILE } from '../ipod-landed-record.ts'

describe('wave sizing', () => {
  const items = [{ id: 1, newSize: 400 }, { id: 2, newSize: 400 }, { id: 3, newSize: 400 }]
  it('as many as fit beside their originals, first fit, rounded up to whole clusters, less the reserve', () => {
    assert.deepEqual(nextWave(items, 900, 0, 1).map((w) => w.id), [1, 2])
    assert.deepEqual(nextWave(items, 5000, 0, 1).map((w) => w.id), [1, 2, 3])
    assert.deepEqual(nextWave(items, WAVE_RESERVE_BYTES + 450, WAVE_RESERVE_BYTES, 1).map((w) => w.id), [1])
    assert.deepEqual(nextWave(items, 900, 0, 512).map((w) => w.id), [1], 'each 400-byte file takes a 512-byte cluster')
  })
  it('one big song doesn\'t block smaller ones after it', () => {
    assert.deepEqual(nextWave([{ id: 9, newSize: 5000 }, ...items], 900, 0, 1).map((w) => w.id), [1, 2])
  })
  it('none fits: an empty wave (the sync stops; nothing is deleted to make room)', () => {
    assert.deepEqual(nextWave(items, 399, 0, 1), [])
    assert.match(noRoomForReplacement('Zero', 7_000_000, 1_000_000, WAVE_RESERVE_BYTES), /isn't room .*"Zero".*needs 74 MB free.*1 MB is free\. Nothing was deleted/)
    assert.equal(waveReserveBytes(300_000, 1_000_000), WAVE_RESERVE_BYTES + 1_600_000)
    assert.equal(onCardBytes(1, 32768), 32768)
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
  /** Fail the remount that follows a catalog write, once, from the Nth "Replacing" wave on. */
  let failRemountAtWave = 0
  let wavesSeen = 0
  let remountsFailed = 0
  const tracks: Array<Record<string, unknown>> = []
  let host: ActivitySyncHost
  const sync = () => runActivitySync(host, {
    tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
    requestedTarget: N, listOnly: true, ipodName: 'Nano', convertOptions: { enabled: true, targetKbps: 256, codec: 'aac' },
  })
  /** Free space that holds `n` replacements of `bytes` beside their originals, with the reserve the engine computes. */
  const roomFor = async (n: number, bytes: number) => {
    const db = (await stat(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))).size
    return waveReserveBytes(Math.ceil(db * 1.5), 0) + n * onCardBytes(bytes, 4096) + 2048
  }
  /** A new recipe / format: the record of what's on the card no longer vouches for it. */
  const newFormat = async (bytes: number) => { mirrorBytes = bytes; await rm(join(state, LANDED_RECORD_FILE), { force: true }) }
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
      sendProgress: (p) => { events.push(p.title); if (/^Replacing \d+ songs? beside/.test(p.title)) wavesSeen++ },
      isCancelled: () => false, isStreamedTrackFile: async () => false,
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
      remountVolume: async (m: string) => {
        if (failRemountAtWave > 0 && wavesSeen >= failRemountAtWave && remountsFailed === 0) { remountsFailed++; return { ok: false, error: 'the card went away (test)' } }
        return { ok: true, mountPoint: m }
      },
      cardFreeBytes: async () => free,
      // A real nano's size (8 GB of which these ten songs are a fraction is too lenient: use a card
      // where replacing every song would be well over the 15% hole rule if it counted).
      cardCapacityBytes: async () => 8_000_000,
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

  it('every song changes (a new format) on a small card: swap, not a wipe (the 70% and 15% rules don\'t count replacements); replaced in place in waves; originals gone only after the catalog', async () => {
    free = await roomFor(3, 300_000)                // three replacements at a time
    events.length = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', String(res.fullReason))
    assert.ok(!events.some((t) => /^Wiping/.test(t)), 'never a wipe')
    const waves = events.filter((t) => /^Replacing \d+ songs? beside/.test(t))
    assert.ok(waves.length >= 4 && waves.every((t) => /^Replacing [123] songs?/.test(t)), `waves of at most three: ${waves.join(' | ')}`)
    const files = await cardFiles()
    assert.equal(files.size, N, 'no side file left, nothing extra')
    for (const [p, size] of files) assert.equal(size, 300_000, `${p} is the new copy`)
    const db = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const paths = parseCatalogPaths(db)!
    assert.equal(paths.length, N)
    const sizes = catalogSizesByPath(db)!
    for (const p of paths) assert.equal(sizes.get(p), 300_000)
  })

  it('a remount fails right after a wave\'s song list is written: originals left hidden, nothing put back; the next sync settles them from the list on the card and finishes the waves (no wipe)', async () => {
    await newFormat(320_000)
    free = await roomFor(3, 320_000)
    failRemountAtWave = 2; wavesSeen = 0; remountsFailed = 0
    events.length = 0
    const stopped = await sync()
    assert.equal(stopped.ok, false, 'the run stops when the card can\'t be checked after a write')
    assert.equal(remountsFailed, 1)
    failRemountAtWave = 0
    events.length = 0
    const res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', String(res.fullReason))
    assert.ok(!events.some((t) => /^Wiping/.test(t)), 'never a wipe')
    const files = await cardFiles()
    assert.equal(files.size, N, 'no hidden file left')
    for (const [p, size] of files) assert.equal(size, 320_000, `${p} is the new copy`)
    const sizes = catalogSizesByPath(await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')))!
    assert.equal(sizes.size, N)
    for (const v of sizes.values()) assert.equal(v, 320_000)
  })

  it('a rename that fails mid-wave puts every original of the wave back; the next sync finishes', { skip: process.platform !== 'darwin' }, async () => {
    await newFormat(340_000)
    free = await roomFor(3, 340_000)
    const music = join(card, 'iPod_Control', 'Music')
    const victim = join(music, 'F01', 'M4.m4a')
    execFileSync('chflags', ['uchg', victim])     // its rename to the hidden name fails
    const before = await cardFiles()
    events.length = 0
    let res = await sync()
    execFileSync('chflags', ['nouchg', victim])
    assert.equal(res.ok, false)
    assert.match(String(res.error), /Couldn't put the new copies on the iPod/)
    const after = await cardFiles()
    for (const [p, size] of before) {
      if (after.get(p) !== size) assert.equal(after.get(p), 340_000, `${p}: either the original, or a committed earlier wave`)
    }
    assert.ok(![...after.keys()].some((p) => p.split('/').pop()!.startsWith('.')), 'no hidden file left by the undo')
    res = await sync()
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', String(res.fullReason))
    for (const [p, size] of await cardFiles()) assert.equal(size, 340_000, `${p}`)
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
