/**
 * Brief 266, suspect 2 (a): one song's AAC conversion fails while Apple's encoder is there.
 * buildAacMirror used to return null, which the activity engine reads as "nothing to
 * convert", so the lossless master went onto the AAC iPod with only a console.warn. Now the
 * failure is thrown (AacConvertFailedError), and:
 *   • a song NOT on the card yet is left off and named in leftOff;
 *   • a song the last sealed sync put on the card keeps that copy and its song-list row, and
 *     is named as kept (review of #519: dropping it let the swap delete it from the card);
 *   • a failure that was the Mac's (a timeout) is never called a damaged file.
 *
 * The real engine on a fake card in a temp folder (the landed-record test's rig).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AacConvertFailedError, AacEncoderMissingError } from '../aac-mirror-recipe.ts'
import { CONVERT_FAILED_THIS_TIME, runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'
import { leftOffKind } from '../../common/ipod-one-sync-plan.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const N = 6
const BAD = 3
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
/** What execFile rejects with when its timeout kills ffmpeg. */
const ffmpegTimeout = (): Error => Object.assign(new Error('Command failed: ffmpeg'), { killed: true, signal: 'SIGTERM' })

interface Rig {
  root: string; lib: string; card: string; state: string
  tracks: Array<Record<string, unknown>>
  failWith: (fn: (src: string) => Error | null) => void
  sync: () => ReturnType<typeof runActivitySync>
  cardFiles: () => Promise<Array<{ name: string; size: number; mtimeMs: number }>>
  catalogTitles: () => Promise<string[]>
  lastLedger: () => Promise<{ leftOff?: Array<{ id: number; t?: string; why?: string }>; keptOldCopies?: string[] }>
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'b266-aac-fails-'))
  const lib = join(root, 'lib'), card = join(root, 'card'), state = join(root, 'state'), mirrors = join(root, 'cache')
  for (const d of [join(card, 'iPod_Control', 'iTunes'), join(card, 'iPod_Control', 'Music'), state, mirrors]) await mkdir(d, { recursive: true })
  await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
  const tracks: Array<Record<string, unknown>> = []
  for (let id = 1; id <= N; id++) {
    const f = `F${String(id % 3).padStart(2, '0')}`
    await mkdir(join(lib, 'iPod_Control', 'Music', f), { recursive: true })
    await writeFile(join(lib, 'iPod_Control', 'Music', f, `M${id}.m4a`), Buffer.alloc(MASTER_BYTES, id))
    tracks.push({ id, title: `Song ${id}`, artist: `Band ${id}`, album: 'A', genre: 'Rock', duration: DURATION_MS, codec: 'alac',
      path: `:iPod_Control:Music:${f}:M${id}.m4a`, audioFingerprint: `sha1:${id.toString(16).padStart(16, '0')}|${DURATION_MS}` })
  }
  let failWith: (src: string) => Error | null = () => null
  const host: ActivitySyncHost = {
    pythonCmd: 'python3', pythonHint: '', coreScript: (rel) => join(REPO, rel), tempDir: root, stateDir: state, pid: process.pid,
    musicDir: join(lib, 'iPod_Control', 'Music'), pathSep: '/', isMac: true, sendProgress: () => {}, isCancelled: () => false,
    isStreamedTrackFile: async () => false,
    // A stand-in for buildAacMirror: a smaller file per master revision, or the thrown failure the real one now gives.
    buildAacMirror: async (src) => {
      const err = failWith(src)
      if (err) throw err
      const st = await stat(src)
      const out = join(mirrors, `${src.split('/').pop()}-${st.size}.m4a`)
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
  return {
    root, lib, card, state, tracks,
    failWith: (fn) => { failWith = fn },
    sync: () => runActivitySync(host, {
      tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
      requestedTarget: tracks.length, listOnly: true, ipodName: 'Nano',
      convertOptions: { enabled: true, targetKbps: 256, codec: 'aac' },
    }),
    cardFiles: async () => {
      const out: Array<{ name: string; size: number; mtimeMs: number }> = []
      for (const f of await readdir(join(card, 'iPod_Control', 'Music'))) {
        for (const n of await readdir(join(card, 'iPod_Control', 'Music', f))) {
          const st = await stat(join(card, 'iPod_Control', 'Music', f, n))
          out.push({ name: `${f}/${n}`, size: st.size, mtimeMs: st.mtimeMs })
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    catalogTitles: async () => (await readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))).tracks.map((t) => String(t.title)).sort(),
    lastLedger: async () => {
      const lines = (await readFile(join(state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n')
      return JSON.parse(lines[lines.length - 1])
    },
  }
}

const isMaster = (f: { size: number }): boolean => f.size >= MASTER_BYTES

describe('the real activity engine: one song whose AAC conversion fails', () => {
  it('a new song (not on the card): left off and named; no lossless master goes on; the rest land', async () => {
    const r = await rig()
    try {
      r.failWith((src) => (src.endsWith(`M${BAD}.m4a`) ? new AacConvertFailedError(src, new Error('afconvert exited 1')) : null))
      const res = await r.sync()
      assert.equal(res.ok, true, res.error)
      assert.equal(res.copied, N - 1)
      const off = res.leftOff ?? []
      assert.deepEqual(off.map((l) => l.id), [BAD])
      assert.match(off[0].why, /converted/)
      assert.equal(res.keptOldCopies, undefined)

      const files = await r.cardFiles()
      assert.equal(files.length, N - 1)
      assert.deepEqual(files.filter(isMaster), [], 'no lossless master went on the card')
      const titles = await r.catalogTitles()
      assert.ok(!titles.includes(`Song ${BAD}`), 'not in the iPod catalog')
      assert.equal(titles.length, N - 1)
      const last = await r.lastLedger()
      assert.deepEqual((last.leftOff ?? []).map((l) => l.id), [BAD])
      assert.equal(last.leftOff![0].t, `Song ${BAD}`)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a new song whose conversion timed out: left off, never called damaged', async () => {
    const r = await rig()
    try {
      r.failWith((src) => (src.endsWith(`M${BAD}.m4a`) ? new AacConvertFailedError(src, ffmpegTimeout()) : null))
      const res = await r.sync()
      assert.equal(res.ok, true, res.error)
      const off = res.leftOff ?? []
      assert.deepEqual(off.map((l) => l.id), [BAD])
      assert.equal(off[0].why, CONVERT_FAILED_THIS_TIME)
      assert.doesNotMatch(off[0].why, /damaged/)
      assert.notEqual(leftOffKind(off[0].why), 'damaged', 'the Device page doesn\'t say "is damaged" either')
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a song already on the card (its master changed, the new copy timed out): keeps its copy and its row, named as kept', async () => {
    const r = await rig()
    try {
      const first = await r.sync()
      assert.equal(first.ok, true, first.error)
      assert.equal(first.copied, N)
      const before = await r.cardFiles()
      assert.equal(before.length, N)

      // A tag edit: the master's bytes change. Its new copy then fails with an ffmpeg timeout.
      const bad = r.tracks.find((t) => t.id === BAD)!
      await writeFile(join(r.lib, String(bad.path).replace(/:/g, '/')), Buffer.alloc(MASTER_BYTES + 5, 9))
      r.failWith((src) => (src.endsWith(`M${BAD}.m4a`) ? new AacConvertFailedError(src, ffmpegTimeout()) : null))
      const res = await r.sync()
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', String(res.fullReason))

      const after = await r.cardFiles()
      assert.deepEqual(after, before, 'every card file is exactly as it was: none deleted, none replaced')
      assert.deepEqual(after.filter(isMaster), [])
      const titles = await r.catalogTitles()
      assert.ok(titles.includes(`Song ${BAD}`), 'still in the iPod catalog')
      assert.equal(titles.length, N)

      assert.deepEqual(res.keptOldCopies, [`Song ${BAD}`])
      assert.equal((res.leftOff ?? []).length, 0, 'kept, not left off')
      assert.match(String(res.summary), /kept its old copy/)
      const last = await r.lastLedger()
      assert.deepEqual(last.keptOldCopies, [`Song ${BAD}`])

      // Next sync, the converter works again: the new copy goes on in its place.
      r.failWith(() => null)
      const again = await r.sync()
      assert.equal(again.ok, true, again.error)
      assert.equal(again.copied, 1)
      assert.equal((await r.catalogTitles()).length, N)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('an encoder check that timed out is said as a timeout, never "isn\'t available"', async () => {
    const r = await rig()
    try {
      r.failWith((src) => new AacEncoderMissingError(src, 'unknown'))
      const res = await r.sync()
      assert.equal(res.ok, false)
      assert.match(String(res.error), /didn't answer in time/)
      assert.doesNotMatch(String(res.error), /isn't available/)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})
