/**
 * Brief 265: the failures the independent reviews of #499 reproduced on the real engine, kept
 * as tests (ported from review-499.test.ts), plus a death between a wave's commit and the
 * release of its originals.
 *   A: a new extension and a later wave with no room: every song the card's catalog names is
 *      still on the card after the stop.
 *   B: the app dies while a wave's song list is being proven: the next sync resumes, never a wipe.
 *   C: the card drops while a wave is being put in place, so renaming the originals back fails:
 *      the card stays whole and the next sync resumes.
 *   D: a journal left open, and the iPod rebuilt elsewhere: recovery never puts this Mac's old
 *      song list over a card it no longer describes.
 *   E: the app dies right after a wave's song list is committed, before its originals are
 *      released: the next sync knows the wave committed (it replaces only the rest).
 *   C2: as C, and copying the originals back fails too: the journal stays open (staged).
 *   F: the song list can't be read while a wave is left staged: "can't tell", the journal is
 *      kept and the sync stops; it is never taken as "changed elsewhere".
 *   I (Brief 266): no room for a replacement, and the song list can't be read at that moment:
 *      the stop deletes nothing (it used to take every song off the card).
 *   J (Brief 266): a new extension, and the wave's song list lands but fails its proof: the
 *      old .m4a files are never deleted before a commit names their replacements.
 *   K (Brief 266 1e): a full iPod, songs taken off its list and the rest in a new format: the
 *      songs leaving go first, so the replacements have room (they used to stall halfway).
 *   L (Brief 266 1e): while that happens, no song that stays has its file deleted or moved
 *      before the song list on the card names its new copy.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogSizesByPath, onCardBytes, waveReserveBytes } from '../ipod-replace-waves.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { LANDED_RECORD_FILE } from '../ipod-landed-record.ts'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readWavesJournal, recoverFromJournal } from '../ipod-replace-waves.ts'
const fsp = createRequire(import.meta.url)('node:fs/promises')
const realRename = fsp.rename
let renameHook: null | ((a: string, b: string) => void) = null
fsp.rename = async (a: string, b: string) => { if (renameHook) renameHook(String(a), String(b)); return realRename(a, b) }
const realUnlink = fsp.unlink
/** Throws synchronously: a process that dies at this call, not a failed unlink a caller catches. */
let unlinkHook: null | ((p: string) => void) = null
fsp.unlink = (p: string) => { if (unlinkHook) unlinkHook(String(p)); return realUnlink(p) }
const realCopyFile = fsp.copyFile
let copyHook: null | ((a: string, b: string) => void) = null
fsp.copyFile = async (a: string, b: string, mode?: number) => { if (copyHook) copyHook(String(a), String(b)); return realCopyFile(a, b, mode) }
const realReadFile = fsp.readFile
/** The next n reads of a song list file (iTunesDB) fail with EIO: a card that answers badly for a moment. */
let failDbReads = 0
fsp.readFile = async (p: unknown, ...a: unknown[]) => {
  if (failDbReads > 0 && String(p).endsWith('iTunesDB')) { failDbReads--; throw Object.assign(new Error('EIO (test)'), { code: 'EIO' }) }
  return realReadFile(p, ...a)
}
syncBuiltinESMExports()

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
  /** The iPod's list, when songs were taken off it (null = all N). */
  s.only = null as Set<number> | null
  s.sync = () => {
    const list = tracks.filter((t) => !s.only || s.only.has(Number(t.id)))
    return runActivitySync(host, {
      tracks: list.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: list.map((t) => t.id) }],
      requestedTarget: list.length, listOnly: true, ipodName: 'Nano', convertOptions: { enabled: true, targetKbps: 256, codec: s.codec },
    })
  }
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
      remountVolume: async (m: string) => { if (s.remountHook) s.remountHook(); if (s.remountFail && s.remountFail()) return { ok: false, error: 'test: remount failed' } as never; return { ok: true, mountPoint: m } },
      cardFreeBytes: () => s.freeFn(),
      cardCapacityBytes: async () => 8_000_000,
    }
  }
  /** Bytes the card's files take, whole clusters, hidden files and the song list included. */
  s.cardUsed = async () => {
    let used = 0
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else used += onCardBytes((await stat(p)).size, 4096)
      }
    }
    await walk(join(card, 'iPod_Control'))
    return used
  }
  s.paths = () => ({ card, state })
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
    // Brief 266: wave 1 released its originals, so the stop never says "Nothing was deleted".
    assert.match(String(r.error), /isn't room/)
    assert.doesNotMatch(String(r.error), /Nothing was deleted/)
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

describe('REVIEW C: the card drops while a wave is being put in place, so putting the originals back fails too', () => {
  const h = harness('rv499-c-')
  before(() => h.before()); after(() => { renameHook = null; return h.after() })
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the iPod is left whole, and the next sync resumes (no wipe)', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    let intoPlace = 0
    let dropped = false
    renameHook = (a, b) => {
      if (a.endsWith('.jtnew') && ++intoPlace === 2) { dropped = true; throw Object.assign(new Error('EIO (test: card dropped)'), { code: 'EIO' }) }
      if (dropped && a.endsWith('.jtorig')) throw Object.assign(new Error('ENOENT (test: card gone)'), { code: 'ENOENT' })
    }
    const r1 = await h.sync()
    renameHook = null
    const j = await readWavesJournal(h.paths().state)
    const missing = await h.catalogMissing()
    h.events.length = 0
    const r = await h.sync()
    assert.deepEqual(missing, [], 'between the two syncs the catalog names files that are not on the card')
    assert.equal(r.mode, 'swap', String(r.fullReason))
  })
})

describe('REVIEW D: a journal left open (staged), and the iPod was rebuilt elsewhere before this Mac sees it again', () => {
  const h = harness('rv499-d-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('recovery never puts this Mac\'s old song list over a card it no longer describes', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    h.wavesSeen = 0
    h.remountHook = () => { if (h.wavesSeen >= 1) { h.remountHook = null; throw new Error('process died (test)') } }
    await assert.rejects(h.sync(), /process died/)
    const { card, state } = h.paths()
    const j = await readWavesJournal(state)
    assert.equal(j?.open?.state, 'staged')
    // Elsewhere (iTunes / another Mac): Music emptied, an empty song list written.
    const music = join(card, 'iPod_Control', 'Music')
    for (const f of await readdir(music)) await rm(join(music, f), { recursive: true, force: true })
    await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
    const { restoreItunesDbBackup } = await import('../ipod-db-backup.ts')
    const out = await recoverFromJournal(card, j!, async (dir) => { await restoreItunesDbBackup(dir, card) })
    const missing = await h.catalogMissing()
    assert.deepEqual(missing, [], 'the restored song list names files that are not on the card')
  })
})

describe('E: the app dies after a wave is committed, before its originals are released', () => {
  const h = harness('rv499-e-')
  before(() => h.before()); after(() => { unlinkHook = null; return h.after() })
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the next sync knows that wave committed: it releases its originals and replaces only the rest', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    h.wavesSeen = 0
    unlinkHook = (p) => { if (p.endsWith('.jtorig')) { unlinkHook = null; throw new Error('process died (test)') } }
    await assert.rejects(h.sync(), /process died/)
    const j = await readWavesJournal(h.paths().state)
    assert.equal(j?.open?.state, 'committed', 'the journal says the wave committed')
    const committedWave = j!.open!.items.length
    h.events.length = 0
    const r = await h.sync()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'swap', String(r.fullReason))
    assert.equal(r.swap?.out, 10 - committedWave, 'the committed wave is not replaced again')
    for (const [p, size] of await h.cardFiles()) assert.equal(size, 300_000, `${p} is the new copy`)
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('C2: the card drops while a wave is put in place, and both renaming and copying the originals back fail', () => {
  const h = harness('rv499-c2-')
  before(() => h.before()); after(() => { renameHook = null; copyHook = null; return h.after() })
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the journal stays open (staged) for the next sync, and the message says not every song is back', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    let intoPlace = 0
    let dropped = false
    renameHook = (a) => {
      if (a.endsWith('.jtnew') && ++intoPlace === 2) { dropped = true; throw Object.assign(new Error('EIO (test: card dropped)'), { code: 'EIO' }) }
      if (dropped && a.endsWith('.jtorig')) throw Object.assign(new Error('ENOENT (test: card gone)'), { code: 'ENOENT' })
    }
    copyHook = (a) => { if (dropped && a.endsWith('.jtorig')) throw Object.assign(new Error('EIO (test: card gone)'), { code: 'EIO' }) }
    const r1 = await h.sync()
    renameHook = null; copyHook = null
    assert.equal(r1.ok, false)
    assert.doesNotMatch(String(r1.error), /Every song is as it was/)
    const j = await readWavesJournal(h.paths().state)
    assert.equal(j?.open?.state, 'staged', 'the journal is still open: nothing was put back')
    h.events.length = 0
    const r = await h.sync()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'swap', String(r.fullReason))
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('F: the song list can\'t be read for a moment while a wave is left staged', () => {
  const h = harness('rv499-f-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('an unreadable song list is "can\'t tell", not "changed elsewhere": the journal is kept and the sync stops', async () => {
    h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    h.wavesSeen = 0
    h.remountHook = () => { if (h.wavesSeen >= 1) { h.remountHook = null; throw new Error('process died (test)') } }
    await assert.rejects(h.sync(), /process died/)
    const { card, state } = h.paths()
    const j = await readWavesJournal(state)
    assert.equal(j?.open?.state, 'staged')
    const db = join(card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const { rename: mv } = await import('node:fs/promises')
    await mv(db, db + '.away')   // the read fails (a mount hiccup)
    const out = await recoverFromJournal(card, j!, async () => {})
    assert.equal(out.report.stale, false, 'never taken as changed elsewhere')
    assert.equal(out.report.unreadable, true)
    const r = await h.sync()
    assert.equal(r.ok, false)
    assert.match(String(r.error), /Couldn’t read the song list on the iPod/)
    assert.equal((await readWavesJournal(state))?.open?.state, 'staged', 'the journal is kept')
    await mv(db + '.away', db)
    const r2 = await h.sync()
    assert.equal(r2.ok, true, r2.error)
    assert.equal(r2.mode, 'swap', String(r2.fullReason))
  })
})

/** Leaves a wave staged and the journal open: the sync dies right after its first wave. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stopMidWave(h: any): Promise<void> {
  h.mirrorBytes = 300_000; await h.dropLanded()
  const r3 = await h.roomFor(3, 300_000)
  h.freeFn = async () => r3
  h.wavesSeen = 0
  h.remountHook = () => { if (h.wavesSeen >= 1) { h.remountHook = null; throw new Error('process died (test)') } }
  await assert.rejects(h.sync(), /process died/)
  h.freeFn = async () => null
}

describe('G: a wave left staged, then the iPod restored with no song list file at all: the journal goes, nothing is wiped, and it syncs once Finder sets it up', () => {
  const h = harness('rv499-g-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('never stuck, never an empty iPod from the sync', async () => {
    await stopMidWave(h)
    const { card, state } = h.paths()
    assert.equal((await readWavesJournal(state))?.open?.state, 'staged')
    const music = join(card, 'iPod_Control', 'Music')
    for (const f of await readdir(music)) await rm(join(music, f), { recursive: true, force: true })
    const db = join(card, 'iPod_Control', 'iTunes', 'iTunesDB')
    await rm(db)
    const out = await recoverFromJournal(card, (await readWavesJournal(state))!, async () => {})
    assert.equal(out.report.noSongList, true)
    assert.equal(out.report.unreadable, false)
    const r = await h.sync()
    assert.equal(r.ok, false)
    assert.match(String(r.error), /no song list file to write to/)
    assert.equal(await readWavesJournal(state), null, 'the journal is gone: the next sync isn\'t held by it')
    assert.equal((await h.cardFiles()).size, 0, 'nothing was put on, nothing written')
    await writeFile(db, emptyTemplate())   // Finder set it up
    const r2 = await h.sync()
    assert.equal(r2.ok, true, r2.error)
    assert.equal(r2.mode, 'full')
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('G2: a wave left staged, then the iPod restored in Finder (an empty song list, no songs): the journal goes and the sync is a full copy', () => {
  const h = harness('rv499-g2-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('a plain full copy', async () => {
    await stopMidWave(h)
    const { card, state } = h.paths()
    const music = join(card, 'iPod_Control', 'Music')
    for (const f of await readdir(music)) await rm(join(music, f), { recursive: true, force: true })
    await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
    const r = await h.sync()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'full')
    assert.equal(await readWavesJournal(state), null)
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('H: the song list file stays missing with the songs still on the iPod: two stops, then the journal goes, and the songs are never wiped for want of a song list', () => {
  const h = harness('rv499-h-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('stops twice keeping the journal; the third drops it and still touches nothing; back to normal once the file is back', async () => {
    await stopMidWave(h)
    const { card, state } = h.paths()
    const db = join(card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const { rename: mv } = await import('node:fs/promises')
    await mv(db, db + '.away')
    const onCard = await h.cardFiles()
    assert.ok(onCard.size > 0)
    for (const n of [1, 2]) {
      const r = await h.sync()
      assert.equal(r.ok, false)
      assert.match(String(r.error), /Couldn’t read the song list on the iPod/)
      assert.equal((await readWavesJournal(state))?.unreadableStops, n)
    }
    const r = await h.sync()
    assert.equal(r.ok, false)
    assert.match(String(r.error), /no song list file to write to/)
    assert.equal(await readWavesJournal(state), null, 'the journal is gone after 3 stops')
    assert.deepEqual(await h.cardFiles(), onCard, 'every song still on the iPod')
    await mv(db + '.away', db)
    const r2 = await h.sync()
    assert.equal(r2.ok, true, r2.error)
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('I (Brief 266): no room for a replacement, and the song list can\'t be read at that moment', () => {
  const h = harness('b266-i-')
  before(() => h.before()); after(() => { failDbReads = 0; return h.after() })
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the stop deletes no song, and the next sync finds the card whole', async () => {
    h.codec = 'mp3'; h.mirrorBytes = 300_000; await h.dropLanded()
    h.freeFn = async () => { failDbReads = 1; return 1000 }
    const onCard = await h.cardFiles()
    const r = await h.sync()
    failDbReads = 0
    assert.equal(r.ok, false)
    assert.match(String(r.error), /isn't room/)
    assert.deepEqual(await h.cardFiles(), onCard, 'every song still on the iPod')
    assert.deepEqual(await h.catalogMissing(), [])
  })
})

describe('J (Brief 266): a new extension, and the wave\'s song list lands on the card but its proof fails (remount)', () => {
  const h = harness('b266-j-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the wave\'s old .m4a files are still on the card after the stop, and the next sync never wipes', async () => {
    h.codec = 'mp3'; h.mirrorBytes = 300_000; await h.dropLanded()
    const r3 = await h.roomFor(3, 300_000)
    h.freeFn = async () => r3
    const onCard = await h.cardFiles()
    h.events.length = 0; h.wavesSeen = 0
    h.remountFail = () => h.wavesSeen >= 1
    const r = await h.sync()
    h.remountFail = null
    assert.equal(r.ok, false)
    assert.equal(h.wavesSeen, 1, 'the stop came in the first wave')
    const after = await h.cardFiles()
    const gone = [...onCard.keys()].filter((k) => !after.has(k))
    assert.deepEqual(gone, [], 'an original was deleted before its replacement was committed')
    h.events.length = 0
    const r2 = await h.sync()
    assert.equal(h.events.some((t: string) => /^Wiping/.test(t)), false, 'the next sync wiped the iPod')
    assert.deepEqual(await h.catalogMissing(), [])
    assert.equal(r2.ok, true, r2.error)
  })
})

/** A full card: free space is what its files leave of a fixed capacity, measured on the card itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fillCard(h: any, slackBytes: number): Promise<void> {
  const capacity = (await h.cardUsed()) + (await h.roomFor(0, 0)) + slackBytes
  h.freeFn = async () => Math.max(0, capacity - (await h.cardUsed()))
}

describe('K (Brief 266 1e): a full iPod, four songs taken off its list, the other six in a new format', () => {
  const h = harness('b266-k-')
  before(() => h.before()); after(() => h.after())
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('the leaving songs go first, so every replacement fits and the sync finishes', async () => {
    // Not room for even one new copy beside its original until the leaving songs are gone.
    await fillCard(h, 100_000)
    h.only = new Set([1, 2, 3, 4, 5, 6])
    h.codec = 'mp3'; h.mirrorBytes = 300_000; await h.dropLanded()
    h.events.length = 0; h.wavesSeen = 0
    const r = await h.sync()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'swap', String(r.fullReason))
    assert.equal(h.events.some((t: string) => /^Wiping/.test(t)), false, 'never a wipe')
    assert.ok(h.wavesSeen >= 2, `replaced in waves (${h.wavesSeen})`)
    const files = await h.cardFiles()
    assert.equal(files.size, 6, `six songs on the card: ${[...files.keys()].join(', ')}`)
    for (const [p, size] of files) { assert.match(p, /\.mp3$/); assert.equal(size, 300_000) }
    assert.deepEqual(await h.catalogMissing(), [])
    const sizes = catalogSizesByPath(await readFile(join(h.paths().card, 'iPod_Control', 'iTunes', 'iTunesDB')))!
    assert.equal(sizes.size, 6)
  })
})

describe('L (Brief 266 1e): a song that stays keeps its file until the song list names its new copy', () => {
  const h = harness('b266-l-')
  before(() => h.before()); after(() => { renameHook = null; unlinkHook = null; return h.after() })
  it('first sync', async () => { const r = await h.sync(); assert.equal(r.ok, true, r.error) })
  it('removing the leaving songs never touches a staying song\'s file; each original goes only after its commit', async () => {
    const { card } = h.paths()
    const onCard = await h.cardFiles()
    // The songs that stay (ids 1-6), by their card file.
    const stayOld = new Set<string>()
    for (const k of onCard.keys()) { const m = /M(\d+)\.m4a$/.exec(k); if (m && Number(m[1]) <= 6) stayOld.add(join(card, 'iPod_Control', 'Music', k)) }
    assert.equal(stayOld.size, 6, [...onCard.keys()].join(', '))
    const named = (abs: string): boolean => {
      const listed = catalogSizesByPath(readFileSync(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')))
      const colon = (':' + abs.slice(card.length + 1).split('/').join(':')).toLowerCase()
      return !!listed && [...listed.keys()].some((p) => p.toLowerCase() === colon)
    }
    const bad: string[] = []
    const touched = (p: string, how: string): void => {
      if (!stayOld.has(p)) return
      const mp3 = p.replace(/\.m4a$/, '.mp3')
      if (!named(mp3)) bad.push(`${how} ${p} before the song list named its new copy`)
      if (named(p)) bad.push(`${how} ${p} while the song list still names it`)
    }
    unlinkHook = (p) => touched(p, 'deleted')
    renameHook = (a) => touched(a, 'moved')
    await fillCard(h, 100_000)
    h.only = new Set([1, 2, 3, 4, 5, 6])
    h.codec = 'mp3'; h.mirrorBytes = 300_000; await h.dropLanded()
    const r = await h.sync()
    unlinkHook = null; renameHook = null
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(bad, [])
    assert.deepEqual(await h.catalogMissing(), [])
    assert.equal((await h.cardFiles()).size, 6)
  })
})
